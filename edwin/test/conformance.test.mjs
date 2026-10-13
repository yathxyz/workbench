// Protocol conformance (spec §16.1 edit-conformance): a Node client against a real edwind in a temp
// directory, over every message and error code of §7, the limits, chunking, stale_base, idempotent
// resend, the hash, the server commands of E1 and the socket checks of R14.3.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { makeDir, startEdwind, stopEdwind, EditClient, MAIN, EDWIN } from './edit-client.mjs';

const require = createRequire(import.meta.url);
const OT = require('../src/ot.js');
const { MAX_LINE, CODES } = await import('../server/proto.mjs');

let dir, child;
before(async () => { dir = makeDir(); child = await startEdwind(dir); });
after(async () => { await stopEdwind(child); fs.rmSync(dir.root, { recursive: true, force: true }); });

const client = async (opts) => { const c = new EditClient(dir.cfg.socket, opts); await c.connect(); const w = await c.hello(); assert.equal(w.t, 'welcome'); c.welcome = w; return c; };
const note = (name, text) => { fs.writeFileSync(path.join(dir.dirs.notes, name), text); return name; };

test('R7.2 MAX_LINE equals wb_proto::limits::MAX_LINE', () => {
  const rs = fs.readFileSync(path.join(EDWIN, '../crates/wb-proto/src/limits.rs'), 'utf8');
  const m = rs.match(/pub const MAX_LINE: usize = (\d+) \* MIB;/);
  assert.ok(m, 'limits.rs declares MAX_LINE in MiB');
  assert.equal(MAX_LINE, Number(m[1]) * 1024 * 1024);
});

test('§7.2 hello and welcome; a bad proto is refused; anything before hello is bad_request', async () => {
  const c = await client();
  assert.equal(c.welcome.proto, 1);
  assert.match(c.welcome.boot, /^[0-9a-f]{16}$/);
  assert.match(c.welcome.imageEpoch, /^[0-9a-f]{16}$/);
  assert.equal(typeof c.welcome.gen, 'number');
  c.close();
  const bad = new EditClient(dir.cfg.socket); await bad.connect();
  const e = await bad.hello({ proto: 7 });
  assert.equal(e.t, 'error'); assert.equal(e.code, 'proto');
  const early = new EditClient(dir.cfg.socket); await early.connect();
  early.send({ t: 'open', rid: 'x', buf: 'a' });
  const e2 = await early.next(m => m.t === 'error');
  assert.equal(e2.code, 'bad_request');
  early.close();
  const old = new EditClient(dir.cfg.socket); await old.connect();
  assert.equal((await old.hello({ proto: 0 })).t, 'welcome', 'proto N-1 is accepted (R15.14)');
  old.close();
});

test('§7.2 ping/pong and unknown messages are ignored (R7.4)', async () => {
  const c = await client();
  c.send({ t: 'ping', rid: 'p1' });
  const p = await c.next(m => m.t === 'pong');
  assert.equal(p.rid, 'p1');
  c.send({ t: 'frobnicate', rid: 'z', junk: 1 });
  c.send({ t: 'ping', rid: 'p2', extra: 'field' });
  assert.equal((await c.next(m => m.t === 'pong')).rid, 'p2');
  c.close();
});

