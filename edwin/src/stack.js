/* The rest of the daily desktop stack: savehist, save-place, recentf and prescient persistence,
   calc, yasnippet, the Modus theme commands, project-find-file / project-find-regexp /
   project-switch-project, the which-key delay, Evil state cursors and snipe highlights.
   Loads before evil-ex.js (boot evaluates init.scm, which uses define-snippet and the
   variables below), so hooks that evil-ex.js sets are wrapped once the page has loaded. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks, EC = globalThis.EvilCore;
const { intern, signal, truthy, listOf, arr, NIL, Sym } = L;
const { D, CMD } = L;
const cur = () => E.current;
const str = x => { if (typeof x !== 'string') signal('wrong-type-argument', 'expected a string, got', x); return x; };
const nameOf = x => x instanceof Sym ? x.name : str(x);
const host = Ed.host, page = host.page;
const whenLoaded = f => host.whenLoaded(f);

/* ---------- small persistent tables beside the files (the host's storage, in memory when it is unavailable) ---------- */
const mem = new Map();
const Meta = {
  get(k, dflt) { try { const v = host.storage.get('edwin:' + k); if (v !== null) return JSON.parse(v); } catch (e) { /* fall through */ } return mem.has(k) ? mem.get(k) : dflt; },
  set(k, v) { mem.set(k, v); try { host.storage.set('edwin:' + k, JSON.stringify(v)); } catch (e) { /* in memory only */ } },
};
/* A write that waits MS and runs once for a burst of calls. flush() runs a pending one now: the
   page flushes them all when it is hidden or closed, as Emacs saves from kill-emacs-hook. */
const pending = new Set();
const later = (f, ms) => {
  let h = null;
  const run = () => { if (h) { clearTimeout(h); h = null; } pending.delete(run); f(); };
  const call = () => { if (h) return; pending.add(run); h = setTimeout(run, ms); };
  call.flush = () => { if (h) run(); };
  return call;
};
const flushAll = () => { for (const run of [...pending]) { try { run(); } catch (e) { console.error(e); } } };
host.onSuspend(flushAll);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

L.defvar('savehist-mode', true, 'Non-#f keeps the minibuffer histories (M-x, files, buffers, ex, search) across reloads.');
L.defvar('save-place-mode', true, 'Non-#f puts point back where it was the last time a file was visited.');
L.defvar('save-place-limit', 600, 'How many files save-place remembers; the least recently visited go first.');
L.defvar('savehist-additional-variables', listOf([intern('kill-ring'), intern('search-ring')]), 'What savehist keeps besides the minibuffer histories: kill-ring (the last 40 kills) and search-ring.');
L.defvar('recentf-mode', true, 'Non-#f orders find-file and consult-recent-file by last visit.');
L.defvar('recentf-max-saved-items', 300, 'How many recently visited files are remembered.');
L.defvar('prescient-persist-mode', true, 'Non-#f keeps the prescient frequency table (M-x, buffers, files) across reloads.');
L.defvar('which-key-idle-delay', 1.0, 'Seconds a prefix key waits before its bindings are listed in the echo area.');
L.defvar('evil-want-C-u-delete', true, 'Non-#f: C-u in Insert state deletes back to the indentation; #f: C-u is the prefix argument (init.scm binds it).');
L.defvar('evil-undo-system', intern('undo-redo'), "Edwin's undo is linear with redo, as Emacs's undo-redo: u undoes, C-r redoes.");
L.defvar('evil-respect-visual-line-mode', true, 'Non-#f: j and k move by screen lines in buffers where visual-line-mode is on (init.scm binds the -visual-line motions).');
L.defvar('evil-snipe-scope', intern('visible'), 's and S (and f, F, t, T under evil-snipe-override-mode) look in the visible part of the buffer (the only scope Edwin searches).');
L.defvar('evil-snipe-repeat-scope', intern('whole-visible'), '; and , repeat a snipe over the visible part of the buffer; whole-visible also highlights every visible match.');

