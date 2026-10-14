/* Edwin Scheme — the extension language of the editor.
   A Lisp-1 with lexical scope and closures, proper tail calls, parameters for dynamic
   binding, define-syntax/syntax-rules (introduced identifiers are renamed, so temporaries
   never capture user variables), define-macro, escape continuations, dynamic-wind, guard,
   records, vectors, hash tables and chars. Expressions are compiled once into JS closures
   with lexical addressing, then run.
   Numbers are JS doubles; an exact integer result outside ±2^53 becomes a BigInt (and comes back
   to a double when it fits again). Textual ports (R7RS), first-class environments, source
   locations on every pair read, a condition-type hierarchy with handlers that run before
   unwinding (R7RS with-exception-handler), restarts, and a shadow stack of active procedure
   calls for backtraces. Everything lives inside schemeModule so a worker can be built from
   its source (pool.js). */
(function () {
function schemeModule(g) {
'use strict';
/* Read once at load: false compiles the shadow stack out (scheme-bench.mjs measures its cost). */
const SHADOW = g.SCHEME_SHADOW_STACK !== false;
/* Generator mode (R4.38): set at load with g.SCHEME_MODE = 'gen', or later with Scheme.setMode. */
let GEN = g.SCHEME_MODE === 'gen';

/* ---------- data ---------- */
class Sym { constructor(name) { this.name = name; } toString() { return this.name; } }
class Alias { constructor(sym, scope, id) { this.sym = sym; this.scope = scope; this.id = id; this.name = sym.name; } }
class Pair { constructor(car, cdr) { this.car = car; this.cdr = cdr; } }
class Char { constructor(code) { this.code = code; } }
class Nil { toString() { return '()'; } }
class Unspecified { toString() { return '#<unspecified>'; } }
class Eof { toString() { return '#<eof>'; } }
class Values { constructor(vals) { this.vals = vals; } }
class Param {
  constructor(value, converter, name) { this.value = value; this.converter = converter || null; this.name = name || null; }
}
class Record { constructor(type, fields) { this.type = type; this.fields = fields; } }
class RecordType { constructor(name, fieldNames) { this.name = name; this.fieldNames = fieldNames; this.printer = null; } }
class Box { constructor(name, value) { this.name = name; this.value = value; } }
/* LOC: where the tail call is (by default the call site in progress), for the shadow stack. */
class TailCall { constructor(f, args, loc) { this.f = f; this.args = args; this.loc = loc === undefined ? site : loc; } }
/* A first-class environment: a compile-time scope and the runtime frame that matches it.
   The global environment has neither. */
class Environment { constructor(scope, frame) { this.scope = scope; this.frame = frame; } }
const GLOBAL_ENV = new Environment(null, null);
/* A textual port. Output ports send text to SINK (a function) or collect it in CHUNKS; input
   ports read TEXT from POS. */
class Port {
  constructor(name, input, output) { this.name = name || null; this.input = input; this.output = output; this.open = true; this.sink = null; this.chunks = null; this.text = ''; this.pos = 0; this.file = null; this.last = 10; }
  put(s) {
    if (!this.open) throw new SchemeError('wrong-type-argument', 'Port is closed: ' + write(this), [this]);
    if (!s) return;
    if (this.sink) this.sink(s); else this.chunks.push(s);
    this.last = s.charCodeAt(s.length - 1);
  }
  string() { const s = this.chunks.join(''); this.chunks = s ? [s] : []; return s; }
}
function makeOutputPort(fn, name) { const p = new Port(name || 'output', false, true); p.sink = fn; return p; }
function makeStringOutputPort() { const p = new Port('string', false, true); p.chunks = []; return p; }
function makeStringInputPort(text, name) { const p = new Port(name || 'string', true, false); p.text = text; return p; }
/* A restart: NAME (a symbol or #f), REPORT (string or procedure of a port), INTERACTIVE (a procedure
   returning the argument list, or #f) and FN, called with the arguments after unwinding to the
   point that established it (TAG). JS is true when FN is a JS function. */
class Restart { constructor(name, report, interactive, fn, tag, js) { this.name = name || false; this.report = report || false; this.interactive = interactive || false; this.fn = fn; this.tag = tag; this.js = !!js; } }
/* Unwinding to a guard or a restart: not an Error, so nothing but its target catches it. */
class Unwind { constructor(tag, a, b) { this.tag = tag; this.a = a; this.b = b; } }
/* A condition type: conditions are SchemeErrors whose KIND names one. */
class ConditionType {
  constructor(name, parent, reporter) { this.name = name; this.parent = parent || null; this.reporter = reporter || null; }
  isa(name) { for (let t = this; t; t = t.parent) if (t.name === name) return true; return false; }
}
/* One entry of a backtrace. */
class StackFrame { constructor(proc, frame, loc) { this.proc = proc; this.frame = frame; this.loc = loc; } }
/* Where a pair was read: the text it came from and an offset; line (from 1) and column (from 0)
   are computed when first asked for. */
class SrcInfo { constructor(file, text) { this.file = file; this.text = text; this.starts = null; } }
class SrcLoc {
  constructor(info, off) { this.info = info; this.off = off; this.lc = null; }
  get file() { return this.info.file; }
  get line() { return this.where()[0]; }
  get col() { return this.where()[1]; }
  where() {
    if (this.lc) return this.lc;
    const info = this.info;
    if (!info.starts) { const st = [0], t = info.text; for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) st.push(i + 1); info.starts = st; }
    const st = info.starts; let lo = 0, hi = st.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (st[m] <= this.off) lo = m; else hi = m - 1; }
    return (this.lc = [lo + 1, this.off - st[lo]]);
  }
  plain() { return { file: this.file, line: this.line, col: this.col }; }
}
const locs = new WeakMap();          // pair -> SrcLoc
/* A hash table whose object keys are held weakly (a WeakMap); other keys (numbers, strings,
   booleans) are held strongly in the Map itself. Iteration (keys, ->alist, walk, count) yields the
   strong entries, then the weak entries whose keys are still alive, so an entry can vanish between
   two walks once nothing else refers to its key. */
const canWeak = typeof WeakRef === 'function';
const isObjKey = k => (typeof k === 'object' && k !== null) || typeof k === 'function';
class WeakTable extends Map {
  constructor() { super(); this.wm = new WeakMap(); this.refs = new Set(); this.reg = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry(r => this.refs.delete(r)) : null; }
  get(k) { if (isObjKey(k)) { const e = this.wm.get(k); return e ? e.v : undefined; } return super.get(k); }
  has(k) { return isObjKey(k) ? this.wm.has(k) : super.has(k); }
  set(k, v) {
    if (!isObjKey(k)) return super.set(k, v);
    const e = this.wm.get(k);
    if (e) e.v = v;
    else { const ref = canWeak ? new WeakRef(k) : { deref: () => k }; this.wm.set(k, { v, ref }); this.refs.add(ref); if (this.reg) this.reg.register(k, ref, ref); }
    return this;
  }
  delete(k) {
    if (!isObjKey(k)) return super.delete(k);
    const e = this.wm.get(k); if (!e) return false;
    this.wm.delete(k); this.refs.delete(e.ref); if (this.reg) this.reg.unregister(e.ref); return true;
  }
  clear() { super.clear(); for (const r of this.refs) if (this.reg) this.reg.unregister(r); this.wm = new WeakMap(); this.refs.clear(); }
  get size() { let n = super.size; for (const r of this.refs) { const k = r.deref(); if (k !== undefined && this.wm.has(k)) n++; } return n; }
  *entries() { yield* super.entries(); for (const r of [...this.refs]) { const k = r.deref(); if (k === undefined) { this.refs.delete(r); continue; } const e = this.wm.get(k); if (e) yield [k, e.v]; } }
  *keys() { for (const [k] of this.entries()) yield k; }
  *values() { for (const [, v] of this.entries()) yield v; }
  [Symbol.iterator]() { return this.entries(); }
  forEach(f, self) { for (const [k, v] of this.entries()) f.call(self, v, k, this); }
}

const NIL = new Nil(), UNSPEC = new Unspecified(), EOF = new Eof();
const MAXS = Number.MAX_SAFE_INTEGER;
const obarray = new Map();
function intern(name) { let s = obarray.get(name); if (!s) { s = new Sym(name); obarray.set(name, s); } return s; }
let gensymCounter = 0;
function gensym(base) { return new Sym((base || 'g') + '%' + (++gensymCounter)); }
const S = {};
for (const n of ['quote', 'quasiquote', 'unquote', 'unquote-splicing', 'lambda', 'define', 'set!', 'if', 'begin', 'let', 'let*', 'letrec',
  'letrec*', 'cond', 'case', 'and', 'or', 'when', 'unless', 'do', 'else', '=>', '...', '_', 'define-syntax', 'syntax-rules', 'define-macro',
  'parameterize', 'guard', 'define-record-type', 'let-values', 'receive', 'assert', 'delay', 'case-lambda', 'named-lambda', 'define-values',
  'let-syntax', 'letrec-syntax', 'include', 'the-environment', 'while', 'dolist', 'dotimes'])
  S[n] = intern(n);
const isKeyword = s => s instanceof Sym && s.name.length > 1 && s.name[0] === ':';
const chars = new Map();
function mkchar(code) { let c = chars.get(code); if (!c) { c = new Char(code); chars.set(code, c); } return c; }

/* ---------- lists ---------- */
function cons(a, b) { return new Pair(a, b); }
function list(...xs) { let r = NIL; for (let i = xs.length - 1; i >= 0; i--) r = new Pair(xs[i], r); return r; }
function listOf(arr, tail) { let r = tail === undefined ? NIL : tail; for (let i = arr.length - 1; i >= 0; i--) r = new Pair(arr[i], r); return r; }
function arr(x) { const out = []; while (x instanceof Pair) { out.push(x.car); x = x.cdr; } if (x !== NIL) throw new SchemeError('wrong-type-argument', 'Expected a proper list', x); return out; }
function isList(x) { while (x instanceof Pair) x = x.cdr; return x === NIL; }
const car = x => { if (!(x instanceof Pair)) throw typeErr('pair', x, 'car'); return x.car; };
const cdr = x => { if (!(x instanceof Pair)) throw typeErr('pair', x, 'cdr'); return x.cdr; };
const truthy = x => x !== false;

/* ---------- errors ---------- */
class SchemeError extends Error {
  constructor(kind, message, irritants, payload) { super(message); this.kind = kind; this.irritants = irritants === undefined ? [] : (Array.isArray(irritants) ? irritants : [irritants]); this.payload = payload; }
}
class Raise extends Error { constructor(obj, continuable) { super('raised'); this.obj = obj; this.continuable = continuable; } }
class Escape { constructor(tag, vals) { this.tag = tag; this.vals = vals; } }
function typeErr(expected, got, who) { return new SchemeError('wrong-type-argument', `${who ? who + ': ' : ''}expected ${expected}, got ${write(got)}`, [got]); }
function err(msg, ...irritants) { return new SchemeError('error', msg, irritants); }
function errorMessage(e) {
  if (e instanceof SchemeError) {
    const t = ctypes.get(e.kind), r = t ? reporterOf(t) : null;
    if (r) { try { return reportWith(r, e); } catch (x) { /* fall back to the plain report */ } }
    return e.message + (e.kind === 'error' && e.irritants.length ? ' ' + e.irritants.map(x => write(x)).join(' ') : '');
  }
  if (e instanceof Raise) return 'Uncaught exception: ' + write(e.obj);
  if (e instanceof RangeError) return 'Stack overflow';
  return e && e.message ? e.message : String(e);
}

/* ---------- condition types ---------- */
/* Every SchemeError is a condition whose type is named by its kind. quit and scheme-interrupt are
   not errors (as in Emacs); a kind nobody declared is a child of error. */
const ctypes = new Map();
function conditionType(kind) {
  if (kind instanceof ConditionType) return kind;
  const name = kind instanceof Sym ? kind.name : String(kind);
  let t = ctypes.get(name);
  if (!t) { t = new ConditionType(name, name === 'error' ? null : conditionType('error'), null); ctypes.set(name, t); }
  return t;
}
function defineConditionType(name, parent, reporter) {
  name = name instanceof Sym ? name.name : String(name);
  const p = parent === null || parent === false || parent === undefined ? null : conditionType(parent);
  for (let q = p; q; q = q.parent) if (q.name === name) throw new SchemeError('error', 'define-condition-type: ' + name + ' cannot be its own ancestor', []);
  let t = ctypes.get(name);
  if (t) { t.parent = p; t.reporter = reporter || null; } else { t = new ConditionType(name, p, reporter); ctypes.set(name, t); }
  return t;
}
const reporterOf = t => { for (let c = t; c; c = c.parent) if (c.reporter) return c.reporter; return null; };
function reportWith(r, c) { if (typeof r === 'string') return r; const p = makeStringOutputPort(); callProc(r, [c, p]); return p.string(); }
function conditionIs(e, kind) { return e instanceof SchemeError && conditionType(e.kind).isa(kind instanceof Sym ? kind.name : kind); }
const isErrorCondition = e => e instanceof SchemeError && conditionType(e.kind).isa('error');
defineConditionType('error', null); defineConditionType('quit', null); defineConditionType('scheme-interrupt', null);
for (const k of ['user-error', 'wrong-type-argument', 'unbound-variable', 'range-error', 'file-error', 'server-only', 'edit-conflict', 'timeout',
  'http-error', 'wrong-number-of-arguments', 'divide-by-zero', 'syntax-error', 'read-error', 'assertion-failed', 'recursion-depth', 'control-error',
  'buffer-read-only', 'search-failed', 'beginning-of-buffer', 'end-of-buffer', 'beginning-of-line', 'end-of-line', 'scan-error', 'void-function',
  'invalid-regexp', 'setting-constant', 'ship-error', 'job-error', 'no-worker', 'thread-died', 'thread-cancelled']) defineConditionType(k, 'error');
defineConditionType('cannot-block', 'control-error'); defineConditionType('args-out-of-range', 'range-error'); defineConditionType('end-of-file', 'read-error'); defineConditionType('thread-timeout', 'timeout');

/* ---------- signalling: handlers run before unwinding ---------- */
/* HANDLERS is the dynamic stack of exception handlers, innermost first: { h, js, next }. A Scheme
   handler (js false) is called with the condition; a JS handler with (condition, continuable) and
   may return DECLINE to pass it on. A handler runs where the condition was raised, with the outer
   handlers installed; returning from one for raise is an error, for raise-continuable it resumes.
   Errors a JS primitive throws are routed here by the innermost Scheme call site that sees them
   while a handler is installed (the try/catch is only paid then); `signalled` marks a condition
   every handler has seen, so outer call sites let it pass (the mark is cleared once it is past
   every handler). Quit and scheme-interrupt conditions reach only JS handlers. */
const DECLINE = { toString() { return '#<decline>'; } };
let handlers = null;
let restarts = null;                 // innermost first: { r: Restart, next }
const isPassive = o => (hooks.isQuit && hooks.isQuit(o)) || (o instanceof SchemeError && (o.kind === 'scheme-interrupt' || o.kind === 'quit'));
function signal(obj, continuable) {
  const top = handlers;
  if (obj instanceof SchemeError) { obj.signalled = true; if (top !== null && obj.shadow === undefined) obj.shadow = snapshot(); }
  if (top !== null) {
    const passive = isPassive(obj);
    try {
      for (let n = top; n !== null; n = n.next) {
        if (passive && !n.js) continue;
        handlers = n.next;
        let v;
        try { v = n.js ? n.h(obj, continuable) : callProc(n.h, [obj]); }
        catch (e) { if (e instanceof SchemeError || e instanceof Raise) e.signalled = true; throw e; }
        if (n.js && v === DECLINE) continue;
        if (continuable) return v;
        signal(new SchemeError('error', 'Exception handler returned from a non-continuable raise of ' + (obj instanceof SchemeError ? errorMessage(obj) : write(obj)), [obj]), false);
      }
    } finally { handlers = top; }
  }
  if (obj instanceof SchemeError) throw obj;
  const r = new Raise(obj, continuable); r.signalled = true; r.shadow = top !== null ? snapshot() : undefined;
  throw r;
}
/* Install the JS handler H(condition, continuable) -> value or DECLINE around THUNK (a JS function). */
function withHandler(h, thunk) {
  const saved = handlers;
  handlers = { h, js: true, next: saved };
  try { return thunk(); } finally { handlers = saved; }
}

/* ---------- restarts ---------- */
/* Restarts are established for the dynamic extent of a thunk and invoked by throwing an Unwind to
   the establishing point, which then calls the restart's procedure with the arguments. Handlers
   run before unwinding, so they see every restart established between them and the raise. */
function establish(rs, tag, run, tailOk) {
  const saved = restarts, s = sp;
  let chain = saved;
  for (let i = rs.length - 1; i >= 0; i--) chain = { r: rs[i], next: chain };
  restarts = chain;
  try { return run(); }
  catch (e) {
    if (!(e instanceof Unwind) || e.tag !== tag) throw e;
    sp = s; restarts = saved;
    const r = e.a;
    if (r.js) return r.fn(...e.b);
    return tailOk ? new TailCall(r.fn, e.b) : callProc(r.fn, e.b);
  } finally { restarts = saved; }
}
const restartName = x => x instanceof Sym ? x : typeof x === 'string' ? intern(x) : false;
function withRestarts(specs, thunk) {
  const tag = {};
  return establish(specs.map(s => s instanceof Restart ? s : new Restart(restartName(s.name), s.report, s.interactive, s.fn, tag, true)), tag, thunk, false);
}
function computeRestarts() { const out = []; for (let n = restarts; n; n = n.next) out.push(n.r); return out; }
function findRestart(x) {
  if (x instanceof Restart) { for (let n = restarts; n; n = n.next) if (n.r === x) return x; return null; }
  const name = restartName(x);
  for (let n = restarts; n; n = n.next) if (n.r.name === name) return n.r;
  return null;
}
function invokeRestart(x, args) {
  const r = findRestart(x);
  if (!r) throw new SchemeError('control-error', x instanceof Restart ? 'Restart is not active: ' + write(x) : 'No restart named ' + write(x) + ' is active', [x]);
  throw new Unwind(r.tag, r, args || []);
}
function restartArgs(r) {
  if (r.interactive) return r.js ? r.interactive(r) : arr(callProc(r.interactive, []));
  if (hooks.restartArgs) return hooks.restartArgs(r) || [];
  return [];
}
function restartReport(r) {
  if (typeof r.report === 'string') return r.report;
  if (typeof r.report === 'function') { if (r.js) return String(r.report(r)); const p = makeStringOutputPort(); callProc(r.report, [p]); return p.string(); }
  return r.name ? r.name.name : 'anonymous restart';
}
const USE_VALUE = intern('use-value'), STORE_VALUE = intern('store-value');
/* An unbound variable offers use-value (a value for this reference) and store-value (define the
   variable and go on), here at the reference. */
function unboundRef(box, name) {
  const tag = {};
  siteProc = null;
  const need = v => { if (v === undefined) throw new SchemeError('wrong-number-of-arguments', name + ': the restart needs a value', []); return v; };
  return establish([
    new Restart(USE_VALUE, `Specify a value to use instead of ${name}.`, null, v => need(v), tag, true),
    new Restart(STORE_VALUE, `Define ${name} to a given value.`, null, v => { box.value = need(v); return v; }, tag, true),
  ], tag, () => signal(new SchemeError('unbound-variable', `Unbound variable: ${name}`, [intern(name)]), false), false);
}
function unboundSet(box, name, v) {
  const tag = {};
  siteProc = null;
  const store = x => { box.value = x === undefined ? v : x; return UNSPEC; };
  return establish([
    new Restart(USE_VALUE, `Define ${name} to a given value (or the one being assigned) and go on.`, null, store, tag, true),
    new Restart(STORE_VALUE, `Define ${name} to a given value (or the one being assigned) and go on.`, null, store, tag, true),
  ], tag, () => signal(new SchemeError('unbound-variable', `Unbound variable: ${name}`, [intern(name)]), false), false);
}

/* ---------- reader ---------- */
const DELIM = /[\s()\[\]"';`,]/;
const NAMED_CHARS = { space: 32, newline: 10, tab: 9, nul: 0, null: 0, return: 13, escape: 27, esc: 27, delete: 127, del: 127, backspace: 8, alarm: 7, linefeed: 10, altmode: 27, rubout: 127 };
/* OPTS: { file } or a file name; every pair read gets a source location (locs). */
function reader(src, opts) {
  let i = 0;
  const file = typeof opts === 'string' ? opts : opts && opts.file !== undefined ? opts.file : null;
  const info = new SrcInfo(file, src);
  const mark = (p, off) => { locs.set(p, new SrcLoc(info, off)); return p; };
  const peek = () => src[i];
  function skip() {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] === ';') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (src[i] === '#' && src[i + 1] === '|') { let d = 1; i += 2; while (i < src.length && d) { if (src[i] === '|' && src[i + 1] === '#') { d--; i += 2; } else if (src[i] === '#' && src[i + 1] === '|') { d++; i += 2; } else i++; } continue; }
      if (src[i] === '#' && src[i + 1] === ';') { i += 2; form(); continue; }
      return;
    }
  }
  function eof() { throw new SchemeError('end-of-file', 'Unexpected end of input'); }
  function readString() {
    i++; let s = '';
    while (i < src.length && src[i] !== '"') {
      if (src[i] === '\\') {
        i++; const e = src[i++];
        if (e === 'n') s += '\n'; else if (e === 't') s += '\t'; else if (e === 'r') s += '\r'; else if (e === 'e') s += '\x1b'; else if (e === 'a') s += '\x07';
        else if (e === '0') s += '\0';
        else if (e === 'x') { let j = i; while (j < src.length && src[j] !== ';' && /[0-9a-fA-F]/.test(src[j])) j++; s += String.fromCodePoint(parseInt(src.slice(i, j), 16)); i = src[j] === ';' ? j + 1 : j; }
        else if (e === '\n') { while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++; }
        else s += e;
      } else s += src[i++];
    }
    if (i >= src.length) eof();
    i++; return s;
  }
  function readChar() {
    i += 2;
    let j = i; while (j < src.length && !DELIM.test(src[j])) j++;
    if (j === i) { const cp = src.codePointAt(i); i += cp > 0xffff ? 2 : 1; return mkchar(cp); }
    const tok = src.slice(i, j);
    if ([...tok].length === 1) { i = j; return mkchar(tok.codePointAt(0)); }
    if (tok[0] === 'x' && /^x[0-9a-fA-F]+$/.test(tok)) { i = j; return mkchar(parseInt(tok.slice(1), 16)); }
    const lc = tok.toLowerCase();
    if (NAMED_CHARS[lc] !== undefined) { i = j; return mkchar(NAMED_CHARS[lc]); }
    const cp = src.codePointAt(i); i += cp > 0xffff ? 2 : 1; return mkchar(cp);
  }
  function located(items, offs, start, tail) {
    const l = listOf(items, tail);
    let p = l;
    for (let k = 0; p instanceof Pair && k < items.length; k++, p = p.cdr) mark(p, k === 0 ? start : offs[k]);
    return l;
  }
  function readList(close) {
    const start = i;
    i++; const items = [], offs = [];
    for (;;) {
      skip();
      if (i >= src.length) eof();
      if (src[i] === close) { i++; return located(items, offs, start, NIL); }
      if (src[i] === ')' || src[i] === ']') throw new SchemeError('read-error', `Unexpected ${src[i]}`);
      if (src[i] === '.' && (i + 1 >= src.length || DELIM.test(src[i + 1])) && items.length) {
        i++; const tail = form(); skip();
        if (src[i] !== close) throw new SchemeError('read-error', 'Bad dotted list');
        i++; return located(items, offs, start, tail);
      }
      offs.push(i);
      items.push(form());
    }
  }
  function quoted(head, at) { skip(); const off = i, x = form(); const p = new Pair(head, new Pair(x, NIL)); mark(p.cdr, off); return mark(p, at); }
  function form() {
    skip();
    if (i >= src.length) eof();
    const c = src[i];
    if (c === '(') return readList(')');
    if (c === '[') return readList(']');
    if (c === ')' || c === ']') { i++; throw new SchemeError('read-error', `Unexpected ${c}`); }
    if (c === "'") { i++; return quoted(S.quote, i - 1); }
    if (c === '`') { i++; return quoted(S.quasiquote, i - 1); }
    if (c === ',') { i++; if (src[i] === '@') { i++; return quoted(S['unquote-splicing'], i - 2); } return quoted(S.unquote, i - 1); }
    if (c === '"') return readString();
    if (c === '#') {
      const d = src[i + 1];
      if (d === '(') { i++; return arr(readList(')')); }
      if (d === '\\') return readChar();
      if (d === 't' || d === 'f') { let j = i + 1; while (j < src.length && !DELIM.test(src[j])) j++; const tok = src.slice(i + 1, j); i = j; if (tok === 't' || tok === 'true') return true; if (tok === 'f' || tok === 'false') return false; throw new SchemeError('read-error', 'Bad # syntax: #' + tok); }
      if (d === ':') { i += 2; let j = i; while (j < src.length && !DELIM.test(src[j])) j++; const name = src.slice(i, j); i = j; return intern(':' + name); }
      if (d === 'x' || d === 'b' || d === 'o' || d === 'd' || d === 'e' || d === 'i') {
        let j = i + 2; while (j < src.length && !DELIM.test(src[j])) j++;
        const tok = src.slice(i + 2, j); i = j;
        const n = d === 'x' || d === 'b' || d === 'o' ? parseRadix(tok, d === 'x' ? 16 : d === 'b' ? 2 : 8) : d === 'i' ? (v => v === false ? false : inexact(v))(parseNumber(tok)) : parseNumber(tok);
        if (n === false) throw new SchemeError('read-error', 'Bad number: #' + d + tok);
        return d === 'e' ? exactOf(n) : n;
      }
      if (d === '!') { let j = i; while (j < src.length && !DELIM.test(src[j])) j++; const tok = src.slice(i + 2, j); i = j; if (tok === 'eof') return EOF; if (tok === 'unspecific' || tok === 'void') return UNSPEC; if (tok === 'default' || tok === 'optional' || tok === 'rest' || tok === 'key') return intern('#!' + tok); return form(); }
      throw new SchemeError('read-error', 'Bad # syntax');
    }
    let j = i;
    if (src[i] === '|') { j = src.indexOf('|', i + 1); if (j < 0) eof(); const name = src.slice(i + 1, j); i = j + 1; return intern(name); }
    while (j < src.length && !DELIM.test(src[j])) j++;
    const tok = src.slice(i, j); i = j;
    if (/^[+-]?\d+$/.test(tok)) { const n = Number(tok); return n <= MAXS && n >= -MAXS ? n : BigInt(tok); }
    if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(tok)) return Number(tok);
    if (/^[+-]?\d+\/\d+$/.test(tok)) { const [a, b] = tok.split('/'); return Number(a) / Number(b); }
    if (tok === '+inf.0') return Infinity; if (tok === '-inf.0') return -Infinity; if (tok === '+nan.0') return NaN;
    if (tok.length > 1 && tok[tok.length - 1] === ':' && tok[0] !== ':') return intern(':' + tok.slice(0, -1));
    return intern(tok);
  }
  return { form, get done() { skip(); return i >= src.length; }, get pos() { return i; }, set pos(v) { i = v; } };
}
function read(src) { return reader(src).form(); }
function readAll(src, file) { const r = reader(src, file), out = []; while (!r.done) out.push(r.form()); return out; }
/* The source location of a pair read or a procedure's lambda form: { file, line, col } or null. */
function sourceLocation(x) {
  const l = typeof x === 'function' ? x.loc : x instanceof SrcLoc ? x : x && typeof x === 'object' ? locs.get(x) : null;
  return l ? l.plain() : null;
}