test('§7.3 open, snap, edit, ack, edits to others, close; every op kind', async () => {
  const id = note('t1.md', 'hello\nworld\n');
  const a = await client(), b = await client();
  const oa = await a.open(id), ob = await b.open(id);
  assert.equal(oa.text, 'hello\nworld\n'); assert.equal(oa.ver, 0); assert.equal(ob.ver, 0);
  assert.equal(oa.meta.mode, 'markdown-mode'); assert.equal(oa.meta.eol, 'lf'); assert.equal(oa.meta.modified, false);
  const ack = await a.edit(id, 0, [[0, 'hello', 'HELLO'], [6, '', '😀 '], [9, 'world', '']], { g: 1 });
  assert.deepEqual(ack, { t: 'ack', buf: id, seq: 1, ver: 1 });
  const ed = await b.next(m => m.t === 'edits' && m.buf === id);
  assert.equal(ed.ver, 1); assert.equal(OT.apply('hello\nworld\n', ed.ops), 'HELLO\n😀 \n', 'the edits carry the batch in canonical form');
  assert.deepEqual(ed.by, { kind: 'cli', device: a.device });
  assert.equal((await b.open(id)).text, 'HELLO\n😀 \n');
  // The sender gets no edits of its own.
  assert.equal(a.queue.filter(m => m.t === 'edits').length, 0);
  b.send({ t: 'close', buf: id });
  await a.edit(id, 1, [[0, '', 'x']]);
  await a.form('(+ 1 1)'); // a round trip, so any edits to b would have arrived
  assert.equal(b.queue.filter(m => m.t === 'edits').length, 0, 'closed clients get nothing');
  a.close(); b.close();
});

test('R7.6, R7.11 concurrent edits are transformed; both replicas converge; sequenced insert left (R7.9)', async () => {
  const id = note('t2.md', 'ab');
  const a = await client(), b = await client();
  await a.open(id); await b.open(id);
  const [ackA, ackB] = await Promise.all([a.edit(id, 0, [[1, '', 'X']]), b.edit(id, 0, [[1, '', 'Y']])]);
  assert.equal(ackA.t, 'ack'); assert.equal(ackB.t, 'ack');
  assert.deepEqual([ackA.ver, ackB.ver].sort(), [1, 2]);
  // Each side gets the other's edit transformed against its own, and both replicas converge.
  const edA = await a.next(m => m.t === 'edits' && m.buf === id), edB = await b.next(m => m.t === 'edits' && m.buf === id);
  const textA = OT.apply(OT.apply('ab', [[1, '', 'X']]), edA.ops), textB = OT.apply(OT.apply('ab', [[1, '', 'Y']]), edB.ops);
  assert.equal(textA, textB);
  const first = ackA.ver === 1 ? 'X' : 'Y';
  assert.equal(textA, `a${first}${first === 'X' ? 'Y' : 'X'}b`, 'the sequenced insert goes left');
  assert.equal((await a.open(id)).text, textA);
  a.close(); b.close();
});

test('R7.7, R7.8 bad_edit: a del mismatch, a position out of range, a split surrogate pair', async () => {
  const id = note('t3.md', 'a😀b');
  const a = await client(); await a.open(id);
  let e = await a.edit(id, 0, [[0, 'x', '']]);
  assert.equal(e.t, 'error'); assert.equal(e.code, 'bad_edit'); assert.equal(e.buf, id); assert.equal(e.seq, 1);
  e = await a.edit(id, 0, [[9, '', 'z']]); assert.equal(e.code, 'bad_edit');
  e = await a.edit(id, 0, [[2, '', 'z']]); assert.equal(e.code, 'bad_edit');
  const ok = await a.edit(id, 0, [[1, '😀', '🧪']]); assert.equal(ok.t, 'ack');
  // Malformed ops are bad_request.
  a.send({ t: 'edit', buf: id, base: 1, seq: 9, ops: [[1, 2, 3]] });
  e = await a.next(m => m.t === 'error'); assert.equal(e.code, 'bad_request');
  a.close();
});

test('R7.15 an edit resent with the same (cid, seq) gets the original ack and is applied once', async () => {
  const id = note('t4.md', '');
  const a = await client(); await a.open(id);
  const ack = await a.edit(id, 0, [[0, '', 'once ']]);
  a.send({ t: 'edit', buf: id, base: 0, seq: 1, ops: [[0, '', 'once ']] });
  const again = await a.next(m => m.t === 'ack' && m.seq === 1);
  assert.deepEqual(again, ack);
  assert.equal((await a.open(id)).text, 'once ');
  a.close();
});

