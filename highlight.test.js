const test = require('node:test');
const assert = require('node:assert');
const { family, highlight } = require('./public/highlight');

test('family by extension', () => {
  assert.equal(family('src/A.cs'), 'c');
  assert.equal(family('db/q.SQL'), 'sql');
  assert.equal(family('build.ps1'), 'hash');
  assert.equal(family('Views/x.cshtml'), 'markup');
  assert.equal(family('README.md'), null);
});

test('c-like tokens, and comment markers inside strings stay strings', () => {
  const h = highlight('var url = "http://x"; // done', 'c');
  assert.equal(h, '<span class="hk">var</span> url = <span class="hs">&quot;http://x&quot;</span>; <span class="hc">// done</span>');
  assert.match(highlight('Foo(1)', 'c'), /<span class="hf">Foo<\/span>\(<span class="hn">1<\/span>\)/);
  assert.match(highlight('new List<int>()', 'c'), /<span class="ht">List<\/span>&lt;<span class="hk">int<\/span>&gt;/);
});

test('sql is case-insensitive and escapes html', () => {
  assert.equal(highlight("SELECT * FROM t WHERE n = '<x>'", 'sql'),
    '<span class="hk">SELECT</span> * <span class="hk">FROM</span> t <span class="hk">WHERE</span> n = <span class="hs">&#39;&lt;x&gt;&#39;</span>');
});

test('plain text is only escaped', () => {
  assert.equal(highlight('<b>', null), '&lt;b&gt;');
});
