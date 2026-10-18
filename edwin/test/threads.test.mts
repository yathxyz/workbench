// The scheduler of the server image (spec §4.8: R4.38–R4.42, R4.46; §4.6: R4.27–R4.29): threads, blocking
// calls, deadlines, held buffers, ask and answer, interrupt, timers and server commands, against a real edwind.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Scheduler } from '../server/threads.mts';
import { makeDir, startEdwind, stopEdwind, EditClient } from './edit-client.mts';
import type { Msg, TestDir, EdwindChild, ClientOptions } from './edit-client.mts';
import type { Server } from '../server/main.mts';
import { loadSchemeIn, SCHEME_SOURCE } from './scheme-load.mts';

let dir: TestDir, child: EdwindChild;
before(async () => { dir = makeDir(); child = await startEdwind(dir); });
after(async () => { await stopEdwind(child); fs.rmSync(dir.root, { recursive: true, force: true }); });
const client = async (opts?: ClientOptions) => { const c = new EditClient(dir.cfg.socket, opts); await c.connect(); const w = await c.hello(); assert.equal(w.t, 'welcome'); return c; };
const note = (name: string, text: string) => { fs.writeFileSync(path.join(dir.dirs.notes, name), text); return name; };
const value = async (c: EditClient, form: string) => { const r = await c.form(form); assert.equal(r.error, undefined, JSON.stringify(r.error)); return r.value; };
const spin = (ms: number) => `(let ((end (+ (current-time) ${ms / 1000}))) (let loop () (if (< (current-time) end) (loop))))`;

test('R4.40 a waiter that times out or is killed leaves the queue: the next unlock or send wakes the live waiter', async () => {
  const c = await client();
  /* A timed mutex-lock! expires while a second thread still waits; the unlock must wake that one. */
  assert.equal(await value(c, '(define m (make-mutex)) (mutex-lock! m) (define t-timed (make-thread (lambda () (mutex-lock! m 0.05)) "timed")) (define t-live (make-thread (lambda () (mutex-lock! m 5) (quote got)) "live")) (thread-yield) (define r1 (thread-join t-timed)) (mutex-unlock! m) (list r1 (thread-join t-live 1))'), '(#f got)');
  /* A timed mailbox-receive! returns its default; the send then reaches the receiver still waiting. */
  assert.equal(await value(c, '(define mb (make-mailbox)) (define r-timed (make-thread (lambda () (mailbox-receive! mb 0.05 (quote none))) "rt")) (define r-live (make-thread (lambda () (mailbox-receive! mb 5)) "rl")) (thread-yield) (define a (thread-join r-timed)) (mailbox-send! mb (quote msg)) (list a (thread-join r-live 1))'), '(none msg)');
  /* A killed waiter leaves the queue too. */
  assert.equal(await value(c, '(define m2 (make-mutex)) (mutex-lock! m2) (define k (make-thread (lambda () (mutex-lock! m2)) "k")) (define l (make-thread (lambda () (mutex-lock! m2) (quote l-got)) "l")) (thread-yield) (thread-kill k) (thread-yield) (mutex-unlock! m2) (thread-join l 1)'), 'l-got');
  c.close();
});

test('R4.40 a thread that ends holding a mutex releases it and wakes the next waiter', async () => {
  const c = await client();
  const t0 = Date.now();
  assert.equal(await value(c, '(define m3 (make-mutex)) (define holder (make-thread (lambda () (mutex-lock! m3) (thread-sleep! 0.05) (quote held)) "holder")) (thread-yield) (define waiter (make-thread (lambda () (mutex-lock! m3 3)) "waiter")) (list (thread-join holder 2) (thread-join waiter 5) (mutex-owner m3))'), '(held #t #f)');
  assert.ok(Date.now() - t0 < 2000, 'the waiter was woken, not timed out');
  assert.equal(await value(c, '(+ 1 2)'), '3', 'the scheduler still runs');
  c.close();
});