test('R7.16 reconnect with the same cid and open{since}: own batches come back as ack, others as edits', async () => {
  const id = note('t5.md', 'base\n');
  const a = await client(), b = await client();
  await a.open(id); await b.open(id);
  await a.edit(id, 0, [[0, '', 'A1 ']]);
  await b.edit(id, 1, [[0, '', 'B1 ']]);
  await a.edit(id, 2, [[0, '', 'A2 ']]);
  a.close();
  const a2 = new EditClient(dir.cfg.socket, { cid: a.cid }); await a2.connect(); await a2.hello();
  const o = await a2.open(id, { since: 0 });
  assert.equal(o.text, null, 'no snap inside the history');
  assert.deepEqual(o.acks.map(x => [x.seq, x.ver]), [[1, 1], [2, 3]]);
  assert.deepEqual(o.edits.map(x => [x.ver, x.ops[0][2]]), [[2, 'B1 ']]);
  assert.equal(o.ver, 3);
  // since beyond the current version falls back to a snap.
  const o2 = await a2.open(id, { since: 99 });
  assert.equal(o2.text, 'A2 B1 A1 base\n');
  a2.close(); b.close();
});

test('R7.3 rid rules and §7.8 bad_id, no_buffer, read_only, refused_path, not_text', async () => {
  const a = await client();
  for (const id of ['../x', 'a//b', '', 'name:', '/etc/../x']) { const o = await a.open(id); assert.equal(o.error && o.error.code, 'bad_id', id); }
  assert.equal((await a.open('absent.md')).error.code, 'no_buffer');
  const ro = await a.open('name:*Messages*');
  assert.equal(ro.error, null); assert.equal(ro.meta.readOnly, 'server special buffer');
  const e = await a.edit('name:*Messages*', ro.ver, [[0, '', 'x']]); assert.equal(e.code, 'read_only');
  fs.mkdirSync(path.join(dir.dirs.home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(dir.dirs.home, '.ssh/authorized_keys'), 'k\n');
  assert.equal((await a.open(path.join(dir.dirs.home, '.ssh/authorized_keys'))).error.code, 'refused_path');
  assert.equal((await a.open(path.join(dir.dirs.home, '.ssh/new'), { create: true })).error.code, 'refused_path');
  fs.writeFileSync(path.join(dir.dirs.notes, 'bin.dat'), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
  assert.equal((await a.open('bin.dat')).error.code, 'not_text');
  // Outside the writable paths: opens read-only with the reason.
  const outside = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'edwind-out-'));
  fs.writeFileSync(path.join(outside, 'f.txt'), 'x\n');
  const o = await a.open(path.join(outside, 'f.txt'));
  assert.equal(o.meta.readOnly, 'outside the writable paths');
  fs.rmSync(outside, { recursive: true, force: true });
  // A long rid is bad_request.
  a.send({ t: 'open', rid: 'r'.repeat(65), buf: 'x' });
  assert.equal((await a.next(m => m.t === 'error')).code, 'bad_request');
  a.close();
});

test('R6.1 ids: notesDir-relative, ~/, absolute; a symlink and its target name one buffer', async () => {
  const a = await client();
  note('ids.md', 'i\n');
  const abs = path.join(dir.dirs.notes, 'ids.md');
  const o1 = await a.open(abs);
  assert.equal(o1.error, null);
  const list = (await a.call('buffer-list')).value;
  assert.ok(list.some(b => b.id === 'ids.md'), 'the canonical id is notesDir-relative');
  fs.symlinkSync(abs, path.join(dir.dirs.home, 'link.md'));
  const o2 = await a.open(path.join(dir.dirs.home, 'link.md'));
  assert.equal(o2.error, null);
  assert.equal((await a.call('buffer-list')).value.filter(b => b.file === abs).length, 1);
  fs.writeFileSync(path.join(dir.dirs.home, 'h.md'), 'h\n');
  const o3 = await a.open('~/h.md');
  assert.equal(o3.error, null);
  assert.ok((await a.call('buffer-list')).value.some(b => b.id === '~/h.md'));
  a.close();
});