/* ---------- savehist: minibuffer histories survive a reload ---------- */
function extra(name) { try { return arr(L.get('savehist-additional-variables')).some(x => x instanceof Sym && x.name === name); } catch (e) { return false; } }
{
  const saved = Meta.get('savehist', null);
  const strings = a => (Array.isArray(a) ? a.filter(s => typeof s === 'string') : []);
  if (saved && typeof saved === 'object') {
    for (const [k, v] of Object.entries(saved.kinds || {})) Ed.historyFor(k).push(...strings(v));
    E.history.push(...strings(saved.mini));
    if (E.exHistory) E.exHistory.push(...strings(saved.ex));
    if (E.searchHistory && extra('search-ring')) E.searchHistory.push(...strings(saved.search));
    if (extra('kill-ring') && !E.killRing.length) E.killRing.push(...strings(saved.kills));
  }
  const write = () => {
    if (!truthy(L.get('savehist-mode'))) return;
    const kinds = {};
    for (const [k, v] of Ed.histories) if (v.length) kinds[k] = v.slice(0, 100);
    Meta.set('savehist', { kinds, mini: E.history.slice(0, 100), ex: (E.exHistory || []).slice(0, 100),
      search: extra('search-ring') ? (E.searchHistory || []).slice(0, 100) : [], kills: extra('kill-ring') ? strings(E.killRing.slice(0, 40)) : [] });
  };
  const save = later(write, 500);
  const prev = H.miniExit;
  H.miniExit = m => { if (prev) prev(m); save(); };
  /* The kill ring changes without the minibuffer: it is written when the page (or the process) goes away. */
  host.onSuspend(write);
}

/* ---------- prescient-persist-mode: the frequency table behind M-x, buffers and files ---------- */
{
  const saved = Meta.get('prescient', null);
  /* Prototype-free copies, as the tables in editor-core.js are, so __proto__ is a candidate like any other. */
  if (saved && saved.kinds && typeof saved.kinds === 'object') {
    const kinds = Object.create(null);
    for (const [k, t] of Object.entries(saved.kinds)) if (t && typeof t === 'object') kinds[k] = Object.assign(Object.create(null), t);
    Ed.prescient.kinds = kinds; Ed.prescient.tick = Number(saved.tick) || 0;
  }
  Ed.prescient.save = later(() => { if (truthy(L.get('prescient-persist-mode'))) Meta.set('prescient', { tick: Ed.prescient.tick, kinds: Ed.prescient.kinds }); }, 500);
}
D('prescient-forget!', '', 'Empty the prescient frequency table.', () => { Ed.prescient.kinds = Object.create(null); Ed.prescient.tick = 0; Meta.set('prescient', null); return false; });

/* ---------- save-place and recentf ---------- */
/* File -> point, the least recently visited first (a file moves to the end when visited). */
const places = Object.assign(Object.create(null), Meta.get('places', {}));
let recent = (Meta.get('recentf', []) || []).filter(s => typeof s === 'string');
function placeOf(name, pt) { delete places[name]; places[name] = pt; }
/* Keep save-place-limit files, dropping those deleted from the store and not open in a buffer. */
const savePlaces = later(() => {
  const all = new Set(Ed.Store.list());
  for (const b of E.buffers) if (b.file) all.add(b.file);
  for (const f of Object.keys(places)) if (!all.has(f)) delete places[f];
  const keys = Object.keys(places), max = Math.max(0, Number(L.get('save-place-limit')) || 0);
  for (const f of keys.slice(0, Math.max(0, keys.length - max))) delete places[f];
  Meta.set('places', places);
}, 1000);
const saveRecent = later(() => Meta.set('recentf', recent), 500);
function touchRecent(name) {
  if (!truthy(L.get('recentf-mode'))) return;
  const i = recent.indexOf(name);
  if (i >= 0) recent.splice(i, 1);
  recent.unshift(name);
  const max = Number(L.get('recentf-max-saved-items')) || 300;
  if (recent.length > max) recent.length = max;
  saveRecent();
}
H.visited = (b, name, fresh) => {
  touchRecent(name);
  if (fresh && truthy(L.get('save-place-mode')) && own(places, name) && typeof places[name] === 'number') { b.pt = Math.max(0, Math.min(b.rope.length, places[name])); placeOf(name, places[name]); }
};
H.wrote = (b, name) => touchRecent(name);
/* Saved files, the most recently visited first and the rest by name. */
H.recentFiles = () => {
  const all = Ed.Store.list(), left = new Set(all), out = [];
  for (const f of recent) if (left.has(f)) { out.push(f); left.delete(f); }
  for (const f of all) if (left.has(f)) out.push(f);
  return out;
};
D('recentf-list', '', 'The recently visited files, most recent first.', () => listOf(H.recentFiles()));
CMD('recentf-cleanup', '', '', 'Forget recent files that no longer exist.', () => { const all = new Set(Ed.Store.list()); recent = recent.filter(f => all.has(f)); saveRecent(); return false; });
{
  const prev = H.postCommand;
  H.postCommand = (def, b, failed) => {
    if (prev) prev(def, b, failed);
    const c = E.current;
    if (c.file && !E.mini && places[c.file] !== c.pt) { placeOf(c.file, c.pt); savePlaces(); }
  };
}

