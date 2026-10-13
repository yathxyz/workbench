/* Lmacs Evil core: the modal machinery that evil.el builds on.
   States and their keymaps, counts and registers, the operator-pending reader, ranges,
   visual selections, dot repeat, keyboard macros, marks and jumps, Vim-style search,
   and the ex command line. Motions, operators, text objects and key bindings live in evil.el. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks;
const { intern, NIL, signal, pr, arr, listOf, truthy, Sym } = L;
const bool = b => !!b, T = true;
const cur = () => E.current;
const num = x => { if (typeof x !== 'number') signal('wrong-type-argument', 'expected an integer, got', x); return Math.trunc(x); };
const str = x => { if (typeof x !== 'string') signal('wrong-type-argument', 'expected a string, got', x); return x; };
const optNum = (x, d) => L.absent(x) ? d : num(x);
const chr = L.chr;
const { D, CMD, alias } = L;
const get = (s, p) => L.prop(s, p);
const put = (name, p, v) => L.put(intern(name), p, v);
const { bol, eol, column, lineNo, posAtColumn, lastLineStart, lineStartOf } = Ed;
const KM = name => { const v = L.get(name); return v instanceof Ed.Keymap ? v : null; };
const defvar = L.defvar;

E.evil = true;
E.registers = {}; E.search = { pattern: null, dir: 1 }; E.hlOff = false; E.preview = null;
E.searchHistory = []; E.exHistory = []; E.dotLast = null; E.dotCand = null; E.macro = null; E.lastMacro = null;
E.ins = null; E.countStr = ''; E.register = null; E.opShow = ''; E.ex = null; E.lastSub = null; E.oneShot = 0;
E.aux = new Map(); E.blockCols = null;

defvar('evil-default-state', intern('normal'), 'State a new buffer starts in.');
defvar('evil-motion-state-modes', listOf([intern('special-mode')]), 'Major modes whose buffers start in Motion state.');
defvar('evil-emacs-state-modes', NIL, 'Major modes whose buffers start in Emacs state.');
defvar('evil-shift-width', 2, 'Columns that > and < shift by.');
defvar('evil-ex-search-case', intern('smart'), 'Case sensitivity of / and :s: smart, sensitive or insensitive.');
defvar('evil-ex-search-highlight-all', true, 'Non-#f to highlight every match of the last search.');
defvar('evil-search-wrap', true, 'Non-#f to let searches wrap around the end of the buffer.');
defvar('evil-this-type', false, 'Set by a motion to override its type for this use: exclusive, inclusive or line.');
defvar('display-line-numbers', false, "#f, #t for absolute numbers, or 'relative.");
defvar('truncate-lines', false, 'Non-#f to show long lines without wrapping.');

/* ---------- states ---------- */
const STATES = ['normal', 'insert', 'visual', 'replace', 'operator', 'motion', 'emacs'];
const TAGS = { normal: 'N', insert: 'I', visual: 'V', replace: 'R', operator: 'O', motion: 'M', emacs: 'E' };
function memqMode(listSym, mode) { return arr(L.get(listSym) ?? NIL).some(s => s instanceof Sym && s.name === mode); }
function initialState(b) {
  if (memqMode('evil-emacs-state-modes', b.mode)) return 'emacs';
  if (memqMode('evil-motion-state-modes', b.mode)) return 'motion';
  const d = L.get('evil-default-state');
  return d instanceof Sym && STATES.includes(d.name) ? d.name : 'normal';
}
function stateOf(b) {
  b = b || E.current;
  if (!E.evil || !b || b === E.minibuf) return null;
  if (b.evilState === undefined) b.evilState = initialState(b);
  return b.evilState;
}
const ECHO = { insert: '-- INSERT --', replace: '-- REPLACE --', emacs: '-- EMACS --' };
const VIS_ECHO = { char: '-- VISUAL --', line: '-- VISUAL LINE --', block: '-- VISUAL BLOCK --' };
function runStateHook(st, what) { try { L.runHook(`evil-${st}-state-${what}-hook`); } catch (e) { Ed.reportError(e); } }
function setState(b, s) {
  const old = stateOf(b);
  if (old === s) return;
  if (old === 'visual') exitVisual(b);
  b.evilState = s;
  if (s === 'operator' || old === 'operator') return;
  if (old) runStateHook(old, 'exit');
  if (ECHO[s]) E.echo = ECHO[s];
  else if (s === 'visual') E.echo = VIS_ECHO[b.visual] || '';
  else if (old && ECHO[old] && E.echo === ECHO[old]) E.echo = '';
  runStateHook(s, 'entry');
}
function clampNormal(b) {
  const t = b.rope;
  if (b.pt === t.length && t.length && t.at(t.length - 1) === '\n') b.pt = bol(t, t.length - 1);
  if (b.pt > 0 && (b.pt === t.length || t.at(b.pt) === '\n') && b.pt > bol(t, b.pt)) b.pt--;
}

/* ---------- keymaps for each state, plus per-mode auxiliary maps ---------- */
function aux(mode, st, create) {
  const key = mode + ':' + st;
  let m = E.aux.get(key);
  if (!m && create) { m = new Ed.Keymap(`${mode}-${st}-state`); E.aux.set(key, m); }
  return m || null;
}
H.stateMaps = b => {
  const st = stateOf(b);
  if (!st) return [];
  const out = [];
  const add = s => { const a = aux(b.mode, s, false); if (a) out.push(a); const g = KM(`evil-${s}-state-map`); if (g) out.push(g); };
  ({ normal: ['normal', 'motion'], visual: ['visual', 'normal', 'motion'], motion: ['motion'], insert: ['insert'],
     replace: ['replace', 'insert'], emacs: ['emacs'], operator: ['operator', 'motion'] })[st].forEach(add);
  return out;
};
function opMaps(b) {
  const out = [];
  for (const s of ['operator', 'motion']) { const a = aux(b.mode, s, false); if (a) out.push(a); const g = KM(`evil-${s}-state-map`); if (g) out.push(g); }
  return out;
}
function modeNameOf(m) {
  if (m instanceof Sym) return m.name.replace(/-map$/, '');
  if (m instanceof Ed.Keymap && m.name) return m.name.replace(/-map$/, '');
  signal('wrong-type-argument', 'expected a keymap or major mode, got', m);
}
function stateTargets(states, map) {
  const sts = states instanceof L.Pair || states === NIL ? arr(states) : [states];
  return sts.map(s => {
    const name = s instanceof Sym ? s.name : String(s);
    if (!STATES.includes(name)) signal('error', `Unknown Evil state: ${name}`);
    if (map === intern('global') || map === false) return KM(`evil-${name}-state-map`);
    return aux(modeNameOf(map), name, true);
  });
}
D('evil-define-key', 'STATE KEYMAP KEY DEF &rest BINDINGS', 'Bind KEY to DEF in STATE (a state or a list of states) for KEYMAP: a major mode, its keymap, or global.',
  ([states, map, ...pairs]) => {
    for (const target of stateTargets(states, map))
      for (let k = 0; k + 1 < pairs.length; k += 2) Ed.defineKey(target, str(pairs[k]), pairs[k + 1]);
    return false;
  });
D('evil-global-set-key', 'STATE KEY DEF', 'Bind KEY to DEF in the global keymap of STATE.', ([s, k, d]) => { for (const m of stateTargets(s, false)) Ed.defineKey(m, str(k), d); return d; });
D('evil-state-keymap', 'STATE', 'The global keymap of STATE.', ([s]) => stateTargets(s, false)[0]);

