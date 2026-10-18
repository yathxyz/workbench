// OT properties (spec §16.2, R16.1–R16.4) over edwin/src/ot.ts: convergence of random replicas,
// intention cases, marker agreement and undo. The scenarios come from a seeded generator, so a failing
// case is one integer; those go to ot-seeds.json and are replayed forever (R16.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { rng, randText, randOp, Server, Client, session } from './ot-sim.mts';
import type { OTModule, EditOp, SimBatch, UndoBatch } from './ot-sim.mts';

const require = createRequire(import.meta.url);
// fast-check is a dev dependency pinned in tools/package-lock.json (R15.1); NODE_PATH names its node_modules.
const fc = require('fast-check'); // any: fast-check's types are not resolvable from edwin/ (it lives in tools/node_modules)
const OT = require('../src/ot.ts') as OTModule;
const SEEDS: number[] = JSON.parse(readFileSync(new URL('./ot-seeds.json', import.meta.url), 'utf8'));
const RUNS = Number(process.env.OT_RUNS || 10000);

const seeds = fc.integer({ min: 1, max: 2 ** 31 - 1 });
const params = { numRuns: RUNS, examples: SEEDS.map(s => [s]), seed: Number(process.env.OT_SEED || 0) || undefined, verbose: 1 };

test('R16.1 convergence: every replica ends with the server text', () => {
  fc.assert(fc.property(seeds, (seed: number) => {
    const { server, clients } = session(seed);
    for (const c of clients) {
      assert.equal(c.inflight, null, `seed ${seed}: an edit never acked`);
      assert.equal(c.text, server.text, `seed ${seed}: ${c.cid} diverged`);
      assert.equal(OT.hash(c.text), OT.hash(server.text));
    }
    // Version numbers are continuous.
    server.hist.forEach((b, i) => assert.equal(b.ver, i + 1));
  }), params);
});

/* A marker's position is not a function of the text alone when a concurrent insert lands exactly where a
   deletion collapsed the range the marker stood at or next to: which side of the insert it ends on then
   depends on the order the two replicas applied them (an after marker at the start of a deleted range, a
   before marker at its end). So the property holds for markers no deletion reached; a marker a deletion
   covered is dead in Edwin's sense and skipped as well. Recorded in edwin/README.md (E1). */
test('R16.3 markers: markers no deletion reached agree between every replica and the server', () => {
  fc.assert(fc.property(seeds, (seed: number) => {
    const { server, clients } = session(seed);
    server.markers.forEach((m, i) => {
      for (const c of clients) {
        const cm = c.markers[i];
        if (m.dead || cm.dead || m.touched || cm.touched) continue;
        assert.equal(cm.pos, m.pos, `seed ${seed}: marker ${i} (${m.type}) at ${cm.pos} in ${c.cid}, ${m.pos} on the server; text ${JSON.stringify(server.text)}`);
      }
    });
  }), params);
});

test('R16.2 intention: same-position inserts order by sequence', () => {
  const t = 'ab';
  const [seqp, incp] = OT.transformOps([[1, '', 'X']], [[1, '', 'Y']], t);
  assert.equal(OT.apply(OT.apply(t, [[1, '', 'X']]), incp), 'aXYb');
  assert.equal(OT.apply(OT.apply(t, [[1, '', 'Y']]), seqp), 'aXYb');
});
test('R16.2 intention: overlapping deletes remove the union once, del recomputed', () => {
  const t = 'abcdef';
  const [seqp, incp] = OT.transformOps([[1, 'bcd', '']], [[2, 'cde', '']], t);
  assert.deepEqual(incp, [[1, 'e', '']]);
  assert.deepEqual(seqp, [[1, 'b', '']]);
  assert.equal(OT.apply(OT.apply(t, [[1, 'bcd', '']]), incp), 'af');
});
test('R16.2 intention: an insert inside a concurrently deleted range survives at its start', () => {
  const t = 'abcdef';
  const [seqp, incp] = OT.transformOps([[1, 'bcde', '']], [[3, '', 'XY']], t);
  assert.deepEqual(incp, [[1, '', 'XY']]);
  assert.equal(OT.apply(OT.apply(t, [[1, 'bcde', '']]), incp), 'aXYf');
  assert.equal(OT.apply(OT.apply(t, [[3, '', 'XY']]), seqp), 'aXYf');
});
test('R7.7, R7.8: bad edits are refused', () => {
  assert.throws(() => OT.apply('abc', [[1, 'x', '']]), (e: Error & { code?: string }) => e.code === 'bad_edit');
  assert.throws(() => OT.apply('abc', [[4, '', 'x']]), (e: Error & { code?: string }) => e.code === 'bad_edit');
  assert.throws(() => OT.apply('a😀b', [[2, '', 'x']]), (e: Error & { code?: string }) => e.code === 'bad_edit');
  assert.throws(() => OT.apply('a😀b', [[1, '\uD83D', '']]), (e: Error & { code?: string }) => e.code === 'bad_edit');
  assert.equal(OT.apply('a😀b', [[1, '😀', '🧪']]), 'a🧪b');
});
test('R7.14 hash: FNV-1a over UTF-16 units, the same for a rope', () => {
  assert.equal(OT.hash(''), 0x811c9dc5);
  assert.equal(OT.hash('a'), ((0x811c9dc5 ^ 0x61) * 0x01000193) >>> 0);
  assert.equal(OT.hash({ ch: ['hel', 'lo 😀'] }), OT.hash('hello 😀'));
});
test('R6.16 invert', () => {
  const ops: EditOp[] = [[0, '', 'ab'], [1, 'b', 'c']];
  const t = OT.apply('xy', ops);
  assert.equal(OT.apply(t, OT.invert(ops)), 'xy');
});