/* ---------- printer ---------- */
const CHAR_NAMES = { 32: 'space', 10: 'newline', 9: 'tab', 0: 'nul', 13: 'return', 27: 'escape', 127: 'delete', 8: 'backspace', 7: 'alarm' };
function writeString(s) { return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"'; }
function write(x, display) {
  if (x === true) return '#t'; if (x === false) return '#f';
  if (x === NIL) return '()';
  if (x === undefined) return '#<undefined>';
  if (x === null) return '#<null>';
  if (x instanceof Sym) return display || !/[\s()"';|]/.test(x.name) || x.name === '' ? (x.name === '' ? '||' : x.name) : '|' + x.name + '|';
  if (x instanceof Alias) return x.sym.name;
  if (typeof x === 'number') return writeNumber(x);
  if (typeof x === 'bigint') return x.toString();
  if (typeof x === 'string') return display ? x : writeString(x);
  if (x instanceof Char) return display ? String.fromCodePoint(x.code) : '#\\' + (CHAR_NAMES[x.code] || (x.code < 32 ? 'x' + x.code.toString(16) : String.fromCodePoint(x.code)));
  if (x instanceof Pair) {
    if (x.car instanceof Sym && x.cdr instanceof Pair && x.cdr.cdr === NIL) {
      const q = { quote: "'", quasiquote: '`', unquote: ',', 'unquote-splicing': ',@' }[x.car.name];
      if (q) return q + write(x.cdr.car, display);
    }
    const parts = []; let c = x, n = 0;
    while (c instanceof Pair) { parts.push(write(c.car, display)); c = c.cdr; if (++n > 100000) { parts.push('…'); break; } }
    if (c !== NIL) parts.push('.', write(c, display));
    return '(' + parts.join(' ') + ')';
  }
  if (Array.isArray(x)) return '#(' + x.map(e => write(e, display)).join(' ') + ')';
  if (typeof x === 'function') return '#<procedure' + (x.procName ? ' ' + x.procName : '') + '>';
  if (x instanceof Param) return '#<parameter' + (x.name ? ' ' + x.name : '') + '>';
  if (x instanceof WeakTable) return '#<weak-hash-table ' + x.size + '>';
  if (x instanceof Map) return '#<hash-table ' + x.size + '>';
  if (x instanceof Record) return writeRecord(x);
  if (x instanceof RecordType) return '#<record-type ' + x.name + '>';
  if (x instanceof Values) return x.vals.map(v => write(v, display)).join(' ');
  if (x instanceof Unspecified || x instanceof Eof || x instanceof Nil) return x.toString();
  if (x && typeof x.__print === 'function') return x.__print();
  if (x instanceof SchemeError) return '#<error ' + writeString(x.message) + '>';
  if (x instanceof Port) return '#<' + (x.input ? 'input-' : '') + (x.output ? 'output-' : '') + 'port' + (x.name ? ' ' + x.name : '') + ' ' + objectHash(x) + '>';
  if (x instanceof Environment) return x === GLOBAL_ENV ? '#<environment system-global-environment>' : '#<environment ' + objectHash(x) + '>';
  if (x instanceof ConditionType) return '#<condition-type ' + x.name + '>';
  if (x instanceof Restart) return '#<restart ' + (x.name ? x.name.name : 'anonymous') + ' ' + objectHash(x) + '>';
  if (x instanceof StackFrame) { const l = x.loc; return '#<stack-frame ' + (x.proc && x.proc.procName || 'anonymous') + (l ? ' ' + (l.file || '') + ':' + l.line + ':' + l.col : '') + '>'; }
  if (x instanceof Error) return '#<js-error ' + writeString(String(x.message)) + '>';
  if (typeof x === 'object') { const c = x.constructor && x.constructor.name; return '#<' + (c && c !== 'Object' ? c : 'object') + ' ' + objectHash(x) + '>'; }
  return String(x);
}
function writeNumber(x) {
  if (Number.isInteger(x)) return x <= MAXS && x >= -MAXS ? String(x) : (s => s.includes('e') ? s : s + '.')(String(x));
  if (Number.isFinite(x)) { const s = String(x); return s.includes('.') || s.includes('e') ? s : s + '.0'; }
  return x > 0 ? '+inf.0' : x < 0 ? '-inf.0' : '+nan.0';
}
/* Records print as #<type N> handles (N is the object's hash number) unless the type has a printer,
   which is called as (printer record port). */
function writeRecord(x) {
  const pr = x.type.printer;
  if (pr) {
    const p = makeStringOutputPort();
    try { callProc(pr, [x, p]); return p.string(); } catch (e) { if (e instanceof Escape || e instanceof Unwind) throw e; }
  }
  return '#<' + x.type.name + ' ' + objectHash(x) + '>';
}
const hashes = new WeakMap(); let hashN = 0;
function objectHash(x) { if (!isObjKey(x)) return false; let h = hashes.get(x); if (!h) { h = ++hashN; hashes.set(x, h); } return h; }
const display = x => write(x, true);

/* ---------- equality ---------- */
function eqv(a, b) { return a === b || (a instanceof Char && b instanceof Char && a.code === b.code) || (typeof a === 'number' && typeof b === 'number' && (a === b || (a !== a && b !== b))); }
function equal(a, b) {
  if (eqv(a, b)) return true;
  if (a instanceof Pair && b instanceof Pair) { while (a instanceof Pair && b instanceof Pair) { if (!equal(a.car, b.car)) return false; a = a.cdr; b = b.cdr; } return equal(a, b); }
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (a instanceof Record && b instanceof Record) return a.type === b.type && a.fields.every((v, i) => equal(v, b.fields[i]));
  return false;
}

/* ---------- global environment ---------- */
const globals = new Map();           // name -> Box
const macros = new Map();            // name -> { kind: 'rules'|'proc', ... }
function gbox(name) { let b = globals.get(name); if (!b) { b = new Box(name, undefined); globals.set(name, b); } return b; }
function gref(name) { const b = globals.get(name); if (!b || b.value === undefined) throw new SchemeError('unbound-variable', `Unbound variable: ${name}`); return b.value; }
function gset(name, v) { gbox(name).value = v; return v; }
function gdef(name, v) { gbox(name).value = v; return v; }
function isBound(name) { const b = globals.get(name); return !!b && b.value !== undefined; }

/* ---------- procedures ---------- */
/* A Scheme procedure is a JS function taking an array of arguments. Tail calls return a TailCall
   that the caller's trampoline runs. Metadata lives on the function object. */
/* Watchdog: a runaway loop signals an error instead of freezing the page. The loops count steps
   (tail calls and do iterations); every 2^18 steps the clock is read, and after watchdog.limitMs
   since the last watchdog.reset() (each command, timer and evaluation starts one) the step throws. */
let tickN = 0, stepT0 = 0;
/* In generator mode the clock is read every 2^12 steps: a background thread's slice is 5 ms (R4.40). */
let TICK_MASK = GEN ? 0xFFF : 0x3FFFF;
const watchdog = { limitMs: 8000, reset() { tickN = 0; stepT0 = 0; } };
/* Returns true when the running thread's time slice is over (generator mode; the caller yields). A
   thread past its deadline (R14.13, runnable time, kept by the scheduler) gets the timeout
   condition, and one second more to unwind before it is signalled again. */
function tick() {
  if ((++tickN & TICK_MASK) !== 0) return false;
  const now = performance.now();
  if (now >= TS.deadlineAt) { TS.deadlineAt = now + 1000; throw new SchemeError('timeout', 'Timed out: the command passed its deadline', []); }
  if (!stepT0) { stepT0 = now; return false; }
  if (now - stepT0 > watchdog.limitMs) { stepT0 = 0; throw new SchemeError('scheme-interrupt', `Interrupted: evaluation ran for more than ${Math.round(watchdog.limitMs / 1000)} s`, []); }
  return now >= TS.sliceEnd;
}

/* ---------- the shadow stack ---------- */
/* ST holds the active applications of compound procedures, three slots per entry (the procedure,
   the location of the call that entered it, its lexical frame), entry k at 3k; entry 0 is a
   sentinel so SP (the next free entry) is never 0. A compound procedure pushes itself on entry and
   pops itself when its body returns, so a tail call it makes (run by its caller's trampoline after
   the pop) replaces it. Call sites only note the callee and their location in SITEPROC and SITE,
   so a call to a primitive costs two stores; a backtrace's innermost entry is the primitive (or the
   procedure not yet entered) the innermost frame last called, if any. Points that raise an error
   outside any call clear SITEPROC so that entry is not shown. Catch sites (callProc, evalForm, guard,
   call/ec, restarts) restore SP after a throw, once a snapshot is attached to the condition. Going
   past MAX_DEPTH signals recursion-depth, with DEPTH_SLACK more entries for its handlers. */
let MAX_DEPTH = 10000;
const DEPTH_SLACK = 2000;
let depthLimit = MAX_DEPTH, sp = 1, site = null, siteProc = null;
let ST = new Array((MAX_DEPTH + 2 * DEPTH_SLACK) * 3).fill(null);
function setMaxDepth(n) {
  MAX_DEPTH = n; depthLimit = n;
  for (let need = (n + 2 * DEPTH_SLACK) * 3; ST.length < need;) ST.push(null);
}
function resetStack() { sp = 1; depthLimit = MAX_DEPTH; site = null; siteProc = null; }
/* A thread's evaluator state (generator mode, R4.38-R4.40): its shadow stack, handlers, restarts and
   dynamic bindings (dyn holds parameter, outer value, own value per binding), the end of its time
   slice and its deadline (absolute, performance.now() terms; the scheduler sets both), whether the
   debugger may hold it, and a slot for the scheduler's own data. The main state owns the
   preallocated stack; a thread's grows as it recurses. */
class ThreadState {
  constructor(name) {
    this.name = name || null; this.ST = [null, null, null]; this.sp = 1; this.site = null; this.siteProc = null; this.depthLimit = MAX_DEPTH;
    this.handlers = null; this.restarts = null; this.dyn = []; this.sliceEnd = Infinity; this.deadlineAt = Infinity; this.canSuspend = false; this.data = null;
  }
}
let TS = new ThreadState('main'); TS.ST = ST;
/* Make TS the running thread: the current state is saved into the state that was running, which is
   returned. Parameter bindings are undone and redone so each thread sees its own. */
function switchTo(ts) {
  const prev = TS;
  if (ts === prev) return prev;
  prev.ST = ST; prev.sp = sp; prev.site = site; prev.siteProc = siteProc; prev.depthLimit = depthLimit; prev.handlers = handlers; prev.restarts = restarts;
  const pd = prev.dyn;
  for (let i = pd.length - 3; i >= 0; i -= 3) { const p = pd[i]; pd[i + 2] = p.value; p.value = pd[i + 1]; }
  if (hooks.threadSwitch) hooks.threadSwitch(prev, ts);
  TS = ts; ST = ts.ST; sp = ts.sp; site = ts.site; siteProc = ts.siteProc; depthLimit = ts.depthLimit; handlers = ts.handlers; restarts = ts.restarts;
  const d = ts.dyn;
  for (let i = 0; i < d.length; i += 3) { const p = d[i]; d[i + 1] = p.value; p.value = d[i + 2]; }
  return prev;
}
function snapshot() { return { raw: ST.slice(3, sp * 3), site, proc: siteProc }; }
/* The entries of a snapshot, innermost first: { proc, frame, loc }. */
function frames(snap) {
  const out = [], raw = snap.raw;
  const n = raw.length / 3, p = snap.proc;
  if (p && (!p.scope || n === 0 || raw[(n - 1) * 3] !== p)) out.push({ proc: p, frame: null, loc: snap.site ? snap.site.plain() : null });
  for (let k = n - 1; k >= 0; k--) { const l = raw[k * 3 + 1]; out.push({ proc: raw[k * 3], frame: raw[k * 3 + 2], loc: l ? l.plain() : null }); }
  return out;
}
function backtrace() { return frames(snapshot()); }
function conditionBacktrace(e) { const s = e && e.shadow; return s ? frames(s) : null; }
function depthExceeded() {
  const e = new SchemeError('recursion-depth', 'Recursion too deep', []);
  if (depthLimit > MAX_DEPTH) throw e;
  depthLimit = MAX_DEPTH + DEPTH_SLACK;
  try { return signal(e, false); } finally { depthLimit = MAX_DEPTH; }
}
/* What every catch site does with an exception passing through: a condition no handler has seen yet
   goes to the handlers now (before anything unwinds further), the stack is snapshotted onto it, and
   the stack pointer goes back to S. */
function unwound(e, s) {
  if (e instanceof SchemeError) {
    if (handlers === null) e.signalled = false;   // past every handler: if it is thrown again, they see it afresh
    else if (!e.signalled) signal(e, false);
    if (e.shadow === undefined) e.shadow = snapshot();
  } else if (e instanceof Raise && e.shadow === undefined) e.shadow = snapshot();
  sp = s;
  throw e;
}
/* Apply F to ARGS from JS (or from a primitive): the callee is noted as called from the current
   site (a procedure map applies shows the (map ...) call as its caller). */
function callProc(f, args) {
  if (typeof f !== 'function') {
    if (f instanceof Param) { if (args.length) { f.value = f.converter ? callProc(f.converter, [args[0]]) : args[0]; return UNSPEC; } return f.value; }
    if (f instanceof Sym && isBound(f.name) && typeof gref(f.name) === 'function') return callProc(gref(f.name), args);
    throw new SchemeError('wrong-type-argument', `Not a procedure: ${write(f)}`, [f]);
  }
  const s = sp, l = s === 1 ? null : site, lp = siteProc;   // from the top level, no call site
  try {
    if (SHADOW) { site = l; siteProc = f; }
    let r = f(args);
    while (r instanceof TailCall) {
      tick(); const h = r.f;
      if (SHADOW) { site = r.loc || l; siteProc = h; }
      r = typeof h === 'function' ? h(r.args) : callProc(h, r.args);
    }
    if (SHADOW) { site = l; siteProc = lp; }
    return r;
  } catch (e) { return unwound(e, s); }
}
/* A call site's application of F, compiled per site with its source location LOC. */
function makeCall(loc) {
  if (!SHADOW) return (f, args) => {
    if (typeof f !== 'function') return callProc(f, args);
    if (handlers !== null) return callGuarded(f, args, loc);
    let r = f(args);
    while (r instanceof TailCall) { tick(); r = typeof r.f === 'function' ? r.f(r.args) : callProc(r.f, r.args); }
    return r;
  };
  return (f, args) => {
    if (typeof f !== 'function') return callProc(f, args);
    if (handlers !== null) return callGuarded(f, args, loc);
    site = loc; siteProc = f;
    let r = f(args);
    while (r instanceof TailCall) { tick(); const h = r.f; site = r.loc; siteProc = h; r = typeof h === 'function' ? h(r.args) : callProc(h, r.args); }
    return r;
  };
}
/* The same while a handler is installed: errors thrown below reach the handlers here. */
function callGuarded(f, args, loc) {
  const s = sp;
  try {
    if (SHADOW) { site = loc; siteProc = f; }
    let r = f(args);
    while (r instanceof TailCall) {
      tick(); const h = r.f;
      if (SHADOW) { site = r.loc; siteProc = h; }
      r = typeof h === 'function' ? h(r.args) : callProc(h, r.args);
    }
    return r;
  } catch (e) { return unwound(e, s); }
}
function arity(f, n, rest) { f.arity = n; f.rest = !!rest; return f; }
function named(f, name) { if (!f.procName) f.procName = name; return f; }

/* ---------- the compiler ---------- */
/* Scope: compile-time description of a lambda frame: names (Sym or Alias) -> slot index.
   Runtime frames are arrays: frame[0] is the parent frame, slots start at 1. */
/* While scanClosure runs, SCAN collects every scope the compile creates, every variable reference
   or assignment with its resolution, and every macro use (pool.js ships closures with it). */
let scan = null;
class Scope {
  constructor(parent, names) { this.parent = parent; this.names = new Map(); this.macros = null; let k = 1; for (const n of names) this.names.set(n, k++); this.size = k; if (scan) scan.scopes.add(this); }
  add(name) { const k = this.size++; this.names.set(name, k); return k; }
}
function lookup(scope, id) {
  let depth = 0;
  for (let s = scope; s; s = s.parent, depth++) {
    if (s.macros && s.macros.has(id)) return { macro: s.macros.get(id), at: s };
    const k = s.names.get(id); if (k !== undefined) return { depth, index: k, at: s };
  }
  if (id instanceof Alias) {
    // Not bound as the alias itself: resolve the original name in the macro's definition scope.
    return lookup(id.scope, id.sym);
  }
  return null;
}
const baseName = id => id instanceof Alias ? baseName(id.sym) : id;
function strip(x) {
  if (x instanceof Alias) return strip(x.sym);
  if (x instanceof Pair) { const out = []; let c = x; while (c instanceof Pair) { out.push(strip(c.car)); c = c.cdr; } return listOf(out, strip(c)); }
  if (Array.isArray(x)) return x.map(strip);
  return x;
}
function isId(x) { return x instanceof Sym || x instanceof Alias; }
function special(scope, head) {
  // Returns the special-form name if HEAD is an unshadowed special form, else null.
  if (!isId(head)) return null;
  const r = lookup(scope, head);
  if (r && !r.macro) return null;
  const b = baseName(head);
  return SPECIAL.has(b) ? b.name : null;
}
function macroFor(scope, head) {
  if (!isId(head)) return null;
  const r = lookup(scope, head);
  if (r) return r.macro || null;
  const b = baseName(head);
  return macros.get(b.name) || null;
}
function expandMacro(m, form, scope) {
  if (m.kind === 'proc') return callProc(m.proc, arr(form.cdr));
  return expandRules(m, form, scope);
}

/* syntax-rules matching with ellipsis and literals; template identifiers that are not pattern
   variables become Aliases that resolve in the macro's definition scope. */
function expandRules(m, form, useScope) {
  for (const [pattern, template] of m.rules) {
    const b = new Map();
    if (match(pattern.cdr, form.cdr, b, m.literals, m.scope, useScope)) {
      const renames = new Map();
      return instantiate(template, b, renames, m);
    }
  }
  throw new SchemeError('syntax-error', 'No matching syntax rule for ' + write(strip(form)));
}
function isEllipsis(x) { return isId(x) && baseName(x) === S['...']; }
function match(p, f, b, literals, defScope, useScope) {
  if (isId(p)) {
    const base = baseName(p);
    if (literals.has(base)) return isId(f) && baseName(f) === base;
    if (base === S._) return true;
    b.set(base, f); return true;
  }
  if (p instanceof Pair) {
    if (p.cdr instanceof Pair && isEllipsis(p.cdr.car)) {
      const after = p.cdr.cdr;
      const minAfter = (() => { let n = 0, c = after; while (c instanceof Pair) { n++; c = c.cdr; } return n; })();
      const items = []; let c = f;
      while (c instanceof Pair) { items.push(c.car); c = c.cdr; }
      const tail = c;
      const nRep = items.length - minAfter;
      if (nRep < 0) return false;
      const seqs = [];
      for (let i = 0; i < nRep; i++) { const bb = new Map(); if (!match(p.car, items[i], bb, literals, defScope, useScope)) return false; seqs.push(bb); }
      for (const v of patternVars(p.car, literals)) b.set(v, { ellipsis: seqs.map(bb => bb.get(v)) });
      let rest = listOf(items.slice(nRep), tail);
      return match(after, rest, b, literals, defScope, useScope);
    }
    if (!(f instanceof Pair)) return false;
    return match(p.car, f.car, b, literals, defScope, useScope) && match(p.cdr, f.cdr, b, literals, defScope, useScope);
  }
  if (p === NIL) return f === NIL;
  if (Array.isArray(p)) return Array.isArray(f) && match(listOf(p), listOf(f), b, literals, defScope, useScope);
  return equal(p, f);
}
function patternVars(p, literals, out) {
  out = out || [];
  if (isId(p)) { const b = baseName(p); if (!literals.has(b) && b !== S._ && b !== S['...']) out.push(b); }
  else if (p instanceof Pair) { patternVars(p.car, literals, out); patternVars(p.cdr, literals, out); }
  else if (Array.isArray(p)) p.forEach(x => patternVars(x, literals, out));
  return out;
}
let aliasCounter = 0;
function instantiate(t, b, renames, m) {
  if (isId(t)) {
    const base = baseName(t);
    if (b.has(base)) { const v = b.get(base); if (v && v.ellipsis) throw new SchemeError('syntax-error', 'Pattern variable used without ellipsis: ' + base.name); return v; }
    if (base === S['...']) return t;
    let a = renames.get(base);
    if (!a) { a = new Alias(base, m.scope, ++aliasCounter); renames.set(base, a); }
    return a;
  }
  if (t instanceof Pair) {
    if (isEllipsis(t.car) && t.cdr instanceof Pair) return instantiate(t.cdr.car, b, renames, m); // (... ...) escape
    if (t.cdr instanceof Pair && isEllipsis(t.cdr.car)) {
      const vars = patternVars(t.car, m.literals).filter(v => b.has(v) && b.get(v) && b.get(v).ellipsis);
      if (!vars.length) throw new SchemeError('syntax-error', 'Ellipsis without a sequence variable in template');
      const n = Math.max(...vars.map(v => b.get(v).ellipsis.length));
      const out = [];
      for (let i = 0; i < n; i++) {
        const bb = new Map(b);
        for (const v of vars) { const seq = b.get(v).ellipsis; if (i < seq.length) bb.set(v, seq[i]); else bb.delete(v); }
        out.push(instantiate(t.car, bb, renames, m));
      }
      let rest = t.cdr.cdr;
      while (rest instanceof Pair && isEllipsis(rest.car)) rest = rest.cdr;
      return listOf(out, instantiate(rest, b, renames, m));
    }
    return new Pair(instantiate(t.car, b, renames, m), instantiate(t.cdr, b, renames, m));
  }
  if (Array.isArray(t)) return arr(instantiate(listOf(t), b, renames, m));
  return t;
}
function parseRules(spec, scope) {
  // spec: (syntax-rules (literals...) (pattern template)...)
  const parts = arr(spec);
  if (!(isId(parts[0]) && baseName(parts[0]) === S['syntax-rules'])) throw new SchemeError('syntax-error', 'define-syntax expects syntax-rules');
  const literals = new Set(arr(parts[1]).map(baseName));
  const rules = parts.slice(2).map(r => { const rr = arr(r); return [rr[0], rr[1]]; });
  return { kind: 'rules', literals, rules, scope };
}

const SPECIAL = new Set([S.quote, S.quasiquote, S.lambda, S.define, S['set!'], S.if, S.begin, S.let, S['let*'], S.letrec, S['letrec*'], S.cond, S.case,
  S.and, S.or, S.when, S.unless, S.do, S['define-syntax'], S['define-macro'], S.parameterize, S.guard, S['define-record-type'], S['let-values'],
  S.receive, S.assert, S.delay, S['case-lambda'], S['named-lambda'], S['define-values'], S['let-syntax'], S['letrec-syntax'], S['the-environment'], S.include]);

const K = v => () => v;
function body(forms, scope, tail) {
  // Internal defines become letrec*-style slots in the current scope.
  const list = arr(forms);
  if (!list.length) return K(UNSPEC);
  const compiled = [];
  scanDefines(list, scope);
  for (let i = 0; i < list.length; i++) compiled.push(comp(list[i], scope, tail && i === list.length - 1));
  if (compiled.length === 1) return compiled[0];
  const n = compiled.length - 1;
  return env => { for (let i = 0; i < n; i++) compiled[i](env); return compiled[n](env); };
}
// Pre-scan a body for internal defines to allocate slots before compiling (mutual recursion).
function scanDefines(list, scope) {
  if (!scope) return;
  for (const f of list) {
    if (f instanceof Pair && special(scope, f.car) === 'define') {
      const target = f.cdr.car;
      const name = target instanceof Pair ? target.car : target;
      if (isId(name) && !scope.names.has(name)) scope.add(name);
    }
    if (f instanceof Pair && special(scope, f.car) === 'define-values') { for (const n of arr(f.cdr.car)) if (isId(n) && !scope.names.has(n)) scope.add(n); }
    if (f instanceof Pair && special(scope, f.car) === 'define-record-type') { const spec = arr(f.cdr); const ctor = spec[1] instanceof Pair ? spec[1].car : spec[1]; for (const n of [ctor, spec[2]]) if (isId(n) && !scope.names.has(n)) scope.add(n); for (const fd of spec.slice(3)) for (const n of arr(fd).slice(1)) if (isId(n) && !scope.names.has(n)) scope.add(n); }
  }
}
function parseParams(params) {
  // Returns { names: [ids], rest: id|null, optional: [ids] } supporting #!optional and dotted rest.
  const names = [], optional = []; let rest = null, mode = 0;
  let p = params;
  while (p instanceof Pair) {
    const x = p.car;
    if (x instanceof Sym && x.name === '#!optional') mode = 1;
    else if (x instanceof Sym && x.name === '#!rest') mode = 2;
    else if (mode === 2) rest = x;
    else if (mode === 1) optional.push(x);
    else names.push(x);
    p = p.cdr;
  }
  if (p !== NIL) rest = p;
  return { names, optional, rest };
}
function makeLambda(params, bodyForms, scope, name, loc) {
  const { names, optional, rest } = parseParams(params);
  const all = [...names, ...optional]; if (rest) all.push(rest);
  const inner = new Scope(scope, all);
  let doc = null;
  if (bodyForms instanceof Pair && typeof bodyForms.car === 'string' && bodyForms.cdr !== NIL) { doc = bodyForms.car; bodyForms = bodyForms.cdr; }
  /* The source form, kept on every closure so a thread can be given a copy of it (pool.js). */
  const srcForm = new Pair(S.lambda, new Pair(params, bodyForms));
  const nReq = names.length, nOpt = optional.length, hasRest = !!rest;
  const slotRest = nReq + nOpt + 1;
  const lambdaLoc = loc || null;
  if (GEN) {
    /* Generator mode: the body is a generator node (gbody, run by applyG); the plain entry drives it
       to completion for callers that cannot yield. */
    const run = bodyG(bodyForms, inner, true);
    return env => {
      const f = function (args) { const t = sp; const frame = enterFrame(f, args); const r = run.d ? run(frame) : driveSync(run(frame)); sp = t; return r; };
      f.procName = name || null; f.doc = doc; f.arity = nReq; f.rest = hasRest; f.optional = nOpt; f.params = params;
      f.src = srcForm; f.scope = inner; f.env = env; f.loc = lambdaLoc; f.gbody = run;
      return f;
    };
  }
  const run = body(bodyForms, inner, true);
  return env => {
    const f = function (args) {
      const n = args.length;
      if (n < nReq || (!hasRest && n > nReq + nOpt)) throw new SchemeError('wrong-number-of-arguments', `${f.procName || 'procedure'}: expected ${hasRest ? 'at least ' : ''}${nReq}${nOpt && !hasRest ? '..' + (nReq + nOpt) : ''} argument${nReq === 1 ? '' : 's'}, got ${n}`);
      const frame = new Array(inner.size);
      frame[0] = env;
      for (let i = 0; i < nReq + nOpt; i++) frame[i + 1] = i < n ? args[i] : false;
      if (hasRest) frame[slotRest] = n > nReq + nOpt ? listOf(args.slice(nReq + nOpt)) : NIL;
      if (SHADOW) {
        const t = sp; if (t > depthLimit) depthExceeded();
        const b = t * 3; ST[b] = f; ST[b + 1] = site; ST[b + 2] = frame; sp = t + 1;
        const r = run(frame); sp = t; return r;
      }
      return run(frame);
    };
    f.procName = name || null; f.doc = doc; f.arity = nReq; f.rest = hasRest; f.optional = nOpt; f.params = params;
    f.src = srcForm; f.scope = inner; f.env = env; f.loc = lambdaLoc;
    return f;
  };
}
function compRef(id, scope) {
  const r = lookup(scope, id);
  if (scan) scan.refs.push([id, r]);
  if (r && r.macro) throw new SchemeError('syntax-error', 'Macro used as a variable: ' + baseName(id).name);
  if (r) {
    const { depth, index } = r;
    if (depth === 0) return env => env[index];
    if (depth === 1) return env => env[0][index];
    if (depth === 2) return env => env[0][0][index];
    return env => { let e = env; for (let d = 0; d < depth; d++) e = e[0]; return e[index]; };
  }
  const name = baseName(id).name;
  const box = gbox(name);
  return () => { const v = box.value; if (v === undefined) return unboundRef(box, name); return v; };
}
/* The store of a value into ID (a define or a set!): (env, value) -> the form's value. */
function compStore(id, scope, define) {
  const r = lookup(scope, id);
  if (scan) scan.refs.push([id, r]);
  if (r && r.macro) throw new SchemeError('syntax-error', 'Cannot assign to a macro: ' + baseName(id).name);
  if (r) {
    const { depth, index } = r;
    return (env, v) => { let e = env; for (let d = 0; d < depth; d++) e = e[0]; if (define && typeof v === 'function' && !v.procName) v.procName = baseName(id).name; e[index] = v; return define ? baseName(id) : UNSPEC; };
  }
  const name = baseName(id).name, box = gbox(name);
  if (define) return (env, v) => { if (typeof v === 'function' && !v.procName) v.procName = name; box.value = v; return baseName(id); };
  return (env, v) => { if (box.value === undefined) return unboundSet(box, name, v); box.value = v; return UNSPEC; };
}
function compSet(id, valc, scope, define) { const st = compStore(id, scope, define); return env => st(env, valc(env)); }
function compCall(form, scope, tail) {
  const fc = comp(form.car, scope, false);
  const argcs = arr(form.cdr).map(a => comp(a, scope, false));
  const n = argcs.length;
  const loc = locs.get(form) || null;
  if (tail) {
    if (n === 0) return env => new TailCall(fc(env), [], loc);
    if (n === 1) return env => new TailCall(fc(env), [argcs[0](env)], loc);
    if (n === 2) return env => new TailCall(fc(env), [argcs[0](env), argcs[1](env)], loc);
    return env => { const f = fc(env), args = new Array(n); for (let i = 0; i < n; i++) args[i] = argcs[i](env); return new TailCall(f, args, loc); };
  }
  const call = makeCall(loc);
  if (n === 0) return env => call(fc(env), []);
  if (n === 1) return env => call(fc(env), [argcs[0](env)]);
  if (n === 2) return env => call(fc(env), [argcs[0](env), argcs[1](env)]);
  if (n === 3) return env => call(fc(env), [argcs[0](env), argcs[1](env), argcs[2](env)]);
  return env => { const f = fc(env), args = new Array(n); for (let i = 0; i < n; i++) args[i] = argcs[i](env); return call(f, args); };
}
function qq(x, scope, depth) {
  if (x instanceof Pair) {
    if (isId(x.car) && baseName(x.car) === S.unquote) {
      if (depth === 1) return comp(x.cdr.car, scope, false);
      const inner = qq(x.cdr.car, scope, depth - 1); return env => list(S.unquote, inner(env));
    }
    if (isId(x.car) && baseName(x.car) === S.quasiquote) { const inner = qq(x.cdr.car, scope, depth + 1); return env => list(S.quasiquote, inner(env)); }
    // Build the list, splicing where needed.
    const parts = []; let c = x;
    while (c instanceof Pair) {
      if (isId(c.car) && baseName(c.car) === S.unquote) break; // dotted unquote: `(a . ,b)
      const item = c.car;
      if (item instanceof Pair && isId(item.car) && baseName(item.car) === S['unquote-splicing'] && depth === 1) parts.push({ splice: comp(item.cdr.car, scope, false) });
      else parts.push({ one: qq(item, scope, depth) });
      c = c.cdr;
    }
    const tailc = c === NIL ? K(NIL) : qq(c, scope, depth);
    return env => {
      let r = tailc(env);
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (p.one) r = new Pair(p.one(env), r);
        else { const items = arr(p.splice(env)); for (let j = items.length - 1; j >= 0; j--) r = new Pair(items[j], r); }
      }
      return r;
    };
  }
  if (Array.isArray(x)) { const lc = qq(listOf(x), scope, depth); return env => arr(lc(env)); }
  const v = strip(x); return K(v);
}
function comp(x, scope, tail) {
  if (isId(x)) { if (isKeyword(baseName(x))) return K(baseName(x)); return compRef(x, scope); }
  if (!(x instanceof Pair)) { if (x === NIL) throw new SchemeError('syntax-error', 'Empty combination ()'); return K(x); }
  const head = x.car;
  const m = macroFor(scope, head);
  if (m && scan) scan.macros.push([head, lookup(scope, head)]);
  if (m) {
    const exp = expandMacro(m, x, scope);
    if (exp instanceof Pair && !locs.has(exp)) { const l = locs.get(x); if (l) locs.set(exp, l); }
    return comp(exp, scope, tail);
  }
  const sf = special(scope, head);
  if (sf) return compSpecial(sf, x, scope, tail);
  return compCall(x, scope, tail);
}
function compSpecial(name, x, scope, tail) {
  const a = arr(x.cdr);
  const need = (n, msg) => { if (a.length < n) throw new SchemeError('syntax-error', `${name}: ${msg || 'too few forms'} in ${write(strip(x))}`); };
  switch (name) {
    case 'quote': need(1); return K(strip(a[0]));
    case 'quasiquote': need(1); return qq(a[0], scope, 1);
    case 'if': {
      need(2);
      const c = comp(a[0], scope, false), t = comp(a[1], scope, tail), e = a.length > 2 ? comp(a[2], scope, tail) : K(UNSPEC);
      return env => c(env) !== false ? t(env) : e(env);
    }
    case 'define': {
      need(1);
      const target = a[0];
      if (target instanceof Pair) {
        // (define (name . params) body...) and curried (define ((name a) b) ...)
        let nameSpec = target.car, params = target.cdr, bodyForms = x.cdr.cdr;
        while (nameSpec instanceof Pair) { bodyForms = list(new Pair(S.lambda, new Pair(params, bodyForms))); params = nameSpec.cdr; nameSpec = nameSpec.car; }
        const lam = makeLambda(params, bodyForms, scope, baseName(nameSpec).name, locs.get(x));
        return compSet(nameSpec, lam, scope, true);
      }
      if (!isId(target)) throw new SchemeError('syntax-error', 'define: bad target ' + write(strip(target)));
      if (a.length === 1) return compSet(target, K(UNSPEC), scope, true);
      let valForm = a[1], doc = null;
      if (typeof valForm === 'string' && a.length > 2) { doc = valForm; valForm = a[2]; }
      const vc = comp(valForm, scope, false);
      const setter = compSet(target, vc, scope, true);
      if (doc) return env => { const r = setter(env); const v = lookupValue(target, scope, env); if (typeof v === 'function') v.doc = doc; else gdoc.set(baseName(target).name, doc); return r; };
      return setter;
    }
    case 'set!': need(2); return compSet(a[0], comp(a[1], scope, false), scope, false);
    case 'lambda': need(1); return makeLambda(a[0], x.cdr.cdr, scope, null, locs.get(x));
    case 'named-lambda': { need(1); const spec = a[0]; return makeLambda(spec.cdr, x.cdr.cdr, scope, baseName(spec.car).name, locs.get(x)); }
    case 'begin': return body(x.cdr, scope, tail);
    case 'let': {
      need(1);
      if (isId(a[0])) {
        // named let
        const nm = a[0], bindings = arr(a[1]).map(b => b instanceof Pair ? [b.car, b.cdr === NIL ? UNSPEC : b.cdr.car] : [b, UNSPEC]);
        const loopScope = new Scope(scope, [nm]);
        const lam = makeLambda(listOf(bindings.map(b => b[0])), x.cdr.cdr.cdr, loopScope, baseName(nm).name, locs.get(x));
        const inits = bindings.map(b => comp(b[1] === UNSPEC ? false : b[1], scope, false));
        return env => { const frame = [env, null]; const f = lam(frame); frame[1] = f; const args = inits.map(i => i(env)); return tail ? new TailCall(f, args) : callProc(f, args); };
      }
      const bindings = arr(a[0]).map(b => b instanceof Pair ? [b.car, b.cdr === NIL ? false : b.cdr.car] : [b, false]);
      const inits = bindings.map(b => comp(b[1], scope, false));
      const inner = new Scope(scope, bindings.map(b => b[0]));
      const run = body(x.cdr.cdr, inner, tail);
      const n = inits.length;
      return env => { const frame = new Array(inner.size); frame[0] = env; for (let i = 0; i < n; i++) frame[i + 1] = inits[i](env); return run(frame); };
    }
    case 'let*': {
      need(1);
      const bindings = arr(a[0]).map(b => b instanceof Pair ? [b.car, b.cdr === NIL ? false : b.cdr.car] : [b, false]);
      if (!bindings.length) return body(x.cdr.cdr, new Scope(scope, []), tail);
      const inner = new Scope(scope, []);
      const steps = bindings.map(([id, init]) => { const ic = comp(init, inner, false); const slot = inner.add(id); return [slot, ic]; });
      const run = body(x.cdr.cdr, inner, tail);
      return env => { const frame = new Array(inner.size); frame[0] = env; for (const [slot, ic] of steps) frame[slot] = ic(frame); return run(frame); };
    }
    case 'letrec': case 'letrec*': {
      need(1);
      const bindings = arr(a[0]).map(b => [b.car, b.cdr === NIL ? false : b.cdr.car]);
      const inner = new Scope(scope, bindings.map(b => b[0]));
      const inits = bindings.map(([id, init]) => { const c = comp(init, inner, false); const nm = baseName(id).name; return env => { const v = c(env); if (typeof v === 'function' && !v.procName) v.procName = nm; return v; }; });
      const run = body(x.cdr.cdr, inner, tail);
      return env => { const frame = new Array(inner.size); frame[0] = env; for (let i = 0; i < inits.length; i++) frame[i + 1] = inits[i](frame); return run(frame); };
    }
    case 'cond': {
      const clauses = a.map(cl => {
        const c = arr(cl);
        if (isId(c[0]) && baseName(c[0]) === S.else) return { els: body(cl.cdr, scope, tail) };
        if (c.length > 1 && isId(c[1]) && baseName(c[1]) === S['=>']) return { test: comp(c[0], scope, false), arrow: comp(c[2], scope, false) };
        return { test: comp(c[0], scope, false), run: c.length > 1 ? body(cl.cdr, scope, tail) : null };
      });
      return env => {
        for (const cl of clauses) {
          if (cl.els) return cl.els(env);
          const v = cl.test(env);
          if (v !== false) { if (cl.arrow) { const f = cl.arrow(env); return tail ? new TailCall(f, [v]) : callProc(f, [v]); } return cl.run ? cl.run(env) : v; }
        }
        return UNSPEC;
      };
    }
    case 'case': {
      need(1);
      const keyc = comp(a[0], scope, false);
      const clauses = a.slice(1).map(cl => {
        const c = arr(cl);
        const els = isId(c[0]) && baseName(c[0]) === S.else;
        const data = els ? null : arr(strip(c[0]));
        if (c.length > 1 && isId(c[1]) && baseName(c[1]) === S['=>']) return { els, data, arrow: comp(c[2], scope, false) };
        return { els, data, run: body(cl.cdr, scope, tail) };
      });
      return env => {
        const k = keyc(env);
        for (const cl of clauses) {
          if (cl.els || cl.data.some(d => eqv(d, k))) { if (cl.arrow) { const f = cl.arrow(env); return tail ? new TailCall(f, [k]) : callProc(f, [k]); } return cl.run(env); }
        }
        return UNSPEC;
      };
    }
    case 'and': {
      if (!a.length) return K(true);
      const cs = a.map((e, i) => comp(e, scope, tail && i === a.length - 1));
      return env => { let v = true; for (let i = 0; i < cs.length; i++) { v = cs[i](env); if (v === false) return false; } return v; };
    }
    case 'or': {
      if (!a.length) return K(false);
      const cs = a.map((e, i) => comp(e, scope, tail && i === a.length - 1));
      return env => { for (let i = 0; i < cs.length; i++) { const v = cs[i](env); if (v !== false) return v; } return false; };
    }
    case 'when': { need(1); const c = comp(a[0], scope, false), run = body(x.cdr.cdr, scope, tail); return env => c(env) !== false ? run(env) : UNSPEC; }
    case 'unless': { need(1); const c = comp(a[0], scope, false), run = body(x.cdr.cdr, scope, tail); return env => c(env) === false ? run(env) : UNSPEC; }
    case 'do': {
      need(2);
      const specs = arr(a[0]).map(s => { const ss = arr(s); return { id: ss[0], init: ss[1], step: ss.length > 2 ? ss[2] : null }; });
      const inner = new Scope(scope, specs.map(s => s.id));
      const inits = specs.map(s => comp(s.init, scope, false));
      const steps = specs.map(s => s.step === null ? null : comp(s.step, inner, false));
      const endSpec = arr(a[1]);
      const test = comp(endSpec[0], inner, false), result = body(a[1].cdr, inner, false);
      const cmds = body(x.cdr.cdr.cdr, inner, false);
      return env => {
        let frame = new Array(inner.size); frame[0] = env;
        for (let i = 0; i < inits.length; i++) frame[i + 1] = inits[i](env);
        for (;;) {
          if (test(frame) !== false) return result(frame);
          tick();
          cmds(frame);
          const next = new Array(inner.size); next[0] = env;
          for (let i = 0; i < steps.length; i++) next[i + 1] = steps[i] ? steps[i](frame) : frame[i + 1];
          frame = next;
        }
      };
    }
    case 'define-syntax': case 'let-syntax': case 'letrec-syntax': {
      if (name === 'define-syntax') {
        need(2);
        const id = a[0], spec = a[1];
        let m;
        if (spec instanceof Pair && isId(spec.car) && baseName(spec.car) === S['syntax-rules']) m = parseRules(spec, scope);
        else { const pc = comp(spec, scope, false); m = { kind: 'proc', proc: null, lazy: pc }; }
        if (scope) { if (!scope.macros) scope.macros = new Map(); if (m.lazy) { m.proc = m.lazy(null); } scope.macros.set(id, m); }
        else { if (m.lazy) m.proc = m.lazy(null); m.src = strip(x); macros.set(baseName(id).name, m); }
        return K(baseName(id));
      }
      const inner = new Scope(scope, []); inner.macros = new Map();
      for (const b of arr(a[0])) { const bb = arr(b); inner.macros.set(bb[0], parseRules(bb[1], name === 'letrec-syntax' ? inner : scope)); }
      const run = body(x.cdr.cdr, inner, tail);
      return env => run([env]);
    }
    case 'define-macro': {
      need(2);
      const target = a[0];
      const nameId = target instanceof Pair ? target.car : target;
      const lam = target instanceof Pair ? makeLambda(target.cdr, x.cdr.cdr, scope, baseName(nameId).name, locs.get(x)) : comp(a[1], scope, false);
      const proc = lam(null);
      const m = { kind: 'proc', proc };
      if (scope) { if (!scope.macros) scope.macros = new Map(); scope.macros.set(nameId, m); } else { m.src = strip(x); macros.set(baseName(nameId).name, m); }
      return K(baseName(nameId));
    }
    case 'parameterize': {
      need(1);
      const bs = arr(a[0]).map(b => { const bb = arr(b); return [comp(bb[0], scope, false), comp(bb[1], scope, false)]; });
      const run = body(x.cdr.cdr, scope, false);
      return env => {
        const ps = bs.map(([pc, vc]) => { const p = pc(env); if (!(p instanceof Param)) throw typeErr('parameter', p, 'parameterize'); return [p, vc(env)]; });
        const old = ps.map(([p]) => p.value);
        for (const [p, v] of ps) p.value = p.converter ? callProc(p.converter, [v]) : v;
        try { return run(env); } finally { ps.forEach(([p], i) => { p.value = old[i]; }); }
      };
    }
    case 'guard': {
      /* (guard (var clause...) body...). The guard is a handler: the clause tests run where the
         condition was raised, before unwinding, so a guard with no matching clause lets the outer
         handlers see the condition in place; the chosen clause's body runs after unwinding to the
         guard. Quit and scheme-interrupt conditions pass through. */
      need(2);
      const spec = a[0], v = spec.car;
      const inner = new Scope(scope, [v]);
      const cls = arr(spec.cdr).map(cl => {
        const c = arr(cl);
        if (isId(c[0]) && baseName(c[0]) === S.else) return { test: null, run: body(cl.cdr, inner, false) };
        if (c.length > 2 && isId(c[1]) && baseName(c[1]) === S['=>']) return { test: comp(c[0], inner, false), arrow: comp(c[2], inner, false) };
        return { test: comp(c[0], inner, false), run: c.length > 1 ? body(cl.cdr, inner, false) : null };
      });
      const run = body(x.cdr.cdr, scope, false);
      return env => {
        const tag = {};
        const choose = obj => {
          if (isPassive(obj)) return null;
          const frame = [env, obj];
          for (let i = 0; i < cls.length; i++) { const t = cls[i].test; if (!t) return [i, true]; const tv = t(frame); if (tv !== false) return [i, tv]; }
          return null;
        };
        const saved = handlers, s = sp;
        handlers = { h: obj => { const c = choose(obj); if (!c) return DECLINE; throw new Unwind(tag, obj, c); }, js: true, next: saved };
        let obj, c;
        try { return run(env); }
        catch (e) {
          if (e instanceof Unwind && e.tag === tag) { obj = e.a; c = e.b; }
          else if (e instanceof Escape || e instanceof Unwind || ((e instanceof SchemeError || e instanceof Raise) && e.signalled)) throw e;
          else if (e instanceof RangeError) {
            /* The JavaScript stack ran out before the shadow stack's cap (R4.34): the stack is unwound
               already, so the clauses see a recursion-depth condition here, after unwinding. */
            handlers = saved;
            obj = new SchemeError('recursion-depth', `Recursion too deep: the JavaScript stack ran out at depth ${Math.max(0, sp - 1)}`, []);
            sp = s;
            c = choose(obj);
            if (!c) throw e;
          } else if (e instanceof SchemeError) {
            try { signal(e, false); } catch (e2) { if (e2 instanceof Unwind && e2.tag === tag) { obj = e2.a; c = e2.b; } else throw e2; }
          } else {
            /* Another JS exception: unwound already; the clauses see it as it is. */
            handlers = saved; sp = s;
            obj = e instanceof Raise ? e.obj : e;
            c = choose(obj);
            if (!c) throw e;
          }
        } finally { handlers = saved; }
        sp = s;
        const frame = [env, obj], cl = cls[c[0]];
        if (cl.arrow) return callProc(cl.arrow(frame), [c[1]]);
        return cl.run ? cl.run(frame) : c[1];
      };
    }
    case 'define-record-type': {
      need(3);
      const typeName = a[0] instanceof Pair ? a[0].car : a[0];
      /* (define-record-type (name :printer proc) ...): PROC is called as (proc record port). */
      let printerc = null;
      if (a[0] instanceof Pair) { const o = arr(a[0].cdr); for (let i = 0; i + 1 < o.length; i += 2) if (isId(o[i]) && baseName(o[i]).name === ':printer') printerc = comp(o[i + 1], scope, false); }
      const ctorSpec = a[1], predName = a[2], fields = a.slice(3).map(f => arr(f));
      const fieldNames = fields.map(f => baseName(f[0]));
      const rt = new RecordType(baseName(typeName).name, fieldNames.map(s => s.name));
      /* The source form and a tag on each generated procedure, so a thread can be given the type (pool.js). */
      rt.src = strip(x);
      const tag = f => { f.recordType = rt; return f; };
      const defs = [];
      defs.push([typeName, K(rt)]);
      if (ctorSpec instanceof Pair) {
        const ctorName = ctorSpec.car, ctorFields = arr(ctorSpec.cdr).map(baseName);
        const idx = ctorFields.map(f => fieldNames.indexOf(f));
        defs.push([ctorName, K(tag(named(arity(args => { const r = new Record(rt, new Array(fieldNames.length).fill(false)); idx.forEach((k, i) => { r.fields[k] = args[i]; }); return r; }, idx.length), baseName(ctorName).name)))]);
      } else if (isId(ctorSpec)) defs.push([ctorSpec, K(tag(named(args => new Record(rt, args.slice()), baseName(ctorSpec).name)))]);
      defs.push([predName, K(tag(named(arity(args => args[0] instanceof Record && args[0].type === rt, 1), baseName(predName).name)))]);
      fields.forEach((f, k) => {
        if (f[1]) defs.push([f[1], K(tag(named(arity(args => { if (!(args[0] instanceof Record) || args[0].type !== rt) throw typeErr(rt.name, args[0], baseName(f[1]).name); return args[0].fields[k]; }, 1), baseName(f[1]).name)))]);
        if (f[2]) defs.push([f[2], K(tag(named(arity(args => { if (!(args[0] instanceof Record) || args[0].type !== rt) throw typeErr(rt.name, args[0], baseName(f[2]).name); args[0].fields[k] = args[1]; return UNSPEC; }, 2), baseName(f[2]).name)))]);
      });
      const setters = defs.map(([id, vc]) => compSet(id, vc, scope, true));
      return env => { if (printerc) rt.printer = printerc(env); for (const s of setters) s(env); return baseName(typeName); };
    }
    case 'let-values': case 'receive': case 'define-values': {
      if (name === 'receive') {
        need(2);
        const formals = a[0], prodc = comp(a[1], scope, false);
        const { names, rest } = parseParams(formals);
        const all = rest ? [...names, rest] : names;
        const inner = new Scope(scope, all);
        const run = body(x.cdr.cdr.cdr, inner, tail);
        return env => { const v = prodc(env); const vals = v instanceof Values ? v.vals : [v]; const frame = new Array(inner.size); frame[0] = env; for (let i = 0; i < names.length; i++) frame[i + 1] = vals[i]; if (rest) frame[names.length + 1] = listOf(vals.slice(names.length)); return run(frame); };
      }
      if (name === 'define-values') {
        need(2);
        const formals = arr(a[0]), prodc = comp(a[1], scope, false);
        const setters = formals.map((id, i) => compSet(id, env => env.__vals[i], scope, true));
        return env => { const v = prodc(env); const vals = v instanceof Values ? v.vals : [v]; const e2 = env || []; const saved = e2.__vals; e2.__vals = vals; try { for (const s of setters) s(e2); } finally { e2.__vals = saved; } return UNSPEC; };
      }
      need(1);
      const bs = arr(a[0]).map(b => { const bb = arr(b); return { formals: parseParams(bb[0]), prod: comp(bb[1], scope, false) }; });
      const all = []; bs.forEach(b => { all.push(...b.formals.names); if (b.formals.rest) all.push(b.formals.rest); });
      const inner = new Scope(scope, all);
      const run = body(x.cdr.cdr, inner, tail);
      return env => {
        const frame = new Array(inner.size); frame[0] = env; let k = 1;
        for (const b of bs) { const v = b.prod(env); const vals = v instanceof Values ? v.vals : [v]; for (let i = 0; i < b.formals.names.length; i++) frame[k++] = vals[i]; if (b.formals.rest) frame[k++] = listOf(vals.slice(b.formals.names.length)); }
        return run(frame);
      };
    }
    case 'assert': { need(1); const c = comp(a[0], scope, false); const src = write(strip(a[0])); return env => { if (c(env) === false) { siteProc = null; signal(new SchemeError('assertion-failed', 'Assertion failed: ' + src), false); } return true; }; }
    case 'delay': { need(1); const c = comp(a[0], scope, false); return env => { let done = false, v; const p = () => { if (!done) { v = c(env); done = true; } return v; }; p.isPromise = true; return p; }; }
    case 'case-lambda': {
      const clauses = a.map(cl => makeLambda(cl.car, cl.cdr, scope, null, locs.get(cl) || locs.get(x)));
      return env => { const fs = clauses.map(c => c(env)); const f = args => { for (const g of fs) if (args.length === g.arity || (g.rest && args.length >= g.arity) || (args.length >= g.arity && args.length <= g.arity + (g.optional || 0))) return g(args); throw new SchemeError('wrong-number-of-arguments', 'case-lambda: no clause for ' + args.length + ' arguments'); }; return f; };
    }
    case 'the-environment': return scope ? env => new Environment(scope, env) : K(GLOBAL_ENV);
    case 'include': {
      /* (include file...): the files' forms, read through hooks.readFile at compile time, as a body. */
      const forms = [];
      for (const f of a) { const file = str(strip(f), 'include'); forms.push(...readAll(readFileText(file), file)); }
      return body(listOf(forms), scope, tail);
    }
  }
  throw new SchemeError('syntax-error', 'Unknown special form ' + name);
}
/* ---------- generator mode (R4.38) ---------- */
/* In generator mode (edwind) the compiler emits generator closures. A compiled node is a generator
   function of the frame, run with yield*, unless it can call no compound procedure: constants,
   variable references, lambda, and calls to a global bound to a primitive when compiled, with such
   nodes as arguments, stay plain closures flagged .d (consumers test the flag and call them). A
   compound procedure compiled in this mode carries gbody, the generator node of its body, and its
   plain JS entry drives that body to completion (driveSync) for callers that cannot yield: JS
   primitives without a generator variant, and direct-mode code. There a blocking primitive signals
   cannot-block. A node yields a Block (wait for a promise), PREEMPT (the time slice is over) or a
   Suspend (the debugger holds the thread); edwind's scheduler resumes the thread with the promise's
   value, or throws into it. Thread state (the shadow stack, handlers, restarts, dynamic bindings)
   is swapped by switchTo. A global unbound when compiled compiles to a generator node, so the
   unbound-variable restarts (use-value, store-value) can hold the thread in the debugger. */
class Block { constructor(promise, what) { this.promise = promise; this.what = what || null; } }
class Suspend { constructor(condition, continuable) { this.condition = condition; this.continuable = continuable; } }
const PREEMPT = { toString() { return '#<preempt>'; } };
const D1 = f => { f.d = true; return f; };
let syncDepth = 0;
const isPrimitive = v => typeof v === 'function' && v.gbody === undefined && v.gen === undefined;
const cannotBlock = what => new SchemeError('cannot-block', `Cannot wait here${what ? ' for ' + what : ''}: this code runs where its thread cannot be suspended`, []);
/* Run the generator IT to completion here: slices are ignored, a wait is refused. */
function driveSync(it) {
  syncDepth++;
  try {
    let r = it.next();
    while (!r.done) {
      const y = r.value;
      if (y === PREEMPT) r = it.next();
      else r = it.throw(cannotBlock(y instanceof Block ? y.what : y instanceof Suspend ? 'the debugger' : null));
    }
    return r.value;
  } finally { syncDepth--; }
}
const syncNode = (c, env) => c.d ? c(env) : driveSync(c(env));
/* Bind the parameter P to V for the current thread until the returned function is called. */
function bindDyn(p, v) {
  const dyn = TS.dyn, base = dyn.length;
  dyn.push(p, p.value, v); p.value = v;
  return () => { for (let i = dyn.length - 3; i >= base; i -= 3) dyn[i].value = dyn[i + 1]; dyn.length = base; };
}
function* withDynG(p, v, run) { const undo = bindDyn(p, v); try { return yield* run(); } finally { undo(); } }

/* The frame of an application of the compound procedure F to ARGS, pushed on the shadow stack. */
function enterFrame(f, args) {
  const n = args.length, nReq = f.arity, nOpt = f.optional, hasRest = f.rest;
  if (n < nReq || (!hasRest && n > nReq + nOpt)) throw new SchemeError('wrong-number-of-arguments', `${f.procName || 'procedure'}: expected ${hasRest ? 'at least ' : ''}${nReq}${nOpt && !hasRest ? '..' + (nReq + nOpt) : ''} argument${nReq === 1 ? '' : 's'}, got ${n}`);
  const frame = new Array(f.scope.size);
  frame[0] = f.env;
  for (let i = 0; i < nReq + nOpt; i++) frame[i + 1] = i < n ? args[i] : false;
  if (hasRest) frame[nReq + nOpt + 1] = n > nReq + nOpt ? listOf(args.slice(nReq + nOpt)) : NIL;
  if (SHADOW) {
    const t = sp; if (t > depthLimit) depthExceeded();
    const b = t * 3; ST[b] = f; ST[b + 1] = site; ST[b + 2] = frame; sp = t + 1;
  }
  return frame;
}
function* depthExceededG() {
  const e = new SchemeError('recursion-depth', 'Recursion too deep', []);
  if (depthLimit > MAX_DEPTH) throw e;
  depthLimit = MAX_DEPTH + DEPTH_SLACK;
  try { return yield* signalG(e, false); } finally { depthLimit = MAX_DEPTH; }
}
/* A compound procedure whose body node is direct runs here, in a plain function (V8 optimises its
   loops, which it does not do inside a generator), through tail calls to such procedures, until the
   value, a tail call to anything else, or the end of the slice: the generator that called then yields.
   PREEMPT_DUE carries that last case to it. */
let preemptDue = false;
function runD(f, args, l) {
  for (;;) {
    if (SHADOW) { site = l; siteProc = f; }
    const t = sp, frame = enterFrame(f, args);
    const r = f.gbody(frame);
    sp = t;
    if (!(r instanceof TailCall)) return r;
    const h = r.f;
    if (typeof h !== 'function' || h.gbody === undefined || !h.gbody.d) return r;
    if (tick()) { preemptDue = true; return r; }
    f = h; args = r.args; if (r.loc) l = r.loc;
  }
}
/* Apply F to ARGS in generator mode, running tail calls; LOC is the call site. */
function* applyG(f, args, loc) {
  const s = sp; let l = loc === undefined ? (s === 1 ? null : site) : loc;
  try {
    for (;;) {
      let r;
      if (typeof f === 'function') {
        const run = f.gbody;
        if (run !== undefined) {
          if (tick()) yield PREEMPT;
          if (SHADOW && sp > depthLimit) yield* depthExceededG();
          if (run.d) { r = runD(f, args, l); if (preemptDue) { preemptDue = false; yield PREEMPT; } }
          else {
            if (SHADOW) { site = l; siteProc = f; }
            const t = sp, frame = enterFrame(f, args);
            r = yield* run(frame);
            sp = t;
          }
        } else {
          if (SHADOW) { site = l; siteProc = f; }
          r = f.gen !== undefined ? yield* f.gen(args) : f(args);
        }
      } else r = callProc(f, args);
      if (!(r instanceof TailCall)) return r;
      f = r.f; args = r.args; if (r.loc) l = r.loc;
    }
  } catch (e) { yield* unwoundG(e, s); }
}
/* The debugger hook (hooks.debugG, a generator function) sees a condition no handler took, once, on a
   thread the scheduler can hold; it returns {value} to continue a continuable condition, undefined
   to let the condition propagate, or throws (an Unwind to a restart). */
function* debugG(r, continuable) {
  if (r.debugged || syncDepth !== 0 || !TS.canSuspend || !hooks.debugG) return undefined;
  if (isPassive(r instanceof Raise ? r.obj : r)) return undefined;
  r.debugged = true;
  return yield* hooks.debugG(r, continuable);
}
function* unwoundG(e, s) {
  if (e instanceof SchemeError) {
    if (!e.signalled) yield* signalG(e, false);
    if (e.shadow === undefined) e.shadow = snapshot();
    yield* debugG(e, false);
    if (handlers === null) e.signalled = false;
  } else if (e instanceof Raise) { if (e.shadow === undefined) e.shadow = snapshot(); yield* debugG(e, false); }
  sp = s;
  throw e;
}
function* signalG(obj, continuable) {
  const top = handlers;
  if (obj instanceof SchemeError) { obj.signalled = true; if (obj.shadow === undefined) obj.shadow = snapshot(); }
  if (top !== null) {
    const passive = isPassive(obj);
    try {
      for (let n = top; n !== null; n = n.next) {
        if (passive && !n.js) continue;
        handlers = n.next;
        let v;
        try { v = n.js ? n.h(obj, continuable) : yield* applyG(n.h, [obj]); }
        catch (e) { if (e instanceof SchemeError || e instanceof Raise) e.signalled = true; throw e; }
        if (n.js && v === DECLINE) continue;
        if (continuable) return v;
        yield* signalG(new SchemeError('error', 'Exception handler returned from a non-continuable raise of ' + (obj instanceof SchemeError ? errorMessage(obj) : write(obj)), [obj]), false);
      }
    } finally { handlers = top; }
  }
  let r = obj;
  if (!(obj instanceof SchemeError)) { r = new Raise(obj, continuable); r.signalled = true; r.shadow = snapshot(); }
  const d = yield* debugG(r, continuable);
  if (d !== undefined && continuable) return d.value;
  throw r;
}
function* establishG(rs, tag, run) {
  const saved = restarts, s = sp;
  let chain = saved;
  for (let i = rs.length - 1; i >= 0; i--) chain = { r: rs[i], next: chain };
  restarts = chain;
  try { return yield* run(); }
  catch (e) {
    if (!(e instanceof Unwind) || e.tag !== tag) throw e;
    sp = s; restarts = saved;
    const r = e.a;
    if (r.js) return r.fn(...e.b);
    return yield* applyG(r.fn, e.b);
  } finally { restarts = saved; }
}
function* withRestartsG(specs, run) {
  const tag = {};
  return yield* establishG(specs.map(s => s instanceof Restart ? s : new Restart(restartName(s.name), s.report, s.interactive, s.fn, tag, true)), tag, run);
}
function* unboundRefG(box, name) {
  const tag = {};
  siteProc = null;
  const need = v => { if (v === undefined) throw new SchemeError('wrong-number-of-arguments', name + ': the restart needs a value', []); return v; };
  return yield* establishG([
    new Restart(USE_VALUE, `Specify a value to use instead of ${name}.`, null, v => need(v), tag, true),
    new Restart(STORE_VALUE, `Define ${name} to a given value.`, null, v => { box.value = need(v); return v; }, tag, true),
  ], tag, function* () { return yield* signalG(new SchemeError('unbound-variable', `Unbound variable: ${name}`, [intern(name)]), false); });
}

/* ---------- the compiler, generator mode ---------- */
function compG(x, scope, tail) {
  if (isId(x)) { if (isKeyword(baseName(x))) return D1(K(baseName(x))); return compRefG(x, scope); }
  if (!(x instanceof Pair)) { if (x === NIL) throw new SchemeError('syntax-error', 'Empty combination ()'); return D1(K(x)); }
  const head = x.car;
  const m = macroFor(scope, head);
  if (m && scan) scan.macros.push([head, lookup(scope, head)]);
  if (m) {
    const exp = expandMacro(m, x, scope);
    if (exp instanceof Pair && !locs.has(exp)) { const l = locs.get(x); if (l) locs.set(exp, l); }
    return compG(exp, scope, tail);
  }
  const sf = special(scope, head);
  if (sf) return compSpecialG(sf, x, scope, tail);
  return compCallG(x, scope, tail);
}
function compRefG(id, scope) {
  const d = compRef(id, scope);
  if (lookup(scope, id)) return D1(d);
  const name = baseName(id).name, box = gbox(name);
  /* A box with an accessor (a magic variable) is read only at run time. */
  const desc = Object.getOwnPropertyDescriptor(box, 'value');
  if (desc && desc.get) return D1(d);
  if (box.value !== undefined) { const c = D1(d); c.gbox = box; return c; }
  const c = function* () { const v = box.value; return v !== undefined ? v : yield* unboundRefG(box, name); };
  c.box = box; c.vname = name;
  return c;
}
function compSetG(id, vc, scope, define) {
  const st = compStore(id, scope, define);
  if (vc.d) return D1(env => st(env, vc(env)));
  return function* (env) { return st(env, yield* vc(env)); };
}
function bodyG(forms, scope, tail) {
  const list = arr(forms);
  if (!list.length) return D1(K(UNSPEC));
  scanDefines(list, scope);
  const compiled = [];
  for (let i = 0; i < list.length; i++) compiled.push(compG(list[i], scope, tail && i === list.length - 1));
  if (compiled.length === 1) return compiled[0];
  const n = compiled.length - 1;
  if (compiled.every(c => c.d)) return D1(env => { for (let i = 0; i < n; i++) compiled[i](env); return compiled[n](env); });
  return function* (env) {
    for (let i = 0; i < n; i++) { const c = compiled[i]; if (c.d) c(env); else yield* c(env); }
    const c = compiled[n]; return c.d ? c(env) : yield* c(env);
  };
}
function compCallG(form, scope, tail) {
  const fc = compG(form.car, scope, false);
  const argcs = arr(form.cdr).map(a => compG(a, scope, false));
  const n = argcs.length, loc = locs.get(form) || null;
  const argsD = argcs.every(c => c.d);
  if (fc.d && argsD) {
    if (tail) {
      const [a0, a1, a2] = argcs;
      if (n === 0) return D1(env => new TailCall(fc(env), [], loc));
      if (n === 1) return D1(env => new TailCall(fc(env), [a0(env)], loc));
      if (n === 2) return D1(env => new TailCall(fc(env), [a0(env), a1(env)], loc));
      if (n === 3) return D1(env => new TailCall(fc(env), [a0(env), a1(env), a2(env)], loc));
      return D1(env => { const f = fc(env), args = []; for (let i = 0; i < n; i++) args.push(argcs[i](env)); return new TailCall(f, args, loc); });
    }
    const box = fc.gbox;
    if (box !== undefined && isPrimitive(box.value)) {
      /* A call to a primitive runs in place; if the global is rebound to a compound procedure later,
         the call still works but cannot hold the thread. */
      const prim = box.value;
      const [a0, a1, a2] = argcs;
      const evalArgs = n === 0 ? () => [] : n === 1 ? env => [a0(env)] : n === 2 ? env => [a0(env), a1(env)] : n === 3 ? env => [a0(env), a1(env), a2(env)]
        : env => { const args = new Array(n); for (let i = 0; i < n; i++) args[i] = argcs[i](env); return args; };
      return D1(env => {
        const f = box.value, args = evalArgs(env);
        if (f !== prim) return callProc(f, args);
        /* With a handler installed, an error the primitive throws reaches it here, before anything
           unwinds (R4.31); that handler runs in place and cannot hold the thread. */
        if (handlers !== null) return callGuarded(f, args, loc);
        if (SHADOW) { site = loc; siteProc = f; }
        let r = f(args);
        while (r instanceof TailCall) r = callProc(r.f, r.args);
        return r;
      });
    }
  }
  const hbox = fc.box, hname = fc.vname;
  const [c0, c1, c2] = argcs;
  return function* (env) {
    let f;
    if (hbox !== undefined) { f = hbox.value; if (f === undefined) f = yield* unboundRefG(hbox, hname); }
    else f = fc.d ? fc(env) : yield* fc(env);
    /* Argument arrays are literals where they can be: a filled new Array(n) is holey and slow. */
    let args;
    if (n === 0) args = [];
    else if (n === 1) args = [c0.d ? c0(env) : yield* c0(env)];
    else if (n === 2) args = [c0.d ? c0(env) : yield* c0(env), c1.d ? c1(env) : yield* c1(env)];
    else if (n === 3) args = [c0.d ? c0(env) : yield* c0(env), c1.d ? c1(env) : yield* c1(env), c2.d ? c2(env) : yield* c2(env)];
    else { args = []; for (let i = 0; i < n; i++) { const c = argcs[i]; args.push(c.d ? c(env) : yield* c(env)); } }
    if (tail) return new TailCall(f, args, loc);
    /* applyG, inlined: one generator per call instead of two. */
    const s = sp; let l = loc;
    try {
      for (;;) {
        let r;
        if (typeof f === 'function') {
          const run = f.gbody;
          if (run !== undefined) {
            if (tick()) yield PREEMPT;
            if (SHADOW && sp > depthLimit) yield* depthExceededG();
            if (run.d) { r = runD(f, args, l); if (preemptDue) { preemptDue = false; yield PREEMPT; } }
            else {
              if (SHADOW) { site = l; siteProc = f; }
              const t = sp, frame = enterFrame(f, args);
              r = yield* run(frame);
              sp = t;
            }
          } else {
            if (SHADOW) { site = l; siteProc = f; }
            r = f.gen !== undefined ? yield* f.gen(args) : f(args);
          }
        } else r = callProc(f, args);
        if (!(r instanceof TailCall)) return r;
        f = r.f; args = r.args; if (r.loc) l = r.loc;
      }
    } catch (e) { yield* unwoundG(e, s); }
  };
}
function mapG(c, f) { if (c.d) return D1(env => f(c(env))); return function* (env) { return f(yield* c(env)); }; }
function qqG(x, scope, depth) {
  if (x instanceof Pair) {
    if (isId(x.car) && baseName(x.car) === S.unquote) {
      if (depth === 1) return compG(x.cdr.car, scope, false);
      return mapG(qqG(x.cdr.car, scope, depth - 1), v => list(S.unquote, v));
    }
    if (isId(x.car) && baseName(x.car) === S.quasiquote) return mapG(qqG(x.cdr.car, scope, depth + 1), v => list(S.quasiquote, v));
    const parts = []; let c = x;
    while (c instanceof Pair) {
      if (isId(c.car) && baseName(c.car) === S.unquote) break;
      const item = c.car;
      if (item instanceof Pair && isId(item.car) && baseName(item.car) === S['unquote-splicing'] && depth === 1) parts.push({ splice: true, c: compG(item.cdr.car, scope, false) });
      else parts.push({ splice: false, c: qqG(item, scope, depth) });
      c = c.cdr;
    }
    const tailc = c === NIL ? D1(K(NIL)) : qqG(c, scope, depth);
    const build = (vals, t) => {
      let r = t;
      for (let i = parts.length - 1; i >= 0; i--) {
        if (!parts[i].splice) r = new Pair(vals[i], r);
        else { const items = arr(vals[i]); for (let j = items.length - 1; j >= 0; j--) r = new Pair(items[j], r); }
      }
      return r;
    };
    if (tailc.d && parts.every(p => p.c.d)) return D1(env => build(parts.map(p => p.c(env)), tailc(env)));
    return function* (env) {
      const vals = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) { const c = parts[i].c; vals[i] = c.d ? c(env) : yield* c(env); }
      return build(vals, tailc.d ? tailc(env) : yield* tailc(env));
    };
  }
  if (Array.isArray(x)) return mapG(qqG(listOf(x), scope, depth), arr);
  return D1(K(strip(x)));
}
const bindingsOf = a => arr(a).map(b => b instanceof Pair ? [b.car, b.cdr === NIL ? false : b.cdr.car] : [b, false]);
function compSpecialG(name, x, scope, tail) {
  const a = arr(x.cdr);
  const need = (n, msg) => { if (a.length < n) throw new SchemeError('syntax-error', `${name}: ${msg || 'too few forms'} in ${write(strip(x))}`); };
  switch (name) {
    case 'quote': need(1); return D1(K(strip(a[0])));
    case 'quasiquote': need(1); return qqG(a[0], scope, 1);
    case 'if': {
      need(2);
      const c = compG(a[0], scope, false), t = compG(a[1], scope, tail), e = a.length > 2 ? compG(a[2], scope, tail) : D1(K(UNSPEC));
      if (c.d && t.d && e.d) return D1(env => c(env) !== false ? t(env) : e(env));
      return function* (env) { return (c.d ? c(env) : yield* c(env)) !== false ? (t.d ? t(env) : yield* t(env)) : (e.d ? e(env) : yield* e(env)); };
    }
    case 'define': {
      need(1);
      const target = a[0];
      if (target instanceof Pair) {
        let nameSpec = target.car, params = target.cdr, bodyForms = x.cdr.cdr;
        while (nameSpec instanceof Pair) { bodyForms = list(new Pair(S.lambda, new Pair(params, bodyForms))); params = nameSpec.cdr; nameSpec = nameSpec.car; }
        const lam = makeLambda(params, bodyForms, scope, baseName(nameSpec).name, locs.get(x));
        return D1(compSet(nameSpec, lam, scope, true));
      }
      if (!isId(target)) throw new SchemeError('syntax-error', 'define: bad target ' + write(strip(target)));
      if (a.length === 1) return D1(compSet(target, K(UNSPEC), scope, true));
      let valForm = a[1], doc = null;
      if (typeof valForm === 'string' && a.length > 2) { doc = valForm; valForm = a[2]; }
      const setter = compSetG(target, compG(valForm, scope, false), scope, true);
      if (!doc) return setter;
      const withDoc = (env, r) => { const v = lookupValue(target, scope, env); if (typeof v === 'function') v.doc = doc; else gdoc.set(baseName(target).name, doc); return r; };
      if (setter.d) return D1(env => withDoc(env, setter(env)));
      return function* (env) { return withDoc(env, yield* setter(env)); };
    }
    case 'set!': need(2); return compSetG(a[0], compG(a[1], scope, false), scope, false);
    case 'lambda': need(1); return D1(makeLambda(a[0], x.cdr.cdr, scope, null, locs.get(x)));
    case 'named-lambda': { need(1); const spec = a[0]; return D1(makeLambda(spec.cdr, x.cdr.cdr, scope, baseName(spec.car).name, locs.get(x))); }
    case 'begin': return bodyG(x.cdr, scope, tail);
    case 'let': {
      need(1);
      if (isId(a[0])) {
        const nm = a[0], bindings = arr(a[1]).map(b => b instanceof Pair ? [b.car, b.cdr === NIL ? UNSPEC : b.cdr.car] : [b, UNSPEC]);
        const loopScope = new Scope(scope, [nm]);
        const lam = makeLambda(listOf(bindings.map(b => b[0])), x.cdr.cdr.cdr, loopScope, baseName(nm).name, locs.get(x));
        const inits = bindings.map(b => compG(b[1] === UNSPEC ? false : b[1], scope, false));
        const n = inits.length;
        if (tail && inits.every(c => c.d)) return D1(env => { const frame = [env, null]; const f = lam(frame); frame[1] = f; const args = []; for (let i = 0; i < n; i++) args.push(inits[i](env)); return new TailCall(f, args); });
        return function* (env) {
          const frame = [env, null]; const f = lam(frame); frame[1] = f;
          const args = [];
          for (let i = 0; i < n; i++) { const c = inits[i]; args.push(c.d ? c(env) : yield* c(env)); }
          return tail ? new TailCall(f, args) : yield* applyG(f, args);
        };
      }
      const bindings = bindingsOf(a[0]);
      const inits = bindings.map(b => compG(b[1], scope, false));
      const inner = new Scope(scope, bindings.map(b => b[0]));
      const run = bodyG(x.cdr.cdr, inner, tail);
      const n = inits.length;
      if (run.d && inits.every(c => c.d)) return D1(env => { const frame = new Array(inner.size); frame[0] = env; for (let i = 0; i < n; i++) frame[i + 1] = inits[i](env); return run(frame); });
      return function* (env) {
        const frame = new Array(inner.size); frame[0] = env;
        for (let i = 0; i < n; i++) { const c = inits[i]; frame[i + 1] = c.d ? c(env) : yield* c(env); }
        return run.d ? run(frame) : yield* run(frame);
      };
    }
    case 'let*': {
      need(1);
      const bindings = bindingsOf(a[0]);
      if (!bindings.length) return bodyG(x.cdr.cdr, new Scope(scope, []), tail);
      const inner = new Scope(scope, []);
      const steps = bindings.map(([id, init]) => { const ic = compG(init, inner, false); const slot = inner.add(id); return [slot, ic]; });
      const run = bodyG(x.cdr.cdr, inner, tail);
      if (run.d && steps.every(s => s[1].d)) return D1(env => { const frame = new Array(inner.size); frame[0] = env; for (const [slot, ic] of steps) frame[slot] = ic(frame); return run(frame); });
      return function* (env) {
        const frame = new Array(inner.size); frame[0] = env;
        for (const [slot, ic] of steps) frame[slot] = ic.d ? ic(frame) : yield* ic(frame);
        return run.d ? run(frame) : yield* run(frame);
      };
    }
    case 'letrec': case 'letrec*': {
      need(1);
      const bindings = arr(a[0]).map(b => [b.car, b.cdr === NIL ? false : b.cdr.car]);
      const inner = new Scope(scope, bindings.map(b => b[0]));
      const names = bindings.map(([id]) => baseName(id).name);
      const inits = bindings.map(([, init]) => compG(init, inner, false));
      const run = bodyG(x.cdr.cdr, inner, tail);
      const nameIt = (v, i) => { if (typeof v === 'function' && !v.procName) v.procName = names[i]; return v; };
      if (run.d && inits.every(c => c.d)) return D1(env => { const frame = new Array(inner.size); frame[0] = env; for (let i = 0; i < inits.length; i++) frame[i + 1] = nameIt(inits[i](frame), i); return run(frame); });
      return function* (env) {
        const frame = new Array(inner.size); frame[0] = env;
        for (let i = 0; i < inits.length; i++) { const c = inits[i]; frame[i + 1] = nameIt(c.d ? c(frame) : yield* c(frame), i); }
        return run.d ? run(frame) : yield* run(frame);
      };
    }
    case 'cond': {
      const clauses = a.map(cl => {
        const c = arr(cl);
        if (isId(c[0]) && baseName(c[0]) === S.else) return { els: bodyG(cl.cdr, scope, tail) };
        if (c.length > 1 && isId(c[1]) && baseName(c[1]) === S['=>']) return { test: compG(c[0], scope, false), arrow: compG(c[2], scope, false) };
        return { test: compG(c[0], scope, false), run: c.length > 1 ? bodyG(cl.cdr, scope, tail) : null };
      });
      const allD = clauses.every(cl => (!cl.els || cl.els.d) && (!cl.test || cl.test.d) && (!cl.run || cl.run.d) && !cl.arrow);
      if (allD) return D1(env => { for (const cl of clauses) { if (cl.els) return cl.els(env); const v = cl.test(env); if (v !== false) return cl.run ? cl.run(env) : v; } return UNSPEC; });
      return function* (env) {
        for (const cl of clauses) {
          if (cl.els) return cl.els.d ? cl.els(env) : yield* cl.els(env);
          const v = cl.test.d ? cl.test(env) : yield* cl.test(env);
          if (v !== false) {
            if (cl.arrow) { const f = cl.arrow.d ? cl.arrow(env) : yield* cl.arrow(env); return tail ? new TailCall(f, [v]) : yield* applyG(f, [v]); }
            return cl.run ? (cl.run.d ? cl.run(env) : yield* cl.run(env)) : v;
          }
        }
        return UNSPEC;
      };
    }
    case 'case': {
      need(1);
      const keyc = compG(a[0], scope, false);
      const clauses = a.slice(1).map(cl => {
        const c = arr(cl);
        const els = isId(c[0]) && baseName(c[0]) === S.else;
        const data = els ? null : arr(strip(c[0]));
        if (c.length > 1 && isId(c[1]) && baseName(c[1]) === S['=>']) return { els, data, arrow: compG(c[2], scope, false) };
        return { els, data, run: bodyG(cl.cdr, scope, tail) };
      });
      const hit = (cl, k) => cl.els || cl.data.some(d => eqv(d, k));
      if (keyc.d && clauses.every(cl => !cl.arrow && cl.run.d)) return D1(env => { const k = keyc(env); for (const cl of clauses) if (hit(cl, k)) return cl.run(env); return UNSPEC; });
      return function* (env) {
        const k = keyc.d ? keyc(env) : yield* keyc(env);
        for (const cl of clauses) {
          if (hit(cl, k)) {
            if (cl.arrow) { const f = cl.arrow.d ? cl.arrow(env) : yield* cl.arrow(env); return tail ? new TailCall(f, [k]) : yield* applyG(f, [k]); }
            return cl.run.d ? cl.run(env) : yield* cl.run(env);
          }
        }
        return UNSPEC;
      };
    }
    case 'and': {
      if (!a.length) return D1(K(true));
      const cs = a.map((e, i) => compG(e, scope, tail && i === a.length - 1));
      if (cs.every(c => c.d)) return D1(env => { let v = true; for (let i = 0; i < cs.length; i++) { v = cs[i](env); if (v === false) return false; } return v; });
      return function* (env) { let v = true; for (let i = 0; i < cs.length; i++) { const c = cs[i]; v = c.d ? c(env) : yield* c(env); if (v === false) return false; } return v; };
    }
    case 'or': {
      if (!a.length) return D1(K(false));
      const cs = a.map((e, i) => compG(e, scope, tail && i === a.length - 1));
      if (cs.every(c => c.d)) return D1(env => { for (let i = 0; i < cs.length; i++) { const v = cs[i](env); if (v !== false) return v; } return false; });
      return function* (env) { for (let i = 0; i < cs.length; i++) { const c = cs[i]; const v = c.d ? c(env) : yield* c(env); if (v !== false) return v; } return false; };
    }
    case 'when': case 'unless': {
      need(1);
      const c = compG(a[0], scope, false), run = bodyG(x.cdr.cdr, scope, tail), want = name === 'when';
      if (c.d && run.d) return D1(env => (c(env) !== false) === want ? run(env) : UNSPEC);
      return function* (env) { return ((c.d ? c(env) : yield* c(env)) !== false) === want ? (run.d ? run(env) : yield* run(env)) : UNSPEC; };
    }
    case 'do': {
      need(2);
      const specs = arr(a[0]).map(s => { const ss = arr(s); return { id: ss[0], init: ss[1], step: ss.length > 2 ? ss[2] : null }; });
      const inner = new Scope(scope, specs.map(s => s.id));
      const inits = specs.map(s => compG(s.init, scope, false));
      const steps = specs.map(s => s.step === null ? null : compG(s.step, inner, false));
      const endSpec = arr(a[1]);
      const test = compG(endSpec[0], inner, false), result = bodyG(a[1].cdr, inner, false);
      const cmds = bodyG(x.cdr.cdr.cdr, inner, false);
      if (test.d && result.d && cmds.d && steps.every(c => c === null || c.d)) {
        /* Every part is direct: the loop runs in a plain function until it ends or the slice is over. */
        const loop = (frame, env, out) => {
          for (;;) {
            if (test(frame) !== false) { out[0] = result(frame); return null; }
            if (tick()) return frame;
            cmds(frame);
            const next = new Array(inner.size); next[0] = env;
            for (let i = 0; i < steps.length; i++) next[i + 1] = steps[i] ? steps[i](frame) : frame[i + 1];
            frame = next;
          }
        };
        return function* (env) {
          let frame = new Array(inner.size); frame[0] = env;
          for (let i = 0; i < inits.length; i++) { const c = inits[i]; frame[i + 1] = c.d ? c(env) : yield* c(env); }
          const out = [UNSPEC];
          while ((frame = loop(frame, env, out)) !== null) yield PREEMPT;
          return out[0];
        };
      }
      return function* (env) {
        let frame = new Array(inner.size); frame[0] = env;
        for (let i = 0; i < inits.length; i++) { const c = inits[i]; frame[i + 1] = c.d ? c(env) : yield* c(env); }
        for (;;) {
          if ((test.d ? test(frame) : yield* test(frame)) !== false) return result.d ? result(frame) : yield* result(frame);
          if (tick()) yield PREEMPT;
          if (cmds.d) cmds(frame); else yield* cmds(frame);
          const next = new Array(inner.size); next[0] = env;
          for (let i = 0; i < steps.length; i++) { const c = steps[i]; next[i + 1] = c === null ? frame[i + 1] : c.d ? c(frame) : yield* c(frame); }
          frame = next;
        }
      };
    }
    case 'define-syntax': case 'let-syntax': case 'letrec-syntax': {
      if (name === 'define-syntax') {
        need(2);
        const id = a[0], spec = a[1];
        let m;
        if (spec instanceof Pair && isId(spec.car) && baseName(spec.car) === S['syntax-rules']) m = parseRules(spec, scope);
        else { const pc = compG(spec, scope, false); m = { kind: 'proc', proc: null, lazy: env => syncNode(pc, env) }; }
        if (scope) { if (!scope.macros) scope.macros = new Map(); if (m.lazy) { m.proc = m.lazy(null); } scope.macros.set(id, m); }
        else { if (m.lazy) m.proc = m.lazy(null); m.src = strip(x); macros.set(baseName(id).name, m); }
        return D1(K(baseName(id)));
      }
      const inner = new Scope(scope, []); inner.macros = new Map();
      for (const b of arr(a[0])) { const bb = arr(b); inner.macros.set(bb[0], parseRules(bb[1], name === 'letrec-syntax' ? inner : scope)); }
      const run = bodyG(x.cdr.cdr, inner, tail);
      if (run.d) return D1(env => run([env]));
      return function* (env) { return yield* run([env]); };
    }
    case 'define-macro': {
      need(2);
      const target = a[0];
      const nameId = target instanceof Pair ? target.car : target;
      const proc = target instanceof Pair ? makeLambda(target.cdr, x.cdr.cdr, scope, baseName(nameId).name, locs.get(x))(null) : syncNode(compG(a[1], scope, false), null);
      const m = { kind: 'proc', proc };
      if (scope) { if (!scope.macros) scope.macros = new Map(); scope.macros.set(nameId, m); } else { m.src = strip(x); macros.set(baseName(nameId).name, m); }
      return D1(K(baseName(nameId)));
    }
    case 'parameterize': {
      need(1);
      const bs = arr(a[0]).map(b => { const bb = arr(b); return [compG(bb[0], scope, false), compG(bb[1], scope, false)]; });
      const run = bodyG(x.cdr.cdr, scope, false);
      return function* (env) {
        const ps = [];
        for (const [pc, vc] of bs) {
          const p = pc.d ? pc(env) : yield* pc(env);
          if (!(p instanceof Param)) throw typeErr('parameter', p, 'parameterize');
          ps.push([p, vc.d ? vc(env) : yield* vc(env)]);
        }
        const dyn = TS.dyn, base = dyn.length;
        for (const [p, v] of ps) { const nv = p.converter ? yield* applyG(p.converter, [v]) : v; dyn.push(p, p.value, nv); p.value = nv; }
        try { return run.d ? run(env) : yield* run(env); }
        finally { for (let i = dyn.length - 3; i >= base; i -= 3) dyn[i].value = dyn[i + 1]; dyn.length = base; }
      };
    }
    case 'guard': {
      need(2);
      const spec = a[0], v = spec.car;
      const inner = new Scope(scope, [v]);
      const cls = arr(spec.cdr).map(cl => {
        const c = arr(cl);
        if (isId(c[0]) && baseName(c[0]) === S.else) return { test: null, run: bodyG(cl.cdr, inner, false) };
        if (c.length > 2 && isId(c[1]) && baseName(c[1]) === S['=>']) return { test: compG(c[0], inner, false), arrow: compG(c[2], inner, false) };
        return { test: compG(c[0], inner, false), run: c.length > 1 ? bodyG(cl.cdr, inner, false) : null };
      });
      const run = bodyG(x.cdr.cdr, scope, false);
      return function* (env) {
        const tag = {};
        /* The clause tests run in the handler, where the condition was raised, so they cannot hold the thread. */
        const choose = obj => {
          if (isPassive(obj)) return null;
          const frame = [env, obj];
          for (let i = 0; i < cls.length; i++) { const t = cls[i].test; if (!t) return [i, true]; const tv = syncNode(t, frame); if (tv !== false) return [i, tv]; }
          return null;
        };
        const saved = handlers, s = sp;
        handlers = { h: obj => { const c = choose(obj); if (!c) return DECLINE; throw new Unwind(tag, obj, c); }, js: true, next: saved };
        let obj, c;
        try { return run.d ? run(env) : yield* run(env); }
        catch (e) {
          if (e instanceof Unwind && e.tag === tag) { obj = e.a; c = e.b; }
          else if (e instanceof Escape || e instanceof Unwind || ((e instanceof SchemeError || e instanceof Raise) && e.signalled)) throw e;
          else if (e instanceof RangeError) {
            handlers = saved;
            obj = new SchemeError('recursion-depth', `Recursion too deep: the JavaScript stack ran out at depth ${Math.max(0, sp - 1)}`, []);
            sp = s;
            c = choose(obj);
            if (!c) throw e;
          } else if (e instanceof SchemeError) {
            try { yield* signalG(e, false); } catch (e2) { if (e2 instanceof Unwind && e2.tag === tag) { obj = e2.a; c = e2.b; } else throw e2; }
          } else {
            handlers = saved; sp = s;
            obj = e instanceof Raise ? e.obj : e;
            c = choose(obj);
            if (!c) throw e;
          }
        } finally { handlers = saved; }
        sp = s;
        const frame = [env, obj], cl = cls[c[0]];
        if (cl.arrow) return yield* applyG(cl.arrow.d ? cl.arrow(frame) : yield* cl.arrow(frame), [c[1]]);
        return cl.run ? (cl.run.d ? cl.run(frame) : yield* cl.run(frame)) : c[1];
      };
    }
    case 'define-record-type': {
      need(3);
      const typeName = a[0] instanceof Pair ? a[0].car : a[0];
      let printerc = null;
      if (a[0] instanceof Pair) { const o = arr(a[0].cdr); for (let i = 0; i + 1 < o.length; i += 2) if (isId(o[i]) && baseName(o[i]).name === ':printer') printerc = compG(o[i + 1], scope, false); }
      const ctorSpec = a[1], predName = a[2], fields = a.slice(3).map(f => arr(f));
      const fieldNames = fields.map(f => baseName(f[0]));
      const rt = new RecordType(baseName(typeName).name, fieldNames.map(s => s.name));
      rt.src = strip(x);
      const tag = f => { f.recordType = rt; return f; };
      const defs = [];
      defs.push([typeName, K(rt)]);
      if (ctorSpec instanceof Pair) {
        const ctorName = ctorSpec.car, ctorFields = arr(ctorSpec.cdr).map(baseName);
        const idx = ctorFields.map(f => fieldNames.indexOf(f));
        defs.push([ctorName, K(tag(named(arity(args => { const r = new Record(rt, new Array(fieldNames.length).fill(false)); idx.forEach((k, i) => { r.fields[k] = args[i]; }); return r; }, idx.length), baseName(ctorName).name)))]);
      } else if (isId(ctorSpec)) defs.push([ctorSpec, K(tag(named(args => new Record(rt, args.slice()), baseName(ctorSpec).name)))]);
      defs.push([predName, K(tag(named(arity(args => args[0] instanceof Record && args[0].type === rt, 1), baseName(predName).name)))]);
      fields.forEach((f, k) => {
        if (f[1]) defs.push([f[1], K(tag(named(arity(args => { if (!(args[0] instanceof Record) || args[0].type !== rt) throw typeErr(rt.name, args[0], baseName(f[1]).name); return args[0].fields[k]; }, 1), baseName(f[1]).name)))]);
        if (f[2]) defs.push([f[2], K(tag(named(arity(args => { if (!(args[0] instanceof Record) || args[0].type !== rt) throw typeErr(rt.name, args[0], baseName(f[2]).name); args[0].fields[k] = args[1]; return UNSPEC; }, 2), baseName(f[2]).name)))]);
      });
      const setters = defs.map(([id, vc]) => compSet(id, vc, scope, true));
      return D1(env => { if (printerc) rt.printer = syncNode(printerc, env); for (const s of setters) s(env); return baseName(typeName); });
    }
    case 'let-values': case 'receive': case 'define-values': {
      if (name === 'receive') {
        need(2);
        const formals = a[0], prodc = compG(a[1], scope, false);
        const { names, rest } = parseParams(formals);
        const all = rest ? [...names, rest] : names;
        const inner = new Scope(scope, all);
        const run = bodyG(x.cdr.cdr.cdr, inner, tail);
        return function* (env) {
          const v = prodc.d ? prodc(env) : yield* prodc(env);
          const vals = v instanceof Values ? v.vals : [v];
          const frame = new Array(inner.size); frame[0] = env;
          for (let i = 0; i < names.length; i++) frame[i + 1] = vals[i];
          if (rest) frame[names.length + 1] = listOf(vals.slice(names.length));
          return run.d ? run(frame) : yield* run(frame);
        };
      }
      if (name === 'define-values') {
        need(2);
        const formals = arr(a[0]), prodc = compG(a[1], scope, false);
        const setters = formals.map((id, i) => compSet(id, env => env.__vals[i], scope, true));
        return function* (env) {
          const v = prodc.d ? prodc(env) : yield* prodc(env);
          const vals = v instanceof Values ? v.vals : [v];
          const e2 = env || []; const saved = e2.__vals; e2.__vals = vals;
          try { for (const s of setters) s(e2); } finally { e2.__vals = saved; }
          return UNSPEC;
        };
      }
      need(1);
      const bs = arr(a[0]).map(b => { const bb = arr(b); return { formals: parseParams(bb[0]), prod: compG(bb[1], scope, false) }; });
      const all = []; bs.forEach(b => { all.push(...b.formals.names); if (b.formals.rest) all.push(b.formals.rest); });
      const inner = new Scope(scope, all);
      const run = bodyG(x.cdr.cdr, inner, tail);
      return function* (env) {
        const frame = new Array(inner.size); frame[0] = env; let k = 1;
        for (const b of bs) {
          const v = b.prod.d ? b.prod(env) : yield* b.prod(env);
          const vals = v instanceof Values ? v.vals : [v];
          for (let i = 0; i < b.formals.names.length; i++) frame[k++] = vals[i];
          if (b.formals.rest) frame[k++] = listOf(vals.slice(b.formals.names.length));
        }
        return run.d ? run(frame) : yield* run(frame);
      };
    }
    case 'assert': {
      need(1);
      const c = compG(a[0], scope, false); const src = write(strip(a[0]));
      return function* (env) { if ((c.d ? c(env) : yield* c(env)) === false) { siteProc = null; yield* signalG(new SchemeError('assertion-failed', 'Assertion failed: ' + src), false); } return true; };
    }
    case 'delay': {
      need(1);
      const c = compG(a[0], scope, false);
      return D1(env => {
        let done = false, v;
        const p = () => { if (!done) { v = syncNode(c, env); done = true; } return v; };
        p.isPromise = true;
        p.gen = function* () { if (!done) { v = c.d ? c(env) : yield* c(env); done = true; } return v; };
        return p;
      });
    }
    case 'case-lambda': {
      const clauses = a.map(cl => makeLambda(cl.car, cl.cdr, scope, null, locs.get(cl) || locs.get(x)));
      return D1(env => {
        const fs = clauses.map(c => c(env));
        const pick = args => { for (const g of fs) if (args.length === g.arity || (g.rest && args.length >= g.arity) || (args.length >= g.arity && args.length <= g.arity + (g.optional || 0))) return g; throw new SchemeError('wrong-number-of-arguments', 'case-lambda: no clause for ' + args.length + ' arguments'); };
        const f = args => pick(args)(args);
        f.gen = function* (args) { return yield* applyG(pick(args), args); };
        return f;
      });
    }
    case 'the-environment': return D1(scope ? env => new Environment(scope, env) : K(GLOBAL_ENV));
    case 'include': {
      const forms = [];
      for (const f of a) { const file = str(strip(f), 'include'); forms.push(...readAll(readFileText(file), file)); }
      return bodyG(listOf(forms), scope, tail);
    }
  }
  throw new SchemeError('syntax-error', 'Unknown special form ' + name);
}

