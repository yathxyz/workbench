// Anchors and the frame's small server commands (spec R9.12, R6.11–R6.13, R7.13, R8.12, R4.11, R10.9, R7.3 sel),
// against a real edwind: the anchor commands and primitives, the `after` marker rule through every writer, the
// relocation after a disk revert, survival across a restart and a compaction, meta broadcast, kill, user-init,
// capf-candidates, and sel's broadcast, throttle and absence from the journal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeDir, startEdwind, stopEdwind, EditClient } from './edit-client.mts';
import type { Msg, TestDir, EdwindChild, ClientOptions } from './edit-client.mts';
import type { EditOp } from './ot-sim.mts';

let dir: TestDir, child: EdwindChild;
before(async () => {
  dir = makeDir();
  /* Notes for capf-candidates, in folders, indexed at start. */
  fs.mkdirSync(path.join(dir.dirs.notes, 'projects/alpha'), { recursive: true });
  fs.writeFileSync(path.join(dir.dirs.notes, 'projects/alpha/plan.md'), '---\ntitle: Alpha Plan\naliases: [AP]\n---\n# Alpha Plan\n');
  fs.writeFileSync(path.join(dir.dirs.notes, 'projects/beta.md'), '# Beta Notes\n');
  fs.writeFileSync(path.join(dir.dirs.notes, 'index.md'), 'no heading\n');
  child = await startEdwind(dir);
});
after(async () => { await stopEdwind(child); fs.rmSync(dir.root, { recursive: true, force: true }); });

const client = async (opts?: ClientOptions) => { const c = new EditClient(dir.cfg.socket, opts); await c.connect(); const w = await c.hello(); assert.equal(w.t, 'welcome'); return c; };
const note = (name: string, text: string) => { fs.writeFileSync(path.join(dir.dirs.notes, name), text); return name; };
/* A file under the test home (no autosave there): {p, id}. */
const file = (name: string, text: string) => { const p = path.join(dir.dirs.home, name); fs.writeFileSync(p, text); return { p, id: '~/' + name }; };
const externalWrite = (p: string, text: string) => { const tmp = p + '.ext'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, p); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sync = async (c: EditClient) => { const rid = c.newRid(); c.send({ t: 'ping', rid }); await c.next(m => m.t === 'pong' && m.rid === rid); };
const value = async (c: EditClient, form: string) => { const r = await c.form(form); assert.equal(r.error, undefined, JSON.stringify(r.error)); return r.value; };
const anchorsOf = async (c: EditClient, id: string) => (await c.call('anchors', [id])).value;
/* The journal text of buffer ID (by its header line), or every journal joined when ID is omitted. */
const journalOf = (id?: string) => { const jdir = path.join(dir.dirs.state, 'buffers'); const texts = fs.readdirSync(jdir).filter(f => f.endsWith('.jsonl')).map(f => fs.readFileSync(path.join(jdir, f), 'utf8')); if (id === undefined) return texts.join(''); const t = texts.find(x => JSON.parse(x.split('\n')[0]).id === id); assert.ok(t, `a journal for ${id}`); return t; };

