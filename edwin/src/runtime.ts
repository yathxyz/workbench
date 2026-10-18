/* Runtime bridge: what the editor's JavaScript layers need from Scheme, in one place.
   Commands are Scheme procedures with an `interactive` property; keymaps hold symbols
   (resolved at dispatch time, so a redefinition takes effect at once) or procedures. */
(function () {
function runtimeModule(g: typeof globalThis) {
'use strict';
const S = g.Scheme;
const { Sym, Pair, Char, SchemeError, NIL, UNSPEC, intern, listOf, arr: arr0, callProc, write, display, gbox, globals } = S;

const ERRMSG: Record<string, string> = {
  'wrong-type-argument': 'Wrong type argument', 'wrong-number-of-arguments': 'Wrong number of arguments',
  'args-out-of-range': 'Args out of range', 'beginning-of-buffer': 'Beginning of buffer', 'end-of-buffer': 'End of buffer',
  'beginning-of-line': 'Beginning of line', 'end-of-line': 'End of line', 'buffer-read-only': 'Buffer is read-only',
  'search-failed': 'Search failed', 'scan-error': 'Unbalanced parentheses', quit: 'Quit', 'void-function': 'Not a command',
  'invalid-regexp': 'Invalid regexp', 'setting-constant': 'Attempt to set a constant',
};
function signal(kind: string, ...data: SchemeValue[]): never {
  if (kind === 'error' || kind === 'user-error') throw new SchemeError(kind, data.map(d => typeof d === 'string' ? d : write(d)).join(' '), []);
  const base = ERRMSG[kind] || kind;
  throw new SchemeError(kind, data.length ? base + ': ' + data.map(d => typeof d === 'string' ? d : write(d)).join(', ') : base, data);
}
const QUIET = intern(':quiet');
function quit(quiet?: boolean): never { throw new SchemeError('quit', 'Quit', quiet ? [QUIET] : []); }
const isQuit = (e: unknown): e is SchemeError => e instanceof SchemeError && e.kind === 'quit';
const isQuietQuit = (e: unknown) => isQuit(e) && e.irritants[0] === QUIET;
S.hooks.isQuit = e => isQuit(e);

const truthy = (x: SchemeValue) => x !== false && x !== undefined;
const absent = (x: SchemeValue): x is false | undefined => x === undefined || x === false;
function arr(x: SchemeValue) { return x === false || x === undefined ? [] : arr0(x); }
function get(name: string) { const b = globals.get(name); return b ? b.value : undefined; }
function set<T extends SchemeValue>(name: string, v: T) { gbox(name).value = v; return v; }
/* A global whose value is computed: reads call GET, writes call SET (or fail). */
function magic(name: string, getter: () => SchemeValue, setter?: ((v: SchemeValue) => void) | null, doc?: string) {
  const b = gbox(name);
  Object.defineProperty(b, 'value', { get: getter, set: setter || (() => { throw new SchemeError('setting-constant', `${name} cannot be set directly`); }), configurable: true });
  if (doc) S.gdoc.set(name, doc);
}
function defvar(name: string, value: SchemeValue, doc?: string) { const b = gbox(name); if (b.value === undefined) b.value = value; if (doc) S.gdoc.set(name, doc); }

/* Resolve a command designator (symbol or procedure) to a procedure, or throw. */
function toFn(x: SchemeValue): SchemeProcedure {
  if (typeof x === 'function') return x as SchemeProcedure;
  if (x instanceof Sym) { const v = get(x.name); if (typeof v === 'function') return v as SchemeProcedure; if (v === undefined) signal('void-function', x.name); throw new SchemeError('wrong-type-argument', `${x.name} is not a procedure`, [v]); }
  if (x instanceof S.Param) return x as unknown as SchemeProcedure;
  throw new SchemeError('wrong-type-argument', `Not a procedure: ${write(x)}`, [x]);
}
function fnOrNull(x: SchemeValue) { try { return toFn(x); } catch (e) { return null; } }
function cmdSym(x: SchemeValue) { if (x instanceof Sym) return x; if (typeof x === 'function' && (x as SchemeProcedure).procName) return intern((x as SchemeProcedure).procName!); return intern('anonymous-command'); }
function cmdName(x: SchemeValue) { return x instanceof Sym ? x.name : typeof x === 'function' ? ((x as SchemeProcedure).procName || 'anonymous') : write(x); }
function isCommand(x: SchemeValue) { const f = fnOrNull(x); return !!f && f.interactive !== undefined; }
function prop(x: SchemeValue, name: string) { const f = fnOrNull(x); const v = f && f.props ? f.props.get(intern(name)) : undefined; return v === undefined ? false : v; }
function put<T extends SchemeValue>(x: SchemeValue, name: string, v: T) { const f = toFn(x); if (!f.props) f.props = new Map(); f.props.set(intern(name), v); return v; }
const call = (name: string, args?: SchemeValue[]) => callProc(toFn(intern(name)), args || []);
const apply = (f: SchemeValue, args?: SchemeValue[]) => callProc(typeof f === 'function' ? f : toFn(f), args || []);

/* Step counting so a runaway loop stops instead of freezing the page. */
let budget = 0;
function resetOps() { budget = 0; S.watchdog.reset(); }

/* A hook's value is a procedure or a list of them. In a buffer-local hook value, #t stands for the
   hook's default value, as t does in Emacs (add-hook! with LOCAL puts it there). */
const hooking = { defaultValue: get };
function hookFns(name: string) {
  const h = get(name);
  if (h === undefined || h === false || h === NIL) return [];
  if (typeof h === 'function') return [h];
  const out: SchemeValue[] = [];
  for (const f of arr(h)) {
    if (f !== true) { out.push(f); continue; }
    const g = hooking.defaultValue(name);
    if (g === h || g === undefined || g === false || g === NIL) continue;
    for (const x of typeof g === 'function' ? [g] : arr(g)) if (x !== true) out.push(x);
  }
  return out;
}
function runHook(name: string, ...args: SchemeValue[]) { for (const f of hookFns(name)) apply(f, args); }
function addHook(name: string, f: SchemeValue, append?: boolean) {
  const cur = arr(get(name) ?? NIL);
  if (cur.some(x => x === f)) return;
  set(name, listOf(append ? [...cur, f] : [f, ...cur]));
}
function removeHook(name: string, f: SchemeValue) { set(name, listOf(arr(get(name) ?? NIL).filter(x => x !== f))); }

/* Characters: Scheme Char objects; accept numbers and one-character strings from older code. */
const chr = (c: SchemeValue) => c instanceof Char ? String.fromCodePoint(c.code) : typeof c === 'number' ? String.fromCodePoint(c) : typeof c === 'string' ? c : null;
const code = (c: SchemeValue) => c instanceof Char ? c.code : typeof c === 'number' ? c : typeof c === 'string' ? c.codePointAt(0) : null;
const mkchar = (s: string | number) => S.mkchar(typeof s === 'number' ? s : s.codePointAt(0)!);

/* Names for completion. */
function commandNames() { const out: string[] = []; for (const [n, b] of globals) if (typeof b.value === 'function' && (b.value as SchemeProcedure).interactive !== undefined) out.push(n); return out.sort(); }
function functionNames() { const out: string[] = []; for (const [n, b] of globals) if (typeof b.value === 'function' || S.macros.has(n)) out.push(n); return out.sort(); }
function variableNames() { const out: string[] = []; for (const [n, b] of globals) { let v; try { v = b.value; } catch (e) { continue; } if (v !== undefined && typeof v !== 'function') out.push(n); } return out.sort(); }

/* define: D for plain procedures, CMD for commands (spec: string, async function returning args, or ''). */
function D<F extends Function>(name: string, args: string, doc: string, fn: F) { return S.def(name, fn as F & SchemeProcedure, { args, doc }); }
function CMD<F extends Function>(name: string, spec: string | ((...args: unknown[]) => unknown), args: string, doc: string, fn: F) { if (typeof spec === 'function') (spec as typeof spec & { jsSpec?: boolean }).jsSpec = true; return S.def(name, fn as F & SchemeProcedure, { args, doc, interactive: spec }); }
function alias(a: string, b: string) { S.gdef(a, toFn(intern(b))); }

const pr = (x: SchemeValue, readably?: boolean) => readably ? write(x) : display(x);
function evalText(text: string) { let v: SchemeValue = UNSPEC; for (const f of S.readAll(text)) v = S.evalForm(f); return v; }

g.L = {
  S, Sym, Pair, Char, SchemeError, NIL, UNSPEC, intern, listOf, arr, callProc, write, display, pr, signal, quit, isQuit, isQuietQuit, QUIET,
  truthy, absent, get, set, magic, defvar, toFn, fnOrNull, cmdSym, cmdName, isCommand, prop, put, call, apply, resetOps, runHook, hookFns, hooking, addHook, removeHook,
  chr, code, mkchar, commandNames, functionNames, variableNames, D, CMD, alias, evalText, read: S.read, readAll: S.readAll, ev: S.evalForm,
  errorMessage: S.errorMessage, Escape: S.Escape, isList: S.isList, car: S.car, cdr: S.cdr, cons: S.cons, list: S.list, equal: S.equal,
};
}
runtimeModule(globalThis);
/* The module is a function so a worker can be built from its source (pool.js). */
globalThis.runtimeSource = '(' + runtimeModule.toString() + ')(self);';
})();
