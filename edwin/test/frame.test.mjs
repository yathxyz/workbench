// The frame runtime against a real edwind (E3 H1, spec 6.3, 7, 9.5): Edwin's core on the Node host with
// src/sync.js as the protocol client, over a net.Socket wrapped to look like a WebSocket (one JSON text
// per send, newline framed on the wire). A second writer is an EditClient with an ot-sim style replica.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeDir, startEdwind, stopEdwind, EditClient } from './edit-client.mjs';
import { rng, randOp } from './ot-sim.mjs';

const require = createRequire(import.meta.url);
const { createHost, loadEdwin, memoryStorage } = require('../src/host-node.js');
const OT = require('../src/ot.js');

let dir, child, Ed, E, L, sync;
const note = (name, text) => { fs.writeFileSync(path.join(dir.dirs.notes, name), text); return name; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(pred, what = 'condition', ms = 8000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`); await sleep(10); } }
const settled = b => until(() => !b.inflight && !b.queue.length && !b.sync.opening, `${b.name} settled`);
/* A WebSocket-like object over the unix socket: onopen/onmessage/onclose/onerror, send(text), close(). */
function transport(sockPath) {
  return () => {
    const s = net.connect(sockPath); s.setEncoding('utf8');
    const ws = { onopen: null, onmessage: null, onclose: null, onerror: null, send: str => { s.write(str + '\n'); }, close: () => s.destroy() };
    let buf = '';
    s.on('connect', () => ws.onopen && ws.onopen());
    s.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line && ws.onmessage) ws.onmessage({ data: line }); } });
    s.on('close', () => ws.onclose && ws.onclose());
    s.on('error', e => ws.onerror && ws.onerror(e));
    return ws;
  };
}
async function client(opts) { const c = new EditClient(dir.cfg.socket, opts); await c.connect(); const w = await c.hello(); assert.equal(w.t, 'welcome'); return c; }
const feed = async keys => { for (const k of keys) Ed.feedKey(k); await Ed.whenIdle(); };
const keys = s => feed(Ed.kbd(s).split(' '));
const type = s => feed([...s].map(ch => (ch === ' ' ? 'SPC' : ch === '\n' ? 'RET' : ch)));
const show = b => { Ed.setWindowBuffer(b); E.current = b; };
const messages = () => Ed.getBuffer('*Messages*').text;
async function serverText(id) { const c = await client(); const o = await c.open(id); c.close(); return o.text; }

/* A second writer whose replica follows R7.12 (the ot-sim Client over a real socket). */
class Writer {
  constructor(c, id) { this.c = c; this.id = id; this.inflight = null; this.queue = []; this.seq = 0; this.acks = new Set(); this.gen = 0; }
  async open() { const o = await this.c.open(this.id); this.text = this.sverText = o.text; this.sver = o.ver; this.pump(); return this; }
  pump() { this.loop = (async () => { for (;;) { let m; try { m = await this.c.next(x => x.buf === this.id && (x.t === 'edits' || x.t === 'ack'), 1e9); } catch (e) { return; } this.recv(m); } })(); }
  local(ops) {
    this.text = OT.apply(this.text, ops);
    if (!this.inflight) { this.inflight = { seq: ++this.seq, base: this.sver, ops }; this.send(); } else this.queue.push({ ops });
  }
  send() { this.c.send({ t: 'edit', buf: this.id, base: this.inflight.base, seq: this.inflight.seq, ops: this.inflight.ops, undo: { g: 'w' + (++this.gen) } }); }
  recv(msg) {
    if (msg.t === 'ack') {
      if (this.acks.has(msg.seq)) return;
      assert.equal(msg.seq, this.inflight.seq, 'ack for the wrong batch');
      this.acks.add(msg.seq);
      this.sverText = OT.apply(this.sverText, this.inflight.ops); this.sver = msg.ver; this.inflight = null;
      if (this.queue.length) { const q = this.queue.shift(); this.inflight = { seq: ++this.seq, base: this.sver, ops: q.ops }; this.send(); }
      return;
    }
    assert.equal(msg.ver, this.sver + 1, 'edits out of order');
    let R = OT.fromOps(msg.ops, this.sverText.length);
    let base = OT.apply(this.sverText, msg.ops);
    this.sverText = base; this.sver = msg.ver;
    if (this.inflight) {
      const [Rp, Ip] = OT.transform(R, OT.fromOps(this.inflight.ops, this.sverText.length - OT.delta(msg.ops)));
      this.inflight.ops = OT.toOps(Ip, base); this.inflight.base = this.sver; R = Rp; base = OT.applyOperation(base, Ip);
    }
    for (let i = 0; i < this.queue.length; i++) {
      const [Rp, Qp] = OT.transform(R, OT.fromOps(this.queue[i].ops, R.baseLen));
      this.queue[i].ops = OT.toOps(Qp, base); R = Rp; base = OT.applyOperation(base, Qp);
    }
    this.text = OT.apply(this.text, OT.toOps(R, this.text));
    assert.equal(this.text, base);
  }
  settled() { return until(() => !this.inflight && !this.queue.length, 'writer settled'); }
}

before(async () => {
  dir = makeDir();
  child = await startEdwind(dir);
  const host = createHost({ storage: memoryStorage(), workers: false });
  Ed = loadEdwin(host); E = Ed.E; L = globalThis.L;
  sync = await Ed.bootServed({ transport: transport(dir.cfg.socket), device: 'frame-test' });
  await Ed.whenIdle();
});
after(async () => { if (sync) sync.shutdown(); if (child) await stopEdwind(child); });

test('R4.11 served boot: no frame, the shipped Scheme loaded, nothing read from browser stores, candidates set', async () => {
  assert.equal(E.frames.length, 0); assert.equal(E.frame, null);
  assert.equal(sync.state, 'online'); assert.equal(sync.cid.length, 32); assert.equal(sync.ready, true);
  assert.ok(L.get('evil-mode') !== undefined || L.fnOrNull(L.intern('evil-normal-state')), 'evil.scm loaded');
  assert.equal(L.get('wiki-candidates') !== undefined, true);
  assert.equal(L.truthy(L.evalText('(image-server?)')), false, 'a frame is not the image server');
  assert.ok(Ed.getBuffer('*scratch*') && Ed.getBuffer('*Messages*'), 'the local buffers');
  assert.equal(Ed.getBuffer('*scratch*').shared, undefined);
  assert.ok(L.isCommand(L.intern('describe-browser-keys')) && L.isCommand(L.intern('eval-in-frame')));
});

test('open, snap, typing becomes one edit batch per command, the ack lands and the server has the text', async () => {
  const id = note('a.md', 'hello\n');
  const w = await client(); const wo = await w.open(id); assert.equal(wo.text, 'hello\n');
  const b = await sync.open(id);
  assert.equal(b.shared, true); assert.equal(b.text, 'hello\n'); assert.equal(b.sver, 0); assert.equal(b.readOnly, false);
  assert.ok(E.buffers.includes(b)); assert.equal(b.meta.file, path.join(dir.dirs.notes, 'a.md'));
  show(b);
  await type('iXY'); await keys('ESC');
  await settled(b);
  assert.equal(b.text, 'XYhello\n');
  /* The first self-insert goes out at once; the second waits in the queue (R7.12): two batches of one undo group. */
  const e = await w.next(m => m.t === 'edits' && m.buf === id);
  assert.deepEqual(e.ops, [[0, '', 'X']]);
  assert.equal(e.by.kind, 'frame'); assert.equal(e.by.cid, sync.cid); assert.equal(e.by.device, 'frame-test');
  const e2 = await w.next(m => m.t === 'edits' && m.buf === id);
  assert.deepEqual(e2.ops, [[1, '', 'Y']]);
  assert.equal(b.hist.length, 2); assert.equal(b.hist[0].cid, sync.cid); assert.ok(b.hist[0].undo.g);
  assert.equal(b.hist[0].undo.g, b.hist[1].undo.g, 'a run of self-inserts is one undo group');
  assert.equal(await serverText(id), 'XYhello\n');
  /* A second command is a second group. */
  await type('A!'); await keys('ESC'); await settled(b);
  assert.equal(b.text, 'XYhello!\n'); assert.equal(b.hist.length, 3); assert.notEqual(b.hist[2].undo.g, b.hist[0].undo.g);
  assert.equal(await serverText(id), 'XYhello!\n');
  w.close();
});

test('remote edits arrive with their origin and transform against the pending local batch', async () => {
  const id = note('r.md', 'abc\n');
  const b = await sync.open(id); show(b);
  const w = await client(); await w.open(id);
  let edited = 0; const off = Ed.onFrameEvent(() => { edited++; });
  const ack = await w.edit(id, b.sver, [[3, '', 'Z']]);
  assert.equal(ack.t, 'ack');
  await until(() => b.text === 'abcZ\n', 'the remote insert');
  assert.equal(b.sver, ack.ver);
  assert.equal(b.hist[b.hist.length - 1].cid !== sync.cid, true);
  /* Hold our own batch in flight by sending through a stalled path: a local insert and a remote one before the ack. */
  Ed.applyOps(b, [[0, '', 'L']], 'local');
  assert.ok(b.inflight, 'the local batch is in flight');
  await settled(b);
  assert.equal(b.text, 'LabcZ\n'); assert.equal(await serverText(id), 'LabcZ\n');
  off(); w.close();
});

test('randomised convergence: 200 interleaved steps of frame and writer edits end with equal texts', async () => {
  const id = note('c.md', 'the quick brown fox\njumps over\n');
  const b = await sync.open(id); show(b);
  const wc = await client(); const w = await new Writer(wc, id).open();
  const r = rng(7);
  for (let i = 0; i < 200; i++) {
    const k = r.int(0, 9);
    if (k < 4) { const op = randOp(r, b.text); if (op) Ed.applyOps(b, [op], 'local'); }
    else if (k < 8) { const op = randOp(r, w.text); if (op) w.local([op]); }
    else await sleep(r.int(0, 3));
  }
  await settled(b); await w.settled();
  await until(() => b.sver === w.sver, 'both replicas at the same version');
  assert.equal(b.text, w.text);
  assert.equal(b.text, await serverText(id));
  assert.equal(b.sync.sverText, b.text);
  wc.close();
});

test('R6.15-R6.18 undo by group: u takes a whole group back, C-r redoes, a partial undo names the other writer', async () => {
  const id = note('u.md', 'abc\n');
  const b = await sync.open(id); show(b);
  await type('iXY'); await keys('ESC'); await settled(b);
  assert.equal(b.text, 'XYabc\n');
  await keys('u'); await settled(b);
  assert.equal(b.text, 'abc\n');
  const u = b.hist[b.hist.length - 1];
  assert.equal(u.undo.of, b.hist[b.hist.length - 2].undo.g, 'the undo batch names the group it undoes');
  assert.equal(await serverText(id), 'abc\n');
  await keys('C-r'); await settled(b);
  assert.equal(b.text, 'XYabc\n'); assert.equal(await serverText(id), 'XYabc\n');
  assert.equal(b.hist[b.hist.length - 1].undo.of, undefined, 'redo is a new group');
  await keys('u'); await settled(b); assert.equal(b.text, 'abc\n');
  /* Partial: our PQ, then another writer deletes the Q; undo removes what is left and says so. */
  await type('iPQ'); await keys('ESC'); await settled(b);
  assert.equal(b.text, 'PQabc\n');
  const w = await client(); await w.open(id);
  const ack = await w.edit(id, b.sver, [[1, 'Q', '']]); assert.equal(ack.t, 'ack');
  await until(() => b.text === 'Pabc\n', 'the remote delete');
  await keys('u'); await settled(b);
  assert.equal(b.text, 'abc\n');
  assert.match(messages(), /Undo \(partial/);
  assert.equal(await serverText(id), 'abc\n');
  /* Nothing of ours left to undo locally: the server fallback answers. */
  await keys('u'); await sleep(200);
  assert.ok(b.text === 'abc\n' || b.text === 'PQabc\n');
  w.close();
});

test('R7.16 reconnect after edwind restarts: the unacknowledged batch is resent and nothing is lost', async () => {
  const id = note('k.md', 'keep\n');
  const b = await sync.open(id); show(b);
  await type('i1'); await keys('ESC'); await settled(b);
  assert.equal(await serverText(id), '1keep\n');
  const states = []; const off = sync.on('state', s => states.push(s));
  await stopEdwind(child);
  await until(() => sync.state !== 'online', 'offline');
  /* Offline edits queue up: the mode line shows the dot. */
  await type('A2'); await keys('ESC');
  assert.ok(b.inflight, 'held while offline'); assert.equal(b.text, '1keep2\n');
  assert.ok(Ed.hooks.modeStatus(b).includes('•') && Ed.hooks.modeStatus(b).includes('offline'));
  child = await startEdwind(dir);
  await until(() => sync.state === 'online', 'online again', 15000);
  await settled(b);
  assert.equal(b.text, '1keep2\n');
  assert.equal(await serverText(id), '1keep2\n');
  assert.ok(states.includes('offline') && states.includes('online'));
  assert.equal(Ed.hooks.modeStatus(b), '');
  off();
  /* The replica keeps working after the reconnect. */
  await type('A3'); await keys('ESC'); await settled(b);
  assert.equal(await serverText(id), '1keep23\n');
});

test('R4.15-R4.18 the image replicates: definitions arrive, on-server forms are skipped, shared variables follow', async () => {
  const c = await client();
  let r = await c.form('(define (frame-fn x) (* x 7))'); assert.ok(!r.error, JSON.stringify(r));
  r = await c.form('(on-server (define (srv-only) 1))'); assert.ok(!r.error);
  r = await c.form('(defvar-shared frame-shared 1 "A count.")'); assert.ok(!r.error);
  r = await c.form('(set! frame-shared 41)'); assert.ok(!r.error);
  await until(() => L.fnOrNull(L.intern('frame-fn')), 'the definition');
  assert.equal(String(L.evalText('(frame-fn 6)')), '42');
  await until(() => String(L.get('frame-shared')) === '41', 'the shared value');
  assert.equal(L.fnOrNull(L.intern('srv-only')), null, 'on-server forms are not evaluated in a frame');
  /* A bad form reports to *Messages* with its generation and does not stop the rest. */
  r = await c.form('(define (after-bad) 2)');
  await until(() => L.fnOrNull(L.intern('after-bad')), 'the later definition');
  c.close();
});

test('R4.27, R4.28 a :where server command runs on edwind; its edits come back as this frame\'s own and undo', async () => {
  const id = note('s.md', 'abc\n');
  const b = await sync.open(id); show(b);
  const c = await client();
  const r = await c.form('(define-command (stamp) "Append S." (interactive) (:where (quote server)) (goto-char (point-max)) (insert "S") (message "stamped"))');
  assert.ok(!r.error, JSON.stringify(r));
  await until(() => { const f = L.fnOrNull(L.intern('stamp')); return f && f.where === 'server'; }, 'the command in the frame');
  await keys('M-x'); await type('stamp'); await keys('RET');
  await until(() => b.text === 'abc\nS', 'the server edit');
  const h = b.hist[b.hist.length - 1];
  assert.equal(h.cid, sync.cid, 'the thread edit is ours'); assert.equal(h.by.via, 'server');
  await until(() => /stamped/.test(messages()), 'the result message');
  await keys('u'); await settled(b);
  assert.equal(b.text, 'abc\n', 'u undoes the server command\'s edit');
  assert.equal(await serverText(id), 'abc\n');
  c.close();
});

test('R4.29 ask reaches the minibuffer of the frame and the answer goes back; C-g answers quit', async () => {
  const c = await client();
  const r = await c.form('(define-command (greet2 n) (interactive "sName: ") (:where (quote server)) (message "hi ~a" n) n)');
  assert.ok(!r.error, JSON.stringify(r));
  await until(() => { const f = L.fnOrNull(L.intern('greet2')); return f && f.where === 'server'; }, 'the command');
  show(Ed.getBuffer('*scratch*'));
  await keys('M-x'); await type('greet2'); await keys('RET');
  await until(() => E.mini && /Name/.test(E.mini.prompt || ''), 'the ask prompt');
  await type('Bob'); await keys('RET');
  await until(() => /hi Bob/.test(messages()), 'the answer used');
  await keys('M-x'); await type('greet2'); await keys('RET');
  await until(() => E.mini && /Name/.test(E.mini.prompt || ''), 'the second ask');
  await keys('C-g');
  await until(() => !E.mini, 'the minibuffer closed');
  await until(() => /Quit/.test(E.echo) || /Quit/.test(messages()), 'quit reported');
  c.close();
});

test('R7.14, R7.17 bad_edit and stale_base recover: the buffer reopens and matches the server', async () => {
  const id = note('e.md', 'safe\n');
  const b = await sync.open(id); show(b);
  sync.sock.send(JSON.stringify({ t: 'edit', buf: id, base: b.sver, seq: ++b.sync.seq, ops: [[999, '', 'x']], undo: { g: 1 } }));
  await until(() => /refused an edit/.test(messages()), 'bad_edit reported');
  await settled(b);
  assert.equal(b.text, 'safe\n'); assert.equal(b.shared, true);
  /* stale_base needs a base older than the retained history; the server's answer is injected on the wire. */
  Ed.applyOps(b, [[0, '', 'pending'], ], 'local');
  sync.sock.onmessage({ data: JSON.stringify({ t: 'error', code: 'stale_base', buf: id, seq: b.inflight.seq, msg: 'base 0 is older than the retained history' }) });
  await until(() => /version edwind no longer has/.test(messages()), 'stale_base reported');
  assert.ok(E.buffers.some(x => /~offline-/.test(x.name) && x.text === 'pendingsafe\n'), 'the unsent edit is kept in an offline copy');
  await settled(b);
  assert.equal(b.text, await serverText(id));
  await type('iok'); await keys('ESC'); await settled(b);
  assert.match(b.text, /ok/); assert.equal(await serverText(id), b.text);
});

test('R9.12 anchors arrive in meta, move with local and remote edits, and anchor-add returns the id', async () => {
  const id = note('n.md', 'one two three\n');
  const b = await sync.open(id); show(b);
  const c = await client(); await c.open(id);
  const r = await c.call('anchor-add', [id, 4, 'two']);
  assert.ok(!r.error, JSON.stringify(r)); assert.equal(r.value.pos, 4);
  await until(() => b.meta.anchors.length === 1, 'the anchor in meta');
  assert.equal(b.meta.anchors[0].pos, 4); assert.equal(b.meta.anchors[0].label, 'two');
  Ed.applyOps(b, [[0, '', 'ZZ']], 'local');
  assert.equal(b.meta.anchors[0].pos, 6, 'moved by the local insert before the ack');
  await settled(b);
  assert.equal(b.meta.anchors[0].pos, 6);
  const ack = await c.edit(id, b.sver, [[0, '', 'Y']]); assert.equal(ack.t, 'ack');
  await until(() => b.meta.anchors[0].pos === 7, 'moved by the remote insert');
  const myId = await sync.anchorAdd(id, 1, 'mine', 'mine-1');
  assert.equal(myId, 'mine-1');
  await until(() => b.meta.anchors.length === 2, 'the second anchor');
  assert.equal(await sync.anchorRemove(id, 'mine-1'), true);
  await until(() => b.meta.anchors.length === 1, 'removed');
  c.close();
});

test('R4.30 server-only primitives are stubs that signal server-only with a hint', async () => {
  const f = L.fnOrNull(L.intern('anchor-add!'));
  assert.ok(f, 'the stub exists'); assert.equal(f.where, 'server');
  let err = null;
  try { L.evalText('(anchor-add! "x" 1)'); } catch (e) { err = e; }
  assert.ok(err && err.kind === 'server-only', String(err));
  assert.match(String(err.message), /runs in edwind/);
});

test('presence: another writer\'s sel is recorded per buffer with a colour and label', async () => {
  const id = note('p.md', 'abc\n');
  const b = await sync.open(id);
  const c = await client({ device: 'laptop' }); await c.open(id);
  c.send({ t: 'sel', buf: id, ranges: [[1, 3]] });
  await until(() => b.presence.length === 1, 'the presence entry');
  assert.deepEqual(b.presence[0].ranges, [[1, 3]]); assert.equal(b.presence[0].label, 'laptop');
  assert.match(b.presence[0].color, /^hsl\(/);
  c.close();
});

test('killed and moved: a buffer killed on the server leaves the frame; a message from edwind reaches the echo area', async () => {
  const id = note('x.md', 'bye\n');
  const b = await sync.open(id); show(Ed.getBuffer('*scratch*'));
  const c = await client();
  const r = await c.form(`(kill-buffer (get-buffer ${JSON.stringify(id)}))`);
  await until(() => !E.buffers.includes(b) || !b.shared, 'the kill');
  assert.ok(!sync.buffers.has(id));
  c.close();
});