test('R4.40 make-thread, mailboxes and thread-join; a background thread is preempted and killed', async () => {
  const c = await client();
  assert.equal(await value(c, '(define mb (make-mailbox)) (define t1 (make-thread (lambda () (thread-sleep! 0.05) (mailbox-send! mb (quote hi)) 42) "t1")) (list (mailbox-receive! mb 1) (thread-join t1) (thread-alive? t1))'), '(hi 42 #f)');
  assert.equal(await value(c, '(define spinner (make-thread (lambda () (let loop () (loop))) "spinner")) (thread-name spinner)'), '"spinner"');
  const t0 = Date.now();
  assert.equal(await value(c, '(+ 1 2)'), '3');
  assert.ok(Date.now() - t0 < 1000, 'a spinning background thread does not block a command');
  assert.equal(await value(c, '(thread-kill spinner) (thread-yield) (list (thread-alive? spinner) (memq spinner (all-threads)))'), '(#f #f)');
  assert.equal((await c.form('(thread-join (make-thread (lambda () (error "bg boom"))))')).error.condition, 'thread-died');
  assert.equal(await value(c, '(define m (make-mutex)) (mutex-lock! m) (define t2 (make-thread (lambda () (mutex-lock! m) (quote got)))) (thread-yield) (define st (thread-state t2)) (mutex-unlock! m) (list st (thread-join t2))'), '(blocked got)');
  assert.equal(await value(c, '(with-timeout (0.05 (quote late)) (sleep-for 1) (quote done))'), 'late');
  assert.equal(await value(c, '(thread-join (make-thread (lambda () (with-mutex m (quote inside)))))'), 'inside');
  c.close();
});

test('R4.39, R4.42 a command that blocks does not block other clients; the deadline is runnable time', async () => {
  const a = await client(), b = await client();
  const t0 = Date.now();
  const pa = a.form('(sleep-for 0.3) (quote slept)');
  const rb = await b.form('(quote quick)');
  assert.equal(rb.value, 'quick'); assert.ok(Date.now() - t0 < 250, 'the other client is served while the first sleeps');
  assert.equal((await pa).value, 'slept');
  const r = await a.form('(sleep-for 2.5) (quote late)');
  assert.equal(r.value, 'late', 'sleeping does not count toward the 30 s deadline, and 2.5 s is under it anyway');
  a.close(); b.close();
});

test('R4.41, R4.28 edits by a command thread are sequenced as one batch with the caller as writer; client edits wait for the hold', async () => {
  const id = note('held.md', 'abc\n');
  const f = await client({ kind: 'frame' }), w = await client();
  const o = await f.open(id); assert.equal(o.text, 'abc\n');
  await w.open(id);
  /* Edits on behalf of frame F keep F's cid with via server (R4.28); two inserts become one batch. */
  const r = await f.request({ t: 'call', form: '(goto-char (point-max)) (insert "X") (insert "Y") (buffer-string)', ctx: { point: 1 }, buf: id });
  assert.equal(r.value, '"abc\\nXY"');
  /* The result is sent only once the batch is in the journal (R16.7): a crash right after it loses nothing. */
  const jdir = path.join(dir.dirs.state, 'buffers');
  const journal = fs.readdirSync(jdir).filter(n => n.endsWith('.jsonl')).map(n => fs.readFileSync(path.join(jdir, n), 'utf8')).find(t => JSON.parse(t.split('\n')[0]).id === id);
  assert.ok(journal && journal.split('\n').some(l => l.includes('"t":"b"') && l.includes('"XY"')), 'the thread batch is on disk when the result arrives');
  const e = await f.next(m => m.t === 'edits' && m.buf === id);
  assert.equal(e.ver, 1); assert.deepEqual(e.ops, [[4, '', 'XY']]);
  assert.equal(e.by.kind, 'frame'); assert.equal(e.by.cid, f.cid); assert.equal(e.by.via, 'server');
  const e2 = await w.next(m => m.t === 'edits' && m.buf === id); assert.deepEqual(e2.ops, [[4, '', 'XY']]);
  /* A thread that edits and keeps running holds the buffer: W's edit waits and lands after the batch. */
  const p = w.request({ t: 'call', form: `(goto-char (point-min)) (insert "1") ${spin(120)} (quote held)`, ctx: {}, buf: id });
  await new Promise(r => setTimeout(r, 30));
  const ack = await w.edit(id, 1, [[0, '', 'w']]);
  assert.equal(ack.t, 'ack'); assert.equal(ack.ver, 3, 'the held edit is sequenced after the thread batch');
  assert.equal((await p).value, 'held');
  const e3 = await f.next(m => m.t === 'edits' && m.buf === id && m.ver === 2);
  assert.deepEqual(e3.ops, [[0, '', '1']]); assert.equal(e3.by.kind, 'cli'); assert.equal(e3.by.via, 'server');
  const e4 = await f.next(m => m.t === 'edits' && m.buf === id && m.ver === 3);
  assert.deepEqual(e4.ops, [[1, '', 'w']], 'rebased through the thread batch: the sequenced insert goes left (R7.9)');
  assert.equal((await w.request({ t: 'call', form: '(buffer-string)', ctx: {}, buf: id })).value, '"1wabc\\nXY"');
  /* Holding past 250 ms of runnable time is the timeout condition; the edits made so far are still sequenced. */
  const t0 = Date.now();
  const rt = await w.request({ t: 'call', form: '(goto-char (point-max)) (insert "Z") (let loop () (loop))', ctx: {}, buf: id });
  assert.equal(rt.error.condition, 'timeout'); assert.ok(Date.now() - t0 < 1500, 'the hold timeout, not the 30 s deadline');
  const e5 = await f.next(m => m.t === 'edits' && m.buf === id && m.ver === 4);
  assert.deepEqual(e5.ops, [[8, '', 'Z']]);
  f.close(); w.close();
});

