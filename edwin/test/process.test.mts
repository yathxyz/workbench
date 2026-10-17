// Processes through the hub (spec §4.8: R4.43, R4.44, R4.45; R9.22; R14.12; R15.10) against a real edwind and
// a fake hub (fake-hub.mts) that speaks the hub protocol and spawns nothing: edwind never starts a process,
// every one is a pty.open on the hub socket.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeDir, startEdwind, stopEdwind, EditClient } from './edit-client.mts';
import { FakeHub } from './fake-hub.mts';
import { inputFrames, PTY_INPUT_FRAME } from '../server/hub.mts';
import { stripAnsi, newSid, exitEvent } from '../server/process.mts';

let dir, child, hub, hubPath;
before(async () => {
  dir = makeDir();
  hubPath = path.join(dir.dirs.sock, 'hub.sock');
  fs.writeFileSync(dir.file, JSON.stringify({ ...dir.cfg, hubSocket: hubPath }));
  hub = await new FakeHub(hubPath).start();
  child = await startEdwind(dir);
});
after(async () => { await stopEdwind(child); await hub.stop(); fs.rmSync(dir.root, { recursive: true, force: true }); });
const client = async (opts) => { const c = new EditClient(dir.cfg.socket, opts); await c.connect(); const w = await c.hello(); assert.equal(w.t, 'welcome'); return c; };
const value = async (c, form) => { const r = await c.form(form); assert.equal(r.error, undefined, JSON.stringify(r.error)); return r.value; };
const until = async (fn, what, ms = 10000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await new Promise(r => setTimeout(r, 25)); } };
const hubUp = c => until(async () => (await value(c, '(hub-status)')) === 'up', 'the hub to be up');

test('unit: sids, input frames, ANSI stripping and sentinel events', () => {
  for (let i = 0; i < 20; i++) assert.match(newSid(), /^ed-[a-z2-7]{16}$/, 'ed- and 16 base32 characters (R4.43)');
  assert.notEqual(newSid(), newSid());
  const big = 'x'.repeat((1 << 20) + 5) + '\u{1F600}'.repeat(300000);
  const frames = inputFrames(big);
  assert.ok(frames.length >= 3);
  assert.equal(frames.join(''), big);
  for (const f of frames) { assert.ok(Buffer.byteLength(f) <= PTY_INPUT_FRAME, 'each frame fits PTY_INPUT_FRAME'); assert.ok(!/[\ud800-\udbff]$/.test(f), 'no frame ends in a lone high surrogate'); }
  assert.equal(stripAnsi('a\x1b[31mred\x1b[0m\r\nb\x1b]0;title\x07c\x1b(Bd\x07\r'), 'ared\nbcd');
  assert.equal(exitEvent(0, null, 'exited'), 'finished\n');
  assert.equal(exitEvent(3, null, 'exited'), 'exited abnormally with code 3\n');
  assert.equal(exitEvent(null, 9, 'killed'), 'killed\n');
  assert.equal(exitEvent(null, null, 'spawn_failed'), 'failed\n');
});

test('R4.43 make-process spawns through the hub: bash -c, the ed- sid, 120x40, output in the buffer, the sentinel', async () => {
  const c = await client(); await hubUp(c);
  assert.equal(await value(c, "(define events '()) (define p (make-process :name \"hello\" :command \"echo hi\" :buffer \"*hello*\" :sentinel (lambda (p ev) (set! events (cons ev events))))) (process-name p)"), '"hello"');
  const sid = JSON.parse(await value(c, '(process-sid p)'));
  assert.match(sid, /^ed-[a-z2-7]{16}$/);
  const [open] = await hub.waitFor(r => r.t === 'pty.open' && r.sid === sid);
  assert.deepEqual(open.spawn, { argv: ['bash', '-c', 'echo hi'], shell: 'bash' }, 'bash is the default when the hub offers it; no cwd or env unless given');
  assert.equal(open.cols, 120); assert.equal(open.rows, 40);
  assert.equal(await value(c, '(process-wait p 5)'), '0');
  assert.equal(await value(c, '(list (process-status p) (process-exit-status p) (process-live-p p))'), '(exit 0 #f)');
  await until(async () => (await value(c, 'events')) !== '()', 'the sentinel');
  assert.equal(await value(c, 'events'), '("finished\\n")');
  assert.equal(await value(c, '(with-current-buffer "*hello*" (buffer-string))'), '"hi\r\\n"', 'raw output at the process mark (the writer prints CR raw); with a sentinel, no exit note is inserted');
  assert.equal(await value(c, '(define pn (make-process :name "noted" :command "echo bye" :buffer "*noted*")) (process-wait pn 5) (accept-process-output pn 1) (with-current-buffer "*noted*" (buffer-string))'), '"bye\r\\n\\nProcess noted finished\\n"', 'without a sentinel the exit note goes to the buffer');
  assert.ok(!child.logs.includes('echo hi'), 'R15.10: the command is not logged');
  c.close();
});

