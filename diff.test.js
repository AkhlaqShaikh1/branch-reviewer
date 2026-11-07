const test = require('node:test');
const assert = require('node:assert');
const { parseDiff, annotate } = require('./diff');

const sample = [
  'diff --git a/src/a.cs b/src/a.cs',
  'index 111..222 100644',
  '--- a/src/a.cs',
  '+++ b/src/a.cs',
  '@@ -10,3 +10,4 @@ class A',
  ' keep\r',
  '-old',
  '+new1',
  '+new2',
  ' tail',
  'diff --git a/old name.txt b/new name.txt',
  'similarity index 100%',
  'rename from old name.txt',
  'rename to new name.txt',
  'diff --git a/added.js b/added.js',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/added.js',
  '@@ -0,0 +1 @@',
  '+x',
  '\\ No newline at end of file',
  'diff --git a/img.png b/img.png',
  'Binary files a/img.png and b/img.png differ',
  '',
].join('\n');

test('parseDiff', () => {
  const [a, r, n, b] = parseDiff(sample);
  assert.equal(a.path, 'src/a.cs');
  assert.deepEqual([a.add, a.del], [2, 1]);
  assert.deepEqual(a.hunks[0].lines, [
    [' ', 10, 10, 'keep'], ['-', 11, null, 'old'], ['+', null, 11, 'new1'], ['+', null, 12, 'new2'], [' ', 12, 13, 'tail'],
  ]);
  assert.deepEqual([r.status, r.oldPath, r.path], ['renamed', 'old name.txt', 'new name.txt']);
  assert.deepEqual([n.status, n.path, n.hunks[0].lines], ['added', 'added.js', [['+', null, 1, 'x']]]);
  assert.equal(b.binary, true);
});

test('annotate numbers new lines and skips binaries', () => {
  const out = annotate(parseDiff(sample));
  assert.match(out, / {3}11 \+new1/);
  assert.match(out, / {6}-old/);
  assert.match(out, /img\.png.*\n\(skipped/);
});