test('R7.2 a line over MAX_LINE is too_large and the connection stays', async () => {
  const a = await client();
  a.sock.write('{"t":"ping","rid":"big","pad":"' + 'x'.repeat(MAX_LINE + 10) + '"}\n');
  const e = await a.next(m => m.t === 'error', 30000);
  assert.equal(e.code, 'too_large');
  a.send({ t: 'ping', rid: 'after' });
  assert.equal((await a.next(m => m.t === 'pong')).rid, 'after');
  a.close();
});

test('R14.14 a snap over 1 MiB comes in chunks and reassembles', async () => {
  const big = ('0123456789abcdef\n'.repeat(70000)) + '😀';
  const id = note('big.md', big);
  const a = await client();
  const o = await a.open(id);
  assert.equal(o.text, big);
  a.close();
});

test('R7.14 ack and edits carry h every 50 versions; it is FNV-1a of the text', async () => {
  const id = note('h.md', '');
  const a = await client(), b = await client(); await a.open(id); await b.open(id);
  let text = '', ver = 0, seen = 0;
  for (let i = 1; i <= 50; i++) {
    const ack = await a.edit(id, ver, [[text.length, '', String(i) + ' ']]);
    text += String(i) + ' '; ver = ack.ver;
    if (ack.h !== undefined) { seen++; assert.equal(ver % 50, 0); assert.equal(ack.h, OT.hash(text)); }
  }
  assert.equal(seen, 1);
  const ed = await b.next(m => m.t === 'edits' && m.ver === 50);
  assert.equal(ed.h, OT.hash(text));
  a.close(); b.close();
});

test('§7.3 save and revert; meta on change; R8.7 atomic save keeps the mode bits', async () => {
  const id = note('s.md', 'one\n');
  fs.chmodSync(path.join(dir.dirs.notes, 's.md'), 0o644);
  const a = await client(); await a.open(id);
  await a.edit(id, 0, [[0, '', 'zero\n']]);
  const r = await a.request({ t: 'save', buf: id });
  assert.deepEqual(r.value, { buf: id, ver: 1, saved: true });
  assert.equal(fs.readFileSync(path.join(dir.dirs.notes, 's.md'), 'utf8'), 'zero\none\n');
  assert.equal(fs.statSync(path.join(dir.dirs.notes, 's.md')).mode & 0o777, 0o644);
  const meta = await a.next(m => m.t === 'meta' && m.buf === id);
  assert.equal(meta.modified, false); assert.equal(meta.saved, 1);
  await a.edit(id, 1, [[0, 'zero', 'ZERO']]);
  const rv = await a.request({ t: 'revert', buf: id });
  assert.equal(rv.value.ver, 3);
  assert.equal((await a.open(id)).text, 'zero\none\n');
  await a.open('name:*scratch*');
  const e = await a.request({ t: 'save', buf: 'name:*scratch*' });
  assert.equal(e.t, 'error'); assert.equal(e.code, 'bad_request', 'a buffer without a file cannot be saved');
  assert.equal((await a.request({ t: 'save', buf: 'absent.md' })).code, 'no_buffer');
  a.close();
});

test('R7.3 sel is relayed to the other clients of the buffer and never to the sender', async () => {
  const id = note('sel.md', 'abc');
  const a = await client(), b = await client(); await a.open(id); await b.open(id);
  a.send({ t: 'sel', buf: id, ranges: [[1, 2]] });
  const s = await b.next(m => m.t === 'sel');
  assert.deepEqual(s.ranges, [[1, 2]]); assert.equal(s.by.device, a.device);
  a.close(); b.close();
});