function lookupValue(id, scope, env) {
  const r = lookup(scope, id);
  if (r && !r.macro) { let e = env; for (let d = 0; d < r.depth; d++) e = e[0]; return e[r.index]; }
  return globals.get(baseName(id).name)?.value;
}
const gdoc = new Map();
/* Host hooks: output(string) for the console port, errorOutput(string) for current-error-port,
   isQuit(condition), readFile(path) -> string or null for load/include/require, and
   restartArgs(restart) -> array for invoke-restart-interactively. */
const hooks = { isQuit: null, output: null, errorOutput: null, readFile: null, restartArgs: null, threadSwitch: null, debugG: null };

/* ---------- evaluation entry points ---------- */
let steps = 0;
function evalForm(form) {
  if (GEN) return driveSync(evalFormG(form));
  const s = sp;
  try { const c = comp(form, null, false); return c(null); } catch (e) { return unwound(e, s); }
}
/* Evaluate FORM in ENV (an Environment): definitions bind in ENV's own frame. */
function evalIn(form, env) {
  if (GEN) return driveSync(evalInG(form, env));
  if (env === undefined || env === null || env === GLOBAL_ENV) return evalForm(form);
  if (!(env instanceof Environment)) throw typeErr('environment', env, 'eval');
  const s = sp;
  try { const c = body(new Pair(form, NIL), env.scope, false); return c(env.frame); } catch (e) { return unwound(e, s); }
}
/* The same as generators, for a thread (generator mode). */
function* evalFormG(form) {
  const s = sp;
  try { const c = compG(form, null, false); return c.d ? c(null) : yield* c(null); } catch (e) { yield* unwoundG(e, s); }
}
function* evalInG(form, env) {
  if (env === undefined || env === null || env === GLOBAL_ENV) return yield* evalFormG(form);
  if (!(env instanceof Environment)) throw typeErr('environment', env, 'eval');
  const s = sp;
  try { const c = bodyG(new Pair(form, NIL), env.scope, false); return c.d ? c(env.frame) : yield* c(env.frame); } catch (e) { yield* unwoundG(e, s); }
}
function* loadFileG(path, env) {
  for (const f of readAll(readFileText(path), path)) yield* evalInG(f, env);
  return true;
}
/* Switch the compiler between 'direct' (frames) and 'gen' (edwind); the prelude is recompiled so its
   procedures are of the new kind. Code compiled before keeps working: a direct-mode procedure called
   from a thread runs in place and cannot hold it. */