test('R4.43 filters run in order on background threads; accept-process-output; process-send-string and interrupt-process', async () => {
  const c = await client(); await hubUp(c);
  hub.programs.set('chunks', async io => { io.write('one '); await io.delay(10); io.write('two '); await io.delay(10); io.write('three'); return 0; });
  assert.equal(await value(c, "(define got \"\") (define pf (make-process :name \"f\" :command \"chunks\" :filter (lambda (p s) (thread-sleep! 0.02) (set! got (string-append got s))))) (process-wait pf 5)"), '0');
  await until(async () => (await value(c, 'got')) === '"one two three"', 'the filter to see every chunk in order');
  assert.equal(await value(c, '(process-status pf)'), 'exit');
  assert.equal(await value(c, '(define pc (make-process :name "cat" :command "cat" :buffer (get-buffer-create "*cat*"))) (process-send-string pc "abc\\n") (accept-process-output pc 5)'), '#t');
  const sid = JSON.parse(await value(c, '(process-sid pc)'));
  const inputs = await hub.waitFor(r => r.t === 'pty.input' && r.sid === sid);
  assert.equal(inputs[0].d, 'abc\n');
  assert.equal(await value(c, '(with-current-buffer "*cat*" (buffer-string))'), '"abc\r\\n"');
  assert.equal(await value(c, '(interrupt-process pc) (process-wait pc 5)'), '130');
  const ints = await hub.waitFor(r => r.t === 'pty.input' && r.sid === sid && r.d === '\x03');
  assert.equal(ints.length, 1, 'interrupt-process sends C-c');
  assert.equal(await value(c, '(accept-process-output pc 0.05)'), '#f', 'no output after the exit');
  c.close();
});

test('R4.43 kill-process on a card-less process sends pty.kill with forget; :card keeps the session; delete-process', async () => {
  const c = await client(); await hubUp(c);
  assert.equal(await value(c, '(define pk (make-process :name "k" :command "sleep 30")) (define pcard (make-process :name "kc" :command "sleep 30" :card #t)) (list (process-card-p pk) (process-card-p pcard))'), '(#f #t)');
  const sidK = JSON.parse(await value(c, '(process-sid pk)')), sidC = JSON.parse(await value(c, '(process-sid pcard)'));
  await hub.waitFor(r => r.t === 'pty.open' && r.sid === sidC);
  assert.equal(await value(c, '(kill-process pk) (process-status pk)'), 'deleted');
  const [k1] = await hub.waitFor(r => r.t === 'pty.kill' && r.sid === sidK);
  assert.equal(k1.forget, true, 'card-less: forget');
  assert.ok(!hub.sessions.has(sidK), 'the hub forgot it');
  assert.equal(await value(c, '(kill-process pcard) (list (process-status pcard) (process-exit-status pcard))'), '(signal 1)');
  const [k2] = await hub.waitFor(r => r.t === 'pty.kill' && r.sid === sidC);
  assert.equal(k2.forget, false, 'a card process stays listed');
  assert.ok(hub.sessions.has(sidC));
  assert.equal(await value(c, '(delete-process pcard) (memq pcard (process-list))'), '#f');
  await hub.waitFor(r => r.t === 'pty.kill' && r.sid === sidC && r.forget === true);
  assert.equal(await value(c, '(memq pk (process-list))'), '#f');
  c.close();
});

test('R4.44 call-process: the TERM prefix for POSIX shells, ANSI stripped, exit status, the corpse forgotten', async () => {
  const c = await client(); await hubUp(c);
  hub.programs.set('colors', async io => { io.write('a\x1b[31mred\x1b[0m\r\nb\r\n'); return 3; });
  assert.equal(await value(c, '(with-current-buffer (get-buffer-create "*cp*") (list (call-process "colors" :buffer #t) (buffer-string)))'), '(3 "ared\\nb\\n")');
  const opens = await hub.waitFor(r => r.t === 'pty.open' && r.spawn && r.spawn.argv[2] && r.spawn.argv[2].endsWith('colors'));
  assert.equal(opens[0].spawn.argv[2], 'export TERM=dumb NO_COLOR=1; colors', 'bash is POSIX: the prefix (R4.44)');
  assert.equal(opens[0].spawn.argv[0], 'bash');
  await hub.waitFor(r => r.t === 'pty.kill' && r.sid === opens[0].sid && r.forget === true);
  assert.ok(!hub.sessions.has(opens[0].sid), 'call-process leaves no session behind');
  assert.equal(await value(c, '(shell-command-to-string "echo plain" :shell "nu")'), '"plain\\n"');
  const nu = await hub.waitFor(r => r.t === 'pty.open' && r.spawn && r.spawn.shell === 'nu');
  assert.equal(nu[0].spawn.argv[2], 'echo plain', 'a non-POSIX shell gets no prefix');
  assert.equal(await value(c, '(call-process "exit 7")'), '7');
  assert.equal(await value(c, '(call-process "echo cwd" :cwd "/tmp" :env (quote (("FOO" . "bar"))))'), '0');
  const [withEnv] = await hub.waitFor(r => r.t === 'pty.open' && r.spawn && r.spawn.argv[2] && r.spawn.argv[2].endsWith('echo cwd'));
  assert.equal(withEnv.spawn.cwd, '/tmp'); assert.deepEqual(withEnv.spawn.env, { FOO: 'bar' });
  assert.equal((await c.form('(call-process "sleep 30" :timeout 0.2)')).error.condition, 'timeout');
  assert.equal((await c.form('(call-process "x" :cwd "relative")')).error.condition, 'error', 'cwd must be absolute');
  c.close();
});

