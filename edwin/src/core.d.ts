/* Edwin's shared types: the model the core files (edwin/src/*.ts) and desktop Edwin (edwin/native/js/*.ts)
   hand each other, and the globals one file sets and the next reads.

   An ambient script (no import or export): every name here is global to both tsconfigs. The files are classic
   scripts, each wrapped in its own IIFE, so the globals below are the only names they share; a type a single
   file needs belongs inside that file's IIFE.

   Sections:
     platform     what bare V8 lacks (native/js/prelude.ts makes it there), module, a DOM stand-in
     Scheme       the value model (scheme.ts), the Scheme object, L (runtime.ts)
     Rope         the buffer text (text.ts)
     editor       buffers, markers, windows, frames, keymaps, the minibuffer, E, the hooks, Ed (editor-core.ts
                  and the files that add to it)
     host         EdHost: the browser, Node and native hosts in one shape
     OT           EdOT (ot.ts)
     pool         EdPool and the worker realm (pool.ts)
     display      the model frame's backend and model (display.ts), Ed.display
     modules      EvilCore, EvilEx, Complete, Yas and the rest
     native       __n, __native, EdTerm, EdGui, EdNativeHost
     globals      the declare var list

   Names are prefixed (Scheme*, Ed*, Rope*) so they shadow nothing: inside the IIFEs the files keep their own
   classes (Buffer, Window, Pair...), and DOM has Window and TS has Record. Extension fields other files put on
   a buffer or on E are optional here. */

/* ---------- platform ---------- */

/* desktop Edwin's V8 has no DOM and no Node: native/js/prelude.ts defines these on globalThis. They are
   written to match lib.dom's declarations, so the core's tsconfig (lib dom) merges them unchanged. */
interface Console {
  log(...data: any[]): void; // any: console takes anything, as lib.dom's does
  info(...data: any[]): void; // any: as log
  warn(...data: any[]): void; // any: as log
  error(...data: any[]): void; // any: as log
  debug(...data: any[]): void; // any: as log
  trace(...data: any[]): void; // any: as log
}
declare var console: Console;
declare function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): number; // any: the arguments go to the handler untouched
declare function clearTimeout(id: number | undefined): void;
declare function setInterval(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): number; // any: as setTimeout
declare function clearInterval(id: number | undefined): void;
declare function queueMicrotask(callback: () => void): void;
interface Performance {
  now(): number;
  readonly timeOrigin: number;
}
declare var performance: Performance;
interface TextEncoder {
  readonly encoding: string;
  encode(input?: string): Uint8Array;
}
declare var TextEncoder: {
  prototype: TextEncoder;
  new(): TextEncoder;
};
interface Crypto {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
  randomUUID(): string;
}
declare var crypto: Crypto;

/* CommonJS: ot.ts, scheme.ts, gui.ts and term.ts also export themselves when Node requires them. */
declare var module: { exports: unknown } | undefined;

/* A page element. lib.dom fills it in for the core; native has no DOM, and a model frame holds none. */
interface HTMLElement {}

/* ---------- Scheme: values (scheme.ts) ----------
   A Scheme value is a JS value:
     numbers        number (flonum or fixnum) or bigint (exact integers past 2^53)
     booleans       true, false (#f is the only false value)
     strings        JS strings (immutable)
     vectors        JS arrays
     hash tables    Map (WeakTable for weak ones)
     regexps        RegExp
     procedures     JS functions taking the argument array (SchemeProcedure)
     undefined      an absent optional argument; a variable that is unbound
   and objects of the classes below. Editor objects (buffers, markers, windows, frames, keymaps, futures) are
   values too: they print with __print(). */

/* A symbol, interned by Scheme.intern: compare with ===. */
interface SchemeSym {
  name: string;
  toString(): string;
}
/* An identifier renamed by a hygienic macro: SYM as seen from SCOPE. */
interface SchemeAlias {
  sym: SchemeSym | SchemeAlias;
  scope: SchemeScope | null;
  id: number;
  name: string;
}
interface SchemePair {
  car: SchemeValue;
  cdr: SchemeValue;
}
/* A character, interned by Scheme.mkchar: compare with ===. */
interface SchemeChar {
  code: number;
}
/* The singletons NIL (the empty list), UNSPEC and EOF: compare with ===. */
interface SchemeNil { toString(): string }
interface SchemeUnspecified { toString(): string }
interface SchemeEof { toString(): string }
/* (values a b ...), when it is not one value. */
interface SchemeValues {
  vals: SchemeValue[];
}
/* A parameter object (make-parameter); callable as a procedure through L.toFn. */
interface SchemeParam {
  value: SchemeValue;
  converter: SchemeValue | null;
  name: string | null;
}
interface SchemeRecordType {
  name: string;
  fieldNames: string[];
  printer: SchemeValue | null;
  src?: SchemeValue;
}
interface SchemeRecord {
  type: SchemeRecordType;
  fields: SchemeValue[];
}
/* A global variable's cell (Scheme.globals). L.magic replaces value with an accessor. */
interface SchemeBox {
  name: string;
  value: SchemeValue;
}
/* (the-environment) and system-global-environment (scope and frame null). */
interface SchemeEnvironment {
  scope: SchemeScope | null;
  frame: SchemeValue[] | null;
}
/* A port: string ports collect chunks or read text; an output port with a sink writes through it. */
interface SchemePort {
  name: string | null;
  input: boolean;
  output: boolean;
  open: boolean;
  sink: ((s: string) => void) | null;
  chunks: string[] | null;
  text: string;
  pos: number;
  file?: string | null;
  /* the last character written, as a code */
  last?: number;
  put(s: string): void;
  string(): string;
}
/* A restart (with-restart, restart-case). js: established from JS (fn takes spread arguments). */
interface SchemeRestart {
  name: SchemeSym | false;
  report: SchemeValue | ((r: SchemeRestart) => string);
  interactive: SchemeValue | ((r: SchemeRestart) => SchemeValue[]);
  fn: SchemeValue | ((...args: SchemeValue[]) => SchemeValue);
  tag: object;
  js: boolean;
}
/* A condition type: kinds of SchemeError form a tree under 'error'. */
interface SchemeConditionType {
  name: string;
  parent: SchemeConditionType | null;
  reporter: SchemeValue | null;
  isa(name: string): boolean;
}
/* A Scheme condition: kind names its condition type ('error', 'wrong-type-argument', 'quit'...). The
   evaluator adds the handler and stack fields as it passes through. */
interface SchemeError extends Error {
  kind: string;
  irritants: SchemeValue[];
  payload?: SchemeValue;
  signalled?: boolean;
  shadow?: SchemeStackSnapshot;
  debugged?: boolean;
}
/* (raise obj): a non-condition raised object. */
interface SchemeRaise extends Error {
  obj: SchemeValue;
  continuable: boolean;
  signalled?: boolean;
  shadow?: SchemeStackSnapshot;
  debugged?: boolean;
}
/* A continuation escape (call/cc, dynamic-wind): thrown to TAG, carrying VALS. */
interface SchemeEscape {
  tag: object;
  vals: SchemeValue[];
}
/* What a procedure in tail position returns instead of calling F: callProc runs it. */
interface SchemeTailCall {
  f: SchemeValue;
  args: SchemeValue[];
  loc?: SchemeSrcLoc | null;
}
/* A restart invocation unwinding to its establishing point. */
interface SchemeUnwind {
  tag: object;
  /* the restart, or the condition a guard unwinds with */
  a: SchemeValue;
  b: SchemeValue[];
}
/* Where a form was read: the file, its text and the line starts. */
interface SchemeSrcInfo {
  file: string | null;
  text: string;
  starts?: number[] | null;
}
interface SchemeSrcLoc {
  info: SchemeSrcInfo;
  off: number;
  readonly file: string | null;
  readonly line: number;
  readonly col: number;
  /* [line, column] */
  where(): [number, number];
  plain(): SchemePlainLoc;
}
interface SchemePlainLoc {
  file: string | null;
  line: number;
  col: number;
}
/* One frame of a backtrace (Scheme.backtrace, Scheme.conditionBacktrace). */
interface SchemeFrame {
  /* what was applied: any value can be */
  proc: SchemeValue;
  frame: SchemeValue[] | null;
  loc: SchemePlainLoc | null;
}
/* The shadow stack as captured on a condition: raw holds [proc, loc, frame] triples. */
interface SchemeStackSnapshot {
  raw: unknown[];
  proc?: SchemeValue;
  site?: SchemeSrcLoc | null;
}
/* A Map whose object keys are held weakly (make-weak-hash-table). */
interface SchemeWeakTable extends Map<SchemeValue, SchemeValue> {}
/* A compile-time scope: names to frame slots, macros, the parent scope. */
interface SchemeScope {
  parent: SchemeScope | null;
  /* keys are identifiers (symbols and aliases) */
  names: Map<SchemeValue, number>;
  macros: Map<SchemeValue, SchemeMacro> | null;
  size: number;
  add(id: SchemeValue): number;
}
/* A macro: syntax-rules (literals, rules) or a procedural transformer. */
type SchemeMacro =
  | { kind: 'rules'; literals: Set<SchemeValue>; rules: [pattern: SchemeValue, template: SchemeValue][]; scope: SchemeScope | null; lazy?: undefined; src?: SchemeValue }
  /* LAZY: the compiled transformer expression, evaluated into PROC on first use */
  | { kind: 'proc'; proc: SchemeValue; lazy?: (env: SchemeValue[] | null) => SchemeValue; src?: SchemeValue };
/* An object the editor gives Scheme: prints itself, names its type for the predicates. */
interface SchemeForeign {
  __print(): string;
  readonly __type?: string;
}

/* A procedure: primitives (def, D, CMD) and closures alike are JS functions taking the argument array. A
   result may be a tail call (closures), or a promise (async commands; the command loop awaits it). The
   properties are set by def and the evaluator, and by runtime.ts and editor-prims.ts for commands. */
interface SchemeProcedure {
  (args: SchemeValue[]): SchemeValue | SchemeTailCall | Promise<SchemeValue | void>;
  /* its name, for printing and backtraces */
  procName?: string | null;
  /* the docstring */
  doc?: string | null;
  /* the argument list as documented: "A &optional B"; a closure's is its parameter list */
  params?: string;
  /* fixed argument count, and whether more are taken */
  arity?: number;
  rest?: boolean;
  optional?: number;
  /* the closure's source, compile scope, captured frame and definition site */
  src?: SchemeValue;
  scope?: SchemeScope | null;
  env?: SchemeValue[] | null;
  loc?: SchemeSrcLoc | null;
  /* the interactive spec: a string of codes, or a function (async) giving the arguments; commands only */
  interactive?: string | SchemeValue | ((...args: unknown[]) => unknown);
  /* for an interactive function spec: it is JS, called with no arguments (runtime.ts CMD) */
  jsSpec?: boolean;
  /* (:where 'server): the command runs in edwind */
  where?: string;
  /* the server image's definer of a primitive, file:line (R4.48) */
  defAt?: string | null;
  /* symbol properties (put, get) */
  props?: Map<SchemeValue, SchemeValue>;
  /* a record type's constructor, predicate or accessor */
  recordType?: SchemeRecordType;
  /* generator mode: the closure's generator body and generator primitive */
  gbody?: unknown;
  gen?: (args: SchemeValue[]) => Generator<unknown, SchemeValue, unknown>;
  /* direct-mode compiled node */
  d?: unknown;
  /* a promise (delay, make-promise) */
  isPromise?: boolean;
  /* advice wrapped around a global function (editor-prims.ts) */
  advised?: unknown;
}

type SchemeValue =
  | number | bigint | boolean | string | null | undefined
  | SchemeSym | SchemeAlias | SchemePair | SchemeChar | SchemeNil | SchemeUnspecified | SchemeEof | SchemeValues
  | SchemeValue[] | SchemeProcedure | SchemeParam | SchemeRecord | SchemeRecordType | SchemeEnvironment | SchemePort
  | SchemeRestart | SchemeConditionType | SchemeError | SchemeRaise | SchemeFrame
  | Map<SchemeValue, SchemeValue> | RegExp | Error | SchemeForeign
  | EdBuffer | EdMarker | EdWindow | EdFrame | EdKeymap;

/* A constructor as the Scheme object exports it: instanceof narrows to T. */
interface SchemeClass<T, A extends unknown[] = any[]> { // any: the default stands for any constructor arguments
  new(...args: A): T;
  prototype: T;
}

/* ---------- Scheme: the Scheme object (scheme.ts) ---------- */

