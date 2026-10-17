// Disk changes (spec §16.1 edit-disk, R8.12–R8.15): external writes revert an unmodified buffer as one batch by
// disk, merge three ways into a modified one, mark a conflict or a deletion, keep CRLF across a round trip, and
// edwind's own saves never count as external changes. Files live under the test home (not notesDir), so the
// 2 s autosave does not interfere; the watcher reacts to inotify events (fs.watch), the sweep is 10 s.
// Renames through edwind (rename-file, R4.49, R6.1, R8.1, §7 moved) are here too: the buffers follow the file,
// clients get moved, the journal and the moved records survive a restart, and the watcher sees no deletion.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeDir, startEdwind, stopEdwind, EditClient } from './edit-client.mts';
import type { Msg, TestDir, EdwindChild } from './edit-client.mts';
import type { EditOp } from './ot-sim.mts';

let dir: TestDir, child: EdwindChild;
before(async () => { dir = makeDir(); child = await startEdwind(dir); });
after(async () => { await stopEdwind(child); fs.rmSync(dir.root, { recursive: true, force: true }); });

const client = async () => { const c = new EditClient(dir.cfg.socket); await c.connect(); assert.equal((await c.hello()).t, 'welcome'); return c; };
/* A file under the test home: {p: its path, id: its canonical buffer id (R6.1), which every message carries}. */
const file = (name: string, text: string) => { const p = path.join(dir.dirs.home, name); fs.writeFileSync(p, text); return { p, id: '~/' + name }; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/* Write FILE from outside edwind: a different inode and mtime, as an editor or git would. */
const externalWrite = (p: string, text: string) => { const tmp = p + '.ext'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, p); };

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
  const touched = ed.ops.reduce((n: number, [, del, ins]: EditOp) => n + del.length + ins.length, 0);
  assert.ok(touched <= 12, `small ops: ${JSON.stringify(ed.ops)}`);
  const now = await a.open(id);
  assert.equal(now.text, 'one\n2\nthree\nfour\n'); assert.equal(now.meta!.modified, false); assert.equal(now.meta!.diskChanged, null);
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
  assert.equal(now.meta!.modified, true, 'ours is still unsaved');
  assert.equal(now.meta!.diskChanged, null);
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
  assert.equal(now.text, 'x\ntheirs\nz\n'); assert.equal(now.meta!.diskChanged, null); assert.equal(now.meta!.modified, false);
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
  assert.equal(o.text, 'one\ntwo\n'); assert.equal(o.meta!.eol, 'crlf');
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
  const now = await a.open(id); assert.equal(now.ver, 1); assert.equal(now.meta!.modified, false);
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

/* rename-file as POST /api/mv sends it: {src, dst}. */
const rename = (c: EditClient, src: string, dst: string) => c.call('rename-file', [{ src, dst }]);

test('R6.1 rename-file: the buffer takes the new id, attached clients get moved and keep editing, the watcher sees no deletion', async () => {
  const { p, id } = file('mv-a.md', 'alpha\n');
  const a = await client(), b = await client();
  const o = await a.open(id); await b.open(id);
  await a.edit(id, o.ver!, [[0, '', 'unsaved ']]);
  const dst = path.join(dir.dirs.home, 'mv-b.md');
  const r = await rename(b, p, dst);
  assert.equal(r.t, 'result', JSON.stringify(r));
  assert.deepEqual(r.value, { ok: true, src: p, dst, from: id, to: '~/mv-b.md' });
  for (const c of [a, b]) assert.deepEqual(await c.next(m => m.t === 'moved'), { t: 'moved', buf: id, to: '~/mv-b.md' });
  assert.equal(fs.existsSync(p), false); assert.equal(fs.readFileSync(dst, 'utf8'), 'alpha\n', 'the file moved, unsaved edits stay in the buffer');
  // An edit still addressed to the old id (sent before the client read moved) lands on the moved buffer.
  const ack = await a.edit(id, 1, [[0, '', '1 ']]);
  assert.equal(ack.t, 'ack'); assert.equal(ack.buf, '~/mv-b.md'); assert.equal(ack.ver, 2);
  const now = await b.open('~/mv-b.md');
  assert.equal(now.text, '1 unsaved alpha\n'); assert.equal(now.ver, 2); assert.equal(now.meta!.file, dst);
  // Past the watcher's debounce: no deletion and no disk batch for edwind's own rename (R8.15).
  await sleep(600);
  assert.equal(now.meta!.diskChanged, null);
  for (const c of [a, b]) {
    assert.equal(c.queue.filter(m => m.t === 'meta' && m.diskChanged).length, 0, 'no diskChanged meta');
    assert.equal(c.queue.filter(m => m.t === 'edits' && m.by && m.by.kind === 'disk').length, 0, 'no disk batch');
  }
  // A client opening the old id is sent on; a save writes the new path.
  const c = await client();
  assert.equal((await c.open(id)).moved, '~/mv-b.md');
  assert.equal((await c.request({ t: 'save', buf: '~/mv-b.md' })).value.saved, true);
  assert.equal(fs.readFileSync(dst, 'utf8'), '1 unsaved alpha\n'); assert.equal(fs.existsSync(p), false);
  // A new file at the old path is that file again, not the moved one.
  fs.writeFileSync(p, 'new alpha\n');
  assert.equal((await c.open(id)).text, 'new alpha\n');
  a.close(); b.close(); c.close();
});

