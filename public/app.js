'use strict';
const $ = (s, el = document) => el.querySelector(s);
const enc = encodeURIComponent;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inlineText = s => esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
// Claude's text: ```fenced``` blocks become <pre>, the rest gets `code` and **bold**.
const inline = s => String(s ?? '').split(/```[\w+-]*\n?([\s\S]*?)(?:```|$)/).map((part, k, all) => k % 2 ? `<pre>${esc(part.replace(/\n$/, ''))}</pre>`
  : inlineText((k ? part.replace(/^\n+/, '') : part).replace(k < all.length - 1 ? /\n+$/ : /$^/, ''))).join('');
const short = sha => (sha || '').slice(0, 8);
const SEVS = ['blocker', 'major', 'minor', 'nit'];
const svg = d => `<svg aria-hidden="true" viewBox="0 0 24 24">${d}</svg>`;
const ICON = {
  sparkle: svg('<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'),
};
const VERDICT = { approve: 'Approved', comment: 'Commented', request_changes: 'Changes requested' };
const VERDICT_BTN = { approve: 'Approve', comment: 'Comment', request_changes: 'Request changes' };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  for (const [n, u] of [[31536000, 'y'], [2592000, 'mo'], [86400, 'd'], [3600, 'h'], [60, 'm']]) if (s >= n) return `${Math.floor(s / n)}${u} ago`;
}
const dur = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-Reviewer': '1' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 4000);
}

// ---------- state ----------
const S = {
  config: { repos: [], settings: {} }, repo: null, branches: [], defaultBase: null,
  head: null, base: null, cmp: null, cmpError: null, review: null, ai: null, job: null,
  tab: 'files', ws: false, collapsed: new Set(), draft: null, focus: '',
  split: store.get('split') === '1', fileCache: {},
};

let pending = null, saveT;
function save() {
  pending = { url: `/api/review?repo=${S.repo}&head=${enc(S.head)}`, data: S.review };
  clearTimeout(saveT);
  saveT = setTimeout(flushSave, 300);
}
function flushSave() {
  clearTimeout(saveT);
  if (!pending) return;
  const p = pending;
  pending = null;
  return api('PUT', p.url, p.data).catch(e => toast('Save failed: ' + e.message));
}

function fileSig(f) {
  let h = 0;
  for (const hk of f.hunks) for (const l of hk.lines) { const s = l[0] + l[3]; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; }
  return `${f.add}.${f.del}.${h}`;
}
const isViewed = f => S.review.viewed[f.path] === f.sig;

function pendingFindings() {
  if (!S.ai) return [];
  const kept = new Set(S.review.comments.map(c => c.aiId));
  return S.ai.findings.filter(f => !kept.has(f.id) && !S.review.dismissed[f.id]);
}
function allItems() {
  return S.review.comments.map(c => ({ ...c, kind: 'comment' }))
    .concat(pendingFindings().map(f => ({ ...f, side: 'new', kind: 'ai' })));
}
function lineTextFor(path, side, line) {
  const f = S.cmp?.files.find(x => x.path === path);
  for (const h of f?.hunks || []) for (const l of h.lines) if ((side === 'old' ? l[1] : l[2]) === line && (side === 'old') === (l[0] === '-')) return l[3];
  return null;
}
function fromFinding(f) {
  return {
    id: crypto.randomUUID(), aiId: f.id, source: 'claude', file: f.file, side: 'new', line: f.line,
    lineText: lineTextFor(f.file, 'new', f.line), severity: f.severity, category: f.category,
    title: f.title, body: f.body, suggestion: f.suggestion || '', createdAt: Date.now(),
  };
}

// ---------- loading ----------
async function init() {
  S.config = await api('GET', '/api/config');
  renderRepoSelect();
  const repo = S.config.repos.find(r => r.id === store.get('repo')) || S.config.repos[0];
  if (repo) await selectRepo(repo.id);
  else openAddRepo();
}

function renderRepoSelect() {
  $('#repoSelect').innerHTML = S.config.repos.length
    ? S.config.repos.map(r => `<option value="${r.id}" ${r.id === S.repo ? 'selected' : ''}>${esc(r.name)}</option>`).join('')
    : '<option>No repos yet</option>';
}

async function selectRepo(id) {
  await flushSave();
  S.repo = id;
  S.head = null;
  store.set('repo', id);
  renderRepoSelect();
  render();
  await loadBranches();
}

async function loadBranches() {
  $('#branchList').innerHTML = '<li class="muted">Loading…</li>';
  try {
    const r = await api('GET', `/api/branches?repo=${S.repo}`);
    S.branches = r.branches;
    S.defaultBase = r.base;
  } catch (e) {
    S.branches = [];
    toast(e.message);
  }
  renderBranches();
}

function renderBranches() {
  const q = $('#branchFilter').value.toLowerCase();
  const hide = $('#hideMerged').checked;
  const list = S.branches.filter(b =>
    (!q || b.name.toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q)) &&
    (!hide || b.ahead !== 0 || b.name === S.head));
  $('#branchList').innerHTML = list.map(b => {
    const st = b.review;
    let badge = '';
    if (st?.verdict) badge = st.reviewedSha && st.reviewedSha !== b.sha
      ? '<span class="badge b-new">new commits</span>'
      : `<span class="badge b-${st.verdict}">${VERDICT[st.verdict]}</span>`;
    return `<li data-act="branch" data-name="${esc(b.name)}" class="${b.name === S.head ? 'sel' : ''}">
      <div class="bn">${esc(b.name)}</div>
      <div class="bm">${badge ? `${badge} · ` : ''}${esc(b.author)} · ${ago(b.date)}${b.ahead != null ? ` · ${b.ahead} ahead, ${b.behind} behind` : ''}</div>
      <div class="bm">${esc(b.subject)}</div></li>`;
  }).join('') || '<li class="muted">No branches. Try Fetch (VPN on?)</li>';
}