/* Scheme.hooks: what the embedder plugs in. */
interface SchemeHooks {
  /* true for the condition C-g raises (runtime.ts) */
  isQuit?: ((e: unknown) => boolean) | null;
  /* where console output and error output go */
  output?: ((s: string) => void) | null;
  errorOutput?: ((s: string) => void) | null;
  /* load and require read through it (editor-prims.ts, markdown.ts) */
  readFile?: ((path: string) => string | null | undefined | false) | null;
  /* the arguments of an interactive restart (the debugger asks) */
  restartArgs?: ((r: SchemeRestart) => SchemeValue[] | null) | null;
  /* generator mode: a thread switch, and the debugger's step */
  threadSwitch?: ((from: SchemeThreadState, to: SchemeThreadState) => void) | null;
  debugG?: unknown;
  /* the worker realm: the mirror of a buffer by its handle (pool.ts) */
  buffer?: (h: { id: string | number; name?: string; ver?: number }) => unknown;
}
/* Generator mode: one Scheme thread's evaluator state. */
interface SchemeThreadState {
  name: string | null;
  data: unknown;
  canSuspend: boolean;
  deadlineAt?: number;
}
/* Generator mode: a value a generator yields to wait for PROMISE. */
interface SchemeBlock {
  promise: Promise<unknown>;
  what: string | null;
}
interface SchemeSuspend {
  condition: SchemeValue;
  continuable: boolean;
}
/* reader(src, opts): forms one at a time. */
interface SchemeReader {
  form(): SchemeValue;
  readonly done: boolean;
  readonly pos: number;
}
type SchemeGen<T = SchemeValue> = Generator<unknown, T, unknown>;
type SchemeNumber = number | bigint;
/* A restart spec for withRestarts from JS. */
interface SchemeRestartSpec {
  name: string | SchemeSym | false;
  report?: string | ((r: SchemeRestart) => string);
  interactive?: (r: SchemeRestart) => SchemeValue[];
  fn: (...args: SchemeValue[]) => SchemeValue;
}

interface SchemeApi {
  /* classes */
  Sym: SchemeClass<SchemeSym, [name: string]>;
  Alias: SchemeClass<SchemeAlias>;
  Pair: SchemeClass<SchemePair, [car: SchemeValue, cdr: SchemeValue]>;
  Char: SchemeClass<SchemeChar, [code: number]>;
  Nil: SchemeClass<SchemeNil, []>;
  Param: SchemeClass<SchemeParam, [value: SchemeValue, converter?: SchemeValue | null, name?: string | null]>;
  Record: SchemeClass<SchemeRecord>;
  RecordType: SchemeClass<SchemeRecordType>;
  Values: SchemeClass<SchemeValues, [vals: SchemeValue[]]>;
  Box: SchemeClass<SchemeBox, [name: string, value: SchemeValue]>;
  SchemeError: SchemeClass<SchemeError, [kind: string, message: string, irritants?: SchemeValue]>;
  Raise: SchemeClass<SchemeRaise>;
  Escape: SchemeClass<SchemeEscape, [tag: object, vals: SchemeValue[]]>;
  TailCall: SchemeClass<SchemeTailCall>;
  Unspecified: SchemeClass<SchemeUnspecified, []>;
  /* the singletons */
  NIL: SchemeNil;
  UNSPEC: SchemeUnspecified;
  EOF: SchemeEof;
  /* symbols, characters, lists */
  intern(name: string): SchemeSym;
  gensym(base?: string): SchemeSym;
  mkchar(code: number): SchemeChar;
  isKeyword(x: SchemeValue): boolean;
  cons(a: SchemeValue, b: SchemeValue): SchemePair;
  list(...xs: SchemeValue[]): SchemePair | SchemeNil;
  listOf(arr: readonly SchemeValue[], tail?: SchemeValue): SchemeValue;
  arr(x: SchemeValue): SchemeValue[];
  isList(x: SchemeValue): boolean;
  car(x: SchemeValue): SchemeValue;
  cdr(x: SchemeValue): SchemeValue;
  /* not #f */
  truthy(x: SchemeValue): boolean;
  /* reader and printer */
  read(src: string): SchemeValue;
  readAll(src: string, file?: string | null): SchemeValue[];
  reader(src: string, opts?: string | { file?: string | null } | null): SchemeReader;
  write(x: SchemeValue, display?: boolean): string;
  display(x: SchemeValue): string;
  writeString(s: string): string;
  eqv(a: SchemeValue, b: SchemeValue): boolean;
  equal(a: SchemeValue, b: SchemeValue): boolean;
  /* globals and macros */
  globals: Map<string, SchemeBox>;
  macros: Map<string, SchemeMacro>;
  gbox(name: string): SchemeBox;
  gref(name: string): SchemeValue;
  gset(name: string, v: SchemeValue): SchemeValue;
  gdef(name: string, v: SchemeValue): SchemeValue;
  isBound(name: string): boolean;
  gdoc: Map<string, string>;
  /* procedures */
  callProc(f: SchemeValue, args: SchemeValue[]): SchemeValue;
  def<F extends SchemeProcedure>(name: string, fn: F, opts?: { args?: string; doc?: string; interactive?: SchemeProcedure['interactive'] }): F;
  D<F extends SchemeProcedure>(name: string, args: string, doc: string, fn: F): F;
  named<F extends SchemeProcedure>(f: F, name: string): F;
  arity<F extends SchemeProcedure>(f: F, n: number, rest?: boolean): F;
  /* evaluation */
  comp(x: SchemeValue, scope: SchemeScope | null, tail: boolean): (env: SchemeValue[] | null) => SchemeValue;
  evalForm(form: SchemeValue): SchemeValue;
  evalString(src: string, file?: string | null): SchemeValue;
  evalIn(form: SchemeValue, env?: SchemeEnvironment | null): SchemeValue;
  loadFile(path: string, env?: SchemeEnvironment | null): SchemeValue;
  readFileText(path: string): string;
  /* the provided features (symbols) */
  features: SchemeValue[];
  /* errors */
  errorMessage(e: unknown): string;
  fmt(f: string, args: SchemeValue[]): string;
  hooks: SchemeHooks;
  strip(x: SchemeValue): SchemeValue;
  typeErr(expected: string, got: SchemeValue, who?: string): SchemeError;
  err(msg: string, ...irritants: SchemeValue[]): SchemeError;
  /* argument checks: X as the type, else a wrong-type-argument error naming WHO */
  num(x: SchemeValue, who?: string): number;
  int(x: SchemeValue, who?: string): number;
  str(x: SchemeValue, who?: string): string;
  sym(x: SchemeValue, who?: string): SchemeSym;
  chr(x: SchemeValue, who?: string): SchemeChar;
  vec(x: SchemeValue, who?: string): SchemeValue[];
  proc(x: SchemeValue, who?: string): SchemeProcedure | SchemeParam;
  opt<T>(x: SchemeValue, d: T): SchemeValue | T;
  watchdog: { limitMs: number; reset(): void };
  /* compile-time scopes */
  lookup(scope: SchemeScope | null, id: SchemeValue): { macro: SchemeMacro; at: SchemeScope } | { macro?: undefined; depth: number; index: number; at: SchemeScope } | null;
  Scope: SchemeClass<SchemeScope>;
  baseName(id: SchemeValue): SchemeValue;
  scanClosure(form: SchemeValue, scope: SchemeScope | null): { scopes: Set<SchemeScope>; refs: unknown; macros: unknown };
  /* numbers */
  numx(x: SchemeValue, who?: string): SchemeNumber;
  isNumber(x: SchemeValue): x is SchemeNumber;
  isExactInt(x: SchemeValue): boolean;
  add(a: SchemeNumber, b: SchemeNumber, who?: string): SchemeNumber;
  sub(a: SchemeNumber, b: SchemeNumber, who?: string): SchemeNumber;
  mul(a: SchemeNumber, b: SchemeNumber, who?: string): SchemeNumber;
  div(a: SchemeNumber, b: SchemeNumber): SchemeNumber;
  quotient(a: SchemeNumber, b: SchemeNumber, who?: string): SchemeNumber;
  remainder(a: SchemeNumber, b: SchemeNumber, who?: string): SchemeNumber;
  modulo(a: SchemeNumber, b: SchemeNumber, who?: string): SchemeNumber;
  expt(b: SchemeNumber, e: SchemeNumber): SchemeNumber;
  exact(x: SchemeNumber): SchemeNumber;
  inexact(x: SchemeValue): number;
  parseNumber(t: string): SchemeNumber | false;
  /* ports */
  Port: SchemeClass<SchemePort>;
  makeOutputPort(fn: (s: string) => void, name?: string): SchemePort;
  makeStringOutputPort(): SchemePort;
  makeStringInputPort(text: string, name?: string): SchemePort;
  consolePort: SchemePort;
  currentOutputPort: SchemeParam;
  currentErrorPort: SchemeParam;
  currentInputPort: SchemeParam;
  withOutputTo<T>(port: SchemePort, thunk: () => T): T;
  /* environments, sources, tables */
  Environment: SchemeClass<SchemeEnvironment>;
  globalEnvironment: SchemeEnvironment;
  sourceLocation(x: SchemeValue | SchemeSrcLoc): SchemePlainLoc | null;
  SrcLoc: SchemeClass<SchemeSrcLoc>;
  WeakTable: SchemeClass<SchemeWeakTable, []>;
  objectHash(x: SchemeValue): number | false;
  /* conditions */
  ConditionType: SchemeClass<SchemeConditionType>;
  conditionType(kind: string): SchemeConditionType;
  defineConditionType(name: string, parent: string | SchemeConditionType | null, reporter?: SchemeValue): SchemeConditionType;
  conditionIs(e: unknown, kind: string | SchemeSym): boolean;
  isErrorCondition(e: unknown): boolean;
  conditionReportString(e: unknown): string;
  signal(obj: SchemeValue, continuable?: boolean): SchemeValue;
  withHandler<T>(h: SchemeValue | ((c: SchemeValue) => SchemeValue), thunk: () => T): T;
  /* a handler's answer for "not mine": the next handler is tried */
  DECLINE: object;
  /* restarts */
  Restart: SchemeClass<SchemeRestart>;
  /* the thunk's value, or the value of the restart invoked */
  withRestarts(specs: (SchemeRestart | SchemeRestartSpec)[], thunk: () => SchemeValue): SchemeValue;
  computeRestarts(): SchemeRestart[];
  findRestart(x: SchemeValue): SchemeRestart | null;
  invokeRestart(x: SchemeValue, args?: SchemeValue[]): never;
  restartArgs(r: SchemeRestart): SchemeValue[];
  restartReport(r: SchemeRestart): string;
  Unwind: SchemeClass<SchemeUnwind>;
  /* the stack */
  backtrace(): SchemeFrame[];
  conditionBacktrace(e: unknown): SchemeFrame[] | null;
  resetStack(): void;
  stackDepth(): number;
  setMaxDepth(n: number): void;
  readonly maxDepth: number;
  shadowStack: boolean;
  /* generator mode (R4.38): the G variants are generators driven by driveSync or the scheduler */
  setMode(mode: 'gen' | 'direct'): void;
  readonly mode: 'gen' | 'direct';
  Block: SchemeClass<SchemeBlock>;
  Suspend: SchemeClass<SchemeSuspend>;
  PREEMPT: object;
  applyG(f: SchemeValue, args: SchemeValue[], loc?: SchemeSrcLoc | null): SchemeGen;
  evalFormG(form: SchemeValue): SchemeGen;
  evalInG(form: SchemeValue, env?: SchemeEnvironment | null): SchemeGen;
  loadFileG(path: string, env?: SchemeEnvironment | null): SchemeGen;
  signalG(obj: SchemeValue, continuable?: boolean): SchemeGen;
  establishG(rs: SchemeRestart[], tag: object, run: () => SchemeGen): SchemeGen;
  withRestartsG(specs: (SchemeRestart | SchemeRestartSpec)[], run: () => SchemeGen): SchemeGen;
  unwoundG(e: unknown, s: number): SchemeGen<never>;
  driveSync<T>(it: Generator<unknown, T, unknown>): T;
  ThreadState: SchemeClass<SchemeThreadState>;
  /* the state that was running */
  switchTo(ts: SchemeThreadState): SchemeThreadState;
  readonly threadState: SchemeThreadState | null;
  bindDyn(p: SchemeParam, v: SchemeValue): () => void;
  withDynG(p: SchemeParam, v: SchemeValue, run: () => SchemeGen): SchemeGen;
  isPrimitive(v: SchemeValue): boolean;
  tick(): void;
}

/* ---------- Scheme: L, the editor's bridge (runtime.ts) ---------- */

/* A command designator: a symbol naming a command, or the procedure. */
type EdCommand = SchemeSym | SchemeProcedure;

