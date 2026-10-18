// Crash safety (spec §16.1 edit-crash): SIGKILL under load with resend (R16.5), a journal torn at every byte
// offset (R16.6), and a full disk during save and journal append (R16.7, by fault injection: EDWIND_FAULT).
// CRASH_ROUNDS sets the number of kill points (default 1000, as R16.5 says; CRASH_SEED the generator seed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeDir, startEdwind, stopEdwind, EditClient, MAIN } from './edit-client.mts';
import { rng, randOp, Client as SimClient } from './ot-sim.mts';
import type { Msg } from './edit-client.mts';
import type { OTModule, Server, SimMsg } from './ot-sim.mts';

const require = createRequire(import.meta.url);
const OT = require('../src/ot.ts') as OTModule;
const { check, loadConfig, makeLog } = await import(MAIN) as typeof import('../server/main.mts');
const ROUNDS = Number(process.env.CRASH_ROUNDS || 1000);
const SEED = Number(process.env.CRASH_SEED || 7);
const quiet = makeLog('error');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const checkOk = (cfg: string) => { const lines: string[] = []; const ok = check(loadConfig(cfg), s => lines.push(s)); return { ok, lines }; };

/* A client of the real edwind with the replica logic of ot-sim's Client: local edits, inflight + queue,
   transformation of remote batches. The transport is the socket; reconnect() replays with open{since}. */
class LiveClient extends SimClient {
  declare buf: string; declare sockPath: string; declare conn: EditClient | null; declare versions: number[];
  declare trace?: string[]; declare replaying?: boolean; declare pumping?: Promise<void>; declare failure?: Error;
  constructor(cid: string, buf: string, text: string, ver: number, sock: string) {
    super(cid, { text, ver, out: new Map() } as Server, []);
    this.buf = buf; this.sockPath = sock; this.conn = null; this.versions = [];
  }
  send() { if (this.conn) this.conn.send({ t: 'edit', buf: this.buf, base: this.inflight!.base, seq: this.inflight!.seq, ops: this.inflight!.ops, undo: this.inflight!.undo }); }
  take(m: Msg) {
    (this.trace ||= []).push(`${m.t}@${m.ver}${m.t === 'ack' ? ' seq ' + m.seq : ' by ' + (m.by && (m.by.cid || m.by.kind))}${this.replaying ? ' (replay)' : ''}`); if (this.trace.length > 30) this.trace.shift();
    if (m.t === 'ack' && this.acks.has(m.seq)) return;
    if (m.t === 'ack' && (!this.inflight || m.seq !== this.inflight.seq)) return; // an ack of a batch replay already delivered
    this.versions.push(m.ver);
    this.recv(m as SimMsg);
  }
  async connect() {
    const c = new EditClient(this.sockPath, { cid: this.cid, kind: 'frame' });
    await c.connect(); const w = await c.hello(); assert.equal(w.t, 'welcome');
    this.conn = c;
    const rid = c.newRid();
    c.send({ t: 'open', rid, buf: this.buf, since: this.sver });
    for (;;) {
      const m = await c.next(x => x.rid === rid || (x.buf === this.buf && (x.t === 'edits' || x.t === 'ack')));
      if (m.t === 'error') throw new Error(`open: ${m.code} ${m.msg}`);
      if (m.t === 'snap') throw new Error(`snap for since=${this.sver}: the history lost acked batches`);
      if (m.t === 'opened') break;
      this.replaying = true; this.take(m); this.replaying = false;
    }
    this.pumping = (async () => { try { for (;;) { const m = await c.next(x => x.buf === this.buf && (x.t === 'edits' || x.t === 'ack' || x.t === 'error'), 3600000); if (m.t === 'error') throw new Error(`${m.code}: ${m.msg}`); this.take(m); } } catch (e) { if (c.closed) return; this.failure = e; } })();
    this.resend();
  }
  drop() { const c = this.conn; this.conn = null; if (c) c.close(); }
  get settled() { return !this.inflight && !this.queue.length; }
}

