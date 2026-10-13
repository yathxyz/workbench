/* Edwin Scheme — the extension language of the editor.
   A Lisp-1 with lexical scope and closures, proper tail calls, parameters for dynamic
   binding, define-syntax/syntax-rules (introduced identifiers are renamed, so temporaries
   never capture user variables), define-macro, escape continuations, dynamic-wind, guard,
   records, vectors, hash tables and chars. Expressions are compiled once into JS closures
   with lexical addressing, then run. */
(function () {
function schemeModule(g) {
'use strict';

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
class RecordType { constructor(name, fieldNames) { this.name = name; this.fieldNames = fieldNames; } }
class Box { constructor(name, value) { this.name = name; this.value = value; } }
class TailCall { constructor(f, args) { this.f = f; this.args = args; } }
class Env { constructor(name, parent) { this.name = name; this.parent = parent; } }

const NIL = new Nil(), UNSPEC = new Unspecified(), EOF = new Eof();
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
  if (e instanceof SchemeError) return e.message + (e.kind === 'error' && e.irritants.length ? ' ' + e.irritants.map(x => write(x)).join(' ') : '');
  if (e instanceof Raise) return 'Uncaught exception: ' + write(e.obj);
  if (e instanceof RangeError) return 'Stack overflow';
  return e && e.message ? e.message : String(e);
}

/* ---------- reader ---------- */
const DELIM = /[\s()\[\]"';`,]/;
const NAMED_CHARS = { space: 32, newline: 10, tab: 9, nul: 0, null: 0, return: 13, escape: 27, esc: 27, delete: 127, del: 127, backspace: 8, alarm: 7, linefeed: 10, altmode: 27, rubout: 127 };
function reader(src) {
  let i = 0;
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
  function readList(close) {
    i++; const items = [];
    for (;;) {
      skip();
      if (i >= src.length) eof();
      if (src[i] === close) { i++; return listOf(items); }
      if (src[i] === ')' || src[i] === ']') throw new SchemeError('read-error', `Unexpected ${src[i]}`);
      if (src[i] === '.' && (i + 1 >= src.length || DELIM.test(src[i + 1])) && items.length) {
        i++; const tail = form(); skip();
        if (src[i] !== close) throw new SchemeError('read-error', 'Bad dotted list');
        i++; return listOf(items, tail);
      }
      items.push(form());
    }
  }
  function form() {
    skip();
    if (i >= src.length) eof();
    const c = src[i];
    if (c === '(') return readList(')');
    if (c === '[') return readList(']');
    if (c === ')' || c === ']') { i++; throw new SchemeError('read-error', `Unexpected ${c}`); }
    if (c === "'") { i++; return list(S.quote, form()); }
    if (c === '`') { i++; return list(S.quasiquote, form()); }
    if (c === ',') { i++; if (src[i] === '@') { i++; return list(S['unquote-splicing'], form()); } return list(S.unquote, form()); }
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
        const n = d === 'x' ? parseInt(tok, 16) : d === 'b' ? parseInt(tok, 2) : d === 'o' ? parseInt(tok, 8) : Number(tok);
        if (isNaN(n)) throw new SchemeError('read-error', 'Bad number: #' + d + tok);
        return n;
      }
      if (d === '!') { let j = i; while (j < src.length && !DELIM.test(src[j])) j++; const tok = src.slice(i + 2, j); i = j; if (tok === 'eof') return EOF; if (tok === 'unspecific' || tok === 'void') return UNSPEC; if (tok === 'default' || tok === 'optional' || tok === 'rest' || tok === 'key') return intern('#!' + tok); return form(); }
      throw new SchemeError('read-error', 'Bad # syntax');
    }
    let j = i;
    if (src[i] === '|') { j = src.indexOf('|', i + 1); if (j < 0) eof(); const name = src.slice(i + 1, j); i = j + 1; return intern(name); }
    while (j < src.length && !DELIM.test(src[j])) j++;
    const tok = src.slice(i, j); i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(tok)) return Number(tok);
    if (/^[+-]?\d+\/\d+$/.test(tok)) { const [a, b] = tok.split('/'); return Number(a) / Number(b); }
    if (tok === '+inf.0') return Infinity; if (tok === '-inf.0') return -Infinity; if (tok === '+nan.0') return NaN;
    if (tok.length > 1 && tok[tok.length - 1] === ':' && tok[0] !== ':') return intern(':' + tok.slice(0, -1));
    return intern(tok);
  }
  return { form, get done() { skip(); return i >= src.length; }, get pos() { return i; }, set pos(v) { i = v; } };
}
function read(src) { return reader(src).form(); }
function readAll(src) { const r = reader(src), out = []; while (!r.done) out.push(r.form()); return out; }

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
  if (typeof x === 'number') return Number.isInteger(x) ? String(x) : Number.isFinite(x) ? (String(x).includes('.') || String(x).includes('e') ? String(x) : x + '.0') : x > 0 ? '+inf.0' : x < 0 ? '-inf.0' : '+nan.0';
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
  if (x instanceof Map) return '#<hash-table ' + x.size + '>';
  if (x instanceof Record) return '#<' + x.type.name + (x.fields.length ? ' ' + x.fields.map(f => write(f, display)).join(' ') : '') + '>';
  if (x instanceof RecordType) return '#<record-type ' + x.name + '>';
  if (x instanceof Values) return x.vals.map(v => write(v, display)).join(' ');
  if (x instanceof Unspecified || x instanceof Eof || x instanceof Nil) return x.toString();
  if (x && typeof x.__print === 'function') return x.__print();
  if (x instanceof SchemeError) return '#<error ' + writeString(x.message) + '>';
  return String(x);
}
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
const watchdog = { limitMs: 8000, reset() { tickN = 0; stepT0 = 0; } };
function tick() {
  if ((++tickN & 0x3FFFF) !== 0) return;
  const now = performance.now();
  if (!stepT0) { stepT0 = now; return; }
  if (now - stepT0 > watchdog.limitMs) { stepT0 = 0; throw new SchemeError('error', `Interrupted: evaluation ran for more than ${Math.round(watchdog.limitMs / 1000)} s`, []); }
}
function callProc(f, args) {
  if (typeof f !== 'function') {
    if (f instanceof Param) { if (args.length) { f.value = f.converter ? callProc(f.converter, [args[0]]) : args[0]; return UNSPEC; } return f.value; }
    if (f instanceof Sym && isBound(f.name) && typeof gref(f.name) === 'function') return callProc(gref(f.name), args);
    throw new SchemeError('wrong-type-argument', `Not a procedure: ${write(f)}`, [f]);
  }
  let r = f(args);
  while (r instanceof TailCall) { tick(); r = typeof r.f === 'function' ? r.f(r.args) : callProc(r.f, r.args); }
  return r;
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
  S.receive, S.assert, S.delay, S['case-lambda'], S['named-lambda'], S['define-values'], S['let-syntax'], S['letrec-syntax'], S['the-environment']]);