interface LispApi {
  S: SchemeApi;
  Sym: SchemeApi['Sym'];
  Pair: SchemeApi['Pair'];
  Char: SchemeApi['Char'];
  SchemeError: SchemeApi['SchemeError'];
  NIL: SchemeNil;
  UNSPEC: SchemeUnspecified;
  intern(name: string): SchemeSym;
  listOf(arr: readonly SchemeValue[], tail?: SchemeValue): SchemeValue;
  /* a proper list's elements; #f and undefined as the empty list */
  arr(x: SchemeValue): SchemeValue[];
  callProc(f: SchemeValue, args: SchemeValue[]): SchemeValue;
  write(x: SchemeValue, display?: boolean): string;
  display(x: SchemeValue): string;
  /* write (READABLY) or display */
  pr(x: SchemeValue, readably?: boolean): string;
  /* raise a condition of KIND; 'error' and 'user-error' join DATA into the message */
  signal(kind: string, ...data: SchemeValue[]): never;
  /* C-g: QUIET suppresses the echo */
  quit(quiet?: boolean): never;
  isQuit(e: unknown): boolean;
  isQuietQuit(e: unknown): boolean;
  QUIET: SchemeSym;
  /* not #f and not undefined */
  truthy(x: SchemeValue): boolean;
  /* #f or undefined: an argument left out */
  absent(x: SchemeValue): x is false | undefined;
  /* global variables by name */
  get(name: string): SchemeValue;
  set<T extends SchemeValue>(name: string, v: T): T;
  magic(name: string, getter: () => SchemeValue, setter?: ((v: SchemeValue) => void) | null, doc?: string): void;
  defvar(name: string, value: SchemeValue, doc?: string): void;
  /* command designators: the procedure a symbol names, or the procedure. A parameter object comes back as
     it is: typed as the procedure its callers use it as. */
  toFn(x: SchemeValue): SchemeProcedure;
  fnOrNull(x: SchemeValue): SchemeProcedure | null;
  cmdSym(x: SchemeValue): SchemeSym;
  cmdName(x: SchemeValue): string;
  isCommand(x: SchemeValue): boolean;
  /* symbol properties of a command (#f when unset) */
  prop(x: SchemeValue, name: string): SchemeValue;
  put<T extends SchemeValue>(x: SchemeValue, name: string, v: T): T;
  call(name: string, args?: SchemeValue[]): SchemeValue;
  apply(f: SchemeValue, args?: SchemeValue[]): SchemeValue;
  /* the step budget and watchdog, reset before each command */
  resetOps(): void;
  /* hooks: a variable holding a procedure or a list of them */
  runHook(name: string, ...args: SchemeValue[]): void;
  hookFns(name: string): SchemeValue[];
  /* how a buffer-local hook's #t finds the default value (editor-core replaces defaultValue) */
  hooking: { defaultValue: (name: string) => SchemeValue };
  addHook(name: string, f: SchemeValue, append?: boolean): void;
  removeHook(name: string, f: SchemeValue): void;
  /* characters from Chars, code points or one-character strings */
  chr(c: SchemeValue): string | null;
  code(c: SchemeValue): number | null | undefined;
  mkchar(s: string | number): SchemeChar;
  /* completion candidates */
  commandNames(): string[];
  functionNames(): string[];
  variableNames(): string[];
  /* definers: D a procedure, CMD a command (SPEC: interactive codes, or an async function giving the arguments) */
  D<F extends Function>(name: string, args: string, doc: string, fn: F): F;
  CMD<F extends Function>(name: string, spec: string | ((...args: unknown[]) => unknown), args: string, doc: string, fn: F): F;
  alias(a: string, b: string): void;
  evalText(text: string): SchemeValue;
  read(src: string): SchemeValue;
  readAll(src: string, file?: string | null): SchemeValue[];
  ev(form: SchemeValue): SchemeValue;
  errorMessage(e: unknown): string;
  Escape: SchemeApi['Escape'];
  isList(x: SchemeValue): boolean;
  car(x: SchemeValue): SchemeValue;
  cdr(x: SchemeValue): SchemeValue;
  cons(a: SchemeValue, b: SchemeValue): SchemePair;
  list(...xs: SchemeValue[]): SchemePair | SchemeNil;
  equal(a: SchemeValue, b: SchemeValue): boolean;
}

/* ---------- Rope: the buffer text (text.ts) ----------
   A string-like rope of chunks with a newline index. Positions are UTF-16 code units; lines count from 1. */
interface Rope {
  /* the chunks, the newlines in each, and their prefix sums */
  ch: string[];
  nl: number[];
  off: Int32Array;
  nlo: Int32Array;
  len: number;
  /* the first chunk whose prefix sums are stale, or -1 */
  dirty: number;
  /* the whole text when known (built by toString, kept until the next edit) */
  flat: string | null;
  ci: number;
  reset(s: string): void;
  readonly length: number;
  fix(): void;
  /* the chunk holding P */
  find(p: number): number;
  toString(): string;
  valueOf(): string;
  charCodeAt(p: number): number;
  charAt(p: number): string;
  at(p: number): string | undefined;
  codePointAt(p: number): number | undefined;
  slice(a?: number, b?: number): string;
  substring(a: number, b?: number): string;
  indexOf(needle: string, from?: number): number;
  lastIndexOf(needle: string, from?: number): number;
  /* the number of newlines */
  newlines(): number;
  /* the line holding P, and the start of line N */
  lineOf(p: number): number;
  lineStart(n: number): number;
  /* replace DEL units at POS by INS; gives back the removed text */
  splice(pos: number, del: number, ins: string): string;
}
interface RopeConstructor {
  new(s?: string): Rope;
  prototype: Rope;
  from(s: string): Rope;
  /* how many times a rope was flattened (a test counter) */
  flattens: number;
}

/* ---------- editor: buffers and markers (editor-core.ts) ---------- */

/* A string or the rope: the text helpers (bol, eol, lineNo...) take either. */
type EdText = string | Rope;

/* One change in the edit log: version V, at POS, DEL removed, INS inserted, the length after, the origin. */
interface EdLogEntry {
  v: number;
  pos: number;
  del: string;
  ins: string;
  len: number;
  o: unknown;
}
/* What the undo list holds: the buffer's state at a version. */
interface EdSnap {
  ver: number;
  pt: number;
  mark: number | null;
  modified: boolean;
  [field: string]: unknown;
}
/* An edit for applyOps: N units (or the text itself) removed at POS, INS inserted. */
type EdEditOp = [pos: number, del: number | string, ins: string];
/* An edit applied: the removed text itself. */
type EdAppliedOp = [pos: number, del: string, ins: string];

interface EdMarker extends SchemeForeign {
  buffer: EdBuffer | null;
  pos: number | null;
  type: 'before' | 'after';
  dead?: boolean;
  /* on the buffer's jump list */
  jump?: boolean;
  set(buffer: EdBuffer | null, pos: number | null): EdMarker;
  release(): void;
}
/* A plain position in buffer.markers (temps): moved as a before marker. */
interface EdTempMarker {
  pos: number;
  dead?: boolean;
}

/* A fold (org.ts, markdown.ts): lines S..E hidden, N lines. */
interface EdFold {
  s: number;
  e: number;
  n?: number;
}

/* A shared buffer's sync state (sync.ts). */
interface EdBufferSync {
  sverText: string;
  seq: number;
  /* the seqs edwind acknowledged (null: an ack of a batch with no seq) */
  acked: Set<number | null>;
  gCount: number;
  undoStack: unknown[];
  redoStack: unknown[];
  create?: boolean;
  /* the rid of the open on its way */
  opening?: string | null;
  waiters?: unknown[];
  anchorsServer?: unknown;
  lastSel?: unknown;
  selTimer?: number | null;
  [field: string]: unknown;
}
/* A shared buffer's metadata from edwind (sync.ts). */
interface EdBufferMeta {
  file?: string | null;
  mode?: string;
  modified?: boolean;
  /* true, or why the buffer is read-only */
  readOnly?: string | boolean;
  saved?: number;
  /* 'conflict', 'deleted' */
  diskChanged?: string | null;
  eol?: string;
  anchors?: { id: string; pos: number; label?: string }[];
  locals?: Record<string, unknown>;
  [field: string]: unknown;
}
/* A batch of ops sent to edwind and not yet acknowledged (sync.ts). */
interface EdBufferBatch {
  seq?: number;
  base?: number;
  ops: EdAppliedOp[];
  undo: { g: unknown; of?: unknown; ofCid?: unknown; redo?: boolean } & Record<string, unknown>;
}
/* Another writer's cursor in a shared buffer (sync.ts). */
interface EdPresence {
  /* the writer (writerKey) and its attribution */
  key: string;
  by: unknown;
  color: string;
  label: string;
  ranges: [from: number, to: number][];
  /* when it last moved or wrote: an agent's cursor fades */
  at: number;
  agent?: boolean;
}

interface EdBuffer extends SchemeForeign {
  /* a number; a shared buffer has edwind's string id (sync.ts) */
  id: number | string;
  name: string;
  rope: Rope;
  /* the edit log: VER counts changes; entries before PIN may be dropped */
  ver: number;
  log: EdLogEntry[];
  pin: number;
  markers: Set<EdMarker | EdTempMarker>;
  temps: Set<EdMarker | EdTempMarker>;
  /* point, the mark and its activity */
  pt: number;
  mark: number | null;
  markActive: boolean;
  /* Evil's marks (positions by name) and the jump list */
  marks: Record<string, number | undefined>;
  /* the jump list; the setter also takes positions (it makes markers of them) */
  jumps: EdMarker[];
  jumpIdx: number;
  /* buffer-local variables */
  locals: Map<string, SchemeValue> | null;
  mode: string;
  file: string | null;
  modified: boolean;
  readOnly: boolean;
  undo: EdSnap[];
  redo: EdSnap[];
  pendingUndo: EdSnap | null;
  typeRun: number;
  scroll: number;
  /* Evil */
  visual: 'char' | 'line' | 'block' | null;
  evilState: EdEvilState | undefined;
  /* the whole text (reading builds a string; assigning edits the differing middle) */
  text: string;
  marker(pos: number | null, type?: 'before' | 'after'): EdMarker;
  /* internals of editor-core: the mark's marker, the marks table, the lexer cache */
  _mark?: EdMarker;
  _marks?: Map<string, EdMarker>;
  _jumps?: EdMarker[];
  _marksView?: Record<string, number | undefined>;
  _lv?: number;
  _lc?: Uint8Array | number[] | null;
  _ld?: unknown;
  _lcb?: Uint8Array | number[] | null;
  _ldb?: unknown;
  _llen?: number;
  _lexBusy?: boolean;
  /* a frame's minibuffer */
  minibuf?: boolean;
  /* the window start it was last shown at (setWindowBuffer) */
  lastStart?: number;
  /* evil-core.ts */
  lastVisual?: { type: 'char' | 'line' | 'block'; mark: number | null; pt: number };
  _lastVer?: number;
  /* sync.ts: a buffer edwind shares */
  shared?: boolean;
  sver?: number;
  hist?: unknown[];
  presence?: EdPresence[];
  inflight?: EdBufferBatch | null;
  queue?: EdBufferBatch[];
  sync?: EdBufferSync;
  meta?: EdBufferMeta;
  saving?: boolean;
  saveError?: string | null;
  _presTick?: number;
  /* org.ts and markdown.ts: folds and their caches */
  folds?: EdFold[] | null;
  _foldVer?: number;
  _foldPre?: number[] | null;
  agenda?: unknown;
  capture?: { tpl: unknown; win: EdWinConfig } | null;
  _cycle?: unknown;
  _gcycle?: unknown;
  _olx?: unknown;
  _fences?: unknown;
  _mlx?: unknown;
  _mdf?: unknown;
  _mdfm?: unknown;
  /* pool.ts: the word index and running jobs */
  _wix?: { src: string; ver: number; ix: EdWordIndex; busy: boolean } | null;
  _jobs?: Map<number | symbol, number>;
  /* org.ts: the node an org-roam buffer shows */
  roamNode?: unknown;
  /* ai.ts */
  _avail?: unknown;
  gptel?: unknown;
}
interface EdBufferConstructor {
  new(name: string): EdBuffer;
  prototype: EdBuffer;
  count?: number;
}
interface EdMarkerConstructor {
  new(buffer: EdBuffer | null, pos: number | null, type?: 'before' | 'after'): EdMarker;
  prototype: EdMarker;
}

/* ---------- editor: windows and frames ---------- */

/* A leaf of the window tree: a buffer shown in a window. el, view and ml are a page frame's elements. */
interface EdWindow extends SchemeForeign {
  id: number;
  buffer: EdBuffer;
  /* point while not selected, the first shown position, the last line drawn, the rows it holds */
  pt: number;
  start: number;
  lastLine: number;
  rows: number;
  /* the buffers it showed, for previous-buffer */
  prev: EdBuffer[];
  /* made by popToBuffer */
  popup: boolean;
  dedicated: boolean;
  parent: EdSplit | null;
  el: HTMLElement | null;
  view: HTMLElement | null;
  ml: HTMLElement | null;
  /* editor-core's caches: metrics, gutter width, view key, selection, line cache, modeline */
  _m?: EdMetrics;
  _gw?: number;
  _vc?: unknown;
  _selected?: boolean;
  _lcache?: unknown;
  _mq?: unknown;
  /* display.ts: the model frame's line cache and horizontal scroll */
  _mcache?: Map<string, unknown> | null;
  _hs?: number;
}
interface EdSplit {
  dir: 'h' | 'v';
  children: (EdWindow | EdSplit)[];
  parent: EdSplit | null;
  el: HTMLElement | null;
}
type EdWindowNode = EdWindow | EdSplit;
interface EdWindowConstructor {
  new(buffer: EdBuffer): EdWindow;
  prototype: EdWindow;
  count?: number;
}
interface EdSplitConstructor {
  new(dir: 'h' | 'v', children: EdWindowNode[]): EdSplit;
  prototype: EdSplit;
}
/* A window's measured font metrics (page frames). */
interface EdMetrics {
  key: string;
  lh: number;
  ch0: number;
  [field: string]: unknown;
}