test('R16.5 SIGKILL at random points under a three-client load: acked batches survive, resends apply once, versions are continuous', { timeout: 3600000 }, async () => {
  const dir = makeDir();
  const r = rng(SEED);
  fs.writeFileSync(path.join(dir.dirs.notes, 'crash.md'), 'start\n');
  let child = await startEdwind(dir);
  const clients = [0, 1, 2].map(i => new LiveClient(`c${i}`.padEnd(8, '0') + i.toString(16).padStart(8, '0'), 'crash.md', 'start\n', 0, dir.cfg.socket));
  for (const c of clients) await c.connect();
  let kills = 0, batches = 0;
  try {
    for (let round = 0; round < ROUNDS; round++) {
      // Edit for a random while: each client makes small random ops as fast as the acks come back.
      const until = Date.now() + r.int(5, 65);
      while (Date.now() < until) {
        for (const c of clients) if (!c.inflight) { c.local([randOp(r, c.text)]); batches++; }
        await sleep(1);
      }
      // SIGKILL edwind now, mid-flight.
      child.kill('SIGKILL'); await stopEdwind(child); kills++;
      for (const c of clients) c.drop();
      { const after = checkOk(dir.file); assert.equal(after.ok, true, `edwind --check after the kill (round ${round}, state ${dir.root}):\n${after.lines.join('\n')}`); }
      child = await startEdwind(dir);
      for (const c of clients) await c.connect();
      // Let everything in flight settle, then compare.
      for (let i = 0; i < 5000 && !clients.every(c => c.settled); i++) await sleep(1);
      assert.ok(clients.every(c => c.settled), `every batch acked after the restart (round ${round}): ${JSON.stringify(clients.map(c => ({ cid: c.cid, sver: c.sver, inflight: c.inflight && c.inflight.seq, queue: c.queue.length, failure: c.failure && c.failure.message, trace: c.trace })), null, 1)}\n${child.logs.slice(-1500)}`);
      const probe = new EditClient(dir.cfg.socket); await probe.connect(); await probe.hello();
      const server = await probe.open('crash.md'); probe.close();
      for (const c of clients) {
        assert.equal(c.failure, undefined, `client ${c.cid}: ${c.failure && c.failure.message}`);
        assert.equal(c.text, server.text, `client ${c.cid} converged (round ${round})`);
        assert.equal(c.sver, server.ver);
        for (let i = 1; i < c.versions.length; i++) assert.equal(c.versions[i], c.versions[i - 1] + 1, `versions continuous at ${c.cid} (round ${round})`);
      }
    }
  } finally {
    for (const c of clients) c.drop();
    await stopEdwind(child);
  }
  assert.ok(batches > kills, `${batches} batches over ${kills} kills`);
  const { ok, lines } = checkOk(dir.file);
  assert.equal(ok, true, lines.join('\n'));
  fs.rmSync(dir.root, { recursive: true, force: true });
});

test('R16.5 SIGKILL between the steps of a compaction: the state checks and loads with every acked batch', { timeout: 120000 }, async () => {
  /* The compaction that moves the journal's base: a history past retention (more than 10,000 batches, two days
     old), so the retained history starts after the base and the save's compaction writes a new snapshot. The
     fault hook kills edwind after the snapshot is written, then after the journal is replaced. */
  const N = 10005, old = Date.now() - 2 * 24 * 3600 * 1000;
  for (const fault of ['kill-compact-snap', 'kill-compact-journal']) {
    const dir = makeDir();
    const file = path.join(dir.dirs.home, 'c.md'), id = '~/c.md';
    fs.writeFileSync(file, 'base\n');
    let child = await startEdwind(dir);
    try { const a = new EditClient(dir.cfg.socket); await a.connect(); await a.hello(); assert.equal((await a.open(id)).text, 'base\n'); a.close(); }
    finally { await stopEdwind(child); }
    const jdir = path.join(dir.dirs.state, 'buffers');
    const jfile = path.join(jdir, fs.readdirSync(jdir).find(f => f.endsWith('.jsonl'))!);
    let lines = '';
    for (let v = 1; v <= N; v++) lines += JSON.stringify({ t: 'b', ver: v, cid: null, seq: null, by: { kind: 'server' }, ops: [[0, '', 'x']], at: old + v }) + '\n';
    fs.appendFileSync(jfile, lines);
    const text = 'x'.repeat(N) + 'base\n';
    child = await startEdwind(dir, { env: { EDWIND_FAULT: fault } });
    try {
      const b = new EditClient(dir.cfg.socket); await b.connect(); await b.hello();
      const o = await b.open(id); assert.equal(o.text, text); assert.equal(o.ver, N);
      assert.equal((await b.edit(id, N, [[0, '', 'y']])).t, 'ack');
      const exited = new Promise(r => child.once('exit', r));
      b.send({ t: 'save', rid: 'save', buf: id });
      await Promise.race([exited, sleep(30000)]);
      b.close();
    } finally { await stopEdwind(child, 'SIGKILL'); }
    assert.equal(child.signalCode, 'SIGKILL', `${fault}: edwind was killed in the compaction:\n${child.logs.slice(-1500)}`);
    { const { ok, lines: out } = checkOk(dir.file); assert.equal(ok, true, `${fault}: edwind --check after the kill:\n${out.join('\n')}`); }
    child = await startEdwind(dir);
    try {
      const c = new EditClient(dir.cfg.socket); await c.connect(); await c.hello();
      const o = await c.open(id);
      assert.equal(o.meta!.readOnly, false, `${fault}: ${o.meta!.readOnly}`);
      assert.equal(o.text, 'y' + text, `${fault}: every acked batch is there`); assert.equal(o.ver, N + 1);
      assert.equal((await c.edit(id, N + 1, [[0, '', 'z']])).t, 'ack');
      assert.equal((await c.request({ t: 'save', buf: id })).value.saved, true, 'a later compaction goes through');
      c.close();
    } finally { await stopEdwind(child); }
    const { ok, lines: out } = checkOk(dir.file); assert.equal(ok, true, out.join('\n'));
    child = await startEdwind(dir);
    try {
      const d = new EditClient(dir.cfg.socket); await d.connect(); await d.hello();
      const o = await d.open(id); assert.equal(o.text, 'zy' + text); assert.equal(o.ver, N + 2); assert.equal(o.meta!.readOnly, false);
      d.close();
    } finally { await stopEdwind(child); }
    assert.deepEqual(fs.readdirSync(jdir).filter(f => !/\.(jsonl|snap|saved)$/.test(f)), [], `${fault}: no file but the journal, the snapshot and the saved copy is left`);
    fs.rmSync(dir.root, { recursive: true, force: true });
  }
});