test('R6.1 rename-file never replaces: an existing destination, or one a buffer visits, is refused; a directory destination takes the file inside', async () => {
  const { p } = file('nr-a.md', 'A\n');
  const { p: q } = file('nr-b.md', 'B\n');
  const a = await client();
  const r = await rename(a, p, q);
  assert.equal(r.t, 'error'); assert.equal(r.code, 'bad_request'); assert.equal(r.msg, 'destination exists');
  assert.equal(fs.readFileSync(p, 'utf8'), 'A\n'); assert.equal(fs.readFileSync(q, 'utf8'), 'B\n');
  // A buffer made for a file that is not on disk yet holds its name.
  assert.equal((await a.open('~/nr-new.md', { create: true })).error, null);
  const r2 = await rename(a, p, path.join(dir.dirs.home, 'nr-new.md'));
  assert.equal(r2.msg, 'destination exists'); assert.equal(fs.existsSync(path.join(dir.dirs.home, 'nr-new.md')), false);
  fs.mkdirSync(path.join(dir.dirs.home, 'nr-dir'));
  const r3 = await rename(a, '~/nr-a.md', '~/nr-dir');
  assert.equal(r3.value.dst, path.join(dir.dirs.home, 'nr-dir/nr-a.md')); assert.equal(r3.value.to, '~/nr-dir/nr-a.md');
  assert.equal(fs.readFileSync(path.join(dir.dirs.home, 'nr-dir/nr-a.md'), 'utf8'), 'A\n');
  const missing = await rename(a, '~/nr-missing.md', '~/nr-x.md');
  assert.equal(missing.t, 'error'); assert.match(missing.msg, /^ENOENT/);
  a.close();
});

test('R6.1 rename-file of a directory: buffers under it follow, ids of files not loaded are sent on, the notes index moves', async () => {
  const sub = path.join(dir.dirs.notes, 'proj');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'one.md'), '# One\n\n[[two]]\n');
  fs.writeFileSync(path.join(sub, 'two.md'), '# Two\n');
  const a = await client();
  const ids = async () => (await a.call('notes-nodes', [{ limit: 20000 }])).value.nodes.map((n: Msg) => n.id).filter((x: string) => /^(proj|archive)\/[^#]*$/.test(x)).sort();
  for (let i = 0; i < 100 && (await ids()).length < 2; i++) await sleep(50);
  assert.deepEqual(await ids(), ['proj/one.md', 'proj/two.md']);
  await a.open('proj/one.md');
  const r = await rename(a, 'proj', 'archive');
  assert.deepEqual(r.value, { ok: true, src: sub, dst: path.join(dir.dirs.notes, 'archive'), from: 'proj', to: 'archive', dir: true });
  assert.deepEqual(await a.next(m => m.t === 'moved'), { t: 'moved', buf: 'proj/one.md', to: 'archive/one.md' });
  assert.equal((await a.open('archive/one.md')).text, '# One\n\n[[two]]\n');
  // two.md was never loaded: its old id is sent on by the directory's record.
  assert.equal((await a.open('proj/two.md')).moved, 'archive/two.md');
  for (let i = 0; i < 100 && (await ids()).join() !== 'archive/one.md,archive/two.md'; i++) await sleep(50);
  assert.deepEqual(await ids(), ['archive/one.md', 'archive/two.md']);
  a.close();
});

