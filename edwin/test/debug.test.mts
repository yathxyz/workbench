// The debugger, the inspector and introspection of the server image (spec §4.7 R4.35, R4.37; §4.9 R4.48,
// R4.50), against a real edwind: a frame's failing call suspends its thread, *Backtrace* shows restarts and
// locals, forms evaluate in a frame's environment, restarts and continue resume the thread, abort ends it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeDir, startEdwind, stopEdwind, EditClient } from './edit-client.mts';

let dir, child;
before(async () => { dir = makeDir(); child = await startEdwind(dir); });
after(async () => { await stopEdwind(child); fs.rmSync(dir.root, { recursive: true, force: true }); });
const client = async (opts) => { const c = new EditClient(dir.cfg.socket, opts); await c.connect(); const w = await c.hello(); assert.equal(w.t, 'welcome'); return c; };
const value = async (c, form) => { const r = await c.form(form); assert.equal(r.error, undefined, JSON.stringify(r.error)); return r.value; };
const BT = 'name:*Backtrace*';

test('R4.35 a frame call that signals suspends in the debugger: *Backtrace* shows the report, restarts, frames and locals; e evaluates in a frame; q aborts', async () => {
  const f = await client({ kind: 'frame' });
  assert.equal(await value(f, '(define (bad x) (+ 1 (car x)))'), 'bad', 'car is not in tail position, so bad\'s frame is live');
  const rid = f.newRid();
  f.send({ t: 'call', rid, form: '(bad 5)', ctx: {} });
  const d = await f.next(m => m.t === 'display');
  assert.equal(d.buf, BT);
  const o = await f.open(BT);
  assert.match(o.text, /Debugger entered: wrong-type-argument/);
  assert.match(o.text, /0: \[abort\] Abort the command\./);
  assert.match(o.text, /\n  0:  \(car\) at :1/); assert.match(o.text, /\n  1:  \(bad x=5\)/);
  const state = (await f.call('debugger-state')).value;
  assert.equal(state.sessions.length, 1); assert.equal(state.sessions[0].condition, 'wrong-type-argument'); assert.equal(state.sessions[0].continuable, false);
  const frames = (await f.call('debugger-frames')).value;
  assert.equal(frames[0].name, 'car'); assert.equal(frames[1].name, 'bad'); assert.deepEqual(frames[1].locals, { x: '5' });
  assert.equal((await f.call('debugger-eval', [1, '(+ x 1)'])).value, '6', 'e: the form sees the frame\'s locals');
  /* The backtrace-mode keys are server commands reading the frame number at point. */
  const line = o.text.indexOf('  1:  (bad');
  const r = await f.request({ t: 'call', cmd: 'debugger-show-locals', args: [], ctx: { point: line + 3 }, buf: BT });
  assert.equal(r.msg, 'x = 5');
  /* Other clients are served while the thread is parked; the thread holds nothing and still exists. */
  const c = await client();
  assert.equal(await value(c, '(+ 2 2)'), '4');
  assert.equal((await c.call('thread-list')).value.filter(t => t.state === 'suspended').length, 1);
  assert.equal((await c.call('status')).value.debugger, 1);
  /* q: abort. The call's result arrives as the aborted condition. */
  assert.equal((await f.call('debugger-abort')).value, 'abort');
  const res = await f.next(m => m.rid === rid && m.t === 'result');
  assert.equal(res.error.condition, 'aborted');
  assert.equal((await f.call('debugger-state')).value.sessions.length, 0);
  assert.equal(await value(f, '(+ 1 1)'), '2', 'the frame goes on');
  f.close(); c.close();
});

test('R4.33, R4.35 restarts: use-value on an unbound variable resumes the computation with the value', async () => {
  const f = await client({ kind: 'frame' });
  const rid = f.newRid();
  f.send({ t: 'call', rid, form: '(+ 1 no-such-variable)', ctx: {} });
  await f.next(m => m.t === 'display');
  const state = (await f.call('debugger-state')).value;
  assert.equal(state.sessions[0].condition, 'unbound-variable');
  const names = state.sessions[0].restarts.map(r => r.name);
  assert.ok(names.includes('use-value') && names.includes('store-value') && names.includes('abort'), names.join(','));
  assert.equal((await f.call('debugger-restart', [names.indexOf('use-value'), null, [41]])).value, 'use-value');
  assert.equal((await f.next(m => m.rid === rid && m.t === 'result')).value, '42');
  f.close();
});

test('R4.35 c continues a continuable condition with a value; the frame\'s C-g (interrupt) quits a suspended thread', async () => {
  const f = await client({ kind: 'frame' });
  const rid = f.newRid();
  f.send({ t: 'call', rid, form: '(+ 1 (raise-continuable (quote oops)))', ctx: {} });
  await f.next(m => m.t === 'display');
  assert.equal((await f.call('debugger-state')).value.sessions[0].continuable, true);
  assert.equal((await f.call('debugger-continue', [41])).value, true);
  assert.equal((await f.next(m => m.rid === rid && m.t === 'result')).value, '42');
  const rid2 = f.newRid();
  f.send({ t: 'call', rid: rid2, form: '(error "stuck")', ctx: {} });
  await f.next(m => m.t === 'display');
  f.send({ t: 'interrupt', rid: rid2 });
  assert.equal((await f.next(m => m.rid === rid2 && m.t === 'result')).error.condition, 'quit');
  assert.equal((await f.call('debugger-state')).value.sessions.length, 0);
  f.close();
});

