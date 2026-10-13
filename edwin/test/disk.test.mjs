// Disk changes (spec §16.1 edit-disk, R8.12–R8.15): external writes revert an unmodified buffer as one batch by
// disk, merge three ways into a modified one, mark a conflict or a deletion, keep CRLF across a round trip, and
// edwind's own saves never count as external changes. Files live under the test home (not notesDir), so the
// 2 s autosave does not interfere; the watcher reacts to inotify events (fs.watch), the sweep is 10 s.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeDir, startEdwind, stopEdwind, EditClient } from './edit-client.mjs';

let dir, child;
before(async () => { dir = makeDir(); child = await startEdwind(dir); });
after(async () => { await stopEdwind(child); fs.rmSync(dir.root, { recursive: true, force: true }); });

const client = async () => { const c = new EditClient(dir.cfg.socket); await c.connect(); assert.equal((await c.hello()).t, 'welcome'); return c; };
/* A file under the test home: {p: its path, id: its canonical buffer id (R6.1), which every message carries}. */
const file = (name, text) => { const p = path.join(dir.dirs.home, name); fs.writeFileSync(p, text); return { p, id: '~/' + name }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* Write FILE from outside edwind: a different inode and mtime, as an editor or git would. */
const externalWrite = (p, text) => { const tmp = p + '.ext'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, p); };

test('R8.12 an external write to an unmodified buffer reverts it in place as one batch by disk', async () => {
  const { p, id } = file('r.md', 'one\ntwo\nthree\n');
  const a = await client(), b = await client();
  const o = await a.open(id); await b.open(id);
  assert.equal(o.text, 'one\ntwo\nthree\n');
  externalWrite(p, 'one\n2\nthree\nfour\n');
  const ed = await a.next(m => m.t === 'edits' && m.buf === id);
  assert.deepEqual(ed.by, { kind: 'disk' });
  assert.equal(ed.ver, 1);
  const ed2 = await b.next(m => m.t === 'edits' && m.buf === id);
  assert.deepEqual(ed2.ops, ed.ops);
  // A line-then-character diff: the untouched lines are not rewritten.
  const touched = ed.ops.reduce((n, [, del, ins]) => n + del.length + ins.length, 0);
  assert.ok(touched <= 12, `small ops: ${JSON.stringify(ed.ops)}`);
  const now = await a.open(id);
  assert.equal(now.text, 'one\n2\nthree\nfour\n'); assert.equal(now.meta.modified, false); assert.equal(now.meta.diskChanged, null);
  a.close(); b.close();
});

test('R8.13 an external write to a modified buffer merges three ways when the hunks do not overlap', async () => {
  const { p, id } = file('m.md', 'a\nb\nc\nd\ne\nf\ng\nh\n');
  const a = await client();
  await a.open(id);
  await a.edit(id, 0, [[0, 'a', 'A']]);
  externalWrite(p, 'a\nb\nc\nd\ne\nf\ng\nH\n');
  const ed = await a.next(m => m.t === 'edits' && m.buf === id);
  assert.deepEqual(ed.by, { kind: 'disk' });
  const now = await a.open(id);
  assert.equal(now.text, 'A\nb\nc\nd\ne\nf\ng\nH\n');
  assert.equal(now.meta.modified, true, 'ours is still unsaved');
  assert.equal(now.meta.diskChanged, null);
  // Saving writes the merged text and the next merge base is that.
  assert.equal((await a.request({ t: 'save', buf: id })).value.saved, true);
  assert.equal(fs.readFileSync(p, 'utf8'), 'A\nb\nc\nd\ne\nf\ng\nH\n');
  a.close();
});