async function selectBranch(name) {
  await flushSave();
  S.head = name;
  S.tab = 'files';
  S.draft = null;
  S.cmp = null;
  S.cmpError = null;
  renderBranches();
  render();
  const r = await api('GET', `/api/review?repo=${S.repo}&head=${enc(name)}`);
  if (S.head !== name) return;
  S.review = { comments: [], dismissed: {}, viewed: {}, summary: '', verdict: null, reviewedSha: null, base: null, ...r.review };
  S.ai = r.ai;
  S.job = r.job;
  S.base = S.review.base || S.defaultBase;
  await loadCompare();
  if (S.job?.status === 'running') pollJob();
}

async function loadCompare() {
  if (!S.base) { S.cmp = null; S.cmpError = 'Pick a base branch to compare against.'; return render(); }
  const head = S.head;
  try {
    const cmp = await api('GET', `/api/compare?repo=${S.repo}&base=${enc(S.base)}&head=${enc(head)}&ws=${S.ws ? 1 : 0}`);
    if (S.head !== head) return;
    for (const f of cmp.files) f.sig = fileSig(f);
    S.cmp = cmp;
    S.cmpError = null;
    S.collapsed = new Set(cmp.files.filter(f => isViewed(f) || f.binary || f.add + f.del > 1500).map(f => f.path));
  } catch (e) {
    S.cmp = null;
    S.cmpError = e.message;
  }
  render();
}

// ---------- rendering ----------
function captureDraft() {
  const ta = $('#draftText');
  if (S.draft && ta) { S.draft.text = ta.value; S.draft.severity = $('#draftSev').value; }
}

function render() {
  captureDraft();
  const m = $('#main');
  if (!S.head || !S.review) { m.innerHTML = `<div class="empty">${S.head ? 'Loading…' : 'Pick a branch to review.'}</div>`; return; }
  const scroll = m.scrollTop;
  const body = S.cmp ? { overview: renderOverview, files: renderFiles, commits: renderCommits }[S.tab]() : `<div class="empty">${esc(S.cmpError || 'Loading diff…')}</div>`;
  m.innerHTML = renderHead() + renderBanners() + `<div class="content">${body}</div>`;
  m.scrollTop = scroll;
  if (S.draft?.focus) { $('#draftText')?.focus(); S.draft.focus = false; }
}

function baseOptions() {
  const names = new Set([S.defaultBase, S.base, ...S.branches.map(b => b.name)].filter(Boolean));
  const since = S.review.reviewedSha && S.cmp && S.review.reviewedSha !== S.cmp.headSha
    ? `<option value="${S.review.reviewedSha}" ${S.base === S.review.reviewedSha ? 'selected' : ''}>since your last review (${short(S.review.reviewedSha)})</option>` : '';
  return since + [...names].filter(n => n !== S.head && n !== S.review.reviewedSha)
    .map(n => `<option ${n === S.base ? 'selected' : ''}>${esc(n)}</option>`).join('');
}

function renderHead() {
  const c = S.cmp;
  const files = c?.files || [];
  const add = files.reduce((a, f) => a + f.add, 0), del = files.reduce((a, f) => a + f.del, 0);
  const running = S.job?.status === 'running';
  const pend = pendingFindings().length;
  const tab = (id, label) => `<button data-act="tab" data-tab="${id}" class="${S.tab === id ? 'on' : ''}">${label}</button>`;
  return `<div class="head">
    <div class="row">
      <span class="title">${esc(S.head)}</span><span class="muted">into</span>
      <select id="baseSelect" aria-label="Base branch">${baseOptions()}</select>
      <span class="muted">${c ? `${short(c.headSha)} · <span class="add-c">+${add}</span> <span class="del-c">−${del}</span>` : ''}</span>
      <span class="grow"></span>
      <div class="seg">${Object.keys(VERDICT_BTN).map(v => `<button data-act="verdict" data-v="${v}" class="v-${v} ${S.review.verdict === v ? 'on' : ''}">${VERDICT_BTN[v]}</button>`).join('')}</div>
      <button data-act="export" ${c ? '' : 'disabled'}>${ICON.download}Export</button>
    </div>
    <div class="row">
      <div class="tabs">
        ${tab('overview', `Overview${pend ? ` (${pend} pending)` : ''}`)}
        ${tab('files', `Files (${files.length})`)}
        ${tab('commits', `Commits (${c?.commits.length ?? 0})`)}
      </div>
      <span class="grow"></span>
      <label class="chk"><input type="checkbox" id="splitToggle" ${S.split ? 'checked' : ''}> Side by side</label>
      <label class="chk"><input type="checkbox" id="wsToggle" ${S.ws ? 'checked' : ''}> Hide whitespace</label>
      <input type="text" id="focusInput" placeholder="Focus for Claude (optional)" value="${esc(S.focus)}" size="28">
      <button class="primary" data-act="run-ai" ${running || !c?.files.length ? 'disabled' : ''}>${ICON.sparkle}${S.ai ? 'Re-run Claude' : 'Review with Claude'}</button>
    </div>
  </div>`;
}

function renderBanners() {
  let h = '';
  const j = S.job;
  if (j?.status === 'running') {
    h += `<div class="banner"><div class="row"><b>Claude is reviewing…</b><span id="jobElapsed" class="muted">${dur(Date.now() - j.startedAt)}</span>
      <span class="grow"></span><button data-act="cancel-ai">Cancel</button></div>
      <div class="joblog" id="jobLog">${esc(j.log.slice(-30).join('\n'))}</div></div>`;
  } else if (j?.status === 'error') {
    h += `<div class="banner err"><div class="row"><b>Claude review failed:</b><span>${esc(j.error)}</span><span class="grow"></span><button data-act="clear-job">Dismiss</button></div></div>`;
  }
  if (S.cmp && S.ai && S.ai.headSha !== S.cmp.headSha) {
    h += `<div class="banner warn">Claude reviewed ${short(S.ai.headSha)}, but the branch is now at ${short(S.cmp.headSha)}. Line positions may be off. Re-run to review the new commits.</div>`;
  }
  if (S.cmp && S.review.reviewedSha && S.review.reviewedSha !== S.cmp.headSha && S.base !== S.review.reviewedSha) {
    h += `<div class="banner warn"><div class="row">New commits since your last review (${short(S.review.reviewedSha)}).
      <button data-act="since">Show only changes since then</button></div></div>`;
  }
  if (S.base === S.review.reviewedSha) {
    h += `<div class="banner"><div class="row">Showing only changes since your last review. <button data-act="full-diff">Show full diff</button></div></div>`;
  }
  return h;
}