function setMode(mode) {
  if (mode !== 'gen' && mode !== 'direct') throw new Error('Scheme.setMode: unknown mode ' + mode);
  const was = GEN;
  GEN = mode === 'gen'; TICK_MASK = GEN ? 0xFFF : 0x3FFFF;
  if (was !== GEN) evalString(PRELUDE);
}
/* Compile FORM in SCOPE only to see what it uses: { scopes, refs: [[id, lookup result or null]],
   macros: [[keyword, lookup result or null]] }. The scopes are the ones FORM binds itself. */
function scanClosure(form, scope) {
  const prev = scan, out = { scopes: new Set(), refs: [], macros: [] };
  scan = out;
  try { comp(form, scope, false); } finally { scan = prev; }
  return out;
}
function evalString(src, file) { let v = UNSPEC; for (const f of readAll(src, file)) v = evalForm(f); return v; }
function readFileText(path) {
  if (!hooks.readFile) throw new SchemeError('file-error', 'Cannot read ' + path + ': no file reader is installed', [path]);
  const t = hooks.readFile(path);
  if (t === null || t === undefined || t === false) throw new SchemeError('file-error', 'Cannot open file: ' + path, [path]);
  return String(t);
}
/* Read PATH through hooks.readFile and evaluate its forms in ENV; the forms carry PATH. */
function loadFile(path, env) {
  for (const f of readAll(readFileText(path), path)) evalIn(f, env);
  return true;
}