/* The state each frame has, and the headless E.implicit: a window tree, a minibuffer and the echo area. */
interface EdFrameState {
  wroot: EdWindowNode | null;
  sel: EdWindow | null;
  winHistory: EdWinConfig[];
  winFuture: EdWinConfig[];
  minibuf: EdBuffer;
  mini: EdMini | null;
  miniFlash: string;
  echo: string;
  prompt: string | null;
  focused: boolean;
  restoreScroll: boolean;
  recenter: unknown;
}
/* A frame: a page frame (root and parts are elements) or a model frame (backend, display.ts). */
interface EdFrame extends EdFrameState, SchemeForeign {
  id: number;
  root: HTMLElement | null;
  parts: Record<string, HTMLElement>;
  kind: 'console' | 'card';
  fontSize: number | null;
  /* made by the older makeFrame(root, parts) */
  legacy: boolean;
  /* the page listeners to remove on deleteFrame: [target, type, fn, options] */
  listeners: [EventTargetLike, string, (ev: any) => void, unknown?][]; // any: DOM listeners take their own event types
  /* a model frame */
  backend?: EdDisplayBackend;
  theme?: 'light' | 'dark' | null;
  lastModel?: EdDisplayModel;
  /* the render key, the presence fade timer, the model layout and mouse state (display.ts) */
  _rkey?: string | null;
  _fadeTimer?: number;
  _layout?: unknown;
  _mouse?: { from: number | null; win: EdWindow | null };
  /* the font size text-scale steps from (editor-prims.ts), the point last reported (sync.ts) */
  baseFontSize?: number;
  _lastPoint?: string;
  el(name: string): HTMLElement | null;
  readonly buffer: EdBuffer | null;
  focus(): void;
  blur(): void;
  showBuffer<T extends EdBuffer | string>(b: T): T;
  point(): number;
  setPoint(p: number): number;
  lineTop(pos: number): number | null;
  posFromPoint(x: number, y: number): number | null;
  unacked(): boolean;
  setFontSize(px: number): void;
  destroy(): void;
}
/* Anything addEventListener works on. */
interface EventTargetLike {
  removeEventListener(type: string, fn: (ev: any) => void, opts?: any): void; // any: as lib.dom's EventTarget
}
interface EdFrameConstructor {
  new(root: HTMLElement | null, parts: Record<string, HTMLElement>): EdFrame;
  prototype: EdFrame;
  count: number | undefined;
}
interface EdFrameStateConstructor {
  new(): EdFrameState;
  prototype: EdFrameState;
}
/* Ed.makeFrame's options: a built page frame (kind, buffer, fontSize), a model frame (backend, theme) or the
   older parts table. */
interface EdMakeFrameOpts {
  buffer?: EdBuffer | string;
  kind?: 'console' | 'card';
  fontSize?: number;
  backend?: EdDisplayBackend;
  theme?: 'light' | 'dark' | null;
  [part: string]: unknown;
}
/* Ed.onFrameEvent's event. */
interface EdFrameEvent {
  type: 'edited' | 'point' | 'focus' | 'blur' | 'status' | string;
  frame: EdFrame | null;
  buffer: EdBuffer | null;
}

/* ---------- editor: keymaps and keys ---------- */

/* A key binding: a command (symbol or procedure), a keymap (a prefix), PREFIX, or a Scheme value. */
type EdBinding = SchemeValue | symbol;
interface EdKeymap extends SchemeForeign {
  name: string;
  map: Map<string, EdBinding>;
  parent: EdKeymap | null;
}
interface EdKeymapConstructor {
  new(name?: string | null): EdKeymap;
  prototype: EdKeymap;
}
/* What Ed.keyName reads from a keydown: the page's KeyboardEvent, or gui.ts's copy of one. */
interface EdKeyEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  getModifierState?(key: string): boolean;
}
/* An entry of the key queue: K, typed by the user (REAL) or replayed. */
interface EdQueuedKey {
  k: string;
  real: boolean;
  noRecord?: boolean;
}
/* The lexer's character classes (Ed.C). */
interface EdLexClasses {
  PLAIN: number; CMT: number; STR: number; PAR: number; NUM: number; KW: number; FN: number; CONST: number; QUO: number; DOC: number;
}
/* Ed.lexOf: the class of each character, and the depth data. */
interface EdLexResult {
  cls: Uint8Array | number[];
  d?: unknown;
  [field: string]: unknown;
}

/* ---------- editor: modes and variables ---------- */

interface EdMinorMode {
  name: string;
  variable: string;
  global: boolean;
  lighter: string;
  [field: string]: unknown;
}
/* A variable made buffer-local: its default, and whether setting it makes it local (auto). */
interface EdLocalized {
  def: SchemeValue;
  auto: boolean;
}

/* ---------- editor: the minibuffer ---------- */

/* A completion table: the candidates for the input. */
type EdCompleter = (input: string) => string[];
interface EdMiniOpts {
  /* the history list, or the kind whose history to use */
  history?: string[];
  kind?: string;
  /* no candidate selected at first */
  noIndex?: boolean;
  onChange?: (text: string) => void;
  onSelect?: (cand: string | null, text: string) => void;
  onExit?: () => void;
  /* the input must be a candidate */
  require?: boolean;
  def?: string;
  keepOrder?: boolean;
  listOrder?: boolean;
  annotate?: ((cand: string) => string) | null;
  label?: (cand: string) => string;
  [opt: string]: unknown;
}
/* E.mini: the minibuffer being read. */
interface EdMini {
  prompt: string;
  completer: EdCompleter | null;
  opts: EdMiniOpts;
  histIdx: number;
  history: string[];
  done: { value: string; quit?: undefined } | { quit: true; value?: undefined } | null;
  index: number;
  cache: string[] | null;
  cacheKey: string | null;
  cacheAll?: string[] | null;
  scroll: number;
  matched?: string[] | null;
  matchedKey?: string | null;
  asyncKey?: string | null;
}
/* E.isearch: an incremental search in progress. */
interface EdIsearch {
  dir: number;
  str: string;
  origin: number;
  stack: unknown[];
  failing: boolean;
  wrapped: boolean;
  match: [number, number] | null;
  [field: string]: unknown;
}

/* ---------- editor: redisplay ---------- */

/* Ed.winConfig: the window tree as it was, for restoreWinConfig */
type EdWinConfig =
  | { dir?: undefined; buffer: EdBuffer; pt: number; start: number; sel: boolean; popup: boolean }
  | { dir: 'h' | 'v'; children: EdWinConfig[] };
/* A rendered line (renderBuffer): offset O, length N, classes CL, its HTML or its runs and text. */
interface EdRenderedLine {
  o: number;
  n: number | null;
  cl: boolean;
  html: string | undefined;
  pulse: boolean;
  runs?: EdRun[];
  text?: string;
}
type EdRenderedLines = EdRenderedLine[] & { seg?: string; cache?: Map<string, unknown> | null };
/* A run of a rendered line: S..E with classes CLS; K marks the cursor, end-of-line and other pieces, T their text. */
interface EdRun {
  s: number;
  e: number;
  cls: string;
  k?: string;
  t?: string;
}
interface EdRenderOpts {
  runs?: boolean;
  html?: boolean;
  lines?: boolean;
  pt?: number;
  from?: number;
  count?: number;
  [opt: string]: unknown;
}
/* What hooks.look gives a window: the cursor, highlights and the echo/modeline parts the modes add. */
interface EdLook {
  cursor?: string;
  onChar?: boolean;
  hl?: unknown;
  current?: unknown;
  tag?: string;
  state?: string;
  extra?: string;
  showcmd?: string;
  stateEcho?: string;
  prefixHelp?: unknown;
  [field: string]: unknown;
}
/* Ed.windowState. */
interface EdWindowState {
  b: EdBuffer;
  selected: boolean;
  look: EdLook;
  numbers: 'relative' | 'absolute' | null;
  centered: boolean;
  nowrap: boolean;
  active: boolean;
  pt: number;
  opts: Record<string, unknown>;
}
interface EdModelineFields {
  tag: string;
  state: string;
  mark: string;
  name: string;
  pos: string;
  mode: string;
  extra: string;
  sync: string;
  cmd: string;
  [field: string]: unknown;
}
interface EdMiniView {
  count: string | null;
  prompt: string;
  flash: string;
  items: { label: string; ann: string; sel: boolean; marks: [number, number][] }[];
  pad: number;
}

/* ---------- editor: E, the editor state ---------- */

type EdEvilState = 'normal' | 'insert' | 'visual' | 'replace' | 'operator' | 'motion' | 'emacs';
/* An Evil register's contents. */
interface EdRegister {
  text: string;
  type: 'char' | 'line' | 'block' | string;
  keys?: string[];
}

/* E: one object of editor state. The fields from root to recenter read and write the frame being worked on
   (EdFrameState); the ones below the core's are set by the files named. */
interface EdState {
  headless: boolean;
  host: EdHost;
  frames: EdFrame[];
  frame: EdFrame | null;
  /* the state when there is no frame */
  implicit: EdFrameState;
  buffers: EdBuffer[];
  /* the selected window's buffer */
  win: EdBuffer | null;
  /* the buffer commands act on (the minibuffer while one is read) */
  current: EdBuffer;
  history: string[];
  pendingKeys: string;
  /* the prefix argument: a number, '-', (4) as [4], or null */
  prefixArg: SchemeValue;
  keepPrefix: boolean;
  uArg: boolean;
  uDigits: string | null;
  /* recursive minibuffer depth */
  depth: number;
  lastCommand: SchemeValue;
  thisCommand: SchemeValue;
  thisKeys: string;
  cmdSeq: number;
  killRing: string[];
  killIdx: number;
  isearch: EdIsearch | null;
  lastSearch: string;
  goalCol: number | null;
  inhibitRO: boolean;
  pasteText: string;
  /* run-at-time's timers: the timer's id to its timeout or interval */
  timers: Map<unknown, number>;
  suppressUndo: boolean;
  noUndo: boolean;
  /* the frame being worked on (accessors) */
  root: EdWindowNode | null;
  sel: EdWindow | null;
  winHistory: EdWinConfig[];
  winFuture: EdWinConfig[];
  mini: EdMini | null;
  minibuf: EdBuffer;
  miniFlash: string;
  echo: string;
  prompt: string | null;
  focused: boolean;
  restoreScroll: boolean;
  recenter: unknown;
  /* set by editor-core as it runs */
  /* who makes the edit being applied: local, remote, server, agent, disk */
  editOrigin: string;
  avy?: { win: EdWindow; labels: unknown } | null;
  /* the line pulse-momentary-highlight lights: buffer B, line start LS, since T */
  pulse?: { b: EdBuffer; ls: number; t: number } | null;
  metricsGen: number;
  sizeGen?: number;
  inFrame?: boolean;
  idle?: boolean;
  lastKeyReal?: boolean;
  keepMark?: boolean;
  booted?: boolean;
  inhibitModHooks?: boolean;
  /* evil-core.ts */
  evil?: boolean;
  registers: Record<string, EdRegister | undefined>;
  search: { pattern: string | null; dir: number } & Record<string, unknown>;
  hlOff?: boolean;
  preview?: unknown;
  searchHistory?: string[];
  exHistory?: string[];
  dotLast?: unknown;
  dotCand?: { keys: string[]; startVer: number; buf: EdBuffer; startState: EdEvilState | null; cmd: SchemeValue; vis: unknown } | null;
  macro?: { reg: string; keys: string[] } | null;
  lastMacro?: string | null;
  ins?: { count: number; prefix: string[]; keys: string[]; replaying: boolean; block: unknown; replaced: (string | null)[] } | null;
  countStr?: string;
  register?: string | null;
  opShow?: string;
  ex?: { lines: [number, number] | null; arg: string | null; bang: boolean; name: string; line: string } & Record<string, unknown> | null;
  lastSub?: unknown;
  oneShot?: unknown;
  aux: Map<string, EdKeymap>;
  blockCols?: { beg: number; end: number; c1: number; c2: number; l1: number; l2: number } | null;
  /* the class an operator throws to stop (evil-core.ts) */
  OpDone?: new () => object;
  jumpFrom?: { b: EdBuffer; pt: number } | null;
  lastEx?: string | null;
  goalX?: number | null;
  /* complete.ts: the completion popup */
  corfu?: { start: number; prefix: string; cands: EdCompletion[]; index: number; scroll: number; auto: boolean; wiki?: unknown } | null;
  /* editor-prims.ts: the board leader key */
  leaderKey?: string;
  /* stack.ts and others */
  snipeHl?: { b: EdBuffer; str: string; whole?: boolean; fwd?: boolean; pt: number } | null;
  printed?: unknown;
  nu?: unknown;
  bookmarks?: Record<string, { buffer: string; file: string | null; pt: number }>;
  [field: string]: unknown;
}