function renderCard(it, lineText, showFile) {
  if (S.draft?.mode === 'edit' && S.draft.id === it.id) return renderDraft();
  const sev = it.severity || 'minor';
  const outdated = it.kind === 'comment' && it.lineText != null && lineText != null && it.lineText !== lineText;
  const who = it.kind === 'ai' ? 'Claude suggestion' : it.source === 'claude' ? 'Claude, kept' : 'You';
  const actions = it.kind === 'ai'
    ? `<button data-act="keep" data-id="${it.id}">Keep</button><button data-act="keep-edit" data-id="${it.id}">Edit &amp; keep</button><button data-act="dismiss" data-id="${it.id}">Dismiss</button>`
    : `<button class="link" data-act="edit" data-id="${it.id}">Edit</button><button class="link" data-act="del" data-id="${it.id}">Delete</button>`;
  return `<div class="card sev-${sev} ${it.kind === 'ai' ? 'ai' : ''}">
    <div class="card-h"><span class="sev">${sev}</span>${it.category ? `<span class="tag">${esc(it.category)}</span>` : ''}
      ${it.title ? `<b>${inline(it.title)}</b>` : ''}<span class="tag">${who}</span>${outdated ? '<span class="tag out">outdated</span>' : ''}
      ${showFile ? `<span class="muted">${esc(it.file)}${it.line ? `:${it.line}` : ''}</span>` : ''}
      <span class="grow"></span>${actions}</div>
    ${it.body ? `<div class="card-b">${inline(it.body)}</div>` : ''}
    ${it.suggestion ? `<pre>${esc(it.suggestion)}</pre>` : ''}
  </div>`;
}

function renderDraft() {
  const d = S.draft;
  const ask = d.mode === 'new'
    ? `<button type="button" data-act="ask-claude" ${d.asking ? 'disabled' : ''}>${ICON.sparkle}${d.asking ? 'Asking Claude…' : 'Ask Claude'}</button>` : '';
  const answer = d.answer ? `<div class="answer"><div class="label">Claude</div><div class="card-b">${inline(d.answer)}</div>
    <div class="row"><button type="button" data-act="use-answer">Use as comment</button><button type="button" class="link" data-act="drop-answer">Discard</button></div></div>` : '';
  return `<div class="draft"><textarea id="draftText" placeholder="${d.mode === 'new' ? 'Write a comment, or type a question and click Ask Claude' : 'Edit comment'}">${esc(d.text || '')}</textarea>
    ${answer}
    <div class="row"><select id="draftSev" aria-label="Severity">${SEVS.map(s => `<option ${s === (d.severity || 'minor') ? 'selected' : ''}>${s}</option>`).join('')}</select>
    <button type="button" class="primary" data-act="save-draft">Save comment</button>${ask}<button type="button" data-act="cancel-draft">Cancel</button>
    <span class="muted">Ctrl+Enter saves, Esc cancels</span></div></div>`;
}

// The hunk around the line (or the first hunks for a file comment), in the same numbered format Claude reviews with.
function askContext(d) {
  const f = S.cmp.files.find(x => x.path === d.file);
  const fmt = h => h.lines.map(([t, , n, s]) => `${n == null ? '     ' : String(n).padStart(5)} ${t}${s}`).join('\n');
  if (d.line == null) return f.hunks.slice(0, 3).map(fmt).join('\n...\n');
  return fmt(f.hunks.find(h => h.lines.some(l => (d.side === 'old' ? l[1] : l[2]) === d.line)) || f.hunks[0]);
}

function renderOverview() {
  const ai = S.ai;
  const pend = pendingFindings();
  let h = '<div class="panel"><h3>Claude review</h3>';
  if (!ai) {
    h += '<p class="muted">Not run yet. Claude reads the repo at the branch head, so it checks callers, tests and config, not only the diff.</p>';
  } else {
    const kept = ai.findings.filter(f => S.review.comments.some(c => c.aiId === f.id)).length;
    const dismissed = ai.findings.filter(f => S.review.dismissed[f.id]).length;
    h += `<div class="row"><span class="badge b-${ai.verdict}">${VERDICT[ai.verdict]}</span>
      <span class="muted">at ${short(ai.headSha)} · ${ago(Date.parse(ai.ranAt))}${ai.durationMs ? ` · ${Math.round(ai.durationMs / 1000)}s` : ''}${ai.focus ? ` · focus: ${esc(ai.focus)}` : ''}</span></div>
      <p class="card-b">${inline(ai.summary)}</p>
      ${ai.praise?.length ? `<b>Done well</b><ul>${ai.praise.map(p => `<li>${inline(p)}</li>`).join('')}</ul>` : ''}
      <div class="row"><span>${ai.findings.length} findings: ${pend.length} pending, ${kept} kept, ${dismissed} dismissed.</span>
      ${pend.length ? '<button data-act="keep-all">Keep all pending</button><button data-act="keep-major">Keep blocker + major</button><button data-act="dismiss-all">Dismiss all pending</button>' : ''}
      <button data-act="use-summary">Copy Claude summary into your review</button></div>`;
  }
  h += '</div>';

  const counts = SEVS.map(s => `<span class="sev sev-${s}">${s}: ${S.review.comments.filter(c => (c.severity || 'minor') === s).length}</span>`).join('');
  h += `<div class="panel"><h3>Your review</h3>
    <textarea id="summaryInput" placeholder="Overall feedback for the developer. Goes at the top of the exported review.">${esc(S.review.summary)}</textarea>
    <div class="stats">${counts}</div></div>`;

  const paths = new Set(S.cmp.files.map(f => f.path));
  const orphan = allItems().filter(i => !paths.has(i.file));
  if (orphan.length) h += `<div class="panel"><h3>Not in the current diff</h3><p class="muted">File no longer changed on this base, or Claude gave a wrong path.</p>${orphan.map(i => renderCard(i, null, true)).join('')}</div>`;
  if (pend.length) h += `<div class="panel"><h3>Pending Claude suggestions</h3>${pend.map(f => renderCard({ ...f, kind: 'ai' }, null, true)).join('')}</div>`;
  return h;
}

