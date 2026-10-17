/* The named JS jobs of edwind's worker pool (R4.47, R15.3).

   In the browser pool.js ships a job to its workers as source text: EdPool.define(name, fn, deps) joins
   fn.toString() into the blob each worker is built from. edwind runs with code generation from strings
   disabled, so a worker is a file (worker.mts) that imports this module, and a job runs on a thread only
   when it is exported here under the name EdPool.run and EdPool.map use. EdPool.define(name, fn) in edwind
   accepts an exported name (FN is then the main-thread version, used when the pool is off), accepts a
   name in LOCAL_ONLY as a main-thread job, and refuses any other name: no function's source crosses to a
   thread. Every export here is registered with the pool when pool.js loads, so a job needs no define call.

   A job is (args, ctx) => value and must be pure: nothing from the editor, the process or the file system.
   ctx.buffer(id) is the text of a buffer the caller passed (opts.buffers, or a buffer in ARGS), ctx.rope(id)
   its rope (text.js), ctx.version(id) its version, ctx.args the shared args of a map, ctx.state a Map kept
   per thread, ctx.worker the thread index, ctx.progress(x) reports to the caller, ctx.scheme is { S, L } on
   a thread that runs Scheme, ctx.transfer(ab) marks an ArrayBuffer to move instead of copy. Arguments and
   results cross by structured clone (plain data, typed arrays, Map, RegExp); typed arrays up to two levels
   deep in the result are transferred.

   Adding a job from another server module: write it in its own file, say edwin/server/notes-job.mts, and
   add one line to the list at the end of this file:
       export * from './notes-job.mts';
   A name that is not an identifier is exported as a string: export { parseNote as 'notes-parse' };
   Then EdPool.run('notes-parse', args, opts) resolves to the value (a promise with .cancel()), and
   EdPool.map('notes-parse', items, opts) to the list of values, split over the threads.

   The jobs below are the pool's own, the same code as the define(...) calls in pool.js keep for the
   browser's workers and for the main thread; pool.test.mts checks that a thread and the main thread agree.
   Keep the two in step. */

/* What a job gets besides its arguments (see above); A is the type of the shared args of a map. */
export interface JobCtx<A = unknown> {
  buffer(id: string): string;
  rope(id: string): unknown;
  version(id: string): number;
  args: A;
  state: Map<string, unknown>;
  worker: number;
  progress(x: unknown): void;
  scheme: { S: unknown; L: unknown } | null;
  transfer(ab: ArrayBuffer): void;
}
export interface WordIndex { n: number; words: string; lower: string; off: Int32Array; loff: Int32Array }

/* Word index of text T: the distinct words (SRC repeated 3 or more times, as scanWords does, in text
   order up to CAP words), sorted by their lowercase form. Kept as two joined strings with offsets
   so it crosses threads as three flat objects instead of 50,000 strings. */
function wordIndex(t: string, src: string, cap: number): WordIndex {
  const rx = new RegExp(src + '{3,}', 'gu'), set = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = rx.exec(t)) && set.size < cap) set.add(m[0]);
  const arr: [string, string][] = [];
  for (const w of set) arr.push([w.toLowerCase(), w]);
  arr.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const n = arr.length, off = new Int32Array(n + 1), loff = new Int32Array(n + 1);
  let words = '', lower = '';
  for (let i = 0; i < n; i++) { lower += arr[i][0]; words += arr[i][1]; loff[i + 1] = lower.length; off[i + 1] = words.length; }
  return { n, words, lower, off, loff };
}
/* Indices of the items that match every term ([source, flags] pairs). */
function filterItems(items: string[], terms: [string, string][]): Int32Array {
  const res = terms.map(([s, f]) => new RegExp(s, f)), out: number[] = [];
  for (let i = 0; i < items.length; i++) { let ok = true; for (const r of res) if (!r.test(items[i])) { ok = false; break; } if (ok) out.push(i); }
  return Int32Array.from(out);
}

