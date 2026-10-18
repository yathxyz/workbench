/* One thread of edwind's worker pool (R4.47, R15.3), started by host-node.js as new Worker(this file).

   The browser builds a worker from the sources of the core's module functions joined into a blob URL
   (pool.js buildUrl). edwind runs with code generation from strings disabled, so this file loads the same
   modules from their files: text.js (the rope), scheme.js and runtime.js (the Scheme the thread evaluates
   shipped forms with), the codec, the thread primitives and the message loop from pool.js (which, run in a
   realm with no editor, defines those three and stops), and the named jobs from jobs.mts. The protocol is
   workerMain's, unchanged: init, reset, edits, drop, broadcast, run, map and eval come in; ready, done,
   fail, progress, out, msg and bdone go out. workerData: { k, withScheme, lexSource, limits }. */
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as jobs from './jobs.mts';
import { lockdown } from './lockdown.mts';
import type { TransferListItem } from 'node:worker_threads';

/* What the core files (text.js, scheme.js, runtime.js, pool.js) leave on the thread's global object. */
type CoreGlobal = typeof globalThis & Record<string, any>; // any: edwin/src is untyped JavaScript
/* The browser worker's self, as workerMain (pool.js) uses it. */
interface WorkerSelf {
  Scheme: unknown;
  L: unknown;
  Rope: unknown;
  JOBS: Record<string, Function>;
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage(m: unknown, transfer?: readonly TransferListItem[]): void;
  importScripts(): never;
}

lockdown(); // before the core files load, as --frozen-intrinsics was (lockdown.mts)

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const { coreSource } = createRequire(import.meta.url)('../src/host-node.cts') as { coreSource(f: string): { text: string; filename: string } };
const load = (f: string) => { const c = coreSource(f); vm.runInThisContext(c.text, { filename: c.filename }); };
const { withScheme, lexSource, limits } = workerData as { k: number; withScheme: boolean; lexSource: string | null; limits: unknown };

load('text');
if (withScheme) { load('scheme'); load('runtime'); }
/* The Lisp lexer, for the lex job: editor-core.js has no file of its own for it and hands the pool its
   source (Ed.LEX_SOURCE, the lexer's functions and constants); it is compiled here as the core files are,
   not evaluated as a string by the engine. */
if (lexSource) vm.runInThisContext(lexSource, { filename: path.join(SRC, 'editor-core.ts') + ':lex' });
load('pool');
const { codecModule, workerPrims, workerMain } = (globalThis as CoreGlobal).EdPoolWorker;

/* What workerMain expects of its realm: the browser worker's self, as a plain object. */
const self: WorkerSelf = {
  Scheme: withScheme ? (globalThis as CoreGlobal).Scheme : null,
  L: withScheme ? (globalThis as CoreGlobal).L : null,
  Rope: (globalThis as CoreGlobal).Rope,
  JOBS: Object.create(null),
  onmessage: null,
  postMessage: (m, transfer) => parentPort!.postMessage(m, transfer),
  importScripts() { throw new Error('a thread of edwind loads its jobs from jobs.mts, not from a URL'); },
};
for (const [name, fn] of Object.entries(jobs)) if (typeof fn === 'function') self.JOBS[name] = fn;
codecModule(self);
if (withScheme) workerPrims(self);
workerMain(self, limits);
parentPort!.on('message', data => self.onmessage!({ data }));