function renderFiles() {
  if (!S.cmp.files.length) return '<div class="empty">No changes between these branches.</div>';
  const byFile = {};
  for (const it of allItems()) (byFile[it.file] ??= []).push(it);
  const nav = S.cmp.files.map((f, i) => {
    const n = (byFile[f.path] || []).length;
    const name = f.path.split('/').pop();
    return `<a href="#f${i}" class="${isViewed(f) ? 'viewed' : ''}" title="${esc(f.path)}"><span class="st st-${f.status}">${f.status[0]}</span><span class="fn">${esc(name)}</span>${n ? `<span class="cnt">${n}</span>` : ''}</a>`;
  }).join('');
  const viewed = S.cmp.files.filter(isViewed).length;
  return `<div class="files-wrap"><nav class="filenav"><div class="muted">${viewed}/${S.cmp.files.length} viewed</div>${nav}</nav>
    <div>${S.cmp.files.map((f, i) => renderFile(f, i, byFile[f.path] || [])).join('')}</div></div>`;
}

const lastNo = (h, col) => { for (let j = h.lines.length - 1; j >= 0; j--) if (h.lines[j][col] != null) return h.lines[j][col]; return (col === 1 ? h.oldStart : h.newStart) - 1; };

// Pull unchanged lines from the file into the diff: the gap above hunk k, or the rest of the file ('end').
function expandGap(f, gap, lines) {
  if (gap === 'end') {
    const h = f.hunks.at(-1);
    let o = lastNo(h, 1), n = lastNo(h, 2);
    while (n < lines.length) h.lines.push([' ', ++o, ++n, lines[n - 1]]);
    f.endLoaded = true;
    return;
  }
  const k = +gap, h = f.hunks[k], prev = f.hunks[k - 1];
  const from = prev ? lastNo(prev, 2) + 1 : 1;
  const ctx = [];
  for (let n = from; n < h.newStart; n++) ctx.push([' ', n + h.oldStart - h.newStart, n, lines[n - 1] ?? '']);
  h.lines.unshift(...ctx);
  h.oldStart -= ctx.length;
  h.newStart = from;
  if (prev) { prev.lines.push(...h.lines); f.hunks.splice(k, 1); }
}

