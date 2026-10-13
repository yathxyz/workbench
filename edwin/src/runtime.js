/* Runtime bridge: what the editor's JavaScript layers need from Scheme, in one place.
   Commands are Scheme procedures with an `interactive` property; keymaps hold symbols
   (resolved at dispatch time, so a redefinition takes effect at once) or procedures. */
(function () {
function runtimeModule(g) {
'use strict';
const S = g.Scheme;
const { Sym, Pair, Char, SchemeError, NIL, UNSPEC, intern, listOf, arr: arr0, callProc, write, display, gbox, globals } = S;

const ERRMSG = {
  'wrong-type-argument': 'Wrong type argument', 'wrong-number-of-arguments': 'Wrong number of arguments',
  'args-out-of-range': 'Args out of range', 'beginning-of-buffer': 'Beginning of buffer', 'end-of-buffer': 'End of buffer',
  'beginning-of-line': 'Beginning of line', 'end-of-line': 'End of line', 'buffer-read-only': 'Buffer is read-only',
  'search-failed': 'Search failed', 'scan-error': 'Unbalanced parentheses', quit: 'Quit', 'void-function': 'Not a command',
  'invalid-regexp': 'Invalid regexp', 'setting-constant': 'Attempt to set a constant',
};
function signal(kind, ...data) {
  if (kind === 'error' || kind === 'user-error') throw new SchemeError(kind, data.map(d => typeof d === 'string' ? d : write(d)).join(' '), []);
  const base = ERRMSG[kind] || kind;
  throw new SchemeError(kind, data.length ? base + ': ' + data.map(d => typeof d === 'string' ? d : write(d)).join(', ') : base, data);
}
const QUIET = intern(':quiet');
function quit(quiet) { throw new SchemeError('quit', 'Quit', quiet ? [QUIET] : []); }
const isQuit = e => e instanceof SchemeError && e.kind === 'quit';
const isQuietQuit = e => isQuit(e) && e.irritants[0] === QUIET;
S.hooks.isQuit = e => isQuit(e);

const truthy = x => x !== false && x !== undefined;
const absent = x => x === undefined || x === false;
function arr(x) { return x === false || x === undefined ? [] : arr0(x); }
function get(name) { const b = globals.get(name); return b ? b.value : undefined; }
function set(name, v) { gbox(name).value = v; return v; }
/* A global whose value is computed: reads call GET, writes call SET (or fail). */
function magic(name, getter, setter, doc) {
  const b = gbox(name);
  Object.defineProperty(b, 'value', { get: getter, set: setter || (() => { throw new SchemeError('setting-constant', `${name} cannot be set directly`); }), configurable: true });
  if (doc) S.gdoc.set(name, doc);
}
function defvar(name, value, doc) { const b = gbox(name); if (b.value === undefined) b.value = value; if (doc) S.gdoc.set(name, doc); }

/* Resolve a command designator (symbol or procedure) to a procedure, or throw. */
function toFn(x) {
  if (typeof x === 'function') return x;
  if (x instanceof Sym) { const v = get(x.name); if (typeof v === 'function') return v; if (v === undefined) signal('void-function', x.name); throw new SchemeError('wrong-type-argument', `${x.name} is not a procedure`, [v]); }
  if (x instanceof S.Param) return x;
  throw new SchemeError('wrong-type-argument', `Not a procedure: ${write(x)}`, [x]);
}
function fnOrNull(x) { try { return toFn(x); } catch (e) { return null; } }
function cmdSym(x) { if (x instanceof Sym) return x; if (typeof x === 'function' && x.procName) return intern(x.procName); return intern('anonymous-command'); }
function cmdName(x) { return x instanceof Sym ? x.name : typeof x === 'function' ? (x.procName || 'anonymous') : write(x); }
function isCommand(x) { const f = fnOrNull(x); return !!f && f.interactive !== undefined; }
function prop(x, name) { const f = fnOrNull(x); const v = f && f.props ? f.props.get(intern(name)) : undefined; return v === undefined ? false : v; }
function put(x, name, v) { const f = toFn(x); if (!f.props) f.props = new Map(); f.props.set(intern(name), v); return v; }
const call = (name, args) => callProc(toFn(intern(name)), args || []);
const apply = (f, args) => callProc(typeof f === 'function' ? f : toFn(f), args || []);

/* Step counting so a runaway loop stops instead of freezing the page. */
let budget = 0;
function resetOps() { budget = 0; S.watchdog.reset(); }

function runHook(name, ...args) {
  const h = get(name);
  if (h === undefined || h === false || h === NIL) return;
  const fs = typeof h === 'function' ? [h] : arr(h);
  for (const f of fs) apply(f, args);
}
function addHook(name, f, append) {
  const cur = arr(get(name) ?? NIL);
  if (cur.some(x => x === f)) return;
  set(name, listOf(append ? [...cur, f] : [f, ...cur]));
}
function removeHook(name, f) { set(name, listOf(arr(get(name) ?? NIL).filter(x => x !== f))); }

/* Characters: Scheme Char objects; accept numbers and one-character strings from older code. */
const chr = c => c instanceof Char ? String.fromCodePoint(c.code) : typeof c === 'number' ? String.fromCodePoint(c) : typeof c === 'string' ? c : null;
const code = c => c instanceof Char ? c.code : typeof c === 'number' ? c : typeof c === 'string' ? c.codePointAt(0) : null;
const mkchar = s => S.mkchar(typeof s === 'number' ? s : s.codePointAt(0));

/* Names for completion. */
function commandNames() { const out = []; for (const [n, b] of globals) if (typeof b.value === 'function' && b.value.interactive !== undefined) out.push(n); return out.sort(); }
function functionNames() { const out = []; for (const [n, b] of globals) if (typeof b.value === 'function' || S.macros.has(n)) out.push(n); return out.sort(); }
function variableNames() { const out = []; for (const [n, b] of globals) { let v; try { v = b.value; } catch (e) { continue; } if (v !== undefined && typeof v !== 'function') out.push(n); } return out.sort(); }

/* define: D for plain procedures, CMD for commands (spec: string, async function returning args, or ''). */
function D(name, args, doc, fn) { return S.def(name, fn, { args, doc }); }
function CMD(name, spec, args, doc, fn) { if (typeof spec === 'function') spec.jsSpec = true; return S.def(name, fn, { args, doc, interactive: spec }); }
function alias(a, b) { S.gdef(a, toFn(intern(b))); }

const pr = (x, readably) => readably ? write(x) : display(x);
function evalText(text) { let v = UNSPEC; for (const f of S.readAll(text)) v = S.evalForm(f); return v; }

g.L = {
  S, Sym, Pair, Char, SchemeError, NIL, UNSPEC, intern, listOf, arr, callProc, write, display, pr, signal, quit, isQuit, isQuietQuit, QUIET,
  truthy, absent, get, set, magic, defvar, toFn, fnOrNull, cmdSym, cmdName, isCommand, prop, put, call, apply, resetOps, runHook, addHook, removeHook,
  chr, code, mkchar, commandNames, functionNames, variableNames, D, CMD, alias, evalText, read: S.read, readAll: S.readAll, ev: S.evalForm,
  errorMessage: S.errorMessage, Escape: S.Escape, isList: S.isList, car: S.car, cdr: S.cdr, cons: S.cons, list: S.list, equal: S.equal,
};
}
runtimeModule(globalThis);
/* The module is a function so a worker can be built from its source (pool.js). */
globalThis.runtimeSource = '(' + runtimeModule.toString() + ')(self);';
})();