test('R6.1 a directory\'s moved record sends on only files that went with it: a new note under the old name is made there', async () => {
  const a = await client();
  fs.mkdirSync(path.join(dir.dirs.notes, 'daily'));
  fs.writeFileSync(path.join(dir.dirs.notes, 'daily', 'old.md'), 'old\n');
  assert.equal((await rename(a, 'daily', 'archive-daily')).value.dir, true);
  // A file that went with the directory is sent on.
  assert.equal((await a.open('daily/old.md')).moved, 'archive-daily/old.md');
  // A new note while the old directory is gone: made at the old path (the directory again), not in the moved one.
  const n1 = await a.open('daily/new1.md', { create: true });
  assert.equal(n1.moved, null); assert.equal(n1.error, null); assert.equal(n1.meta!.file, path.join(dir.dirs.notes, 'daily', 'new1.md'));
  assert.equal(fs.existsSync(path.join(dir.dirs.notes, 'archive-daily', 'new1.md')), false);
  // The directory is there again: nothing under it is sent on, not even a name the moved directory holds.
  const n2 = await a.open('daily/new2.md', { create: true });
  assert.equal(n2.moved, null); assert.equal(n2.meta!.file, path.join(dir.dirs.notes, 'daily', 'new2.md'));
  assert.equal((await a.open('daily/old.md', { create: true })).moved, null);
  // server-edit of a new path there neither returns at once nor goes to the moved directory.
  assert.deepEqual((await a.call('server-edit', ['daily/new3.md'], {})).value, { buf: 'daily/new3.md', exit: null });
  a.close();
});

test('R6.1 a write that lands just before a rename is not lost: the buffer still sees the file changed', async () => {
  const { p, id } = file('ext-a.md', 'one\n');
  const a = await client();
  await a.open(id);
  await sleep(200);
  externalWrite(p, 'two\n');
  const r = await rename(a, id, '~/ext-b.md');   // before the watcher's 50 ms debounce
  assert.equal(r.t, 'result', JSON.stringify(r));
  await a.next(m => m.t === 'moved');
  const ed = await a.next(m => m.t === 'edits' && m.buf === '~/ext-b.md', 3000);
  assert.deepEqual(ed.by, { kind: 'disk' });
  const now = await a.open('~/ext-b.md');
  assert.equal(now.text, 'two\n'); assert.equal(now.meta!.diskChanged, null);
  a.close();
});

test('R6.1 an old id after a rename: server-edit waits on the moved buffer; with a new file at the old path, visit-id and kill-buffer name that file', async () => {
  const { p, id } = file('se-a.md', 'alpha\n');
  const a = await client(), b = await client();
  const o = await a.open(id);
  await a.edit(id, o.ver!, [[0, '', 'UNSAVED ']]);
  assert.equal((await rename(a, id, '~/se-b.md')).t, 'result');
  // wb edit --wait with the old path waits for done on the buffer where the file is now.
  const rid = b.newRid();
  b.send({ t: 'call', rid, cmd: 'server-edit', args: [id], ctx: { wait: true } });
  await sleep(300);
  assert.equal(b.queue.some(m => m.rid === rid), false, 'server-edit --wait returned before done');
  await a.call('server-edit-done', ['~/se-b.md']);
  assert.deepEqual((await b.next(m => m.rid === rid)).value, { buf: '~/se-b.md', exit: 0 });
  assert.equal(fs.readFileSync(path.join(dir.dirs.home, 'se-b.md'), 'utf8'), 'UNSAVED alpha\n');
  a.seqs.set('~/se-b.md', a.seqs.get(id)!);   // the same buffer: its seqs go on
  const ag = await a.edit('~/se-b.md', 1, [[0, '', 'AGAIN ']]);
  assert.equal(ag.t, 'ack', JSON.stringify(ag));
  // A new file at the old path, not loaded: commands naming the old id are about it, not the moved buffer.
  fs.writeFileSync(p, 'new alpha\n');
  const c = await client();
  assert.deepEqual((await c.call('visit-id', [id])).value, { buf: id, readOnly: false });
  const k = await c.call('kill-buffer', [id]);
  assert.equal(k.t, 'error'); assert.equal(k.code, 'no_buffer');
  const still = await c.open('~/se-b.md');
  assert.equal(still.text, 'AGAIN UNSAVED alpha\n', 'the moved buffer and its unsaved edit stay');
  a.close(); b.close(); c.close();
});