test('§7.4 call{form}: value, out, msg; conditions come back in result, never as error', async () => {
  const a = await client();
  let r = await a.form('(display "hi") (display "\\n") (+ 20 22)');
  assert.equal(r.value, '42'); assert.equal(r.out, 'hi\n');
  r = await a.form('(message "echo!") (list 1 "two" #\\3)');
  assert.equal(r.value, '(1 "two" #\\3)'); assert.equal(r.msg, 'echo!');
  r = await a.form('(error "boom" 1 2)');
  assert.equal(r.t, 'result'); assert.equal(r.error.condition, 'error'); assert.match(r.error.report, /boom/);
  assert.ok(Array.isArray(r.error.restarts)); assert.ok(Array.isArray(r.error.backtrace));
  r = await a.form('(define (f n) (if (= n 0) 0 (+ 1 (f (- n 1))))) (f 9900)');
  assert.equal(r.value, '9900', 'the cap of 10,000 frames holds under edwind (R4.34)');
  r = await a.form('(user-error "nope")');
  assert.equal(r.error.condition, 'user-error');
  r = await a.form('(');
  assert.equal(r.t, 'result'); assert.ok(r.error);
  a.send({ t: 'call', form: '1' });
  assert.equal((await a.next(m => m.t === 'error')).code, 'bad_request', 'a call needs a rid');
  a.close();
});

test('R4.14, R4.15 definitional forms enter the image log with a generation; image? replays them', async () => {
  const a = await client();
  const g0 = (await client()).welcome.gen;
  await a.form('(define e1-logged 41)');
  await a.form('(set! e1-logged 42)');
  await a.form('(+ 1 2)');
  const b = await client();
  assert.equal(b.welcome.gen, g0 + 2);
  b.send({ t: 'image?', rid: 'i', from: g0 });
  const img = await b.next(m => m.t === 'image');
  assert.deepEqual(img.forms, ['(define e1-logged 41)', '(set! e1-logged 42)']);
  assert.equal((await b.next(m => m.t === 'result' && m.rid === 'i')).value.gen, g0 + 2);
  const log = fs.readFileSync(path.join(dir.dirs.state, 'image.jsonl'), 'utf8');
  assert.match(log, /"form":"\(define e1-logged 41\)"/);
  a.close(); b.close();
});

test('R14.13 a runaway form hits the deadline and comes back as the timeout condition', async () => {
  const f = await client({ kind: 'frame' });
  const t0 = Date.now();
  const r = await f.form('(let loop () (loop))');
  assert.equal(r.error.condition, 'timeout');
  assert.ok(Date.now() - t0 < 10000);
  assert.equal((await f.form('(+ 1 1)')).value, '2', 'edwind serves on');
  f.close();
});

test('§13.1 buffer-list and kill-buffer; killed reaches attached clients', async () => {
  const id = note('k.md', 'k\n');
  const a = await client(), b = await client(); await a.open(id); await b.open(id);
  const list = (await a.call('buffer-list')).value;
  const e = list.find(x => x.id === id);
  assert.equal(e.name, 'k.md'); assert.equal(e.mode, 'markdown-mode'); assert.equal(e.modified, false); assert.equal(e.writers.length, 2);
  await a.call('kill-buffer', [id]);
  assert.equal((await b.next(m => m.t === 'killed')).buf, id);
  assert.equal((await a.call('buffer-list')).value.some(x => x.id === id), false);
  // A Scheme kill-buffer kills everywhere too (R6.3).
  const id2 = note('k2.md', 'k\n'); await b.open(id2);
  await a.form(`(kill-buffer "k2.md")`);
  assert.equal((await b.next(m => m.t === 'killed')).buf, id2);
  a.close(); b.close();
});

test('§13.1 server-edit: --wait resolves on done (saved, 0) or abort (1); plain returns at once', async () => {
  const a = await client(), b = await client();
  const id = note('se.md', 'edit me\n');
  const quick = await a.call('server-edit', [id, 3], {});
  assert.deepEqual(quick.value, { buf: id, exit: null });
  const rid = a.newRid();
  a.send({ t: 'call', rid, cmd: 'server-edit', args: [id, null], ctx: { wait: true } });
  await b.open(id);
  await b.edit(id, 0, [[0, '', 'ok ']]);
  await b.call('server-edit-done', [id]);
  const r = await a.next(m => m.rid === rid);
  assert.deepEqual(r.value, { buf: id, exit: 0 });
  assert.equal(fs.readFileSync(path.join(dir.dirs.notes, 'se.md'), 'utf8'), 'ok edit me\n');
  const rid2 = a.newRid();
  a.send({ t: 'call', rid: rid2, cmd: 'server-edit', args: [id], ctx: { wait: true } });
  await b.call('server-edit-abort', [id]);
  assert.deepEqual((await a.next(m => m.rid === rid2)).value, { buf: id, exit: 1 });
  a.close(); b.close();
});