/* ---------- editor: hooks (Ed.hooks) ----------
   The seams other files plug into; editor-core calls each when set. Several files chain the previous one. */
interface EdHooks {
  /* the major mode for a buffer name (org.ts, markdown.ts) */
  modeFor?: ((name: string) => string | null | undefined) | null;
  /* after edits were applied to B (sync.ts sends them) */
  applied?: ((b: EdBuffer, ops: EdAppliedOp[], origin: unknown) => void) | null;
  /* a buffer's text changed (org.ts, markdown.ts drop caches) */
  edited?: ((b: EdBuffer) => void) | null;
  /* before a key is dispatched: true when the hook consumed it */
  beforeKey?: ((k: string) => Promise<boolean | void> | boolean | void) | null;
  recordKey?: ((it: EdQueuedKey) => void) | null;
  undefinedKey?: ((seq: string) => void) | null;
  preCommand?: ((def: SchemeValue, b: EdBuffer) => void) | null;
  postCommand?: ((def: SchemeValue, b: EdBuffer, failed: boolean) => void) | null;
  /* the keymaps of B's Evil state, ahead of the mode's */
  stateMaps?: ((b: EdBuffer) => EdKeymap[]) | null;
  canSelfInsert?: ((b: EdBuffer) => boolean) | null;
  clampPoint?: ((b: EdBuffer) => void) | null;
  /* inside an insert session: undo groups it as one step */
  inSession?: ((b: EdBuffer) => boolean) | null;
  sexpEnd?: ((b: EdBuffer) => number) | null;
  nativePaste?: (() => boolean) | null;
  /* the oldest log version a cache still needs */
  logFloor?: ((b: EdBuffer) => number) | null;
  /* the look of window W on B */
  look?: ((b: EdBuffer, w?: EdWindow) => EdLook) | null;
  /* the lexer for a segment: classes and names for markdown/org text */
  lexSeg?: ((b: EdBuffer, from: number, to: number, seg: unknown) => unknown) | null;
  /* folding (org.ts) */
  ellipsis?: ((b?: EdBuffer) => string) | null;
  foldEnd?: ((b: EdBuffer, e: number) => number) | null;
  lineTarget?: ((b: EdBuffer, line: number, c: unknown) => unknown) | null;
  /* the mouse (evil-ex.ts, markdown.ts) */
  mouseDown?: ((b: EdBuffer, pos: number, ev?: { button?: number; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; detail?: number }) => void) | null;
  mouseDrag?: ((b: EdBuffer, from: number, p: number) => void) | null;
  miniExit?: ((m: EdMini) => void) | null;
  /* the files offered by find-file, and the file visits (stack.ts) */
  recentFiles?: (() => string[]) | null;
  visited?: ((b: EdBuffer, name: string, fresh: boolean) => void) | null;
  wrote?: ((b: EdBuffer, name: string) => void) | null;
  /* redisplay: overlays, presence, a model frame's draw (complete.ts, stack.ts, sync.ts, display.ts) */
  renderOverlay?: ((f?: EdFrame) => void) | null;
  renderPresence?: ((f: EdFrame) => void) | null;
  renderModel?: ((f: EdFrame) => void) | null;
  /* the page's frame wiring (editor-prims.ts) */
  wireFrame?: ((f: EdFrame) => void) | null;
  wireWindow?: ((w: EdWindow) => void) | null;
  /* the page: open a page by name, give the keyboard back */
  openPage?: ((name: string) => unknown) | null;
  leaveFrame?: ((f: EdFrame) => void) | null;
  /* boot: before the shipped Scheme's keymaps are filled, and between it and the user's init */
  setup?: (() => void) | null;
  beforeUserInit?: (() => void) | null;
  /* edwind (sync.ts) */
  modeStatus?: ((b: EdBuffer, frame?: EdFrameState) => string) | null;
  statusKey?: (() => string) | null;
  serverCommand?: ((name: string, f?: SchemeProcedure) => unknown) | null;
  evalServer?: ((text: string, opts?: { insert?: 'inline' | 'line' | null; buf?: EdBuffer; done?: string }) => boolean) | null;
  visit?: ((name: string) => EdBuffer | null | Promise<EdBuffer | null | false>) | null;
  saveShared?: ((b: EdBuffer) => boolean) | null;
  revertShared?: ((b: EdBuffer) => unknown) | null;
  killShared?: ((b: EdBuffer) => unknown) | null;
  undoShared?: ((b: EdBuffer) => unknown) | null;
  redoShared?: ((b: EdBuffer) => unknown) | null;
  /* the host: kill-emacs and suspend-frame (native main.ts) */
  killEmacs?: ((code: number) => void) | null;
  suspendFrame?: (() => void) | null;
}

/* ---------- editor: Ed, the editor's API (editor-core.ts) ----------
   editor-core.ts makes the object; the members marked "set by" are added by the file named, when it loads. */
interface EdApi {
  E: EdState;
  hooks: EdHooks;
  host: EdHost;
  /* frames */
  Frame: EdFrameConstructor;
  FrameState: EdFrameStateConstructor;
  makeFrame(root: HTMLElement | null, opts?: EdMakeFrameOpts): EdFrame;
  selectFrame(f: EdFrame): EdFrame;
  deleteFrame(f: EdFrame): boolean;
  onFrameEvent(fn: (ev: EdFrameEvent) => void): () => void;
  frameEvent(type: string, frame: EdFrame | null, buffer?: EdBuffer | null): void;
  frameScale(f: EdFrame): number;
  withFrame<T>(f: EdFrameState | null, fn: () => T): T;
  allWindows(): EdWindow[];
  allMinibufs(): EdBuffer[];
  renderFrame(f: EdFrame): void;
  rectAt(w: EdWindow, p: number, len: number): { left: number; top: number; width: number; height: number } | null;
  scheduleRender(): void;
  FRAME_CSS: string;
  /* text and edits */
  Marker: EdMarkerConstructor;
  shiftMarkers(b: EdBuffer, pos: number, del: number, ins: number, entry?: EdLogEntry): void;
  editText(b: EdBuffer, pos: number, n: number, ins: string): string;
  applyOps(b: EdBuffer, ops: EdEditOp[], origin?: string, whole?: string): EdAppliedOp[];
  withOrigin<T>(origin: unknown, f: () => T): T;
  runHookSafely(name: string, args?: SchemeValue[]): void;
  removeHookEverywhere(name: string, f: SchemeValue): void;
  /* buffer-local variables and modes */
  localized: Map<string, EdLocalized>;
  localize(name: string): EdLocalized;
  makeLocal(b: EdBuffer, name: string): void;
  localValue(b: EdBuffer, name: string): SchemeValue;
  defaultValue(name: string): SchemeValue;
  setDefault<T extends SchemeValue>(name: string, v: T): T;
  minorModes: Map<string, EdMinorMode>;
  minorOn(b: EdBuffer, m: EdMinorMode): boolean;
  modeParents: Map<string, string>;
  modeChain(mode: string): string[];
  lighters(b: EdBuffer): string;
  /* the lexer's source, for the workers */
  LEX_SOURCE: string;
  /* the file store: the host's files, or its storage */
  Store: {
    get(n: string): string | null;
    set(n: string, v: string): boolean;
    del(n: string): void;
    list(): string[];
  };
  /* buffers */
  Buffer: EdBufferConstructor;
  Keymap: EdKeymapConstructor;
  PREFIX: symbol;
  C: EdLexClasses;
  SENTINEL: string;
  getBuffer(name: string): EdBuffer | null;
  getBufferCreate(name: string): EdBuffer;
  toBuffer(x: SchemeValue): EdBuffer;
  setWindowBuffer(b: EdBuffer, w?: EdWindow | null): void;
  otherBuffer(): EdBuffer;
  checkRO(b: EdBuffer): void;
  insertText(b: EdBuffer, s: string): void;
  deleteText(b: EdBuffer, s: number, e: number): string;
  replaceText(b: EdBuffer, s: number, e: number, str: string): void;
  spanOf(b: EdBuffer, old: number): { pre: number; suf: number } | null;
  changedSince(b: EdBuffer, ver: number): boolean;
  installLex(b: EdBuffer, ver: number, cls: Uint8Array | number[], d: unknown): void;
  metrics(w: EdWindow): EdMetrics;
  lastMatch(str: string, re: RegExp, from: number, len: number, win?: number): number;
  /* text helpers: T is a string or a rope */
  bol(t: EdText, p: number): number;
  eol(t: EdText, p: number): number;
  lineNo(t: EdText, p: number): number;
  column(t: EdText, p: number): number;
  posAtColumn(t: EdText, ls: number, col: number): number;
  lastLineStart(t: EdText): number;
  lineStartOf(t: EdText, n: number): number;
  lex(t: string, info?: { dirty: boolean }): Uint8Array;
  lexOf(b: EdBuffer, soft?: boolean): Uint8Array | number[] | null;
  markDocstrings(t: string, cls: Uint8Array, from?: number, to?: number, base?: number): Uint8Array;
  forwardSexp(t: EdText, cls: Uint8Array | number[], p: number): number | null;
  backwardSexp(t: EdText, cls: Uint8Array | number[], p: number): number | null;
  upList(t: EdText, cls: Uint8Array | number[], p: number): number | null;
  matchParen(t: EdText, cls: Uint8Array | number[], k: number): number | null;
  indentLine(b: EdBuffer): void;
  /* null inside a string: leave the line alone */
  lispIndentFor(t: EdText, cls: ArrayLike<number>, ls: number): number | null;
  isLisp(b: EdBuffer): boolean;
  modeFor(name: string): string;
  MODE_NAMES: Record<string, string>;
  /* keys */
  normKey(k: string): string;
  kbd(s: string): string;
  defineKey(km: EdKeymap, keys: string, def: EdBinding): void;
  lookupIn(km: EdKeymap, parts: string[]): EdBinding | undefined;
  lookupKey(seq: string, b?: EdBuffer): EdBinding | undefined;
  lookupWith(maps: EdKeymap[], seq: string): EdBinding | undefined;
  activeMaps(b: EdBuffer): EdKeymap[];
  whereIs(cmd: SchemeValue, maps?: EdKeymap[]): string[];
  keyName(e: EdKeyEvent): string | null;
  keyChar(k: string): string | null;
  selfInsertable(k: string): boolean;
  message(s: string): void;
  ding(): void;
  reportError(e: unknown): void;
  errorText(e: unknown): string;
  quietQuit(): never;
  QUIET: SchemeSym;
  /* set by pool.ts too (C-g cancels the awaited jobs) */
  feedKey(k: string): void;
  unreadKeys(keys: string[], real?: boolean): void;
  flushReplay(): void;
  nextKey(opts?: { sentinel?: boolean }): Promise<string>;
  /* the minibuffer */
  readMini(prompt: string, initial?: string, completer?: EdCompleter | null, opts?: EdMiniOpts): Promise<string>;
  exitMini(inputOnly?: boolean): void;
  abortMini(): void;
  completeMini(): void;
  historyMove(d: number): void;
  miniCandidates(sync?: boolean): string[];
  miniMove(d: number, cycle?: boolean): void;
  miniInsert(): void;
  markUsed(m: EdMini, v: string): void;
  termRegex(term: string): RegExp;
  histories: Map<string, string[]>;
  historyFor(kind?: string): string[];
  prescient: { tick: number; kinds: Record<string, Record<string, [number, number]>>; save: (() => void) | null; limit: number };
  annotateCommand(name: string): string;
  annotateFunction(name: string): string;
  annotateVariable(name: string): string;
  annotateBuffer(name: string): string;
  annotateFile(name: string): string;
  readKeySeq(prompt: string): Promise<string>;
  readChar(prompt: string): Promise<SchemeChar>;
  commandNames(): string[];
  functionNames(): string[];
  variableNames(): string[];
  bufferNames(): string[];
  isCommand(x: SchemeValue): boolean;
  /* commands */
  prefixNumeric(p: SchemeValue): number;
  specArgs(spec: string): Promise<SchemeValue[]>;
  /* handlers for <code> items of an interactive spec */
  specCodes: Record<string, () => Promise<SchemeValue[]>>;
  callInteractively(cmd: SchemeValue): Promise<SchemeValue>;
  undoStep(b: EdBuffer): unknown;
  redoStep(b: EdBuffer): unknown;
  snap(b: EdBuffer): EdSnap;
  runCommand(def: SchemeValue, keys?: string): Promise<void>;
  dispatch(k: string): Promise<void>;
  commandLoop(): Promise<void>;
  executeKeys(keys: string | string[]): Promise<void>;
  isearch(dir: number): Promise<void>;
  /* redisplay */
  render(): void;
  /* the lines, or their HTML joined when neither lines nor runs are wanted */
  renderBuffer(b: EdBuffer, o: EdRenderOpts & { runs: true }): EdRenderedLines;
  renderBuffer(b: EdBuffer, o: EdRenderOpts): EdRenderedLines | string;
  posFromPoint(x: number, y: number, w: EdWindow): number | null;
  windowAt(x: number, y: number): EdWindow | null;
  lineHeight(): number;
  whenIdle(): Promise<void>;
  frameRender(): void;
  windowState(w: EdWindow): EdWindowState;
  scrollStart(w: EdWindow, b: EdBuffer, ptLine: number, rows: number, selected: boolean): number;
  modelineFields(w: EdWindow, st: EdWindowState, ptLine: number): EdModelineFields;
  miniView(): EdMiniView;
  echoView(look: EdLook): { text: string; which: boolean };
  matchSpans(s: string, terms: RegExp[]): [number, number][];
  percent(w: EdWindow): string;
  foldsOf(b: EdBuffer): EdFold[] | null;
  onScroll(w: EdWindow): void;
  scrollWindow(w: EdWindow, lines: number): void;
  /* lines of a buffer, and shown lines (folds hide some) */
  lineIndex(b: EdBuffer): number[];
  lineNoB(b: EdBuffer, p: number): number;
  lineStartB(b: EdBuffer, n: number): number;
  lineCountB(b: EdBuffer): number;
  foldAt(folds: EdFold[], ls: number): EdFold | null;
  vLineNo(b: EdBuffer, p: number): number;
  vLineStart(b: EdBuffer, n: number): number;
  vLineCount(b: EdBuffer): number;
  windowRows(w: EdWindow): number;
  ensureWindowDom(): void;
  /* windows */
  Window: EdWindowConstructor;
  Split: EdSplitConstructor;
  windowList(): EdWindow[];
  selectWindow(w: EdWindow, keepPoint?: boolean): void;
  splitWindow(w: EdWindow | null, dir: string, size?: number): EdWindow;
  deleteWindow(w: EdWindow): void;
  deleteOtherWindows(w: EdWindow): void;
  winConfig(): EdWinConfig;
  restoreWinConfig(cfg: EdWinConfig): void;
  saveWinConfig(): void;
  windowFor(b: EdBuffer): EdWindow | null;
  popToBuffer(b: EdBuffer, select?: boolean): EdWindow;
  leaves(node: EdWindowNode | null, out?: EdWindow[]): EdWindow[];
  readonly queueLength: number;
  runCallback<T>(fn: () => T): T | undefined;