/* R16.4: writers A and B edit their own zones of one document; undoing all of A's groups through the
   server's history gives B's result on the original A text, and never a bad_edit. */
test('R16.4 undo: undoing one writer restores the other writers’ text', () => {
  fc.assert(fc.property(seeds, (seed: number) => {
    const r = rng(seed);
    const SEP = '\n====\n';
    const aText = randText(r, r.int(1, 15)), bText = randText(r, r.int(1, 15));
    const text = aText + SEP + bText;
    const server = new Server(text, []);
    const A = new Client('A', server, []), B = new Client('B', server, []);
    const clients = [A, B];
    // Each writer's zone end is a marker: before type for A (its zone ends at the separator), after for B's start.
    const zones: Record<string, { lo: (c: Client) => number; hi: (c: Client) => number }> = { A: { lo: () => 0, hi: c => zoneEnd(c) }, B: { lo: c => zoneStart(c), hi: c => c.text.length } };
    const zoneEnd = (c: Client) => c.text.indexOf(SEP), zoneStart = (c: Client) => c.text.indexOf(SEP) + SEP.length;
    let groups = 0, n = r.int(1, 12);
    const drain = () => { while (clients.some(c => c.inbox.length)) { const c = r.pick(clients); if (c.inbox.length) c.recv(c.inbox.shift()!); } };
    while (groups < n) {
      const c = r.pick(clients), z = zones[c.cid];
      const lo = z.lo(c), hi = z.hi(c);
      if (hi <= lo && r.next() < 0.5) { if (c.inbox.length) c.recv(c.inbox.shift()!); continue; }
      const op = randOp(r, c.text, [lo, Math.max(lo, hi)]);
      c.local([op], false, { g: 'g' + groups }); groups++;
      if (r.next() < 0.5) { const d = r.pick(clients); if (d.inbox.length) d.recv(d.inbox.shift()!); }
    }
    drain();
    assert.equal(A.text, server.text); assert.equal(B.text, server.text);
    const before = server.text;
    // Undo every A batch, newest first, as the server command does (R6.19), each as a new batch by A.
    const aBatches = server.hist.filter(b => b.cid === 'A' && b.undo!.of === undefined);
    const undone: SimBatch[] = [];
    for (let i = aBatches.length - 1; i >= 0; i--) {
      const g = aBatches[i];
      const history = server.hist.filter(b => b.ver >= g.ver);
      const u = OT.undoOps({ cid: 'A', g: g.undo!.g }, history, server.text);
      const ops = OT.toOps(u.op, server.text);
      assert.doesNotThrow(() => OT.apply(server.text, ops), 'undo produced a bad edit');
      server.edit('A', { base: server.ver, seq: ++A.seq, ops, undo: { g: 'u' + i, of: g.undo!.g } });
      undone.push(server.hist[server.hist.length - 1]);
    }
    const expect = aText + SEP + server.text.slice(server.text.indexOf(SEP) + SEP.length);
    assert.equal(server.text, expect, `seed ${seed}`);
    // Redo: undo the undo batches, newest first.
    for (let i = undone.length - 1; i >= 0; i--) {
      const g = undone[i];
      const history = server.hist.filter(b => b.ver >= g.ver);
      const ops = OT.toOps(OT.undoOps({ cid: 'A', g: g.undo!.g }, history, server.text).op, server.text);
      server.edit('A', { base: server.ver, seq: ++A.seq, ops, undo: { g: 'r' + i, of: g.undo!.g } });
    }
    assert.equal(server.text, before, `seed ${seed}: redo`);
  }), params);
});

test('R6.17 partial undo: text another writer removed is skipped and reported', () => {
  // A inserts "XYZ"; B deletes the "Y"; undoing A's insert removes "XZ" and is partial.
  const g: UndoBatch = { ver: 1, ops: [[1, '', 'XYZ']], cid: 'A', undo: { g: 1 } };
  const u = OT.undoOps({ cid: 'A', g: 1 }, [g, { ver: 2, ops: [[2, 'Y', '']], cid: 'B', undo: { g: 1 } }], 'aXZb');
  assert.equal(u.partial, true);
  assert.equal(OT.applyOperation('aXZb', u.op), 'ab');
  const v = OT.undoOps({ cid: 'A', g: 1 }, [g], 'aXYZb');
  assert.equal(v.partial, false);
  assert.equal(OT.applyOperation('aXYZb', v.op), 'ab');
});