/* ---------- builtins ---------- */
function def(name, fn, opts) {
  fn.procName = name;
  if (opts) { if (opts.doc) fn.doc = opts.doc; if (opts.args) fn.params = opts.args; if (opts.interactive !== undefined) fn.interactive = opts.interactive; }
  gdef(name, fn); return fn;
}
const D = (name, args, doc, fn) => def(name, fn, { args, doc });
/* NUM gives a double (a BigInt converts); INT an integer double (a BigInt is out of range there). */
const num = (x, who) => { if (typeof x === 'number') return x; if (typeof x === 'bigint') return Number(x); throw typeErr('number', x, who); };
const int = (x, who) => { if (Number.isInteger(x)) return x; if (typeof x === 'bigint') throw new SchemeError('range-error', `${who ? who + ': ' : ''}${x} is out of range`, [x]); throw typeErr('integer', x, who); };
const str = (x, who) => { if (typeof x !== 'string') throw typeErr('string', x, who); return x; };
const sym = (x, who) => { if (!(x instanceof Sym)) throw typeErr('symbol', x, who); return x; };
const chr = (x, who) => { if (!(x instanceof Char)) throw typeErr('char', x, who); return x; };
const vec = (x, who) => { if (!Array.isArray(x)) throw typeErr('vector', x, who); return x; };
const proc = (x, who) => { if (typeof x !== 'function' && !(x instanceof Param)) throw typeErr('procedure', x, who); return x; };
const ht = (x, who) => { if (!(x instanceof Map)) throw typeErr('hash table', x, who); return x; };
const opt = (x, d) => x === undefined ? d : x;

/* numbers: doubles, with BigInt for exact integers beyond ±2^53 (see norm) */
const BMAX = 9007199254740991n, BMIN = -9007199254740991n;
const isExactInt = x => typeof x === 'bigint' || Number.isSafeInteger(x);
/* A BigInt result back in the safe range becomes a double, so 5 and 5n never meet. */
const norm = b => b <= BMAX && b >= BMIN ? Number(b) : b;
const big = x => typeof x === 'bigint' ? x : BigInt(x);
const numx = (x, who) => { if (typeof x === 'number' || typeof x === 'bigint') return x; throw typeErr('number', x, who); };
const intx = (x, who) => { if (typeof x === 'bigint' || Number.isInteger(x)) return x; throw typeErr('integer', x, who); };
const divz = () => new SchemeError('divide-by-zero', 'Division by zero');
function add(a, b, who) {
  if (typeof a === 'number' && typeof b === 'number') { const r = a + b; if (r <= MAXS && r >= -MAXS) return r; return Number.isSafeInteger(a) && Number.isSafeInteger(b) ? norm(BigInt(a) + BigInt(b)) : r; }
  numx(a, who); numx(b, who);
  return isExactInt(a) && isExactInt(b) ? norm(big(a) + big(b)) : Number(a) + Number(b);
}
function sub(a, b, who) {
  if (typeof a === 'number' && typeof b === 'number') { const r = a - b; if (r <= MAXS && r >= -MAXS) return r; return Number.isSafeInteger(a) && Number.isSafeInteger(b) ? norm(BigInt(a) - BigInt(b)) : r; }
  numx(a, who); numx(b, who);
  return isExactInt(a) && isExactInt(b) ? norm(big(a) - big(b)) : Number(a) - Number(b);
}
function mul(a, b, who) {
  if (typeof a === 'number' && typeof b === 'number') { const r = a * b; if (r <= MAXS && r >= -MAXS) return r; return Number.isSafeInteger(a) && Number.isSafeInteger(b) ? norm(BigInt(a) * BigInt(b)) : r; }
  numx(a, who); numx(b, who);
  return isExactInt(a) && isExactInt(b) ? norm(big(a) * big(b)) : Number(a) * Number(b);
}
function div(a, b) {
  if (typeof a === 'number' && typeof b === 'number') { if (b === 0) throw divz(); return a / b; }
  numx(a, '/'); numx(b, '/');
  if (b === 0) throw divz();
  if (isExactInt(a) && isExactInt(b)) { const A = big(a), B = big(b); if (A % B === 0n) return norm(A / B); }
  return Number(a) / Number(b);
}
const neg = x => typeof x === 'number' ? -x : norm(-numx(x, '-'));
function quotient(a, b, who) {
  if (typeof a === 'number' && typeof b === 'number' && Number.isSafeInteger(a) && Number.isSafeInteger(b)) { if (b === 0) throw divz(); return ((a - a % b) / b) || 0; }
  intx(a, who); intx(b, who);
  if (isExactInt(a) && isExactInt(b)) { const B = big(b); if (B === 0n) throw divz(); return norm(big(a) / B); }
  const y = Number(b); if (y === 0) throw divz(); return Math.trunc(Number(a) / y);
}
function remainder(a, b, who) {
  if (typeof a === 'number' && typeof b === 'number' && Number.isInteger(a) && Number.isInteger(b)) { if (b === 0) throw divz(); return (a % b) || 0; }
  intx(a, who); intx(b, who);
  if (isExactInt(a) && isExactInt(b)) { const B = big(b); if (B === 0n) throw divz(); return norm(big(a) % B); }
  const y = Number(b); if (y === 0) throw divz(); return Number(a) % y;
}
function modulo(a, b, who) {
  if (typeof a === 'number' && typeof b === 'number' && Number.isInteger(a) && Number.isInteger(b)) { if (b === 0) throw divz(); const r = a % b; return r !== 0 && (r < 0) !== (b < 0) ? r + b : r || 0; }
  intx(a, who); intx(b, who);
  if (isExactInt(a) && isExactInt(b)) { const B = big(b); if (B === 0n) throw divz(); const r = big(a) % B; return norm(r !== 0n && (r < 0n) !== (B < 0n) ? r + B : r); }
  const x = Number(a), y = Number(b); if (y === 0) throw divz(); const r = x % y; return r !== 0 && (r < 0) !== (y < 0) ? r + y : r;
}
function gcd2(a, b) {
  if (typeof a === 'number' && typeof b === 'number') { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; }
  let A = big(a), B = big(b); if (A < 0n) A = -A; if (B < 0n) B = -B;
  while (B) [A, B] = [B, A % B];
  return norm(A);
}
const absx = x => typeof x === 'number' ? Math.abs(x) : x < 0n ? -x : x;
function expt(b, e) {
  numx(b, 'expt'); numx(e, 'expt');
  if (isExactInt(b) && isExactInt(e) && e >= 0) {
    if (typeof b === 'number' && typeof e === 'number' && Math.abs(Math.pow(b, e)) < 2 ** 52) {
      let r = 1, x = b, k = e;
      while (k > 0) { if (k % 2 === 1) r *= x; k = Math.floor(k / 2); if (k) x *= x; }
      return r;
    }
    if (b === 0 || b === 1) return b;
    if (b === -1) return big(e) % 2n === 0n ? 1 : -1;
    const bits = Number(e) * Math.log2(Math.abs(Number(b)));
    if (!(bits < 2 ** 24)) throw new SchemeError('range-error', 'expt: the result would be too large', [b, e]);
    return norm(big(b) ** big(e));
  }
  return Math.pow(Number(b), Number(e));
}
function exactOf(x) {
  if (typeof x === 'bigint') return x;
  numx(x, 'exact');
  if (Number.isInteger(x)) return Number.isSafeInteger(x) ? x : BigInt(x);
  return x;   // no rationals: a non-integer stays as it is
}
const inexact = x => typeof x === 'bigint' ? Number(x) : numx(x, 'inexact');
const isNumber = x => typeof x === 'number' || typeof x === 'bigint';
function parseNumber(t) {
  if (/^[+-]?\d+$/.test(t)) { const n = Number(t); return n <= MAXS && n >= -MAXS ? n : BigInt(t[0] === '+' ? t.slice(1) : t); }
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return Number(t);
  if (/^[+-]?\d+\/\d+$/.test(t)) { const [p, q] = t.split('/'); return div(parseNumber(p), parseNumber(q)); }
  if (t === '+inf.0') return Infinity; if (t === '-inf.0') return -Infinity; if (t === '+nan.0' || t === '-nan.0') return NaN;
  return false;
}
function parseRadix(t, r) {
  if (r === 10) return parseNumber(t);
  const m = /^([+-]?)([0-9a-z]+)$/i.exec(t);
  if (!m) return false;
  let b = 0n; const R = BigInt(r);
  for (const ch of m[2].toLowerCase()) { const d = parseInt(ch, 36); if (d >= r) return false; b = b * R + BigInt(d); }
  return norm(m[1] === '-' ? -b : b);
}
const roundEven = x => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; };
D('+', '. numbers', 'Sum of the numbers.', a => { if (a.length === 2) return add(a[0], a[1], '+'); let s = 0; for (let i = 0; i < a.length; i++) s = add(s, a[i], '+'); return s; });
D('*', '. numbers', 'Product of the numbers.', a => { if (a.length === 2) return mul(a[0], a[1], '*'); let s = 1; for (let i = 0; i < a.length; i++) s = mul(s, a[i], '*'); return s; });
D('-', 'n . numbers', 'Negation of one number, or the first minus the rest.', a => { if (a.length === 2) return sub(a[0], a[1], '-'); if (!a.length) throw err('-: expected at least 1 argument'); if (a.length === 1) return neg(a[0]); let s = numx(a[0], '-'); for (let i = 1; i < a.length; i++) s = sub(s, a[i], '-'); return s; });
D('/', 'n . numbers', 'Reciprocal of one number, or the first divided by the rest.', a => { if (!a.length) throw err('/: expected at least 1 argument'); if (a.length === 1) return div(1, a[0]); let s = a[0]; for (let i = 1; i < a.length; i++) s = div(s, a[i]); return s; });
D('quotient', 'a b', 'Integer quotient, truncating toward zero.', ([a, b]) => quotient(a, b, 'quotient'));
D('remainder', 'a b', 'Remainder with the sign of A.', ([a, b]) => remainder(a, b, 'remainder'));
D('modulo', 'a b', 'Modulo with the sign of B.', ([a, b]) => modulo(a, b, 'modulo'));
D('truncate-quotient', 'a b', 'Integer quotient, truncating toward zero.', ([a, b]) => quotient(a, b, 'truncate-quotient'));
D('truncate-remainder', 'a b', 'Remainder with the sign of A.', ([a, b]) => remainder(a, b, 'truncate-remainder'));
D('floor-remainder', 'a b', 'Modulo with the sign of B.', ([a, b]) => modulo(a, b, 'floor-remainder'));
D('floor-quotient', 'a b', 'Integer quotient, rounding toward minus infinity.', ([a, b]) => quotient(sub(a, modulo(a, b, 'floor-quotient'), 'floor-quotient'), b, 'floor-quotient'));
D('abs', 'x', 'Absolute value.', ([x]) => absx(numx(x, 'abs')));
D('magnitude', 'x', 'Absolute value.', ([x]) => absx(numx(x, 'magnitude')));
function minmax(a, who, isMax) {
  if (!a.length) throw err(who + ': expected at least 1 argument');
  let m = numx(a[0], who), inexactSeen = typeof m === 'number' && !Number.isSafeInteger(m);
  for (let i = 1; i < a.length; i++) {
    const v = numx(a[i], who);
    if (typeof v === 'number' && !Number.isSafeInteger(v)) inexactSeen = true;
    if (v !== v) return NaN;
    if (isMax ? v > m : v < m) m = v;
  }
  return inexactSeen && typeof m === 'bigint' ? Number(m) : m;
}
const allNumbers = a => { for (let i = 0; i < a.length; i++) if (typeof a[i] !== 'number') return false; return true; };
D('min', 'x . xs', 'Smallest argument.', a => allNumbers(a) && a.length ? Math.min(...a) : minmax(a, 'min', false));
D('max', 'x . xs', 'Largest argument.', a => allNumbers(a) && a.length ? Math.max(...a) : minmax(a, 'max', true));
D('gcd', '. ns', 'Greatest common divisor.', a => a.reduce((g, v) => gcd2(g, intx(v, 'gcd')), 0));
D('lcm', '. ns', 'Least common multiple.', a => a.reduce((l, v) => { intx(v, 'lcm'); if (l === 0 || v === 0) return 0; return absx(mul(quotient(l, gcd2(l, v), 'lcm'), v, 'lcm')); }, 1));
for (const [n, f] of [['floor', Math.floor], ['ceiling', Math.ceil], ['round', roundEven], ['truncate', Math.trunc]])
  D(n, 'x', `${n[0].toUpperCase() + n.slice(1)} of X.`, ([x]) => typeof x === 'bigint' ? x : f(numx(x, n)));
for (const [n, f] of [['sqrt', Math.sqrt], ['exp', Math.exp], ['sin', Math.sin], ['cos', Math.cos], ['tan', Math.tan], ['asin', Math.asin], ['acos', Math.acos]])
  D(n, 'x', `${n[0].toUpperCase() + n.slice(1)} of X.`, ([x]) => f(num(x, n)));
