/* Lmacs Evil, part two: Vim regular expressions, / and ? search, and the : command line.
   Ex commands are looked up in the Lisp alist evil-ex-commands, so evil.el and init.el can add more. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks, EC = globalThis.EvilCore;
const { intern, NIL, signal, pr, arr, listOf, truthy, Sym } = L;
const bool = b => !!b, T = true;
const { D, CMD, put, stateOf, setState, textToKeys, firstNonBlank } = EC;
const { bol, eol, column, lineNo, lastLineStart, lineStartOf } = Ed;
const cur = () => E.current;
const num = x => { if (typeof x !== 'number') signal('wrong-type-argument', 'expected an integer, got', x); return Math.trunc(x); };
const optNum = (x, d) => L.absent(x) ? d : num(x);

/* ---------- Vim regular expressions ---------- */
const POSIX = { alpha: '\\p{L}', digit: '0-9', alnum: '\\p{L}\\p{N}', space: '\\s', upper: '\\p{Lu}', lower: '\\p{Ll}', blank: ' \\t', punct: '\\p{P}', xdigit: '0-9A-Fa-f', word: '\\w' };
const CLASSES = { s: '[ \\t]', S: '[^ \\t\\n]', d: '\\d', D: '\\D', w: '[0-9A-Za-z_]', W: '[^0-9A-Za-z_]', a: '[A-Za-z]', A: '[^A-Za-z]',
  l: '[a-z]', L: '[^a-z]', u: '[A-Z]', U: '[^A-Z]', x: '[0-9A-Fa-f]', X: '[^0-9A-Fa-f]', h: '[A-Za-z_]', H: '[^A-Za-z_]',
  k: '[\\p{L}\\p{N}_]', i: '[\\p{L}\\p{N}_]', o: '[0-7]', O: '[^0-7]', n: '\\n', t: '\\t', e: '\\x1b', r: '\\r' };
const SYNTAX = /[\^$\\.*+?()[\]{}|\/]/;
function bracket(p, i) {
  let out = '[', j = i + 1;
  if (p[j] === '^') { out += '^'; j++; }
  if (p[j] === ']') { out += '\\]'; j++; }
  for (; j < p.length && p[j] !== ']'; j++) {
    if (p.startsWith('[:', j)) { const e = p.indexOf(':]', j); if (e > 0) { out += POSIX[p.slice(j + 2, e)] || ''; j = e + 1; continue; } }
    if (p[j] === '\\' && j + 1 < p.length) { const d = p[++j]; out += 'ntr'.includes(d) ? '\\' + d : 'dsw'.includes(d) ? '\\' + d : SYNTAX.test(d) || d === '-' ? '\\' + d : d; continue; }
    out += p[j] === '[' ? '\\[' : p[j];
  }
  if (j >= p.length) return null;
  return [out + ']', j + 1];
}
function convert(p, st) {
  let out = '', i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === '\\') {
      const d = p[i + 1]; i += 2;
      if (d === undefined) { out += '\\\\'; break; }
      if (d === 'v') { st.very = true; continue; }
      if (d === 'm' || d === 'M' || d === 'V') { st.very = false; continue; }
      if (d === 'c') { st.icase = true; continue; }
      if (d === 'C') { st.icase = false; continue; }
      if (st.very) { out += CLASSES[d] || (/[0-9]/.test(d) ? '\\' + d : SYNTAX.test(d) || '<>=@'.includes(d) ? (SYNTAX.test(d) ? '\\' + d : d) : d); continue; }
      if (d === '(') { out += '('; continue; }
      if (d === ')') { out += ')'; continue; }
      if (d === '|') { out += '|'; continue; }
      if (d === '+') { out += '+'; continue; }
      if (d === '?' || d === '=') { out += '?'; continue; }
      if (d === '<' || d === '>') { out += '\\b'; continue; }
      if (d === '{') {
        let j = p.indexOf('}', i); if (j < 0) j = p.length;
        let body = p.slice(i, j).replace(/\\$/, ''); i = j + 1;
        const lazy = body.startsWith('-'); if (lazy) body = body.slice(1);
        const q = body === '' ? '*' : `{${body.startsWith(',') ? '0' + body : body}}`;
        out += q + (lazy ? '?' : ''); continue;
      }
      if (d === '_') { const e = p[i++]; out += e === '.' ? '[\\s\\S]' : e === 's' ? '\\s' : e === '^' ? '^' : e === '$' ? '$' : CLASSES[e] ? CLASSES[e].replace(/^\[\^?/, m => m === '[^' ? '[^\\n' : '[\\n') : e; continue; }
      if (CLASSES[d]) { out += CLASSES[d]; continue; }
      if (/[0-9]/.test(d)) { out += '\\' + d; continue; }
      out += SYNTAX.test(d) ? '\\' + d : d;
      continue;
    }
    if (c === '[') { const r = bracket(p, i); if (r) { out += r[0]; i = r[1]; continue; } out += '\\['; i++; continue; }
    if (st.very) {
      if (c === '<' || c === '>') { out += '\\b'; i++; continue; }
      if (c === '=') { out += '?'; i++; continue; }
      if (c === '/') { out += '\\/'; i++; continue; }
      out += c; i++; continue;
    }
    if ('()|+?{}/'.includes(c)) { out += '\\' + c; i++; continue; }
    out += c; i++;
  }
  return out;
}
const reCache = new Map();
function vimRegex(pat) {
  const key = pat + '\u0000' + pr(L.get('evil-ex-search-case'));
  if (reCache.has(key)) return reCache.get(key);
  const st = { very: false, icase: null };
  let source;
  const zs = pat.indexOf('\\zs'), ze = pat.indexOf('\\ze');
  if (zs >= 0 || ze >= 0) {
    const a = zs >= 0 ? zs : 0, z = ze >= 0 ? ze : pat.length;
    const pre = zs >= 0 ? pat.slice(0, zs) : '', main = pat.slice(zs >= 0 ? a + 3 : 0, z), post = ze >= 0 ? pat.slice(z + 3) : '';
    source = (pre ? `(?<=${convert(pre, st)})` : '') + convert(main, st) + (post ? `(?=${convert(post, st)})` : '');
  } else source = convert(pat, st);
  let icase = st.icase;
  if (icase === null) {
    const mode = L.get('evil-ex-search-case');
    icase = mode === intern('insensitive') ? true : mode === intern('sensitive') ? false : !/[A-Z]/.test(pat.replace(/\\./g, ''));
  }
  let re;
  try { re = new RegExp(source, 'gmu' + (icase ? 'i' : '')); }
  catch (e) { signal('user-error', `E383: Invalid search string: ${pat}`); }
  if (reCache.size > 200) reCache.clear();
  reCache.set(key, re);
  return re;
}
/* Search T (a string or the buffer's rope) for RE from FROM. A pattern that cannot match across a
   line end (no newline classes, no lookaround, no s flag) is run on pieces of whole lines, about 64K
   at a time, outward from FROM: the matches are the same as in a scan of the whole text, but the
   cost follows the distance to the match, and the rope is never joined. Other patterns scan the
   whole text, as before. */