test('anchor-add, anchors, anchor-remove: ids, clamping, the result shapes, meta to the other clients with ver', async () => {
  const id = note('a1.md', 'hello world\n');
  const a = await client({ kind: 'frame' }), b = await client({ kind: 'frame' });
  const o = await a.open(id); await b.open(id);
  assert.deepEqual(o.meta!.anchors, []); assert.equal(o.meta!.ver, 0);
  let r = await a.call('anchor-add', [id, 6, 'w', 'ink-1']);
  assert.deepEqual(r.value, { id: 'ink-1', pos: 6 });
  const meta = await b.next(m => m.t === 'meta' && m.buf === id);
  assert.deepEqual(meta.anchors, [{ id: 'ink-1', pos: 6, label: 'w' }]); assert.equal(meta.ver, 0);
  assert.deepEqual((await a.next(m => m.t === 'meta' && m.buf === id)).anchors, meta.anchors, 'the caller gets the meta too');
  // No id: a server-made one; a used id: a fresh one, never a collision; no label: none in the list.
  r = await a.call('anchor-add', [id, 0]);
  assert.match(r.value.id, /^[0-9a-f]{16}$/); assert.equal(r.value.pos, 0);
  const r2 = await a.call('anchor-add', [id, 11, null, 'ink-1']);
  assert.notEqual(r2.value.id, 'ink-1'); assert.equal(r2.value.pos, 11);
  // Past the end: clamped to the text.
  const r3 = await a.call('anchor-add', [id, 999, 'end', 'end']);
  assert.equal(r3.value.pos, 12);
  const list = await anchorsOf(a, id);
  assert.deepEqual(list.map((x: Msg) => x.id).sort(), ['end', 'ink-1', r.value.id, r2.value.id].sort());
  assert.deepEqual(list.find((x: Msg) => x.id === r.value.id), { id: r.value.id, pos: 0 });
  // The call's buf stands in for the argument.
  assert.deepEqual((await a.call('anchors', [], {}, id)).value, list);
  // remove: true once, then false; meta follows.
  await sync(b); b.queue = b.queue.filter(m => m.t !== 'meta');
  assert.equal((await a.call('anchor-remove', [id, 'end'])).value, true);
  assert.equal((await a.call('anchor-remove', [id, 'end'])).value, false);
  const m2 = await b.next(m => m.t === 'meta' && m.buf === id);
  assert.equal(m2.anchors.some((x: Msg) => x.id === 'end'), false);
  // Bad requests.
  assert.equal((await a.call('anchor-add', [id, -1])).code, 'bad_request');
  assert.equal((await a.call('anchor-add', [id, 'x'])).code, 'bad_request');
  assert.equal((await a.call('anchor-add', [id, 1, 'l', 'x'.repeat(65)])).code, 'bad_request');
  assert.equal((await a.call('anchors', ['absent.md'])).code, 'no_buffer');
  assert.equal((await a.call('anchors', [])).code, 'bad_request');
  a.close(); b.close();
});

test('R6.11, R6.12, R7.13 anchors move as after markers through client edits; plain shifts send no meta', async () => {
  const id = note('a2.md', 'abcdef\n');
  const a = await client({ kind: 'frame' }), b = await client({ kind: 'frame' });
  await a.open(id); await b.open(id);
  await a.call('anchor-add', [id, 3, null, 'x']); // before "d"
  await a.next(m => m.t === 'meta' && m.buf === id); await b.next(m => m.t === 'meta' && m.buf === id);
  const pos = async () => (await anchorsOf(a, id))[0].pos;
  let ver = 0;
  const ed = async (ops: EditOp[]) => { const ack = await a.edit(id, ver, ops); assert.equal(ack.t, 'ack', JSON.stringify(ack)); ver = ack.ver; };
  await ed([[0, '', 'XY']]); assert.equal(await pos(), 5, 'an insert before shifts');            // XYabc|def
  await ed([[5, '', 'ZZ']]); assert.equal(await pos(), 7, 'an insert at the anchor advances it (after)'); // XYabcZZ|def
  await ed([[10, '', 'tail']]); assert.equal(await pos(), 7, 'an insert after leaves it');            // XYabcZZ|deftail
  await ed([[6, 'Zd', '']]); assert.equal(await pos(), 6, 'a deletion covering it moves it to the start'); // XYabcZ|eftail
  await ed([[5, 'Ze', 'QRS']]); assert.equal(await pos(), 8, 'a replacement covering it puts it at the end of the insertion'); // XYabcQRS|ftail
  await ed([[0, 'XYabcQRSftail', '']]); assert.equal(await pos(), 0, 'everything deleted: position 0');
  assert.equal((await a.open(id)).text, '\n');
  await sync(b);
  assert.equal(b.queue.filter(m => m.t === 'meta').length, 0, 'ordinary shifts are not announced: every client applies the same rule');
  assert.equal(b.queue.filter(m => m.t === 'edits').length, 6);
  a.close(); b.close();
});