D('exact-integer-sqrt', 'n', 'Two values: the integer square root S of N and N - S^2.', ([n]) => {
  intx(n, 'exact-integer-sqrt'); if (n < 0) throw typeErr('non-negative integer', n, 'exact-integer-sqrt');
  let s = BigInt(Math.floor(Math.sqrt(Number(n))));
  const N = big(n);
  while (s * s > N) s--;
  while ((s + 1n) * (s + 1n) <= N) s++;
  return new Values([norm(s), norm(N - s * s)]);
});
D('log', 'x [base]', 'Natural logarithm, or the logarithm in BASE.', ([x, b]) => b === undefined ? Math.log(num(x, 'log')) : Math.log(num(x, 'log')) / Math.log(num(b, 'log')));
D('atan', 'y [x]', 'Arc tangent.', ([y, x]) => x === undefined ? Math.atan(num(y, 'atan')) : Math.atan2(num(y, 'atan'), num(x, 'atan')));
D('expt', 'x y', 'X raised to the power Y (exact for exact integers).', ([x, y]) => expt(x, y));
D('exact->inexact', 'x', 'X as a float.', ([x]) => inexact(x));
D('inexact->exact', 'x', 'X as an exact integer when it is an integer.', ([x]) => exactOf(x));
D('exact', 'x', 'X as an exact integer when it is an integer.', ([x]) => exactOf(x));
D('inexact', 'x', 'X as a float.', ([x]) => inexact(x));
D('number->string', 'n [radix]', 'Printed form of N.', ([n, r]) => r === undefined || r === 10 ? write(numx(n, 'number->string')) : numx(n, 'number->string').toString(int(r, 'number->string')));
D('string->number', 's [radix]', 'The number S names, or #f.', ([s, r]) => { const t = str(s, 'string->number').trim(); return r !== undefined && r !== 10 ? parseRadix(t, int(r, 'string->number')) : parseNumber(t); });
D('random', '[n]', 'Random integer below N, or a float in [0,1).', ([n]) => {
  if (n === undefined) return Math.random();
  if (typeof n === 'bigint') { let b = 0n; const words = n.toString(16).length / 8 + 2; for (let i = 0; i < words; i++) b = (b << 32n) | BigInt(Math.floor(Math.random() * 2 ** 32)); return norm(b % n); }
  return Number.isInteger(n) ? Math.floor(Math.random() * n) : Math.random() * num(n, 'random');
});
D('1+', 'n', 'N plus one.', ([n]) => add(n, 1, '1+'));
D('1-', 'n', 'N minus one.', ([n]) => sub(n, 1, '1-'));
D('-1+', 'n', 'N minus one.', ([n]) => sub(n, 1, '-1+'));
D('square', 'n', 'N squared.', ([n]) => mul(n, n, 'square'));
D('exact-integer?', 'x', '#t if X is an exact integer.', ([x]) => isExactInt(x));
D('exact-rational?', 'x', '#t if X is an exact integer (there are no other exact rationals).', ([x]) => isExactInt(x));
const I32 = x => typeof x === 'number' && (x | 0) === x;
function bitop(name, a, init, f32, fbig) {
  let small = true;
  for (const v of a) { intx(v, name); if (!I32(v)) small = false; }
  if (small) { let s = init; for (const v of a) s = f32(s, v); return s; }
  for (const v of a) if (!isExactInt(v)) throw typeErr('exact integer', v, name);
  let s = BigInt(init); for (const v of a) s = fbig(s, BigInt(v)); return norm(s);
}
D('bitwise-and', '. ns', 'Bitwise and.', a => bitop('bitwise-and', a, -1, (x, y) => x & y, (x, y) => x & y));
D('bitwise-or', '. ns', 'Bitwise or.', a => bitop('bitwise-or', a, 0, (x, y) => x | y, (x, y) => x | y));
D('bitwise-xor', '. ns', 'Bitwise xor.', a => bitop('bitwise-xor', a, 0, (x, y) => x ^ y, (x, y) => x ^ y));
D('bitwise-not', 'n', 'Bitwise complement: -N - 1.', ([n]) => sub(neg(intx(n, 'bitwise-not')), 1, 'bitwise-not'));
function ashift(n, c, who) {
  intx(n, who); int(c, who);
  if (typeof n === 'number' && Number.isSafeInteger(n)) {
    if (c < 0) return Math.floor(n / 2 ** -c);
    const r = n * 2 ** c; if (r <= MAXS && r >= -MAXS) return r;
  }
  if (!isExactInt(n)) throw typeErr('exact integer', n, who);
  if (c > 2 ** 24) throw new SchemeError('range-error', who + ': shift count too large', [c]);
  return norm(c >= 0 ? big(n) << BigInt(c) : big(n) >> BigInt(-c));
}
D('arithmetic-shift', 'n count', 'Shift N left by COUNT bits (right if negative).', ([n, c]) => ashift(n, c, 'arithmetic-shift'));
D('shift-left', 'n count', 'Shift N left by COUNT bits.', ([n, c]) => ashift(n, c, 'shift-left'));
D('shift-right', 'n count', 'Shift N right by COUNT bits.', ([n, c]) => ashift(n, -int(c, 'shift-right'), 'shift-right'));
D('bit-count', 'n', 'Number of 1 bits in N (in its complement if negative).', ([n]) => { let b = big(intx(n, 'bit-count')); if (b < 0n) b = -b - 1n; let k = 0; for (const ch of b.toString(2)) if (ch === '1') k++; return k; });
D('integer-length', 'n', 'Bits needed to represent N.', ([n]) => { let b = big(intx(n, 'integer-length')); if (b < 0n) b = -b - 1n; return b === 0n ? 0 : b.toString(2).length; });
/* = across a double and a BigInt compares values (only a big double can equal a BigInt). */
const numEq = (x, y) => x === y || (typeof x !== typeof y && x == y);   // eslint-disable-line eqeqeq
function cmp(name, f) {
  D(name, 'a b . rest', 'Numeric comparison over all arguments.', a => {
    if (a.length === 2) { const x = a[0], y = a[1]; if (typeof x === 'number' && typeof y === 'number') return f(x, y); return f(numx(x, name), numx(y, name)); }
    for (let i = 0; i < a.length; i++) numx(a[i], name);
    for (let i = 0; i + 1 < a.length; i++) if (!f(a[i], a[i + 1])) return false;
    return true;
  });
}
cmp('=', numEq); cmp('<', (x, y) => x < y); cmp('>', (x, y) => x > y); cmp('<=', (x, y) => x <= y); cmp('>=', (x, y) => x >= y);
const pred = (n, f, doc) => D(n, 'x', doc || 'Type predicate.', ([x]) => f(x));
pred('number?', isNumber); pred('integer?', x => typeof x === 'bigint' || Number.isInteger(x)); pred('real?', isNumber); pred('complex?', isNumber);
pred('rational?', x => typeof x === 'bigint' || Number.isFinite(x)); pred('exact?', x => isExactInt(x)); pred('inexact?', x => typeof x === 'number' && !Number.isSafeInteger(x));
pred('zero?', x => numx(x, 'zero?') == 0); pred('positive?', x => numx(x, 'positive?') > 0); pred('negative?', x => numx(x, 'negative?') < 0);   // eslint-disable-line eqeqeq
pred('even?', x => typeof x === 'bigint' ? x % 2n === 0n : int(x, 'even?') % 2 === 0); pred('odd?', x => typeof x === 'bigint' ? x % 2n !== 0n : int(x, 'odd?') % 2 !== 0);
pred('nan?', x => Number.isNaN(x)); pred('infinite?', x => x === Infinity || x === -Infinity); pred('finite?', x => typeof x === 'bigint' || Number.isFinite(x));

/* booleans and equivalence */
D('not', 'x', '#t if X is #f.', ([x]) => x === false);
pred('boolean?', x => typeof x === 'boolean');
D('eq?', 'a b', '#t if A and B are the same object.', ([a, b]) => a === b || (a instanceof Char && b instanceof Char && a.code === b.code));
D('eqv?', 'a b', '#t if A and B are the same object or equal numbers/chars.', ([a, b]) => eqv(a, b));
D('equal?', 'a b', '#t if A and B have the same structure.', ([a, b]) => equal(a, b));
D('boolean=?', 'a b', '#t if both booleans are equal.', ([a, b]) => a === b);

/* pairs and lists */
pred('pair?', x => x instanceof Pair); pred('null?', x => x === NIL); pred('list?', x => isList(x));
D('cons', 'a b', 'A new pair.', ([a, b]) => new Pair(a, b));
D('car', 'p', 'First element of a pair.', ([p]) => car(p));
D('cdr', 'p', 'Rest of a pair.', ([p]) => cdr(p));
for (const path of ['aa', 'ad', 'da', 'dd', 'aaa', 'aad', 'ada', 'add', 'daa', 'dad', 'dda', 'ddd', 'addd', 'dddd'])
  D('c' + path + 'r', 'p', `Composition of car/cdr: c${path}r.`, ([p]) => { let v = p; for (let i = path.length - 1; i >= 0; i--) v = path[i] === 'a' ? car(v) : cdr(v); return v; });
D('set-car!', 'p v', 'Set the car of P.', ([p, v]) => { if (!(p instanceof Pair)) throw typeErr('pair', p, 'set-car!'); p.car = v; return UNSPEC; });
D('set-cdr!', 'p v', 'Set the cdr of P.', ([p, v]) => { if (!(p instanceof Pair)) throw typeErr('pair', p, 'set-cdr!'); p.cdr = v; return UNSPEC; });
D('list', '. xs', 'A list of the arguments.', a => listOf(a));
D('cons*', 'x . xs', 'Like list, but the last argument is the tail.', a => listOf(a.slice(0, -1), a[a.length - 1]));
D('make-list', 'n [fill]', 'A list of N copies of FILL.', ([n, f]) => listOf(new Array(int(n, 'make-list')).fill(opt(f, UNSPEC))));
D('length', 'list', 'Number of elements.', ([l]) => arr(l).length);
D('append', '. lists', 'The lists joined; the last is shared.', a => { if (!a.length) return NIL; let r = a[a.length - 1]; for (let i = a.length - 2; i >= 0; i--) r = listOf(arr(a[i]), r); return r; });
D('append!', '. lists', 'Like append.', a => gref('append')(a));
D('reverse', 'list', 'The list reversed.', ([l]) => listOf(arr(l).reverse()));
D('reverse!', 'list', 'The list reversed.', ([l]) => listOf(arr(l).reverse()));
D('list-tail', 'list k', 'LIST without its first K elements.', ([l, k]) => { let c = l; for (let i = 0; i < int(k, 'list-tail'); i++) c = cdr(c); return c; });
D('list-head', 'list k', 'The first K elements of LIST.', ([l, k]) => listOf(arr(l).slice(0, int(k, 'list-head'))));
D('list-ref', 'list k', 'Element K of LIST.', ([l, k]) => { let c = l; for (let i = 0; i < int(k, 'list-ref'); i++) c = cdr(c); return car(c); });
D('list-index', 'pred list', 'Index of the first element satisfying PRED, or #f.', ([p, l]) => { const i = arr(l).findIndex(x => callProc(p, [x]) !== false); return i < 0 ? false : i; });
D('list-copy', 'list', 'A copy of LIST.', ([l]) => listOf(arr(l)));
D('last', 'list', 'The last element.', ([l]) => { const a = arr(l); if (!a.length) throw err('last: empty list'); return a[a.length - 1]; });
D('last-pair', 'list', 'The last pair.', ([l]) => { let c = l; while (c instanceof Pair && c.cdr instanceof Pair) c = c.cdr; return c; });
D('first', 'list', 'The first element.', ([l]) => car(l));
D('second', 'list', 'The second element.', ([l]) => car(cdr(l)));
D('third', 'list', 'The third element.', ([l]) => car(cdr(cdr(l))));
D('iota', 'n [start step]', 'List of N numbers from START by STEP.', ([n, s, st]) => { const out = []; for (let i = 0; i < int(n, 'iota'); i++) out.push(opt(s, 0) + i * opt(st, 1)); return listOf(out); });
D('memq', 'x list', 'Tail of LIST starting at X (eq?).', ([x, l]) => { let c = l; while (c instanceof Pair) { if (c.car === x) return c; c = c.cdr; } return false; });
D('memv', 'x list', 'Tail of LIST starting at X (eqv?).', ([x, l]) => { let c = l; while (c instanceof Pair) { if (eqv(c.car, x)) return c; c = c.cdr; } return false; });
D('member', 'x list [pred]', 'Tail of LIST starting at an element equal to X.', ([x, l, p]) => { let c = l; while (c instanceof Pair) { if (p ? callProc(p, [x, c.car]) !== false : equal(c.car, x)) return c; c = c.cdr; } return false; });
D('assq', 'key alist', 'First pair of ALIST whose car is KEY (eq?).', ([k, l]) => { let c = l; while (c instanceof Pair) { if (c.car instanceof Pair && c.car.car === k) return c.car; c = c.cdr; } return false; });
D('assv', 'key alist', 'First pair whose car is KEY (eqv?).', ([k, l]) => { let c = l; while (c instanceof Pair) { if (c.car instanceof Pair && eqv(c.car.car, k)) return c.car; c = c.cdr; } return false; });
D('assoc', 'key alist [pred]', 'First pair whose car equals KEY.', ([k, l, p]) => { let c = l; while (c instanceof Pair) { if (c.car instanceof Pair && (p ? callProc(p, [k, c.car.car]) !== false : equal(c.car.car, k))) return c.car; c = c.cdr; } return false; });
D('assq-ref', 'alist key [default]', 'Value for KEY in ALIST, or DEFAULT.', ([l, k, d]) => { let c = l; while (c instanceof Pair) { if (c.car instanceof Pair && (c.car.car === k || equal(c.car.car, k))) return c.car.cdr; c = c.cdr; } return opt(d, false); });
D('assq-set', 'alist key value', 'ALIST with KEY set to VALUE.', ([l, k, v]) => { const a = arr(l); const i = a.findIndex(p => p instanceof Pair && p.car === k); if (i >= 0) { a[i] = new Pair(k, v); return listOf(a); } return new Pair(new Pair(k, v), l); });
D('delete', 'x list', 'LIST without elements equal to X.', ([x, l]) => listOf(arr(l).filter(e => !equal(e, x))));
D('delete!', 'x list', 'LIST without elements equal to X.', ([x, l]) => listOf(arr(l).filter(e => !equal(e, x))));
D('delq', 'x list', 'LIST without X (eq?).', ([x, l]) => listOf(arr(l).filter(e => e !== x)));
D('delete-duplicates', 'list [pred]', 'LIST without later duplicates.', ([l, p]) => { const out = []; for (const e of arr(l)) if (!out.some(o => p ? callProc(p, [o, e]) !== false : equal(o, e))) out.push(e); return listOf(out); });
D('map', 'f list . lists', 'Apply F to each element; collect the results.', ([f, ...ls]) => { const as = ls.map(l => arr(l)); const n = Math.min(...as.map(a => a.length)); const out = new Array(n); for (let i = 0; i < n; i++) out[i] = callProc(f, as.map(a => a[i])); return listOf(out); });
D('for-each', 'f list . lists', 'Apply F to each element for effect.', ([f, ...ls]) => { const as = ls.map(l => arr(l)); const n = Math.min(...as.map(a => a.length)); for (let i = 0; i < n; i++) callProc(f, as.map(a => a[i])); return UNSPEC; });
D('append-map', 'f list', 'Append the lists returned by F.', ([f, l]) => { const out = []; for (const x of arr(l)) out.push(...arr(callProc(f, [x]))); return listOf(out); });
D('filter-map', 'f list', 'Results of F that are not #f.', ([f, l]) => listOf(arr(l).map(x => callProc(f, [x])).filter(v => v !== false)));
D('filter', 'pred list', 'Elements satisfying PRED.', ([p, l]) => listOf(arr(l).filter(x => callProc(p, [x]) !== false)));
D('remove', 'pred list', 'Elements not satisfying PRED.', ([p, l]) => listOf(arr(l).filter(x => callProc(p, [x]) === false)));
D('partition', 'pred list', 'Two values: elements satisfying PRED and the rest.', ([p, l]) => { const a = [], b = []; for (const x of arr(l)) (callProc(p, [x]) !== false ? a : b).push(x); return new Values([listOf(a), listOf(b)]); });
D('reduce', 'f init list', 'Combine the elements of LIST with F from the left; INIT for an empty list.', ([f, init, l]) => { const a = arr(l); if (!a.length) return init; let acc = a[0]; for (let i = 1; i < a.length; i++) acc = callProc(f, [a[i], acc]); return acc; });
D('fold', 'f init list . lists', 'Left fold: (f elem acc).', ([f, init, ...ls]) => { const as = ls.map(l => arr(l)); const n = Math.min(...as.map(a => a.length)); let acc = init; for (let i = 0; i < n; i++) acc = callProc(f, [...as.map(a => a[i]), acc]); return acc; });
D('fold-left', 'f init list', 'Left fold: (f acc elem).', ([f, init, l]) => { let acc = init; for (const x of arr(l)) acc = callProc(f, [acc, x]); return acc; });
D('fold-right', 'f init list', 'Right fold: (f elem acc).', ([f, init, l]) => { let acc = init; const a = arr(l); for (let i = a.length - 1; i >= 0; i--) acc = callProc(f, [a[i], acc]); return acc; });
D('find', 'pred list', 'First element satisfying PRED, or #f.', ([p, l]) => { for (const x of arr(l)) if (callProc(p, [x]) !== false) return x; return false; });
D('find-tail', 'pred list', 'First tail whose car satisfies PRED, or #f.', ([p, l]) => { let c = l; while (c instanceof Pair) { if (callProc(p, [c.car]) !== false) return c; c = c.cdr; } return false; });
D('any', 'pred list . lists', 'First non-#f result of PRED, or #f.', ([p, ...ls]) => { const as = ls.map(l => arr(l)); const n = Math.min(...as.map(a => a.length)); for (let i = 0; i < n; i++) { const v = callProc(p, as.map(a => a[i])); if (v !== false) return v; } return false; });
D('every', 'pred list . lists', '#f if any element fails PRED, else the last result.', ([p, ...ls]) => { const as = ls.map(l => arr(l)); const n = Math.min(...as.map(a => a.length)); let v = true; for (let i = 0; i < n; i++) { v = callProc(p, as.map(a => a[i])); if (v === false) return false; } return v; });
D('count', 'pred list', 'Number of elements satisfying PRED.', ([p, l]) => arr(l).filter(x => callProc(p, [x]) !== false).length);
D('take', 'list k', 'The first K elements.', ([l, k]) => listOf(arr(l).slice(0, int(k, 'take'))));
D('drop', 'list k', 'LIST without the first K elements.', ([l, k]) => { let c = l; for (let i = 0; i < int(k, 'drop'); i++) c = cdr(c); return c; });
D('take-while', 'pred list', 'Leading elements satisfying PRED.', ([p, l]) => { const out = []; for (const x of arr(l)) { if (callProc(p, [x]) === false) break; out.push(x); } return listOf(out); });
D('drop-while', 'pred list', 'LIST after the leading elements satisfying PRED.', ([p, l]) => { let c = l; while (c instanceof Pair && callProc(p, [c.car]) !== false) c = c.cdr; return c; });
D('sort', 'seq less', 'SEQ (a list or vector) sorted stably by LESS.', ([l, p]) => { const a = (Array.isArray(l) ? l.slice() : arr(l)).sort((x, y) => callProc(p, [x, y]) !== false ? -1 : callProc(p, [y, x]) !== false ? 1 : 0); return Array.isArray(l) ? a : listOf(a); });
D('sort!', 'seq less', 'Like sort.', a => gref('sort')(a));
D('list-set!', 'list k v', 'Set element K of LIST.', ([l, k, v]) => { let c = l; for (let i = 0; i < int(k, 'list-set!'); i++) c = cdr(c); if (!(c instanceof Pair)) throw err('list-set!: index out of range'); c.car = v; return UNSPEC; });
D('apply', 'f . args', 'Call F with the arguments; the last argument is a list of more.', ([f, ...a]) => { const args = a.length ? a.slice(0, -1).concat(arr(a[a.length - 1])) : []; return new TailCall(f, args); });

/* symbols, keywords */
pred('symbol?', x => x instanceof Sym && !isKeyword(x)); pred('keyword?', x => isKeyword(x));
D('symbol->string', 's', 'Name of S.', ([s]) => sym(s, 'symbol->string').name);
D('string->symbol', 's', 'The symbol named S.', ([s]) => intern(str(s, 'string->symbol')));
D('symbol-append', '. syms', 'Symbol whose name joins the names.', a => intern(a.map(s => sym(s, 'symbol-append').name).join('')));
D('gensym', '[prefix]', 'A fresh uninterned symbol.', ([p]) => gensym(p instanceof Sym ? p.name : typeof p === 'string' ? p : 'g'));
D('keyword->symbol', 'k', 'The symbol with the keyword’s name.', ([k]) => intern(sym(k, 'keyword->symbol').name.replace(/^:/, '')));
D('symbol->keyword', 's', 'The keyword with the symbol’s name.', ([s]) => intern(':' + sym(s, 'symbol->keyword').name));
D('keyword->string', 'k', 'Name of the keyword without the colon.', ([k]) => sym(k, 'keyword->string').name.replace(/^:/, ''));
D('string->keyword', 's', 'The keyword named S.', ([s]) => intern(':' + str(s, 'string->keyword')));
D('symbol<?', 'a b', 'Alphabetic order of symbol names.', ([a, b]) => sym(a).name < sym(b).name);

/* chars */
pred('char?', x => x instanceof Char);
D('char->integer', 'c', 'Code point of C.', ([c]) => chr(c, 'char->integer').code);
D('integer->char', 'n', 'Character with code N.', ([n]) => mkchar(int(n, 'integer->char')));
D('char-upcase', 'c', 'Upper-case C.', ([c]) => mkchar(String.fromCodePoint(chr(c, 'char-upcase').code).toUpperCase().codePointAt(0)));
D('char-downcase', 'c', 'Lower-case C.', ([c]) => mkchar(String.fromCodePoint(chr(c, 'char-downcase').code).toLowerCase().codePointAt(0)));
const cs = c => String.fromCodePoint(chr(c).code);
pred('char-alphabetic?', c => /\p{L}/u.test(cs(c))); pred('char-numeric?', c => /\p{N}/u.test(cs(c))); pred('char-whitespace?', c => /\s/u.test(cs(c)));
pred('char-upper-case?', c => /\p{Lu}/u.test(cs(c))); pred('char-lower-case?', c => /\p{Ll}/u.test(cs(c)));
D('char->digit', 'c [radix]', 'Digit value of C, or #f.', ([c, r]) => { const v = parseInt(cs(c), opt(r, 10)); return isNaN(v) ? false : v; });
D('digit->char', 'n [radix]', 'Character for digit N.', ([n, r]) => mkchar(int(n).toString(opt(r, 10)).codePointAt(0)));
D('digit-value', 'c', 'Digit value of C, or #f.', ([c]) => { const v = parseInt(cs(c), 10); return isNaN(v) ? false : v; });
for (const [n, f] of [['char=?', (a, b) => a === b], ['char<?', (a, b) => a < b], ['char>?', (a, b) => a > b], ['char<=?', (a, b) => a <= b], ['char>=?', (a, b) => a >= b]])
  D(n, 'a b . rest', 'Compare characters by code.', a => { for (let i = 0; i + 1 < a.length; i++) if (!f(chr(a[i], n).code, chr(a[i + 1], n).code)) return false; return true; });
D('char-ci=?', 'a b', 'Compare characters ignoring case.', ([a, b]) => cs(a).toLowerCase() === cs(b).toLowerCase());
D('char->string', 'c', 'One-character string.', ([c]) => cs(c));

/* strings (immutable) */
pred('string?', x => typeof x === 'string');
D('string-length', 's', 'Number of characters.', ([s]) => str(s, 'string-length').length);
D('string-ref', 's k', 'Character K of S.', ([s, k]) => { str(s, 'string-ref'); int(k, 'string-ref'); if (k < 0 || k >= s.length) throw new SchemeError('range-error', `string-ref: index ${k} out of range`); return mkchar(s.charCodeAt(k)); });
D('substring', 's start [end]', 'Part of S from START to END.', ([s, a, b]) => { str(s, 'substring'); const e = opt(b, s.length); if (a < 0 || e > s.length || a > e) throw new SchemeError('range-error', `substring: bad range ${a}..${e} for length ${s.length}`); return s.slice(a, e); });
D('string-append', '. strings', 'The strings joined.', a => a.map(s => str(s, 'string-append')).join(''));
D('string', '. chars', 'A string of the characters (strings are spliced in).', a => a.map(c => typeof c === 'string' ? c : cs(c)).join(''));
D('make-string', 'n [char]', 'N copies of CHAR.', ([n, c]) => (c === undefined ? ' ' : cs(c)).repeat(int(n, 'make-string')));
D('string-copy', 's [start end]', 'A copy of part of S.', ([s, a, b]) => str(s, 'string-copy').slice(opt(a, 0), opt(b, s.length)));
D('string->list', 's', 'The characters of S.', ([s]) => listOf([...str(s, 'string->list')].map(c => mkchar(c.codePointAt(0)))));
D('list->string', 'list', 'A string of the characters in LIST.', ([l]) => arr(l).map(c => cs(c)).join(''));
D('string->vector', 's', 'The characters as a vector.', ([s]) => [...str(s)].map(c => mkchar(c.codePointAt(0))));
D('string-upcase', 's', 'S in upper case.', ([s]) => str(s, 'string-upcase').toUpperCase());
D('string-downcase', 's', 'S in lower case.', ([s]) => str(s, 'string-downcase').toLowerCase());
D('string-titlecase', 's', 'S with each word capitalized.', ([s]) => str(s).toLowerCase().replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()));
D('string-null?', 's', '#t if S is empty.', ([s]) => str(s, 'string-null?') === '');
D('string-index', 's pred-or-char [start]', 'Index of the first character matching, or #f.', ([s, p, st]) => { str(s, 'string-index'); for (let i = opt(st, 0); i < s.length; i++) { const c = mkchar(s.charCodeAt(i)); if (p instanceof Char ? p.code === c.code : callProc(p, [c]) !== false) return i; } return false; });
D('string-rindex', 's pred-or-char', 'Index of the last character matching, or #f.', ([s, p]) => { for (let i = str(s).length - 1; i >= 0; i--) { const c = mkchar(s.charCodeAt(i)); if (p instanceof Char ? p.code === c.code : callProc(p, [c]) !== false) return i; } return false; });
D('string-search-forward', 'pattern s start', 'Index of PATTERN in S at or after START, or #f.', ([p, s, st]) => { const i = str(s).indexOf(str(p), opt(st, 0)); return i < 0 ? false : i; });
D('string-search-backward', 'pattern s end', 'End index of the last PATTERN in S before END, or #f.', ([p, s, e]) => { const i = str(s).lastIndexOf(str(p), opt(e, s.length) - str(p).length); return i < 0 ? false : i + p.length; });
D('string-search-all', 'pattern s', 'Indices of every PATTERN in S.', ([p, s]) => { const out = []; let i = -1; while ((i = str(s).indexOf(str(p), i + 1)) >= 0) out.push(i); return listOf(out); });
D('string-contains', 's pattern', 'Index of PATTERN in S, or #f.', ([s, p]) => { const i = str(s).indexOf(str(p)); return i < 0 ? false : i; });
D('string-prefix?', 'prefix s', '#t if S starts with PREFIX.', ([p, s]) => str(s, 'string-prefix?').startsWith(str(p)));
D('string-suffix?', 'suffix s', '#t if S ends with SUFFIX.', ([p, s]) => str(s, 'string-suffix?').endsWith(str(p)));
D('string-prefix-ci?', 'prefix s', '#t if S starts with PREFIX, ignoring case.', ([p, s]) => str(s).toLowerCase().startsWith(str(p).toLowerCase()));
D('string-join', 'strings [delimiter]', 'The strings joined by DELIMITER.', ([l, d]) => arr(l).map(s => str(s, 'string-join')).join(opt(d, ' ')));
D('string-split', 's delimiter', 'Split S at every DELIMITER (a char or string).', ([s, d]) => listOf(str(s, 'string-split').split(d instanceof Char ? cs(d) : str(d))));
D('string-trim', 's', 'S without leading and trailing whitespace.', ([s]) => str(s, 'string-trim').trim());
D('string-trim-left', 's', 'S without leading whitespace.', ([s]) => str(s).trimStart());
D('string-trim-right', 's', 'S without trailing whitespace.', ([s]) => str(s).trimEnd());
D('string-pad-left', 's n [char]', 'S padded on the left to N characters.', ([s, n, c]) => str(s).padStart(int(n), c ? cs(c) : ' ').slice(-n));
D('string-pad-right', 's n [char]', 'S padded on the right to N characters.', ([s, n, c]) => str(s).padEnd(int(n), c ? cs(c) : ' ').slice(0, n));
D('string-reverse', 's', 'S reversed.', ([s]) => [...str(s)].reverse().join(''));
D('string-replace', 's from to', 'S with every FROM replaced by TO.', ([s, f, t]) => str(s).split(str(f)).join(str(t)));
D('string-count', 's pred-or-char', 'Number of characters matching.', ([s, p]) => [...str(s)].filter(c => p instanceof Char ? c.codePointAt(0) === p.code : callProc(p, [mkchar(c.codePointAt(0))]) !== false).length);
D('string-for-each', 'f s', 'Apply F to each character.', ([f, s]) => { for (const c of str(s)) callProc(f, [mkchar(c.codePointAt(0))]); return UNSPEC; });
D('string-map', 'f s', 'String of the characters F returns.', ([f, s]) => [...str(s)].map(c => { const r = callProc(f, [mkchar(c.codePointAt(0))]); return r instanceof Char ? cs(r) : str(r); }).join(''));
for (const [n, f] of [['string=?', (a, b) => a === b], ['string<?', (a, b) => a < b], ['string>?', (a, b) => a > b], ['string<=?', (a, b) => a <= b], ['string>=?', (a, b) => a >= b]])
  D(n, 'a b . rest', 'Compare strings.', a => { for (let i = 0; i + 1 < a.length; i++) if (!f(str(a[i], n), str(a[i + 1], n))) return false; return true; });
D('string-ci=?', 'a b', 'Compare strings ignoring case.', ([a, b]) => str(a).toLowerCase() === str(b).toLowerCase());
D('string-ci<?', 'a b', 'Order strings ignoring case.', ([a, b]) => str(a).toLowerCase() < str(b).toLowerCase());
D('string->utf8-length', 's', 'Bytes in the UTF-8 encoding.', ([s]) => new TextEncoder().encode(str(s)).length);
D('number->padded-string', 'n width', 'N padded with zeros to WIDTH.', ([n, w]) => String(n).padStart(w, '0'));