/* ---------- calc: quick-calc evaluates an expression typed in the minibuffer ---------- */
const FUNCS = {
  sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  ln: Math.log, log10: Math.log10, log2: Math.log2, exp: Math.exp, abs: Math.abs, floor: Math.floor, ceil: Math.ceil,
  round: Math.round, trunc: Math.trunc, log: (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)),
  min: Math.min, max: Math.max, pow: Math.pow,
};
const CONSTS = { pi: Math.PI, e: Math.E };
/* A small recursive-descent evaluator: + - * / % ^ (right associative), unary minus, parentheses,
   % as Calc's calc-mod (the result has the sign of the divisor: -10 % 3 = 2),
   function calls with one or two arguments, pi and e. Angles are radians. */
function calcEval(src) {
  const toks = [];
  const re = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)|([a-z_][a-z0-9_]*)|(\*\*|[-+*/%^(),]))/giy;
  let m, i = 0;
  while (i < src.length) {
    re.lastIndex = i; m = re.exec(src);
    if (!m) { if (/^\s*$/.test(src.slice(i))) break; signal('error', `calc: cannot read "${src.slice(i, i + 10)}"`); }
    i = re.lastIndex;
    if (m[1] !== undefined) toks.push({ n: Number(m[1]) }); else if (m[2] !== undefined) toks.push({ id: m[2].toLowerCase() }); else toks.push({ op: m[3] === '**' ? '^' : m[3] });
  }
  let k = 0;
  const peek = () => toks[k], next = () => toks[k++];
  const expect = op => { const t = next(); if (!t || t.op !== op) signal('error', `calc: expected ${op}`); };
  function expr() { let v = term(); for (;;) { const t = peek(); if (t && (t.op === '+' || t.op === '-')) { next(); const r = term(); v = t.op === '+' ? v + r : v - r; } else return v; } }
  function term() { let v = unary(); for (;;) { const t = peek(); if (t && (t.op === '*' || t.op === '/' || t.op === '%')) { next(); const r = unary(); v = t.op === '*' ? v * r : t.op === '/' ? v / r : v - r * Math.floor(v / r); } else return v; } }
  function unary() { const t = peek(); if (t && t.op === '-') { next(); return -unary(); } if (t && t.op === '+') { next(); return unary(); } return power(); }
  function power() { const b = atom(); const t = peek(); if (t && t.op === '^') { next(); return Math.pow(b, unary()); } return b; }
  function atom() {
    const t = next();
    if (!t) signal('error', 'calc: expression ends early');
    if (t.n !== undefined) return t.n;
    if (t.op === '(') { const v = expr(); expect(')'); return v; }
    if (t.id !== undefined) {
      if (peek() && peek().op === '(') {
        const f = FUNCS[t.id]; if (!f) signal('error', `calc: unknown function ${t.id}`);
        next(); const args = [expr()]; while (peek() && peek().op === ',') { next(); args.push(expr()); } expect(')');
        return f(...args);
      }
      if (t.id in CONSTS) return CONSTS[t.id];
      signal('error', `calc: unknown name ${t.id}`);
    }
    signal('error', `calc: unexpected ${t.op}`);
  }
  if (!toks.length) signal('user-error', 'calc: nothing to evaluate');
  const v = expr();
  if (k < toks.length) signal('error', `calc: unexpected ${toks[k].op || toks[k].id || toks[k].n}`);
  if (typeof v !== 'number' || Number.isNaN(v)) signal('error', 'calc: not a number');
  return v;
}
function fmtNum(v) { if (Number.isInteger(v)) return String(v); const s = Number(v.toPrecision(12)); return String(s); }
CMD('quick-calc', async () => [await Ed.readMini('Quick calc: ', '', null, { kind: 'calc' })], 'EXPR',
  'Evaluate EXPR (+ - * / % ^, parentheses, sqrt sin cos tan ln log exp abs floor round, pi e; angles in radians); show the result and put it in the kill ring, so p or C-y inserts it. ESC leaves (M-x calc).',
  ([src]) => { const v = calcEval(str(src)), s = fmtNum(v); L.call('kill-new', [s]); Ed.message(`${src.trim()} => ${s}`); return v; });