function renderFile(f, i, items) {
  const byKey = {};
  for (const it of items) if (it.line != null) (byKey[`${it.side || 'new'}|${it.line}`] ??= []).push(it);
  const rowKeys = new Set();
  for (const h of f.hunks) for (const l of h.lines) rowKeys.add(l[0] === '-' ? `old|${l[1]}` : `new|${l[2]}`);
  const collapsed = S.collapsed.has(f.path);
  const d = S.draft;
  const fam = HL.family(f.path);
  const cols = S.split ? 4 : 3;
  const canExpand = f.status !== 'added' && f.status !== 'deleted' && !f.binary;
  const expandBtn = (gap, label) => `<button type="button" class="link" data-act="expand" data-file="${i}" data-gap="${gap}">${label}</button>`;

  // Comments and the open draft that belong under a row, for each [side, line, lineText] the row shows.
  const thread = keys => {
    let h = '';
    for (const [side, line, text] of keys) {
      h += (byKey[`${side}|${line}`] || []).map(it => renderCard(it, text)).join('');
      if (d?.mode === 'new' && d.file === f.path && d.side === side && d.line === line) h += renderDraft();
    }
    return h ? `<tr class="thread"><td colspan="${cols}">${h}</td></tr>` : '';
  };
  const no = (side, line, cls = '') => `<td class="no ${cls}" data-act="add" data-side="${side}" data-line="${line}">${line}</td>`;
  const kind = t => t === '+' ? 'add' : t === '-' ? 'del' : '';

  let rows = '';
  if (!collapsed) {
    f.hunks.forEach((h, k) => {
      const hidden = h.newStart - (k ? lastNo(f.hunks[k - 1], 2) : 0) - 1;
      rows += `<tr class="hunk"><td colspan="${cols}">${canExpand && hidden > 0 ? expandBtn(k, `Show ${hidden} line${hidden > 1 ? 's' : ''}`) : ''}<span>${esc(h.header)}</span></td></tr>`;
      if (!S.split) {
        for (const [t, o, n, s] of h.lines) {
          const side = t === '-' ? 'old' : 'new', line = t === '-' ? o : n;
          rows += `<tr class="ln ${kind(t)}" data-file="${i}">
            <td class="no" data-act="add" data-side="${side}" data-line="${line}">${o ?? ''}</td><td class="no" data-act="add" data-side="${side}" data-line="${line}">${n ?? ''}</td>
            <td class="code"><span class="mk">${t}</span>${HL.highlight(s, fam)}</td></tr>` + thread([[side, line, s]]);
        }
        return;
      }
      // Split view: pair each run of removed lines with the run of added lines after it.
      const L = h.lines;
      let j = 0;
      const pair = (l, r) => {
        const left = !l ? '<td class="no blank"></td><td class="code blank"></td>'
          : l[0] === '-' ? no('old', l[1], 'del') + `<td class="code del">${HL.highlight(l[3], fam)}</td>`
          : no('new', l[2]) + `<td class="code">${HL.highlight(l[3], fam)}</td>`;
        const right = !r ? '<td class="no blank"></td><td class="code blank"></td>'
          : no('new', r[2], kind(r[0])) + `<td class="code ${kind(r[0])}">${HL.highlight(r[3], fam)}</td>`;
        const keys = [];
        if (l?.[0] === '-') keys.push(['old', l[1], l[3]]);
        if (r) keys.push(['new', r[2], r[3]]);
        rows += `<tr class="ln sp" data-file="${i}">${left}${right}</tr>` + thread(keys);
      };
      while (j < L.length) {
        if (L[j][0] === ' ') { pair(L[j], L[j]); j++; continue; }
        const dels = [], adds = [];
        while (j < L.length && L[j][0] === '-') dels.push(L[j++]);
        while (j < L.length && L[j][0] === '+') adds.push(L[j++]);
        for (let m = 0; m < Math.max(dels.length, adds.length); m++) pair(dels[m], adds[m]);
      }
    });
    if (canExpand && f.hunks.length && !f.endLoaded) rows += `<tr class="hunk"><td colspan="${cols}">${expandBtn('end', 'Show rest of file')}</td></tr>`;
  }
  const fileLevel = items.filter(it => it.line == null || !rowKeys.has(`${it.side || 'new'}|${it.line}`));
  const fileDraft = d?.mode === 'new' && d.file === f.path && d.line == null;
  const big = f.add + f.del > 1500;
  const colgroup = S.split ? '<col class="cno"><col><col class="cno"><col>' : '<col class="cno"><col class="cno"><col>';

  return `<section class="file" id="f${i}">
    <div class="fh"><span class="st st-${f.status}">${f.status}</span>
      <span class="path" data-act="toggle-file" data-file="${i}">${collapsed ? '▸' : '▾'} ${f.status === 'renamed' ? esc(f.oldPath) + ' → ' : ''}${esc(f.path)}</span>
      <span class="add-c">+${f.add}</span><span class="del-c">−${f.del}</span>
      ${items.length ? `<span class="cnt">${items.length} comment${items.length > 1 ? 's' : ''}</span>` : ''}
      <button class="link" data-act="file-comment" data-file="${i}">Comment on file</button>
      <label class="chk"><input type="checkbox" data-act="viewed" data-file="${i}" ${isViewed(f) ? 'checked' : ''}> Viewed</label>
    </div>
    ${!collapsed && (fileLevel.length || fileDraft) ? `<div class="filelevel">${fileLevel.map(it => renderCard(it, null)).join('')}${fileDraft ? renderDraft() : ''}</div>` : ''}
    ${f.binary ? '<div class="filelevel muted">Binary file</div>' : ''}
    ${collapsed && big && !isViewed(f) ? `<div class="filelevel muted">Large diff (${f.add + f.del} lines) hidden. Click the file name to show it.</div>` : ''}
    ${rows ? `<table class="diff ${S.split ? 'split' : ''}"><colgroup>${colgroup}</colgroup>${rows}</table>` : ''}
  </section>`;
}

function renderCommits() {
  return `<div class="panel">${S.cmp.commits.map(c => `<div class="commit">
    <div class="row"><b>${esc(c.subject)}</b><span class="grow"></span><code>${short(c.sha)}</code></div>
    <div class="muted">${esc(c.author)} · ${ago(c.date)} · ${new Date(c.date).toLocaleString()}</div>
    ${c.body ? `<pre>${esc(c.body)}</pre>` : ''}</div>`).join('') || '<p class="muted">No commits.</p>'}</div>`;
}

// ---------- job polling ----------
let pollT;
async function pollJob() {
  clearTimeout(pollT);
  if (!S.job) return;
  const { id, head } = S.job;
  let job;
  try { job = await api('GET', `/api/job?id=${id}`); } catch { job = null; }
  if (S.head !== head) return;
  S.job = job;
  if (job?.status === 'running') {
    const log = $('#jobLog');
    if (!log) render();
    else {
      $('#jobElapsed').textContent = dur(Date.now() - job.startedAt);
      log.textContent = job.log.slice(-30).join('\n');
      log.scrollTop = log.scrollHeight;
    }
    pollT = setTimeout(pollJob, 1500);
    return;
  }
  if (job?.status === 'done') {
    S.ai = (await api('GET', `/api/review?repo=${S.repo}&head=${enc(head)}`)).ai;
    toast(`Claude review done: ${S.ai?.findings.length ?? 0} findings`);
    S.tab = 'overview';
  }
  render();
}

// ---------- export ----------
function buildMarkdown() {
  const c = S.cmp, r = S.review;
  const out = [`# Code review: \`${S.head}\` into \`${S.base === r.reviewedSha ? S.defaultBase : S.base}\``, ''];
  out.push(`Reviewed commit \`${short(c.headSha)}\` · ${c.commits.length} commits · ${c.files.length} files · ${new Date().toLocaleDateString()}`, '');
  if (r.verdict) out.push(`**Verdict: ${VERDICT[r.verdict]}**`, '');
  if (r.summary.trim()) out.push('## Summary', '', r.summary.trim(), '');
  const comments = r.comments.slice().sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  if (comments.length) {
    const counts = SEVS.map(s => [s, comments.filter(x => (x.severity || 'minor') === s).length]).filter(x => x[1]).map(([s, n]) => `${n} ${s}`).join(', ');
    out.push(`## Comments (${counts})`, '');
    const indent = s => String(s).split('\n').map(l => '  ' + l).join('\n');
    let file = null;
    for (const cm of comments) {
      if (cm.file !== file) { file = cm.file; out.push(`### \`${file}\``, ''); }
      out.push(`- **[${cm.severity || 'minor'}]** ${cm.line ? `Line ${cm.line}` : 'Whole file'}${cm.title ? `: **${cm.title}**` : ''}`);
      if (cm.lineText?.trim()) out.push('', '  ```', indent(cm.lineText.trim()), '  ```');
      if (cm.body) out.push('', indent(cm.body));
      if (cm.suggestion) out.push('', '  Suggested change:', '', '  ```', indent(cm.suggestion), '  ```');
      out.push('');
    }
  } else out.push('No line comments.', '');
  return out.join('\n');
}

