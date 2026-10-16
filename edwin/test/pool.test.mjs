// The worker pool on the Node host (R4.47, R15.3): `node --test edwin/test/pool.test.mjs`, plain and under
// edwind's flag (`node --disallow-code-generation-from-strings --test ...`).
//
// Edwin boots headless as edwind does (host-node.js), with threads from edwin/server/worker.mjs running the
// named jobs of edwin/server/jobs.mjs and the Scheme futures of pool.js. One Edwin per process, so the cases
// run in order; the pool-off switch is checked in a child process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startEdwin, createHost } from './headless.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { workerCount } = require('../src/host-node.js');
const jobs = await import('../server/jobs.mjs');

const ed = await startEdwin();
const P = globalThis.EdPool;
let n = 0;
async function fresh(text, ext = 'txt') {
  await ed.type(`:e p${++n}.${ext}\n`);
  assert.equal(ed.text(), '');
  if (text) { ed.Ed.insertText(ed.E.current, text); ed.E.current.pt = 0; }
  return ed.E.current;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (pred, ms = 5000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(10); } };
const SRC = '[A-Za-z]';
/* A future is a thenable, not a Promise: assert.rejects wants the latter. */
const pr = x => Promise.resolve(x);

test('the thread count is min(6, CPUs - 1), at least 1 (R4.47)', () => {
  const cpus = os.availableParallelism();
  assert.equal(workerCount(), Math.min(6, Math.max(1, cpus - 1)));
  assert.equal(ed.host.workerCount, workerCount());
  assert.equal(P.size, workerCount());
  assert.equal(ed.eval('thread-pool-size'), workerCount());
});

test('the host runs the pool from a file: threads boot and run Scheme', async () => {
  assert.equal(ed.host.workers, true);
  assert.equal(P.ok, true);
  assert.equal(await P.ready, true);
  assert.ok(P.alive >= 1);
  assert.equal(P.stats().scheme, 'yes');
  assert.equal(P.scheme, true);
  assert.equal(ed.eval('(thread-pool-ok?)'), true);
  assert.ok(ed.eval('(thread-count)') >= 1);
});

test('the flags in effect: code generation from strings is off when the suite asks for it (R14.11)', () => {
  if (process.execArgv.includes('--disallow-code-generation-from-strings')) assert.throws(() => new Function('return 1'), EvalError);
  else assert.equal(new Function('return 1')(), 1);
});

test('every job of jobs.mjs is registered without a define call; the core\'s own are too', () => {
  const defs = new Set(P.stats().defs);
  for (const [k, v] of Object.entries(jobs)) if (typeof v === 'function') assert.ok(defs.has(k), k);
  for (const k of ['words', 'list', 'unlist', 'filter', 'lex', 'grep']) assert.ok(defs.has(k), k);
  for (const k of jobs.LOCAL_ONLY) assert.ok(defs.has(k), k + ' (main thread only)');
});

test('run(words): a thread and the main-thread fallback agree, and so does pool.js\'s own wordIndex', async () => {
  const text = 'hello world hello there worldly\nHello again, worldly words and more words';
  const b = await fresh(text);
  const args = { id: b.id, src: SRC, cap: 50000 };
  const p = P.run('words', args, { buffers: [b] });
  assert.equal(typeof p.then, 'function');
  assert.equal(typeof p.cancel, 'function');
  const got = await p;
  const want = P.local('words', args, [b]);
  assert.deepEqual(got, want);
  assert.deepEqual(got, P.wordIndex(text, SRC, 50000));
  assert.ok(got.off instanceof Int32Array);
  assert.equal(got.n, 9);   /* words of three or more letters, case kept: hello Hello world worldly there again words and more */
  assert.ok(p.versions instanceof Map);
  assert.equal(p.versions.get(b.id), b.ver);
});

test('run(grep) over a buffer, through map: the same hits as the main thread, typed arrays transferred', async () => {
  const text = 'alpha beta\ngamma alpha\n\nALPHA delta alpha';
  const b = await fresh(text);
  const res = await P.grep('alpha', 'gi', [b], 1000);
  assert.equal(res.length, 1);
  assert.equal(res[0].target, b);
  assert.ok(res[0].hits instanceof Int32Array);
  const local = P.local('grep', { id: b.id }, [b], { source: 'alpha', flags: 'gi', max: 1000 });
  assert.deepEqual(res[0].hits, local.hits);
  assert.equal(res[0].hits.length / 5, 4);
  assert.deepEqual([...res[0].hits].filter((x, i) => i % 5 === 1), [1, 2, 4, 4]);
  assert.equal(res[0].truncated, false);
});

