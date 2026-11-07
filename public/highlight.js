// Tiny syntax highlighter for diff lines. No dependencies, works offline.
// shortcut: highlights each line on its own, so a multi-line string or block comment is colored only
// on its first line; swap in a full highlighter (e.g. highlight.js) if that starts to matter.
(function (root) {
  const KW = new Set(('abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double ' +
    'dynamic else enum event explicit extern false finally fixed float for foreach from function get goto if implicit import in init int ' +
    'interface internal is let lock long namespace new null object operator out override params partial private protected public readonly ' +
    'record ref required return sbyte sealed set short sizeof static string struct super switch this throw true try typeof uint ulong ' +
    'unchecked unsafe ushort using var virtual void volatile when where while yield export extends implements instanceof package type ' +
    'undefined of def elif except lambda None True False pass raise with not and or nonlocal global del assert func go chan defer map range ' +
    'select fallthrough fn mut pub impl trait match loop crate nameof self Self final throws native synchronized transient boolean echo ' +
    'then fi esac done param begin end process').split(' '));
  const SQL = new Set(('select from where insert into update delete join left right inner outer full cross on group by order having limit ' +
    'offset values set create table view alter drop index and or not null as distinct union all exists like in is between case when then ' +
    'else end primary key foreign references begin commit rollback transaction declare exec execute procedure function returns return top ' +
    'with asc desc count sum avg min max cast convert nolock if go use database default identity constraint unique check trigger ' +
    'merge using matched output').split(' '));

  const STR = String.raw`"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?`;
  const RX = {
    c: new RegExp(String.raw`(\/\/.*$|\/\*.*?(?:\*\/|$))|(${STR}|\x60(?:\\.|[^\x60\\])*\x60?)|(\b\d[\w.]*)|([A-Za-z_$@][\w$]*)`, 'g'),
    hash: new RegExp(String.raw`(#.*$)|(${STR})|(\b\d[\w.]*)|([A-Za-z_$@][\w$-]*)`, 'g'),
    sql: new RegExp(String.raw`(--.*$|\/\*.*?(?:\*\/|$))|('(?:''|[^'])*'?|"[^"]*"?)|(\b\d[\w.]*)|([A-Za-z_@#][\w$]*)`, 'g'),
    markup: new RegExp(String.raw`(<!--.*?(?:-->|$)|@\*.*?(?:\*@|$))|("[^"]*"?|'[^']*'?)|(\b\d[\w.]*)|(<\/?[\w:.-]+|\/?>)`, 'g'),
  };
  const FAMILY = {
    hash: 'py rb sh bash zsh yml yaml toml ini ps1 psm1 psd1 r pl dockerfile conf properties gitignore env editorconfig makefile',
    sql: 'sql',
    markup: 'html htm xml cshtml razor vue svelte xaml csproj vbproj props targets config svg resx nuspec',
    none: 'md txt csv log lock',
  };
  const famOf = {};
  for (const [fam, exts] of Object.entries(FAMILY)) for (const e of exts.split(' ')) famOf[e] = fam;

  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function family(path) {
    const name = path.split('/').pop().toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : name;
    const fam = famOf[ext] || 'c';
    return fam === 'none' ? null : fam;
  }

  // Returns escaped HTML with <span class="hX"> tokens: k keyword, s string, c comment, n number, f function, t type.
  function highlight(text, fam) {
    if (!fam) return esc(text);
    let out = '', last = 0;
    text.replace(RX[fam], (m, com, str, num, word, idx) => {
      out += esc(text.slice(last, idx));
      last = idx + m.length;
      let cls = com ? 'c' : str ? 's' : num ? 'n' : '';
      if (word) {
        if (fam === 'markup') cls = 'k';
        else if (fam === 'sql' ? SQL.has(word.toLowerCase()) : KW.has(word)) cls = 'k';
        else if (text[last] === '(') cls = 'f';
        else if (/^[A-Z][a-z0-9]/.test(word)) cls = 't';
      }
      out += cls ? `<span class="h${cls}">${esc(m)}</span>` : esc(m);
      return m;
    });
    return out + esc(text.slice(last));
  }

  const api = { family, highlight };
  if (typeof module !== 'undefined') module.exports = api; else root.HL = api;
})(this);