function openExport() {
  openDialog(`<h2>Export review</h2>
    <p class="muted">No PR system, so send this to the developer (Teams, email, or commit it as REVIEW.md on their branch).</p>
    <textarea id="mdOut" rows="22" style="font-family:var(--mono);font-size:12px">${esc(buildMarkdown())}</textarea>
    <div class="row"><button type="button" class="primary" data-act="copy-md">Copy</button><button type="button" data-act="download-md">Download .md</button><span class="grow"></span><button>Close</button></div>`);
}

// ---------- dialogs ----------
function openDialog(html) {
  $('#dlgBody').innerHTML = html;
  $('#dlg').showModal();
}

function openAddRepo() {
  openDialog(`<h2>Add repository</h2>
    <p class="muted">Browse to a repo you already cloned, or pick a folder and click "Find repos" to list every git repo inside it.</p>
    <div class="row">
      <button type="button" data-act="browse-up" title="Parent folder">Up</button>
      <input type="text" id="browsePath" class="grow" placeholder="Drives and home" aria-label="Folder path">
      <button type="button" data-act="browse-go">Go</button>
      <button type="button" data-act="scan">Find repos here</button>
    </div>
    <div id="browseList" class="browse"><div class="muted">Loading…</div></div>
    <details><summary>Not cloned yet? Clone from the server</summary>
      <label>Clone URL <input type="text" id="repoUrl" placeholder="http://bonobo-server/Git/MyProject.git"></label>
      <label>Into folder (new or empty) <input type="text" id="repoPath" placeholder="C:\\Code\\MyProject"></label>
      <div class="row"><button type="button" data-act="clone-repo">Clone and add (VPN on)</button></div>
    </details>
    <div class="row"><span class="grow"></span><button>Done</button></div>`);
  browse(store.get('browsePath') || '');
}

const norm = p => p.replace(/[\\/]+$/, '').toLowerCase();
const isAdded = p => S.config.repos.some(r => norm(r.path) === norm(p));
const repoRow = (name, p, sub) => `<div class="brow"><span class="tag">git</span><span class="grow" title="${esc(p)}">${esc(name)}${sub ? ` <span class="muted">${esc(sub)}</span>` : ''}</span>
  ${isAdded(p) ? '<span class="muted">Added</span>' : `<button type="button" data-act="add-local" data-path="${esc(p)}">Add</button>`}</div>`;

async function browse(p) {
  const list = $('#browseList');
  try {
    const r = await api('GET', `/api/browse?path=${enc(p)}`);
    S.browse = r;
    store.set('browsePath', r.path);
    $('#browsePath').value = r.path;
    list.innerHTML = (r.isRepo ? repoRow('This folder is a repo', r.path) : '') + (r.dirs.map(d => d.isRepo
      ? repoRow(d.name, d.path)
      : `<div class="brow dir" data-act="browse-open" data-path="${esc(d.path)}"><span class="tag">dir</span><span class="grow">${esc(d.name)}</span></div>`).join('') || '<div class="muted">No subfolders.</div>');
  } catch (e) { toast(e.message); }
}

async function addLocal(p) {
  S.config = await api('POST', '/api/repos', { path: p });
  renderRepoSelect();
  if (!S.repo) await selectRepo(S.config.repos[S.config.repos.length - 1].id);
  toast(`Added ${p}`);
}

function openSettings() {
  const st = S.config.settings || {};
  openDialog(`<h2>Settings</h2>
    <label>Claude model (blank = your Claude Code default; e.g. opus, sonnet) <input type="text" id="setModel" value="${esc(st.model)}"></label>
    <label>Review guidelines for all repos (team rules Claude should enforce)
      <textarea id="setGuidelines" placeholder="e.g. All DB access through repositories. No raw SQL string concat. Async all the way down.">${esc(st.guidelines)}</textarea></label>
    <h2>Repositories</h2>
    ${S.config.repos.map(r => `<div class="repo-edit" data-repo="${r.id}">
      <div class="row"><b>${esc(r.name)}</b><span class="muted">${esc(r.path)}</span><span class="grow"></span><button type="button" class="link" data-act="remove-repo" data-id="${r.id}">Remove</button></div>
      <label>Default base branch (blank = auto-detect) <input type="text" data-k="base" value="${esc(r.base)}" placeholder="origin/master"></label>
      <label>Model override <input type="text" data-k="model" value="${esc(r.model)}"></label>
      <label>Repo-specific guidelines <textarea data-k="guidelines">${esc(r.guidelines)}</textarea></label>
    </div>`).join('') || '<p class="muted">No repos.</p>'}
    <p class="muted">Tip: a CLAUDE.md file in a repo is also read by Claude during review.</p>
    <div class="row"><button type="button" class="primary" data-act="save-settings">Save</button><button>Cancel</button></div>`);
}