test('R4.29 read-string, completing-read and y-or-n-p ask the calling frame; quit and a cli caller', async () => {
  const f = await client({ kind: 'frame' }), c = await client();
  const rid = f.newRid();
  f.send({ t: 'call', rid, form: '(string-append "Hi " (read-string "Name: " "Yan"))', ctx: {} });
  const ask = await f.next(m => m.t === 'ask');
  assert.equal(ask.rid, rid); assert.equal(ask.kind, 'string'); assert.equal(ask.prompt, 'Name: '); assert.equal(ask.init, 'Yan');
  f.send({ t: 'answer', rid, value: 'Yanni' });
  assert.equal((await f.next(m => m.rid === rid && m.t === 'result')).value, '"Hi Yanni"');
  const rid2 = f.newRid();
  f.send({ t: 'call', rid: rid2, form: '(completing-read "Pick: " (list "alpha" "beta"))', ctx: {} });
  const ask2 = await f.next(m => m.t === 'ask'); assert.equal(ask2.kind, 'completing'); assert.deepEqual(ask2.table, ['alpha', 'beta']);
  f.send({ t: 'answer', rid: rid2, value: 'beta' });
  assert.equal((await f.next(m => m.rid === rid2 && m.t === 'result')).value, '"beta"');
  const rid3 = f.newRid();
  f.send({ t: 'call', rid: rid3, form: '(if (y-or-n-p "Sure? ") (quote yes) (quote no))', ctx: {} });
  const ask3 = await f.next(m => m.t === 'ask'); assert.equal(ask3.kind, 'y-or-n');
  f.send({ t: 'answer', rid: rid3, quit: true });
  assert.equal((await f.next(m => m.rid === rid3 && m.t === 'result')).error.condition, 'quit');
  assert.equal((await c.form('(read-string "Name: ")')).error.condition, 'user-error', 'a cli has no minibuffer to ask');
  f.close(); c.close();
});

test('R4.36 interrupt{rid} stops a running command with quit; the thread is gone', async () => {
  const f = await client({ kind: 'frame' });
  const rid = f.newRid();
  f.send({ t: 'call', rid, form: '(let loop () (loop))', ctx: {} });
  await new Promise(r => setTimeout(r, 50));
  f.send({ t: 'interrupt', rid });
  const t0 = Date.now();
  const r = await f.next(m => m.rid === rid && m.t === 'result');
  assert.equal(r.error.condition, 'quit'); assert.ok(Date.now() - t0 < 1000);
  const threads = (await f.call('thread-list')).value;
  assert.equal(threads.filter((t: Msg) => t.client === f.cid).length, 0, 'the interrupted thread is gone');
  f.close();
});