L.alias('calc', 'quick-calc');
D('calc-eval', 'EXPR', 'The value of the calc expression EXPR.', ([s]) => calcEval(str(s)));

/* ---------- yasnippet: define-snippet in Scheme, TAB after the key expands it ---------- */
const snippets = new Map(); // mode name or '*' -> Map(key -> { template, doc })
const KEYCH = /[\p{L}\p{N}_-]/u;
function snippetsFor(mode) { return [snippets.get(mode), snippets.get('*')].filter(Boolean); }
function lookupSnippet(mode, key) { for (const m of snippetsFor(mode)) if (m.has(key)) return m.get(key); return null; }
D('define-snippet', 'mode key template [doc]', 'Define a snippet: in buffers of MODE (a major mode symbol, or #t for every mode) TAB after KEY replaces it with TEMPLATE. ${1:name} is a field asked for in the minibuffer (RET keeps "name"), $1 repeats it, $0 is where point ends.',
  ([mode, key, tpl, doc]) => {
    const m = mode === true || mode === false ? '*' : nameOf(mode);
    if (!snippets.has(m)) snippets.set(m, new Map());
    snippets.get(m).set(str(key), { template: str(tpl), doc: typeof doc === 'string' ? doc : '' });
    return intern(key);
  });
D('snippet-keys', '[mode]', 'The snippet keys defined for MODE (default: the current buffer’s mode).', ([mode]) => listOf([...new Set(snippetsFor(L.absent(mode) ? cur().mode : nameOf(mode)).flatMap(m => [...m.keys()]))]));
/* The snippet key ending at point, when point is at the end of the word. */
function keyAt(b) {
  const t = b.rope;
  if (b.pt < t.length && KEYCH.test(t.at(b.pt))) return null;
  let s = b.pt;
  while (s > 0 && KEYCH.test(t.at(s - 1))) s--;
  if (s === b.pt) return null;
  const key = t.slice(s, b.pt), sn = lookupSnippet(b.mode, key);
  return sn ? { start: s, key, snippet: sn } : null;
}
async function expandTemplate(b, start, end, tpl) {
  const fields = [];
  for (const m of tpl.matchAll(/\$\{(\d+):([^}]*)\}/g)) if (!fields.some(f => f.n === m[1])) fields.push({ n: m[1], name: m[2] });
  fields.sort((a, c) => +a.n - +c.n);
  const vals = {};
  for (const f of fields) { const v = await Ed.readMini(f.name + ': ', '', null, { kind: 'snippet ' + f.name }); vals[f.n] = v || f.name; }
  let text = tpl.replace(/\$\{(\d+):([^}]*)\}/g, (m, n, d) => vals[n] ?? d).replace(/\$(\d+)/g, (m, n) => (n === '0' ? '\u0000' : vals[n] ?? ''));
  const cut = text.indexOf('\u0000'), after = cut >= 0 ? cut : text.length;
  text = text.replace(/\u0000/g, '');
  /* $0 as a line of the expansion and a distance from that line's end, which indenting keeps. */
  const before = text.slice(0, after), zLine = before.split('\n').length - 1;
  const zEol = text.indexOf('\n', after), zFromEnd = (zEol < 0 ? text.length : zEol) - after;
  const lines = text.split('\n').length;
  if (!Ed.isLisp(b) && lines > 1) {
    /* yas-indent-line fixed: the lines after the first take the indentation of the key's line. */
    const t = b.rope, ls = Ed.bol(t, start);
    let ie = ls; while (ie < start && (t.at(ie) === ' ' || t.at(ie) === '\t')) ie++;
    const ind = t.slice(ls, ie);
    if (ind) text = text.split('\n').map((l, i) => (i ? ind + l : l)).join('\n');
  }
  Ed.replaceText(b, start, end, text);
  const first = Ed.lineNoB(b, start);
  /* yas-indent-line auto: in Lisp every line of the expansion, the key's line too, is indented as TAB would. */
  if (Ed.isLisp(b)) for (let i = 0; i < lines; i++) { b.pt = Ed.lineStartB(b, first + i); Ed.indentLine(b); }
  b.pt = Math.max(Ed.lineStartB(b, first + zLine), Ed.eol(b.rope, Ed.lineStartB(b, first + zLine)) - zFromEnd);
  return true;
}
async function expand(b) { const s = keyAt(b); if (!s) return false; return expandTemplate(b, s.start, b.pt, s.snippet.template); }
CMD('yas-expand', '*', '', 'Expand the snippet key before point (TAB in Insert state).', async () => { if (!await expand(cur())) signal('user-error', 'No snippet key before point'); return false; });
CMD('yas-insert-snippet', async () => {
  const keys = arr(L.call('snippet-keys', []));
  if (!keys.length) signal('user-error', `No snippets for ${cur().mode}`);
  return [await Ed.readMini('Snippet: ', '', () => keys, { kind: 'snippet', require: true, annotate: k => { const s = lookupSnippet(cur().mode, k); return s ? s.doc || s.template.split('\n')[0] : ''; } })];
}, 'KEY', 'Insert the snippet KEY at point, asking for its fields.', async ([key]) => { const b = cur(), s = lookupSnippet(b.mode, str(key)); if (!s) signal('user-error', `No snippet ${key}`); await expandTemplate(b, b.pt, b.pt, s.template); return false; });
globalThis.Yas = { keyAt, expand, snippets };

