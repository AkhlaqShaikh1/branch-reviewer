// Unified diff parser shared by the server (for the UI) and the Claude prompt builder.
// Line tuple: [type, oldNo, newNo, text] where type is '+', '-' or ' '.

function parseDiff(text) {
  const files = [];
  let f = null, h = null, oldNo = 0, newNo = 0;
  for (let line of text.split('\n')) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      f = { oldPath: m ? m[1] : '', path: m ? m[2] : '', status: 'modified', binary: false, add: 0, del: 0, hunks: [] };
      files.push(f);
      h = null;
      continue;
    }
    if (!f) continue;
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!m) continue;
      oldNo = +m[1];
      newNo = +m[2];
      h = { header: line, oldStart: oldNo, newStart: newNo, lines: [] };
      f.hunks.push(h);
      continue;
    }
    if (!h) {
      if (line.startsWith('new file mode')) f.status = 'added';
      else if (line.startsWith('deleted file mode')) f.status = 'deleted';
      else if (line.startsWith('rename from ')) { f.oldPath = line.slice(12); f.status = 'renamed'; }
      else if (line.startsWith('rename to ')) f.path = line.slice(10);
      else if (line.startsWith('Binary files')) f.binary = true;
      else if (line.startsWith('--- ') && !line.startsWith('--- /dev/null')) f.oldPath = line.slice(4).replace(/^a\//, '').replace(/\t$/, '');
      else if (line.startsWith('+++ ') && !line.startsWith('+++ /dev/null')) f.path = line.slice(4).replace(/^b\//, '').replace(/\t$/, '');
      continue;
    }
    const c = line[0];
    if (c === '+') { h.lines.push(['+', null, newNo++, line.slice(1)]); f.add++; }
    else if (c === '-') { h.lines.push(['-', oldNo++, null, line.slice(1)]); f.del++; }
    else if (c === ' ') h.lines.push([' ', oldNo++, newNo++, line.slice(1)]);
  }
  return files;
}

// Lock files and generated assets: shown in the UI, but not worth Claude's tokens.
const NOISE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|packages\.lock\.json|composer\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock)$|\.min\.(js|css)$|\.map$|\.designer\.cs$/i;

// Diff text for the prompt, each line prefixed with its NEW-file line number so findings anchor correctly.
function annotate(files, maxChars = 400000) {
  let out = '';
  for (const f of files) {
    const head = `\n=== ${f.status.toUpperCase()}: ${f.status === 'renamed' ? f.oldPath + ' -> ' : ''}${f.path} (+${f.add} -${f.del})\n`;
    if (f.binary || NOISE.test(f.path)) { out += head + '(skipped: binary or generated file)\n'; continue; }
    let body = '';
    for (const h of f.hunks) {
      body += h.header + '\n';
      for (const [t, , n, s] of h.lines) body += `${n == null ? '     ' : String(n).padStart(5)} ${t}${s}\n`;
    }
    if (out.length + body.length > maxChars) { out += head + '(diff too large to include here: Read this file in the working tree)\n'; continue; }
    out += head + body;
  }
  return out;
}

module.exports = { parseDiff, annotate, NOISE };