test('R4.41 edits by a server thread and server undo move anchors too; Scheme primitives see and make them', async () => {
  const id = note('a3.md', 'one two\n');
  const f = await client({ kind: 'frame' });
  await f.open(id);
  assert.equal(await value(f, `(anchor-add! "${id}" 4 "second" "s1")`), '"s1"');
  await f.next(m => m.t === 'meta' && m.buf === id);
  assert.equal(await value(f, `(buffer-anchors "${id}")`), '(((id . "s1") (pos . 4) (label . "second")))');
  // A thread inserting at point-min with the buffer current: one batch, the anchor follows.
  const r = await f.request({ t: 'call', form: '(goto-char (point-min)) (insert "zero ") (buffer-anchors)', ctx: {}, buf: id });
  assert.equal(r.value, '(((id . "s1") (pos . 9) (label . "second")))', 'the hold is flushed before the positions are read');
  assert.deepEqual(await anchorsOf(f, id), [{ id: 's1', pos: 9, label: 'second' }]);
  // An anchor added by a thread that has edited the buffer is placed against the sequenced text.
  const r2 = await f.request({ t: 'call', form: '(goto-char (point-min)) (insert "A") (anchor-add! (current-buffer) 1 #f "s2") (buffer-anchors)', ctx: {}, buf: id });
  assert.equal(r2.value, '(((id . "s1") (pos . 10) (label . "second")) ((id . "s2") (pos . 1)))');
  // Server undo of the thread batch moves them back.
  const u = await f.call('undo-global', [], {}, id);
  assert.equal(u.msg, 'Undo');
  assert.deepEqual(await anchorsOf(f, id), [{ id: 's1', pos: 9, label: 'second' }, { id: 's2', pos: 0 }]);
  assert.equal(await value(f, `(anchor-remove! "${id}" "s2")`), '#t');
  assert.equal(await value(f, `(anchor-remove! "${id}" "s2")`), '#f');
  const c = await client(); // a cli caller: a frame's error would stop in the debugger (R4.35)
  assert.equal((await c.form('(buffer-anchors "*scratch*")')).error.condition, 'error', 'an unshared buffer is an error');
  c.close();
  // The registry marks them server-only (R4.48).
  const reg = (await f.call('primitives')).value;
  for (const nm of ['anchor-add!', 'anchor-remove!', 'buffer-anchors']) { const p = reg.find((x: Msg) => x.name === nm); assert.ok(p, nm); assert.equal(p.where, 'server', nm); }
  f.close();
});

test('R8.12 after a disk revert an anchor is relocated by prefix and quote, announced in meta and journaled; R8.13 merge too', async () => {
  const { p, id } = file('r.md', 'one\ntwo\nthree\nfour\n');
  const a = await client({ kind: 'frame' });
  await a.open(id);
  await a.call('anchor-add', [id, 8, 'ink', 'ink-3']); // the start of "three"
  await a.call('anchor-add', [id, 0, null, 'top']);
  await a.next(m => m.t === 'meta' && m.buf === id); await sync(a); a.queue = a.queue.filter(m => m.t !== 'meta');
  // The lines above change and move: the diff alone could leave the anchor on another line.
  externalWrite(p, 'four\ntwo\nthree\none\nzero\n');
  const ed = await a.next(m => m.t === 'edits' && m.buf === id);
  assert.deepEqual(ed.by, { kind: 'disk' });
  const meta = await a.next(m => m.t === 'meta' && m.buf === id && m.anchors.length === 2);
  const text = 'four\ntwo\nthree\none\nzero\n';
  assert.equal(meta.anchors.find((x: Msg) => x.id === 'ink-3').pos, text.indexOf('three'));
  const top = meta.anchors.find((x: Msg) => x.id === 'top').pos;
  assert.ok(top >= 0 && top <= 5, `an anchor whose quote is gone keeps its shifted position: ${top}`);
  assert.equal(meta.ver, 1);
  assert.deepEqual(await anchorsOf(a, id), meta.anchors);
  // A modified buffer: the three-way merge is a disk batch as well.
  await a.edit(id, 1, [[0, 'four', 'FOUR']]);
  externalWrite(p, 'four\ntwo\nthree\none\nzero\nfive\n');
  await a.next(m => m.t === 'edits' && m.buf === id && m.by.kind === 'disk');
  assert.equal((await a.open(id)).text, 'FOUR\ntwo\nthree\none\nzero\nfive\n');
  // The watcher may see the external write in two parts (two disk batches): read the anchors once the last one landed.
  let ink3;
  for (let i = 0; i < 200 && ink3 !== 9; i++) { if (i) await sleep(25); ink3 = (await anchorsOf(a, id)).find((x: Msg) => x.id === 'ink-3').pos; }
  assert.equal(ink3, 9);
  // The relocation is in the journal: the last anchors line names the current version and the positions.
  // The append is fsynced after the batch is announced, so wait for it instead of a fixed pause.
  let last;
  for (let i = 0; i < 200 && (!last || last.ver < 3); i++) {
    if (i) await sleep(25);
    const lines = journalOf(id).split('\n').filter(l => l.includes('"t":"a"')).map(l => JSON.parse(l));
    last = lines[lines.length - 1];
  }
  assert.equal(last.ver, 3); assert.equal(last.anchors.find((x: Msg) => x.id === 'ink-3').pos, 9); assert.equal(last.anchors.find((x: Msg) => x.id === 'ink-3').quote.slice(0, 5), 'three');
  // A quote that vanished: the shifted position stands, clamped (the buffer is saved first, so this is a revert).
  await a.request({ t: 'save', buf: id });
  externalWrite(p, 'x\n');
  await a.next(m => m.t === 'edits' && m.buf === id && m.by.kind === 'disk');
  const now = await a.open(id); assert.equal(now.text, 'x\n');
  for (const x of now.meta!.anchors) assert.ok(x.pos >= 0 && x.pos <= 2);
  a.close();
});