/* ---------- themes: the two Modus tinted palettes of the CSS, by name ---------- */
const THEMES = { 'modus-operandi-tinted': 'light', 'modus-vivendi-tinted': 'dark' };
/* data-theme is shared with the host page: the value Edwin did not set itself is the host's, and
   auto (disable-theme) puts it back instead of removing the attribute. */
let hostTheme = page.getAttr('theme'), ownTheme;
function setThemeAttr(v) {
  const now = page.getAttr('theme');
  if (now !== ownTheme) hostTheme = now;
  ownTheme = v;
  if (v === undefined) { page.setAttr('theme', hostTheme); ownTheme = hostTheme; }
  else page.setAttr('theme', v);
}
function applyTheme(name) {
  if (!name || name === 'auto') { setThemeAttr(undefined); Meta.set('theme', null); }
  else { if (!THEMES[name]) signal('error', `Unknown theme: ${name}`); setThemeAttr(THEMES[name]); Meta.set('theme', name); }
  E.metricsGen++;
}
ownTheme = hostTheme;
{ const saved = Meta.get('theme', null); if (saved && THEMES[saved]) setThemeAttr(THEMES[saved]); }
const currentTheme = () => (L.call('theme-dark?', []) ? 'modus-vivendi-tinted' : 'modus-operandi-tinted');
const themeCompleter = extra => () => [...Object.keys(THEMES), ...extra];
const themeAnnotate = n => (n === 'auto' ? 'follow the page (prefers-color-scheme or data-theme)' : THEMES[n] === 'light' ? 'light, warm background' : 'dark, blue-black background');
CMD('load-theme', async () => [await Ed.readMini('Load custom theme: ', '', themeCompleter(['auto']), { kind: 'theme', require: true, annotate: themeAnnotate })], 'THEME',
  'Enable THEME: modus-operandi-tinted (light), modus-vivendi-tinted (dark), or auto to follow the page.', ([t]) => { const n = nameOf(t); applyTheme(n); Ed.message(n === 'auto' ? 'Following the page theme' : `Loaded ${n}`); return false; });
CMD('modus-themes-select', async () => [await Ed.readMini('Select Modus theme: ', '', themeCompleter([]), { kind: 'theme', require: true, annotate: themeAnnotate })], 'THEME',
  'Switch to one of the Modus tinted themes.', ([t]) => { const n = nameOf(t); applyTheme(n); Ed.message(`Loaded ${n}`); return false; });
CMD('modus-themes-toggle', '', '', 'Switch between modus-operandi-tinted and modus-vivendi-tinted.', () => { const n = currentTheme() === 'modus-vivendi-tinted' ? 'modus-operandi-tinted' : 'modus-vivendi-tinted'; applyTheme(n); Ed.message(`Loaded ${n}`); return false; });
CMD('disable-theme', '', '', 'Follow the page theme again.', () => { applyTheme('auto'); Ed.message('Following the page theme'); return false; });
D('custom-enabled-themes', '', 'The theme in effect, as a one-element list.', () => listOf([intern(currentTheme())]));