/* ---------- registers ---------- */
const clip = s => Ed.host.setClipboard(s);
function regKey(r) { return r === null || L.absent(r) ? '"' : (chr(r) ?? String(r)); }
function regGet(r) {
  const c = regKey(r), b = cur();
  switch (c) {
    case '"': return E.registers['"'] || (E.killRing[0] ? { text: E.killRing[0], type: 'char' } : null);
    case '_': return { text: '', type: 'char' };
    case '/': return E.search.pattern ? { text: E.search.pattern, type: 'char' } : null;
    case ':': return E.lastEx ? { text: E.lastEx, type: 'char' } : null;
    case '%': return { text: (E.win || b).file || (E.win || b).name, type: 'char' };
    case '*': case '+': return E.registers['+'] || E.registers['"'] || null;
    default: return E.registers[/[A-Z]/.test(c) ? c.toLowerCase() : c] || null;
  }
}
function storeYank(text, type, r, isDelete) {
  const c = regKey(r);
  if (c === '_') return;
  if (type === 'line' && !text.endsWith('\n')) text += '\n';
  const entry = { text, type };
  if (c !== '"') {
    if (/[A-Z]/.test(c)) {
      const lc = c.toLowerCase(), old = E.registers[lc];
      if (old) {
        const lineish = old.type === 'line' || type === 'line';
        entry.text = lineish ? (old.text.endsWith('\n') ? old.text : old.text + '\n') + text : old.text + text;
        entry.type = lineish ? 'line' : old.type;
      }
      E.registers[lc] = entry;
    } else if (/[a-z0-9\-+*]/.test(c)) E.registers[c === '*' ? '+' : c] = entry;
    else signal('error', `Invalid register: ${c}`);
    if (c === '+' || c === '*') clip(entry.text);
  } else if (isDelete) {
    if (type === 'line' || text.includes('\n')) { for (let k = 9; k > 1; k--) if (E.registers[String(k - 1)]) E.registers[String(k)] = E.registers[String(k - 1)]; E.registers['1'] = entry; }
    else E.registers['-'] = entry;
  } else E.registers['0'] = entry;
  E.registers['"'] = entry;
  E.killRing.unshift(entry.text); if (E.killRing.length > 60) E.killRing.pop();
  if (c === '"') clip(entry.text);
}
D('evil-get-register', 'REGISTER &optional NOERROR', 'Text stored in REGISTER (a character).', ([r, noerr]) => {
  const e = regGet(r);
  if (!e) { if (truthy(noerr)) return false; signal('user-error', `Register ${regKey(r)} is empty`); }
  return e.text;
});
D('evil-register-type', 'REGISTER', 'Type of the text in REGISTER: char, line or block.', ([r]) => { const e = regGet(r); return e ? intern(e.type) : false; });
D('evil-set-register', 'REGISTER TEXT &optional TYPE', 'Store TEXT in REGISTER.', ([r, t, ty]) => {
  const c = regKey(r); const e = { text: str(t), type: ty instanceof Sym ? ty.name : 'char' };
  E.registers[/[A-Z]/.test(c) ? c.toLowerCase() : c] = e; if (c === '"') E.killRing.unshift(e.text); return t;
});
/* Emacs kills feed the unnamed register, so p pastes what C-k killed. */
{
  const kn = L.toFn(intern('kill-new')), ka = L.toFn(intern('kill-append'));
  D('kill-new', kn.params, kn.doc, ([s]) => { const r = kn([s]); E.registers['"'] = { text: E.killRing[0], type: 'char' }; return r; });
  D('kill-append', ka.params, ka.doc, a => { const r = ka(a); E.registers['"'] = { text: E.killRing[0], type: 'char' }; return r; });
}