test('R4.46 timers run as background threads: run-with-timer, repeat, cancel-timer, run-with-idle-timer', async () => {
  const c = await client();
  assert.equal(await value(c, '(define hits 0) (define tm (run-with-timer 0.03 0.03 (lambda () (set! hits (+ hits 1))))) (sleep-for 0.1) (cancel-timer tm) (define seen hits) (sleep-for 0.08) (list (>= seen 2) (= hits seen) (timerp tm))'), '(#t #t #t)');
  assert.equal(await value(c, '(define idle 0) (run-with-idle-timer 0.1 #f (lambda () (set! idle (+ idle 1)))) (sleep-for 0.25) idle'), '1');
  assert.equal(await value(c, '(define at 0) (run-at-time "0.05 sec" #f (lambda (x) (set! at x)) 7) (sleep-for 0.12) at'), '7');
  c.close();
});

test('R4.27 a command declared :where server runs on the server; its interactive spec reads through ask', async () => {
  const f = await client({ kind: 'frame' });
  assert.equal(await value(f, '(define-command (greet) "Say hello from the server." (interactive) (:where (quote server)) (message "hello from the server") (quote greeted))'), 'greet');
  assert.equal(await value(f, '(command-where (quote greet))'), 'server');
  const r = await f.call('greet');
  assert.equal(r.value, 'greeted'); assert.equal(r.msg, 'hello from the server');
  assert.equal(await value(f, '(define-command (add2 a b) (interactive "nA: \\nnB: ") (:where (quote server)) (+ a b))'), 'add2');
  assert.equal((await f.call('add2', [1, 2])).value, '3');
  const rid = f.newRid();
  f.send({ t: 'call', rid, cmd: 'add2', args: [], ctx: {} });
  const a1 = await f.next(m => m.t === 'ask' && m.rid === rid); assert.equal(a1.kind, 'number'); assert.equal(a1.prompt, 'A: ');
  f.send({ t: 'answer', rid, value: '40' });
  const a2 = await f.next(m => m.t === 'ask' && m.rid === rid); assert.equal(a2.prompt, 'B: ');
  f.send({ t: 'answer', rid, value: '2' });
  assert.equal((await f.next(m => m.rid === rid && m.t === 'result')).value, '42');
  assert.equal((await f.call('no-such-command')).code, 'bad_request');
  assert.equal(await value(f, '(define-command (local-only) (interactive) 1) (command-where (quote local-only))'), 'frame');
  assert.equal((await f.call('local-only')).code, 'bad_request', 'a frame command is not a server command');
  f.close();
});

test('R15.11 status carries the event-loop lag and ack percentiles and the thread count', async () => {
  const c = await client();
  const s = (await c.call('status')).value;
  assert.ok('loopLagP95Ms' in s); assert.ok('ackP95Ms' in s); assert.equal(typeof s.threads, 'number');
  c.close();
});

test('R4.35 a thread suspended with no debugger, or whose debugger fails, is resumed by the scheduler', () => {
  /* The scheduler alone over the real evaluator; the test steps the threads itself (no pump). */
  const S = loadSchemeIn(SCHEME_SOURCE) as any; // any: the suite uses S.Suspend, which scheme-load's Scheme leaves out
  const errors: string[] = [];
  const log = { error: (ev: string) => errors.push(ev), warn() {}, info() {}, debug() {} };
  const sched = new Scheduler({ log, L: { S, resetOps() {} }, Ed: { message() {} } } as unknown as Server);
  sched.stopping = true;
  try {
    const cond = new S.SchemeError('error', 'boom', []);
    /* No debugger: the thread goes on with no value. */
    const a = sched.spawn(function* () { const v = yield new S.Suspend(cond, true); return v === undefined ? 'resumed' : v; });
    sched.step(a);
    assert.equal(a.state, 'runnable');
    sched.step(a);
    assert.equal(a.state, 'done'); assert.equal(a.result, 'resumed');
    /* A debugger that throws: the condition is delivered to the thread, and the failure is logged. */
    sched.onSuspend = () => { throw new Error('no frame to show the debugger in'); };
    const b = sched.spawn(function* () { try { yield new S.Suspend(cond, false); return 'continued'; } catch (e) { return e === cond ? 'thrown' : 'other'; } });
    sched.step(b);
    assert.equal(b.state, 'runnable'); assert.deepEqual(errors, ['debugger']);
    sched.step(b);
    assert.equal(b.state, 'done'); assert.equal(b.result, 'thrown');
  } finally { sched.lag.disable(); }
});