/* ---------- project: the saved files, by top-level folder ---------- */
L.defvar('project-root', false, 'A folder of the saved files (a name prefix ending in /) that SPC p f and SPC p g work in; #f for all of them.');
const root = () => { const r = L.get('project-root'); return typeof r === 'string' && r ? r : null; };
function projectFiles() { const r = root(), all = H.recentFiles(); return r ? all.filter(f => f.startsWith(r)) : all; }
CMD('project-find-file', async () => { const r = root(); return [await Ed.readMini(`Find file${r ? ' in ' + r : ''}: `, '', projectFiles, { kind: 'file', require: true, annotate: Ed.annotateFile, listOrder: true })]; },
  'FILE', 'Visit a saved file of the project, matched with orderless (SPC p f).', ([f]) => Ed.visit(str(f)));
function folders() {
  const out = new Set();
  for (const f of Ed.Store.list()) { const k = f.indexOf('/'); if (k > 0) out.add(f.slice(0, k + 1)); }
  return [...out].sort();
}
D('project-folders', '', 'The top-level folders of the saved files.', () => listOf(folders()));
CMD('project-switch-project', async () => {
  const fs = folders();
  if (!fs.length) signal('user-error', 'No folders among the saved files: name a file folder/name to make one');
  return [await Ed.readMini('Switch to project: ', '', () => ['/', ...fs], { kind: 'project', require: true, annotate: d => (d === '/' ? 'every saved file' : `${Ed.Store.list().filter(f => f.startsWith(d)).length} files`) })];
}, 'DIR', 'Make a top-level folder of the saved files the project (/ for all of them), then find a file in it (SPC p p).', async ([d]) => {
  L.set('project-root', d === '/' ? false : str(d));
  await Ed.callInteractively(intern('project-find-file'));
  return false;
});
/* The matches of a regexp in TEXT, one per line: { name, line, col, text }. Pure, so the worker pool
   can run it (EdPool.define); otherwise it runs here. */