/* vectors */
pred('vector?', x => Array.isArray(x));
D('vector', '. xs', 'A vector of the arguments.', a => a.slice());
D('make-vector', 'n [fill]', 'A vector of N copies of FILL.', ([n, f]) => new Array(int(n, 'make-vector')).fill(opt(f, false)));
D('vector-length', 'v', 'Number of elements.', ([v]) => vec(v, 'vector-length').length);
D('vector-ref', 'v k', 'Element K.', ([v, k]) => { vec(v, 'vector-ref'); int(k, 'vector-ref'); if (k < 0 || k >= v.length) throw new SchemeError('range-error', `vector-ref: index ${k} out of range`); return v[k]; });
D('vector-set!', 'v k x', 'Set element K.', ([v, k, x]) => { vec(v, 'vector-set!'); int(k, 'vector-set!'); if (k < 0 || k >= v.length) throw new SchemeError('range-error', `vector-set!: index ${k} out of range`); v[k] = x; return UNSPEC; });
D('vector->list', 'v [start end]', 'The elements as a list.', ([v, a, b]) => listOf(vec(v).slice(opt(a, 0), opt(b, v.length))));
D('list->vector', 'list', 'The elements as a vector.', ([l]) => arr(l));
D('vector-map', 'f v', 'Vector of F applied to each element.', ([f, v]) => vec(v).map(x => callProc(f, [x])));
D('vector-for-each', 'f v', 'Apply F to each element.', ([f, v]) => { vec(v).forEach(x => callProc(f, [x])); return UNSPEC; });
D('vector-fill!', 'v x', 'Set every element to X.', ([v, x]) => { vec(v).fill(x); return UNSPEC; });
D('vector-copy', 'v [start end]', 'A copy of part of V.', ([v, a, b]) => vec(v).slice(opt(a, 0), opt(b, v.length)));
D('vector-append', '. vs', 'The vectors joined.', a => [].concat(...a.map(v => vec(v))));
D('vector-grow', 'v n', 'A copy of V with room for N elements.', ([v, n]) => { const c = vec(v).slice(); c.length = n; return c; });
D('subvector', 'v start end', 'Part of V.', ([v, a, b]) => vec(v).slice(a, b));
D('vector-binary-search', 'v key compare', 'Element matching KEY by COMPARE, or #f.', ([v, k, c]) => { let lo = 0, hi = vec(v).length - 1; while (lo <= hi) { const m = (lo + hi) >> 1, r = callProc(c, [k, v[m]]); if (r === 0) return v[m]; if (r < 0) hi = m - 1; else lo = m + 1; } return false; });

/* hash tables */
/* Keys are compared as a JS Map does: by identity, strings and numbers (BigInts too) by value. Chars
   are interned by mkchar, so a char is its own key. */
D('make-hash-table', '. args', 'A new hash table (keys compared with eqv?, strings by value).', () => new Map());
D('make-weak-hash-table', '. args', 'A new hash table that holds its object keys weakly: an entry goes away once nothing else refers to its key. Walking it shows the entries whose keys are still alive.', () => new WeakTable());
D('make-key-weak-eqv-hash-table', '. args', 'A new hash table that holds its object keys weakly.', () => new WeakTable());
pred('weak-hash-table?', x => x instanceof WeakTable);
D('make-equal-hash-table', '', 'A new hash table.', () => new Map());
D('make-strong-eqv-hash-table', '', 'A new hash table.', () => new Map());
D('make-string-hash-table', '', 'A new hash table.', () => new Map());
pred('hash-table?', x => x instanceof Map);
D('hash-table-ref', 'table key [fail]', 'Value for KEY, or the result of FAIL.', ([t, k, f]) => { const v = ht(t).get(k); if (v !== undefined) return v; if (f === undefined) throw err('hash-table-ref: no value for key', k); return callProc(f, []); });
D('hash-table-ref/default', 'table key default', 'Value for KEY, or DEFAULT.', ([t, k, d]) => { const v = ht(t).get(k); return v === undefined ? d : v; });
D('hash-ref', 'table key [default]', 'Value for KEY, or DEFAULT (#f).', ([t, k, d]) => { const v = ht(t).get(k); return v === undefined ? opt(d, false) : v; });
D('hash-table-set!', 'table key value', 'Store VALUE under KEY.', ([t, k, v]) => { ht(t).set(k, v); return UNSPEC; });
D('hash-set!', 'table key value', 'Store VALUE under KEY.', ([t, k, v]) => { ht(t).set(k, v); return UNSPEC; });
D('hash-table-delete!', 'table key', 'Remove KEY.', ([t, k]) => { ht(t).delete(k); return UNSPEC; });
D('hash-remove!', 'table key', 'Remove KEY.', ([t, k]) => { ht(t).delete(k); return UNSPEC; });
D('hash-table-contains?', 'table key', '#t if KEY is present.', ([t, k]) => ht(t).has(k));
D('hash-table-exists?', 'table key', '#t if KEY is present.', ([t, k]) => ht(t).has(k));
D('hash-table-count', 'table', 'Number of entries.', ([t]) => ht(t).size);
D('hash-table-size', 'table', 'Number of entries.', ([t]) => ht(t).size);
D('hash-table-keys', 'table', 'List of the keys.', ([t]) => listOf([...ht(t).keys()]));
D('hash-table-values', 'table', 'List of the values.', ([t]) => listOf([...ht(t).values()]));
D('hash-table->alist', 'table', 'The entries as an alist.', ([t]) => listOf([...ht(t)].map(([k, v]) => new Pair(k, v))));
D('hash-table-walk', 'table f', 'Call F with each key and value.', ([t, f]) => { for (const [k, v] of ht(t)) callProc(f, [k, v]); return UNSPEC; });
D('hash-for-each', 'f table', 'Call F with each key and value.', ([f, t]) => { for (const [k, v] of ht(t)) callProc(f, [k, v]); return UNSPEC; });
D('hash-map->list', 'f table', 'List of F applied to each key and value.', ([f, t]) => listOf([...ht(t)].map(([k, v]) => callProc(f, [k, v]))));
D('hash-table-update!', 'table key f [default]', 'Replace the value under KEY with (f value).', ([t, k, f, d]) => { const cur = ht(t).get(k); const base = cur === undefined ? (d === undefined ? (() => { throw err('hash-table-update!: no value for key', k); })() : callProc(d, [])) : cur; t.set(k, callProc(f, [base])); return UNSPEC; });
D('hash-table-update!/default', 'table key f default', 'Replace the value under KEY with (f value), starting from DEFAULT.', ([t, k, f, d]) => { const cur = ht(t).get(k); t.set(k, callProc(f, [cur === undefined ? d : cur])); return UNSPEC; });
D('hash-table-clear!', 'table', 'Remove every entry.', ([t]) => { ht(t).clear(); return UNSPEC; });
D('hash-table-copy', 'table', 'A copy.', ([t]) => { const c = ht(t) instanceof WeakTable ? new WeakTable() : new Map(); for (const [k, v] of t) c.set(k, v); return c; });

/* control */
pred('procedure?', x => typeof x === 'function' || x instanceof Param);
D('values', '. xs', 'Return several values.', a => a.length === 1 ? a[0] : new Values(a));
D('call-with-values', 'producer consumer', 'Call CONSUMER with the values PRODUCER returns.', ([p, c]) => { const v = callProc(p, []); return new TailCall(c, v instanceof Values ? v.vals : [v]); });
D('call/ec', 'f', 'Call F with an escape procedure that returns from this call.', ([f]) => {
  const tag = {}; const k = named(args => { throw new Escape(tag, args); }, 'escape');
  const s = sp;
  try { return callProc(f, [k]); } catch (e) { if (e instanceof Escape && e.tag === tag) { sp = s; return e.vals.length === 1 ? e.vals[0] : new Values(e.vals); } throw e; }
});
gdef('call-with-escape-continuation', gref('call/ec'));
gdef('call-with-current-continuation', gref('call/ec'));
gdef('call/cc', gref('call/ec'));
D('dynamic-wind', 'before thunk after', 'Call BEFORE, THUNK and AFTER; AFTER also runs if THUNK escapes.', ([b, t, a]) => { callProc(b, []); try { return callProc(t, []); } finally { callProc(a, []); } });
D('force', 'promise', 'Value of a delayed expression.', ([p]) => typeof p === 'function' && p.isPromise ? p() : p);
D('make-promise', 'x', 'A promise already forced to X.', ([x]) => { const p = () => x; p.isPromise = true; return p; });
D('make-parameter', 'value [converter]', 'A parameter object; call it to read, parameterize to bind.', ([v, c]) => new Param(c ? callProc(c, [v]) : v, c || null));
D('parameter?', 'x', '#t if X is a parameter.', ([x]) => x instanceof Param);

/* conditions: raise, handlers and condition types */
D('error', 'message . irritants', 'Signal an error. A condition as MESSAGE is raised as it is.', ([m, ...irr]) => signal(m instanceof SchemeError ? m : new SchemeError('error', typeof m === 'string' ? m : write(m), irr), false));
D('user-error', 'format . args', 'Signal an error meant for the user.', ([m, ...a]) => signal(new SchemeError('user-error', fmt(str(m, 'user-error'), a), []), false));
D('warn', 'message . irritants', 'Print a warning on the current error port.', ([m, ...irr]) => { errPort().put(';Warning: ' + (typeof m === 'string' ? m : write(m)) + (irr.length ? ' ' + irr.map(x => write(x)).join(' ') : '') + '\n'); return UNSPEC; });
D('raise', 'obj', 'Raise OBJ: the current handler is called with it where it was raised; returning from that handler is an error.', ([o]) => signal(o, false));
D('raise-continuable', 'obj', 'Raise OBJ; the value of the current handler is the value of this call.', ([o]) => signal(o, true));
D('with-exception-handler', 'handler thunk', 'Call THUNK with HANDLER installed: anything raised in it calls HANDLER there, before unwinding, with the outer handlers installed.', ([h, t]) => {
  proc(h, 'with-exception-handler');
  const saved = handlers;
  handlers = { h, js: false, next: saved };
  try { return callProc(t, []); } finally { handlers = saved; }
});
pred('error?', x => isErrorCondition(x), '#t if X is a condition whose type is error or one of its descendants (quit is not an error).');
pred('error-object?', x => x instanceof SchemeError, '#t if X is a condition.');
pred('condition?', x => x instanceof SchemeError, '#t if X is a condition.');
D('error-object-message', 'e', 'Message of the error.', ([e]) => e instanceof SchemeError ? e.message : write(e));
D('error-object-irritants', 'e', 'Irritants of the error.', ([e]) => e instanceof SchemeError ? listOf(e.irritants) : NIL);
D('error-message', 'e', 'Message of the error.', ([e]) => e instanceof SchemeError ? e.message : write(e));
D('error-irritants', 'e', 'Irritants of the error.', ([e]) => e instanceof SchemeError ? listOf(e.irritants) : NIL);
D('error-kind', 'e', 'Kind of the error, a symbol.', ([e]) => e instanceof SchemeError ? intern(e.kind) : intern('unknown'));
D('error-message-string', 'e', 'Message of the error with its irritants.', ([e]) => errorMessage(e));
D('condition/report-string', 'c', 'The report of condition C: its type reporter\'s output, or the message with the irritants.', ([e]) => errorMessage(e));
D('condition/type', 'c', 'The condition type of C.', ([c]) => { if (!(c instanceof SchemeError)) throw typeErr('condition', c, 'condition/type'); return conditionType(c.kind); });
pred('condition-type?', x => x instanceof ConditionType);
const ctype = (x, who) => { if (x instanceof ConditionType) return x; if (x instanceof Sym || typeof x === 'string') return conditionType(x); throw typeErr('condition type', x, who); };
D('condition-type/error?', 'type', '#t if TYPE is error or one of its descendants.', ([t]) => ctype(t, 'condition-type/error?').isa('error'));
D('condition-type/name', 'type', 'The name of TYPE, a symbol.', ([t]) => intern(ctype(t, 'condition-type/name').name));
D('condition-type/parent', 'type', 'The parent of TYPE, or #f.', ([t]) => ctype(t, 'condition-type/parent').parent || false);
D('condition-type/generalizations', 'type', 'TYPE and its ancestors, nearest first.', ([t]) => { const out = []; for (let c = ctype(t, 'condition-type/generalizations'); c; c = c.parent) out.push(c); return listOf(out); });
D('condition-type', 'name', 'The condition type named NAME (a child of error is made for an unknown name).', ([n]) => ctype(n, 'condition-type'));
D('make-condition-type', 'name parent [reporter]', 'Define the condition type NAME under PARENT (a type or a name, #f for a root). REPORTER, a string or a procedure (condition port), writes its report.', ([n, p, r]) => defineConditionType(sym(n, 'make-condition-type'), p === false || p === undefined ? null : ctype(p, 'make-condition-type'), r || null));
D('make-condition', 'type message . irritants', 'A new condition of TYPE (a type or a name).', ([t, m, ...irr]) => new SchemeError(ctype(t, 'make-condition').name, typeof m === 'string' ? m : write(m), irr));
D('condition-is?', 'condition type', '#t if CONDITION is of TYPE (a type or a name) or one of its descendants.', ([c, t]) => conditionIs(c, ctype(t, 'condition-is?').name));
D('condition-predicate', 'type', 'A predicate for conditions of TYPE or its descendants.', ([t]) => { const name = ctype(t, 'condition-predicate').name; return named(([c]) => conditionIs(c, name), name + '?'); });
D('access-condition', 'condition field', 'Field FIELD of CONDITION: message, irritants, type, kind, payload or backtrace.', ([c, f]) => {
  if (!(c instanceof SchemeError)) throw typeErr('condition', c, 'access-condition');
  switch (sym(f, 'access-condition').name) {
    case 'message': return c.message;
    case 'irritants': return listOf(c.irritants);
    case 'type': return conditionType(c.kind);
    case 'kind': return intern(c.kind);
    case 'payload': return c.payload === undefined ? false : c.payload;
    case 'backtrace': return stackFrames(conditionBacktrace(c));
  }
  throw new SchemeError('wrong-type-argument', 'access-condition: no field ' + f.name, [f]);
});
D('condition/backtrace', 'condition', 'The stack when CONDITION was signalled (before unwinding), innermost first, as stack frames.', ([c]) => stackFrames(conditionBacktrace(c)));
for (const k of ['user-error', 'wrong-type-argument', 'unbound-variable', 'range-error', 'file-error', 'quit', 'server-only', 'edit-conflict', 'timeout',
  'http-error', 'scheme-interrupt', 'read-error', 'syntax-error', 'divide-by-zero', 'wrong-number-of-arguments', 'assertion-failed', 'recursion-depth', 'control-error'])
  pred(k + '?', x => conditionIs(x, k), `#t if X is a ${k} condition (or of a type descended from ${k}).`);
for (const t of ctypes.values()) gdef('condition-type:' + t.name, t);
/* (define-condition-type name parent [reporter]): NAME and PARENT are names, not evaluated. Defines
   condition-type:NAME and the predicate NAME?. */
macros.set('define-condition-type', { kind: 'proc', proc: named(args => {
  const [n, p, r] = args;
  if (!isId(n)) throw new SchemeError('syntax-error', 'define-condition-type: expected a name', [strip(n)]);
  const name = baseName(n), parent = p === undefined || p === false ? false : list(S.quote, strip(p));
  const q = intern('quote');
  return list(S.begin,
    list(S.define, intern('condition-type:' + name.name), list(intern('make-condition-type'), list(q, name), parent, r === undefined ? false : r)),
    list(S.define, intern(name.name + '?'), list(intern('condition-predicate'), list(q, name))),
    list(q, name));
}, 'define-condition-type') });

/* restarts */
pred('restart?', x => x instanceof Restart);
D('restart/name', 'restart', 'Name of RESTART, a symbol, or #f.', ([r]) => { if (!(r instanceof Restart)) throw typeErr('restart', r, 'restart/name'); return r.name; });
D('restart/report-string', 'restart', 'What RESTART does, for people.', ([r]) => { if (!(r instanceof Restart)) throw typeErr('restart', r, 'restart/report-string'); return restartReport(r); });
D('compute-restarts', '[condition]', 'The active restarts, innermost first.', () => listOf(computeRestarts()));
D('find-restart', 'name [condition]', 'The innermost active restart named NAME (or RESTART itself if active), or #f.', ([n]) => findRestart(n) || false);
D('invoke-restart', 'restart . args', 'Unwind to RESTART (a restart or a name) and call it with ARGS.', ([r, ...a]) => invokeRestart(r, a));
D('invoke-restart-interactively', 'restart', 'Invoke RESTART with arguments from its interactive procedure (or hooks.restartArgs).', ([r]) => { const rr = findRestart(r); if (!rr) return invokeRestart(r, []); return invokeRestart(rr, restartArgs(rr)); });
for (const [n, doc] of [['abort', 'Invoke the innermost abort restart (back to the command loop).'], ['continue', 'Invoke the innermost continue restart, if any; else return #f.'],
  ['retry', 'Invoke the innermost retry restart, if any; else return #f.'], ['use-value', 'Invoke the innermost use-value restart with VALUE, if any; else return #f.'],
  ['store-value', 'Invoke the innermost store-value restart with VALUE, if any; else return #f.']])
  D(n, n === 'use-value' || n === 'store-value' ? 'value' : '', doc, args => {
    const r = findRestart(intern(n));
    if (r) return invokeRestart(r, args);
    if (n === 'abort') throw new SchemeError('control-error', 'No abort restart is active', []);
    return false;
  });
/* (%restart-case thunk name report interactive procedure ...): call THUNK with the restarts. */
D('%restart-case', 'thunk . specs', 'Call THUNK with restarts established (restart-case expands into this).', ([thunk, ...specs]) => {
  const tag = {}, rs = [];
  for (let i = 0; i + 3 < specs.length; i += 4) rs.push(new Restart(specs[i], specs[i + 1], specs[i + 2], specs[i + 3], tag, false));
  return establish(rs, tag, () => callProc(thunk, []), true);
});
D('%with-simple-restart', 'name thunk format . args', 'Call THUNK with a restart NAME that makes this return #f and #t.', ([n, thunk, f, ...a]) => {
  const tag = {};
  return establish([new Restart(n, typeof f === 'string' ? fmt(f, a) : false, null, () => new Values([false, true]), tag, true)], tag, () => callProc(thunk, []), true);
});
/* (restart-case expr (name (arg...) [:report r] [:interactive i] body...) ...) */
macros.set('restart-case', { kind: 'proc', proc: named(([expr, ...clauses]) => {
  const out = [intern('%restart-case'), list(S.lambda, NIL, expr)];
  for (const cl of clauses) {
    const c = arr(cl);
    if (c.length < 2 || !isId(c[0])) throw new SchemeError('syntax-error', 'restart-case: bad clause ' + write(strip(cl)), [strip(cl)]);
    let k = 2, report = false, interactive = false;
    while (k + 1 < c.length && isId(c[k]) && isKeyword(baseName(c[k]))) {
      const kw = baseName(c[k]).name;
      if (kw === ':report') report = c[k + 1]; else if (kw === ':interactive') interactive = c[k + 1];
      k += 2;
    }
    out.push(list(S.quote, baseName(c[0])), report, interactive, new Pair(S.lambda, new Pair(c[1], listOf(c.slice(k)))));
  }
  return listOf(out);
}, 'restart-case') });
/* (with-simple-restart (name format arg...) body...): #f and #t if the restart is invoked. */
macros.set('with-simple-restart', { kind: 'proc', proc: named(([spec, ...forms]) => {
  const s = arr(spec);
  return listOf([intern('%with-simple-restart'), list(S.quote, baseName(s[0])), new Pair(S.lambda, new Pair(NIL, listOf(forms))), ...s.slice(1)]);
}, 'with-simple-restart') });

/* the shadow stack, from Scheme */
const stackFrames = fs => fs ? listOf(fs.map(f => new StackFrame(f.proc, f.frame, f.loc))) : NIL;
D('stack-backtrace', '', 'The active procedure applications, innermost first, as stack frames.', function sbt() { const fs = backtrace(); return stackFrames(fs.length && fs[0].proc === sbt ? fs.slice(1) : fs); });
pred('stack-frame?', x => x instanceof StackFrame);
D('stack-frame/procedure', 'frame', 'The procedure applied.', ([f]) => f.proc);
D('stack-frame/location', 'frame', 'Where it was called from: (file line column), or #f.', ([f]) => f.loc ? list(f.loc.file === null ? false : f.loc.file, f.loc.line, f.loc.col) : false);
D('stack-frame/environment', 'frame', 'The environment of the application (for eval), or #f for a primitive.', ([f]) => f.proc && f.proc.scope && f.frame ? new Environment(f.proc.scope, f.frame) : false);
D('source-location', 'obj', 'Where OBJ (a pair read or a compound procedure) comes from: (file line column), or #f.', ([x]) => { const l = sourceLocation(x); return l ? list(l.file === null ? false : l.file, l.line, l.col) : false; });

/* environments */
pred('environment?', x => x instanceof Environment);
gdef('system-global-environment', GLOBAL_ENV);
gdef('user-initial-environment', GLOBAL_ENV);
D('interaction-environment', '', 'The global environment.', () => GLOBAL_ENV);
D('nearest-repl/environment', '', 'The global environment.', () => GLOBAL_ENV);
D('make-environment', '[parent]', 'A new empty environment inside PARENT (default the global one); eval\'s definitions in it stay in it.', ([p]) => {
  const parent = p === undefined || p === false ? GLOBAL_ENV : p;
  if (!(parent instanceof Environment)) throw typeErr('environment', parent, 'make-environment');
  return new Environment(new Scope(parent.scope, []), [parent.frame]);
});
D('eval', 'expr [env]', 'Evaluate EXPR in ENV (default the global environment).', ([x, env]) => evalIn(x, env));
/* The slot of SYM in ENV: [frame, index], or null when it is not bound locally. */
function envSlot(env, s) {
  if (!(env instanceof Environment)) throw typeErr('environment', env, 'environment');
  const r = env.scope ? lookup(env.scope, s) : null;
  if (!r || r.macro) return null;
  let e = env.frame; for (let d = 0; d < r.depth; d++) e = e[0];
  return [e, r.index];
}
D('environment-bound?', 'env symbol', '#t if SYMBOL is bound in ENV.', ([e, s]) => { sym(s, 'environment-bound?'); const sl = envSlot(e, s); return sl ? true : isBound(s.name); });
D('symbol-bound?', 'env symbol', '#t if SYMBOL is bound in ENV.', ([e, s]) => { sym(s, 'symbol-bound?'); const sl = e instanceof Environment ? envSlot(e, s) : null; return sl ? true : isBound(s.name); });
D('environment-lookup', 'env symbol', 'The value of SYMBOL in ENV.', ([e, s]) => { sym(s, 'environment-lookup'); const sl = envSlot(e, s); if (sl) { const v = sl[0][sl[1]]; if (v === undefined) throw new SchemeError('unbound-variable', 'Unassigned variable: ' + s.name, [s]); return v; } return gref(s.name); });
D('environment-assign!', 'env symbol value', 'Set SYMBOL in ENV.', ([e, s, v]) => { sym(s, 'environment-assign!'); const sl = envSlot(e, s); if (sl) sl[0][sl[1]] = v; else gset(s.name, v); return UNSPEC; });
D('environment-define', 'env symbol value', 'Bind SYMBOL in ENV itself.', ([e, s, v]) => { sym(s, 'environment-define'); if (!(e instanceof Environment)) throw typeErr('environment', e, 'environment-define'); if (!e.scope) { gdef(s.name, v); return s; } let k = e.scope.names.get(s); if (k === undefined) k = e.scope.add(s); e.frame[k] = v; return s; });