/* The word index of buffer A.id (words of the character class A.src, at most A.cap of them). */
export function words(a: { id: string; src: string; cap: number }, ctx: JobCtx): WordIndex { return wordIndex(ctx.buffer(a.id), a.src, a.cap); }
/* Keep the candidate list A.items on this thread under A.key, for filter. */
export function list(a: { key: string; items: string[] }, ctx: JobCtx): boolean { ctx.state.set('list:' + a.key, a.items); return true; }
/* Forget the candidate list A.key. */
export function unlist(a: { key: string }, ctx: JobCtx): boolean { ctx.state.delete('list:' + a.key); return true; }
/* Indices of the items of list A.key matching every term of A.terms ([source, flags] pairs). */
export function filter(a: { key: string; terms: [string, string][] }, ctx: JobCtx): Int32Array { return filterItems((ctx.state.get('list:' + a.key) as string[] | undefined) || [], a.terms); }
/* Syntax classes and paren depths of the Lisp buffer A.id. The lexer (lex, markDocstrings, parenDepths)
   is editor-core.js's, which worker.mts installs in the thread's global scope from Ed.LEX_SOURCE; the
   main thread runs pool.js's own version of this job against Ed.lex. */
/* The lexer's functions as worker.mts installs them in the thread's global scope. */
interface LexRealm {
  markDocstrings?: (t: string, cls: unknown) => unknown;
  lex?: (t: string) => unknown;
  parenDepths?: (t: string, cls: unknown, from: number, to: number, depth: number) => unknown;
}
export function lex(a: { id: string }, ctx: JobCtx): { cls: unknown; d: unknown } {
  const g = globalThis as typeof globalThis & LexRealm;
  if (typeof g.markDocstrings !== 'function' || typeof g.lex !== 'function' || typeof g.parenDepths !== 'function') throw new Error('lex: the lexer is not loaded in this thread');
  const t = ctx.buffer(a.id), cls = g.markDocstrings(t, g.lex(t));
  return { cls, d: g.parenDepths(t, cls, 0, t.length, 0) };
}
/* Matches of a regexp (ctx.args: source, flags, max) in a buffer, a shard of one, or a text: five numbers
   per hit (index, line, column, line start, line end). */
export interface GrepArgs { source: string; flags: string; max: number }
export function grep(it: { text?: string; id?: string; from?: number; to?: number }, ctx: JobCtx<GrepArgs>): { hits: Int32Array; truncated: boolean } {
  const t = it.text !== undefined ? it.text : ctx.buffer(it.id!), re = new RegExp(ctx.args.source, ctx.args.flags.includes('g') ? ctx.args.flags : ctx.args.flags + 'g');
  const hits: number[] = []; let m: RegExpExecArray | null, n = 0, line = 1, nlPos = 0;
  re.lastIndex = it.from || 0; const end = it.to === undefined ? t.length : it.to;
  while ((m = re.exec(t)) && m.index < end && n < ctx.args.max) {
    for (let k = t.indexOf('\n', nlPos); k >= 0 && k < m.index; k = t.indexOf('\n', nlPos)) { line++; nlPos = k + 1; }
    const ls = t.lastIndexOf('\n', m.index - 1) + 1, le = t.indexOf('\n', m.index);
    hits.push(m.index, line, m.index - ls, ls, le < 0 ? t.length : le); n++;
    if (m[0] === '') re.lastIndex++;
  }
  return { hits: Int32Array.from(hits), truncated: n >= ctx.args.max };
}

/* Jobs the core's browser files define by source (evil-ex.js subst, org.js org-parse, stack.js
   project-grep, ai.js gptel-grep) and no file here provides: in edwind they run on the main thread, as
   when the pool is off. To move one to the threads, write it in a server file, export it above and take
   its name off this list. */
export const LOCAL_ONLY = ['subst', 'org-parse', 'project-grep', 'gptel-grep'];

/* Jobs of other server modules, one line each, added by their owners:
   export * from './notes-job.mts'; */