const K = v => () => v;
function body(forms, scope, tail) {
  // Internal defines become letrec*-style slots in the current scope.
  const list = arr(forms);
  if (!list.length) return K(UNSPEC);
  const compiled = [];
  // Pre-scan for internal defines to allocate slots before compiling (mutual recursion).
  if (scope) for (const f of list) {
    if (f instanceof Pair && special(scope, f.car) === 'define') {
      const target = f.cdr.car;
      const name = target instanceof Pair ? target.car : target;
      if (isId(name) && !scope.names.has(name)) scope.add(name);
    }
    if (f instanceof Pair && special(scope, f.car) === 'define-values') { for (const n of arr(f.cdr.car)) if (isId(n) && !scope.names.has(n)) scope.add(n); }
    if (f instanceof Pair && special(scope, f.car) === 'define-record-type') { const spec = arr(f.cdr); const ctor = spec[1] instanceof Pair ? spec[1].car : spec[1]; for (const n of [ctor, spec[2]]) if (isId(n) && !scope.names.has(n)) scope.add(n); for (const fd of spec.slice(3)) for (const n of arr(fd).slice(1)) if (isId(n) && !scope.names.has(n)) scope.add(n); }
  }
  for (let i = 0; i < list.length; i++) compiled.push(comp(list[i], scope, tail && i === list.length - 1));
  if (compiled.length === 1) return compiled[0];
  const n = compiled.length - 1;
  return env => { for (let i = 0; i < n; i++) compiled[i](env); return compiled[n](env); };
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
function makeLambda(params, bodyForms, scope, name) {
  const { names, optional, rest } = parseParams(params);
  const all = [...names, ...optional]; if (rest) all.push(rest);
  const inner = new Scope(scope, all);
  let doc = null;
  if (bodyForms instanceof Pair && typeof bodyForms.car === 'string' && bodyForms.cdr !== NIL) { doc = bodyForms.car; bodyForms = bodyForms.cdr; }
  /* The source form, kept on every closure so a thread can be given a copy of it (pool.js). */
  const srcForm = new Pair(S.lambda, new Pair(params, bodyForms));
  const run = body(bodyForms, inner, true);
  const nReq = names.length, nOpt = optional.length, hasRest = !!rest;
  const slotRest = nReq + nOpt + 1;
  return env => {
    const f = function (args) {
      const n = args.length;
      if (n < nReq || (!hasRest && n > nReq + nOpt)) throw new SchemeError('wrong-number-of-arguments', `${f.procName || 'procedure'}: expected ${hasRest ? 'at least ' : ''}${nReq}${nOpt && !hasRest ? '..' + (nReq + nOpt) : ''} argument${nReq === 1 ? '' : 's'}, got ${n}`);
      const frame = new Array(inner.size);
      frame[0] = env;
      for (let i = 0; i < nReq + nOpt; i++) frame[i + 1] = i < n ? args[i] : false;
      if (hasRest) frame[slotRest] = n > nReq + nOpt ? listOf(args.slice(nReq + nOpt)) : NIL;
      return run(frame);
    };
    f.procName = name || null; f.doc = doc; f.arity = nReq; f.rest = hasRest; f.optional = nOpt; f.params = params;
    f.src = srcForm; f.scope = inner; f.env = env;
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
  return () => { const v = box.value; if (v === undefined) throw new SchemeError('unbound-variable', `Unbound variable: ${name}`); return v; };
}
function compSet(id, valc, scope, define) {
  const r = lookup(scope, id);
  if (scan) scan.refs.push([id, r]);
  if (r && r.macro) throw new SchemeError('syntax-error', 'Cannot assign to a macro: ' + baseName(id).name);
  if (r) {
    const { depth, index } = r;
    return env => { let e = env; for (let d = 0; d < depth; d++) e = e[0]; const v = valc(env); if (define && typeof v === 'function' && !v.procName) v.procName = baseName(id).name; e[index] = v; return define ? baseName(id) : UNSPEC; };
  }
  const name = baseName(id).name, box = gbox(name);
  if (define) return env => { const v = valc(env); if (typeof v === 'function' && !v.procName) v.procName = name; box.value = v; return baseName(id); };
  return env => { if (box.value === undefined) throw new SchemeError('unbound-variable', `Unbound variable: ${name}`); box.value = valc(env); return UNSPEC; };
}
function compCall(form, scope, tail) {
  const fc = comp(form.car, scope, false);
  const argcs = arr(form.cdr).map(a => comp(a, scope, false));
  const n = argcs.length;
  if (tail) {
    if (n === 0) return env => new TailCall(fc(env), []);
    if (n === 1) return env => new TailCall(fc(env), [argcs[0](env)]);
    if (n === 2) return env => new TailCall(fc(env), [argcs[0](env), argcs[1](env)]);
    return env => { const f = fc(env), args = new Array(n); for (let i = 0; i < n; i++) args[i] = argcs[i](env); return new TailCall(f, args); };
  }
  const call = (f, args) => {
    if (typeof f !== 'function') return callProc(f, args);
    let r = f(args);
    while (r instanceof TailCall) { tick(); r = typeof r.f === 'function' ? r.f(r.args) : callProc(r.f, r.args); }
    return r;
  };
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
  if (m) return comp(expandMacro(m, x, scope), scope, tail);
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
        const lam = makeLambda(params, bodyForms, scope, baseName(nameSpec).name);
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
    case 'lambda': need(1); return makeLambda(a[0], x.cdr.cdr, scope, null);
    case 'named-lambda': { need(1); const spec = a[0]; return makeLambda(spec.cdr, x.cdr.cdr, scope, baseName(spec.car).name); }
    case 'begin': return body(x.cdr, scope, tail);
    case 'let': {
      need(1);
      if (isId(a[0])) {
        // named let
        const nm = a[0], bindings = arr(a[1]).map(b => b instanceof Pair ? [b.car, b.cdr === NIL ? UNSPEC : b.cdr.car] : [b, UNSPEC]);
        const loopScope = new Scope(scope, [nm]);
        const lam = makeLambda(listOf(bindings.map(b => b[0])), x.cdr.cdr.cdr, loopScope, baseName(nm).name);
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
      const lam = target instanceof Pair ? makeLambda(target.cdr, x.cdr.cdr, scope, baseName(nameId).name) : comp(a[1], scope, false);
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
      // (guard (var clause...) body...)
      need(2);
      const spec = a[0], v = spec.car;
      const inner = new Scope(scope, [v]);
      const clauses = spec.cdr;
      const handler = comp(new Pair(S.cond, clauses), inner, false);
      const hasElse = arr(clauses).some(cl => cl instanceof Pair && isId(cl.car) && baseName(cl.car) === S.else);
      const run = body(x.cdr.cdr, scope, false);
      return env => {
        try { return run(env); }
        catch (e) {
          if (e instanceof Escape || e instanceof RangeError) throw e;
          const obj = e instanceof Raise ? e.obj : e;
          if (hooks.isQuit && hooks.isQuit(obj)) throw e;
          const frame = [env, obj];
          if (hasElse) return handler(frame);
          // Without else, a cond that falls through re-raises.
          const r = handler(frame);
          if (r === UNSPEC && !clauseMatched(clauses, frame, inner)) throw e;
          return r;
        }
      };
    }
    case 'define-record-type': {
      need(3);
      const typeName = a[0] instanceof Pair ? a[0].car : a[0];
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
      return env => { for (const s of setters) s(env); return baseName(typeName); };
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
    case 'assert': { need(1); const c = comp(a[0], scope, false); const src = write(strip(a[0])); return env => { if (c(env) === false) throw new SchemeError('assertion-failed', 'Assertion failed: ' + src); return true; }; }
    case 'delay': { need(1); const c = comp(a[0], scope, false); return env => { let done = false, v; const p = () => { if (!done) { v = c(env); done = true; } return v; }; p.isPromise = true; return p; }; }
    case 'case-lambda': {
      const clauses = a.map(cl => makeLambda(cl.car, cl.cdr, scope, null));
      return env => { const fs = clauses.map(c => c(env)); const f = args => { for (const g of fs) if (args.length === g.arity || (g.rest && args.length >= g.arity) || (args.length >= g.arity && args.length <= g.arity + (g.optional || 0))) return g(args); throw new SchemeError('wrong-number-of-arguments', 'case-lambda: no clause for ' + args.length + ' arguments'); }; return f; };
    }
    case 'the-environment': return () => scope;
  }
  throw new SchemeError('syntax-error', 'Unknown special form ' + name);
}
function clauseMatched(clauses, frame, scope) {
  for (const cl of arr(clauses)) { const c = comp(cl.car, scope, false); if (c(frame) !== false) return true; }
  return false;
}
function lookupValue(id, scope, env) {
  const r = lookup(scope, id);
  if (r && !r.macro) { let e = env; for (let d = 0; d < r.depth; d++) e = e[0]; return e[r.index]; }
  return globals.get(baseName(id).name)?.value;
}
const gdoc = new Map();
const hooks = { isQuit: null };

/* ---------- evaluation entry points ---------- */
let steps = 0;
function evalForm(form) { const c = comp(form, null, false); return c(null); }
/* Compile FORM in SCOPE only to see what it uses: { scopes, refs: [[id, lookup result or null]],
   macros: [[keyword, lookup result or null]] }. The scopes are the ones FORM binds itself. */
function scanClosure(form, scope) {
  const prev = scan, out = { scopes: new Set(), refs: [], macros: [] };
  scan = out;
  try { comp(form, scope, false); } finally { scan = prev; }
  return out;
}
function evalString(src) { let v = UNSPEC; for (const f of readAll(src)) v = evalForm(f); return v; }

/* ---------- builtins ---------- */
function def(name, fn, opts) {
  fn.procName = name;
  if (opts) { if (opts.doc) fn.doc = opts.doc; if (opts.args) fn.params = opts.args; if (opts.interactive !== undefined) fn.interactive = opts.interactive; }
  gdef(name, fn); return fn;
}
const D = (name, args, doc, fn) => def(name, fn, { args, doc });
const num = (x, who) => { if (typeof x !== 'number') throw typeErr('number', x, who); return x; };
const int = (x, who) => { if (!Number.isInteger(x)) throw typeErr('integer', x, who); return x; };
const str = (x, who) => { if (typeof x !== 'string') throw typeErr('string', x, who); return x; };
const sym = (x, who) => { if (!(x instanceof Sym)) throw typeErr('symbol', x, who); return x; };
const chr = (x, who) => { if (!(x instanceof Char)) throw typeErr('char', x, who); return x; };
const vec = (x, who) => { if (!Array.isArray(x)) throw typeErr('vector', x, who); return x; };
const proc = (x, who) => { if (typeof x !== 'function' && !(x instanceof Param)) throw typeErr('procedure', x, who); return x; };
const ht = (x, who) => { if (!(x instanceof Map)) throw typeErr('hash table', x, who); return x; };
const opt = (x, d) => x === undefined ? d : x;

/* numbers */
D('+', '. numbers', 'Sum of the numbers.', a => { let s = 0; for (const v of a) s += num(v, '+'); return s; });
D('*', '. numbers', 'Product of the numbers.', a => { let s = 1; for (const v of a) s *= num(v, '*'); return s; });
D('-', 'n . numbers', 'Negation of one number, or the first minus the rest.', a => { if (!a.length) throw err('-: expected at least 1 argument'); if (a.length === 1) return -num(a[0], '-'); let s = num(a[0], '-'); for (let i = 1; i < a.length; i++) s -= num(a[i], '-'); return s; });
D('/', 'n . numbers', 'Reciprocal of one number, or the first divided by the rest.', a => { if (!a.length) throw err('/: expected at least 1 argument'); if (a.length === 1) return 1 / num(a[0], '/'); let s = num(a[0], '/'); for (let i = 1; i < a.length; i++) { const d = num(a[i], '/'); if (d === 0) throw new SchemeError('divide-by-zero', 'Division by zero'); s /= d; } return s; });
D('quotient', 'a b', 'Integer quotient, truncating toward zero.', ([a, b]) => { if (int(b, 'quotient') === 0) throw new SchemeError('divide-by-zero', 'Division by zero'); return Math.trunc(int(a, 'quotient') / b); });
D('remainder', 'a b', 'Remainder with the sign of A.', ([a, b]) => { if (int(b, 'remainder') === 0) throw new SchemeError('divide-by-zero', 'Division by zero'); return int(a, 'remainder') % b; });
D('modulo', 'a b', 'Modulo with the sign of B.', ([a, b]) => { if (int(b, 'modulo') === 0) throw new SchemeError('divide-by-zero', 'Division by zero'); return ((int(a, 'modulo') % b) + b) % b; });
D('abs', 'x', 'Absolute value.', ([x]) => Math.abs(num(x, 'abs')));
D('min', 'x . xs', 'Smallest argument.', a => Math.min(...a.map(v => num(v, 'min'))));
D('max', 'x . xs', 'Largest argument.', a => Math.max(...a.map(v => num(v, 'max'))));
D('gcd', '. ns', 'Greatest common divisor.', a => a.reduce((g, v) => { v = Math.abs(int(v, 'gcd')); while (v) [g, v] = [v, g % v]; return g; }, 0));
D('lcm', '. ns', 'Least common multiple.', a => a.reduce((l, v) => { v = Math.abs(int(v, 'lcm')); if (!l || !v) return 0; let g = l, w = v; while (w) [g, w] = [w, g % w]; return l / g * v; }, 1));
for (const [n, f] of [['floor', Math.floor], ['ceiling', Math.ceil], ['round', x => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; }], ['truncate', Math.trunc], ['sqrt', Math.sqrt], ['exp', Math.exp], ['sin', Math.sin], ['cos', Math.cos], ['tan', Math.tan], ['asin', Math.asin], ['acos', Math.acos]])
  D(n, 'x', `${n[0].toUpperCase() + n.slice(1)} of X.`, ([x]) => f(num(x, n)));
D('log', 'x [base]', 'Natural logarithm, or the logarithm in BASE.', ([x, b]) => b === undefined ? Math.log(num(x, 'log')) : Math.log(num(x, 'log')) / Math.log(num(b, 'log')));
D('atan', 'y [x]', 'Arc tangent.', ([y, x]) => x === undefined ? Math.atan(num(y, 'atan')) : Math.atan2(num(y, 'atan'), num(x, 'atan')));
D('expt', 'x y', 'X raised to the power Y.', ([x, y]) => Math.pow(num(x, 'expt'), num(y, 'expt')));
D('exact->inexact', 'x', 'X as a float.', ([x]) => num(x, 'exact->inexact'));
D('inexact->exact', 'x', 'X as an integer when it is one.', ([x]) => num(x, 'inexact->exact'));
D('exact', 'x', 'X as an integer when it is one.', ([x]) => num(x, 'exact'));
D('inexact', 'x', 'X as a float.', ([x]) => num(x, 'inexact'));
D('number->string', 'n [radix]', 'Printed form of N.', ([n, r]) => r === undefined || r === 10 ? write(num(n, 'number->string')) : num(n).toString(r));
D('string->number', 's [radix]', 'The number S names, or #f.', ([s, r]) => { const t = str(s, 'string->number').trim(); if (r !== undefined && r !== 10) { const v = parseInt(t, r); return isNaN(v) ? false : v; } if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return false; return Number(t); });
D('random', '[n]', 'Random integer below N, or a float in [0,1).', ([n]) => n === undefined ? Math.random() : Number.isInteger(n) ? Math.floor(Math.random() * n) : Math.random() * num(n, 'random'));
D('1+', 'n', 'N plus one.', ([n]) => num(n, '1+') + 1);
D('1-', 'n', 'N minus one.', ([n]) => num(n, '1-') - 1);
D('square', 'n', 'N squared.', ([n]) => num(n, 'square') ** 2);
D('exact-integer?', 'x', 'Non-#f if X is an integer.', ([x]) => Number.isInteger(x));
D('bitwise-and', '. ns', 'Bitwise and.', a => a.reduce((s, v) => s & int(v, 'bitwise-and'), -1));
D('bitwise-or', '. ns', 'Bitwise or.', a => a.reduce((s, v) => s | int(v, 'bitwise-or'), 0));
D('bitwise-xor', '. ns', 'Bitwise xor.', a => a.reduce((s, v) => s ^ int(v, 'bitwise-xor'), 0));
D('arithmetic-shift', 'n count', 'Shift N left by COUNT bits (right if negative).', ([n, c]) => c >= 0 ? int(n, 'arithmetic-shift') * 2 ** c : Math.floor(int(n, 'arithmetic-shift') / 2 ** -c));
function cmp(name, f) { D(name, 'a b . rest', 'Numeric comparison over all arguments.', a => { for (let i = 0; i + 1 < a.length; i++) if (!f(num(a[i], name), num(a[i + 1], name))) return false; return true; }); }
cmp('=', (x, y) => x === y); cmp('<', (x, y) => x < y); cmp('>', (x, y) => x > y); cmp('<=', (x, y) => x <= y); cmp('>=', (x, y) => x >= y);
const pred = (n, f, doc) => D(n, 'x', doc || 'Type predicate.', ([x]) => f(x));
pred('number?', x => typeof x === 'number'); pred('integer?', x => Number.isInteger(x)); pred('real?', x => typeof x === 'number');
pred('rational?', x => typeof x === 'number' && Number.isFinite(x)); pred('exact?', x => Number.isInteger(x)); pred('inexact?', x => typeof x === 'number' && !Number.isInteger(x));
pred('zero?', x => num(x, 'zero?') === 0); pred('positive?', x => num(x, 'positive?') > 0); pred('negative?', x => num(x, 'negative?') < 0);
pred('even?', x => int(x, 'even?') % 2 === 0); pred('odd?', x => int(x, 'odd?') % 2 !== 0); pred('nan?', x => Number.isNaN(x)); pred('infinite?', x => x === Infinity || x === -Infinity); pred('finite?', x => Number.isFinite(x));

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
function hkey(k) { return k instanceof Char ? 'c' + k.code : k; }
D('make-hash-table', '. args', 'A new hash table (keys compared with eqv?, strings by value).', () => new Map());
D('make-equal-hash-table', '', 'A new hash table.', () => new Map());
D('make-strong-eqv-hash-table', '', 'A new hash table.', () => new Map());
D('make-string-hash-table', '', 'A new hash table.', () => new Map());
pred('hash-table?', x => x instanceof Map);
D('hash-table-ref', 'table key [fail]', 'Value for KEY, or the result of FAIL.', ([t, k, f]) => { const v = ht(t).get(hkey(k)); if (v !== undefined) return v; if (f === undefined) throw err('hash-table-ref: no value for key', k); return callProc(f, []); });
D('hash-table-ref/default', 'table key default', 'Value for KEY, or DEFAULT.', ([t, k, d]) => { const v = ht(t).get(hkey(k)); return v === undefined ? d : v; });
D('hash-ref', 'table key [default]', 'Value for KEY, or DEFAULT (#f).', ([t, k, d]) => { const v = ht(t).get(hkey(k)); return v === undefined ? opt(d, false) : v; });
D('hash-table-set!', 'table key value', 'Store VALUE under KEY.', ([t, k, v]) => { ht(t).set(hkey(k), v); return UNSPEC; });
D('hash-set!', 'table key value', 'Store VALUE under KEY.', ([t, k, v]) => { ht(t).set(hkey(k), v); return UNSPEC; });
D('hash-table-delete!', 'table key', 'Remove KEY.', ([t, k]) => { ht(t).delete(hkey(k)); return UNSPEC; });
D('hash-remove!', 'table key', 'Remove KEY.', ([t, k]) => { ht(t).delete(hkey(k)); return UNSPEC; });
D('hash-table-contains?', 'table key', '#t if KEY is present.', ([t, k]) => ht(t).has(hkey(k)));
D('hash-table-exists?', 'table key', '#t if KEY is present.', ([t, k]) => ht(t).has(hkey(k)));
D('hash-table-count', 'table', 'Number of entries.', ([t]) => ht(t).size);
D('hash-table-size', 'table', 'Number of entries.', ([t]) => ht(t).size);
D('hash-table-keys', 'table', 'List of the keys.', ([t]) => listOf([...ht(t).keys()].map(k => typeof k === 'string' && /^c\d+$/.test(k) && false ? k : k)));
D('hash-table-values', 'table', 'List of the values.', ([t]) => listOf([...ht(t).values()]));
D('hash-table->alist', 'table', 'The entries as an alist.', ([t]) => listOf([...ht(t)].map(([k, v]) => new Pair(k, v))));
D('hash-table-walk', 'table f', 'Call F with each key and value.', ([t, f]) => { for (const [k, v] of ht(t)) callProc(f, [k, v]); return UNSPEC; });
D('hash-for-each', 'f table', 'Call F with each key and value.', ([f, t]) => { for (const [k, v] of ht(t)) callProc(f, [k, v]); return UNSPEC; });
D('hash-map->list', 'f table', 'List of F applied to each key and value.', ([f, t]) => listOf([...ht(t)].map(([k, v]) => callProc(f, [k, v]))));
D('hash-table-update!', 'table key f [default]', 'Replace the value under KEY with (f value).', ([t, k, f, d]) => { const cur = ht(t).get(hkey(k)); const base = cur === undefined ? (d === undefined ? (() => { throw err('hash-table-update!: no value for key', k); })() : callProc(d, [])) : cur; t.set(hkey(k), callProc(f, [base])); return UNSPEC; });
D('hash-table-update!/default', 'table key f default', 'Replace the value under KEY with (f value), starting from DEFAULT.', ([t, k, f, d]) => { const cur = ht(t).get(hkey(k)); t.set(hkey(k), callProc(f, [cur === undefined ? d : cur])); return UNSPEC; });
D('hash-table-clear!', 'table', 'Remove every entry.', ([t]) => { ht(t).clear(); return UNSPEC; });
D('hash-table-copy', 'table', 'A copy.', ([t]) => new Map(ht(t)));

/* control */
pred('procedure?', x => typeof x === 'function' || x instanceof Param);
D('values', '. xs', 'Return several values.', a => a.length === 1 ? a[0] : new Values(a));
D('call-with-values', 'producer consumer', 'Call CONSUMER with the values PRODUCER returns.', ([p, c]) => { const v = callProc(p, []); return new TailCall(c, v instanceof Values ? v.vals : [v]); });
D('call/ec', 'f', 'Call F with an escape procedure that returns from this call.', ([f]) => {
  const tag = {}; const k = named(args => { throw new Escape(tag, args); }, 'escape');
  try { return callProc(f, [k]); } catch (e) { if (e instanceof Escape && e.tag === tag) return e.vals.length === 1 ? e.vals[0] : new Values(e.vals); throw e; }
});
gdef('call-with-escape-continuation', gref('call/ec'));
gdef('call-with-current-continuation', gref('call/ec'));
gdef('call/cc', gref('call/ec'));
D('dynamic-wind', 'before thunk after', 'Call BEFORE, THUNK and AFTER; AFTER also runs if THUNK escapes.', ([b, t, a]) => { callProc(b, []); try { return callProc(t, []); } finally { callProc(a, []); } });
D('force', 'promise', 'Value of a delayed expression.', ([p]) => typeof p === 'function' && p.isPromise ? p() : p);
D('make-promise', 'x', 'A promise already forced to X.', ([x]) => { const p = () => x; p.isPromise = true; return p; });
D('make-parameter', 'value [converter]', 'A parameter object; call it to read, parameterize to bind.', ([v, c]) => new Param(c ? callProc(c, [v]) : v, c || null));
D('parameter?', 'x', '#t if X is a parameter.', ([x]) => x instanceof Param);
D('error', 'message . irritants', 'Signal an error.', ([m, ...irr]) => { throw new SchemeError('error', typeof m === 'string' ? m : write(m), irr); });
D('user-error', 'format . args', 'Signal an error meant for the user.', ([m, ...a]) => { throw new SchemeError('user-error', fmt(str(m), a), []); });
D('raise', 'obj', 'Raise OBJ as an exception.', ([o]) => { throw new Raise(o, false); });
D('raise-continuable', 'obj', 'Raise OBJ; a handler may return a value.', ([o]) => { throw new Raise(o, true); });
D('with-exception-handler', 'handler thunk', 'Call THUNK; if it raises, call HANDLER with the condition.', ([h, t]) => { try { return callProc(t, []); } catch (e) { if (e instanceof Escape || e instanceof RangeError) throw e; const obj = e instanceof Raise ? e.obj : e; if (hooks.isQuit && hooks.isQuit(obj)) throw e; return callProc(h, [obj]); } });
pred('error?', x => x instanceof SchemeError); pred('error-object?', x => x instanceof SchemeError);
D('error-object-message', 'e', 'Message of the error.', ([e]) => e instanceof SchemeError ? e.message : write(e));
D('error-object-irritants', 'e', 'Irritants of the error.', ([e]) => e instanceof SchemeError ? listOf(e.irritants) : NIL);
D('error-message', 'e', 'Message of the error.', ([e]) => e instanceof SchemeError ? e.message : write(e));
D('error-kind', 'e', 'Kind of the error, a symbol.', ([e]) => e instanceof SchemeError ? intern(e.kind) : intern('unknown'));
D('error-message-string', 'e', 'Message of the error with its irritants.', ([e]) => errorMessage(e));
D('condition/report-string', 'e', 'Message of the error with its irritants.', ([e]) => errorMessage(e));
D('eval', 'expr [env]', 'Evaluate EXPR.', ([x]) => evalForm(x));
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
D('symbol-bound?', 'env symbol', '#t if the global variable is bound.', ([e, s]) => isBound(sym(s).name));
D('environment-bound?', 'env symbol', '#t if the global variable is bound.', ([e, s]) => isBound(sym(s).name));
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

/* input and output: strings and the message area */
D('write-string', 'obj . rest', 'Printed form of OBJ, like display.', ([x]) => display(x));
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
      case 'd': out = String(Math.trunc(num(a, 'format'))); break; case 'c': out = a instanceof Char ? cs(a) : String.fromCodePoint(num(a)); break;
      case 'x': out = num(a).toString(16); break; case 'X': out = num(a).toString(16).toUpperCase(); break; case 'o': out = num(a).toString(8); break;
      case 'f': out = num(a).toFixed(prec ? +prec : 6); break;
    }
    if (prec && c === 's') out = out.slice(0, +prec);
    if (w) out = left ? out.padEnd(+w) : out.padStart(+w);
    return out;
  });
}
D('format', 'destination-or-string . args', 'Format ARGS into the string: ~a ~s ~% or %s %S %d %c %x %f.', ([d, ...a]) => {
  if (typeof d === 'string') return fmt(d, a);
  const s = fmt(str(a[0], 'format'), a.slice(1));
  if (d === false) return s;
  if (hooks.output) hooks.output(s);
  return UNSPEC;
});
D('string-format', 'format . args', 'Format ARGS into the string.', ([f, ...a]) => fmt(str(f), a));
D('display', 'obj [port]', 'Print OBJ for people.', ([x]) => { if (hooks.output) hooks.output(display(x)); return UNSPEC; });
D('write', 'obj [port]', 'Print OBJ so it can be read back.', ([x]) => { if (hooks.output) hooks.output(write(x)); return UNSPEC; });
D('newline', '[port]', 'Print a newline.', () => { if (hooks.output) hooks.output('\n'); return UNSPEC; });
D('write-line', 'obj', 'Print OBJ and a newline.', ([x]) => { if (hooks.output) hooks.output(write(x) + '\n'); return UNSPEC; });
D('pp', 'obj', 'Print OBJ.', ([x]) => { if (hooks.output) hooks.output(write(x) + '\n'); return UNSPEC; });
D('read', '[string]', 'Read one datum from the string.', ([s]) => s === undefined ? EOF : read(str(s)));
D('read-from-string', 'string [start]', 'Read one datum from STRING; return it and the end index as two values.', ([s, st]) => { const r = reader(str(s)); r.pos = opt(st, 0); const v = r.form(); return new Values([v, r.pos]); });
D('read-all', 'string', 'Read every datum from STRING as a list.', ([s]) => listOf(readAll(str(s))));
pred('eof-object?', x => x === EOF);
D('eof-object', '', 'The end-of-file object.', () => EOF);