function grepLines(name, text, src, flags, max) {
  const re = new RegExp(src, flags.includes('g') ? flags : flags + 'g'), out = [];
  let m, ln = 1, ls = 0;
  while (out.length < max && (m = re.exec(text))) {
    for (let k = text.indexOf('\n', ls); k >= 0 && k < m.index; k = text.indexOf('\n', k + 1)) { ln++; ls = k + 1; }
    const le = text.indexOf('\n', m.index), end = le < 0 ? text.length : le;
    out.push({ name, line: ln, col: m.index - ls, text: text.slice(ls, Math.min(end, ls + 200)) });
    if (end >= text.length) break;
    re.lastIndex = end + 1; ls = end + 1; ln++;
  }
  return out;
}
function projectGrepJob(args, ctx) { return grepLines(args.name, args.text != null ? args.text : ctx.buffer(args.id), args.src, args.flags, args.max); }
const pooled = () => globalThis.EdPool && typeof EdPool.define === 'function' && typeof EdPool.run === 'function' && typeof EdPool.map === 'function';
if (pooled()) { try { EdPool.define('project-grep', projectGrepJob, [grepLines]); } catch (e) { console.error(e); } }
async function grepAll(items, buffers) {
  if (pooled() && EdPool.ok) {
    try { return await EdPool.map('project-grep', items, { buffers }); } catch (e) { /* fall back */ }
  }
  return items.map(it => grepLines(it.name, it.text != null ? it.text : (E.buffers.find(b => b.id === it.id) || { text: '' }).text, it.src, it.flags, it.max));
}
/* A pattern is a JS regexp, case-insensitive unless it has a capital; one that does not parse is literal. */
function patternOf(pat) {
  const ci = pat === pat.toLowerCase() ? 'i' : '';
  try { new RegExp(pat, 'u'); return { src: pat, flags: 'u' + ci }; } catch (e) { return { src: pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags: 'u' + ci }; }
}
CMD('project-find-regexp', async () => {
  const pat = await Ed.readMini(`Find regexp${root() ? ' in ' + root() : ''}: `, '', null, { kind: 'grep' });
  if (!pat.trim()) signal('user-error', 'No pattern');
  const { src, flags } = patternOf(pat), r = root(), max = 2000;
  const bufs = E.buffers.filter(b => !b.name.startsWith(' ') && b.mode !== 'special-mode' && (r ? b.file && b.file.startsWith(r) : true));
  const items = bufs.map(b => ({ name: b.file || b.name, id: b.id, src, flags, max }));
  for (const f of Ed.Store.list()) if (!(r && !f.startsWith(r)) && !bufs.some(b => b.file === f)) items.push({ name: f, text: Ed.Store.get(f) || '', src, flags, max });
  const results = (await grepAll(items, bufs)).flat().slice(0, 5000);
  if (!results.length) signal('user-error', `No matches for ${pat}`);
  const byLabel = new Map(), labels = [];
  for (const x of results) { const l = `${x.name}:${x.line}: ${x.text}`; if (!byLabel.has(l)) { byLabel.set(l, x); labels.push(l); } }
  /* Live preview in the selected window; buffers opened for it are closed again unless chosen. */
  const w = E.sel, orig = { b: w.buffer, pt: w.buffer.pt, start: w.start }, opened = new Set();
  const bufferFor = name => {
    let b = E.buffers.find(x => x.file === name) || Ed.getBuffer(name);
    if (!b) { b = Ed.getBufferCreate(name); b.text = Ed.Store.get(name) || ''; b.file = name; b.mode = Ed.modeFor(name); b.modified = false; b.undo = []; opened.add(b); }
    return b;
  };
  const show = x => { const b = bufferFor(x.name); if (w.buffer !== b) Ed.setWindowBuffer(b, w); b.pt = Math.min(b.rope.length, Ed.lineStartB(b, x.line) + x.col); E.recenter = 'center'; };
  let picked = null;
  try {
    picked = await Ed.readMini('Match: ', '', () => labels, { kind: 'grep-match', require: true, keepOrder: true, onSelect: c => { const x = c && byLabel.get(c); if (x) show(x); } });
  } finally {
    const keep = picked ? bufferFor(byLabel.get(picked).name) : null;
    if (!picked) { if (E.buffers.includes(orig.b)) { Ed.setWindowBuffer(orig.b, w); orig.b.pt = orig.pt; w.start = orig.start; } }
    for (const b of opened) if (b !== keep) L.call('kill-buffer', [b]);
    if (keep && opened.has(keep)) H.visited(keep, keep.name, false);
  }
  const x = byLabel.get(picked);
  return [x.name, x.line, x.col, orig.b, orig.pt];
}, 'FILE LINE COL', 'Search a regexp in every saved file and open buffer; pick a match (file:line: text) with live preview and jump to it (SPC p g).', ([name, line, col, ob, opt]) => {
  const b = E.buffers.find(x => x.file === name) || Ed.getBuffer(name) || Ed.visit(name);
  if (ob instanceof Ed.Buffer && E.buffers.includes(ob)) EC.pushJump(ob, opt);
  Ed.setWindowBuffer(b);
  b.pt = Math.min(b.rope.length, Ed.lineStartB(b, line) + col); E.recenter = 'center';
  return false;
});
L.put(intern('project-find-regexp'), 'evil-jump', true);
L.addHook('post-command-pulse', intern('project-find-regexp'));
globalThis.Stack = { grepLines, calcEval, Meta, places: () => places, recent: () => recent };

/* ---------- the echo area: which-key waits, the root carries the Evil state, snipe matches are boxed ---------- */
/* The bindings of a pending prefix are rendered at once (the echo text is what it always was) and
   shown after which-key-idle-delay: until then data-which-key="wait" on the root hides them. */
let wkKeys = '', wkSince = 0, wkTimer = null;
function wrapLook() {
  const prevLook = H.look;
  H.look = (b, w) => {
    const o = prevLook ? prevLook(b, w) : {};
    let wait = false;
    if (o.prefixHelp) {
      const delay = Math.max(0, Number(L.get('which-key-idle-delay')) || 0) * 1000;
      if (E.pendingKeys !== wkKeys) { wkKeys = E.pendingKeys; wkSince = Date.now(); }
      const left = wkSince + delay - Date.now();
      if (left > 0) {
        wait = true;
        if (!wkTimer) wkTimer = setTimeout(() => { wkTimer = null; if (E.pendingKeys && E.pendingKeys === wkKeys) Ed.render(); }, left + 5);
      }
    } else wkKeys = '';
    page.setAttr('which-key', wait ? 'wait' : undefined);
    return o;
  };
}
whenLoaded(wrapLook);
/* Snipe highlight: after s, S (f, F, t, T under evil-snipe-override-mode), ; or , the visible matches of the snipe are boxed until the next command:
   those ahead of point, or every one when the scope is whole-visible. */