test('R4.43 a refused spawn is process-error with the hub\'s message; make-process checks its arguments', async () => {
  const c = await client(); await hubUp(c);
  const r = await c.form('(make-process :name "x" :command "true" :shell "fish")');
  assert.equal(r.error.condition, 'process-error'); assert.match(r.error.report, /shell fish not available/);
  hub.programs.set('refuse:boom', { code: 'spawn_failed', message: 'spawn failed: exec' });
  const r2 = await c.form('(make-process :name "x" :command "boom")');
  assert.equal(r2.error.condition, 'process-error'); assert.match(r2.error.report, /spawn failed: exec/);
  assert.equal((await c.form('(make-process :name "x")')).error.condition, 'error');
  assert.equal((await c.form('(make-process :name "x" :command "true" :env (quote (("A" . "1") "junk")))')).error.condition, 'wrong-type-argument');
  assert.equal(await value(c, '(length (process-list))') > '0', true);
  c.close();
});

test('M-x list-processes renders *Process List* with every process, card-less ones included (R9.22)', async () => {
  const c = await client(); await hubUp(c);
  assert.equal(await value(c, '(define pl (make-process :name "lister" :command "sleep 30")) (process-live-p pl)'), '#t');
  const r = await c.call('list-processes');
  assert.equal(r.value, '"name:*Process List*"');
  const o = await c.open('name:*Process List*');
  assert.equal(o.error, null);
  assert.match(o.text, /^Process +PID +Status +Buffer +Shell +Session +Card +Command\n/);
  const sid = JSON.parse(await value(c, '(process-sid pl)'));
  const row = o.text.split('\n').find(l => l.startsWith('lister'));
  assert.ok(row, 'the process is listed'); assert.match(row, /run/); assert.ok(row.includes(sid)); assert.ok(row.includes('sleep 30'));
  assert.equal(o.meta && o.meta.readOnly, 'server special buffer');
  c.close();
});

test('R4.45 edwind started nothing itself: every process was a pty.open on the hub socket', async () => {
  const c = await client();
  const made = Number(await value(c, '(length (process-list))'));
  const opens = hub.requests.filter(r => r.t === 'pty.open' && r.spawn);
  assert.ok(opens.length >= made, 'each process came through the hub');
  assert.ok(opens.every(r => r.spawn.argv[0] === r.spawn.shell && (r.spawn.argv.length === 1 || r.spawn.argv[1] === '-c')), 'the hub runs only its shells, every command through -c');
  assert.ok(!child.logs.includes('colors') && !child.logs.includes('chunks'), 'R15.10: no command in the log');
  const s = (await c.call('status')).value;
  assert.equal(s.hub, 'up'); assert.equal(typeof s.processes, 'number');
  c.close();
});

test('hub down: hub-error, then reconnect with backoff and re-attach to the live process with resume', async () => {
  const c = await client(); await hubUp(c);
  assert.equal(await value(c, '(define pr (make-process :name "resume" :command "cat" :buffer (get-buffer-create "*resume*"))) (process-send-string pr "before\\n") (accept-process-output pr 5)'), '#t');
  const sid = JSON.parse(await value(c, '(process-sid pr)'));
  const sessions = hub.sessions;
  await hub.stop();
  await until(async () => (await value(c, '(hub-status)')) === 'down', 'edwind to notice the hub is gone');
  const r = await c.form('(make-process :name "nohub" :command "true")');
  assert.equal(r.error.condition, 'hub-error');
  assert.equal((await c.form('(process-send-string pr "x")')).error.condition, 'hub-error');
  assert.equal(await value(c, '(process-status pr)'), 'run', 'the last known state while the hub is down');
  /* The hub comes back with the same sessions (the real hub persists them); edwind re-attaches with resume. */
  hub = await new FakeHub(hubPath, { sessions }).start();
  sessions.get(sid).inputFn = d => hub.emitOut(sid, d.replace(/\n/g, '\r\n'));   // the fake cat, on the new hub
  await until(async () => (await value(c, '(hub-status)')) === 'up', 'the reconnect', 15000);
  const [re] = await hub.waitFor(r => r.t === 'pty.open' && r.sid === sid && !r.spawn);
  assert.deepEqual(Object.keys(re.resume).sort(), ['out', 'stream']);
  assert.equal(await value(c, '(process-send-string pr "after\\n") (accept-process-output pr 5)'), '#t');
  assert.equal(await value(c, '(with-current-buffer "*resume*" (buffer-string))'), '"before\r\\nafter\r\\n"');
  assert.equal(await value(c, '(process-live-p pr)'), '#t');
  c.close();
});