test('R6.19–R6.21 server undo: own newest group, undo-global, undo-writer, partial undo', async () => {
  const id = note('u.md', 'base\n');
  const a = await client(), b = await client(); await a.open(id); await b.open(id);
  await a.edit(id, 0, [[0, '', 'A1 ']], { g: 1 });
  await b.edit(id, 1, [[3, '', 'B1 ']], { g: 1 });
  await a.edit(id, 2, [[6, '', 'A2 ']], { g: 2 });
  assert.equal((await a.open(id)).text, 'A1 B1 A2 base\n');
  let r = await a.call('undo', [], {}, id);
  assert.equal(r.msg, 'Undo'); assert.equal(r.value.ver, 4);
  assert.equal((await a.open(id)).text, 'A1 B1 base\n');
  r = await a.call('undo', [], {}, id);
  assert.equal((await a.open(id)).text, 'B1 base\n');
  r = await a.call('undo', [], {}, id);
  assert.equal(r.value, false); assert.equal(r.msg, 'No further undo information');
  r = await b.call('undo-global', [], {}, id);
  assert.equal((await b.open(id)).text, 'base\n');
  const writers = (await a.call('list-writers', [], {}, id)).value;
  assert.ok(writers.length >= 2);
  // Partial: A inserts, B deletes part of it, A undoes.
  await a.edit(id, 6, [[0, '', 'XYZ']], { g: 3 });
  await b.edit(id, 7, [[1, 'Y', '']], { g: 2 });
  r = await a.call('undo', [], {}, id);
  assert.equal(r.value.partial, true); assert.match(r.msg, /^Undo \(partial: changed by cli\)/);
  assert.equal((await a.open(id)).text, 'base\n');
  const msg = await b.next(m => m.t === 'msg' && /partial/.test(m.text));
  assert.match(msg.text, /changed by cli/);
  a.close(); b.close();
});

test('R14.3 edwind refuses to start on a socket directory that is not 0700, or not its own', async () => {
  const d2 = makeDir();
  fs.chmodSync(d2.dirs.sock, 0o755);
  await assert.rejects(startEdwind(d2), /mode 755, not 700/);
  fs.chmodSync(d2.dirs.sock, 0o700);
  fs.symlinkSync('/nonexistent', d2.cfg.socket);
  await assert.rejects(startEdwind(d2), /exists and is not a socket|ENOENT|not a socket/);
  fs.rmSync(d2.root, { recursive: true, force: true });
});

test('R15.2, R15.4 the socket is 0600 and edit.json with an unknown field is refused', async () => {
  assert.equal(fs.statSync(dir.cfg.socket).mode & 0o777, 0o600);
  const d2 = makeDir({ bogus: 1 });
  await assert.rejects(startEdwind(d2), /unknown field "bogus"/);
  fs.rmSync(d2.root, { recursive: true, force: true });
});

test('R7.8 shutting_down: a stopping edwind tells its clients and exits cleanly', async () => {
  const d2 = makeDir();
  const ch = await startEdwind(d2);
  const a = new EditClient(d2.cfg.socket); await a.connect(); await a.hello();
  const o = await a.open('name:x', { create: true });
  assert.equal(o.ver, 0);
  ch.kill('SIGTERM');
  const e = await a.next(m => m.t === 'error');
  assert.equal(e.code, 'shutting_down');
  await stopEdwind(ch);
  assert.equal(fs.existsSync(d2.cfg.socket), false, 'the socket is removed');
  fs.rmSync(d2.root, { recursive: true, force: true });
});

