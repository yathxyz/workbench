// Load Edwin's Scheme (src/scheme.ts) into Node by itself, with no page stand-ins.
//
// loadScheme() runs it in this context (vm.runInThisContext), as the editor does, and returns the
// Scheme object; loadSchemeIn(source, globals) runs a source text in a fresh context (the benchmark
// loads several evaluators side by side that way).
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export type SchemeValue = any; // any: a value of the evaluator, which is untyped JavaScript (src/scheme.ts)
export type SchemeMode = 'direct' | 'gen';
/* A source location, as sourceLocation gives it. */
export interface SourceLoc { file: string | null; line: number; col: number }
/* A frame of the shadow stack (R4.34). */
export interface StackFrame { proc: SchemeValue; frame: SchemeValue; loc: SourceLoc | null }
export interface SchemeErrorObject extends Error { kind: string; irritants: SchemeValue[]; payload?: SchemeValue; shadow?: unknown; signalled?: boolean }
export interface SymObject { name: string }
export interface PairObject { car: SchemeValue; cdr: SchemeValue }
export interface BoxObject { name: string; value: SchemeValue }
export interface RestartObject { name: SymObject | false; report: SchemeValue; interactive: SchemeValue; fn: SchemeValue; tag: unknown; js: boolean }
/* A restart as withRestarts takes it. */
export interface RestartSpec { name: string | SymObject; report?: string; interactive?: (r: RestartObject) => SchemeValue[]; fn: (...args: SchemeValue[]) => SchemeValue }
export interface SchemeReader { form(): SchemeValue; readonly done: boolean; pos: number }
/* The hooks the host installs (all null until set). */
export interface SchemeHooks {
  isQuit: ((o: unknown) => boolean) | null;
  output: ((s: string) => void) | null;
  errorOutput: ((s: string) => void) | null;
  readFile: ((path: string) => string | null | undefined | false) | null;
  restartArgs: ((r: RestartObject) => SchemeValue[] | null | undefined) | null;
  threadSwitch: ((prev: unknown, next: unknown) => void) | null;
  debugG: ((r: unknown, continuable: boolean) => Generator<unknown, SchemeValue, unknown>) | null;
}
/* The Scheme object src/scheme.js exports (the members the suites use). */
export interface Scheme {
  Sym: new (name: string) => SymObject;
  Pair: new (car: SchemeValue, cdr: SchemeValue) => PairObject;
  SchemeError: new (kind: string, message: string, irritants?: SchemeValue, payload?: SchemeValue) => SchemeErrorObject;
  Raise: new (obj: SchemeValue, continuable: boolean) => Error & { obj: SchemeValue; continuable: boolean };
  Escape: new (tag: unknown, vals: SchemeValue[]) => { tag: unknown; vals: SchemeValue[] };
  NIL: SchemeValue;
  UNSPEC: SchemeValue;
  EOF: SchemeValue;
  DECLINE: object;
  intern(name: string): SymObject;
  gensym(base?: string): SymObject;
  cons(a: SchemeValue, b: SchemeValue): PairObject;
  list(...xs: SchemeValue[]): SchemeValue;
  listOf(arr: SchemeValue[], tail?: SchemeValue): SchemeValue;
  arr(x: SchemeValue): SchemeValue[];
  read(src: string): SchemeValue;
  readAll(src: string, file?: string | { file?: string }): SchemeValue[];
  reader(src: string, opts?: string | { file?: string }): SchemeReader;
  write(x: SchemeValue, display?: boolean): string;
  display(x: SchemeValue): string;
  eqv(a: SchemeValue, b: SchemeValue): boolean;
  equal(a: SchemeValue, b: SchemeValue): boolean;
  gbox(name: string): BoxObject;
  gref(name: string): SchemeValue;
  gset(name: string, v: SchemeValue): SchemeValue;
  gdef(name: string, v: SchemeValue): SchemeValue;
  isBound(name: string): boolean;
  callProc(f: SchemeValue, args: SchemeValue[]): SchemeValue;
  def(name: string, fn: (...args: SchemeValue[]) => SchemeValue, opts?: { doc?: string; args?: string; interactive?: SchemeValue }): SchemeValue;
  evalForm(form: SchemeValue): SchemeValue;
  evalString(src: string, file?: string): SchemeValue;
  errorMessage(e: unknown): string;
  hooks: SchemeHooks;
  watchdog: { limitMs: number; reset(): void };
  makeOutputPort(fn: (s: string) => void, name?: string): SchemeValue;
  withOutputTo(port: SchemeValue, thunk: () => SchemeValue): SchemeValue;
  sourceLocation(x: SchemeValue): SourceLoc | null;
  conditionIs(e: unknown, kind: string | SymObject): boolean;
  withHandler(h: (condition: SchemeValue, continuable: boolean) => SchemeValue, thunk: () => SchemeValue): SchemeValue;
  withRestarts(specs: (RestartSpec | RestartObject)[], thunk: () => SchemeValue): SchemeValue;
  computeRestarts(): RestartObject[];
  invokeRestart(x: SchemeValue, args?: SchemeValue[]): never;
  backtrace(): StackFrame[];
  conditionBacktrace(e: unknown): StackFrame[] | null;
  resetStack(): void;
  stackDepth(): number;
  setMaxDepth(n: number): void;
  readonly maxDepth: number;
  shadowStack: boolean;
  readonly mode: SchemeMode;
}
/* The globals the evaluator reads at load. */
interface SchemeGlobals { SCHEME_MODE?: string; SCHEME_SHADOW_STACK?: boolean; Scheme?: Scheme }

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEME_FILE = join(ROOT, 'src', 'scheme.ts');
/* Its JavaScript (host-node.cts coreSource: the built scheme.js, or scheme.ts stripped). */
export const SCHEME_SOURCE: string = (createRequire(import.meta.url)('../src/host-node.cts') as { coreSource(f: string): { text: string } }).coreSource('scheme').text;

// The evaluator modes a suite runs in: 'direct' (the closure compiler, frames) and 'gen' (generator
// closures, edwind; R4.38). Both must pass the same suite.
export const MODES: string[] = ['direct', 'gen'];
export const MODE: string = process.env.EDWIN_SCHEME_MODE || 'direct';

export function loadScheme(mode: string = MODE): Scheme {
  if (!MODES.includes(mode)) throw new Error('unknown Scheme evaluator mode: ' + mode);
  (globalThis as SchemeGlobals).SCHEME_MODE = mode;
  vm.runInThisContext(SCHEME_SOURCE, { filename: 'scheme.ts' });
  return (globalThis as SchemeGlobals).Scheme!;
}

export function loadSchemeIn(source: string, globals: SchemeGlobals = {}): Scheme {
  const sandbox: SchemeGlobals & Record<string, unknown> = { performance, TextEncoder, console, ...globals };
  sandbox.window = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'scheme.ts' });
  return sandbox.Scheme!;
}