test('R9.12 anchors survive a restart, with later edits applied, and a compaction after save', async () => {
  const d2 = makeDir();
  fs.writeFileSync(path.join(d2.dirs.notes, 'keep.md'), 'alpha beta gamma\n');
  let ch = await startEdwind(d2);
  let a = new EditClient(d2.cfg.socket, { kind: 'frame' }); await a.connect(); await a.hello();
  await a.open('keep.md');
  await a.call('anchor-add', ['keep.md', 6, 'b', 'ink-b']);
  await a.call('anchor-add', ['keep.md', 11, 'g', 'ref-g']);
  await a.call('anchor-remove', ['keep.md', 'ref-g']);
  await a.edit('keep.md', 0, [[0, '', '>> ']]);        // the anchor is now at 9; this batch is after the last anchors line
  await a.edit('keep.md', 1, [[9, '', 'B']]);          // at the anchor: advances to 10
  a.close(); await stopEdwind(ch);
  ch = await startEdwind(d2);
  a = new EditClient(d2.cfg.socket, { kind: 'frame' }); await a.connect(); await a.hello();
  let o = await a.open('keep.md');
  assert.equal(o.text, '>> alpha Bbeta gamma\n'); assert.equal(o.ver, 2);
  assert.deepEqual(o.meta!.anchors, [{ id: 'ink-b', pos: 10, label: 'b' }]);
  // A save compacts the journal: the anchors line is rewritten after the retained batches.
  await a.request({ t: 'save', buf: 'keep.md' });
  await sleep(100);
  const jdir = path.join(d2.dirs.state, 'buffers');
  const j = fs.readFileSync(path.join(jdir, fs.readdirSync(jdir).find(f => f.endsWith('.jsonl'))!), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(j[j.length - 1].t, 'a'); assert.equal(j[j.length - 1].ver, 2);
  assert.deepEqual(j[j.length - 1].anchors.map((x: Msg) => [x.id, x.pos, x.quote, x.prefix]), [['ink-b', 10, 'beta gamma\n', '>> alpha B']]);
  a.close(); await stopEdwind(ch);
  ch = await startEdwind(d2);
  a = new EditClient(d2.cfg.socket, { kind: 'frame' }); await a.connect(); await a.hello();
  o = await a.open('keep.md');
  assert.deepEqual(o.meta!.anchors, [{ id: 'ink-b', pos: 10, label: 'b' }]);
  // --check still passes with anchors lines in the journal.
  a.close(); await stopEdwind(ch);
  const { check, loadConfig } = await import('../server/main.mts');
  const out: string[] = []; assert.equal(check(loadConfig(d2.file), s => out.push(s)), true, out.join('\n'));
  fs.rmSync(d2.root, { recursive: true, force: true });
});

test('R8.5 a reloaded journal counts its anchors lines toward compaction, as the running journal does', async () => {
  const d2 = makeDir();
  const p = path.join(d2.dirs.home, 'many.md'), id = '~/many.md';
  fs.writeFileSync(p, 'text\n');
  let ch = await startEdwind(d2);
  let a = new EditClient(d2.cfg.socket); await a.connect(); await a.hello();
  await a.open(id);
  a.close(); await stopEdwind(ch);
  /* A journal past the compaction line count (20,000) made of anchors lines only, as anchor-add and
     anchor-remove leave behind (each one journals the whole list). */
  const jdir = path.join(d2.dirs.state, 'buffers');
  const jfile = path.join(jdir, fs.readdirSync(jdir).find(f => f.endsWith('.jsonl'))!);
  fs.appendFileSync(jfile, (JSON.stringify({ t: 'a', ver: 0, anchors: [] }) + '\n').repeat(20001));
  ch = await startEdwind(d2);
  try {
    a = new EditClient(d2.cfg.socket); await a.connect(); await a.hello();
    const o = await a.open(id); assert.equal(o.text, 'text\n'); assert.equal(o.meta!.readOnly, false);
    assert.equal((await a.edit(id, 0, [[0, '', 'more ']])).t, 'ack');
    const lines = () => fs.readFileSync(jfile, 'utf8').trim().split('\n').length;
    for (let i = 0; i < 100 && lines() > 2; i++) await sleep(20);
    assert.equal(lines(), 2, 'the next batch compacted the journal: the header and that batch');
    assert.equal((await a.open(id)).text, 'more text\n');
    a.close();
  } finally { await stopEdwind(ch); }
  fs.rmSync(d2.root, { recursive: true, force: true });
});

test('R6.3 anchors die with the buffer; status counts them', async () => {
  const id = note('k.md', 'k\n');
  const a = await client({ kind: 'frame' });
  await a.open(id);
  await a.call('anchor-add', [id, 0, null, 'ink-k']);
  assert.ok((await a.call('status')).value.anchors >= 1);
  await a.call('kill-buffer', [id]);
  assert.equal((await a.call('anchors', [id])).code, 'no_buffer');
  const o = await a.open(id);
  assert.deepEqual(o.meta!.anchors, []);
  a.close();
});

test('R4.11 user-init: null without the file, its text with it, refused through the authority', async () => {
  const a = await client({ kind: 'frame' });
  assert.equal((await a.call('user-init')).value, null);
  const init = path.join(dir.dirs.config, 'init.scm');
  fs.writeFileSync(init, '(define from-user 1)\n');
  assert.equal((await a.call('user-init')).value, '(define from-user 1)\n');
  fs.unlinkSync(init);
  fs.mkdirSync(path.join(dir.dirs.home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(dir.dirs.home, '.ssh/id_x'), 'secret\n');
  fs.symlinkSync(path.join(dir.dirs.home, '.ssh/id_x'), init);
  assert.equal((await a.call('user-init')).code, 'refused_path');
  fs.unlinkSync(init);
  a.close();
});

test('R10.9 capf-candidates wiki: titles, aliases and folders from the notes index', async () => {
  const a = await client({ kind: 'frame' });
  let names: string[] = [];
  for (let i = 0; i < 150 && !names.includes('Beta Notes'); i++) { names = (await a.call('capf-candidates', [{ kind: 'wiki' }])).value; if (!names.includes('Beta Notes')) await sleep(100); }
  for (const n of ['Alpha Plan', 'AP', 'Beta Notes', 'index', 'projects', 'projects/alpha']) assert.ok(names.includes(n), `${n} in ${JSON.stringify(names)}`);
  assert.deepEqual(names, [...new Set(names)].sort((x, y) => x.localeCompare(y)), 'sorted and unique');
  assert.equal((await a.call('capf-candidates', [{ kind: 'board' }])).code, 'bad_request');
  a.close();
});

test('R7.3 sel reaches the other clients with the sender\'s by, is throttled to 20 per second per client, and is never journaled', async () => {
  const id = note('sel.md', 'abc\n');
  const a = await client({ kind: 'frame' }), b = await client({ kind: 'frame' }), c = await client({ kind: 'cli' });
  await a.open(id); await b.open(id); await c.open(id);
  for (let i = 0; i < 40; i++) a.send({ t: 'sel', buf: id, ranges: [[i % 4, i % 4]] });
  await sync(a); await sync(b); await sync(c);
  const got = b.queue.filter(m => m.t === 'sel' && m.buf === id);
  assert.equal(got.length, 20, 'the 21st sel within a second is dropped');
  assert.deepEqual(got[0].by, { kind: 'frame', cid: a.cid, device: a.device });
  assert.deepEqual(got[0].ranges, [[0, 0]]);
  assert.equal(c.queue.filter(m => m.t === 'sel').length, 20, 'every other client of the buffer');
  assert.equal(a.queue.filter(m => m.t === 'sel').length, 0, 'never the sender');
  // Another client's budget is its own; the window slides.
  b.send({ t: 'sel', buf: id, ranges: [[1, 2]] });
  assert.deepEqual((await a.next(m => m.t === 'sel' && m.buf === id)).ranges, [[1, 2]]);
  await sleep(1050);
  a.send({ t: 'sel', buf: id, ranges: [[3, 3]] });
  assert.deepEqual((await c.next(m => m.t === 'sel' && m.buf === id && m.ranges[0][0] === 3)).ranges, [[3, 3]]);
  await sleep(50);
  assert.equal(journalOf().includes('"sel"'), false, 'sel is presence, never journaled');
  a.close(); b.close(); c.close();
});