  /* set by editor-prims.ts */
  boot(opts?: { host?: EdHost; frame?: EdFrame; served?: boolean; deferUserInit?: boolean }): void;
  loadUserInit(): string | null;
  setLeaderKey(name: string): string;
  fileLabel(name: string): string;
  visit(name: string): EdBuffer | null | Promise<EdBuffer | null | false>;
  symProp(sym: SchemeValue, name: string): SchemeValue;
  adviceOf(name: string): { how: string; fn: SchemeValue; name: string | null | undefined }[];
  defineMinorMode(...args: unknown[]): unknown;
  switchMajorMode(b: EdBuffer, mode: string): void;
  /* set by stack.ts: read the persistent tables (recentf, savehist...) from storage again */
  reloadPersistent(): void;
  /* set by sync.ts */
  sync: EdSyncApi;
  bootServed(opts?: { sources?: Record<string, string>; transport?: () => EdTransport; device?: string; cid?: string; pending?: unknown }): Promise<EdSyncApi>;
  /* set by display.ts */
  display: EdDisplayApi;
}

/* ---------- editor: edwind's client (sync.ts) ---------- */

/* A WebSocket-shaped transport (the page's WebSocket, native main.ts's socket). */
interface EdTransport {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  readyState: number;
  send?(s: string): void;
  close?(): void;
}
/* A reply from edwind: a value, or an error with its condition and report. */
interface EdServerReply {
  value?: unknown;
  error?: { condition: string; report: string; [field: string]: unknown };
  [field: string]: unknown;
}
interface EdSyncApi {
  state: 'offline' | 'connecting' | 'online' | string;
  started: boolean;
  ready: boolean;
  cid: string | null;
  device: string | null;
  buffers: Map<string, EdBuffer>;
  calls: Map<unknown, unknown>;
  spinning: number;
  start(opts?: { transport?: () => EdTransport; device?: string; cid?: string }): void;
  open(id: string, opts?: { create?: boolean }): Promise<EdBuffer | null>;
  close(id: string): unknown;
  shutdown(): void;
  call(opts: { cmd?: string; form?: string; args?: unknown[]; buf?: string; ctx?: unknown }): Promise<EdServerReply>;
  save(b: EdBuffer | string): Promise<EdServerReply>;
  revert(b: EdBuffer | string): Promise<EdServerReply>;
  anchorAdd(buf: EdBuffer | string, pos: number, label: string, id?: string): Promise<unknown>;
  anchorRemove(buf: EdBuffer | string, id: string): Promise<unknown>;
  refreshCandidates(...args: unknown[]): unknown;
  exportPending(): unknown;
  fromJSON(j: unknown): SchemeValue;
  writerColor(key: string): string;
  writerLabel(by: unknown): string;
  [field: string]: unknown;
}

/* ---------- host: EdHost (host-browser.ts, host-node.cts, native/js/host-native.ts) ----------
   What the core needs from where it runs. The browser host is a page, the Node host is edwind's and the
   tests' (headless), the native host is desktop Edwin's; members only some hosts have are optional. */

interface EdHostStorage {
  get(k: string): string | null;
  set(k: string, v: unknown): boolean;
  remove(k: string): void;
  keys(): string[];
  /* native: write the storage file now, open it (init) */
  flush?(): void;
  open?(file: string): void;
}
interface EdHostPage {
  getAttr(name: string): unknown;
  setAttr(name: string, v: unknown): void;
  getVar(name: string): string;
  setVar(name: string, v: unknown): void;
  prefersDark(): boolean;
  addStyle(id: string, css: string): void;
  onResize(f: () => void): void;
  onMedia(query: string, f: () => void): void;
  onFontsLoaded(f: () => void): void;
}
/* A file system the user edits directly (native): NAME is a path, relative to the directory edwin started in. */
interface EdHostFiles {
  read(name: string): string | null;
  write(name: string, text: string): void;
  remove(name: string): void;
  list(): string[];
  resolve(name: string): string;
  label(path: string): string;
  truename(name: string): string;
  exists(name: string): boolean;
  readonly cwd: string;
}
/* The Node host's job table for the worker threads (host-node.cts). */
interface EdHostJobs {
  fns: Map<string, EdPoolJobFn>;
  localOnly: Set<string>;
}
interface EdHost {
  kind: 'browser' | 'node' | 'native';
  headless: boolean;
  storage: EdHostStorage;
  /* browser: the page's own storage, kept when sync.ts moves storage into memory */
  pageStorage?: EdHostStorage;
  /* the shipped Scheme file NAME, the user's own, and a file by path (null: none) */
  config(name: string): string | null;
  userConfig(name: string): string | null;
  readFile(p: string): string | null;
  loadPath: string[];
  page: EdHostPage;
  /* the page was hidden or the program ends: flush what must persist */
  onSuspend(f: () => void): void;
  suspend?(): void;
  whenLoaded(f: () => void): void;
  /* browser: the texts the page fetched in served mode (Ed.bootServed) */
  sources?: Record<string, string>;
  clipboard?: string;
  setClipboard(s: string): void;
  /* native: the clipboard goes to the terminal or the window */
  onClipboard?: ((s: string) => void) | null;
  openUrl(url?: string): boolean;
  onCspViolation(f?: unknown): void;
  idle(f: () => void): unknown;
  nextFrame(f: () => void): unknown;
  /* native */
  files?: EdHostFiles;
  readonly dirs?: { home: string; cwd: string; config: string; state: string };
  init?(): void;
  /* node: worker threads for the pool (host-node.cts) */
  workers?: boolean;
  workersUnavailable?: string | null;
  workerCount?: number;
  jobs?: EdHostJobs | null;
  makeWorker?(data: EdPoolWorkerData): EdPoolThread;
}

/* ---------- OT: EdOT (ot.ts) ----------
   Two shapes of an edit: sequential ops ([pos, del text, ins], each against the text after the previous) and
   a TextOperation (retain n > 0, insert string, delete n < 0 over the whole document). */

type EdOTOp = [pos: number, del: string, ins: string];
interface EdTextOperation {
  /* components: retain (a positive number), insert (a string), delete (a negative number) */
  c: (number | string)[];
  baseLen: number;
  targetLen: number;
}
/* A sequenced batch in a history, for undo and rebase. */
interface EdOTBatch {
  ops: EdOTOp[];
  len?: number;
  ver?: number;
  cid?: unknown;
  undo?: { g: unknown; of?: unknown; ofCid?: unknown; redo?: boolean } | null;
}
interface EdOTError extends Error {
  code: string;
}
interface EdOTApi {
  OTError: SchemeClass<EdOTError, [code: string, msg: string]>;
  apply(text: string, ops: EdOTOp[]): string;
  applyOp(text: string, op: EdOTOp): string;
  checkOp(text: EdText, op: EdOTOp): void;
  check(text: string, ops: EdOTOp[]): number;
  invert(ops: EdOTOp[]): EdOTOp[];
  delta(ops: EdOTOp[]): number;
  fromOps(ops: EdOTOp[], len: number): EdTextOperation;
  toOps(o: EdTextOperation, text: EdText): EdOTOp[];
  applyOperation(s: string, o: EdTextOperation): string;
  compose(a: EdTextOperation, b: EdTextOperation): EdTextOperation;
  transform(a: EdTextOperation, b: EdTextOperation): [EdTextOperation, EdTextOperation];
  transformOps(seq: EdOTOp[], inc: EdOTOp[], text: EdText): [EdOTOp[], EdOTOp[]];
  rebase(inc: EdOTOp[], baseLen: number, later: { ops: EdOTOp[]; len: number }[]): EdTextOperation;
  shiftMarker(p: number, type: 'before' | 'after', pos: number, delLen: number, insLen: number): number;
  killsMarker(p: number, pos: number, delLen: number): boolean;
  hash(text: EdText): number;
  splitsPair(text: EdText, pos: number): boolean;
  undoOps(group: { cid: unknown; g: unknown }, history: EdOTBatch[], text: EdText): { op: EdTextOperation; partial: boolean };
  textBefore(text: EdText, batches: EdOTBatch[]): string;
  Op(): EdTextOperation;
  retain(o: EdTextOperation, n: number): EdTextOperation;
  insert(o: EdTextOperation, s: string): EdTextOperation;
  del(o: EdTextOperation, n: number): EdTextOperation;
}

/* ---------- pool: EdPool and the worker realm (pool.ts) ---------- */

/* What a job's function gets besides its item: the buffers it may read (mirrored in the worker), its
   arguments, the worker's state, progress reports, Scheme when the worker has it. */