test('R16.6 a journal truncated at every byte offset of its last line recovers to the last whole batch and logs it', { timeout: 3600000 }, async () => {
  const dir = makeDir();
  fs.writeFileSync(path.join(dir.dirs.notes, 'torn.md'), 'line\n');
  let child = await startEdwind(dir);
  const a = new EditClient(dir.cfg.socket); await a.connect(); await a.hello();
  await a.open('torn.md');
  const texts = ['line\n'];
  for (let i = 1; i <= 6; i++) { const ack = await a.edit('torn.md', i - 1, [[0, '', `b${i} 😀 `]]); assert.equal(ack.t, 'ack'); texts.push(`b${i} 😀 ` + texts[i - 1]); }
  a.close(); await stopEdwind(child);
  const jdir = path.join(dir.dirs.state, 'buffers');
  const jfile = path.join(jdir, fs.readdirSync(jdir).find(f => f.endsWith('.jsonl'))!);
  const pristine = fs.readFileSync(jfile);
  const lines = pristine.toString('utf8').split('\n'); assert.equal(lines.pop(), '');
  const lastStart = pristine.length - Buffer.byteLength(lines[lines.length - 1] + '\n');
  assert.equal(JSON.parse(lines[lines.length - 1]).ver, 6);
  let started = 0;
  for (let off = lastStart; off < pristine.length; off++) {
    fs.writeFileSync(jfile, pristine.subarray(0, off));
    const { ok, lines: out } = checkOk(dir.file);
    assert.equal(ok, true, `offset ${off}: ${out.join('\n')}`);
    if (off === pristine.length - 1) {
      assert.match(out[0], /ok, 6 batches, version 6$/, 'a whole last line without its newline counts');
      // The next batch starts a line of its own after it.
      child = await startEdwind(dir); started++;
      const b = new EditClient(dir.cfg.socket); await b.connect(); await b.hello();
      assert.equal((await b.open('torn.md')).ver, 6);
      assert.equal((await b.edit('torn.md', 6, [[0, '', 'b7 ']])).ver, 7);
      b.close(); await stopEdwind(child);
      const after = checkOk(dir.file);
      assert.equal(after.ok, true, after.lines.join('\n')); assert.match(after.lines[0], /ok, 7 batches, version 7$/, 'the batch after an unterminated line is whole on disk');
      fs.writeFileSync(jfile, pristine);
      continue;
    }
    assert.match(out[0], off === lastStart ? /ok, 5 batches, version 5$/ : /ok, 5 batches, version 5, torn last line dropped/, `offset ${off}`);
    // Every ninth offset, and the edges, also through a real start.
    if (off === lastStart || off === pristine.length - 2 || (off - lastStart) % 9 === 0) {
      child = await startEdwind(dir); started++;
      const b = new EditClient(dir.cfg.socket); await b.connect(); await b.hello();
      const o = await b.open('torn.md');
      assert.equal(o.text, texts[5]); assert.equal(o.ver, 5);
      assert.equal(o.meta!.readOnly, false);
      // A client that had the sixth batch acked... cannot exist: the ack came after the sync. One that sent it
      // and lost the ack resends, and the batch is applied afresh at version 6.
      const ack = await b.edit('torn.md', 5, [[0, '', 'b6 😀 ']]);
      assert.equal(ack.ver, 6); assert.equal((await b.open('torn.md')).text, texts[6]);
      b.close(); await stopEdwind(child);
      // The torn tail is cut off the file, so the batch acked after the restart is a whole line of it.
      const after = checkOk(dir.file);
      assert.equal(after.ok, true, `offset ${off}: ${after.lines.join('\n')}`);
      assert.match(after.lines[0], /ok, 6 batches, version 6$/, `offset ${off}: the batch acked after the restart is on disk`);
      if (off !== lastStart) assert.match(child.logs, /torn last journal line was dropped/, 'the truncation is logged');
      assert.match(child.logs, /reload \{"buf":"torn.md","ver":5,"batches":5\}/);
      fs.writeFileSync(jfile, pristine); // the run above re-journaled; restore for the next offset
    }
  }
  assert.ok(started >= 3);
  // Whole lines are never dropped: the pristine journal checks with 6 batches.
  fs.writeFileSync(jfile, pristine);
  assert.match(checkOk(dir.file).lines[0], /ok, 6 batches, version 6$/);
  fs.rmSync(dir.root, { recursive: true, force: true });
});