test('list and filter keep a candidate list on one thread', async () => {
  const items = ['apple pie', 'banana split', 'apple tart', 'cherry', 'pineapple'];
  const terms = [/apple/, /p/];
  const got = await P.filterAsync(items, terms);
  assert.deepEqual(got, P.filterItems(items, terms.map(r => [r.source, r.flags])));
  assert.deepEqual([...got], [0, 2, 4]);
  P.unlist(items);
});

test('(thread-run (lambda () (+ 1 2))) is a future whose value is 3', async () => {
  const f = ed.eval('(define f1 (thread-run (lambda () (+ 1 2)))) f1');
  assert.equal(ed.eval('(future? f1)'), true);
  assert.equal(await f, 3);
  assert.equal(ed.eval('(future-value f1)'), 3);
  assert.equal(ed.eval('(future-done? f1)'), true);
  assert.equal(ed.eval('(future-status f1)').name, 'done');
  assert.equal(ed.eval('(future-error f1)'), false);
});

test('closure conversion ships free variables; (future ...) and thread-eval work; handlers run', async () => {
  assert.equal(await ed.eval('(let ((k 10)) (thread-run (lambda (x) (+ x k)) 5))'), 15);
  assert.equal(await ed.eval('(future (string-append "a" "b"))'), 'ab');
  assert.equal(ed.L.write(await ed.eval("(thread-eval '(map (lambda (x) (* 2 x)) (list 1 2 3)))")), '(2 4 6)');
  const f = ed.eval('(define got #f) (define f2 (thread-run (lambda () 5))) (future-then f2 (lambda (v) (set! got (* v 2)))) f2');
  assert.equal(await f, 5);
  assert.equal(ed.eval('got'), 10);
});

test('parallel-map over a list, in order, and parallel-filter', async () => {
  assert.equal(ed.L.write(await ed.eval("(parallel-map (lambda (x) (* x x)) '(1 2 3 4 5 6 7 8 9 10) 2)")), '(1 4 9 16 25 36 49 64 81 100)');
  assert.equal(ed.L.write(await ed.eval("(parallel-filter odd? '(1 2 3 4 5 6 7))")), '(1 3 5 7)');
  assert.equal(await ed.eval("(parallel-reduce + '(1 2 3 4 5 6 7 8 9 10) 0 3)"), 55);
});

test('a buffer crosses as a mirror: the thread reads its text, and reports the version it saw', async () => {
  const b = await fresh('one\ntwo\nthree');
  assert.equal(await ed.eval('(thread-run (lambda (b) (buffer-string b)) (current-buffer))'), 'one\ntwo\nthree');
  assert.equal(await ed.eval('(thread-run (lambda () (buffer-line-count)) :buffers (list (current-buffer)))'), 3);
  const f = ed.eval('(define f3 (thread-run (lambda (b) (buffer-substring 5 8 b)) (current-buffer))) f3');
  assert.equal(await f, 'two');
  assert.equal(ed.L.write(ed.eval('(map cdr (future-versions f3))')), '(' + b.ver + ')');
  assert.equal(ed.L.write(await ed.eval('(thread-run (lambda () (list (in-thread?) (integer? (thread-id)))))')), '(#t #t)');
});

test('define-threaded and thread-broadcast define in every thread; output lands in *Messages*', async () => {
  ed.eval('(define-threaded (sq x) (* x x))');
  assert.equal(await ed.eval('(thread-run (lambda () (sq 7)))'), 49);
  await ed.eval("(thread-broadcast '(define bc 11))");
  assert.equal(await ed.eval('(thread-run (lambda () (+ bc 1)))'), 12);
  await ed.eval('(thread-run (lambda () (display "from-a-thread") 1))');
  assert.match(ed.Ed.getBuffer('*Messages*').text, /\[thread \d+\] from-a-thread/);
});

test('an error on a thread comes back as the condition, with its kind', async () => {
  const f = ed.eval('(define f4 (thread-run (lambda () (car 1)))) f4');
  await assert.rejects(pr(f), e => e.kind === 'wrong-type-argument');
  assert.equal(ed.eval('(future-failed? f4)'), true);
  assert.equal(ed.eval('(error-kind (future-error f4))').name, 'wrong-type-argument');
  assert.equal(await ed.eval('(guard (e (#t (error-kind e))) (future-value f4))'), ed.L.intern('wrong-type-argument'));
});

test('define: an exported name is accepted, a LOCAL_ONLY name runs on the main thread, any other raises (R15.3)', async () => {
  P.define('words', (a, ctx) => P.wordIndex(ctx.buffer(a.id), a.src, a.cap));
  assert.throws(() => P.define('not-a-job', a => a), /not shipped to a thread.*jobs\.mjs/);
  assert.throws(() => P.define('not-a-job', a => a, []), /export the job as "not-a-job"/);
  assert.ok(!P.stats().defs.includes('not-a-job'));
  P.define('subst', it => ({ out: 'main thread ' + it.x }));
  assert.deepEqual(await P.run('subst', { x: 1 }), { out: 'main thread 1' });
  assert.deepEqual(await P.map('subst', [{ x: 2 }, { x: 3 }]), [{ out: 'main thread 2' }, { out: 'main thread 3' }]);
  await assert.rejects(P.run('no-such-job', {}), /no such job/);
});