/* ---------- interactive codes used by evil.el ---------- */
const sc = Ed.specCodes;
sc.c = async () => [E.prefixArg === null ? false : Ed.prefixNumeric(E.prefixArg)];
sc.x = async () => {
  if (E.ex && E.ex.arg && /^[a-zA-Z0-9"\-_+*](\s|$)/.test(E.ex.arg)) return [L.mkchar(E.ex.arg)];
  return [E.register ? L.mkchar(E.register) : false];
};
sc.C = async () => { const r = await Ed.readChar(''); return [r]; };
sc.R = async () => { const [b, e, t] = await readRange(); return [b + 1, e + 1, intern(t)]; };
sc.r = async () => { const [b, e] = await readRange(); return [b + 1, e + 1]; };
sc.a = async () => [E.ex && E.ex.arg ? E.ex.arg : false];
sc.f = sc.a;
sc['!'] = async () => [bool(E.ex && E.ex.bang)];
sc.L = async () => { const r = exRange(false); return [r[0] + 1, r[1] + 1]; };
sc['%'] = async () => { const r = exRange(true); return [r[0] + 1, r[1] + 1]; };
function exRange(whole) {
  const b = cur(), t = b.rope;
  if (E.ex && E.ex.lines) { const [l1, l2] = E.ex.lines; const s = lineStartOf(t, l1), e = eol(t, lineStartOf(t, l2)); return [s, Math.min(t.length, e + 1)]; }
  if (whole) return [0, t.length];
  const s = bol(t, b.pt), e = eol(t, b.pt); return [s, Math.min(t.length, e + 1)];
}

/* ---------- the operator-pending reader ---------- */
class OpDone { }
E.OpDone = OpDone;
function isTextObject(cmd) { return truthy(get(cmd, 'evil-text-object')); }
function motionType(cmd) { const t = get(cmd, 'evil-motion-type'); return t instanceof Sym ? t.name : 'exclusive'; }
function firstNonBlank(t, p) { let k = bol(t, p); for (let c = t.charAt(k); c === ' ' || c === '\t'; c = t.charAt(++k)); return k; }
/* A folded line (org.js keeps b.folds) counts with its hidden part: in Vim an operator takes a closed
   fold as a whole, whether it comes from dd, a motion (dj) or Visual-line (Vd). */
const lineEndWithFold = (b, e) => H.foldEnd && b.folds && b.folds.length ? H.foldEnd(b, e) : e;
function lineRange(b, count) {
  const t = b.rope, beg = bol(t, b.pt);
  let end = beg;
  for (let i = 0; i < (count || 1); i++) { const e = lineEndWithFold(b, eol(t, end)); end = e < t.length ? e + 1 : e; if (e >= t.length) break; }
  return [beg, end, 'line'];
}
function normalize(b, s, e, type) {
  const t = b.rope;
  let beg = Math.min(s, e), end = Math.max(s, e);
  if (type === 'inclusive') { if (end < t.length && t.at(end) !== '\n') end++; }
  else if (type === 'exclusive' && end > beg && t.at(end - 1) === '\n' && lineNo(t, end) > lineNo(t, beg)) {
    if (beg <= firstNonBlank(t, beg)) { type = 'line'; end = end - 1; }
    else end = end - 1;
  }
  if (type === 'line') { beg = bol(t, beg); const le = lineEndWithFold(b, eol(t, end)); end = le < t.length ? le + 1 : le; }
  if (type === 'block') end = Math.min(t.length, end + 1);
  return [beg, end, type];
}
async function readRange() {
  const b = cur(), st = stateOf(b);
  if (E.ex) { const [s, e] = exRange(false); return [s, e, 'line']; }
  if (st === 'visual') return visualRange(b, true);
  if (st === null || st === 'emacs' || st === 'insert') {
    if (b.mark === null) signal('user-error', 'The mark is not set now, so there is no region');
    return [Math.min(b.pt, b.mark), Math.max(b.pt, b.mark), 'exclusive'];
  }
  const opKeys = E.thisKeys ? E.thisKeys.split(' ') : [];
  const opSym = E.thisCommand;
  const count1 = E.prefixArg === null ? null : Ed.prefixNumeric(E.prefixArg);
  setState(b, 'operator');
  E.opShow = opKeys.join('');
  let count2 = '', forced = null, seq = '';
  try {
    for (;;) {
      const k = await Ed.nextKey();
      if (!seq) {
        if (/^[1-9]$/.test(k) || (k === '0' && count2)) { count2 += k; E.opShow += k; continue; }
        if (k === 'ESC' || k === 'C-g') Ed.quietQuit();
        if (k === 'v' || k === 'V' || k === 'C-v') { forced = { v: 'char', V: 'line', 'C-v': 'block' }[k]; E.opShow += k; continue; }
      }
      seq = seq ? seq + ' ' + k : k;
      E.opShow += k.length > 1 ? `<${k}>` : k;
      const count = count1 === null && !count2 ? null : (count1 || 1) * (+count2 || 1);
      if (seq === opKeys.join(' ') || (opKeys.length > 1 && seq === opKeys[opKeys.length - 1])) return lineRange(b, count);
      const def = Ed.lookupWith(opMaps(b), seq);
      if (def === Ed.PREFIX) continue;
      if (def === undefined) { Ed.ding(); Ed.quietQuit(); }
      if (truthy(get(def, 'evil-surround-edit'))) { await surroundEdit(b, opSym, count); throw new OpDone(); }
      return await motionRange(b, def, count, forced, opSym);
    }
  } finally {
    if (stateOf(b) === 'operator') b.evilState = 'normal';
    E.opShow = ''; E.prefixArg = null;
  }
}
/* ys{motion}{char}, ds{char} and cs{old}{new}: the s after an operator means surround. */
async function surroundEdit(b, opSym, count) {
  const name = opSym instanceof Sym ? opSym.name : '';
  if (name === 'evil-delete') { const c = await Ed.readChar(''); L.call('evil-surround-delete', [c]); return; }
  if (name === 'evil-change') { const o = await Ed.readChar(''); const n = await Ed.readChar(''); L.call('evil-surround-change', [o, n]); return; }
  // yank (or any other operator): read a motion or text object, then the pair character
  let seq = '', forced = null;
  for (;;) {
    const k = await Ed.nextKey();
    if (!seq && (k === 'v' || k === 'V')) { forced = k === 'v' ? 'char' : 'line'; continue; }
    if (k === 'ESC' || k === 'C-g') Ed.quietQuit();
    seq = seq ? seq + ' ' + k : k;
    E.opShow += k;
    if (k === 's' && seq === 's') { const [bg, en, ty] = lineRange(b, count); const c = await Ed.readChar(''); L.call('evil-surround-region', [bg + 1, en + 1, intern(ty), c]); return; }
    const def = Ed.lookupWith(opMaps(b), seq);
    if (def === Ed.PREFIX) continue;
    if (def === undefined) { Ed.ding(); Ed.quietQuit(); }
    const [bg, en, ty] = await motionRange(b, def, count, forced, opSym);
    const c = await Ed.readChar('');
    L.call('evil-surround-region', [bg + 1, en + 1, intern(ty), c]);
    return;
  }
}
async function motionRange(b, def, count, forced, opSym) {
  let cmd = def;
  if (opSym === intern('evil-change') && cmd instanceof Sym) {
    const ch = b.rope.at(b.pt);
    if (ch !== undefined && !/\s/.test(ch)) {
      if (cmd === intern('evil-forward-word-begin')) cmd = intern('evil-forward-word-end');
      else if (cmd === intern('evil-forward-WORD-begin')) cmd = intern('evil-forward-WORD-end');
    }
  }
  const start = b.pt;
  E.prefixArg = count;
  if (isTextObject(cmd)) {
    const r = arr(await Ed.callInteractively(cmd));
    b.pt = start;
    if (r.length < 2) Ed.quietQuit();
    let type = r[2] instanceof Sym ? r[2].name : 'exclusive';
    if (forced === 'line') type = 'line'; else if (forced === 'char' && type === 'line') type = 'exclusive';
    const [s, e] = [r[0] - 1, r[1] - 1];
    return type === 'line' ? normalize(b, s, Math.max(s, e - 1), 'line') : [Math.min(s, e), Math.max(s, e), type === 'inclusive' ? 'exclusive' : type];
  }
  L.set('evil-this-type', false);
  await Ed.callInteractively(cmd);
  const end = b.pt; b.pt = start;
  const dyn = L.get('evil-this-type');
  let type = dyn instanceof Sym ? dyn.name : motionType(cmd);
  L.set('evil-this-type', false);
  if (forced === 'line') type = 'line';
  else if (forced === 'block') type = 'block';
  else if (forced === 'char') type = type === 'line' ? 'exclusive' : type === 'exclusive' ? 'inclusive' : 'exclusive';
  if (type === 'block') { E.blockCols = null; return normalize(b, start, end, 'block'); }
  return normalize(b, start, end, type);
}

/* ---------- visual selections ---------- */
function visualBounds(b) {
  const t = b.rope, a = b.mark ?? b.pt, p = b.pt, s = Math.min(a, p), e = Math.max(a, p);
  if (b.visual === 'line') return [bol(t, s), Math.min(t.length, lineEndWithFold(b, eol(t, e)) + 1), 'line'];
  if (b.visual === 'block') {
    const c1 = Math.min(column(t, a), column(t, p)), c2 = Math.max(column(t, a), column(t, p));
    const l1 = bol(t, s), l2 = bol(t, e);
    const beg = posAtColumn(t, l1, c1), end = Math.min(eol(t, l2), posAtColumn(t, l2, c2) + 1);
    E.blockCols = { beg, end, c1, c2, l1, l2 };
    return [beg, Math.max(beg, end), 'block'];
  }
  return [s, Math.min(t.length, e + 1), 'inclusive'];
}
function visualRange(b, exit) {
  const r = visualBounds(b);
  if (exit) setState(b, 'normal');
  return r;
}
function exitVisual(b) {
  if (!b.visual) return;
  const t = b.text, a = b.mark ?? b.pt, p = b.pt;
  b.marks['<'] = Math.min(a, p); b.marks['>'] = Math.max(a, p);
  b.lastVisual = { type: b.visual, mark: a, pt: p };
  b.visual = null; b.markActive = false;
  void t;
}
function enterVisual(b, type) {
  const st = stateOf(b);
  if (st === 'visual') {
    if (b.visual === type) { setState(b, 'normal'); return; }
    b.visual = type; E.echo = VIS_ECHO[type]; return;
  }
  if (st === 'insert' || st === 'replace') setState(b, 'normal');
  b.mark = b.pt; b.markActive = true; b.visual = type;
  setState(b, 'visual');
}
CMD('evil-visual-char', '', '', 'Start or end characterwise Visual state.', () => { enterVisual(cur(), 'char'); return false; });
CMD('evil-visual-line', '', '', 'Start or end linewise Visual state.', () => { enterVisual(cur(), 'line'); return false; });
CMD('evil-visual-block', '', '', 'Start or end blockwise Visual state.', () => { enterVisual(cur(), 'block'); return false; });
CMD('evil-exit-visual-state', '', '', 'Leave Visual state.', () => { setState(cur(), 'normal'); return false; });
CMD('evil-visual-exchange-corners', '', '', 'Move point to the other end of the selection.', () => { const b = cur(); if (b.mark !== null) [b.pt, b.mark] = [b.mark, b.pt]; return false; });
CMD('evil-visual-rotate', '', '', 'In a block, move point to the other side of the same line.', () => {
  const b = cur(), t = b.rope;
  if (b.visual !== 'block') { [b.pt, b.mark] = [b.mark, b.pt]; return false; }
  const cp = column(t, b.pt), cm = column(t, b.mark);
  b.pt = posAtColumn(t, bol(t, b.pt), cm); b.mark = posAtColumn(t, bol(t, b.mark), cp); return false;
});
CMD('evil-visual-restore', '', '', 'Select the previous Visual selection again.', () => {
  const b = cur(), v = b.lastVisual;
  if (!v) signal('user-error', 'No previous selection');
  if (stateOf(b) === 'visual') exitVisual(b);
  b.mark = Math.min(v.mark, b.rope.length); b.pt = Math.min(v.pt, b.rope.length); b.markActive = true; b.visual = v.type; b.evilState = 'normal'; setState(b, 'visual');
  return false;
});
D('evil-visual-range', '', 'Selection as (BEG END TYPE), and leave Visual state.', () => { const [s, e, t] = visualRange(cur(), true); return L.list(s + 1, e + 1, intern(t)); });
D('evil--apply-text-object', 'RANGE', 'In Visual state, extend the selection to RANGE. Return RANGE.', ([r]) => {
  const b = cur(), a = arr(r);
  if (stateOf(b) !== 'visual' || a.length < 2) return r;
  let s = a[0] - 1, e = a[1] - 1;
  const type = a[2] instanceof Sym ? a[2].name : 'exclusive';
  if (e <= s) return r;
  const single = b.mark === b.pt;
  if (!single) { s = Math.min(s, b.mark, b.pt); e = Math.max(e, Math.max(b.mark, b.pt) + 1); }
  if (type === 'line') b.visual = 'line';
  b.mark = s; b.pt = Math.max(s, e - 1); E.keepMark = true;
  return r;
});

/* ---------- insert, replace and emacs states ---------- */
function enterInsert(b, count, open, block) {
  if (stateOf(b) === 'visual') setState(b, 'normal');
  setState(b, 'insert');
  E.ins = { count: typeof count === 'number' && count > 1 ? count : 1, prefix: open ? ['RET'] : [], keys: [], replaying: false, block: block || null, replaced: [] };
}
D('evil-insert-state', '&optional COUNT OPEN', 'Enter Insert state. COUNT repeats the inserted text on exit; OPEN repeats it on new lines.',
  ([c, o]) => { enterInsert(cur(), L.absent(c) ? 1 : num(c), truthy(o)); return false; });
D('evil-replace-state', '&optional COUNT', 'Enter Replace state: typed characters overwrite the text.', ([c]) => {
  const b = cur(); enterInsert(b, optNum(c, 1), false); b.evilState = 'replace'; E.echo = ECHO.replace; return false;
});
function leaveInsert(b) {
  const ins = E.ins; E.ins = null;
  let blockPt = null;
  if (ins && ins.block) { applyBlockInsert(b, ins.block); blockPt = b.pt; }
  b.marks['^'] = b.pt;
  if (ins) E.registers['.'] = { text: keysToText(ins.keys.filter(k => [...k].length === 1 || k === 'SPC' || k === 'RET')), type: 'char' };
  setState(b, 'normal');
  if (blockPt !== null) b.pt = blockPt;
  else if (b.pt > bol(b.rope, b.pt)) b.pt--;
}
CMD('evil-normal-state', '', '', 'Return to Normal state from any other state.', () => {
  const b = cur(), st = stateOf(b);
  E.countStr = ''; E.register = null;
  if ((st === 'insert' || st === 'replace') && E.ins && E.ins.count > 1 && !E.ins.replaying) {
    const exitLen = E.thisKeys ? E.thisKeys.split(' ').length : 1;
    const typed = E.ins.keys.slice(0, Math.max(0, E.ins.keys.length - exitLen));
    const rep = [];
    for (let i = 1; i < E.ins.count; i++) rep.push(...E.ins.prefix, ...typed);
    E.ins.replaying = true; E.ins.count = 1;
    Ed.unreadKeys([...rep, 'ESC']);
    return false;
  }
  if (st === 'insert' || st === 'replace') leaveInsert(b);
  else if (st === 'visual' || st === 'operator' || st === 'motion' || st === 'emacs') setState(b, st === 'motion' ? 'motion' : 'normal');
  return false;
});
CMD('evil-force-normal-state', '', '', 'Leave Visual state and cancel any count or register.', () => {
  const b = cur(); E.countStr = ''; E.register = null; E.prefixArg = null;
  if (stateOf(b) === 'visual') setState(b, 'normal');
  return false;
});
CMD('evil-emacs-state', '', '', 'Switch this buffer to Emacs state: plain Emacs keys.', () => { const b = cur(); if (stateOf(b) === 'insert') leaveInsert(b); setState(b, 'emacs'); return false; });
CMD('evil-exit-emacs-state', '', '', 'Leave Emacs state for Normal state.', () => { const b = cur(); setState(b, initialState(b) === 'emacs' ? 'normal' : initialState(b)); E.echo = ''; return false; });
CMD('evil-toggle-emacs-state', '', '', 'Switch between Emacs state and Normal state.', () => L.apply(intern(stateOf(cur()) === 'emacs' ? 'evil-exit-emacs-state' : 'evil-emacs-state'), []));
CMD('evil-execute-in-normal-state', '', '', 'Run one Normal-state command, then return to Insert state.', () => {
  const b = cur(); b.evilState = 'normal'; E.oneShot = 1; E.echo = '-- (insert) --'; if (b.pt > bol(b.rope, b.pt) && (b.pt === b.rope.length || b.rope.at(b.pt) === '\n')) b.pt--; return false;
});
CMD('evil-mode', '', '&optional ARG', 'Toggle Evil: Vim states and keys in every buffer.', () => {
  E.evil = !E.evil;
  if (E.evil) for (const b of E.buffers) b.evilState = undefined; else for (const b of E.buffers) { b.visual = null; }
  E.ins = null; Ed.message(E.evil ? 'Evil mode enabled' : 'Evil mode disabled: plain Emacs keys'); return false;
});
for (const s of STATES) { D(`evil-${s}-state?`, '[buffer]', `#t if BUFFER is in ${s[0].toUpperCase() + s.slice(1)} state.`, ([b]) => stateOf(b instanceof Ed.Buffer ? b : cur()) === s); alias(`evil-${s}-state-p`, `evil-${s}-state?`); }
L.magic('evil-state', () => { const st = stateOf(cur()); return st ? intern(st) : false; }, null, 'The current Evil state as a symbol.');

/* Replace state: typed characters overwrite; DEL brings the old ones back. */
{
  const sic = L.toFn(intern('self-insert-command'));
  CMD('self-insert-command', sic.interactive, sic.params, sic.doc, ([n]) => {
    const b = cur();
    if (stateOf(b) !== 'replace') return sic([n]);
    const ch = chr(L.get('last-command-event'));
    if (ch === null || ch === undefined) return false;
    for (let k = 0; k < Math.max(1, optNum(n, 1)); k++) {
      if (b.pt < b.rope.length && b.rope.at(b.pt) !== '\n' && ch !== '\n') { E.ins && E.ins.replaced.push(b.rope.at(b.pt)); Ed.deleteText(b, b.pt, b.pt + 1); }
      else E.ins && E.ins.replaced.push(null);
      Ed.insertText(b, ch);
    }
    return false;
  });
}
CMD('evil-replace-backspace', '', '', 'In Replace state, move back and restore the character that was replaced.', () => {
  const b = cur();
  if (b.pt <= 0) return false;
  const old = E.ins && E.ins.replaced.length ? E.ins.replaced.pop() : undefined;
  if (old === undefined) { b.pt--; return false; }
  Ed.deleteText(b, b.pt - 1, b.pt);
  if (old !== null) { Ed.insertText(b, old); b.pt--; }
  return false;
});

/* Visual block I and A: type on the first line, the text is copied to the others on ESC. */
function blockInsert(append) {
  const b = cur(), t = b.rope;
  if (b.visual !== 'block') {
    const [s, e] = visualBounds(b);
    setState(b, 'normal');
    b.pt = append ? Math.min(e, t.length) : s;
    if (append && b.visual === null && t.at(b.pt - 1) === '\n') b.pt--;
    enterInsert(b, 1, false); return false;
  }
  const { c1, c2, l1, l2 } = (visualBounds(b), E.blockCols);
  setState(b, 'normal');
  const col = append ? c2 + 1 : c1;
  const lines = [];
  for (let ls = eol(t, l1) + 1; ls <= l2 && ls <= t.length; ls = eol(t, ls) + 1) { const m = { pos: ls }; b.temps.add(m); lines.push(m); if (eol(t, ls) >= t.length) break; }
  b.pt = posAtColumn(b.rope, l1, col);
  if (append && column(b.rope, b.pt) < col) Ed.insertText(b, ' '.repeat(col - column(b.rope, b.pt)));
  const start = { pos: b.pt }; b.temps.add(start);
  enterInsert(b, 1, false, { lines, col, append, start });
  return false;
}
function applyBlockInsert(b, blk) {
  const { lines, col, append, start } = blk;
  const text = start.dead || b.pt < start.pos ? '' : b.rope.slice(start.pos, b.pt);
  b.temps.delete(start);
  const savePt = b.pt;
  if (text && !text.includes('\n')) {
    for (const m of lines) {
      if (m.dead) continue;
      const t = b.rope, ls = m.pos, le = eol(t, ls);
      let p = posAtColumn(t, ls, col);
      if (column(t, p) < col || p > le) {
        if (!append) continue;
        b.pt = le; Ed.insertText(b, ' '.repeat(col - column(b.rope, le))); p = b.pt;
      }
      b.pt = p; Ed.insertText(b, text);
    }
  }
  for (const m of lines) b.temps.delete(m);
  b.pt = Math.min(savePt, b.rope.length);
  b.pt = Math.max(0, start.pos);
  void savePt;
}
CMD('evil-visual-insert', '', '', 'Insert at the left edge of the selection (on every line of a block).', () => blockInsert(false));
CMD('evil-visual-append', '', '', 'Append at the right edge of the selection (on every line of a block).', () => blockInsert(true));

/* ---------- keys typed: counts, registers, dot repeat, macros ---------- */
const KEY2CH = { SPC: ' ', RET: '\n', TAB: '\t', ESC: '\x1b', DEL: '\x7f' };
function keysToText(keys) { return keys.map(k => KEY2CH[k] ?? (/^C-[a-z]$/.test(k) ? String.fromCharCode(k.charCodeAt(2) - 96) : [...k].length === 1 ? k : `<${k}>`)).join(''); }
function textToKeys(text) {
  const out = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === ' ') out.push('SPC'); else if (ch === '\n' || ch === '\r') out.push('RET'); else if (ch === '\t') out.push('TAB');
    else if (code === 27) out.push('ESC'); else if (code === 127) out.push('DEL');
    else if (code > 0 && code < 27) out.push('C-' + String.fromCharCode(code + 96));
    else out.push(ch);
  }
  return out;
}
H.recordKey = it => {
  if (E.macro && it.real) E.macro.keys.push(it.k);
  if (E.dotCand && it.real) E.dotCand.keys.push(it.k);
  if (E.ins && !E.ins.replaying) E.ins.keys.push(it.k);
};
H.beforeKey = async k => {
  const b = cur(), st = stateOf(b);
  if (E.depth === 0 && !E.dotCand && (st === 'normal' || st === 'visual'))
    E.dotCand = { keys: E.lastKeyReal ? [k] : [], startVer: b.ver, buf: b, startState: st, cmd: null, vis: null };
  if (st !== 'normal' && st !== 'visual' && st !== 'motion') return false;
  if (/^[1-9]$/.test(k) || (k === '0' && E.countStr)) { E.countStr += k; E.prefixArg = +E.countStr; return true; }
  if (k === '"') {
    const r = await Ed.nextKey();
    if (r === 'ESC' || r === 'C-g') { E.register = null; return true; }
    const c = Ed.keyChar(r);
    if (!c || !/^[a-zA-Z0-9"\-_+*/:.%]$/.test(c)) { Ed.ding(); return true; }
    E.register = c; return true;
  }
  return false;
};
H.undefinedKey = () => { E.countStr = ''; E.register = null; E.dotCand = null; };
H.nativePaste = () => { if (E.mini) return true; const st = stateOf(E.current); return st === 'insert' || st === 'replace' || st === null; };
H.clampPoint = b => { const st = stateOf(b); if (st === 'normal' || st === 'motion' || st === 'visual') clampNormal(b); };
H.canSelfInsert = b => { const st = stateOf(b); return st === null || st === 'insert' || st === 'replace' || st === 'emacs'; };
H.inSession = b => { const st = stateOf(b); return st === 'insert' || st === 'replace'; };
H.sexpEnd = b => { const st = stateOf(b); return (st === 'normal' || st === 'visual' || st === 'motion') && b.pt < b.rope.length && b.rope.at(b.pt) !== '\n' ? b.pt + 1 : b.pt; };
function visualPrefix(v) {
  if (!v) return [];
  const digits = n => String(n).split('');
  if (v.type === 'line') return ['V', ...(v.lines > 1 ? [...digits(v.lines - 1), 'j'] : [])];
  if (v.type === 'block') return ['C-v', ...(v.lines > 1 ? [...digits(v.lines - 1), 'j'] : []), ...(v.width > 1 ? [...digits(v.width - 1), 'l'] : [])];
  if (v.lines === 1) return ['v', ...(v.chars > 1 ? [...digits(v.chars - 1), 'l'] : [])];
  return ['v', ...digits(v.lines - 1), 'j', ...digits(v.endCol + 1), '|'];
}
function finishDot(c) {
  const keys = c.keys; let i = 0, count = '', reg = null;
  for (;;) {
    if (keys[i] === '"' && i + 1 < keys.length) { reg = keys[i + 1]; i += 2; continue; }
    if (/^[1-9]$/.test(keys[i]) || (count && /^[0-9]$/.test(keys[i]))) { count += keys[i++]; continue; }
    break;
  }
  return { pre: c.startState === 'visual' ? visualPrefix(c.vis) : [], keys: keys.slice(i), count: count ? +count : null, reg };
}
H.preCommand = (def, b) => {
  if (E.dotCand && !E.dotCand.cmd) {
    E.dotCand.cmd = def;
    if (E.dotCand.startState === 'visual' && b.visual) {
      const t = b.rope, s = Math.min(b.pt, b.mark), e = Math.max(b.pt, b.mark);
      E.dotCand.vis = { type: b.visual, lines: lineNo(t, e) - lineNo(t, s) + 1, chars: e - s + 1, endCol: column(t, e), width: Math.abs(column(t, b.pt) - column(t, b.mark)) + 1 };
    }
  }
  if (truthy(get(def, 'evil-jump')) && E.depth === 0) E.jumpFrom = { b, pt: b.pt };
  else E.jumpFrom = null;
};
/* Keep the edit log back to the versions compared above. */
H.logFloor = b => Math.min(b._lastVer ?? Infinity, E.dotCand && E.dotCand.buf === b ? E.dotCand.startVer : Infinity);
H.postCommand = (def, b, failed) => {
  if (E.depth > 0) return;
  const w = E.win, st = stateOf(w);
  if (st === 'operator') w.evilState = 'normal';
  if (E.jumpFrom && E.jumpFrom.b === E.current && E.current.pt !== E.jumpFrom.pt && !failed) pushJump(E.jumpFrom.b, E.jumpFrom.pt);
  E.jumpFrom = null;
  /* Versions, not text copies: comparing whole texts would flatten the rope after every edit. */
  if (b._lastVer !== undefined && Ed.changedSince(b, b._lastVer)) b.marks['.'] = b.pt;
  b._lastVer = b.ver;
  if (E.oneShot === 1) E.oneShot = 2;
  else if (E.oneShot === 2) {
    E.oneShot = 0; const cb = E.current;
    if (stateOf(cb) === 'normal' && E.ins) {
      cb.evilState = 'insert'; E.echo = ECHO.insert;
      if (def === intern('evil-end-of-line') || (cb.pt === eol(cb.rope, cb.pt) - 1 && def === intern('evil-append'))) cb.pt = eol(cb.rope, cb.pt);
    }
  }
  const cs = stateOf(E.current);
  if (E.dotCand && cs !== 'insert' && cs !== 'replace' && !E.oneShot) {
    const c = E.dotCand; E.dotCand = null;
    const abort = get(c.cmd, 'evil-repeat') === intern('abort');
    if (!failed && !abort && c.keys.length && Ed.changedSince(c.buf, c.startVer)) E.dotLast = finishDot(c);
  }
  if (cs === 'normal' || cs === 'motion') clampNormal(E.current);
  if (cs === 'visual' && E.current.mark === null) setState(E.current, 'normal');
  E.countStr = ''; E.register = null;
};
CMD('evil-repeat', '<c>', '&optional COUNT', 'Repeat the last change. A COUNT replaces the count of that change.', ([count]) => {
  const d = E.dotLast;
  if (!d) signal('user-error', 'Nothing to repeat');
  if (count !== false) d.count = count;
  if (d.reg && /^[1-8]$/.test(d.reg)) d.reg = String(+d.reg + 1);
  Ed.unreadKeys([...d.pre, ...(d.reg ? ['"', d.reg] : []), ...(d.count ? String(d.count).split('') : []), ...d.keys]);
  return false;
});
CMD('evil-record-macro', async () => E.macro ? [false] : [await Ed.readChar('')], 'REGISTER', 'Record keys into REGISTER until q is pressed again.', ([r]) => {
  if (E.macro) {
    const m = E.macro; E.macro = null;
    const n = E.thisKeys ? E.thisKeys.split(' ').length : 0;
    const keys = m.keys.slice(0, Math.max(0, m.keys.length - n));
    const entry = { text: keysToText(keys), type: 'char', keys };
    if (/[A-Z]/.test(m.reg)) { const old = E.registers[m.reg.toLowerCase()]; const ok = old ? (old.keys || textToKeys(old.text)) : []; entry.keys = ok.concat(keys); entry.text = keysToText(entry.keys); E.registers[m.reg.toLowerCase()] = entry; }
    else E.registers[m.reg] = entry;
    E.echo = ''; return false;
  }
  const c = chr(r);
  if (!/^[a-zA-Z0-9"]$/.test(c)) signal('user-error', `Invalid register: ${c}`);
  E.macro = { reg: c === '"' ? '"' : c, keys: [] };
  return false;
});
CMD('evil-execute-macro', async () => [E.prefixArg === null ? 1 : Ed.prefixNumeric(E.prefixArg), await Ed.readChar('')], 'COUNT REGISTER',
  'Run the keys in REGISTER COUNT times. @@ repeats the last one, @: the last ex command.', async ([count, r]) => {
    let c = chr(r);
    if (c === '@') { if (!E.lastMacro) signal('user-error', 'No previously used register'); c = E.lastMacro; }
    if (c === ':') { E.lastMacro = ':'; if (!E.lastEx) signal('user-error', 'No previous command line'); for (let k = 0; k < count; k++) await globalThis.EvilCore.exExecute(E.lastEx); return false; }
    const e = regGet(c);
    if (!e) signal('user-error', `Register ${c} is empty`);
    E.lastMacro = c;
    const keys = e.keys || textToKeys(e.text), all = [];
    for (let k = 0; k < count; k++) all.push(...keys);
    Ed.unreadKeys(all);
    return false;
  });
CMD('evil-paste-from-register', async () => [await Ed.readChar('"')], 'REGISTER', 'Insert the text of REGISTER (C-r in Insert state).', ([r]) => {
  const e = regGet(r); if (!e) signal('user-error', `Register ${regKey(r)} is empty`);
  Ed.insertText(cur(), e.text); return false;
});

/* ---------- undo, marks and jumps ---------- */
CMD('evil-undo', '<c>', '&optional COUNT', 'Undo COUNT changes.', ([n]) => { const b = cur(); for (let k = 0; k < optNum(n, 1); k++) Ed.undoStep(b); clampNormal(b); return false; });
CMD('evil-redo', '<c>', '&optional COUNT', 'Redo COUNT changes.', ([n]) => { const b = cur(); for (let k = 0; k < optNum(n, 1); k++) Ed.redoStep(b); clampNormal(b); return false; });
function pushJump(b, pos) {
  const t = b.rope, ln = lineNo(t, pos);
  b.jumps = b.jumps.filter(j => lineNo(t, j) !== ln);
  b.jumps.push(pos); if (b.jumps.length > 100) b.jumps.shift();
  b.jumpIdx = b.jumps.length; b.marks['`'] = pos;
}
D('evil-set-jump', '&optional POS', 'Record POS (default point) in the jump list.', ([p]) => { const b = cur(); pushJump(b, L.absent(p) ? b.pt : num(p) - 1); return false; });
CMD('evil-jump-backward', '<c>', '&optional COUNT', 'Go to an older position in the jump list (C-o).', ([n]) => {
  const b = cur(), c = optNum(n, 1);
  if (b.jumpIdx >= b.jumps.length) { pushJump(b, b.pt); b.jumpIdx = b.jumps.length - 1; }
  const k = b.jumpIdx - c; if (k < 0) signal('user-error', 'At the start of the jump list');
  b.jumpIdx = k; b.pt = Math.min(b.jumps[k], b.rope.length); return false;
});
CMD('evil-jump-forward', '<c>', '&optional COUNT', 'Go to a newer position in the jump list (C-i or TAB).', ([n]) => {
  const b = cur(), k = b.jumpIdx + optNum(n, 1);
  if (k >= b.jumps.length) signal('user-error', 'At the end of the jump list');
  b.jumpIdx = k; b.pt = Math.min(b.jumps[k], b.rope.length); return false;
});
D('evil-set-marker', 'CHAR &optional POS', 'Set mark CHAR at POS (default point).', ([c, p]) => {
  const ch = chr(c), b = cur();
  if (!/^[a-zA-Z`'<>\[\].^]$/.test(ch)) signal('user-error', `Invalid mark: ${ch}`);
  b.marks[ch === "'" ? '`' : ch] = L.absent(p) ? b.pt : num(p) - 1; return false;
});
D('evil-get-marker', 'CHAR', 'Position of mark CHAR, or nil.', ([c]) => {
  const ch = chr(c), b = cur(); const v = b.marks[ch === "'" ? '`' : ch];
  return v === undefined ? false : Math.min(v, b.rope.length) + 1;
});

/* ---------- character classes, lines and pairs, used by motions and text objects ---------- */
const WORDCH = /[\p{L}\p{N}_]/u;
function cclass(ch, big) {
  if (ch === undefined) return 4;
  if (ch === '\n') return 3;
  if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === ' ') return 0;
  if (big) return 1;
  return WORDCH.test(ch) ? 1 : 2;
}
D('evil--class', 'CHAR &optional BIG', 'Syntax class of CHAR for word motions: 0 blank, 1 word, 2 punctuation, 3 newline, 4 none.',
  ([c, big]) => cclass(chr(c) ?? undefined, truthy(big)));
D('evil--line-move', 'COUNT &optional NOERROR', 'Move COUNT lines down (up if negative), keeping the goal column.', ([n, noerr]) => {
  const b = cur(), t = b.rope, c = num(n);
  const vert = ['evil-next-line', 'evil-previous-line', 'evil-next-visual-line', 'evil-previous-visual-line', 'evil-scroll-down', 'evil-scroll-up', 'next-line', 'previous-line'];
  const last = E.lastCommand instanceof Sym ? E.lastCommand.name : '';
  if (last === 'evil-end-of-line') E.goalCol = Infinity;
  else if (!vert.includes(last) || E.goalCol === null) E.goalCol = column(t, b.pt);
  if (E.thisCommand === intern('evil-end-of-line')) E.goalCol = Infinity;
  const curLine = lineNo(t, b.pt), lastLine = lineNo(t, lastLineStart(t));
  let target = curLine + c;
  /* Folded lines (org.js keeps b.folds) are stepped over, as line-move-ignore-invisible does. */
  if (H.lineTarget && b.folds && b.folds.length) {
    target = H.lineTarget(b, curLine, c);
    if (target === curLine && c !== 0) { if (truthy(noerr)) return false; signal(c > 0 ? 'end-of-buffer' : 'beginning-of-buffer'); }
  } else if (target < 1 || target > lastLine) {
    if ((c > 0 && curLine >= lastLine) || (c < 0 && curLine <= 1)) { if (truthy(noerr)) return false; signal(c > 0 ? 'end-of-buffer' : 'beginning-of-buffer'); }
    target = Math.max(1, Math.min(lastLine, target));
  }
  const ls = lineStartOf(t, target), le = eol(t, ls);
  let p = E.goalCol === Infinity ? le : posAtColumn(t, ls, E.goalCol);
  const st = stateOf(b);
  if ((st === 'normal' || st === 'motion' || st === 'visual' && E.goalCol !== Infinity) && p >= le && le > ls) p = le - 1;
  if (st === 'visual' && E.goalCol === Infinity) p = le;
  b.pt = p;
  return false;
});
D('evil--last-line-position', '', 'Start of the last line that holds text.', () => lastLineStart(cur().rope) + 1);
D('evil--find-char', 'COUNT CHAR FORWARD TILL &optional REPEAT', 'Position of the COUNTth CHAR on this line for f, F, t and T, or nil.', ([n, c, fwd, till, rep]) => {
  const b = cur(), t = b.rope, ch = chr(c), ls = bol(t, b.pt), le = eol(t, b.pt);
  let p = b.pt, cnt = optNum(n, 1);
  const f = truthy(fwd), tl = truthy(till);
  if (truthy(rep) && tl) p += f ? 1 : -1;
  for (; cnt > 0; cnt--) {
    p = f ? t.indexOf(ch, p + 1) : t.lastIndexOf(ch, p - 1);
    if (p < 0 || (f ? p >= le : p < ls)) return false;
  }
  if (tl) p += f ? -1 : 1;
  return p + 1;
});
const PAIRS = { '(': ')', '[': ']', '{': '}' }, CLOSE = { ')': '(', ']': '[', '}': '{' };
function matchBracket(b, k) {
  const t = b.rope, ch = t.at(k);
  if (Ed.isLisp(b) && (ch === '(' || ch === ')')) { const cls = Ed.lexOf(b); if (cls[k] === Ed.C.PAR) { const o = Ed.matchParen(t, cls, k); return o === null || o === undefined ? null : o; } }
  if (PAIRS[ch]) { let d = 0; for (let j = k; j < t.length; j++) { if (t.at(j) === ch) d++; else if (t.at(j) === PAIRS[ch] && --d === 0) return j; } return null; }
  if (CLOSE[ch]) { let d = 0; for (let j = k; j >= 0; j--) { if (t.at(j) === ch) d++; else if (t.at(j) === CLOSE[ch] && --d === 0) return j; } return null; }
  return null;
}
D('evil--find-string', 'COUNT STRING FORWARD &optional REPEAT TILL', 'Position of the COUNTth STRING on screen after (or before) point, for snipe; #f when none. TILL stops next to it (evil-snipe-t), and a repeat then skips the match beside point.', ([n, s, fwd, rep, till]) => {
  const b = cur(), t = b.text, f = truthy(fwd);
  const view = E.sel.view;
  let first = 0, last = t.length;
  { const v = visibleLines(); first = v.first; last = v.last; }
  const needle = str(s), fold = needle === needle.toLowerCase();
  const hay = fold ? t.toLowerCase() : t, nd = fold ? needle.toLowerCase() : needle;
  let p = b.pt, cnt = optNum(n, 1);
  const tl = truthy(till);
  if (truthy(rep) && tl) p += f ? 1 : -1;
  for (; cnt > 0; cnt--) {
    p = f ? hay.indexOf(nd, p + 1) : hay.lastIndexOf(nd, p - 1);
    if (p < 0 || (f ? p > last : p < first)) return false;
  }
  if (tl) p += f ? -1 : nd.length;
  return p + 1;
});
D('symbol-bounds-at-point', '', 'Start and end (exclusive) of the symbol at point as a list, or #f.', () => {
  const b = cur(), t = b.rope, re = Ed.isLisp(b) ? /[\p{L}\p{N}_\-+*\/<>=!?:&%$^~.]/u : /[\p{L}\p{N}_]/u;
  let s = b.pt, e = b.pt;
  while (s > 0 && re.test(t.at(s - 1))) s--;
  while (e < t.length && re.test(t.at(e))) e++;
  return s < e ? L.list(s + 1, e + 1) : false;
});
D('evil-select-region', 'BEG END', 'Select the text from BEG to END in characterwise Visual state.', ([s, e]) => {
  const b = cur(); const beg = num(s) - 1, end = Math.max(beg, num(e) - 2);
  if (stateOf(b) !== 'visual') { b.mark = beg; b.pt = end; b.markActive = true; b.visual = 'char'; setState(b, 'visual'); }
  else { b.mark = beg; b.pt = end; b.visual = 'char'; }
  E.keepMark = true; return false;
});
D('evil--jump-item', '', 'Position of the bracket matching the first bracket at or after point on this line, or nil.', () => {
  const b = cur(), t = b.rope, le = eol(t, b.pt);
  let k = b.pt; while (k < le && !PAIRS[t.at(k)] && !CLOSE[t.at(k)]) k++;
  if (k >= le) return false;
  const m = matchBracket(b, k); return m === null ? false : m + 1;
});
function wordObject(b, count, big, outer) {
  const t = b.rope, p = b.pt, ls = bol(t, p), le = eol(t, p);
  if (p >= le) return null;
  const cl = q => cclass(t.at(q), big);
  const runEnd = q => { const c = cl(q); while (q < le && cl(q) === c) q++; return q; };
  const runStart = q => { const c = cl(q); while (q > ls && cl(q - 1) === c) q--; return q; };
  let beg = runStart(p), end = runEnd(p);
  if (!outer) { for (let i = 1; i < count && end < le; i++) end = runEnd(end); return [beg, end]; }
  if (cl(p) === 0) { for (let i = 0; i < count && end < le; i++) { end = runEnd(end); if (i + 1 < count && end < le && cl(end) === 0) end = runEnd(end); } return [beg, end]; }
  for (let i = 0; i < count; i++) {
    if (i > 0) { if (end < le && cl(end) === 0) end = runEnd(end); if (end < le) end = runEnd(end); }
  }
  if (end < le && cl(end) === 0) end = runEnd(end);
  else if (beg > ls && cl(beg - 1) === 0 && runStart(beg - 1) > ls) beg = runStart(beg - 1);
  return [beg, end];
}
D('evil--word-object', 'COUNT BIG OUTER', 'Range (BEG END) of COUNT words at point for iw, aw, iW and aW.', ([n, big, outer]) => {
  const r = wordObject(cur(), optNum(n, 1), truthy(big), truthy(outer));
  return r ? L.list(r[0] + 1, r[1] + 1, intern('exclusive')) : false;
});
function pairObject(b, open, close, count, outer) {
  const t = b.rope; let p = b.pt, o = null;
  for (let c = 0; c < count; c++) {
    o = null;
    if (c === 0 && t.at(p) === open) o = p;
    else {
      let d = 0;
      for (let k = (c === 0 && t.at(p) === close) ? p - 1 : p - 1; k >= 0; k--) {
        if (t.at(k) === close && open !== close) d++;
        else if (t.at(k) === open) { if (d === 0) { o = k; break; } d--; }
      }
    }
    if (o === null) return null;
    p = o;
  }
  let d = 0, cl = null;
  for (let k = o; k < t.length; k++) { if (t.at(k) === open) d++; else if (t.at(k) === close && --d === 0) { cl = k; break; } }
  if (cl === null) return null;
  if (outer) return [o, cl + 1, 'exclusive'];
  let beg = o + 1, end = cl;
  if (t.at(beg) === '\n' && /^[ \t]*$/.test(t.slice(bol(t, cl), cl)) && bol(t, cl) > beg) return [beg + 1, bol(t, cl), 'line'];
  return [beg, end, 'exclusive'];
}
D('evil--pair-object', 'OPEN CLOSE COUNT OUTER', 'Range of the COUNTth pair of OPEN and CLOSE around point.', ([o, c, n, outer]) => {
  const r = pairObject(cur(), chr(o), chr(c), optNum(n, 1), truthy(outer));
  return r ? L.list(r[0] + 1, r[1] + 1, intern(r[2])) : false;
});
D('evil--quote-object', 'QUOTE OUTER', 'Range of the QUOTE-delimited string on this line around or after point.', ([q, outer]) => {
  const b = cur(), t = b.rope, ch = chr(q), p = b.pt, ls = bol(t, p), le = eol(t, p);
  const qs = [];
  for (let k = ls; k < le; k++) if (t.at(k) === ch && t.at(k - 1) !== '\\') qs.push(k);
  let pair = null;
  for (let i = 0; i + 1 < qs.length; i += 2) if (qs[i] <= p && p <= qs[i + 1]) { pair = [qs[i], qs[i + 1]]; break; }
  if (!pair) for (let i = 0; i + 1 < qs.length; i += 2) if (qs[i] > p) { pair = [qs[i], qs[i + 1]]; break; }
  if (!pair) return false;
  let [a, z] = pair;
  if (!truthy(outer)) return L.list(a + 2, z + 1, intern('exclusive'));
  let e = z + 1;
  if (e < le && /[ \t]/.test(t.at(e))) { while (e < le && /[ \t]/.test(t.at(e))) e++; }
  else { while (a > ls && /[ \t]/.test(t.at(a - 1))) a--; }
  return L.list(a + 1, e + 1, intern('exclusive'));
});
D('evil--block-ranges', 'BEG END', 'List of (LINE-BEG . LINE-END) pieces of the block from BEG to END.', ([s, e]) => listOf(blockRanges(cur(), num(s) - 1, num(e) - 1).map(([a, z]) => new L.Pair(a + 1, z + 1))));
function blockRanges(b, beg, end) {
  const t = b.rope;
  let c1, c2;
  if (E.blockCols && E.blockCols.beg === beg && E.blockCols.end === end) ({ c1, c2 } = E.blockCols);
  else { const ce = column(t, Math.max(beg, end - 1)); c1 = Math.min(column(t, beg), ce); c2 = Math.max(column(t, beg), ce); }
  const out = [];
  for (let ls = bol(t, beg); ; ) {
    const le = eol(t, ls);
    const a = posAtColumn(t, ls, c1), z = Math.min(le, posAtColumn(t, ls, c2 + 1));
    out.push([Math.min(a, le), Math.max(Math.min(a, le), z)]);
    if (le >= t.length || le + 1 > Math.max(beg, end - 1)) break;
    ls = le + 1;
  }
  return out;
}
function blockText(b, beg, end) { return blockRanges(b, beg, end).map(([a, z]) => b.rope.slice(a, z)).join('\n'); }
D('evil--delete-block', 'BEG END', 'Delete the block from BEG to END and leave point at its top-left corner.', ([s, e]) => {
  const b = cur(), rs = blockRanges(b, num(s) - 1, num(e) - 1);
  for (let i = rs.length - 1; i >= 0; i--) Ed.deleteText(b, rs[i][0], rs[i][1]);
  b.pt = rs[0][0]; return false;
});
D('evil--change-block', 'BEG END', 'Delete the block from BEG to END, then insert on each of its lines.', ([s, e]) => {
  const b = cur(), beg = num(s) - 1, rs = blockRanges(b, beg, num(e) - 1);
  const col = column(b.rope, rs[0][0]);
  for (let i = rs.length - 1; i >= 0; i--) Ed.deleteText(b, rs[i][0], rs[i][1]);
  const t = b.rope, lines = [];
  for (let i = 1; i < rs.length; i++) { const m = { pos: bol(t, rs[i][0]) }; b.temps.add(m); lines.push(m); }
  b.pt = rs[0][0];
  const start = { pos: b.pt }; b.temps.add(start);
  enterInsert(b, 1, false, { lines, col, append: false, start });
  return false;
});

/* ---------- yank and paste ---------- */
D('evil--yank', 'BEG END TYPE REGISTER &optional DELETE', 'Save the text from BEG to END in REGISTER, with Vim’s register rules. Return the text.', ([s, e, ty, r, del]) => {
  const b = cur(), beg = num(s) - 1, end = num(e) - 1, type = ty instanceof Sym ? ty.name : 'char';
  const kind = type === 'line' ? 'line' : type === 'block' ? 'block' : 'char';
  const text = kind === 'block' ? blockText(b, beg, end) : b.rope.slice(beg, end);
  storeYank(text, kind, L.absent(r) ? null : regKey(r), truthy(del));
  b.marks['['] = beg; b.marks[']'] = Math.max(beg, end - 1);
  const n = (text.match(/\n/g) || []).length + (kind === 'block' ? 1 : 0);
  if (n > 2) Ed.message(kind === 'block' ? `block of ${n} lines ${truthy(del) ? 'deleted' : 'yanked'}` : truthy(del) ? `${n} fewer lines` : `${n} lines yanked`);
  return text;
});
/* evil-open-below (o) goes here before it opens its line: the new line goes below a closed fold. */
D('evil--end-of-line-or-fold', '', 'Move point to the end of the line, or of the closed fold that starts there.', () => {
  const b = cur(); let e = eol(b.rope, b.pt);
  if (H.foldEnd && b.folds && b.folds.length) e = H.foldEnd(b, e);
  b.pt = e; return false;
});
D('evil--paste', 'TEXT TYPE COUNT AFTER', 'Insert TEXT of TYPE (char, line or block) COUNT times, after point if AFTER, and place point as Vim does.', ([text, ty, n, after]) => {
  const b = cur(), type = ty instanceof Sym ? ty.name : 'char', count = Math.max(1, optNum(n, 1)), aft = truthy(after);
  str(text); if (!text) return false;
  const t = b.rope;
  if (type === 'line') {
    let body = text.endsWith('\n') ? text : text + '\n'; body = body.repeat(count);
    let start;
    if (aft) {
      /* Below a closed fold (org.js keeps b.folds), not into its hidden lines, as in Vim. */
      let e = eol(t, b.pt); if (H.foldEnd && b.folds && b.folds.length) e = H.foldEnd(b, e);
      if (e >= t.length) { b.pt = t.length; Ed.insertText(b, '\n' + body.slice(0, -1)); start = e + 1; }
      else { b.pt = e + 1; Ed.insertText(b, body); start = e + 1; }
    } else { start = bol(t, b.pt); b.pt = start; Ed.insertText(b, body); }
    b.marks['['] = start; b.marks[']'] = Math.max(start, b.pt - 1);
    b.pt = firstNonBlank(b.rope, start);
    return false;
  }
  if (type === 'block') {
    const pieces = text.split('\n'), width = Math.max(...pieces.map(p => [...p].length));
    let col = column(t, b.pt) + (aft && b.pt < t.length && t.at(b.pt) !== '\n' ? 1 : 0);
    let ls = bol(t, b.pt);
    const top = ls;
    for (let i = 0; i < pieces.length; i++) {
      if (i > 0) { const le = eol(b.rope, ls); if (le >= b.rope.length) { b.pt = b.rope.length; Ed.insertText(b, '\n'); } ls = eol(b.rope, ls) + 1; }
      const le = eol(b.rope, ls);
      let p = posAtColumn(b.rope, ls, col);
      if (column(b.rope, p) < col || p >= le) { b.pt = le; Ed.insertText(b, ' '.repeat(Math.max(0, col - column(b.rope, le)))); p = b.pt; }
      const after = p < eol(b.rope, ls);
      b.pt = p; Ed.insertText(b, after ? pieces[i].padEnd(width) : pieces[i].repeat(1));
    }
    b.pt = posAtColumn(b.rope, top, col);
    return false;
  }
  const body = text.repeat(count);
  let pos = b.pt; if (aft && pos < t.length && t.at(pos) !== '\n') pos++;
  b.pt = pos; Ed.insertText(b, body);
  b.marks['['] = pos; b.marks[']'] = Math.max(pos, b.pt - 1);
  b.pt = body.includes('\n') ? pos : Math.max(pos, b.pt - 1);
  return false;
});
D('evil-first-non-blank-position', '&optional POS', 'Position of the first non-blank character on the line of POS.', ([p]) => { const b = cur(); return firstNonBlank(b.rope, L.absent(p) ? b.pt : num(p) - 1) + 1; });
D('thing-at-point', 'THING', 'The symbol or word at point, as a string, or nil.', ([th]) => {
  const b = cur(), t = b.rope, re = th === intern('word') ? /[\p{L}\p{N}_]/u : /[\p{L}\p{N}_\-+*/<>=!?:&%$^~.]/u;
  let s = b.pt, e = b.pt;
  while (s > 0 && re.test(t.at(s - 1))) s--;
  while (e < t.length && re.test(t.at(e))) e++;
  return s < e ? t.slice(s, e) : false;
});

/* ---------- the window: screen lines and scrolling ---------- */
function visibleLines() {
  const w = E.sel, b = w.buffer, t = b.text;
  const first = w.start, lastLs = Ed.lineStartB(b, Math.max(1, w.lastLine || Ed.lineNoB(b, w.start)));
  return { first, last: eol(t, lastLs), n: w.rows || Ed.windowRows(w), t };
}
D('evil--window-line', 'WHICH &optional COUNT', 'Start of the top (H), middle (M) or bottom (L) line on screen.', ([w, n]) => {
  const v = visibleLines(), t = cur().rope, c = optNum(n, 1) - 1;
  const l1 = lineNo(t, v.first), l2 = lineNo(t, v.last);
  const which = chr(w);
  const line = which === 'H' ? Math.min(l2, l1 + c) : which === 'L' ? Math.max(l1, l2 - c) : Math.floor((l1 + l2) / 2);
  return lineStartOf(t, line) + 1;
});
function scrollBy(lines, movePoint) {
  const w = E.sel, b = cur();
  Ed.scrollWindow(w, lines);
  if (movePoint) { const total = Ed.lineCountB(b), target = Math.max(1, Math.min(total, Ed.lineNoB(b, b.pt) + lines)); b.pt = firstNonBlank(b.rope, Ed.lineStartB(b, target)); }
  else {
    const l = Ed.lineNoB(b, b.pt), l1 = Ed.lineNoB(b, w.start), l2 = l1 + (w.rows || 20) - 1;
    if (l < l1) b.pt = firstNonBlank(b.rope, w.start); else if (l > l2) b.pt = firstNonBlank(b.rope, Ed.lineStartB(b, l2));
  }
}
const half = () => Math.max(1, Math.floor(visibleLines().n / 2));
CMD('evil-scroll-down', '<c>', '&optional COUNT', 'Scroll the window and point down half a screen (C-d).', ([n]) => { scrollBy(n === false ? half() : num(n), true); return false; });
CMD('evil-scroll-up', '<c>', '&optional COUNT', 'Scroll the window and point up half a screen (C-u).', ([n]) => { scrollBy(-(n === false ? half() : num(n)), true); return false; });
CMD('evil-scroll-page-down', '<c>', '&optional COUNT', 'Scroll down a screen (C-f).', ([n]) => { scrollBy((visibleLines().n - 2) * optNum(n, 1), true); return false; });
CMD('evil-scroll-page-up', '<c>', '&optional COUNT', 'Scroll up a screen (C-b).', ([n]) => { scrollBy(-(visibleLines().n - 2) * optNum(n, 1), true); return false; });
CMD('evil-scroll-line-down', '<c>', '&optional COUNT', 'Scroll the text up COUNT lines, keeping point on screen (C-e).', ([n]) => { scrollBy(optNum(n, 1), false); return false; });
CMD('evil-scroll-line-up', '<c>', '&optional COUNT', 'Scroll the text down COUNT lines, keeping point on screen (C-y).', ([n]) => { scrollBy(-optNum(n, 1), false); return false; });
CMD('evil-scroll-line-to-center', '', '', 'Scroll so the line with point is in the middle (zz).', () => { E.recenter = 'center'; return false; });
CMD('evil-scroll-line-to-top', '', '', 'Scroll so the line with point is at the top (zt).', () => { E.recenter = 'top'; return false; });
CMD('evil-scroll-line-to-bottom', '', '', 'Scroll so the line with point is at the bottom (zb).', () => { E.recenter = 'bottom'; return false; });

for (const n of ['evil-repeat', 'evil-undo', 'evil-redo', 'evil-execute-macro', 'undo', 'undo-redo', 'evil-record-macro']) put(n, 'evil-repeat', intern('abort'));
globalThis.EvilCore = { stateOf, setState, visualBounds, visualRange, readRange, regGet, storeYank, keysToText, textToKeys, clampNormal, firstNonBlank, blockRanges, pushJump, exitVisual, enterInsert, defvar, D, CMD, put, get, aux, KM };
})();
