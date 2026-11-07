// Local branch reviewer: git diff viewer + inline comments + Claude review, for git servers without PRs.
// Zero dependencies. Binds to localhost only.
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { parseDiff, annotate } = require('./diff');

const PORT = +process.env.PORT || 4777;
const HOST = '127.0.0.1';
const DATA = path.join(__dirname, 'data');
const CONFIG = path.join(DATA, 'config.json');
const PUBLIC = path.join(__dirname, 'public');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const AI_TIMEOUT_MS = 20 * 60 * 1000;

fs.mkdirSync(path.join(DATA, 'reviews'), { recursive: true });

const isRepo = p => fs.existsSync(path.join(p, '.git'));
const hash = (s, n = 16) => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);

// ---------- git ----------
function git(cwd, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotePath=false', ...args], {
      cwd, timeout, windowsHide: true, maxBuffer: 512 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout);
    });
  });
}

async function resolveRef(repo, ref) {
  if (!ref || ref.startsWith('-')) throw httpError(400, 'Bad ref');
  try { return (await git(repo.path, ['rev-parse', '--verify', '--quiet', ref + '^{commit}'])).trim(); }
  catch { throw httpError(400, `Unknown ref: ${ref}`); }
}

async function defaultBase(repo) {
  if (repo.base) return repo.base;
  try { return (await git(repo.path, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).trim(); } catch {}
  for (const b of ['origin/main', 'origin/master', 'origin/develop', 'main', 'master']) {
    try { await git(repo.path, ['rev-parse', '--verify', '--quiet', b]); return b; } catch {}
  }
  return null;
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// ---------- config & storage ----------
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return { repos: [], settings: {} }; }
}
function saveConfig(c) { fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2)); }
function getRepo(id) {
  const repo = loadConfig().repos.find(r => r.id === id);
  if (!repo) throw httpError(404, 'Unknown repo');
  return repo;
}

function reviewFiles(repo, branch) {
  const dir = path.join(DATA, 'reviews', repo.id);
  const base = path.join(dir, hash(branch));
  return { dir, review: base + '.json', ai: base + '.ai.json' };
}
async function readJson(file) { try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; } }
async function writeJson(file, obj) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fsp.rename(tmp, file);
}

// ---------- Claude review jobs ----------
const jobs = new Map(); // id -> job
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'verdict', 'findings', 'praise'],
  properties: {
    summary: { type: 'string', description: 'What the change does and the overall assessment, 2-6 sentences.' },
    verdict: { type: 'string', enum: ['approve', 'comment', 'request_changes'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'line', 'severity', 'category', 'title', 'body'],
        properties: {
          file: { type: 'string', description: 'Path exactly as in the diff header.' },
          line: { type: 'integer', description: 'NEW-file line number from the left column of the annotated diff.' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          category: { type: 'string', enum: ['bug', 'security', 'performance', 'error-handling', 'design', 'readability', 'tests', 'style'] },
          title: { type: 'string', description: 'One-line summary of the problem.' },
          body: { type: 'string', description: 'Why it is a problem and how to fix it. Written for a junior developer to learn from.' },
          suggestion: { type: 'string', description: 'Optional replacement code for the line(s). Code only, no prose.' },
        },
      },
    },
    praise: { type: 'array', items: { type: 'string' }, description: '0-3 specific things done well.' },
  },
};

function buildPrompt({ head, base, commits, files, guidelines, focus }) {
  return `You are a senior engineer reviewing a branch written by a junior developer on your team. There is no pull request system, so your review is the pull request review.

Branch under review: ${head}
Target branch: ${base}
Commits:
${commits.map(c => `- ${c.sha.slice(0, 8)} ${c.author}: ${c.subject}`).join('\n') || '(none)'}

Your current working directory is the repository checked out at the branch head. Use Read, Grep and Glob to check surrounding code, callers, interfaces, config and tests before claiming something is wrong. Verify, do not guess.
${guidelines ? `\nTeam review guidelines:\n${guidelines}\n` : ''}${focus ? `\nReviewer asked you to focus on: ${focus}\n` : ''}
What to report:
- Real problems first: bugs, wrong logic, security issues (injection, auth, secrets, unsafe input), data loss, concurrency, resource leaks, missing or swallowed error handling, broken contracts with callers, performance problems on realistic data, missing tests for risky logic.
- Design and maintainability problems that will cost the team later (duplication of existing helpers, wrong layer, unclear naming that misleads).
- At most 3 nits. Skip pure formatting unless it breaks clear project conventions.
- Do not report things that are fine. An empty findings list is a valid result.

Rules for each finding:
- file: the path exactly as shown after "===" in the diff (the new path).
- line: the NEW-file line number shown in the left column. For a problem on removed code, use the nearest new line.
- body: explain WHY it is a problem and HOW to fix it, in plain friendly language a junior can learn from. Mention the concept by name (e.g. "SQL injection", "N+1 query") so they can look it up.
- suggestion: only when you can give concrete replacement code.
- verdict: "request_changes" if any blocker or major finding, "approve" if only nits or nothing, otherwise "comment".

Annotated diff (left column = new-file line number, blank for removed lines):
${annotate(files)}`;
}