test('R13.10, R4.35 cli calls and background threads never suspend; debug-on-error nil turns the debugger off for frames', async () => {
  const c = await client(), f = await client({ kind: 'frame' });
  const r = await c.form('(car 5)');
  assert.equal(r.error.condition, 'wrong-type-argument');
  assert.equal((await c.form('(thread-join (make-thread (lambda () (car 5))))')).error.condition, 'thread-died');
  assert.equal((await c.call('debugger-state')).value.sessions.length, 0);
  await value(f, '(set! debug-on-error #f)');
  assert.equal((await f.form('(car 5)')).error.condition, 'wrong-type-argument', 'reported, not suspended');
  await f.form('(set! debug-on-error #t)');
  c.close(); f.close();
});

test('R4.50 the inspector walks lists, vectors, records, hash tables, buffers and threads', async () => {
  const f = await client({ kind: 'frame' });
  const r = await f.call('inspect', ['(list 1 (vector 2 3) (quote (a . b)))']);
  assert.equal(r.value.title, 'a list of 3');
  const o = await f.open('name:*Inspector*');
  assert.match(o.text, /Inspecting a list of 3/); assert.match(o.text, /\n  1:  1 +#\(2 3\)/);
  await value(f, '(%inspect-nth 1)');
  assert.equal(await value(f, '(inspector-object)'), '#(2 3)');
  await value(f, '(%inspect-pop)');
  assert.equal(await value(f, '(inspector-object)'), '(1 #(2 3) (a . b))');
  assert.equal(await value(f, '(define-record-type point (make-point x y) point? (x point-x) (y point-y)) (inspect (make-point 1 2)) (length (debugger-sessions))'), '0');
  const o2 = await f.open('name:*Inspector*');
  assert.match(o2.text, /Inspecting a record of type point/); assert.match(o2.text, /x +1\n/); assert.match(o2.text, /y +2\n/);
  await value(f, '(inspect (current-buffer))');
  assert.match((await f.open('name:*Inspector*')).text, /Inspecting the buffer .*\n[\s\S]*size/);
  await value(f, '(inspect (current-thread))');
  assert.match((await f.open('name:*Inspector*')).text, /Inspecting the thread \d+ \(call\)/);
  f.close();
});

test('R4.50 apropos, find-definition, room, list-threads and list-clients', async () => {
  const f = await client({ kind: 'frame' });
  const ap = (await f.call('apropos-list', ['^thread-'])).value;
  assert.ok(ap.some(x => x.name === 'thread-join' && x.kind === 'function' && x.where === 'server'), JSON.stringify(ap.slice(0, 3)));
  await f.request({ t: 'call', cmd: 'apropos', args: ['^mailbox'], ctx: {} });
  assert.match((await f.open('name:*Apropos*')).text, /mailbox-receive! +function +server/);
  const fd = (await f.call('definition-of', ['make-thread'])).value;
  assert.equal(fd.kind, 'primitive'); assert.equal(fd.file, 'edwin/server/threads.mts'); assert.ok(fd.line > 0);
  assert.equal((await f.call('definition-of', ['car'])).value.file, 'edwin/src/scheme.js');
  assert.equal((await f.call('definition-of', ['caar'])).value.file, 'edwin/src/scheme.js', 'defined in a loop: the file, no line');
  await value(f, '(define (my-proc a) (+ a 1))');
  const fd2 = (await f.call('definition-of', ['my-proc'])).value;
  assert.equal(fd2.kind, 'procedure');
  const room = (await f.call('room-info')).value;
  assert.match((await f.request({ t: 'call', cmd: 'room', args: [], ctx: {} })).msg, /^Heap [\d.]+ of/);
  assert.ok(room.heapUsedMiB > 0 && room.buffers > 0 && typeof room.journalBytes === 'number');
  await f.request({ t: 'call', cmd: 'list-threads', args: [], ctx: {} });
  assert.match((await f.open('name:*Threads*')).text, /\d+ threads?[\s\S]*list-threads/);
  await f.request({ t: 'call', cmd: 'list-clients', args: [], ctx: {} });
  assert.match((await f.open('name:*Clients*')).text, /1 client[\s\S]*frame/);
  assert.equal((await f.call('client-list')).value.length, 1);
  assert.match(await value(f, '(describe-function (quote make-thread)) (with-current-buffer "*Help*" (buffer-string))'), /runs on the server/, 'describe-function shows where (R4.48)');
  f.close();
});

test('R4.48 the primitive registry: every JS primitive with arity, documentation, where and source; no JS escape hatch (R16.15)', async () => {
  const c = await client();
  const prims = (await c.call('primitives')).value;
  assert.ok(prims.length > 500, String(prims.length));
  const by = Object.fromEntries(prims.map(p => [p.name, p]));
  assert.equal(by.car.where, 'both'); assert.match(by.car.source, /^edwin\/src\/scheme\.js:\d+$/); assert.equal(by.car.args, 'p');
  assert.equal(by['make-thread'].where, 'server'); assert.equal(by['thread-join'].blocking, true);
  assert.equal(by['notes-query'].where, 'server');
  for (const p of prims) { assert.ok(typeof p.name === 'string' && ['server', 'frame', 'both'].includes(p.where), p.name); assert.doesNotMatch(p.name, /js-eval|javascript|js->|->js|eval-js|new-function/i); }
  const missing = prims.filter(p => !p.source).map(p => p.name);
  assert.equal(missing.length, 0, 'every primitive has a source (R4.48): missing ' + missing.slice(0, 20).join(' '));
  assert.equal(await (async () => (await c.form('(primitive-where (quote make-thread))')).value)(), 'server');
  assert.equal((await c.form('(primitive-where (quote car))')).value, 'both');
  c.close();
});