test('R16.6 an image log cut inside its last line takes the next form on a line of its own', async () => {
  const { ImageLog } = await import('../server/image.mts');
  const dir = makeDir(), file = path.join(dir.root, 'image.jsonl'), by = { kind: 'cli' as const };
  const line = (gen: number, form: string) => JSON.stringify({ t: 'form', gen, at: 1, by, form });
  const head = JSON.stringify({ t: 'epoch', epoch: 'e0', at: 1 }) + '\n' + line(1, '(define a 1)') + '\n';
  // A torn tail, and a whole line that lost only its newline.
  for (const [tail, kept] of [[line(2, '(define b 2)').slice(0, 30), []], [line(2, '(define b 2)'), ['(define b 2)']]] as const) {
    fs.writeFileSync(file, head + tail);
    new ImageLog(file).append('(define c 3)', by);
    assert.deepEqual(new ImageLog(file).entries.map(e => e.form), ['(define a 1)', ...kept, '(define c 3)'], tail);
  }
  fs.rmSync(dir.root, { recursive: true, force: true });
});

test('R16.7 a full disk during save: the client gets an error, the file keeps its old text, no temp file remains', async () => {
  const dir = makeDir();
  const file = path.join(dir.dirs.home, 'full.md'), id = '~/full.md';
  fs.writeFileSync(file, 'old\n');
  let child = await startEdwind(dir, { env: { EDWIND_FAULT: 'enospc-save' } });
  const a = new EditClient(dir.cfg.socket); await a.connect(); await a.hello();
  const o = await a.open(id); assert.equal(o.error, null);
  await a.edit(id, 0, [[0, '', 'new ']]);
  const r = await a.request({ t: 'save', buf: id });
  assert.equal(r.t, 'error'); assert.match(r.msg, /ENOSPC/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old\n');
  assert.deepEqual(fs.readdirSync(dir.dirs.home).filter(f => f.includes('edwind-')), [], 'the temp file is removed');
  const list = (await a.call('buffer-list')).value.find((b: Msg) => b.file === file);
  assert.equal(list.modified, true, 'the buffer stays modified');
  assert.equal((await a.open(id)).text, 'new old\n', 'nothing acked is lost');
  a.close(); await stopEdwind(child);
  // Space back: the save goes through, and the journal kept the edit across the restart.
  child = await startEdwind(dir);
  const b = new EditClient(dir.cfg.socket); await b.connect(); await b.hello();
  assert.equal((await b.open(id)).text, 'new old\n');
  assert.equal((await b.request({ t: 'save', buf: id })).value.saved, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new old\n');
  b.close(); await stopEdwind(child);
  fs.rmSync(dir.root, { recursive: true, force: true });
});

test('R16.7 a full disk during journal append: the edit is refused and rolled back, the buffer goes read-only until a save', async () => {
  const dir = makeDir();
  fs.writeFileSync(path.join(dir.dirs.notes, 'j.md'), 'text\n');
  let child = await startEdwind(dir);
  const a = new EditClient(dir.cfg.socket); await a.connect(); await a.hello();
  await a.open('j.md');
  assert.equal((await a.edit('j.md', 0, [[0, '', 'ok ']])).t, 'ack');
  a.close(); await stopEdwind(child);
  child = await startEdwind(dir, { env: { EDWIND_FAULT: 'enospc-journal' } });
  const b = new EditClient(dir.cfg.socket), c = new EditClient(dir.cfg.socket);
  await b.connect(); await b.hello(); await c.connect(); await c.hello();
  const o = await b.open('j.md'); assert.equal(o.text, 'ok text\n'); assert.equal(o.ver, 1); await c.open('j.md');
  // Two edits in one group commit: both are refused and both are rolled back, newest first.
  const [e, e2] = await Promise.all([b.edit('j.md', 1, [[0, '', 'lost ']]), c.edit('j.md', 1, [[3, '', 'gone ']])]);
  for (const x of [e, e2]) { assert.equal(x.t, 'error'); assert.equal(x.code, 'read_only'); assert.match(x.msg, /ENOSPC/); assert.equal(x.seq, 1); }
  const meta = await c.next(m => m.t === 'meta' && m.buf === 'j.md');
  assert.match(meta.readOnly, /journal write failed: ENOSPC/);
  assert.equal((await c.open('j.md')).text, 'ok text\n', 'the refused batches are not applied');
  assert.equal((await c.open('j.md')).ver, 1, 'the version did not move');
  assert.equal(c.queue.filter(m => m.t === 'edits').length, 0, 'no edits went out for them');
  assert.equal(b.queue.filter(m => m.t === 'edits').length, 0);
  // The resend of the refused batch is refused the same way (nothing was recorded for its seq).
  b.send({ t: 'edit', buf: 'j.md', base: 1, seq: 1, ops: [[0, '', 'lost ']] });
  assert.equal((await b.next(m => m.t === 'error' || m.t === 'ack')).code, 'read_only');
  // A save (which needs no journal append) clears the condition and compacts; the next append fails again
  // only because the fault is still injected, which is what a still-full disk does.
  const s = await b.request({ t: 'save', buf: 'j.md' });
  assert.equal(s.value.saved, true);
  const m2 = await c.next(m => m.t === 'meta' && m.buf === 'j.md' && m.readOnly === false);
  assert.equal(m2.readOnly, false);
  b.close(); c.close(); await stopEdwind(child);
  // With space again: the journal is whole and the buffer takes edits.
  child = await startEdwind(dir);
  assert.equal(checkOk(dir.file).ok, true);
  const d = new EditClient(dir.cfg.socket); await d.connect(); await d.hello();
  const o2 = await d.open('j.md'); assert.equal(o2.text, 'ok text\n'); assert.equal(o2.meta!.readOnly, false);
  assert.equal((await d.edit('j.md', o2.ver!, [[0, '', 'again ']])).t, 'ack');
  d.close(); await stopEdwind(child);
  fs.rmSync(dir.root, { recursive: true, force: true });
});

test('R16.7 a journal write that fails after its bytes landed is truncated, so a restart never replays a refused edit', async () => {
  const dir = makeDir();
  fs.writeFileSync(path.join(dir.dirs.notes, 'p.md'), 'text\n');
  let child = await startEdwind(dir);
  const a = new EditClient(dir.cfg.socket); await a.connect(); await a.hello();
  await a.open('p.md');
  assert.equal((await a.edit('p.md', 0, [[0, '', 'kept ']])).t, 'ack');
  a.close(); await stopEdwind(child);
  const jdir = path.join(dir.dirs.state, 'buffers');
  const jfile = path.join(jdir, fs.readdirSync(jdir).find(f => f.endsWith('.jsonl'))!);
  const before = fs.statSync(jfile).size;
  child = await startEdwind(dir, { env: { EDWIND_FAULT: 'enospc-journal-partial' } });
  const b = new EditClient(dir.cfg.socket); await b.connect(); await b.hello();
  assert.equal((await b.open('p.md')).text, 'kept text\n');
  const e = await b.edit('p.md', 1, [[0, '', 'refused ']]);
  assert.equal(e.code, 'read_only');
  b.close(); await stopEdwind(child);
  assert.equal(fs.statSync(jfile).size, before, 'the journal is back to its length before the failed group');
  const { ok, lines } = checkOk(dir.file);
  assert.equal(ok, true, lines.join('\n')); assert.match(lines[0], /ok, 1 batches, version 1$/);
  child = await startEdwind(dir);
  const c = new EditClient(dir.cfg.socket); await c.connect(); await c.hello();
  const o = await c.open('p.md');
  assert.equal(o.text, 'kept text\n'); assert.equal(o.ver, 1); assert.equal(o.meta!.readOnly, false);
  c.close(); await stopEdwind(child);
  fs.rmSync(dir.root, { recursive: true, force: true });
});