// ---------- actions ----------
const findDraftFile = i => S.cmp.files[+i];
const actions = {
  'branch': el => selectBranch(el.dataset.name),
  'theme'() {
    const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = t;
    store.set('theme', t);
  },
  'tab': el => { S.tab = el.dataset.tab; render(); },
  'add-repo': openAddRepo,
  'settings': openSettings,

  async 'fetch'(el) {
    if (!S.repo) return;
    el.disabled = true;
    el.lastElementChild.textContent = 'Fetching…';
    try {
      await api('POST', `/api/fetch?repo=${S.repo}`);
      toast('Fetched');
      await loadBranches();
      if (S.head) await loadCompare();
    } catch (e) { toast('Fetch failed (VPN?): ' + e.message); }
    el.disabled = false;
    el.lastElementChild.textContent = 'Fetch';
  },

  'add'(el) {
    const f = findDraftFile(el.closest('[data-file]').dataset.file);
    const side = el.dataset.side, line = +el.dataset.line;
    captureDraft();
    if (S.draft?.text?.trim() && !confirm('Discard the comment you are writing?')) return;
    S.draft = { mode: 'new', file: f.path, side, line, lineText: lineTextFor(f.path, side, line), text: '', severity: 'minor', focus: true };
    render();
  },
  async 'expand'(el) {
    const f = findDraftFile(el.dataset.file);
    const key = `${S.cmp.headSha}:${f.path}`;
    el.disabled = true;
    S.fileCache[key] ??= (await api('GET', `/api/file?repo=${S.repo}&sha=${S.cmp.headSha}&path=${enc(f.path)}`)).lines;
    expandGap(f, el.dataset.gap, S.fileCache[key]);
    render();
  },
  async 'ask-claude'() {
    captureDraft();
    const d = S.draft;
    if (!d.text.trim()) return toast('Type your question in the box first');
    d.asking = true;
    render();
    try {
      const r = await api('POST', `/api/ask?repo=${S.repo}`, { head: S.head, file: d.file, line: d.line, question: d.text, context: askContext(d) });
      d.answer = r.answer;
    } catch (e) { toast(e.message); }
    d.asking = false;
    if (S.draft === d) render();
  },
  'use-answer'() {
    $('#draftText').value = S.draft.answer; // render() reads the textarea back into the draft
    S.draft.answer = null;
    S.draft.focus = true;
    render();
  },
  'drop-answer'() { S.draft.answer = null; render(); },
  'file-comment'(el) {
    const f = findDraftFile(el.dataset.file);
    S.collapsed.delete(f.path);
    S.draft = { mode: 'new', file: f.path, side: 'new', line: null, lineText: null, text: '', severity: 'minor', focus: true };
    render();
  },
  'save-draft'() {
    captureDraft();
    const d = S.draft;
    if (!d?.text.trim()) return toast('Comment is empty');
    if (d.mode === 'new') {
      S.review.comments.push({ id: crypto.randomUUID(), source: 'me', file: d.file, side: d.side, line: d.line, lineText: d.lineText, severity: d.severity, body: d.text.trim(), createdAt: Date.now() });
    } else {
      const c = S.review.comments.find(x => x.id === d.id);
      if (c) Object.assign(c, { body: d.text.trim(), severity: d.severity });
    }
    S.draft = null;
    save();
    render();
  },
  'cancel-draft'() { S.draft = null; render(); },
  'edit'(el) {
    const c = S.review.comments.find(x => x.id === el.dataset.id);
    S.draft = { mode: 'edit', id: c.id, text: c.body, severity: c.severity, focus: true };
    render();
  },
  'del'(el) {
    if (!confirm('Delete this comment?')) return;
    S.review.comments = S.review.comments.filter(x => x.id !== el.dataset.id);
    save();
    render();
  },
  'keep'(el) {
    S.review.comments.push(fromFinding(S.ai.findings.find(f => f.id === el.dataset.id)));
    save();
    render();
  },
  'keep-edit'(el) {
    const c = fromFinding(S.ai.findings.find(f => f.id === el.dataset.id));
    S.review.comments.push(c);
    S.draft = { mode: 'edit', id: c.id, text: c.body, severity: c.severity, focus: true };
    if (S.cmp.files.some(f => f.path === c.file)) S.tab = 'files'; // Overview doesn't render kept comments, so edit where it lives
    save();
    render();
  },
  'dismiss'(el) { S.review.dismissed[el.dataset.id] = true; save(); render(); },
  'keep-all'() { pendingFindings().forEach(f => S.review.comments.push(fromFinding(f))); save(); render(); },
  'keep-major'() { pendingFindings().filter(f => f.severity === 'blocker' || f.severity === 'major').forEach(f => S.review.comments.push(fromFinding(f))); save(); render(); },
  'dismiss-all'() { if (!confirm('Dismiss all pending Claude suggestions?')) return; pendingFindings().forEach(f => { S.review.dismissed[f.id] = true; }); save(); render(); },
  'use-summary'() {
    const ai = S.ai;
    const text = ai.summary + (ai.praise?.length ? `\n\nWhat you did well:\n${ai.praise.map(p => `- ${p}`).join('\n')}` : '');
    S.review.summary = S.review.summary.trim() ? `${S.review.summary.trim()}\n\n${text}` : text;
    save();
    render();
  },
  'toggle-file'(el) {
    const p = findDraftFile(el.dataset.file).path;
    S.collapsed.has(p) ? S.collapsed.delete(p) : S.collapsed.add(p);
    render();
  },
  'verdict'(el) {
    const v = el.dataset.v;
    S.review.verdict = S.review.verdict === v ? null : v;
    S.review.reviewedSha = S.review.verdict ? S.cmp?.headSha : null;
    const b = S.branches.find(x => x.name === S.head);
    if (b) b.review = { verdict: S.review.verdict, reviewedSha: S.review.reviewedSha };
    save();
    render();
    renderBranches();
  },
  'since'() { S.base = S.review.reviewedSha; loadCompare(); },
  'full-diff'() { S.base = S.review.base || S.defaultBase; loadCompare(); },
  'export': openExport,
  async 'copy-md'() {
    try { await navigator.clipboard.writeText($('#mdOut').value); toast('Copied'); }
    catch { $('#mdOut').select(); toast('Press Ctrl+C to copy'); }
  },
  'download-md'() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([$('#mdOut').value], { type: 'text/markdown' }));
    a.download = `review-${S.head.replace(/[\\/:*?"<>|]/g, '_')}-${short(S.cmp.headSha)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  },
  async 'run-ai'(el) {
    S.focus = $('#focusInput').value.trim();
    el.disabled = true;
    try {
      S.job = await api('POST', `/api/ai-review?repo=${S.repo}`, { base: S.base, head: S.head, focus: S.focus });
      render();
      pollJob();
    } catch (e) { toast(e.message); el.disabled = false; }
  },
  async 'cancel-ai'() { await api('POST', `/api/job/cancel?id=${S.job.id}`); },
  'clear-job'() { S.job = null; render(); },

  'browse-open': el => browse(el.dataset.path),
  'browse-up'() {
    const p = $('#browsePath').value.trim();
    if (!p) return;
    browse(S.browse?.path && norm(S.browse.path) === norm(p) ? S.browse.parent || '' : p + '/..');
  },
  'browse-go': () => browse($('#browsePath').value.trim()),
  async 'scan'(el) {
    const root = $('#browsePath').value.trim();
    if (!root) return toast('Open a folder first, e.g. C:\\ or your code folder');
    el.disabled = true;
    el.textContent = 'Searching…';
    try {
      const r = await api('GET', `/api/scan?path=${enc(root)}`);
      const notAdded = r.repos.filter(x => !isAdded(x.path));
      $('#browseList').innerHTML = `<div class="row"><b>${r.repos.length} repos in ${esc(r.root)}</b><span class="grow"></span>
        ${notAdded.length > 1 ? `<button type="button" data-act="add-all">Add all ${notAdded.length}</button>` : ''}
        <button type="button" data-act="browse-go">Back to folders</button></div>`
        + (r.repos.map(x => { const sub = x.path.slice(r.root.length).replace(/^[\\/]/, ''); return repoRow(x.name, x.path, sub !== x.name && sub); }).join('') || '<div class="muted">No git repos found (searched 4 levels deep).</div>');
    } catch (e) { toast(e.message); }
    el.disabled = false;
    el.textContent = 'Find repos here';
  },
  async 'add-local'(el) {
    el.disabled = true;
    try { await addLocal(el.dataset.path); el.outerHTML = '<span class="muted">Added</span>'; }
    catch (e) { toast(e.message); el.disabled = false; }
  },
  async 'add-all'(el) {
    el.disabled = true;
    for (const b of [...document.querySelectorAll('#browseList [data-act=add-local]')]) await actions['add-local'](b);
    el.remove();
  },
  async 'clone-repo'(el) {
    const path = $('#repoPath').value.trim(), url = $('#repoUrl').value.trim();
    if (!path || !url) return toast('Give both the clone URL and the folder');
    el.disabled = true;
    el.textContent = 'Cloning… (can take a while)';
    try {
      S.config = await api('POST', '/api/repos', { path, url });
      $('#dlg').close();
      await selectRepo(S.config.repos[S.config.repos.length - 1].id);
    } catch (e) { toast(e.message); }
    el.disabled = false;
    el.textContent = 'Clone and add (VPN on)';
  },
  async 'remove-repo'(el) {
    if (!confirm('Remove this repo from the reviewer? Your clone and saved reviews stay on disk.')) return;
    S.config = await api('DELETE', `/api/repos?repo=${el.dataset.id}`);
    $('#dlg').close();
    renderRepoSelect();
    if (S.repo === el.dataset.id) S.config.repos[0] ? selectRepo(S.config.repos[0].id) : (S.repo = null, S.head = null, S.branches = [], renderBranches(), render());
  },
  async 'save-settings'() {
    try {
      S.config = await api('PUT', '/api/settings', { model: $('#setModel').value, guidelines: $('#setGuidelines').value });
      for (const box of document.querySelectorAll('.repo-edit')) {
        const body = { id: box.dataset.repo };
        box.querySelectorAll('[data-k]').forEach(i => { body[i.dataset.k] = i.value; });
        S.config = await api('PUT', '/api/repos', body);
      }
      $('#dlg').close();
      toast('Saved');
      await loadBranches();
    } catch (e) { toast(e.message); }
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT') return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  Promise.resolve(fn(el)).catch(err => toast(err.message));
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'repoSelect') selectRepo(t.value);
  else if (t.id === 'hideMerged') renderBranches();
  else if (t.id === 'baseSelect') {
    S.base = t.value;
    if (t.value !== S.review.reviewedSha) { S.review.base = t.value; save(); }
    loadCompare();
  } else if (t.id === 'wsToggle') { S.ws = t.checked; loadCompare(); }
  else if (t.id === 'splitToggle') { S.split = t.checked; store.set('split', t.checked ? '1' : '0'); render(); }
  else if (t.dataset.act === 'viewed') {
    const f = findDraftFile(t.dataset.file);
    if (t.checked) { S.review.viewed[f.path] = f.sig; S.collapsed.add(f.path); }
    else { delete S.review.viewed[f.path]; S.collapsed.delete(f.path); }
    save();
    render();
  }
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'branchFilter') renderBranches();
  else if (t.id === 'summaryInput') { S.review.summary = t.value; save(); }
  else if (t.id === 'focusInput') S.focus = t.value;
});

document.addEventListener('keydown', e => {
  // Enter in the path box would submit (and close) the dialog form.
  if (e.target.id === 'browsePath' && e.key === 'Enter') { e.preventDefault(); actions['browse-go'](); return; }
  if (e.target.id !== 'draftText') return;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); actions['save-draft'](); }
  else if (e.key === 'Escape') { e.preventDefault(); actions['cancel-draft'](); }
});

window.addEventListener('beforeunload', () => {
  if (pending) fetch(pending.url, { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Reviewer': '1' }, body: JSON.stringify(pending.data) });
});

init().catch(e => toast(e.message));