test('R8.1 a rename survives a restart: the mv journal line gives the id and file, the moved record still sends old ids on', async () => {
  const d2 = makeDir();
  let e2 = await startEdwind(d2);
  try {
    const p = path.join(d2.dirs.home, 'rs-a.md');
    fs.writeFileSync(p, 'before\n');
    const c = new EditClient(d2.cfg.socket); await c.connect(); await c.hello();
    const o = await c.open('~/rs-a.md');
    await c.edit('~/rs-a.md', o.ver!, [[0, '', 'journaled ']]);
    assert.equal((await rename(c, '~/rs-a.md', '~/rs-b.md')).t, 'result');
    c.close();
    await stopEdwind(e2); e2 = await startEdwind(d2);
    const c2 = new EditClient(d2.cfg.socket); await c2.connect(); await c2.hello();
    const n = await c2.open('~/rs-b.md');
    assert.equal(n.error, null); assert.equal(n.text, 'journaled before\n', 'the unsaved edit replayed onto the moved buffer');
    assert.equal(n.meta!.file, path.join(d2.dirs.home, 'rs-b.md')); assert.equal(n.meta!.diskChanged, null);
    assert.equal((await c2.open('~/rs-a.md')).moved, '~/rs-b.md');
    assert.equal(fs.existsSync(p), false, 'the old path stays empty');
    c2.close();
  } finally { await stopEdwind(e2); fs.rmSync(d2.root, { recursive: true, force: true }); }
});

test('R8.1 a rename whose mv journal line failed (a full disk) still reloads the buffer on the moved file, not at the old path', async () => {
  const d2 = makeDir();
  let e2 = await startEdwind(d2);
  try {
    const p = path.join(d2.dirs.home, 'fd-a.md'), q = path.join(d2.dirs.home, 'fd-b.md');
    fs.writeFileSync(p, 'before\n');
    let c = new EditClient(d2.cfg.socket); await c.connect(); await c.hello();
    const o = await c.open('~/fd-a.md');
    await c.edit('~/fd-a.md', o.ver!, [[0, '', 'journaled ']]);
    c.close(); await stopEdwind(e2);
    e2 = await startEdwind(d2, { env: { EDWIND_FAULT: 'enospc-journal' } });
    c = new EditClient(d2.cfg.socket); await c.connect(); await c.hello();
    assert.equal((await rename(c, '~/fd-a.md', '~/fd-b.md')).t, 'result');
    c.close(); await stopEdwind(e2);
    e2 = await startEdwind(d2);
    c = new EditClient(d2.cfg.socket); await c.connect(); await c.hello();
    const n = await c.open('~/fd-b.md');
    assert.equal(n.error, null); assert.equal(n.text, 'journaled before\n', 'the unsaved edit is on the moved buffer');
    assert.equal(n.meta!.file, q); assert.equal(n.meta!.modified, true);
    assert.equal((await c.open('~/fd-a.md')).moved, '~/fd-b.md');
    assert.equal(fs.existsSync(p), false);
    assert.equal((await c.request({ t: 'save', buf: '~/fd-b.md' })).value.saved, true);
    assert.equal(fs.readFileSync(q, 'utf8'), 'journaled before\n'); assert.equal(fs.existsSync(p), false, 'no copy at the old path');
    c.close();
    // The mv line written at that reload holds on the next one.
    await stopEdwind(e2); e2 = await startEdwind(d2);
    c = new EditClient(d2.cfg.socket); await c.connect(); await c.hello();
    assert.equal((await c.open('~/fd-b.md')).meta!.file, q);
    c.close();
  } finally { await stopEdwind(e2); fs.rmSync(d2.root, { recursive: true, force: true }); }
});