async function prepareWorktree(repo, sha) {
  const wt = path.join(DATA, 'worktrees', repo.id);
  if (fs.existsSync(path.join(wt, '.git'))) {
    await git(wt, ['checkout', '--detach', '--force', sha], 600000);
  } else {
    await git(repo.path, ['worktree', 'prune']);
    await fsp.rm(wt, { recursive: true, force: true });
    await git(repo.path, ['worktree', 'add', '--detach', '--force', wt, sha], 600000);
  }
  return wt;
}

// One review worktree per repo, so Claude runs take turns on it.
const wtLocks = new Map();
function withWorktree(repo, sha, fn) {
  const run = (wtLocks.get(repo.id) || Promise.resolve()).then(async () => fn(await prepareWorktree(repo, sha)));
  wtLocks.set(repo.id, run.catch(() => {}));
  return run;
}

function modelArgs(repo) {
  const m = repo.model || loadConfig().settings?.model;
  return m ? ['--model', m] : [];
}

// Runs `claude -p` with read-only tools in cwd. Resolves with the final result message.
function runClaude({ cwd, prompt, extraArgs = [], onTool, onSpawn, timeoutMs = AI_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, ['-p', '--output-format', 'stream-json', '--verbose', '--tools', 'Read,Grep,Glob', ...extraArgs], { cwd, windowsHide: true });
    onSpawn?.(child);
    const timer = setTimeout(() => { child.kill(); reject(new Error('Claude timed out')); }, timeoutMs);
    let buf = '', stderr = '', final = null;
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'assistant') {
          for (const c of msg.message?.content || []) {
            if (c.type !== 'tool_use' || c.name === 'StructuredOutput') continue;
            const target = String(c.input?.file_path || c.input?.pattern || c.input?.path || '');
            onTool?.(`${c.name} ${target.replace(cwd, '').replace(/^[\\/]/, '')}`);
          }
        } else if (msg.type === 'result') final = msg;
      }
    });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    child.on('error', e => { clearTimeout(timer); reject(new Error(`Cannot start "${CLAUDE_BIN}": ${e.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (final && !final.is_error) return resolve(final);
      reject(new Error(final?.result || stderr.trim() || `Claude exited with code ${code}`));
    });
    child.stdin.end(prompt);
  });
}

async function startAiReview(repo, { base, head, focus }) {
  const running = [...jobs.values()].find(j => j.repoId === repo.id && j.status === 'running');
  if (running) throw httpError(409, `A Claude review is already running for ${running.head} in this repo`);

  const job = { id: hash(Math.random() + head, 12), repoId: repo.id, head, base, status: 'running', log: [], startedAt: Date.now() };
  jobs.set(job.id, job);
  const log = s => { job.log.push(s); if (job.log.length > 200) job.log.shift(); };

  (async () => {
    const baseSha = await resolveRef(repo, base);
    const headSha = await resolveRef(repo, head);
    const mergeBase = (await git(repo.path, ['merge-base', baseSha, headSha])).trim();
    const files = parseDiff(await git(repo.path, ['diff', '--no-color', '--no-ext-diff', '-M', '-U5', mergeBase, headSha]));
    if (!files.length) throw new Error('No changes between base and branch');
    const commits = await getCommits(repo, mergeBase, headSha);
    const settings = loadConfig().settings || {};
    const guidelines = [settings.guidelines, repo.guidelines].filter(Boolean).join('\n');
    const prompt = buildPrompt({ head, base, commits, files, guidelines, focus });
    const extraArgs = ['--json-schema', JSON.stringify(SCHEMA), ...modelArgs(repo)];
    log(`Checking out ${headSha.slice(0, 8)} into review worktree…`);
    const result = await withWorktree(repo, headSha, wt => {
      if (job.status === 'cancelled') throw new Error('Cancelled');
      log(`Starting Claude${extraArgs.includes('--model') ? ` (${extraArgs.at(-1)})` : ''} on ${files.length} files…`);
      return runClaude({ cwd: wt, prompt, extraArgs, onTool: log, onSpawn: c => { job.kill = () => c.kill(); } });
    });
    const out = result.structured_output;
    if (!out) throw new Error(result.result || 'Claude returned no structured review');
    const findings = (out.findings || []).map(f => ({
      ...f,
      file: String(f.file).replace(/^\.?[\\/]/, '').replace(/^[ab]\//, '').replace(/\\/g, '/'),
      id: hash(`${f.file}|${f.line}|${f.title}|${headSha}`, 12),
    }));
    await writeJson(reviewFiles(repo, head).ai, {
      ranAt: new Date().toISOString(), base, head, headSha, mergeBase, model: modelArgs(repo)[1] || null,
      durationMs: result.duration_ms, focus: focus || '',
      summary: out.summary, verdict: out.verdict, praise: out.praise || [], findings,
    });
    log(`Done: ${findings.length} findings.`);
    job.status = 'done';
  })().catch(e => {
    if (job.status !== 'cancelled') { job.status = 'error'; job.error = e.message; }
    log(`Error: ${e.message}`);
  }).finally(() => { job.endedAt = Date.now(); delete job.kill; });

  return job;
}

// ---------- API ----------
function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }

async function getCommits(repo, from, to) {
  const out = await git(repo.path, ['log', '--format=%H%x00%an%x00%ae%x00%at%x00%s%x00%b%x1e', `${from}..${to}`]);
  return out.split('\x1e').map(s => s.trim()).filter(Boolean).map(s => {
    const [sha, author, email, at, subject, body] = s.split('\x00');
    return { sha, author, email, date: +at * 1000, subject, body: (body || '').trim() };
  });
}

const routes = {
  'GET /api/config': async () => loadConfig(),

  'PUT /api/settings': async (q, body) => {
    const c = loadConfig();
    c.settings = { model: String(body.model || '').trim(), guidelines: String(body.guidelines || '') };
    saveConfig(c);
    return c;
  },

  'POST /api/repos': async (q, body) => {
    let p = String(body.path || '').trim();
    const url = String(body.url || '').trim();
    if (!p) throw httpError(400, 'Folder path is required');
    p = path.resolve(p);
    if (url) {
      if (url.startsWith('-')) throw httpError(400, 'Bad URL');
      if (fs.existsSync(p) && fs.readdirSync(p).length) throw httpError(400, 'Target folder exists and is not empty');
      await git(path.dirname(p), ['clone', '--', url, p], 60 * 60 * 1000);
    }
    try { await git(p, ['rev-parse', '--git-dir']); } catch { throw httpError(400, `Not a git repository: ${p}`); }
    const c = loadConfig();
    const id = hash(p.toLowerCase(), 10);
    if (!c.repos.some(r => r.id === id)) c.repos.push({ id, name: path.basename(p), path: p, base: '', guidelines: '', model: '' });
    saveConfig(c);
    return c;
  },

  // Folder browser for the Add repo dialog. No path = drives + home.
  'GET /api/browse': async q => {
    const p = q.get('path');
    if (!p) {
      const home = os.homedir();
      const roots = [{ name: `Home (${home})`, path: home, isRepo: isRepo(home) }];
      if (process.platform === 'win32') {
        for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(`${l}:\\`)) roots.push({ name: `${l}:\\`, path: `${l}:\\`, isRepo: false });
      } else roots.push({ name: '/', path: '/', isRepo: false });
      return { path: '', parent: null, isRepo: false, dirs: roots };
    }
    const abs = path.resolve(p);
    let entries;
    try { entries = await fsp.readdir(abs, { withFileTypes: true }); }
    catch (e) { throw httpError(400, `Cannot open ${abs} (${e.code})`); }
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
      .map(e => { const full = path.join(abs, e.name); return { name: e.name, path: full, isRepo: isRepo(full) }; })
      .sort((a, b) => b.isRepo - a.isRepo || a.name.localeCompare(b.name));
    const parent = path.dirname(abs);
    return { path: abs, parent: parent === abs ? '' : parent, isRepo: isRepo(abs), dirs };
  },

  // Find git repos under a folder (depth 4). Symlinks/junctions are skipped, so no loops.
  'GET /api/scan': async q => {
    const root = path.resolve(q.get('path') || os.homedir());
    const SKIP = new Set(['node_modules', 'bin', 'obj', 'packages', 'vendor', 'dist', 'build', 'AppData', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData']);
    const found = [];
    async function walk(dir, depth) {
      if (found.length >= 300 || dir.startsWith(DATA)) return;
      if (isRepo(dir)) { found.push(dir); return; }
      if (depth >= 4) return;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$') && !SKIP.has(e.name)) await walk(path.join(dir, e.name), depth + 1);
      }
    }
    await walk(root, 0);
    return { root, repos: found.map(p => ({ name: path.basename(p), path: p })) };
  },

  'PUT /api/repos': async (q, body) => {
    const c = loadConfig();
    const r = c.repos.find(x => x.id === body.id);
    if (!r) throw httpError(404, 'Unknown repo');
    for (const k of ['name', 'base', 'guidelines', 'model']) if (k in body) r[k] = String(body[k] ?? '').trim();
    saveConfig(c);
    return c;
  },

  'DELETE /api/repos': async q => {
    const c = loadConfig();
    const r = c.repos.find(x => x.id === q.get('repo'));
    if (r) {
      await git(r.path, ['worktree', 'remove', '--force', path.join(DATA, 'worktrees', r.id)]).catch(() => {});
      c.repos = c.repos.filter(x => x !== r);
      saveConfig(c);
    }
    return c; // review files in data/reviews are kept on purpose
  },

  'POST /api/fetch': async q => {
    const repo = getRepo(q.get('repo'));
    await git(repo.path, ['fetch', '--all', '--prune'], 10 * 60 * 1000);
    return { ok: true };
  },

  'GET /api/branches': async q => {
    const repo = getRepo(q.get('repo'));
    const base = await defaultBase(repo);
    const fmt = '%(refname)%00%(refname:short)%00%(objectname)%00%(committerdate:unix)%00%(authorname)%00%(subject)';
    const out = await git(repo.path, ['for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/remotes', 'refs/heads']);
    let branches = out.split('\n').filter(Boolean).map(l => {
      const [ref, name, sha, at, author, subject] = l.split('\x00');
      return { name, sha, date: +at * 1000, author, subject, remote: ref.startsWith('refs/remotes/') };
    }).filter(b => !b.name.endsWith('/HEAD') && b.name !== 'origin');
    // Juniors push to the server, so hide local branches that just mirror a remote one.
    const remoteNames = new Set(branches.filter(b => b.remote).map(b => b.name.replace(/^[^/]+\//, '')));
    branches = branches.filter(b => b.remote || !remoteNames.has(b.name));
    let baseSha = null;
    try { baseSha = base && (await resolveRef(repo, base)); } catch {}
    if (baseSha) {
      await mapLimit(branches, 8, async b => {
        try {
          const [behind, ahead] = (await git(repo.path, ['rev-list', '--left-right', '--count', `${baseSha}...${b.sha}`])).trim().split(/\s+/).map(Number);
          Object.assign(b, { ahead, behind });
        } catch {}
      });
    }
    const dir = reviewFiles(repo, '').dir;
    const status = {};
    for (const f of await fsp.readdir(dir).catch(() => [])) {
      if (!f.endsWith('.json') || f.endsWith('.ai.json')) continue;
      const r = await readJson(path.join(dir, f));
      if (r?.branch) status[r.branch] = { verdict: r.verdict || null, reviewedSha: r.reviewedSha || null };
    }
    for (const b of branches) b.review = status[b.name] || null;
    return { base, branches };
  },

  'GET /api/compare': async q => {
    const repo = getRepo(q.get('repo'));
    const baseSha = await resolveRef(repo, q.get('base'));
    const headSha = await resolveRef(repo, q.get('head'));
    let mergeBase;
    try { mergeBase = (await git(repo.path, ['merge-base', baseSha, headSha])).trim(); }
    catch { throw httpError(400, 'Branches share no history'); }
    const diffArgs = ['diff', '--no-color', '--no-ext-diff', '-M', '-U5'];
    if (q.get('ws') === '1') diffArgs.push('-w');
    const [diff, commits] = await Promise.all([
      git(repo.path, [...diffArgs, mergeBase, headSha]),
      getCommits(repo, mergeBase, headSha),
    ]);
    return { baseSha, headSha, mergeBase, commits, files: parseDiff(diff) };
  },

  'GET /api/review': async q => {
    const repo = getRepo(q.get('repo'));
    const head = q.get('head');
    const f = reviewFiles(repo, head);
    const job = [...jobs.values()].reverse().find(j => j.repoId === repo.id && j.head === head && (j.status === 'running' || Date.now() - j.endedAt < 60000));
    return { review: await readJson(f.review), ai: await readJson(f.ai), job: job ? publicJob(job) : null };
  },

  'PUT /api/review': async (q, body) => {
    const repo = getRepo(q.get('repo'));
    const head = q.get('head');
    if (!head) throw httpError(400, 'head required');
    await writeJson(reviewFiles(repo, head).review, { ...body, branch: head, updatedAt: new Date().toISOString() });
    return { ok: true };
  },

  'POST /api/ai-review': async (q, body) => {
    const repo = getRepo(q.get('repo'));
    return publicJob(await startAiReview(repo, { base: body.base, head: body.head, focus: String(body.focus || '').slice(0, 2000) }));
  },

  // File content at a commit, for expanding diff context.
  'GET /api/file': async q => {
    const repo = getRepo(q.get('repo'));
    const sha = await resolveRef(repo, q.get('sha'));
    const p = q.get('path') || '';
    if (!p || p.startsWith('-')) throw httpError(400, 'Bad path');
    let text;
    try { text = await git(repo.path, ['show', `${sha}:${p}`]); }
    catch { throw httpError(404, `${p} not found at ${sha.slice(0, 8)}`); }
    const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
    if (lines.at(-1) === '') lines.pop();
    return { lines };
  },

  // Ask Claude a question about one line or file of the branch.
  'POST /api/ask': async (q, body) => {
    const repo = getRepo(q.get('repo'));
    const headSha = await resolveRef(repo, body.head);
    const question = String(body.question || '').trim().slice(0, 4000);
    if (!question) throw httpError(400, 'Type a question first');
    const prompt = `You are helping a senior engineer review a junior developer's branch "${body.head}". Your current directory is the repository at the branch head. Use Read, Grep and Glob to check surrounding code when it helps.

File: ${String(body.file || '')}${body.line ? `, line ${+body.line} (new-file numbering)` : ''}
Diff context (left column = new-file line number):
${String(body.context || '').slice(0, 20000)}

Question: ${question}

Answer in under 200 words, specific to this code. If you suggest a change, show the code. Do not restate the question.`;
    const result = await withWorktree(repo, headSha, wt => runClaude({ cwd: wt, prompt, extraArgs: modelArgs(repo), timeoutMs: 5 * 60 * 1000 }));
    return { answer: String(result.result || '').trim() };
  },

  'GET /api/job': async q => {
    const job = jobs.get(q.get('id'));
    if (!job) throw httpError(404, 'Unknown job');
    return publicJob(job);
  },

  'POST /api/job/cancel': async q => {
    const job = jobs.get(q.get('id'));
    if (job?.status === 'running') { job.status = 'cancelled'; job.kill?.(); }
    return { ok: true };
  },
};

function publicJob(j) {
  const { kill, ...rest } = j;
  return rest;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  };
  // Block DNS rebinding and cross-site requests from other pages open in the browser.
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return send(403, { error: 'Forbidden host' });

  if (url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.headers['x-reviewer'] !== '1') return send(403, { error: 'Missing X-Reviewer header' });
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(404, { error: 'Not found' });
    try {
      let body = {};
      if (req.method !== 'GET') {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 20e6) throw httpError(413, 'Body too large'); }
        body = raw ? JSON.parse(raw) : {};
      }
      send(200, await handler(url.searchParams, body));
    } catch (e) {
      if (!e.status) console.error(e);
      send(e.status || 500, { error: e.message });
    }
    return;
  }

  const file = path.join(PUBLIC, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) return send(403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => err ? send(404, 'Not found', 'text/plain') : send(200, data, MIME[path.extname(file)] || 'application/octet-stream'));
});

server.listen(PORT, HOST, () => console.log(`Branch reviewer running at http://localhost:${PORT}`));