interface EdPoolCtx {
  buffer(id: string | number): string;
  rope(id: string | number): Rope | null;
  version(id: string | number): number;
  args: any; // any: each job defines its own arguments
  state: Map<string, unknown>;
  worker: number;
  progress(v: unknown): void;
  scheme: { S: SchemeApi; L: LispApi } | null;
  transfer(...bufs: ArrayBufferLike[]): void;
  [field: string]: unknown;
}
/* A job: its source is shipped to the workers, so it may close over nothing but its DEPS. */
type EdPoolJobFn = (item: any, ctx: EdPoolCtx) => unknown; // any: each job defines its own items
interface EdPoolOpts {
  buffers?: EdBuffer[];
  buffersFor?: (item: any) => EdBuffer[]; // any: as the job's items
  affinity?: unknown;
  worker?: number;
  priority?: 'ui' | 'batch' | number;
  tag?: string;
  fallback?: 'local';
  chunk?: number;
  args?: unknown;
  timeout?: number;
  transfer?: ArrayBufferLike[];
  onProgress?: (v: unknown) => void;
  [opt: string]: unknown;
}
/* A job's promise: cancel stops it (hard: terminate its worker). */
interface EdPoolPromise<T = any> extends Promise<T> { // any: a job's result is the job's own
  req?: number;
  versions?: Map<number | string, number>;
  cancel?: (o?: { hard?: boolean }) => void;
}
interface EdPoolApi {
  readonly ok: boolean;
  readonly scheme: boolean;
  size: number;
  readonly alive: number;
  readonly ready: Promise<boolean>;
  setSize(n: number): void;
  stats(): Record<string, unknown>;
  JOB_LIMIT: number;
  define(name: string, fn: EdPoolJobFn, deps?: Function[]): void;
  run<T = any>(name: string, args?: unknown, opts?: EdPoolOpts): EdPoolPromise<T>; // any: as EdPoolPromise
  map<T = any>(name: string, items: unknown[], opts?: EdPoolOpts): EdPoolPromise<T[]>; // any: as EdPoolPromise
  local(name: string, args?: unknown, bufs?: EdBuffer[], mapArgs?: unknown): unknown;
  /* B's text from FROM to TO in N pieces at line boundaries */
  shards(b: EdBuffer, from: number, to: number, n: number): { id: string | number; from: number; to: number }[];
  cancel(p: EdPoolPromise<unknown>, o?: { hard?: boolean }): void;
  cancelAll(tag?: string): void;
  sync(b: EdBuffer): void;
  release(b: EdBuffer): void;
  evalForm(form: string, opts?: EdPoolOpts): EdPoolPromise<unknown>;
  callProc(name: string, args?: unknown[], opts?: EdPoolOpts): EdPoolPromise<unknown>;
  broadcast(src: string): Promise<unknown>;
  deliver(fn: () => void, now?: boolean): void;
  grep(source: string, flags: string, targets: (EdBuffer | string | { id: string | number; from: number; to: number })[], max?: number): EdPoolPromise<{ target: unknown; hits: Int32Array; truncated: boolean }[]>;
  /* P, cancelled by C-g while the command loop waits on it */
  interruptible<T>(p: Promise<T>): Promise<T>;
  /* the word index of buffers, for completion */
  wordIndex(t: string, src: string, cap: number): EdWordIndex;
  wordsIn(b: EdBuffer, src: string, sync?: boolean): EdWordIndex;
  wordsWithPrefix(ix: EdWordIndex, lower: string, fn: (w: string) => void): void;
  filterItems(items: string[], terms: [source: string, flags: string][]): Int32Array;
  /* the matching indexes of ITEMS, in a worker: null when it would not pay */
  filterAsync(items: string[], terms: RegExp[]): Promise<ArrayLike<number>> | null;
  unlist(items: string[]): void;
  /* lex B in a worker: false when it cannot */
  lexAsync(b: EdBuffer): boolean;
  _fail?: unknown;
  _slots?: unknown;
  _codec?: unknown;
  Future?: unknown;
  [field: string]: unknown;
}
/* host.makeWorker's argument: what a Node worker thread starts with. */
interface EdWordIndex { n: number; words: string; lower: string; off: Int32Array; loff: Int32Array }
interface EdPoolWorkerData {
  k: number;
  withScheme: boolean;
  lexSource: string;
  limits: { SCHEME_TIMEOUT: number; MIRROR_BUDGET: number };
}
/* A worker as the pool drives it: a page Worker, or host-node's thread wrapper. */
interface EdPoolThread {
  onmessage: ((ev: { data: any }) => void) | null; // any: messages are checked by their t field
  onerror: ((ev: { message: string; preventDefault(): void }) => void) | null;
  postMessage(m: unknown, transfer?: unknown[]): void;
  terminate(): void;
  closed?: boolean;
  ref?(): void;
  unref?(): void;
}
/* The structured clone codec for Scheme values crossing to a worker. */
interface EdCodecApi {
  encode(x: unknown): unknown;
  decode(x: unknown): unknown;
  hooks: { buffer?: (h: { id: string | number; name?: string; ver?: number }) => unknown };
}
/* The worker realm's prims: install the worker's state, set its id. */
interface EdPrimsApi {
  install(w: unknown): void;
  setId(k: number): void;
}
/* pool.ts loaded without Ed (a Node worker thread): the parts the thread builds itself from. */
interface EdPoolWorkerModule {
  codecModule: (g: TPoolCodecRealm) => void;
  workerPrims: (self: TPoolRealm) => void;
  workerMain: (self: TPoolRealm, limits: EdPoolWorkerData['limits']) => void;
  [field: string]: unknown;
}

/* ---------- display: model frames (display.ts) ---------- */

/* A model frame's backend: a terminal (native main.ts), a window (native gui.ts), a test. */
interface EdDisplayBackend {
  size(): { cols: number; rows: number } | null;
  draw(model: EdDisplayModel): void;
  bell?(): void;
  theme?: 'light' | 'dark' | null;
  tty?: boolean;
  gui?: boolean;
}
/* A face: colours '#rrggbb'. */
interface EdFace {
  fg: string;
  bg: string;
  weight?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  box?: boolean;
}
/* A segment of a row: TEXT takes W cells from column X in face F. cw: each character's width (gui.ts). */
interface EdSegment {
  x: number;
  w: number;
  text: string;
  f: number;
  cw?: number[];
}
type EdCursorShape = 'box' | 'bar' | 'hbar' | 'half' | 'hollow';
/* What display.ts hands the backend each redisplay: plain data, so it can go as JSON. */
interface EdDisplayModel {
  cols: number;
  rows: number;
  theme: 'light' | 'dark';
  focused: boolean;
  title: string;
  /* faces[0] is the default face */
  faces: EdFace[];
  /* one list of segments per row */
  lines: EdSegment[][];
  cursor: { x: number; y: number; shape: EdCursorShape; color?: string; fg?: string } | null;
  /* the cursors of the windows without the keyboard */
  ghosts: { x: number; y: number }[];
  /* other writers' cursors */
  presence: { x: number; y: number; label: string; color: string }[];
  windows: { id: number; x: number; y: number; w: number; h: number; selected: boolean; buffer: string; start: number; lastLine: number }[];
}
/* An input event in cell terms, for Ed.display.input. */
type EdDisplayEvent =
  | { type: 'key'; key: string }
  | { type: 'paste'; text: string }
  | { type: 'focus'; focused: boolean }
  | { type: 'mouse'; action: 'down' | 'drag' | 'up' | 'wheel'; x: number; y: number; button?: number; dy?: number; shift?: boolean; meta?: boolean; ctrl?: boolean }
  | { type: 'resize' };
/* What is at a cell of a model frame. */
type EdDisplayHit =
  | { area: 'text'; window: EdWindow; pos: number }
  | { area: 'modeline'; window: EdWindow }
  | { area: 'divider' | 'echo'; window?: undefined }
  | null;
/* A glyph of a rendered line: T shown in W cells, at offset P, with classes K; CUR: the cursor's cell. */
interface EdGlyph {
  t: string;
  w: number;
  p: number;
  k: string;
  cur: boolean;
}
interface EdDisplayApi {
  /* the palette tokens of the light and dark themes, and each class's face spec in tokens */
  PALETTE: Record<'light' | 'dark', Record<string, string>>;
  FACES: Record<string, Record<string, unknown>>;
  resolveFace(key: string, theme: 'light' | 'dark'): EdFace;
  parseColor(s: string): [number, number, number, number] | null;
  charWidth(cp: number): number;
  strWidth(s: string): number;
  glyphsOf(line: EdRenderedLine): EdGlyph[];
  wrap(g: EdGlyph[], cols: number, nowrap?: boolean): EdGlyph[][];
  frameModel(f: EdFrame): EdDisplayModel;
  posAt(f: EdFrame, x: number, y: number): EdDisplayHit;
  redraw(f: EdFrame): void;
  setTheme(f: EdFrame, theme: string | null): void;
  input(f: EdFrame, ev: EdDisplayEvent): void;
}

/* ---------- modules: the other files' exports ---------- */

/* An Evil range: [beg, end, type]. */
type EdRange = [beg: number, end: number, type: 'char' | 'inclusive' | 'exclusive' | 'line' | 'block' | string];

/* evil-core.ts; evil-ex.ts adds exExecute. */
interface EvilCoreApi {
  stateOf(b?: EdBuffer | null): EdEvilState | null;
  setState(b: EdBuffer, s: EdEvilState): void;
  visualBounds(b: EdBuffer): EdRange;
  visualRange(b: EdBuffer, exit?: boolean): EdRange;
  readRange(): Promise<EdRange>;
  regGet(r?: string | null): EdRegister | null;
  storeYank(text: string, type: EdRegister['type'], r?: string | null, isDelete?: boolean): void;
  keysToText(keys: string[]): string;
  textToKeys(text: string): string[];
  clampNormal(b: EdBuffer): void;
  firstNonBlank(t: EdText, p: number): number;
  blockRanges(b: EdBuffer, beg: number, end: number): [number, number][];
  pushJump(b: EdBuffer, pos?: number): void;
  exitVisual(b: EdBuffer): void;
  enterInsert(b: EdBuffer, count?: number, open?: unknown, block?: unknown): void;
  defvar: LispApi['defvar'];
  D: LispApi['D'];
  CMD: LispApi['CMD'];
  put: LispApi['put'];
  /* a symbol property (evil-core's own, not L.get) */
  get: LispApi['prop'];
  aux(mode: string, st: string, create?: boolean): EdKeymap | null;
  KM(name: string): EdKeymap | null;
  /* set by evil-ex.ts */
  exExecute?: (line: string) => Promise<unknown>;
}
interface EvilExApi {
  vimRegex(pat: string): RegExp;
  findMatch(t: EdText, re: RegExp, from: number, dir: number, wrap?: boolean): { s: number; e: number; [k: string]: unknown } | null;
  exExecute(line: string): Promise<unknown>;
  parseRange(b: EdBuffer, s: string): unknown;
  resolveEx(name: string): unknown;
  substituteText(seg: string, reSource: string, reFlags: string, rep: string, g: boolean, inner?: unknown): unknown;
}
/* complete.ts: the in-buffer completion popup (corfu). */
interface CompleteApi {
  open(b: EdBuffer, auto?: boolean, min?: number): boolean;
  close(): void;
  accept(): boolean | void;
  prefixAt(b: EdBuffer): { start: number; text: string; [k: string]: unknown } | null;
  fileCandidates(text: string): EdCompletion[];
}
/* A completion candidate: its text, its score and an annotation shown beside it. */
interface EdCompletion { text: string; score: number; ann: string }
/* stack.ts: snippets. */
interface YasApi {
  keyAt(b: EdBuffer): { start: number; snippet: { template: string; [k: string]: unknown }; [k: string]: unknown } | null;
  expand(b: EdBuffer): Promise<boolean>;
  snippets: unknown;
}
/* stack.ts, org.ts, markdown.ts and ai.ts export more for the tests; the core reads none of it. */
interface EdModuleExports {
  [name: string]: unknown;
}

/* ---------- native: desktop Edwin (native/js) ---------- */

/* __n: the natives the Rust shell gives (edwin/native/src/natives.rs). File calls throw with the system's
   message; reading a missing file gives null. */
interface EdNatives {
  /* run an embedded source (native/js/NAME or a core file) */
  load(name: string): void;
  args(): string[];
  print(s: string): void;
  eprint(s: string): void;
  env(name: string): string | undefined;
  cwd(): string;
  now(): number;
  readFile(path: string): string | null;
  writeFile(path: string, text: string): void;
  appendFile(path: string, text: string): void;
  stat(path: string): { dir: boolean; size: number; mtime: number; mode: number } | null;
  realpath(path: string): string | null;
  readDir(path: string): [name: string, dir: boolean][];
  remove(path: string): void;
  mkdirs(path: string): void;
  readStdin(): string;
  ttyOpen(): boolean;
  ttyClose(): void;
  ttyWrite(s: string): void;
  ttyFlush(): void;
  ttySize(): [cols: number, rows: number];
  /* stop until SIGCONT */
  suspend(): void;
  exit(code: number): void;
  sockOpen(path: string): number;
  sockSend(id: number, s: string): void;
  sockClose(id: number): void;
  /* the window: its size and theme (null in a terminal), the model as JSON, an action, the clipboard */
  guiSize(): { cols: number; rows: number; theme?: 'light' | 'dark' } | null;
  guiDraw(json: string): void;
  guiAction(name: string, arg?: string): void;
  guiClipboard(): string | null;
}
/* __native: what the shell's event loop calls (prelude.ts); main.ts sets the handlers. */
interface EdNativeLoop {
  handlers: {
    input: ((s: string) => void) | null;
    signal: ((name: string) => void) | null;
    sock: ((id: number, line: string | null) => void) | null;
    gui?: ((json: string) => void) | null;
  };
  /* run the due timers; milliseconds to the next (-1: none) */
  tick(): number;
  freeze(): void;
  thaw(): void;
  next(): number;
  input(s: string): void;
  signal(name: string): void;
  sock(id: number, line: string | null): void;
  gui(json: string): void;
}
/* host-native.ts's module: the host, and the path helpers main.ts uses. */
interface EdNativeHostModule {
  createHost(opts?: { storage?: EdHostStorage; dark?: boolean }): EdHost;
  resolve(name: string): string;
  truename(name: string): string;
  label(p: string): string;
  env(k: string): string | null;
  join(a: string, b: string): string;
  dirname(p: string): string;
  readonly HOME: string;
  readonly CWD: string;
}
/* term.ts: the terminal's encoder (model to escape sequences) and decoder (bytes to display events). */
type EdColorMode = 'truecolor' | '256' | '16' | string;
interface EdTermEncoder {
  readonly color: EdColorMode;
  defaultColors: boolean;
  enter(): string;
  leave(): string;
  invalidate(): void;
  draw(m: EdDisplayModel): string;
  clipboard(s: string): string;
  title(s: string): string;
  bell(): string;
}
/* A decoded terminal event: a display event, or a reply to a query (the background colour, DA1). */
/* a reply to a query term.ts sent: the kitty keyboard flags, the background colour, the primary device attributes */
type EdTermEvent = EdDisplayEvent | { type: 'reply'; kind: 'kitty'; value: number } | { type: 'reply'; kind: 'background' | 'da1'; value: string };
interface EdTermDecoder {
  feed(text: string): EdTermEvent[];
  pending(): boolean;
  flush(): EdTermEvent[];
}
interface EdTermApi {
  encoder(opts?: { color?: EdColorMode; defaultColors?: boolean }): EdTermEncoder;
  decoder(): EdTermDecoder;
  colorMode(env: { COLORTERM?: string; TERM?: string; TERM_PROGRAM?: string }): EdColorMode;
  to256(rgb: [number, number, number]): number;
  to16(rgb: [number, number, number]): number;
  b64(s: string): string;
}
/* gui.ts: the window instead of the terminal (edwin --gui). */
interface EdGuiScreen {
  backend: EdDisplayBackend;
  theme(): 'light' | 'dark' | null;
  clipboard(s: string): void;
  iconify(): void;
}
interface EdGuiApi {
  screen(): EdGuiScreen;
  handle(json: string, frame: EdFrame, on: { close(): void; drop(path: string): void }): void;
  keydown(ev: { key: unknown; code?: unknown; ctrlKey?: unknown; altKey?: unknown; shiftKey?: unknown; metaKey?: unknown; altGraph?: unknown }): EdKeyEvent;
  withWidths(m: EdDisplayModel): EdDisplayModel;
}