/* features, load and require (files are read through hooks.readFile) */
const featureList = [];
D('provide', 'feature', 'Record that FEATURE is present.', ([f]) => { sym(f, 'provide'); if (!featureList.includes(f)) featureList.unshift(f); return f; });
D('featurep', 'feature', '#t if FEATURE has been provided.', ([f]) => featureList.includes(f));
D('features', '', 'The features provided, the latest first.', () => listOf(featureList));
gdef('load-path', NIL);
gdoc.set('load-path', 'Directories (strings) require searches for FEATURE.scm.');
const joinPath = (d, f) => d === '' || d === '.' ? f : d.endsWith('/') ? d + f : d + '/' + f;
D('load', 'filename [env]', 'Read FILENAME (through the host) and evaluate its forms in ENV.', ([f, env]) => loadFile(str(f, 'load'), env));
D('require', 'feature [filename]', 'Load FEATURE unless it is provided: FILENAME, or FEATURE.scm in a directory of load-path. The file must provide FEATURE.', ([f, file]) => {
  sym(f, 'require');
  if (featureList.includes(f)) return f;
  const name = file === undefined || file === false ? f.name + '.scm' : str(file, 'require');
  const dirs = arr(gbox('load-path').value || NIL);
  const tries = name.startsWith('/') ? [name] : dirs.map(d => joinPath(str(d, 'require'), name));
  let path = null, text = null;
  if (hooks.readFile) for (const p of tries) { const t = hooks.readFile(p); if (t !== null && t !== undefined && t !== false) { path = p; text = String(t); break; } }
  if (text === null) throw new SchemeError('file-error', `Cannot open load file: ${name}` + (hooks.readFile ? '' : ' (no file reader is installed)'), [f]);
  for (const x of readAll(text, path)) evalForm(x);
  if (!featureList.includes(f)) throw new SchemeError('error', `Loading file ${path} did not provide feature ${f.name}`, [f]);
  return f;
});
D('procedure-name', 'f', 'Name of the procedure, or #f.', ([f]) => proc(f, 'procedure-name').procName || false);
D('procedure-documentation', 'f', 'Docstring of the procedure, or #f.', ([f]) => proc(f, 'procedure-documentation').doc || false);
D('procedure-arity', 'f', 'Required argument count.', ([f]) => proc(f).arity === undefined ? false : f.arity);
D('procedure-property', 'f key [default]', 'Property KEY of procedure F.', ([f, k, d]) => { const p = proc(f, 'procedure-property').props; const v = p && p.get(k); return v === undefined ? opt(d, false) : v; });
D('set-procedure-property!', 'f key value', 'Set property KEY of procedure F.', ([f, k, v]) => { proc(f, 'set-procedure-property!'); if (!f.props) f.props = new Map(); f.props.set(k, v); return UNSPEC; });
D('set-procedure-name!', 'f name', 'Name procedure F.', ([f, n]) => { proc(f).procName = n instanceof Sym ? n.name : str(n); return UNSPEC; });
D('void', '. ignored', 'The unspecified value.', () => UNSPEC);
D('unspecific', '', 'The unspecified value.', () => UNSPEC);
pred('unspecified?', x => x instanceof Unspecified);
pred('default-object?', x => x === false || x === undefined);
D('identity', 'x', 'X.', ([x]) => x);
D('const', 'x', 'A procedure that always returns X.', ([x]) => () => x);
D('compose', '. fs', 'Composition of the procedures.', fs => args => { let v = args.length === 1 ? args[0] : new Values(args); for (let i = fs.length - 1; i >= 0; i--) v = callProc(fs[i], v instanceof Values ? v.vals : [v]); return v; });
D('runtime', '', 'Seconds since the epoch.', () => Date.now() / 1000);
D('real-time', '', 'Milliseconds since the epoch.', () => Date.now());
D('current-time', '', 'Seconds since the epoch.', () => Date.now() / 1000);
D('current-seconds', '', 'Seconds since the epoch.', () => Date.now() / 1000);
D('performance-now', '', 'High-resolution milliseconds.', () => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
D('exit', '[code]', 'Not available in the editor.', () => { throw err('exit: the editor cannot exit'); });
D('bound?', 'symbol', '#t if the global variable is bound.', ([s]) => isBound(sym(s, 'bound?').name));
D('global-ref', 'symbol', 'Value of the global variable.', ([s]) => gref(sym(s, 'global-ref').name));
D('global-set!', 'symbol value', 'Set the global variable.', ([s, v]) => { gset(sym(s, 'global-set!').name, v); return UNSPEC; });
D('global-define!', 'symbol value', 'Define the global variable.', ([s, v]) => { gdef(sym(s).name, v); return s; });
D('global-unbind!', 'symbol', 'Make the global variable unbound.', ([s]) => { const b = globals.get(sym(s).name); if (b) b.value = undefined; return UNSPEC; });
D('variable-documentation', 'symbol', 'Docstring of a global variable, or #f.', ([s]) => gdoc.get(sym(s).name) || false);
D('set-variable-documentation!', 'symbol doc', 'Set the docstring of a global variable.', ([s, d]) => { gdoc.set(sym(s).name, str(d)); return UNSPEC; });
D('global-names', '', 'Names of every bound global, sorted.', () => listOf([...globals.entries()].filter(([, b]) => b.value !== undefined).map(([n]) => n).sort()));
D('macro?', 'symbol', '#t if the symbol names a macro.', ([s]) => macros.has(sym(s).name));
D('macroexpand-1', 'form', 'Expand the outermost macro of FORM once.', ([f]) => { if (f instanceof Pair) { const m = macroFor(null, f.car); if (m) return strip(expandMacro(m, f, null)); } return f; });
D('macroexpand', 'form', 'Expand macros at the head of FORM until none apply.', ([f]) => { for (let n = 0; n < 1000; n++) { if (!(f instanceof Pair)) return f; const m = macroFor(null, f.car); if (!m) return strip(f); f = expandMacro(m, f, null); } return strip(f); });

/* input and output: textual ports (R7RS), strings and the message area */
/* The console ports write through hooks.output (and hooks.errorOutput), read when written to. */
const consolePort = makeOutputPort(s => { if (hooks.output) hooks.output(s); }, 'console');
const consoleErrorPort = makeOutputPort(s => { const f = hooks.errorOutput || hooks.output; if (f) f(s); }, 'console-error');
const emptyInput = makeStringInputPort('', 'console-input');
const curOut = new Param(consolePort, null, 'current-output-port');
const curErr = new Param(consoleErrorPort, null, 'current-error-port');
const curIn = new Param(emptyInput, null, 'current-input-port');
gdef('current-output-port', curOut); gdef('current-error-port', curErr); gdef('current-input-port', curIn);
const outPort = (p, who) => { if (p === undefined || p === true) return curOut.value; if (p instanceof Port && p.output) return p; throw typeErr('output port', p, who); };
const inPort = (p, who) => { if (p === undefined) return curIn.value; if (p instanceof Port && p.input) return p; throw typeErr('input port', p, who); };
const errPort = () => curErr.value instanceof Port ? curErr.value : consolePort;
const openIn = (p, who) => { if (!p.open) throw new SchemeError('wrong-type-argument', who + ': the port is closed', [p]); return p; };
/* Call THUNK with the current output port bound to PORT. */
function withOutputTo(port, thunk) { const old = curOut.value; curOut.value = port; try { return thunk(); } finally { curOut.value = old; } }
pred('port?', x => x instanceof Port); pred('input-port?', x => x instanceof Port && x.input); pred('output-port?', x => x instanceof Port && x.output);
pred('textual-port?', x => x instanceof Port); pred('binary-port?', () => false);
D('input-port-open?', 'port', '#t if PORT is open.', ([p]) => inPort(p, 'input-port-open?').open);
D('output-port-open?', 'port', '#t if PORT is open.', ([p]) => outPort(p, 'output-port-open?').open);
for (const n of ['close-port', 'close-input-port', 'close-output-port']) D(n, 'port', 'Close PORT.', ([p]) => { if (!(p instanceof Port)) throw typeErr('port', p, n); p.open = false; return UNSPEC; });
D('open-input-string', 'string', 'An input port reading STRING.', ([s]) => makeStringInputPort(str(s, 'open-input-string')));
D('open-output-string', '', 'An output port collecting what is written to it; see get-output-string.', () => makeStringOutputPort());
D('get-output-string', 'port', 'What has been written to a string output PORT.', ([p]) => { if (!(p instanceof Port) || !p.chunks) throw typeErr('string output port', p, 'get-output-string'); return p.string(); });
D('with-output-to-string', '[thunk]', 'What THUNK writes to the current output port, as a string.', ([t]) => { const p = makeStringOutputPort(); if (t !== undefined) withOutputTo(p, () => callProc(t, [])); return p.string(); });
D('call-with-output-string', 'proc', 'What PROC writes to the port it is called with, as a string.', ([f]) => { const p = makeStringOutputPort(); callProc(f, [p]); return p.string(); });
D('with-input-from-string', 'string thunk', 'Call THUNK with the current input port reading STRING.', ([s, t]) => { const old = curIn.value; curIn.value = makeStringInputPort(str(s, 'with-input-from-string')); try { return callProc(t, []); } finally { curIn.value = old; } });
D('read-char', '[port]', 'The next character of PORT, or the eof object.', ([p]) => { p = openIn(inPort(p, 'read-char'), 'read-char'); if (p.pos >= p.text.length) return EOF; const c = p.text.codePointAt(p.pos); p.pos += c > 0xffff ? 2 : 1; return mkchar(c); });
D('peek-char', '[port]', 'The next character of PORT without reading it, or the eof object.', ([p]) => { p = openIn(inPort(p, 'peek-char'), 'peek-char'); return p.pos >= p.text.length ? EOF : mkchar(p.text.codePointAt(p.pos)); });
D('char-ready?', '[port]', '#t if a character can be read from PORT without waiting.', ([p]) => { inPort(p, 'char-ready?'); return true; });
D('read-line', '[port]', 'The next line of PORT without its newline, or the eof object.', ([p]) => {
  p = openIn(inPort(p, 'read-line'), 'read-line');
  if (p.pos >= p.text.length) return EOF;
  let j = p.text.indexOf('\n', p.pos); if (j < 0) j = p.text.length;
  const line = p.text.slice(p.pos, j); p.pos = Math.min(j + 1, p.text.length); return line;
});
D('read-string', 'k [port]', 'The next K characters of PORT (fewer at its end), or the eof object.', ([k, p]) => {
  if (k instanceof Port) [k, p] = [p, k];   // MIT's (read-string port k) order too
  p = openIn(inPort(p, 'read-string'), 'read-string'); int(k, 'read-string');
  if (p.pos >= p.text.length) return EOF;
  /* K characters, not UTF-16 units: a character outside the BMP is two units and is never split. */
  const t = p.text; let j = p.pos;
  for (let n = 0; n < k && j < t.length; n++) j += t.codePointAt(j) > 0xffff ? 2 : 1;
  const s = t.slice(p.pos, j); p.pos = j; return s;
});
/* (read [port]) reads a datum from PORT; (read string) reads one from STRING, as before. */
D('read', '[port-or-string]', 'Read one datum from PORT (the current input port), or from a string.', ([s]) => {
  if (typeof s === 'string') return read(s);
  const p = openIn(inPort(s, 'read'), 'read');
  const r = reader(p.text, p.file || null); r.pos = p.pos;
  if (r.done) { p.pos = p.text.length; return EOF; }
  const v = r.form(); p.pos = r.pos; return v;
});
D('write-string', 'string [port start end]', 'Write the characters of STRING (from START to END) to PORT.', ([s, p, a, b]) => { str(s, 'write-string'); outPort(p, 'write-string').put(a === undefined ? s : s.slice(a, opt(b, s.length))); return UNSPEC; });
D('write-char', 'char [port]', 'Write CHAR to PORT.', ([c, p]) => { outPort(p, 'write-char').put(String.fromCodePoint(chr(c, 'write-char').code)); return UNSPEC; });
D('write-u8', 'byte [port]', 'Not supported: ports are textual.', () => { throw new SchemeError('wrong-type-argument', 'write-u8: ports are textual', []); });
D('flush-output', '[port]', 'Nothing to do: ports are not buffered.', ([p]) => { outPort(p, 'flush-output'); return UNSPEC; });
D('fresh-line', '[port]', 'Start a new line on PORT unless it is at the start of one.', ([p]) => { p = outPort(p, 'fresh-line'); if (p.last !== 10) p.put('\n'); return UNSPEC; });
D('object->string', 'obj', 'Printed form of OBJ, like write.', ([x]) => write(x));
D('display->string', 'obj', 'Printed form of OBJ, like display.', ([x]) => display(x));
D('string-pad', 's n', 'S padded on the right to N characters.', ([s, n]) => str(s).padEnd(n));
/* format: ~a ~s ~d ~% ~~ (Scheme) and %s %S %d %c %x %f %% (Emacs) both work. */
function fmt(f, args) {
  let k = 0;
  return f.replace(/~([asd%~])|%(-?)(\d*)(?:\.(\d+))?([sSdcxXof%])/g, (m, t, left, w, prec, c) => {
    if (t) { if (t === '%') return '\n'; if (t === '~') return '~'; const a = args[k++]; return t === 'a' ? display(a) : t === 's' ? write(a) : display(a); }
    if (c === '%') return '%';
    const a = args[k++]; let out;
    switch (c) {
      case 's': out = display(a); break; case 'S': out = write(a); break;
      case 'd': out = typeof a === 'bigint' ? a.toString() : String(Math.trunc(num(a, 'format'))); break; case 'c': out = a instanceof Char ? cs(a) : String.fromCodePoint(num(a)); break;
      case 'x': out = numx(a, 'format').toString(16); break; case 'X': out = numx(a, 'format').toString(16).toUpperCase(); break; case 'o': out = numx(a, 'format').toString(8); break;
      case 'f': out = num(a).toFixed(prec ? +prec : 6); break;
    }
    if (prec && c === 's') out = out.slice(0, +prec);
    if (w) out = left ? out.padEnd(+w) : out.padStart(+w);
    return out;
  });
}
D('format', 'destination format . args', 'Format ARGS: ~a ~s ~% or %s %S %d %c %x %f. DESTINATION #f returns the string, #t writes to the current output port, a port writes to it; a format string first returns the string.', ([d, ...a]) => {
  if (typeof d === 'string') return fmt(d, a);
  const s = fmt(str(a[0], 'format'), a.slice(1));
  if (d === false) return s;
  outPort(d, 'format').put(s);
  return UNSPEC;
});
D('string-format', 'format . args', 'Format ARGS into the string.', ([f, ...a]) => fmt(str(f), a));
D('display', 'obj [port]', 'Print OBJ for people.', ([x, p]) => { outPort(p, 'display').put(display(x)); return UNSPEC; });
D('write', 'obj [port]', 'Print OBJ so it can be read back.', ([x, p]) => { outPort(p, 'write').put(write(x)); return UNSPEC; });
D('write-shared', 'obj [port]', 'Print OBJ so it can be read back.', ([x, p]) => { outPort(p, 'write-shared').put(write(x)); return UNSPEC; });
D('write-simple', 'obj [port]', 'Print OBJ so it can be read back.', ([x, p]) => { outPort(p, 'write-simple').put(write(x)); return UNSPEC; });
D('newline', '[port]', 'Print a newline.', ([p]) => { outPort(p, 'newline').put('\n'); return UNSPEC; });
D('write-line', 'obj [port]', 'Print OBJ and a newline.', ([x, p]) => { outPort(p, 'write-line').put(write(x) + '\n'); return UNSPEC; });
D('pp', 'obj [port]', 'Print OBJ.', ([x, p]) => { outPort(p, 'pp').put(write(x) + '\n'); return UNSPEC; });
D('read-from-string', 'string [start]', 'Read one datum from STRING; return it and the end index as two values.', ([s, st]) => { const r = reader(str(s)); r.pos = opt(st, 0); const v = r.form(); return new Values([v, r.pos]); });
D('read-all', 'string [file]', 'Read every datum from STRING as a list.', ([s, f]) => listOf(readAll(str(s), f === undefined || f === false ? null : str(f, 'read-all'))));
pred('eof-object?', x => x === EOF);
D('eof-object', '', 'The end-of-file object.', () => EOF);
D('set-record-type-printer!', 'type printer', 'Print records of TYPE by calling (PRINTER record port); #f restores the default.', ([t, p]) => { if (!(t instanceof RecordType)) throw typeErr('record type', t, 'set-record-type-printer!'); t.printer = p || null; return UNSPEC; });
pred('record?', x => x instanceof Record);
D('record-type-descriptor', 'record', 'The type of RECORD.', ([r]) => { if (!(r instanceof Record)) throw typeErr('record', r, 'record-type-descriptor'); return r.type; });
D('record-type-name', 'type', 'The name of record TYPE, a symbol.', ([t]) => { if (!(t instanceof RecordType)) throw typeErr('record type', t, 'record-type-name'); return intern(t.name); });
D('object-hash', 'obj', 'A number for OBJ (the one it prints with), or #f for an immediate value.', ([x]) => objectHash(x));

/* regular expressions over JS syntax, used by the editor's search code and string utilities */
D('regexp', 'pattern [flags]', 'A compiled JavaScript regular expression.', ([p, f]) => { try { return new RegExp(str(p, 'regexp'), opt(f, 'u')); } catch (e) { throw err('regexp: ' + e.message); } });
pred('regexp?', x => x instanceof RegExp);
D('regexp-match', 'regexp s [start]', 'List of the match and its groups, or #f.', ([r, s, st]) => { const rx = new RegExp(r.source, r.flags.includes('g') ? r.flags : r.flags + 'g'); rx.lastIndex = opt(st, 0); const m = rx.exec(str(s)); return m ? listOf([...m].map(g => g === undefined ? false : g)) : false; });
D('regexp-match-index', 'regexp s [start]', 'Index of the match, or #f.', ([r, s, st]) => { const rx = new RegExp(r.source, r.flags.includes('g') ? r.flags : r.flags + 'g'); rx.lastIndex = opt(st, 0); const m = rx.exec(str(s)); return m ? m.index : false; });
D('regexp-replace', 'regexp s replacement', 'S with every match replaced (replacement may be a string with $1 or a procedure).', ([r, s, rep]) => str(s).replace(new RegExp(r.source, r.flags.includes('g') ? r.flags : r.flags + 'g'), typeof rep === 'string' ? rep : (...m) => display(callProc(rep, [m[0], ...m.slice(1, -2).map(g => g === undefined ? false : g)]))));
D('regexp-split', 'regexp s', 'S split at every match.', ([r, s]) => listOf(str(s).split(r)));
D('regexp-quote', 's', 'S with regexp metacharacters escaped.', ([s]) => str(s).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'));

/* ---------- generator variants of the higher-order primitives (R4.38) ---------- */
/* In generator mode a primitive that calls a procedure runs its .gen variant, so the procedure can
   hold the thread. Primitives without one (sort's comparator, assoc's equality, regexp-replace's
   procedure) call back into Scheme in place; such a callback cannot block. */
const G = (name, gen) => { gref(name).gen = gen; };
const minLen = as => as.length ? Math.min(...as.map(a => a.length)) : 0;
G('map', function* ([f, ...ls]) { const as = ls.map(l => arr(l)); const n = minLen(as); const out = new Array(n); for (let i = 0; i < n; i++) out[i] = yield* applyG(f, as.map(a => a[i])); return listOf(out); });
G('for-each', function* ([f, ...ls]) { const as = ls.map(l => arr(l)); const n = minLen(as); for (let i = 0; i < n; i++) yield* applyG(f, as.map(a => a[i])); return UNSPEC; });
G('append-map', function* ([f, l]) { const out = []; for (const x of arr(l)) out.push(...arr(yield* applyG(f, [x]))); return listOf(out); });
G('filter-map', function* ([f, l]) { const out = []; for (const x of arr(l)) { const v = yield* applyG(f, [x]); if (v !== false) out.push(v); } return listOf(out); });
G('filter', function* ([p, l]) { const out = []; for (const x of arr(l)) if ((yield* applyG(p, [x])) !== false) out.push(x); return listOf(out); });
G('remove', function* ([p, l]) { const out = []; for (const x of arr(l)) if ((yield* applyG(p, [x])) === false) out.push(x); return listOf(out); });
G('partition', function* ([p, l]) { const a = [], b = []; for (const x of arr(l)) ((yield* applyG(p, [x])) !== false ? a : b).push(x); return new Values([listOf(a), listOf(b)]); });
G('reduce', function* ([f, init, l]) { const a = arr(l); if (!a.length) return init; let acc = a[0]; for (let i = 1; i < a.length; i++) acc = yield* applyG(f, [a[i], acc]); return acc; });
G('fold', function* ([f, init, ...ls]) { const as = ls.map(l => arr(l)); const n = minLen(as); let acc = init; for (let i = 0; i < n; i++) acc = yield* applyG(f, [...as.map(a => a[i]), acc]); return acc; });
G('fold-left', function* ([f, init, l]) { let acc = init; for (const x of arr(l)) acc = yield* applyG(f, [acc, x]); return acc; });
G('fold-right', function* ([f, init, l]) { let acc = init; const a = arr(l); for (let i = a.length - 1; i >= 0; i--) acc = yield* applyG(f, [a[i], acc]); return acc; });
G('find', function* ([p, l]) { for (const x of arr(l)) if ((yield* applyG(p, [x])) !== false) return x; return false; });
G('find-tail', function* ([p, l]) { let c = l; while (c instanceof Pair) { if ((yield* applyG(p, [c.car])) !== false) return c; c = c.cdr; } return false; });
G('any', function* ([p, ...ls]) { const as = ls.map(l => arr(l)); const n = minLen(as); for (let i = 0; i < n; i++) { const v = yield* applyG(p, as.map(a => a[i])); if (v !== false) return v; } return false; });
G('every', function* ([p, ...ls]) { const as = ls.map(l => arr(l)); const n = minLen(as); let v = true; for (let i = 0; i < n; i++) { v = yield* applyG(p, as.map(a => a[i])); if (v === false) return false; } return v; });
G('count', function* ([p, l]) { let n = 0; for (const x of arr(l)) if ((yield* applyG(p, [x])) !== false) n++; return n; });
G('take-while', function* ([p, l]) { const out = []; for (const x of arr(l)) { if ((yield* applyG(p, [x])) === false) break; out.push(x); } return listOf(out); });
G('drop-while', function* ([p, l]) { let c = l; while (c instanceof Pair && (yield* applyG(p, [c.car])) !== false) c = c.cdr; return c; });
G('apply', function* ([f, ...a]) { return new TailCall(f, a.length ? a.slice(0, -1).concat(arr(a[a.length - 1])) : []); });
G('vector-map', function* ([f, v]) { const a = vec(v), out = new Array(a.length); for (let i = 0; i < a.length; i++) out[i] = yield* applyG(f, [a[i]]); return out; });
G('vector-for-each', function* ([f, v]) { const a = vec(v); for (let i = 0; i < a.length; i++) yield* applyG(f, [a[i]]); return UNSPEC; });
G('string-for-each', function* ([f, s]) { for (const c of str(s)) yield* applyG(f, [mkchar(c.codePointAt(0))]); return UNSPEC; });
G('string-map', function* ([f, s]) { let out = ''; for (const c of str(s)) { const r = yield* applyG(f, [mkchar(c.codePointAt(0))]); out += r instanceof Char ? cs(r) : str(r); } return out; });
G('hash-table-walk', function* ([t, f]) { for (const [k, v] of [...ht(t)]) yield* applyG(f, [k, v]); return UNSPEC; });
G('hash-for-each', function* ([f, t]) { for (const [k, v] of [...ht(t)]) yield* applyG(f, [k, v]); return UNSPEC; });
G('hash-map->list', function* ([f, t]) { const out = []; for (const [k, v] of [...ht(t)]) out.push(yield* applyG(f, [k, v])); return listOf(out); });
G('hash-table-update!', function* ([t, k, f, d]) { const cur = ht(t).get(k); if (cur === undefined && d === undefined) throw err('hash-table-update!: no value for key', k); const base = cur === undefined ? yield* applyG(d, []) : cur; t.set(k, yield* applyG(f, [base])); return UNSPEC; });
G('hash-table-update!/default', function* ([t, k, f, d]) { const cur = ht(t).get(k); t.set(k, yield* applyG(f, [cur === undefined ? d : cur])); return UNSPEC; });
G('call-with-values', function* ([p, c]) { const v = yield* applyG(p, []); return new TailCall(c, v instanceof Values ? v.vals : [v]); });
G('call/ec', function* ([f]) {
  const tag = {}; const k = named(args => { throw new Escape(tag, args); }, 'escape');
  const s = sp;
  try { return yield* applyG(f, [k]); } catch (e) { if (e instanceof Escape && e.tag === tag) { sp = s; return e.vals.length === 1 ? e.vals[0] : new Values(e.vals); } throw e; }
});
G('dynamic-wind', function* ([b, t, a]) { yield* applyG(b, []); try { return yield* applyG(t, []); } finally { yield* applyG(a, []); } });
G('force', function* ([p]) { if (typeof p === 'function' && p.isPromise) return p.gen ? yield* p.gen() : p(); return p; });
G('with-exception-handler', function* ([h, t]) { proc(h, 'with-exception-handler'); const saved = handlers; handlers = { h, js: false, next: saved }; try { return yield* applyG(t, []); } finally { handlers = saved; } });
G('error', function* ([m, ...irr]) { return yield* signalG(m instanceof SchemeError ? m : new SchemeError('error', typeof m === 'string' ? m : write(m), irr), false); });
G('user-error', function* ([m, ...a]) { return yield* signalG(new SchemeError('user-error', fmt(str(m, 'user-error'), a), []), false); });
G('raise', function* ([o]) { return yield* signalG(o, false); });
G('raise-continuable', function* ([o]) { return yield* signalG(o, true); });
G('%restart-case', function* ([thunk, ...specs]) {
  const tag = {}, rs = [];
  for (let i = 0; i + 3 < specs.length; i += 4) rs.push(new Restart(specs[i], specs[i + 1], specs[i + 2], specs[i + 3], tag, false));
  return yield* establishG(rs, tag, function* () { return yield* applyG(thunk, []); });
});
G('%with-simple-restart', function* ([n, thunk, f, ...a]) {
  const tag = {};
  return yield* establishG([new Restart(n, typeof f === 'string' ? fmt(f, a) : false, null, () => new Values([false, true]), tag, true)], tag, function* () { return yield* applyG(thunk, []); });
});
G('eval', function* ([x, env]) { return yield* evalInG(x, env); });
G('load', function* ([f, env]) { return yield* loadFileG(str(f, 'load'), env); });
G('with-output-to-string', function* ([t]) { const p = makeStringOutputPort(); if (t !== undefined) yield* withDynG(curOut, p, function* () { return yield* applyG(t, []); }); return p.string(); });
G('call-with-output-string', function* ([f]) { const p = makeStringOutputPort(); yield* applyG(f, [p]); return p.string(); });
G('with-input-from-string', function* ([s, t]) { return yield* withDynG(curIn, makeStringInputPort(str(s, 'with-input-from-string')), function* () { return yield* applyG(t, []); }); });

/* standard macros written in Scheme itself */
const PRELUDE = `
(define-syntax while
  (syntax-rules ()
    ((_ test body ...) (let loop () (when test body ... (loop))))))
(define-syntax until
  (syntax-rules ()
    ((_ test body ...) (let loop () (unless test body ... (loop))))))
(define-syntax dolist
  (syntax-rules ()
    ((_ (var list) body ...) (for-each (lambda (var) body ...) list))
    ((_ (var list result) body ...) (begin (for-each (lambda (var) body ...) list) result))))
(define-syntax dotimes
  (syntax-rules ()
    ((_ (var n) body ...) (let ((limit n)) (do ((var 0 (+ var 1))) ((>= var limit)) body ...)))
    ((_ (var n result) body ...) (let ((limit n)) (do ((var 0 (+ var 1))) ((>= var limit) result) body ...)))))
(define-syntax push!
  (syntax-rules () ((_ x place) (set! place (cons x place)))))
(define-syntax pop!
  (syntax-rules () ((_ place) (let ((top (car place))) (set! place (cdr place)) top))))
(define-syntax inc!
  (syntax-rules () ((_ place) (set! place (+ place 1))) ((_ place n) (set! place (+ place n)))))
(define-syntax dec!
  (syntax-rules () ((_ place) (set! place (- place 1))) ((_ place n) (set! place (- place n)))))
(define-syntax swap!
  (syntax-rules () ((_ a b) (let ((tmp a)) (set! a b) (set! b tmp)))))
(define-syntax assert-type
  (syntax-rules () ((_ pred x) (unless (pred x) (error "Wrong type:" 'pred x)))))
(define-syntax unwind-protect
  (syntax-rules () ((_ body cleanup ...) (dynamic-wind (lambda () #f) (lambda () body) (lambda () cleanup ...)))))
(define-syntax ignore-errors
  (syntax-rules () ((_ body ...) (guard (e (#t #f)) body ...))))
(define-syntax condition-case
  (syntax-rules (error)
    ((_ var body (error handler ...)) (guard (var (#t handler ...)) body))))
(define-syntax catch
  (syntax-rules () ((_ tag body ...) (call/ec (lambda (k) (parameterize ((%catch-tags (cons (cons tag k) (%catch-tags)))) body ...))))))
(define %catch-tags (make-parameter '()))
(define (throw tag . vals)
  (let ((entry (assq tag (%catch-tags))))
    (if entry (apply (cdr entry) vals) (error "No catch for tag:" tag))))
(define-syntax let1
  (syntax-rules () ((_ var val body ...) (let ((var val)) body ...))))
(define-syntax if-let
  (syntax-rules () ((_ (var val) then else) (let ((var val)) (if var then else))) ((_ (var val) then) (let ((var val)) (if var then)))))
(define-syntax when-let
  (syntax-rules () ((_ (var val) body ...) (let ((var val)) (when var body ...)))))
(define-syntax and-let*
  (syntax-rules ()
    ((_ () body ...) (begin body ...))
    ((_ ((var val) rest ...) body ...) (let ((var val)) (if var (and-let* (rest ...) body ...) #f)))
    ((_ ((expr) rest ...) body ...) (if expr (and-let* (rest ...) body ...) #f))))
(define-syntax ->
  (syntax-rules ()
    ((_ x) x)
    ((_ x (f args ...) rest ...) (-> (f x args ...) rest ...))
    ((_ x f rest ...) (-> (f x) rest ...))))
(define-syntax ->>
  (syntax-rules ()
    ((_ x) x)
    ((_ x (f args ...) rest ...) (->> (f args ... x) rest ...))
    ((_ x f rest ...) (->> (f x) rest ...))))
(define-syntax define-inline (syntax-rules () ((_ head body ...) (define head body ...))))
(define (assoc-ref alist key . default)
  (let ((p (assoc key alist))) (if p (cdr p) (if (pair? default) (car default) #f))))
(define (alist-copy a) (map (lambda (p) (if (pair? p) (cons (car p) (cdr p)) p)) a))
(define (alist-delete key alist) (remove (lambda (p) (and (pair? p) (equal? (car p) key))) alist))
(define (string-empty? s) (string-null? s))
(define (char-blank? c) (or (char=? c #\\space) (char=? c #\\tab)))
(define (list-tabulate n f) (map f (iota n)))
(define (flatten x) (cond ((null? x) '()) ((pair? x) (append (flatten (car x)) (flatten (cdr x)))) (else (list x))))
(define (assq-del alist key) (remove (lambda (p) (and (pair? p) (eq? (car p) key))) alist))
(define (string-join* sep . strings) (string-join strings sep))
(define (boolean->string b) (if b "#t" "#f"))
(define (vector-index pred v) (let loop ((i 0)) (cond ((>= i (vector-length v)) #f) ((pred (vector-ref v i)) i) (else (loop (+ i 1))))))
(define (exact-nonnegative-integer? x) (and (exact-integer? x) (>= x 0)))
(define (char-ascii? c) (< (char->integer c) 128))
(define (string-search-char s ch) (string-index s ch))
`;
evalString(PRELUDE);

/* ---------- exports ---------- */
const Scheme = {
  Sym, Alias, Pair, Char, Nil, Param, Record, RecordType, Values, Box, SchemeError, Raise, Escape, TailCall, Unspecified,
  NIL, UNSPEC, EOF, intern, gensym, mkchar, isKeyword, cons, list, listOf, arr, isList, car, cdr, truthy,
  read, readAll, reader, write, display, writeString, eqv, equal, globals, macros, gbox, gref, gset, gdef, isBound, gdoc,
  callProc, def, D, named, arity, comp, evalForm, evalString, errorMessage, fmt, hooks, strip, typeErr, err,
  num, int, str, sym, chr, vec, proc, opt, watchdog, lookup, Scope, baseName, scanClosure,
  // numbers (R4.3)
  numx, isNumber, isExactInt, add, sub, mul, div, quotient, remainder, modulo, expt, exact: exactOf, inexact, parseNumber,
  // ports (R4.4)
  Port, makeOutputPort, makeStringOutputPort, makeStringInputPort, consolePort, currentOutputPort: curOut, currentErrorPort: curErr, currentInputPort: curIn, withOutputTo,
  // environments and loading (R4.5, R4.10)
  Environment, globalEnvironment: GLOBAL_ENV, evalIn, loadFile, readFileText, features: featureList,
  // source locations (R4.6)
  sourceLocation, SrcLoc,
  // hash tables and printing (R4.7, R4.8)
  WeakTable, objectHash,
  // conditions, handlers, restarts (R4.31-R4.33)
  ConditionType, conditionType, defineConditionType, conditionIs, isErrorCondition, conditionReportString: errorMessage,
  signal, withHandler, DECLINE, Restart, withRestarts, computeRestarts, findRestart, invokeRestart, restartArgs, restartReport, Unwind,
  // the shadow stack (R4.34)
  backtrace: () => backtrace(), conditionBacktrace, resetStack, stackDepth: () => sp - 1, setMaxDepth, get maxDepth() { return MAX_DEPTH; }, shadowStack: SHADOW,
  // generator mode and threads (R4.38-R4.40)
  setMode, get mode() { return GEN ? 'gen' : 'direct'; }, Block, Suspend, PREEMPT, applyG, evalFormG, evalInG, loadFileG, signalG, establishG, withRestartsG, unwoundG,
  driveSync, ThreadState, switchTo, get threadState() { return TS; }, bindDyn, withDynG, isPrimitive, tick,
};
g.Scheme = Scheme;
if (typeof module !== 'undefined') module.exports = Scheme;
}
schemeModule(globalThis);
/* The module is a function so a worker can be built from its source (pool.js). */
globalThis.schemeSource = '(' + schemeModule.toString() + ')(self);';
})();
