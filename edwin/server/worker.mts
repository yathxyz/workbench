/* One thread of edwind's worker pool (R4.47, R15.3), started by host-node.js as new Worker(this file).

   The browser builds a worker from the sources of the core's module functions joined into a blob URL
   (pool.js buildUrl). edwind runs with code generation from strings disabled, so this file loads the same
   modules from their files: text.js (the rope), scheme.js and runtime.js (the Scheme the thread evaluates
   shipped forms with), the codec, the thread primitives and the message loop from pool.js (which, run in a
   realm with no editor, defines those three and stops), and the named jobs from jobs.mts. The protocol is
   workerMain's, unchanged: init, reset, edits, drop, broadcast, run, map and eval come in; ready, done,
   fail, progress, out, msg and bdone go out. workerData: { k, withScheme, lexSource, limits }. */
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as jobs from './jobs.mts';
import { lockdown } from './lockdown.mts';

lockdown(); // before the core files load, as --frozen-intrinsics was (lockdown.mts)

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const load = f => { const p = path.join(SRC, f); vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p }); };
const { withScheme, lexSource, limits } = workerData;

load('text.js');
if (withScheme) { load('scheme.js'); load('runtime.js'); }
/* The Lisp lexer, for the lex job: editor-core.js has no file of its own for it and hands the pool its
   source (Ed.LEX_SOURCE, the lexer's functions and constants); it is compiled here as the core files are,
   not evaluated as a string by the engine. */
if (lexSource) vm.runInThisContext(lexSource, { filename: path.join(SRC, 'editor-core.js') + ':lex' });
load('pool.js');
const { codecModule, workerPrims, workerMain } = globalThis.EdPoolWorker;

/* What workerMain expects of its realm: the browser worker's self, as a plain object. */
const self = {
  Scheme: withScheme ? globalThis.Scheme : null,
  L: withScheme ? globalThis.L : null,
  Rope: globalThis.Rope,
  JOBS: Object.create(null),
  onmessage: null,
  postMessage: (m, transfer) => parentPort.postMessage(m, transfer),
  importScripts() { throw new Error('a thread of edwind loads its jobs from jobs.mts, not from a URL'); },
};
for (const [name, fn] of Object.entries(jobs)) if (typeof fn === 'function') self.JOBS[name] = fn;
codecModule(self);
if (withScheme) workerPrims(self);
workerMain(self, limits);
parentPort.on('message', data => self.onmessage({ data }));