test('R15.12 edwind --check verifies the journals; --export writes the buffers', async () => {
  const id = note('chk.md', 'c\n');
  const a = await client(); await a.open(id); await a.edit(id, 0, [[0, '', 'C ']]); a.close();
  await new Promise(r => setTimeout(r, 100));
  const run = (args) => new Promise(resolve => { const p = spawn(process.execPath, [MAIN, '--config', dir.file, ...args], { env: { ...process.env, HOME: dir.dirs.home } }); let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; }); p.on('exit', code => resolve({ code, out })); });
  const r = await run(['--check']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /chk\.md: ok, 1 batches, version 1/);
  assert.match(r.out, /0 with problems/);
  const dirOut = path.join(dir.root, 'export');
  const ex = await run(['--export', dirOut]);
  assert.equal(ex.code, 0, ex.out);
  const files = fs.readdirSync(dirOut);
  assert.ok(files.some(f => f.endsWith('chk.md')));
  assert.equal(fs.readFileSync(path.join(dirOut, files.find(f => f.endsWith('chk.md'))), 'utf8'), 'C c\n');
});

test('R16.17 limits: 500 open buffers, a flood of edits and a deep recursion leave edwind serving', async () => {
  const a = await client();
  for (let i = 0; i < 500; i++) assert.equal((await a.open(`name:flood-${i}`, { create: true })).error, null);
  const id = 'name:flood-0';
  let ver = 0;
  const acks = [];
  for (let i = 0; i < 300; i++) { a.send({ t: 'edit', buf: id, base: ver, seq: i + 1, ops: [[0, '', 'x']] }); ver++; }
  for (let i = 0; i < 300; i++) acks.push(await a.next(m => m.t === 'ack' && m.seq === i + 1));
  assert.equal(acks[299].ver, 300);
  const r = await a.form('(define (deep n) (if (= n 0) 0 (+ 1 (deep (- n 1))))) (deep 1000000)');
  assert.equal(r.error.condition, 'recursion-depth');
  assert.equal((await a.form('(+ 1 1)')).value, '2');
  const b = await client();
  assert.equal((await b.open(id)).text.length, 300);
  a.close(); b.close();
});

test('R16.16 the Node flags of bin/edwind are in effect: no eval, frozen intrinsics, a sized stack, no child processes', async () => {
  const cmd = fs.readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0');
  for (const f of ['--disallow-code-generation-from-strings', '--frozen-intrinsics']) assert.ok(cmd.includes(f), f);
  assert.ok(cmd.some(f => f.startsWith('--stack-size=')));
  assert.ok(!cmd.includes('--permission'), 'the permission model would disable fsync (R8.3)');
  // The child_process guard (R4.45, R14.12): every function of the module throws once edwind has started.
  const probe = `import { guardProcesses } from ${JSON.stringify(MAIN)}; import cp from 'node:child_process'; import { spawnSync } from 'node:child_process';
    guardProcesses(); const out = [];
    for (const f of [() => spawnSync('true'), () => cp.execSync('true'), () => cp.spawn('true'), () => cp.fork('x')]) { try { f(); out.push('ran'); } catch (e) { out.push(e.message); } }
    console.log(JSON.stringify(out));`;
  const r = await new Promise(resolve => { const p = spawn(process.execPath, ['--input-type=module', '-e', probe], { env: process.env }); let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; }); p.on('exit', code => resolve({ code, out })); });
  assert.equal(r.code, 0, r.out);
  const msgs = JSON.parse(r.out.trim().split('\n').pop());
  assert.equal(msgs.length, 4); for (const m of msgs) assert.match(m, /edwind never starts processes/);
});

test('every §7.8 code is one edwind knows', () => {
  assert.deepEqual(CODES.sort(), ['bad_edit', 'bad_id', 'bad_request', 'no_buffer', 'not_text', 'proto', 'read_only', 'refused_path', 'shutting_down', 'slow_client', 'stale_base', 'too_large']);
});