const SNIPERS = new Set(['evil-snipe-s', 'evil-snipe-S', 'evil-snipe-f', 'evil-snipe-F', 'evil-snipe-t', 'evil-snipe-T', 'evil-repeat-find-char', 'evil-repeat-find-char-reverse']);
{
  const prev = H.postCommand;
  H.postCommand = (def, b, failed) => {
    if (prev) prev(def, b, failed);
    const name = L.cmdSym(def).name, last = L.get('evil-snipe-last');
    if (failed || !SNIPERS.has(name) || !last || last === NIL || truthy(L.get('evil-last-find'))) { E.snipeHl = null; return; }
    const whole = L.get(name.startsWith('evil-snipe') ? 'evil-snipe-scope' : 'evil-snipe-repeat-scope') === intern('whole-visible');
    const fwd = truthy(L.car(L.cdr(last))) !== (name === 'evil-repeat-find-char-reverse');
    E.snipeHl = { b: E.current, str: L.car(last), whole, fwd, pt: E.current.pt };
  };
}
/* The client rect of LEN characters at buffer position P in window W, from the rendered lines. */
function rectAt(w, p, len) {
  const view = w.view, t = w.buffer.rope, ls = Ed.bol(t, p);
  const ln = view.querySelector(`.ln[data-o="${ls}"]`);
  if (!ln) return null;
  let off = p - ls, startNode = null, startOff = 0;
  const doc = ln.ownerDocument, walker = doc.createTreeWalker(ln, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const n = node.nodeValue.length;
    if (!startNode) { if (off < n) { startNode = node; startOff = off; off += len; } else { off -= n; continue; } }
    if (startNode && off <= n) { const r = doc.createRange(); r.setStart(startNode, startOff); r.setEnd(node, off); const rs = r.getClientRects(); return rs.length ? rs[0] : null; }
    if (startNode) off -= n;
  }
  return null;
}
function drawSnipe() {
  const f = E.frame; if (!f) return;
  let el = f.el('snipe');
  const h = E.snipeHl, w = E.sel;
  if (!h || !w || w.buffer !== h.b || E.mini) { if (el) el.hidden = true; return; }
  if (!el) { el = f.root.ownerDocument.createElement('div'); el.className = 'snipe'; if (f.legacy) el.id = 'snipe'; f.root.appendChild(el); f.parts.snipe = el; }
  const b = h.b, t = b.rope, fold = h.str === h.str.toLowerCase();
  const first = w.start, last = Ed.eol(t, Ed.lineStartB(b, Math.max(1, w.lastLine || Ed.lineNoB(b, w.start))));
  const hay = t.slice(first, Math.min(t.length, last + h.str.length)), nd = fold ? h.str.toLowerCase() : h.str, src = fold ? hay.toLowerCase() : hay;
  const frame = f.root.getBoundingClientRect(), boxes = [], sc = Ed.frameScale(f);
  for (let k = src.indexOf(nd), n = 0; k >= 0 && n < 200; k = src.indexOf(nd, k + 1), n++) {
    if (!h.whole && (h.fwd ? first + k < h.pt : first + k > h.pt)) continue;
    const r = rectAt(w, first + k, h.str.length);
    if (r && r.width) boxes.push(`<div style="left:${(r.left - frame.left) / sc}px;top:${(r.top - frame.top) / sc}px;width:${r.width / sc}px;height:${r.height / sc}px"></div>`);
  }
  el.innerHTML = boxes.join(''); el.hidden = !boxes.length;
}
{
  const prev = H.renderOverlay;
  H.renderOverlay = () => {
    if (prev) prev();
    const b = E.sel && E.sel.buffer, st = b && E.evil ? EC.stateOf(b) : null;
    page.setAttr('evil-state', E.mini ? 'minibuffer' : st || 'emacs');
    drawSnipe();
  };
}
})();