/* regular expressions over JS syntax, used by the editor's search code and string utilities */
D('regexp', 'pattern [flags]', 'A compiled JavaScript regular expression.', ([p, f]) => { try { return new RegExp(str(p, 'regexp'), opt(f, 'u')); } catch (e) { throw err('regexp: ' + e.message); } });
pred('regexp?', x => x instanceof RegExp);
D('regexp-match', 'regexp s [start]', 'List of the match and its groups, or #f.', ([r, s, st]) => { const rx = new RegExp(r.source, r.flags.includes('g') ? r.flags : r.flags + 'g'); rx.lastIndex = opt(st, 0); const m = rx.exec(str(s)); return m ? listOf([...m].map(g => g === undefined ? false : g)) : false; });
D('regexp-match-index', 'regexp s [start]', 'Index of the match, or #f.', ([r, s, st]) => { const rx = new RegExp(r.source, r.flags.includes('g') ? r.flags : r.flags + 'g'); rx.lastIndex = opt(st, 0); const m = rx.exec(str(s)); return m ? m.index : false; });
D('regexp-replace', 'regexp s replacement', 'S with every match replaced (replacement may be a string with $1 or a procedure).', ([r, s, rep]) => str(s).replace(new RegExp(r.source, r.flags.includes('g') ? r.flags : r.flags + 'g'), typeof rep === 'string' ? rep : (...m) => display(callProc(rep, [m[0], ...m.slice(1, -2).map(g => g === undefined ? false : g)]))));
D('regexp-split', 'regexp s', 'S split at every match.', ([r, s]) => listOf(str(s).split(r)));
D('regexp-quote', 's', 'S with regexp metacharacters escaped.', ([s]) => str(s).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'));

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
};
g.Scheme = Scheme;
if (typeof module !== 'undefined') module.exports = Scheme;
}
schemeModule(globalThis);
/* The module is a function so a worker can be built from its source (pool.js). */
globalThis.schemeSource = '(' + schemeModule.toString() + ')(self);';
})();