const lineLocal = r => !r.flags.includes('s') && !/\\[nsSWDrpP]|\[\^|\(\?[<=!]/.test(r.source);
const WIN = 65536;
function findMatch(t, re, from, dir, wrap) {
  const r = new RegExp(re.source, re.flags), n = t.length;
  if (typeof t !== 'string' && t.flat !== null) t = t.flat;
  if (lineLocal(r)) {
    const hit = m => m && { s: m.s, e: m.e, wrapped: false };
    if (dir > 0) {
      let m = from <= n ? hit(scanForward(t, r, from, n)) : null;
      if (m) return m;
      if (!wrap) return null;
      m = scanForward(t, r, 0, n);
      return m ? { s: m.s, e: m.e, wrapped: true } : null;
    }
    const m = scanBackward(t, r, from);
    if (m) return { s: m.s, e: m.e, wrapped: false };
    if (!wrap) return null;
    const z = scanBackward(t, r, n + 1);
    return z ? { s: z.s, e: z.e, wrapped: true } : null;
  }
  if (typeof t !== 'string') t = t.toString();
  if (dir > 0) {
    r.lastIndex = Math.min(from, t.length);
    let m = from <= t.length ? r.exec(t) : null;
    if (m) return { s: m.index, e: m.index + m[0].length, wrapped: false };
    if (!wrap) return null;
    r.lastIndex = 0; m = r.exec(t);
    return m ? { s: m.index, e: m.index + m[0].length, wrapped: true } : null;
  }
  let best = null, lastAll = null, m;
  r.lastIndex = 0;
  while ((m = r.exec(t))) {
    if (m.index < from) best = m;
    lastAll = m;
    if (m[0] === '') r.lastIndex++;
  }
  if (best) return { s: best.index, e: best.index + best[0].length, wrapped: false };
  if (wrap && lastAll) return { s: lastAll.index, e: lastAll.index + lastAll[0].length, wrapped: true };
  return null;
}
/* First match at or after FROM, in windows of whole lines. */
/* After a few windows without a match the rope is joined (once, cached): a long scan is then faster
   on one string than on copied pieces. */
const flatAfter = (t, k) => (k === 4 && typeof t !== 'string' ? t.toString() : t);
function scanForward(t, r, from, n) {
  for (let S = bol(t, from), at = from, k = 0; S < n || (S === n && at === n); t = flatAfter(t, ++k)) {
    let E = Math.min(n, S + WIN); if (E < n) E = eol(t, E);
    const sub = t.slice(S, E);
    r.lastIndex = at - S;
    const m = r.exec(sub);
    if (m) return { s: S + m.index, e: S + m.index + m[0].length };
    if (E >= n) return null;
    S = at = E + 1;
  }
  return null;
}
/* Last match that starts before FROM, as a scan from the start of the text would find it. */
function scanBackward(t, r, from) {
  const n = t.length;
  let E = from >= n ? n : eol(t, Math.max(0, from));
  for (let k = 0; ; t = flatAfter(t, ++k)) {
    const S = bol(t, Math.max(0, E - WIN)), sub = t.slice(S, E);
    let best = null, m;
    r.lastIndex = 0;
    while ((m = r.exec(sub)) && S + m.index < from) { best = m; if (m[0] === '') r.lastIndex++; }
    if (best) return { s: S + best.index, e: S + best.index + best[0].length };
    if (S === 0) return null;
    E = S - 1;
  }
}
const escapeVim = s => s.replace(/[\\\/.*$^~\[\]]/g, '\\$&');
D('evil-regexp-to-js', 'PATTERN', 'The JavaScript source of the Vim regular expression PATTERN.', ([p]) => vimRegex(p).source);

/* ---------- / ? n N * # ---------- */
function rememberSearch(pattern, dir) {
  E.search = { pattern, dir }; E.hlOff = false;
  if (E.searchHistory[0] !== pattern) E.searchHistory.unshift(pattern);
}
function searchMotion(b, pattern, dir, count) {
  const re = vimRegex(pattern);
  let pos = b.pt, wrapped = false;
  for (let i = 0; i < count; i++) {
    const m = findMatch(b.rope, re, dir > 0 ? pos + 1 : pos, dir, truthy(L.get('evil-search-wrap')));
    if (!m) signal('user-error', `E486: Pattern not found: ${pattern}`);
    if (m.wrapped) wrapped = true;
    pos = m.s;
  }
  b.pt = pos;
  E.echo = wrapped ? (dir > 0 ? 'search hit BOTTOM, continuing at TOP' : 'search hit TOP, continuing at BOTTOM') : (dir > 0 ? '/' : '?') + pattern;
  return false;
}
async function readSearch(dir) {
  const b = cur(), origin = b.pt;
  try {
    return await Ed.readMini(dir > 0 ? '/' : '?', '', null, {
      history: E.searchHistory,
      onChange: text => {
        E.preview = null;
        if (!text) return;
        let re; try { re = vimRegex(text); } catch (e) { return; }
        const m = findMatch(b.rope, re, dir > 0 ? origin + 1 : origin, dir, true);
        E.preview = { re, match: m ? [m.s, m.e] : null, b };
      },
    });
  } finally { E.preview = null; }
}
function searchCmd(dir) {
  return async () => {
    const c = E.prefixArg === null ? 1 : Ed.prefixNumeric(E.prefixArg);
    return [c, await readSearch(dir)];
  };
}
function doSearch(count, pattern, dir) {
  if (!pattern) { pattern = E.search.pattern; if (!pattern) signal('user-error', 'E35: No previous regular expression'); }
  vimRegex(pattern);
  rememberSearch(pattern, dir);
  return searchMotion(cur(), pattern, dir, count);
}
CMD('evil-search-forward', searchCmd(1), 'COUNT PATTERN', 'Search forward for the Vim regexp PATTERN (/).', ([c, p]) => doSearch(c, p, 1));
CMD('evil-search-backward', searchCmd(-1), 'COUNT PATTERN', 'Search backward for the Vim regexp PATTERN (?).', ([c, p]) => doSearch(c, p, -1));
CMD('evil-search-next', '<c>', '&optional COUNT', 'Repeat the last search in the same direction (n).', ([n]) => {
  if (!E.search.pattern) signal('user-error', 'E35: No previous regular expression');
  E.hlOff = false; return searchMotion(cur(), E.search.pattern, E.search.dir, optNum(n, 1));
});
CMD('evil-search-previous', '<c>', '&optional COUNT', 'Repeat the last search in the other direction (N).', ([n]) => {
  if (!E.search.pattern) signal('user-error', 'E35: No previous regular expression');
  E.hlOff = false; return searchMotion(cur(), E.search.pattern, -E.search.dir, optNum(n, 1));
});
function searchWord(dir, count) {
  const b = cur(), t = b.rope, le = eol(t, b.pt), isK = ch => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
  let s = b.pt;
  while (s < le && !isK(t.at(s))) s++;
  if (s >= le) signal('user-error', 'E348: No string under cursor');
  let a = s, z = s;
  while (a > bol(t, s) && isK(t.at(a - 1))) a--;
  while (z < le && isK(t.at(z))) z++;
  const pattern = `\\<${escapeVim(t.slice(a, z))}\\>`;
  rememberSearch(pattern, dir);
  b.pt = a;
  return searchMotion(b, pattern, dir, count);
}
CMD('evil-search-word-forward', '<c>', '&optional COUNT', 'Search forward for the word under point (*).', ([n]) => searchWord(1, optNum(n, 1)));
CMD('evil-search-word-backward', '<c>', '&optional COUNT', 'Search backward for the word under point (#).', ([n]) => searchWord(-1, optNum(n, 1)));
for (const n of ['evil-search-forward', 'evil-search-backward', 'evil-search-next', 'evil-search-previous', 'evil-search-word-forward', 'evil-search-word-backward']) {
  put(n, 'evil-motion-type', intern('exclusive')); put(n, 'evil-jump', T);
}
CMD('evil-ex-nohighlight', '', '', 'Hide the search highlighting until the next search (:noh).', () => { E.hlOff = true; return false; });

/* ---------- the : command line ---------- */
function exTable() {
  const out = [];
  for (const p of arr(L.get('evil-ex-commands') ?? NIL)) {
    const spec = L.car(p), cmd = L.cdr(p);
    if (typeof spec !== 'string') continue;
    const m = /^([^\[]*)(?:\[(.*)\])?$/.exec(spec);
    out.push({ req: m[1], full: m[1] + (m[2] || ''), cmd });
  }
  return out;
}
function resolveEx(name) {
  const tab = exTable();
  return (tab.find(e => e.full === name) || tab.find(e => name.length >= e.req.length && e.full.startsWith(name)) || null);
}
function lastLine(t) { return lineNo(t, lastLineStart(t)); }
function parseAddress(b, s, i, curLine) {
  const t = b.rope;
  let line = null;
  const c = s[i];
  if (/[0-9]/.test(c)) { let j = i; while (/[0-9]/.test(s[j])) j++; line = +s.slice(i, j); i = j; }
  else if (c === '.') { line = curLine; i++; }
  else if (c === '$') { line = lastLine(t); i++; }
  else if (c === "'") {
    const mk = s[i + 1]; i += 2;
    const pos = b.marks[mk === "'" ? '`' : mk];
    if (pos === undefined) signal('user-error', 'E20: Mark not set');
    line = lineNo(t, Math.min(pos, t.length));
  } else if (c === '/' || c === '?') {
    let j = i + 1, pat = '';
    while (j < s.length && s[j] !== c) { if (s[j] === '\\' && s[j + 1] === c) { pat += c; j += 2; continue; } pat += s[j++]; }
    i = j < s.length ? j + 1 : j;
    if (!pat) pat = E.search.pattern || '';
    const re = vimRegex(pat);
    const from = c === '/' ? Math.min(t.length, eol(t, lineStartOf(t, curLine)) + 1) : lineStartOf(t, curLine);
    const m = findMatch(t, re, from, c === '/' ? 1 : -1, true);
    if (!m) signal('user-error', `E486: Pattern not found: ${pat}`);
    line = lineNo(t, m.s);
  } else if (c === '+' || c === '-') line = curLine;
  if (line === null) return null;
  while (s[i] === '+' || s[i] === '-') {
    const sign = s[i] === '+' ? 1 : -1; i++;
    let j = i; while (/[0-9]/.test(s[j])) j++;
    line += sign * (j > i ? +s.slice(i, j) : 1); i = j;
  }
  return { line, i };
}
function parseRange(b, s) {
  const t = b.rope;
  let i = 0, curLine = lineNo(t, b.pt);
  while (s[i] === ' ' || s[i] === ':') i++;
  if (s[i] === '%') return { lines: [1, lastLine(t)], i: i + 1 };
  const a = parseAddress(b, s, i, curLine);
  if (!a) return { lines: null, i };
  i = a.i;
  if (s[i] === ',' || s[i] === ';') {
    if (s[i] === ';') curLine = a.line;
    const z = parseAddress(b, s, i + 1, curLine);
    if (z) return { lines: [a.line, z.line], i: z.i };
    return { lines: [a.line, curLine], i: i + 1 };
  }
  return { lines: [a.line, a.line], i };
}
function checkLines(t, lines) {
  let [l1, l2] = lines;
  if (l1 > l2) [l1, l2] = [l2, l1];
  const last = lastLine(t);
  if (l1 < 0 || l2 > last) signal('user-error', 'E16: Invalid range');
  return [Math.max(1, l1), Math.max(1, l2)];
}
function evalString(s) { let v = false; for (const f of L.readAll(s)) { L.resetOps(); v = L.ev(f); } return v; }
async function exExecute(line) {
  let s = line.replace(/^[\s:]+/, '');
  if (!s) return;
  if (s[0] === '(') { const v = evalString(s); Ed.message(pr(v, true)); return; }
  const b = cur(), t = b.rope;
  const r = parseRange(b, s);
  s = s.slice(r.i).replace(/^\s+/, '');
  const lines = r.lines ? checkLines(t, r.lines) : null;
  if (!s || s === '|') {
    if (!lines) return;
    EC.pushJump(b, b.pt);
    b.pt = firstNonBlank(b.rope, lineStartOf(b.rope, lines[1] === 0 ? 1 : lines[1]));
    return;
  }
  const m = /^([a-zA-Z]+|&&|[&<>=~!@*#]+)/.exec(s);
  if (!m) signal('user-error', `E492: Not an editor command: ${line}`);
  let name = m[1], rest = s.slice(name.length);
  let bang = false;
  if (/^[<>]+$/.test(name) && name.length > 1) { rest = name.slice(1) + rest; name = name[0]; }
  if (rest[0] === '!' && name !== '!') { bang = true; rest = rest.slice(1); }
  const arg = rest.replace(/^\s+/, '');
  const e = resolveEx(name);
  if (!e) signal('user-error', `E492: Not an editor command: ${line}`);
  const saved = E.ex;
  E.ex = { lines: lines && lines[0] === 0 ? [1, Math.max(1, lines[1])] : lines, arg: arg || null, bang, name, line };
  try { await Ed.callInteractively(e.cmd); }
  finally { E.ex = saved; }
}
EC.exExecute = exExecute;
D('evil-ex-execute', 'STRING', 'Run STRING as an ex command line.', ([s]) => exExecute(s).catch(err => { Ed.reportError(err); }));
const EX_OPTIONS = ['number', 'nonumber', 'relativenumber', 'norelativenumber', 'wrap', 'nowrap', 'ignorecase', 'noignorecase', 'smartcase', 'nosmartcase', 'hlsearch', 'nohlsearch', 'wrapscan', 'nowrapscan', 'shiftwidth='];
function exCompleter(text) {
  const m = /^(\s*(?:%|'<,'>|[.$\d,;+\-]*)\s*)([a-zA-Z]*)(!?)(\s+(.*))?$/.exec(text);
  if (!m) return [];
  const [, pre, name, bang, sp, arg] = m;
  if (sp === undefined) return [...new Set(exTable().map(e => e.full))].filter(n => /^[a-z]/i.test(n) && n.startsWith(name)).sort().map(n => pre + n);
  const e = resolveEx(name);
  if (!e) return [];
  const kind = L.prop(e.cmd, 'evil-ex-complete');
  let items = [];
  if (kind === intern('file')) items = Ed.Store.list().concat(E.buffers.filter(x => x.file).map(x => x.file));
  else if (kind === intern('buffer')) items = Ed.bufferNames();
  else if (kind === intern('option')) items = EX_OPTIONS;
  else if (kind === intern('function')) items = Ed.functionNames();
  items = [...new Set(items)].sort();
  const a = arg || '';
  const words = a.split(' '), lastw = words.pop(), head = words.length ? words.join(' ') + ' ' : '';
  return items.filter(x => x.startsWith(lastw)).map(x => `${pre}${name}${bang} ${head}${x}`);
}
const exLabel = s => (s.match(/(\S+)$/) || ['', ''])[1].replace(/^[%.$\d,;+\-'<>]+(?=[a-z])/i, '');
CMD('evil-ex', async () => {
  const b = cur(), st = stateOf(b);
  let init = '';
  if (st === 'visual') { EC.visualRange(b, true); init = "'<,'>"; }
  else if (E.prefixArg !== null) { const c = Ed.prefixNumeric(E.prefixArg); init = c === 1 ? '.' : `.,.+${c - 1}`; }
  return [await Ed.readMini(':', init, exCompleter, { history: E.exHistory, label: exLabel, kind: 'ex', keepOrder: true, noIndex: true })];
}, 'COMMAND', 'Read an ex command line and run it (:). A line that starts with ( is evaluated as Lisp.', async ([s]) => {
  if (!s.trim()) return false;
  E.lastEx = s;
  await exExecute(s);
  return false;
});

/* ---------- ex commands written in JavaScript ---------- */
function exLines() {
  const b = cur(), t = b.rope;
  const [l1, l2] = E.ex && E.ex.lines ? E.ex.lines : [lineNo(t, b.pt), lineNo(t, b.pt)];
  return [l1, l2];
}
function linesSpan(t, l1, l2) { const s = lineStartOf(t, l1), e = eol(t, lineStartOf(t, l2)); return [s, Math.min(t.length, e + 1)]; }
function splitDelimited(arg, count) {
  const d = arg[0];
  if (!d || /[a-zA-Z0-9\\"| ]/.test(d)) signal('user-error', 'E146: Regular expressions can’t be delimited by letters');
  const parts = []; let i = 1, cur2 = '';
  while (parts.length < count && i <= arg.length) {
    if (i === arg.length || arg[i] === d) { parts.push(cur2); cur2 = ''; i++; if (i > arg.length) break; continue; }
    if (arg[i] === '\\' && i + 1 < arg.length) { cur2 += arg[i + 1] === d ? d : arg[i] + arg[i + 1]; i += 2; continue; }
    cur2 += arg[i++];
  }
  while (parts.length < count) parts.push(null);
  return { parts, rest: arg.slice(Math.min(i, arg.length)) };
}
function expandReplacement(rep, m) {
  let out = '', mode = null, once = null;
  const add = s => {
    for (const ch of s) {
      let c = ch;
      if (once) { c = once === 'u' ? c.toUpperCase() : c.toLowerCase(); once = null; }
      else if (mode) c = mode === 'U' ? c.toUpperCase() : c.toLowerCase();
      out += c;
    }
  };
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i];
    if (c === '\\' && i + 1 < rep.length) {
      const d = rep[++i];
      if (/[0-9]/.test(d)) add(m[+d] ?? '');
      else if (d === 'n' || d === 'r') add('\n');
      else if (d === 't') add('\t');
      else if (d === 'u' || d === 'l') once = d;
      else if (d === 'U' || d === 'L') mode = d;
      else if (d === 'e' || d === 'E') mode = null;
      else add(d);
    } else if (c === '&') add(m[0]);
    else add(c);
  }
  return out;
}
/* REP compiled to a function of the match: a constant when it has no escapes or &, a join of
   pieces when it has no case changes, else expandReplacement. */
function compileRep(rep) {
  if (!/[\\&]/.test(rep)) return () => rep;
  if (/\\[uUlLeE]/.test(rep)) return m => expandReplacement(rep, m);
  const parts = [];
  let lit = '';
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i];
    if (c === '\\' && i + 1 < rep.length) {
      const d = rep[++i];
      if (/[0-9]/.test(d)) { parts.push(lit, +d); lit = ''; }
      else lit += d === 'n' || d === 'r' ? '\n' : d === 't' ? '\t' : d;
    } else if (c === '&') { parts.push(lit, 0); lit = ''; }
    else lit += c;
  }
  parts.push(lit);
  return m => { let o = ''; for (let i = 0; i < parts.length; i++) o += typeof parts[i] === 'number' ? m[parts[i]] ?? '' : parts[i]; return o; };
}
/* The :s replacement for one line-aligned segment SEG; pure (no editor state), so the same code
   runs in a thread (the subst job below). The regexp comes as source and flags. Returns
   { out, count, nl, lastEnd }: the new text (SEG itself when nothing matched), the match count,
   the number of changed lines and the end of the last replacement relative to OUT. With INNER (a
   shard that another shard follows), the empty text after SEG's final newline is not a line: it is
   the start of the next shard's first line, which that shard matches. */
function substituteText(seg, reSource, reFlags, rep, g, inner) {
  const re = new RegExp(reSource, reFlags), one = new RegExp(reSource, reFlags.replace('g', ''));
  let count = 0, lastEnd = -1;
  const changed = new Set();
  const lineNoStr = (s, at) => { let n = 1; for (let k = s.indexOf('\n'); k >= 0 && k < at; k = s.indexOf('\n', k + 1)) n++; return n; };
  /* Replace in TEXT; BASE is the offset of TEXT in the new segment, used to find where the last replacement ends. */
  const run = (text, lineIdx, base) => {
    let delta = 0;
    return text.replace(g ? re : one, (...a) => {
      const m = a.slice(0, a.length - 2), at = a[a.length - 2];
      count++; changed.add(lineIdx === null ? lineNoStr(seg, at) : lineIdx);
      const r = expand(m);
      lastEnd = base + at + delta + r.length; delta += r.length - m[0].length;
      return r;
    });
  };
  const expand = compileRep(rep);
  const seam = inner && seg.endsWith('\n') ? seg.length : -1;
  let out;
  if (lineLocal(re)) {
    /* One pass over the segment instead of a replace per line: the pattern cannot see past a line
       end, so the matches are those of the per-line replace. Without g, the scan skips to the next
       line after a match. */
    const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), uni = r.flags.includes('u');
    const pieces = [];
    let last = 0, line = 0, nlPos = 0, delta = 0, m;
    r.lastIndex = 0;
    while ((m = r.exec(seg))) {
      const at = m.index;
      if (at === seam) break;
      for (let k = seg.indexOf('\n', nlPos); k >= 0 && k < at; k = seg.indexOf('\n', nlPos)) { line++; nlPos = k + 1; }
      count++; changed.add(line);
      const x = expand(m);
      pieces.push(seg.slice(last, at), x);
      lastEnd = at + delta + x.length; delta += x.length - m[0].length;
      last = at + m[0].length;
      if (!g) { const k = seg.indexOf('\n', at); if (k < 0) break; r.lastIndex = k + 1; }
      else if (m[0] === '') r.lastIndex = at + (uni && at + 1 < seg.length && seg.charCodeAt(at) >= 0xD800 && seg.charCodeAt(at) <= 0xDBFF ? 2 : 1);
    }
    pieces.push(seg.slice(last));
    out = count ? pieces.join('') : seg;
  } else if (/\\n|\[\\s\\S\]/.test(re.source)) out = run(seg, null, 0);
  else {
    const parts = seg.split('\n'), done = [];
    if (seam >= 0) parts.pop();
    let off = 0;
    for (let i = 0; i < parts.length; i++) { const x = run(parts[i], i, off); done.push(x); off += x.length + 1; }
    out = done.join('\n') + (seam >= 0 ? '\n' : '');
  }
  return { out, count, nl: changed.size, lastEnd };
}
/* The thread job: the replacement of one shard [from, to) of buffer ID, with OUT null when nothing changed. */
if (globalThis.EdPool && EdPool.define) EdPool.define('subst', (it, ctx) => {
  const seg = ctx.rope(it.id).slice(it.from, it.to);
  const r = substituteText(seg, ctx.args.source, ctx.args.flags, ctx.args.rep, ctx.args.g, !!it.inner);
  return { out: r.out === seg ? null : r.out, count: r.count, nl: r.nl, lastEnd: r.lastEnd };
}, [substituteText, compileRep, expandReplacement, lineLocal]);
function substitute(b, lines, pattern, rep, flags) {
  if (!pattern) { pattern = E.search.pattern; if (!pattern) signal('user-error', 'E35: No previous regular expression'); }
  rep = rep ?? '';
  const re = vimRegex((flags.includes('i') ? '\\c' : flags.includes('I') ? '\\C' : '') + pattern);
  rememberSearch(pattern, E.search.dir || 1);
  E.lastSub = { pattern, rep, flags };
  const t = b.rope, [l1, l2] = lines, [s, e] = linesSpan(t, l1, l2);
  /* A big range goes to the thread pool in line-aligned shards; the command then returns a promise
     that the command loop awaits, so keys wait while the page stays live. */
  if (e - s > (1 << 20) && globalThis.EdPool && EdPool.ok) return substituteAsync(b, lines, re, pattern, rep, flags);
  return substituteSync(b, lines, re, pattern, rep, flags);
}
function substituteSync(b, lines, re, pattern, rep, flags) {
  const t = b.rope, [l1, l2] = lines, [s, e] = linesSpan(t, l1, l2);
  const seg = t.slice(s, e);
  const { out, count, nl, lastEnd } = substituteText(seg, re.source, re.flags, rep, flags.includes('g'));
  if (!substituteReport(count, nl, pattern, flags)) return;
  if (out !== seg) replaceSubstituted(b, s, e, out, seg);
  substituteFinish(b, s, lastEnd, count, nl, flags);
}
/* Put OUT, the :s result for SEG (the text from S to E), in the buffer: one replacement of the range,
   one log entry, one undo step. Org unfolds what an edit overlaps, so with folds the lines are
   compared first: a fold the replacement overlaps though no changed line does (a folded subtree with
   no match) is put back after it, moved by the changes before it. Its hidden text is the same. */
function replaceSubstituted(b, s, e, out, seg) {
  const F = b.folds && b.folds.length ? b.folds : null;
  if (!F) { Ed.replaceText(b, s, e, out); return; }
  seg = seg ?? b.rope.slice(s, e);
  const a = seg.split('\n'), z = out.split('\n'), keep = [];
  if (a.length === z.length) {
    /* The runs of changed lines, [p, q) in the old text, and how much each changes the length. */
    const runs = [];
    let off = s, run = null;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== z[i]) {
        const d = z[i].length - a[i].length;
        if (run && run.q === off - 1) { run.q = off + a[i].length; run.d += d; }
        else runs.push(run = { p: off, q: off + a[i].length, d });
      }
      off += a[i].length + 1;
    }
    let r = 0, shift = 0;
    for (const f of F) {
      if (e <= f.s || s > f.e) continue;
      while (r < runs.length && runs[r].q <= f.s) shift += runs[r++].d;
      if (r < runs.length && runs[r].p <= f.e) continue;
      keep.push({ ...f, s: f.s + shift, e: f.e + shift });
    }
  }
  Ed.replaceText(b, s, e, out);
  if (keep.length) {
    const have = new Set((b.folds || []).map(f => f.s));
    b.folds = (b.folds || []).concat(keep.filter(f => !have.has(f.s))).sort((x, y) => x.s - y.s);
    b._foldVer = (b._foldVer || 0) + 1;
  }
}
/* The messages of :s; #f when nothing is to be replaced (no match, or the n flag). */
function substituteReport(count, nl, pattern, flags) {
  if (!count) { if (flags.includes('e')) return false; signal('user-error', `E486: Pattern not found: ${pattern}`); }
  if (flags.includes('n')) { Ed.message(`${count} match${count === 1 ? '' : 'es'} on ${nl} line${nl === 1 ? '' : 's'}`); return false; }
  return true;
}
function substituteFinish(b, s, lastEnd, count, nl, flags) {
  b.pt = firstNonBlank(b.rope, Math.min(b.rope.length, s + Math.max(0, lastEnd)));
  if (count > 1 || nl > 1) Ed.message(`${count} substitution${count === 1 ? '' : 's'} on ${nl} line${nl === 1 ? '' : 's'}`);
  if (flags.includes('c')) Ed.message(`${E.echo}  (the c flag is not supported; every match was replaced)`);
}
async function substituteAsync(b, lines, re, pattern, rep, flags) {
  const t = b.rope, [l1, l2] = lines, [s, e] = linesSpan(t, l1, l2), g = flags.includes('g');
  /* A pattern that can see past a line end runs on the whole segment in one job. */
  const shardable = lineLocal(re) || !/\\n|\[\\s\\S\]/.test(re.source);
  /* Three shards per thread: the work still balances when a thread is busy with another job, and
     the first shard on each thread runs with a cold JIT (measured: 9 shards beat 3 and 6). */
  const shards = shardable ? EdPool.shards(b, s, e, 3 * EdPool.size) : [{ id: b.id, from: s, to: e }];
  /* Every shard but the last ends at a line start that the next shard matches from. */
  for (let k = 0; k < shards.length - 1; k++) shards[k].inner = true;
  const ver = b.ver;
  let res;
  /* C-g stops the threads (EdPool.interruptible); a shard that backtracks past the limit fails. */
  const job = EdPool.map('subst', shards, { buffers: [b], args: { source: re.source, flags: re.flags, rep, g }, priority: 'ui', chunk: 1, timeout: EdPool.JOB_LIMIT });
  try { res = await (EdPool.interruptible ? EdPool.interruptible(job) : job); }
  catch (err) { if (err && (err.kind === 'no-worker' || err.kind === 'thread-died')) return substituteSync(b, lines, re, pattern, rep, flags); throw err; }
  /* The user cannot have typed meanwhile, but a timer may have edited: then the shards are stale. */
  if (Ed.changedSince(b, ver)) return substituteSync(b, lines, re, pattern, rep, flags);
  let count = 0, nl = 0;
  for (const r of res) { count += r.count; nl += r.nl; }
  if (!substituteReport(count, nl, pattern, flags)) return;
  /* One replacement of the whole range, as the sync path does: one log entry, one undo step. */
  const parts = res.map((r, k) => r.out !== null ? r.out : t.slice(shards[k].from, shards[k].to));
  /* The end of the last replacement in the new text, relative to S. */
  let lastEnd = -1, j = -1;
  for (let k = res.length - 1; k >= 0; k--) if (res[k].count > 0) { j = k; break; }
  if (j >= 0) { let off = 0; for (let i = 0; i < j; i++) off += parts[i].length; lastEnd = off + res[j].lastEnd; }
  replaceSubstituted(b, s, e, parts.join(''));
  substituteFinish(b, s, lastEnd, count, nl, flags);
}
/* The command's value: the promise of a :s that went to the threads, else #f. */
const subResult = r => r && typeof r.then === 'function' ? r.then(() => false) : false;
CMD('evil-ex-substitute', '<L><a>', 'BEG END ARGS', 'Replace matches of a Vim regexp in the lines: :s/PATTERN/REPLACEMENT/FLAGS. Flags: g all, i ignore case, I match case, n count only, e no error.',
  () => {
    const b = cur(), arg = E.ex && E.ex.arg ? E.ex.arg : '';
    if (!arg || /^[&cegiInp#lr]*$/.test(arg)) {
      if (!E.lastSub) signal('user-error', 'E35: No previous regular expression');
      const keep = arg.startsWith('&') ? E.lastSub.flags : '';
      return subResult(substitute(b, exLines(), E.lastSub.pattern, E.lastSub.rep, keep + arg.replace('&', '')));
    }
    const { parts, rest } = splitDelimited(arg, 2);
    return subResult(substitute(b, exLines(), parts[0], parts[1] ?? '', rest.trim()));
  });
put('evil-ex-substitute', 'evil-ex-complete', false);
CMD('evil-ex-repeat-substitute', '<L><a>', 'BEG END FLAGS', 'Repeat the last :s on the lines (& or :&). && keeps the flags.', () => {
  if (!E.lastSub) signal('user-error', 'E35: No previous regular expression');
  const arg = E.ex && E.ex.arg ? E.ex.arg : '';
  const keep = arg.startsWith('&') || (E.ex && E.ex.name === '&&') ? E.lastSub.flags : '';
  return subResult(substitute(cur(), exLines(), E.lastSub.pattern, E.lastSub.rep, keep + arg.replace(/&/g, '')));
});
async function globalCmd(invert) {
  const b = cur(), t = b.rope, arg = E.ex && E.ex.arg ? E.ex.arg : '';
  const inv = invert || (E.ex && E.ex.bang);
  const { parts, rest } = splitDelimited(arg, 1);
  const pattern = parts[0] || E.search.pattern;
  if (!pattern) signal('user-error', 'E35: No previous regular expression');
  const re = vimRegex(pattern), test = new RegExp(re.source, re.flags.replace('g', ''));
  rememberSearch(pattern, 1);
  const [l1, l2] = E.ex && E.ex.lines ? E.ex.lines : [1, lastLine(t)];
  const marks = [];
  let ls = lineStartOf(t, l1);
  for (let l = l1; l <= l2; l++) {
    const le = eol(t, ls);
    if (test.test(t.slice(ls, le)) !== inv) { const m = { pos: ls }; b.temps.add(m); marks.push(m); }
    if (le >= t.length) break;
    ls = le + 1;
  }
  if (!marks.length) { signal('user-error', `E486: Pattern not found: ${pattern}`); }
  const cmd = rest.trim() || 'p';
  const before = lineNo(b.rope, b.rope.length);
  E.printed = [];
  try {
    for (const m of marks) {
      if (m.dead) continue;
      b.pt = m.pos;
      await exExecute(cmd);
    }
  } finally { for (const m of marks) b.temps.delete(m); }
  const after = lineNo(b.rope, b.rope.length);
  if (E.printed.length) { Ed.message(E.printed.join('\n')); }
  else if (before - after > 2) Ed.message(`${before - after} fewer lines`);
  E.printed = null;
  return false;
}
CMD('evil-ex-global', '', '', 'Run an ex command on every line that matches: :g/PATTERN/COMMAND. :g! runs it on lines that do not match.', () => globalCmd(false));
CMD('evil-ex-vglobal', '', '', 'Run an ex command on every line that does not match: :v/PATTERN/COMMAND.', () => globalCmd(true));
CMD('evil-ex-print', '<L>', 'BEG END', 'Show the lines in the echo area (:p).', ([s, e]) => {
  const b = cur(), text = b.rope.slice(s - 1, e - 1).replace(/\n$/, '');
  if (E.printed) E.printed.push(text); else Ed.message(text);
  return false;
});
CMD('evil-ex-normal', '', '', 'Type the keys of the argument in Normal state, once on each line of the range (:normal).', async () => {
  const b = cur(), arg = E.ex && E.ex.arg ? E.ex.arg : '';
  if (!arg) signal('user-error', 'E471: Argument required');
  const keys = textToKeys(arg);
  const lines = E.ex && E.ex.lines;
  const finish = () => {
    const w = cur(), st = stateOf(w);
    if (st === 'insert' || st === 'replace') { EC.setState(w, 'normal'); E.ins = null; if (w.pt > bol(w.text, w.pt)) w.pt--; }
    else if (st === 'visual' || st === 'operator') EC.setState(w, 'normal');
  };
  const wasSup = E.suppressUndo; E.suppressUndo = true;
  const savedEx = E.ex; E.ex = null;
  try {
    if (!lines) { await Ed.executeKeys(keys); finish(); return false; }
    const t = b.rope, marks = [];
    let ls = lineStartOf(t, lines[0]);
    for (let l = lines[0]; l <= lines[1]; l++) { const m = { pos: ls }; b.temps.add(m); marks.push(m); const le = eol(t, ls); if (le >= t.length) break; ls = le + 1; }
    try {
      for (const m of marks) { if (m.dead) continue; b.pt = m.pos; await Ed.executeKeys(keys); finish(); }
    } finally { for (const m of marks) b.temps.delete(m); }
  } finally { E.suppressUndo = wasSup; E.ex = savedEx; }
  return false;
});
CMD('evil-ex-sort', '<%><a><!>', 'BEG END OPTIONS REVERSE', 'Sort the lines (:sort). Options: i ignore case, n numeric, u unique. :sort! sorts in reverse.', ([s, e, opts, rev]) => {
  const b = cur(), o = opts === false ? '' : opts;
  const [a, z] = [s - 1, e - 1];
  let seg = b.rope.slice(a, z); const nl = seg.endsWith('\n'); if (nl) seg = seg.slice(0, -1);
  let lines = seg.split('\n');
  const keyOf = l => o.includes('i') ? l.toLowerCase() : l;
  if (o.includes('n')) { const n = l => { const m = /-?\d+/.exec(l); return m ? +m[0] : -Infinity; }; lines.sort((x, y) => n(x) - n(y)); }
  else lines.sort((x, y) => keyOf(x) < keyOf(y) ? -1 : keyOf(x) > keyOf(y) ? 1 : 0);
  if (truthy(rev)) lines.reverse();
  if (o.includes('u')) lines = lines.filter((l, i) => i === 0 || keyOf(l) !== keyOf(lines[i - 1]));
  Ed.replaceText(b, a, z, lines.join('\n') + (nl ? '\n' : ''));
  b.pt = a; return false;
});
function targetLine(b) {
  const arg = E.ex && E.ex.arg ? E.ex.arg.trim() : '';
  if (!arg) signal('user-error', 'E14: Invalid address');
  if (arg === '0') return 0;
  const a = parseAddress(b, arg, 0, lineNo(b.rope, b.pt));
  if (!a) signal('user-error', 'E14: Invalid address');
  return a.line;
}
function moveOrCopy(copy) {
  const b = cur(), t = b.text, [l1, l2] = exLines(), dest = targetLine(b);
  if (!copy && dest >= l1 && dest < l2) signal('user-error', 'E134: Cannot move a range of lines into itself');
  const all = t.split('\n'); const trailing = t.endsWith('\n'); if (trailing) all.pop();
  const block = all.slice(l1 - 1, l2);
  let out;
  if (copy) { out = all.slice(0, dest).concat(block, all.slice(dest)); }
  else {
    const rest = all.slice(0, l1 - 1).concat(all.slice(l2));
    const d = dest >= l2 ? dest - block.length : dest;
    out = rest.slice(0, d).concat(block, rest.slice(d));
  }
  const nt = out.join('\n') + (trailing ? '\n' : '');
  Ed.replaceText(b, 0, t.length, nt);
  const lastMoved = copy ? dest + block.length : (dest >= l2 ? dest : dest + block.length);
  b.pt = firstNonBlank(b.rope, lineStartOf(b.rope, Math.max(1, lastMoved)));
  return false;
}
CMD('evil-ex-move', '', '', 'Move the lines below line ADDRESS (:m ADDRESS, 0 for the top).', () => moveOrCopy(false));
CMD('evil-ex-copy', '', '', 'Copy the lines below line ADDRESS (:t ADDRESS or :co ADDRESS).', () => moveOrCopy(true));
D('evil--join', 'BEG COUNT NOSPACE', 'Join COUNT lines starting at the line of BEG. NOSPACE keeps leading blanks and adds no space.', ([p, n, nosp]) => {
  const b = cur(), count = Math.max(2, optNum(n, 2)), raw = truthy(nosp);
  b.pt = num(p) - 1;
  let joinPt = b.pt;
  for (let k = 1; k < count; k++) {
    const t = b.rope, e = eol(t, b.pt);
    if (e + 1 >= t.length) break;
    let s2 = e + 1;
    if (!raw) while (t.at(s2) === ' ' || t.at(s2) === '\t') s2++;
    const a = e;
    const nextEmpty = s2 >= t.length || t.at(s2) === '\n';
    const sep = raw || nextEmpty || a === bol(t, e) || t.at(s2) === ')' || t.at(a - 1) === ' ' || t.at(a - 1) === '\t' ? '' : ' ';
    Ed.replaceText(b, a, s2, sep);
    joinPt = a; b.pt = a;
  }
  b.pt = joinPt;
  return false;
});
CMD('evil-ex-join', '<L><!>', 'BEG END BANG', 'Join the lines (:j). With one line, join it with the next.', ([s, e, bang]) => {
  const b = cur(), t = b.rope, l1 = lineNo(t, s - 1), l2 = lineNo(t, Math.max(s - 1, e - 2));
  return L.call('evil--join', [s, Math.max(2, l2 - l1 + 1), bang]);
});
const OPTS = () => ({
  number: () => { const v = L.get('display-line-numbers'); return truthy(v); },
  relativenumber: () => L.get('display-line-numbers') === intern('relative'),
  wrap: () => !truthy(L.get('truncate-lines')),
  ignorecase: () => L.get('evil-ex-search-case') !== intern('sensitive'),
  smartcase: () => L.get('evil-ex-search-case') === intern('smart'),
  hlsearch: () => truthy(L.get('evil-ex-search-highlight-all')),
  wrapscan: () => truthy(L.get('evil-search-wrap')),
});
const ALIASES = { nu: 'number', rnu: 'relativenumber', ic: 'ignorecase', scs: 'smartcase', hls: 'hlsearch', ws: 'wrapscan', sw: 'shiftwidth', shiftwidth: 'shiftwidth' };
function setOpt(name, on) {
  const v = (n, x) => { L.set(n, x); };
  switch (name) {
    case 'number': v('display-line-numbers', on ? (OPTS().relativenumber() ? intern('relative') : T) : (OPTS().relativenumber() ? intern('relative') : false)); E.nu = on; break;
    case 'relativenumber': v('display-line-numbers', on ? intern('relative') : (E.nu !== false && truthy(L.get('display-line-numbers')) ? T : false)); break;
    case 'wrap': v('truncate-lines', on ? false : T); break;
    case 'ignorecase': v('evil-ex-search-case', on ? (OPTS().smartcase() ? intern('smart') : intern('insensitive')) : intern('sensitive')); break;
    case 'smartcase': v('evil-ex-search-case', on ? intern('smart') : (OPTS().ignorecase() ? intern('insensitive') : intern('sensitive'))); break;
    case 'hlsearch': v('evil-ex-search-highlight-all', on ? T : false); break;
    case 'wrapscan': v('evil-search-wrap', on ? T : false); break;
    default: signal('user-error', `E518: Unknown option: ${name}`);
  }
}
CMD('evil-ex-set', '<a>', 'OPTIONS', 'Set options (:set nu, :set nornu, :set sw=4, :set ic?). Supported: number relativenumber wrap ignorecase smartcase hlsearch wrapscan shiftwidth.', ([a]) => {
  const opts = OPTS();
  if (a === false) { Ed.message(Object.keys(opts).map(k => (opts[k]() ? '  ' : 'no') + k).join('  ') + `  shiftwidth=${L.get('evil-shift-width')}`); return false; }
  const out = [];
  for (const w of a.trim().split(/\s+/)) {
    let m;
    if ((m = /^(\w+)=(\d+)$/.exec(w))) { const n = ALIASES[m[1]] || m[1]; if (n !== 'shiftwidth') signal('user-error', `E518: Unknown option: ${m[1]}`); L.set('evil-shift-width', +m[2]); continue; }
    if ((m = /^(\w+)\?$/.exec(w))) { const n = ALIASES[m[1]] || m[1]; if (n === 'shiftwidth') out.push(`shiftwidth=${L.get('evil-shift-width')}`); else if (opts[n]) out.push((opts[n]() ? '  ' : 'no') + n); else signal('user-error', `E518: Unknown option: ${m[1]}`); continue; }
    if ((m = /^(\w+)!$/.exec(w))) { const n = ALIASES[m[1]] || m[1]; if (!opts[n]) signal('user-error', `E518: Unknown option: ${m[1]}`); setOpt(n, !opts[n]()); continue; }
    let n = w, on = true;
    if (!opts[ALIASES[n] || n] && /^no/.test(n)) { n = n.slice(2); on = false; }
    n = ALIASES[n] || n;
    if (!opts[n]) signal('user-error', `E518: Unknown option: ${w}`);
    setOpt(n, on);
  }
  if (out.length) Ed.message(out.join('  '));
  return false;
});
put('evil-ex-set', 'evil-ex-complete', intern('option'));
function showList(name, text) {
  const h = Ed.getBufferCreate(name); h.mode = 'special-mode'; h.readOnly = true; h.evilState = undefined;
  h.text = text; h.pt = 0; h.modified = false; h.undo = []; h.redo = [];
  Ed.popToBuffer(h, true);
}
CMD('evil-ex-registers', '', '', 'List the registers and their contents (:reg).', () => {
  const rows = [];
  const show = (c, e) => { if (e && e.text) rows.push(`${({ line: 'l', block: 'b' })[e.type] || 'c'}  "${c}   ${e.text.replace(/\n/g, '^J').replace(/\x1b/g, '^[').slice(0, 70)}`); };
  show('"', EC.regGet('"'));
  for (const c of '0123456789abcdefghijklmnopqrstuvwxyz-.:/') show(c, EC.regGet(c));
  showList('*Registers*', `Type Name Content\n${rows.join('\n')}\n`);
  return false;
});
CMD('evil-ex-marks', '', '', 'List the marks in this buffer (:marks).', () => {
  const b = cur(), t = b.rope;
  const rows = Object.keys(b.marks).sort().map(k => { const p = Math.min(b.marks[k], t.length), ls = bol(t, p); return ` ${k === '`' ? "'" : k}  ${String(lineNo(t, p)).padStart(5)}  ${String(column(t, p)).padStart(4)}  ${t.slice(ls, eol(t, p)).slice(0, 60)}`; });
  showList('*Marks*', `mark  line   col  text\n${rows.join('\n')}\n`);
  return false;
});
for (const n of ['evil-ex', 'evil-ex-substitute', 'evil-ex-global', 'evil-ex-vglobal', 'evil-ex-normal', 'evil-ex-sort', 'evil-ex-move', 'evil-ex-copy', 'evil-ex-join', 'evil-ex-repeat-substitute'])
  put(n, 'evil-repeat', intern('abort'));

/* ---------- files and buffers for the ex commands ---------- */
D('write-region', 'START END FILENAME', 'Save the text from START to END as FILENAME without visiting it.', ([s, e, f]) => {
  const b = cur(), a = s === false ? 0 : num(s) - 1, z = e === false ? b.rope.length : num(e) - 1;
  Ed.Store.set(String(f), b.rope.slice(a, z)); Ed.message(`Wrote ${f}`); return false;
});
D('insert-file-contents', 'FILENAME', 'Insert the saved file FILENAME at point. Return its length.', ([f]) => {
  const v = Ed.Store.get(String(f)); if (v === null) signal('user-error', `E484: Can’t open file ${f}`);
  const b = cur(), p = b.pt; Ed.insertText(b, v); b.pt = p; return v.length;
});
D('revert-buffer', '', 'Reload the current buffer from its saved file, dropping changes.', () => {
  const b = cur(); if (!b.file) signal('user-error', 'E32: No file name');
  const v = Ed.Store.get(b.file); b.text = v ?? ''; b.pt = Math.min(b.pt, b.rope.length); b.modified = false; b.marks = {}; b.jumps = [];
  Ed.message(`"${b.file}" reloaded`); return false;
});
D('load', 'FILE', 'Evaluate the saved file FILE, or the buffer visiting it.', ([f]) => {
  const vb = E.buffers.find(x => x.file === f), text = vb ? vb.text : Ed.Store.get(String(f));
  if (text === null) signal('user-error', `Cannot open load file: ${f}`);
  for (const form of L.readAll(text)) { L.resetOps(); L.ev(form); }
  Ed.message(`Loaded ${f}`); return T;
});
D('evil--show-help-text', 'TEXT', 'Show TEXT in the *Help* buffer.', ([t]) => { showList('*Help*', String(t)); Ed.message('q returns to the previous buffer'); return false; });
function cycleBuffer(d) {
  const list = E.buffers.filter(x => !x.name.startsWith(' ') && !/^\*(Messages|Help|Registers|Marks|Buffer List)\*$/.test(x.name)).sort((a, z) => a.id - z.id);
  if (!list.length) return;
  let k = list.indexOf(E.win); k = ((k < 0 ? 0 : k + d) % list.length + list.length) % list.length;
  Ed.setWindowBuffer(list[k]);
}
CMD('evil-next-buffer', '<c>', '&optional COUNT', 'Show the next buffer (:bn, ]b).', ([n]) => { for (let i = 0; i < optNum(n, 1); i++) cycleBuffer(1); return false; });
CMD('evil-prev-buffer', '<c>', '&optional COUNT', 'Show the previous buffer (:bp, [b).', ([n]) => { for (let i = 0; i < optNum(n, 1); i++) cycleBuffer(-1); return false; });

/* ---------- what the mode line and echo area show ---------- */
const NAMES = { normal: 'NORMAL', insert: 'INSERT', replace: 'REPLACE', operator: 'O-PENDING', motion: 'MOTION', emacs: 'EMACS' };
const VNAMES = { char: 'VISUAL', line: 'V-LINE', block: 'V-BLOCK' };
const escH = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function prefixBindings(seq) {
  const parts = seq.split(' '), seen = new Map();
  for (const m of Ed.activeMaps(E.current)) {
    const km = Ed.lookupIn(m, parts);
    if (!(km instanceof Ed.Keymap)) continue;
    for (let k = km; k; k = k.parent) for (const [key, d] of k.map) if (!seen.has(key) && d !== false) seen.set(key, d);
  }
  return [...seen].sort((a, b) => a[0].localeCompare(b[0]));
}
H.look = b => {
  const st = stateOf(b), o = {};
  if (st) { o.state = st; o.tag = st === 'visual' ? VNAMES[b.visual] || 'VISUAL' : NAMES[st]; }
  o.cursor = st === 'insert' ? 'bar' : st === 'replace' ? 'hbar' : st === 'operator' ? 'half' : st === null && !E.evil ? 'bar' : '';
  o.onChar = !!st && st !== 'insert' && st !== 'emacs';
  if (E.preview && E.preview.b === b) { o.hl = E.preview.re; o.current = E.preview.match; }
  else if (truthy(L.get('evil-ex-search-highlight-all')) && !E.hlOff && E.search.pattern) { try { o.hl = vimRegex(E.search.pattern); } catch (e) { /* ignore */ } }
  o.extra = E.macro ? `recording @${E.macro.reg}` : '';
  o.stateEcho = st === 'insert' ? (E.oneShot ? '-- (insert) --' : '-- INSERT --') : st === 'replace' ? '-- REPLACE --' : st === 'visual' ? `-- ${({ char: 'VISUAL', line: 'VISUAL LINE', block: 'VISUAL BLOCK' })[b.visual] || 'VISUAL'} --` : '';
  if (E.macro && o.stateEcho) o.stateEcho += 'recording @' + E.macro.reg;
  const pend = E.pendingKeys ? E.pendingKeys.split(' ').map(k => k.length > 1 ? `<${k}>` : k).join('') : '';
  o.showcmd = E.countStr + (E.register ? '"' + E.register : '') + E.opShow + pend;
  if (E.pendingKeys && !E.mini && !/^ESC$/.test(E.pendingKeys)) {
    const items = prefixBindings(E.pendingKeys);
    if (items.length) o.prefixHelp = items.slice(0, 48).map(([k, d]) =>
      `<span class="wk"><kbd>${escH(k)}</kbd>${escH(d instanceof Ed.Keymap ? '+prefix' : L.cmdName(d))}</span>`).join('');
  }
  return o;
};

/* ---------- keymaps and startup ---------- */
H.setup = () => {
  for (const s of ['normal', 'insert', 'visual', 'replace', 'operator', 'motion', 'emacs']) L.set(`evil-${s}-state-map`, new Ed.Keymap(`evil-${s}-state-map`));
  L.set('evil-inner-text-objects-map', new Ed.Keymap('evil-inner-text-objects-map'));
  L.set('evil-outer-text-objects-map', new Ed.Keymap('evil-outer-text-objects-map'));
  L.defvar('evil-ex-commands', NIL, 'Alist of ex command names ("w[rite]") to commands.');
  L.set('minibuffer-mode-map', L.get('scheme-mode-map'));
};
H.mouseDown = (b, p) => {
  const st = stateOf(b);
  if (st === 'visual') setState(b, 'normal');
  b.pt = p; b.markActive = false;
  if (st === 'normal' || st === 'motion' || st === 'visual') EC.clampNormal(b);
};
H.mouseDrag = (b, from, p) => {
  const st = stateOf(b);
  if (st === 'normal' || st === 'motion' || st === 'visual') {
    if (st !== 'visual') { b.mark = from; b.visual = 'char'; b.markActive = true; setState(b, 'visual'); }
    b.pt = Math.min(p, Math.max(0, b.rope.length - 1));
  } else { b.mark = from; b.pt = p; b.markActive = p !== from; }
};
globalThis.EvilEx = { vimRegex, findMatch, exExecute, parseRange, resolveEx, substituteText };
})();