test('R8.13 overlapping hunks are not merged: diskChanged = conflict; revert takes the disk text', async () => {
  const { p, id } = file('c.md', 'x\ny\nz\n');
  const a = await client();
  await a.open(id);
  await a.edit(id, 0, [[2, 'y', 'ours']]);
  externalWrite(p, 'x\ntheirs\nz\n');
  const meta = await a.next(m => m.t === 'meta' && m.buf === id && m.diskChanged === 'conflict');
  assert.equal(meta.modified, true);
  assert.equal((await a.open(id)).text, 'x\nours\nz\n', 'the buffer keeps ours');
  const rv = await a.request({ t: 'revert', buf: id });
  assert.equal(rv.t, 'result');
  const now = await a.open(id);
  assert.equal(now.text, 'x\ntheirs\nz\n'); assert.equal(now.meta.diskChanged, null); assert.equal(now.meta.modified, false);
  a.close();
});

test('R8.14 a deleted file keeps its buffer, marks deleted, and a save recreates it', async () => {
  const { p, id } = file('d.md', 'keep\n');
  const a = await client();
  await a.open(id);
  fs.unlinkSync(p);
  const meta = await a.next(m => m.t === 'meta' && m.buf === id && m.diskChanged === 'deleted');
  assert.equal(meta.diskChanged, 'deleted');
  assert.equal((await a.open(id)).text, 'keep\n');
  assert.equal((await a.request({ t: 'save', buf: id })).value.saved, true);
  assert.equal(fs.readFileSync(p, 'utf8'), 'keep\n');
  assert.equal(fs.statSync(p).mode & 0o777, 0o600, 'a new file is 0600');
  const after = await a.next(m => m.t === 'meta' && m.buf === id && m.diskChanged === null);
  assert.equal(after.modified, false);
  a.close();
});

test('R8.9 CRLF round trip: LF inside, eol crlf in meta, CRLF written back; the trailing newline policy follows the file', async () => {
  const { p, id } = file('crlf.txt', 'one\r\ntwo\r\n');
  const a = await client();
  const o = await a.open(id);
  assert.equal(o.text, 'one\ntwo\n'); assert.equal(o.meta.eol, 'crlf');
  await a.edit(id, 0, [[4, '', 'and a half\n']]);
  await a.request({ t: 'save', buf: id });
  assert.equal(fs.readFileSync(p, 'utf8'), 'one\r\nand a half\r\ntwo\r\n');
  const { p: q, id: qid } = file('nonl.txt', 'no newline');
  const o2 = await a.open(qid); assert.equal(o2.text, 'no newline');
  await a.edit(qid, 0, [[0, '', 'still ']]);
  await a.request({ t: 'save', buf: qid });
  assert.equal(fs.readFileSync(q, 'utf8'), 'still no newline');
  a.close();
});

test('R8.15 edwind\'s own saves never read back as disk changes; an identical external rewrite is ignored too', async () => {
  const { p, id } = file('own.md', 'mine\n');
  const a = await client();
  await a.open(id);
  await a.edit(id, 0, [[0, '', 'all ']]);
  await a.request({ t: 'save', buf: id });
  // An external rewrite with the same content: a new inode and mtime, the same hash.
  externalWrite(p, 'all mine\n');
  await sleep(600);
  assert.equal(a.queue.filter(m => m.t === 'edits').length, 0, 'no disk batch');
  assert.equal(a.queue.filter(m => m.t === 'meta' && m.diskChanged).length, 0);
  const now = await a.open(id); assert.equal(now.ver, 1); assert.equal(now.meta.modified, false);
  a.close();
});

test('R8.7 a save is atomic: a reader never sees a partial file, and the mode bits survive', async () => {
  const { p, id } = file('atomic.md', 'short\n');
  fs.chmodSync(p, 0o640);
  const a = await client();
  await a.open(id);
  const big = 'x'.repeat(3 * 1024 * 1024) + '\n';
  await a.edit(id, 0, [[0, '', big]]);
  let partial = false, stop = false;
  const reader = (async () => { while (!stop) { const s = fs.readFileSync(p, 'utf8'); if (s !== 'short\n' && s !== big + 'short\n') partial = true; await sleep(0); } })();
  await a.request({ t: 'save', buf: id });
  stop = true; await reader;
  assert.equal(partial, false);
  assert.equal(fs.statSync(p).mode & 0o777, 0o640);
  assert.equal(fs.statSync(p).size, big.length + 6);
  a.close();
});