test('a thread that dies is replaced: its job fails with thread-died, the slot comes back and runs again', async () => {
  await P.ready;
  const s = P._slots.find(s => s && s.ready && !s.busy);
  assert.ok(s, 'a ready slot');
  const k = s.k, crashes = P.stats().crashes;
  const f = ed.eval(`(thread-run (lambda () (let loop ((i 0)) (if (< i 1e12) (loop (+ i 1)) i))) :worker ${k} :timeout 30)`);
  await until(() => P.stats().busy.includes(k));
  s.w.thread.terminate();   /* the thread under the slot, as a crash of the thread would */
  await assert.rejects(pr(f), e => e.kind === 'thread-died');
  await until(() => P._slots[k] && P._slots[k].ready);
  assert.equal(P.stats().crashes, crashes + 1);
  assert.equal(P._slots[k].dead, false);
  assert.equal(await ed.eval(`(thread-run (lambda () (* 6 7)) :worker ${k})`), 42);
});

test('a job cancelled while it runs restarts its thread; the pool stays whole', async () => {
  const f = ed.eval('(define f5 (thread-run (lambda () (let loop ((i 0)) (if (< i 1e12) (loop (+ i 1)) i))) :timeout 30)) f5');
  await until(() => P.stats().busy.length > 0);
  assert.equal(ed.eval('(future-cancel f5)'), true);
  await assert.rejects(pr(f), e => e.kind === 'thread-cancelled');
  assert.equal(ed.eval('(future-cancelled? f5)'), true);
  assert.equal(await ed.eval('(thread-run (lambda () 1))'), 1);
});

test('deep recursion on a thread raises and leaves the thread alive (R4.34 on a thread)', async () => {
  const alive = P.alive;
  await assert.rejects(pr(ed.eval('(thread-run (lambda () (let loop ((i 0)) (if (< i 1000000) (+ 1 (loop (+ i 1))) 0))))')), e => /recursion-depth|error/.test(e.kind));
  assert.equal(await ed.eval('(thread-run (lambda () (let loop ((i 0)) (if (< i 3000) (+ 1 (loop (+ i 1))) 0))))'), 3000);
  assert.ok(P.alive >= Math.min(alive, 1));
  assert.ok(P._slots.every(s => !s || !s.dead));
});

test('a timeout stops a Scheme job', async () => {
  await assert.rejects(pr(ed.eval('(thread-run (lambda () (let loop () (loop))) :timeout 0.5)')), e => e.kind === 'thread-timeout');
  assert.equal(await ed.eval('(thread-run (lambda () 2))'), 2);
});

test('with host.workers false the pool is off: every path runs on the main thread', () => {
  const headless = fileURLToPath(new URL('./headless.mjs', import.meta.url));
  const src = `
    import { startEdwin } from ${JSON.stringify(headless)};
    const ed = await startEdwin({ workers: false });
    const P = globalThis.EdPool;
    const out = { workers: ed.host.workers, ok: P.ok, scheme: P.scheme, three: await ed.eval('(thread-run (lambda () (+ 1 2)))'),
      pm: ed.L.write(await ed.eval("(parallel-map (lambda (x) (* x x)) '(1 2 3))")), poolOk: ed.eval('(thread-pool-ok?)'), count: ed.eval('(thread-count)') };
    try { await P.run('words', { id: 0, src: '[a-z]', cap: 10 }); out.run = 'resolved'; } catch (e) { out.run = e.kind; }
    await ed.type(':e off.txt\\n'); ed.Ed.insertText(ed.E.current, 'aaa bbb aaa');
    out.local = (await P.run('words', { id: ed.E.current.id, src: '[a-z]', cap: 10 }, { buffers: [ed.E.current], fallback: 'local' })).n;
    try { P.define('not-a-job', a => a); out.define = 'accepted'; } catch (e) { out.define = 'raised'; }
    console.log(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, [...process.execArgv.filter(a => !a.startsWith('--test')), '--input-type=module', '-e', src], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(out, { workers: false, ok: false, scheme: false, three: 3, pm: '(1 4 9)', poolOk: false, count: 0, run: 'no-worker', local: 2, define: 'raised' });
});

test('createHost: the worker switch, the job table and the thread factory are the host\'s (R4.1)', () => {
  const h = createHost({ workers: false });
  assert.equal(h.workers, false);
  assert.equal(typeof h.makeWorker, 'function');
  assert.ok(h.jobs.fns.has('words'));
  assert.ok(h.jobs.localOnly.has('subst'));
  assert.equal(h.workerCount, workerCount());
});