/* The artifact runtime on claude.ai (ai.ts): present only inside an artifact; check typeof claude first. */
interface EdClaudeRuntime {
  use(capability: string): Promise<unknown>;
  [field: string]: unknown;
}

/* ---------- globals ----------
   Set by the file named; read by the files after it in the load order (README: scheme runtime text
   editor-core editor-prims evil-core pool complete extras stack ai evil-ex org markdown ot sync display,
   after host-browser.ts or the Node or native host). Module objects are typed as present: the readers that
   may run before them check globalThis.X first. */

/* scheme.ts: the Scheme object; SCHEME_MODE ('gen') and SCHEME_SHADOW_STACK (false) are read at load */
declare var Scheme: SchemeApi;
declare var SCHEME_MODE: 'gen' | 'direct' | undefined;
declare var SCHEME_SHADOW_STACK: boolean | undefined;
/* runtime.ts */
declare var L: LispApi;
/* text.ts */
declare var Rope: RopeConstructor;
/* the sources of scheme.ts, runtime.ts and text.ts, for the workers (pool.ts) */
declare var schemeSource: string;
declare var runtimeSource: string;
declare var ropeSource: string;
/* host-browser.ts, host-node.cts, native boot.ts */
declare var EdHost: EdHost;
/* editor-core.ts */
declare var Ed: EdApi;
/* evil-core.ts, evil-ex.ts */
declare var EvilCore: EvilCoreApi;
declare var EvilEx: EvilExApi;
/* pool.ts: the pool; in a worker, the codec, the prims, the job table; without Ed, the worker module */
declare var EdPool: EdPoolApi;
declare var EdCodec: EdCodecApi | null;
declare var EdPrims: EdPrimsApi;
declare var JOBS: Record<string, EdPoolJobFn>;
declare var EdPoolWorker: EdPoolWorkerModule;
/* complete.ts, stack.ts */
declare var Complete: CompleteApi;
declare var Yas: YasApi;
declare var Stack: EdModuleExports;
/* ai.ts, org.ts, markdown.ts */
declare var EdAI: EdModuleExports;
declare var Org: EdModuleExports;
declare var Markdown: EdModuleExports;
/* ot.ts */
declare var EdOT: EdOTApi;
/* ai.ts reads it (also as window.claude) */
declare var claude: EdClaudeRuntime;

/* native: the shell's natives and shipped Scheme (natives.rs), prelude.ts's loop, the modules */
declare var __n: EdNatives;
declare var __scm: Record<string, string>;
declare var __native: EdNativeLoop;
declare var EdNativeHost: EdNativeHostModule;
declare var EdTerm: EdTermApi;
declare var EdGui: EdGuiApi;
/* boot.ts: how far the startup got (the snapshot holds 'booted'), the core files; main.ts: attach to edwind */
declare var EdBooted: 'loaded' | 'booted' | undefined;
declare var EdBootAttach: boolean | undefined;
declare var EdNativeFiles: string[] | undefined;

/* ---------- types (erased) ---------- */
type TPoolId = number | string;
type TPoolVersions = Map<TPoolId, number>;
interface TPoolLimits { SCHEME_TIMEOUT: number; MIRROR_BUDGET: number }
/* the codec's trees: plain data, typed arrays, or a node tagged by $ */
type TPoolEnc = boolean | number | string | bigint | ArrayBuffer | ArrayBufferView | TPoolNode;
interface TPoolBufHandle { $: 'b'; id: TPoolId; name: string; pt: number; ver: number }
interface TPoolList { $: 'l'; a: TPoolEnc[]; t?: TPoolEnc }
type TPoolNode =
  | { $: 'nil' } | { $: 'u' } | { $: 'eof' } | { $: 'y'; n: string } | { $: 'c'; c: number } | TPoolList
  | { $: 'v'; a: TPoolEnc[] } | { $: 'h'; e: [TPoolEnc, TPoolEnc][] } | { $: 'r'; t: string; f: TPoolEnc[] }
  | { $: 'vals'; a: TPoolEnc[] } | { $: 'rx'; s: string; f: string } | { $: 'e'; k: string; m: string; i: TPoolEnc[] }
  | TPoolBufHandle | { $: 'p'; v: TPoolEnc } | { $: 'proc'; f: TPoolEnc };
/* what encode reports: the buffers met, procedures to ship, record types met */
interface TPoolCodecMeta {
  buffers?: Set<EdBuffer>;
  ship?: (p: SchemeProcedure) => TPoolEnc;
  record?: (rt: SchemeRecordType) => void;
}
interface TPoolCodec {
  encode(x: SchemeValue, meta?: TPoolCodecMeta): TPoolEnc;
  /* a Scheme value, or a JS job's plain data as it came */
  decode(x: unknown): SchemeValue;
  hooks: { buffer: ((h: TPoolBufHandle) => SchemeValue) | null };
}
interface TPoolCodecRealm { Scheme?: SchemeApi | null; EdCodec?: TPoolCodec | null }
/* a thread's global object: a page worker's self, or server/worker.mts's stand-in */
interface TPoolRealm extends TPoolCodecRealm {
  L?: LispApi | null;
  EdPrims?: TPoolPrims;
  JOBS: Record<string, EdPoolJobFn>;
  Rope: RopeConstructor;
  postMessage(m: TPoolFromWorker, transfer?: ArrayBufferLike[]): void;
  importScripts(url: string | null): void;
  onmessage: ((ev: { data: TPoolToWorker }) => void) | null;
}
interface TPoolPrims { install(w: TPoolWorkerState): void; setId(k: number): void }
/* a thread's copy of a buffer (rope null once dropped) */
interface TPoolMirror {
  id: TPoolId; name: string; ver: number; pt: number; rope: Rope | null; lastUse: number; dead?: boolean;
  __type: 'buffer';
  __print(): string;
}
interface TPoolWorkerState {
  mirrors: Map<TPoolId, TPoolMirror>;
  state: Map<string, unknown>;
  k: number;
  cur: TPoolMirror | null;
  req: number;
  t0: number;
  chars: number;
  touch: (r: TPoolMirror) => void;
  report: (x: SchemeValue) => void;
  base?: Map<string, SchemeValue>;
}
/* an error as it crosses from a thread */
interface TPoolWireError { kind: string; message: string; irritants?: TPoolEnc[]; obj?: TPoolEnc; stack?: string }
type TPoolJobMsg =
  | { t: 'run'; req: number; name: string; args: unknown; timeout: number }
  | { t: 'map'; req: number; name: string; items: unknown[]; args: unknown; timeout: number }
  | { t: 'eval'; req: number; prelude: TPoolEnc[]; form: TPoolEnc; cur: TPoolId | null; timeout: number; args?: undefined };
type TPoolToWorker =
  | { t: 'init'; k: number; size: number; broadcast: TPoolEnc[] }
  | { t: 'reset'; id: TPoolId; name: string; ver: number; pt: number; text: string }
  | { t: 'edits'; id: TPoolId; name?: string; ver: number; pt: number; ops: [pos: number, del: number, ins: string][] }
  | { t: 'drop'; id: TPoolId }
  | { t: 'define'; name: string; url: string | null }
  | { t: 'broadcast'; form: TPoolEnc; req?: number }
  | TPoolJobMsg;
type TPoolFromWorker =
  | { t: 'ready'; k: number; scheme: boolean; names: string[]; macros: string[] }
  | { t: 'done'; req: number; val: unknown; versions: TPoolVersions; ms: number; evicted: TPoolId[] }
  | { t: 'fail'; req: number; error: TPoolWireError; versions: TPoolVersions }
  | { t: 'progress'; req: number; x: unknown }
  | { t: 'out'; s: string }
  | { t: 'msg'; s: string }
  | { t: 'bdone'; req: number; ok: boolean }
  | { t: 'defined'; name: string; url: string | null }
  | { t: 'define-failed'; name: string; url: string | null; error: string };
/* the Node host, when it makes the threads */
type TPoolNodeHost = EdHost & { makeWorker(data: EdPoolWorkerData): EdPoolThread };
/* a condition or a JS error a job failed with */
interface TPoolErr extends Error { kind?: string; irritants?: SchemeValue[] }
type TPoolStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
interface TPoolPromise extends EdPoolPromise { versions?: TPoolVersions }
interface TPoolJobDef { name: string; fn: EdPoolJobFn; src: string | null; depsSrc: string | null; localOnly: boolean }
interface TPoolDef { value: unknown; enc: TPoolEnc | null; data?: boolean }
interface TPoolSlot {
  k: number; w: EdPoolThread | null; url: string | null; ready: boolean; scheme: boolean; busy: TPoolJob | null; gen: number;
  /* the version of each buffer mirrored there, and the point and name last sent */
  mirrors: Map<TPoolId, number>; meta: Map<TPoolId, { pt: number; name: string }>;
  /* the definitions it holds ('g:' globals, 'm:' macros, 'r:' record types) by the value shipped */
  have: Map<string, unknown>;
  names: Set<string> | null; macros: Set<string> | null;
  lastUse: number; crashes: number[]; dead: boolean; retired: boolean; bootFails: number; withScheme: boolean;
}
interface TPoolJob {
  req: number; kind: 'run' | 'map' | 'eval'; priority: number; worker: number | undefined; affinity: unknown;
  timeout: number | undefined; tag: string | undefined; transfer: ArrayBufferLike[] | undefined; onProgress: ((v: unknown) => void) | undefined;
  buffers: Set<EdBuffer>; status: 'queued' | 'running' | 'done' | 'failed'; slot: TPoolSlot | null; gen: number; timer: number;
  versions: TPoolVersions | null; future: unknown | null; parent: unknown | null;
  cbs: { onDone?: (v: unknown, versions: TPoolVersions) => void; onFail?: (e: TPoolErr) => void } | null;
  added: string[] | null; name: string | null; args: unknown; items: unknown[] | null; form: TPoolEnc | null;
  defs: Map<string, TPoolDef> | null; cur: TPoolId | null; convert: ((names: Set<string> | null) => void) | null; localFn: (() => SchemeValue) | null;
  promise: TPoolPromise; res: (v: unknown) => void; rej: (e: unknown) => void; parts?: TPoolJob[];
}
interface TPoolHandler { onValue?: SchemeValue; onError?: SchemeValue; onFinally?: SchemeValue }
/* compile-time references, as Scheme.scanClosure collects them */
type TPoolLookup = { macro: SchemeMacro; at: SchemeScope; index?: undefined } | { macro?: undefined; depth: number; index: number; at: SchemeScope };
interface TPoolScan { scopes: Set<SchemeScope>; refs: [SchemeSym | SchemeAlias, TPoolLookup | null][]; macros: [SchemeValue, TPoolLookup | null][] }
interface TPoolConverter {
  defs: Map<string, TPoolDef>;
  encode: (v: SchemeValue) => TPoolEnc;
  global: (name: string) => void;
  proc: (p: SchemeProcedure) => TPoolEnc;
  walk: (datum: SchemeValue) => void;
  addDef: (key: string, value: unknown, enc: TPoolEnc, data?: boolean) => void;
}
/* the word index of a text */
interface TPoolWordIndex { n: number; words: string; lower: string; off: Int32Array; loff: Int32Array }
interface TPoolGrepHit { target: EdBuffer | string | { id: TPoolId; from: number; to: number }; hits: Int32Array; truncated: boolean }
