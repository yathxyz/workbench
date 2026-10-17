// The notes index (spec §16.1 edit-notes, §11): a real edwind over a copy of the fixture notesDir
// (edwin/test/fixtures/notes/root). Every §11.3 command is compared field by field with a golden JSON file
// under fixtures/notes/golden (NOTES_UPDATE_GOLDEN=1 rewrites them); then link resolution (R11.3), freshness
// from buffer edits, file system events and the sweep (R11.4), the snapshot and restart (R11.6), the notes{gen}
// message and notes-generation (R11.7), the writes as edits (R11.9), the Lisp procedures (R11.10) and the
// 10,000-file rebuild (R11.5; the budget is NOTES_REBUILD_BUDGET_MS, 60 s here, 20 s on the fast host).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDir, startEdwind, stopEdwind, EditClient } from './edit-client.mts';
import type { Msg, TestDir, EdwindChild, ClientOptions } from './edit-client.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'notes', 'root');
const GOLDEN = path.join(HERE, 'fixtures', 'notes', 'golden');
const UPDATE = !!process.env.NOTES_UPDATE_GOLDEN;
const BUDGET_MS = Number(process.env.NOTES_REBUILD_BUDGET_MS || 60000);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/* A notesDir from the fixtures plus what git cannot hold: a .git directory, node_modules, a file over 4 MiB, a
   symlink out of the tree and a symlinked directory out of the tree (R11.1). */
function fixtureDir(extra?: Record<string, unknown>) {
  const dir = makeDir(extra);
  fs.cpSync(FIXTURES, dir.dirs.notes, { recursive: true });
  /* cpSync keeps the source modes, and the fixtures read from the Nix store are read-only: give the copy back to
     its owner so a test can write it. */
  for (const e of fs.readdirSync(dir.dirs.notes, { recursive: true, withFileTypes: true })) {
    const p = path.join(e.parentPath, e.name);
    fs.chmodSync(p, fs.statSync(p).mode | 0o200);
  }
  fs.mkdirSync(path.join(dir.dirs.notes, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir.dirs.notes, '.git', 'config'), '[core]\n');
  fs.mkdirSync(path.join(dir.dirs.notes, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir.dirs.notes, 'node_modules', 'pkg', 'readme.md'), '# Not indexed\n');
  fs.writeFileSync(path.join(dir.dirs.notes, 'huge.md'), '# Huge\n' + 'x'.repeat(4 * 1024 * 1024 + 10) + '\n');
  const outside = path.join(dir.root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.md'), '# Secret\n');
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(dir.dirs.notes, 'outside.md'));
  fs.symlinkSync(outside, path.join(dir.dirs.notes, 'linkout'));
  return dir;
}
const EXPECTED_FILES = ['alpha.md', 'beta.md', 'cards/vocab.md', 'gamma/delta.org', 'journal/2026-10-01.md', 'sub/alpha.md', 'tasks.md'];

let dir: TestDir, child: EdwindChild;
/* Every edwind and directory a test starts on its own, so a failing test leaks nothing (an open child would
   keep the test process alive). */
const extra = new Set<EdwindChild>();
const start = async (d: TestDir) => { const ch = await startEdwind(d); extra.add(ch); return ch; };
const stop = async (ch: EdwindChild) => { extra.delete(ch); await stopEdwind(ch); };
before(async () => { dir = fixtureDir(); child = await startEdwind(dir); });
after(async () => {
  for (const ch of extra) await stopEdwind(ch, 'SIGKILL');
  await stopEdwind(child);
  for (const root of [dir.root, ...tmpRoots]) fs.rmSync(root, { recursive: true, force: true });
});
const tmpRoots: string[] = [];

const client = async (opts: ClientOptions = { kind: 'web' }, sock = dir.cfg.socket) => { const c = new EditClient(sock, opts); await c.connect(); const w = await c.hello(); assert.equal(w.t, 'welcome'); return c; };
const value = async (c: EditClient, cmd: string, args?: unknown[], timeout?: number) => {
  const rid = c.newRid(); c.send({ t: 'call', cmd, args: args || [], ctx: {}, rid });
  const r = await c.next(m => m.rid === rid && (m.t === 'result' || m.t === 'error'), timeout || 10000);
  assert.equal(r.t, 'result', `${cmd}: ${JSON.stringify(r)}`); return r.value;
};
const info = (c: EditClient) => value(c, 'notes-info');
/* The next notes{gen} message after GEN. */
const nextGen = (c: EditClient, gen: number, timeout = 15000) => c.next(m => m.t === 'notes' && m.gen > gen, timeout);

/* Goldens: absolute paths and volatile fields are normalised before comparing. */
function normalise(v: unknown) {
  const root = dir.dirs.notes;
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x)) {
        if (k === 'mtime' || k === 'gen' || k === 'ms' || k === 'startup' || k === 'watch' || k === 'worker') continue;
        out[k] = typeof val === 'string' && val.startsWith(root) ? '<notesDir>' + val.slice(root.length) : walk(val);
      }
      return out;
    }
    return x;
  };
  return walk(v);
}
function assertGolden(name: string, actual: unknown) {
  const file = path.join(GOLDEN, name + '.json');
  const got = normalise(actual);
  if (UPDATE) { fs.mkdirSync(GOLDEN, { recursive: true }); fs.writeFileSync(file, JSON.stringify(got, null, 1) + '\n'); return; }
  const want = JSON.parse(fs.readFileSync(file, 'utf8'));
  /* Field by field, so a difference names its path. */
  const diff = (a: any, b: any, at: string) => { // any: JSON from the server and the golden file
    if (Array.isArray(a) || Array.isArray(b)) { assert.ok(Array.isArray(a) && Array.isArray(b), `${name}${at}: array expected`); assert.equal(a.length, b.length, `${name}${at}: length ${a.length} != ${b.length}`); a.forEach((x, i) => diff(x, b[i], `${at}[${i}]`)); return; }
    if (a && b && typeof a === 'object' && typeof b === 'object') { assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${name}${at}: keys`); for (const k of Object.keys(b)) diff(a[k], b[k], `${at}.${k}`); return; }
    assert.deepEqual(a, b, `${name}${at}`);
  };
  diff(got, want, '');
}

test('R11.1 the index covers *.md and *.org, skips dot-directories, ignore patterns, big files and symlinks out', async () => {
  const c = await client();
  const i = await info(c);
  assert.equal(i.exists, true); assert.equal(i.ready, true);
  const nodes = (await value(c, 'notes-nodes', [{ limit: 20000 }])).nodes;
  assert.deepEqual(nodes.filter((n: Msg) => n.kind === 'file').map((n: Msg) => n.id), EXPECTED_FILES);
  assert.equal(i.files, EXPECTED_FILES.length);
  /* limit caps the rows. */
  assert.equal((await value(c, 'notes-nodes', [{ limit: 3 }])).nodes.length, 3);
  c.close();
});

test('§11.3 goldens: every command over the fixture notesDir', async () => {
  const c = await client();
  assertGolden('nodes', await value(c, 'notes-nodes', [{ limit: 20000 }]));
  assertGolden('links', await value(c, 'notes-links'));
  assertGolden('cards', await value(c, 'notes-cards'));
  assertGolden('reviews', await value(c, 'notes-reviews'));
  assertGolden('tasks', await value(c, 'notes-tasks'));
  assertGolden('task', await value(c, 'notes-task', [{ id: 'tasks.md:3' }]));
  assertGolden('ambiguous-links', await value(c, 'notes-ambiguous-links'));
  assertGolden('info', await value(c, 'notes-info'));
  const g = await value(c, 'notes-grammar');
  assert.deepEqual(g['task-keywords'], ['TODO', 'NEXT', 'WAITING', 'HOLD', 'SOMEDAY', 'DONE', 'CANCELLED', 'DOING', 'NOW', 'LATER']);
  assertGolden('grammar', g);
  c.close();
});

test('R11.2 record shapes: file, heading, block, task and card fields the frontend reads', async () => {
  const c = await client();
  const nodes = (await value(c, 'notes-nodes', [{}])).nodes;
  const beta = nodes.find((n: Msg) => n.id === 'beta.md');
  assert.equal(beta.kind, 'file'); assert.equal(beta.title, 'Beta'); assert.equal(beta.path, 'beta.md');
  assert.deepEqual(beta.aliases, ['B', 'Second B']); assert.deepEqual(beta.tags, ['proj', 'notes', 'setext']);
  assert.equal(beta.props.id, '7d3e5c10-0000-4000-8000-000000000002');
  assert.equal(typeof beta.mtime, 'number');
  assert.equal(beta.body.split('\n').length, 12, 'the first 12 lines');
  const h = nodes.find((n: Msg) => n.id === 'beta.md#10');
  assert.equal(h.kind, 'heading'); assert.equal(h.title, 'First block'); assert.equal(h.level, 2); assert.equal(h.line, 10);
  assert.ok(h.body.split('\n').length <= 5);
  const b = nodes.find((n: Msg) => n.id === 'beta.md#^b1');
  assert.deepEqual(b, { id: 'beta.md#^b1', title: 'First block', kind: 'block', line: 10, path: 'beta.md' });
  assert.equal(nodes.find((n: Msg) => n.id === 'beta.md#18').title, 'Setext heading');
  const delta = nodes.find((n: Msg) => n.id === 'gamma/delta.org');
  assert.equal(delta.title, 'Delta'); assert.deepEqual(delta.tags, ['org', 'x']); assert.deepEqual(delta.aliases, ['Big Delta', 'dd']);
  assert.equal(nodes.find((n: Msg) => n.id === 'sub/alpha.md').title, 'Alpha');
  assert.equal(nodes.find((n: Msg) => n.id === 'journal/2026-10-01.md').title, '2026-10-01');
  /* Nothing inside a code fence is a heading or a block. */
  assert.ok(!nodes.some((n: Msg) => n.title === 'not a heading inside a fence'));
  const tasks = (await value(c, 'notes-tasks')).tasks;
  const ship = tasks.find((t: Msg) => t.id === 'tasks.md:3');
  assert.equal(ship.kw, 'TODO'); assert.equal(ship.title, 'Ship it'); assert.equal(ship.priority, 'B'); assert.equal(ship.node, 'tasks.md#^t1');
  assert.equal(ship.session, 'tmux:agent-x'); assert.equal(ship.dispatched, '2026-10-01T10:00'); assert.equal(ship.target, '@devbox');
  assert.equal(ship.prompt, 'Ship the thing, then tell [[Beta]].'); assert.equal(ship.path, 'tasks.md'); assert.equal(ship.line, 3);
  const follow = tasks.find((t: Msg) => t.id === 'tasks.md:8');
  assert.equal(follow.scheduled, '2026-10-20'); assert.equal(follow.deadline, '2026-10-25'); assert.deepEqual(follow.tags, ['urgent']); assert.equal(follow.node, 'tasks.md#1');
  const org = tasks.find((t: Msg) => t.id === 'gamma/delta.org:11');
  assert.equal(org.kw, 'TODO'); assert.equal(org.priority, 'A'); assert.equal(org.title, 'Write the Org section'); assert.deepEqual(org.tags, ['work']);
  assert.equal(org.scheduled, '2026-10-20'); assert.equal(org.deadline, '2026-10-25');
  assert.equal(tasks.find((t: Msg) => t.id === 'gamma/delta.org:17').closed, '2026-10-02');
  assert.deepEqual(tasks.map((t: Msg) => t.kw).filter((k: string, i: number, a: string[]) => a.indexOf(k) === i).sort(), ['CANCELLED', 'DOING', 'DONE', 'HOLD', 'LATER', 'NEXT', 'TODO', 'WAITING']);
  const cards = (await value(c, 'notes-cards')).cards;
  assert.deepEqual(cards.map((x: Msg) => x.id), ['cards/vocab.md#^k3m9x2#fwd', 'cards/vocab.md#^k3m9x2#rev', 'cards/vocab.md#^p01x7', 'cards/vocab.md#^a0r1s', 'cards/vocab.md#^nx0m1#c1', 'cards/vocab.md#^nx0m1#c2', 'cards/vocab.md#^old01']);
  const rev = cards.find((x: Msg) => x.id.endsWith('#rev'));
  assert.equal(rev.kind, 'reverse'); assert.equal(rev.front, 'excellence, virtue'); assert.equal(rev.back, 'ἀρετή'); assert.equal(rev.deck, 'grc/vocab');
  assert.equal(rev.props.card, 'reverse'); assert.equal(rev.status, 'active'); assert.ok(rev.src.startsWith('## ἀρετή ^k3m9x2\ncard:: reverse'));
  const cl = cards.find((x: Msg) => x.id.endsWith('#c2'));
  assert.equal(cl.kind, 'cloze'); assert.equal(cl.cloze, 2); assert.match(cl.text, /\{\{c2::mkEnableOption\}\}/); assert.ok(!cl.text.includes('\n'));
  assert.equal(cards.find((x: Msg) => x.id.endsWith('#^old01')).status, 'retired');
  assert.equal(cards.find((x: Msg) => x.id.endsWith('#^a0r1s')).kind, 'type');
  c.close();
});

test('R11.3 link resolution: title, alias, path, case, id:, file:, anchors; the shortest path wins an ambiguity', async () => {
  const c = await client();
  const { files, links, backlinks } = await value(c, 'notes-links');
  assert.deepEqual(Object.keys(files).sort(), EXPECTED_FILES);
  assert.equal(files['gamma/delta.org'].title, 'Delta');
  const from = (src: string, dst: string) => links.find((l: Msg) => l.srcFile === src && l.dst === dst);
  assert.equal(from('alpha.md', 'Beta').dstFile, 'beta.md');
  assert.equal(from('alpha.md', 'Beta').kind, 'wiki');
  assert.equal(links.find((l: Msg) => l.srcFile === 'alpha.md' && l.label === 'the b').dstFile, 'beta.md', 'a [[name|label]] link');
  assert.equal(from('alpha.md', 'gamma/delta').dstFile, 'gamma/delta.org', 'by path without extension');
  assert.equal(from('alpha.md', 'Big Delta').dstFile, 'gamma/delta.org', 'by alias');
  assert.equal(from('alpha.md', 'Missing note').dstFile, null);
  assert.equal(from('beta.md', 'alpha').dstFile, 'alpha.md', 'case-insensitive');
  assert.equal(from('alpha.md', 'Beta#^b1').kind, 'ref'); assert.equal(from('alpha.md', 'Beta#^b1').dstFile, 'beta.md');
  assert.equal(from('alpha.md', '^b2').dstFile, 'beta.md', 'a bare anchor finds its file');
  assert.equal(from('alpha.md', 'https://example.org/docs').kind, 'url'); assert.equal(from('alpha.md', 'https://example.org/docs').dstFile, null);
  assert.equal(from('alpha.md', 'sub/alpha.md').kind, 'file'); assert.equal(from('alpha.md', 'sub/alpha.md').dstFile, 'sub/alpha.md');
  assert.equal(from('gamma/delta.org', 'id:7d3e5c10-0000-4000-8000-000000000002').dstFile, 'beta.md', 'an Org id: link to a Markdown front matter id');
  assert.equal(from('gamma/delta.org', 'file:../beta.md').dstFile, 'beta.md');
  assert.equal(from('gamma/delta.org', 'Alpha#^links').dstFile, 'alpha.md');
  assert.equal(from('cards/vocab.md', 'Beta#^b1').dstFile, 'beta.md');
  /* Two notes titled Alpha: alpha.md is shorter than sub/alpha.md. */
  assert.equal(from('alpha.md', 'Alpha').dstFile, 'alpha.md');
  assert.equal(from('beta.md', 'Alpha').dstFile, 'alpha.md');
  const amb = await value(c, 'notes-ambiguous-links');
  assert.ok(amb.length >= 4);
  for (const a of amb) { assert.deepEqual(a.candidates, ['alpha.md', 'sub/alpha.md']); assert.equal(a.chosen, 'alpha.md'); }
  assert.ok(amb.some((a: Msg) => a.srcFile === 'beta.md' && a.line === 8));
  /* Backlinks count links from other files. */
  assert.equal(backlinks['beta.md'], links.filter((l: Msg) => l.dstFile === 'beta.md' && l.srcFile !== 'beta.md').length);
  assert.equal(backlinks['sub/alpha.md'], 1);
  assert.equal(backlinks['alpha.md'], links.filter((l: Msg) => l.dstFile === 'alpha.md' && l.srcFile !== 'alpha.md').length);
  /* The link's src is the heading or block that holds it. */
  assert.equal(from('alpha.md', 'gamma/delta').src, 'alpha.md#5');
  assert.equal(from('journal/2026-10-01.md', 'Alpha').src, 'journal/2026-10-01.md#1');
  c.close();
});

test('R11.4, R11.7 a buffer edit re-indexes the live text 300 ms later and every client gets notes{gen}', async () => {
  const a = await client(), b = await client({ kind: 'frame' });
  const gen0 = (await info(a)).gen;
  const o = await a.open('tasks.md');
  const pos = o.text!.indexOf('- NEXT Follow up');
  const t0 = Date.now();
  const ack = await a.edit('tasks.md', o.ver!, [[pos, '', '- SOMEDAY A brand new task #fresh\n']]);
  assert.equal(ack.t, 'ack');
  const [ma, mb] = await Promise.all([nextGen(a, gen0), nextGen(b, gen0)]);
  const dt = Date.now() - t0;
  assert.equal(ma.gen, mb.gen);
  assert.ok(dt >= 250 && dt < 5000, `re-indexed after ${dt} ms`);
  const tasks = (await value(a, 'notes-tasks')).tasks;
  const fresh = tasks.find((t: Msg) => t.title === 'A brand new task #fresh');
  assert.ok(fresh, 'the new task is indexed'); assert.equal(fresh.kw, 'SOMEDAY'); assert.deepEqual(fresh.tags, ['fresh']); assert.equal(fresh.id, 'tasks.md:8');
  assert.equal(tasks.find((t: Msg) => t.title === 'Follow up with the team #urgent').line, 9, 'later tasks moved down a line');
  /* The index came from the buffer, not from the disk: the file has not been autosaved yet (2 s). */
  if (dt < 1800) assert.ok(!fs.readFileSync(path.join(dir.dirs.notes, 'tasks.md'), 'utf8').includes('brand new'), 'unsaved text is indexed');
  assert.equal((await info(a)).gen, ma.gen);
  assert.equal((await a.form('notes-generation')).value, String(ma.gen), 'the Scheme variable follows');
  const st = await value(a, 'status');
  assert.equal(st.notesGen, ma.gen); assert.equal(st.notesExists, true);
  /* Several quick edits are one re-parse (the debounce). */
  const gen1 = ma.gen;
  let ver = ack.ver;
  for (let i = 0; i < 5; i++) { let r = await a.edit('tasks.md', ver, [[0, '', 'x']]); ver = r.ver; r = await a.edit('tasks.md', ver, [[0, 'x', '']]); ver = r.ver; await sleep(40); }
  const r = await a.edit('tasks.md', ver, [[o.text!.length + 34, '', '- TODO Fifth\n']]);
  assert.equal(r.t, 'ack');
  const m2 = await nextGen(a, gen1);
  await sleep(600);
  assert.equal((await info(a)).gen, m2.gen, 'one generation for the burst');
  a.close(); b.close();
});

test('R11.4 files written, changed and removed outside edwind reach the index (fs.watch or the sweep)', async () => {
  const c = await client();
  const gen0 = (await info(c)).gen;
  fs.writeFileSync(path.join(dir.dirs.notes, 'fresh.md'), '# Fresh\n\nA new note linking [[Beta]]. ^f1\n');
  await nextGen(c, gen0, 15000);
  let nodes = (await value(c, 'notes-nodes', [{}])).nodes;
  assert.ok(nodes.some((n: Msg) => n.id === 'fresh.md' && n.title === 'Fresh'));
  assert.ok(nodes.some((n: Msg) => n.id === 'fresh.md#^f1'));
  assert.equal((await value(c, 'notes-links')).backlinks['beta.md'] >= 1, true);
  /* A new directory with a note inside. */
  const gen1 = (await info(c)).gen;
  fs.mkdirSync(path.join(dir.dirs.notes, 'newdir'));
  fs.writeFileSync(path.join(dir.dirs.notes, 'newdir', 'inner.org'), '#+title: Inner\n\n* TODO Inner task\n');
  await nextGen(c, gen1, 15000);
  const deadline = Date.now() + 15000;
  while (!(await value(c, 'notes-tasks')).tasks.some((t: Msg) => t.id === 'newdir/inner.org:3') && Date.now() < deadline) await sleep(200);
  assert.ok((await value(c, 'notes-tasks')).tasks.some((t: Msg) => t.id === 'newdir/inner.org:3' && t.title === 'Inner task'));
  /* Changed. */
  const gen2 = (await info(c)).gen;
  await sleep(20);
  fs.writeFileSync(path.join(dir.dirs.notes, 'fresh.md'), '# Fresher\n');
  await nextGen(c, gen2, 15000);
  nodes = (await value(c, 'notes-nodes', [{}])).nodes;
  assert.equal(nodes.find((n: Msg) => n.id === 'fresh.md').title, 'Fresher');
  assert.ok(!nodes.some((n: Msg) => n.id === 'fresh.md#^f1'));
  /* Removed. */
  const gen3 = (await info(c)).gen;
  fs.unlinkSync(path.join(dir.dirs.notes, 'fresh.md'));
  fs.rmSync(path.join(dir.dirs.notes, 'newdir'), { recursive: true });
  await nextGen(c, gen3, 15000);
  const until = Date.now() + 15000;
  while ((await value(c, 'notes-nodes', [{}])).nodes.some((n: Msg) => n.path === 'fresh.md' || n.path === 'newdir/inner.org') && Date.now() < until) await sleep(200);
  nodes = (await value(c, 'notes-nodes', [{}])).nodes;
  assert.ok(!nodes.some((n: Msg) => n.path === 'fresh.md' || n.path === 'newdir/inner.org'));
  c.close();
});

test('§11.3 notes-task-set edits the task line and its fields as one edit batch by the caller', async () => {
  const a = await client(), b = await client({ kind: 'frame' });
  const o = await b.open('tasks.md');
  const ver0 = o.ver;
  const r = await value(a, 'notes-task-set', [{ id: 'tasks.md:3', kw: 'NEXT', set: { session: 'tmux:agent-9', dispatched: '2026-10-14T10:00' }, by: { kind: 'agent', agent: 'tester' } }]);
  assert.equal(r.kw, 'NEXT'); assert.equal(r.session, 'tmux:agent-9'); assert.equal(r.dispatched, '2026-10-14T10:00'); assert.equal(r.id, 'tasks.md:3');
  const ed = await b.next(m => m.t === 'edits' && m.buf === 'tasks.md');
  assert.deepEqual(ed.by, { kind: 'agent', agent: 'tester' });
  assert.equal(ed.ver, ver0! + 1, 'one batch');
  const now = (await b.open('tasks.md')).text!;
  assert.match(now, /^- NEXT Ship it \[#B\] \^t1\n  session:: tmux:agent-9\n  dispatched:: 2026-10-14T10:00\n  target:: @devbox\n/m, 'existing fields are replaced in place');
  /* A task without the fields gets them inserted under its line, indented; the keyword alone also works. */
  const follow = (await value(a, 'notes-tasks')).tasks.find((t: Msg) => t.title === 'Follow up with the team #urgent');
  const r2 = await value(a, 'notes-task-set', [{ id: follow.id, kw: 'DONE', set: { session: 'tmux:x' } }]);
  assert.equal(r2.kw, 'DONE'); assert.equal(r2.session, 'tmux:x');
  const ed2 = await b.next(m => m.t === 'edits' && m.buf === 'tasks.md');
  assert.deepEqual(ed2.by, { kind: 'web', cid: a.cid, device: a.device }, 'without a by of its own, the caller is the writer');
  const text2 = (await b.open('tasks.md')).text!;
  assert.match(text2, /^- DONE Follow up with the team #urgent\n  session:: tmux:x\n  SCHEDULED: <2026-10-20 Tue>\n/m);
  /* Setting the same field twice does not duplicate it; an Org heading task takes a keyword too. */
  await value(a, 'notes-task-set', [{ id: follow.id, set: { session: 'tmux:y' } }]);
  const text3 = (await b.open('tasks.md')).text!;
  assert.equal((text3.match(/session:: tmux:[xy]/g) || []).length, 1); assert.ok(text3.includes('session:: tmux:y'));
  const org = await value(a, 'notes-task-set', [{ id: 'gamma/delta.org:11', kw: 'DONE' }]);
  assert.equal(org.kw, 'DONE');
  assert.match((await b.open('gamma/delta.org')).text!, /^\* DONE \[#A\] Write the Org section/m);
  /* Refusals. */
  let e = await a.call('notes-task-set', [{ id: 'nope:1', kw: 'DONE' }]);
  assert.equal(e.t, 'error'); assert.equal(e.code, 'bad_request'); assert.match(e.msg, /no task nope:1/);
  e = await a.call('notes-task-set', [{ id: 'tasks.md:3', kw: 'BOGUS' }]);
  assert.equal(e.code, 'bad_request');
  e = await a.call('notes-task', [{ id: 'absent' }]);
  assert.equal(e.code, 'bad_request'); assert.equal(e.msg, 'no task absent');
  /* A task found by its anchor. */
  assert.equal((await value(a, 'notes-task', [{ id: 't1' }])).id, 'tasks.md:3');
  a.close(); b.close();
});

test('§11.3 notes-journal creates journal/<day>.md from journal-template as a buffer and saves it', async () => {
  const a = await client();
  const r = await value(a, 'notes-journal', [{ day: '2026-10-14' }]);
  assert.deepEqual(r, { path: 'journal/2026-10-14.md', created: true });
  assert.equal(fs.readFileSync(path.join(dir.dirs.notes, 'journal', '2026-10-14.md'), 'utf8'), '# 2026-10-14\n\n');
  assert.deepEqual(await value(a, 'notes-journal', [{ day: '2026-10-14' }]), { path: 'journal/2026-10-14.md', created: false });
  assert.deepEqual(await value(a, 'notes-journal', [{ day: '2026-10-01' }]), { path: 'journal/2026-10-01.md', created: false }, 'a journal file already on disk');
  const list = (await value(a, 'buffer-list'));
  assert.ok(list.some((b: Msg) => b.id === 'journal/2026-10-14.md' && b.modified === false), 'a saved buffer');
  const nodes = (await value(a, 'notes-nodes', [{}])).nodes;
  assert.ok(nodes.some((n: Msg) => n.id === 'journal/2026-10-14.md' && n.title === '2026-10-14'));
  /* The template is a Scheme variable: a string with <day>, or a procedure of the day. */
  await a.form('(set! journal-template (lambda (day) (string-append "# Journal " day "\\n\\n- TODO plan the day\\n")))');
  const r2 = await value(a, 'notes-journal', [{ day: '2026-10-15' }]);
  assert.equal(r2.created, true);
  assert.equal((await a.open('journal/2026-10-15.md')).text, '# Journal 2026-10-15\n\n- TODO plan the day\n');
  assert.ok((await value(a, 'notes-tasks')).tasks.some((t: Msg) => t.id === 'journal/2026-10-15.md:3'));
  await a.form('(set! journal-template "# <day>\\n\\n")');
  const e = await a.call('notes-journal', [{ day: '14-10-2026' }]);
  assert.equal(e.code, 'bad_request');
  a.close();
});

test('§11.3 notes-append appends as an edit to the buffer, creating the file; paths outside notesDir are refused', async () => {
  const a = await client(), b = await client({ kind: 'frame' });
  const block = '## ἀρετή again ^zz9\ncard:: basic\ndeck:: inbox\nback:: virtue\n';
  const r = await value(a, 'notes-append', [{ path: 'inbox/cards.md', text: block, by: 'assistant' }]);
  assert.deepEqual(r, { path: 'inbox/cards.md' });
  const o = await b.open('inbox/cards.md');
  assert.equal(o.text, block);
  const r2 = await value(a, 'notes-append', [{ path: 'inbox/cards.md', text: '## λόγος again ^zz10\ncard:: basic\ndeck:: inbox\nback:: word', by: { kind: 'agent', agent: 'helper' } }]);
  assert.equal(r2.path, 'inbox/cards.md');
  const ed = await b.next(m => m.t === 'edits' && m.buf === 'inbox/cards.md');
  assert.deepEqual(ed.by, { kind: 'agent', agent: 'helper' });
  assert.equal((await b.open('inbox/cards.md')).text, block + '## λόγος again ^zz10\ncard:: basic\ndeck:: inbox\nback:: word\n', 'newline-separated');
  /* Indexed at once: the review deck sees the new cards. */
  const cards = (await value(a, 'notes-cards')).cards;
  assert.ok(cards.some((c: Msg) => c.id === 'inbox/cards.md#^zz9' && c.deck === 'inbox'));
  assert.ok(cards.some((c: Msg) => c.id === 'inbox/cards.md#^zz10'));
  /* The file is written by the autosave (R8.11), not by the command. */
  const until = Date.now() + 6000;
  while (!fs.existsSync(path.join(dir.dirs.notes, 'inbox', 'cards.md')) && Date.now() < until) await sleep(100);
  assert.ok(fs.readFileSync(path.join(dir.dirs.notes, 'inbox', 'cards.md'), 'utf8').includes('^zz10'));
  for (const p of ['../x.md', '/etc/passwd', '~/x.md', 'name:*scratch*', 'a/../../x.md', '', 'linkout/secret.md']) {
    const e = await a.call('notes-append', [{ path: p, text: 'x' }]);
    assert.equal(e.t, 'error', p); assert.equal(e.code, 'bad_request', p);
  }
  assert.equal(fs.readFileSync(path.join(dir.root, 'outside', 'secret.md'), 'utf8'), '# Secret\n');
  /* A new note under a symlinked or dangling directory: refused before any directory is made (R14.8). */
  fs.symlinkSync(path.join(dir.dirs.home, '.ssh'), path.join(dir.dirs.notes, 'linkssh'));
  fs.symlinkSync(path.join(dir.root, 'nowhere'), path.join(dir.dirs.notes, 'dangling'));
  for (const p of ['linkout/new/note.md', 'linkssh/new/note.md', 'dangling/note.md', 'dangling/new/note.md']) {
    const e = await a.call('notes-append', [{ path: p, text: 'x' }]);
    assert.equal(e.t, 'error', p); assert.equal(e.code, 'bad_request', p);
  }
  assert.equal(fs.existsSync(path.join(dir.root, 'outside', 'new')), false, 'nothing created through the symlink');
  assert.equal(fs.existsSync(path.join(dir.dirs.home, '.ssh', 'new')), false, 'nothing created in a refused path');
  assert.equal(fs.existsSync(path.join(dir.root, 'nowhere')), false, 'a dangling symlink is not made real');
  /* A real nested directory inside notesDir is still created on demand. */
  assert.deepEqual(await value(a, 'notes-append', [{ path: 'deep/er/note.md', text: 'ok' }]), { path: 'deep/er/note.md' });
  assert.equal((await a.call('notes-append', [{ path: 'x.md' }])).code, 'bad_request');
  a.close(); b.close();
});

test('§11.3 notes-reviews reads .reviews/*.jsonl and notes-reviews-append appends to <host>.jsonl', async () => {
  const a = await client();
  const before = await value(a, 'notes-reviews');
  assert.equal(before.reviews.length, 2);
  assert.equal(before.dir, path.join(dir.dirs.notes, '.reviews'));
  const lines = [{ card: 'cards/vocab.md#^p01x7', g: 4, t: '2026-10-14T09:00:00.000Z' }, { card: 'cards/vocab.md#^a0r1s', g: 1, t: '2026-10-14T09:01:00.000Z' }];
  const r = await value(a, 'notes-reviews-append', [{ reviews: lines }]);
  assert.deepEqual(r, { dir: before.dir, appended: 2 });
  const file = path.join(dir.dirs.notes, '.reviews', 'test.jsonl');
  assert.equal(fs.readFileSync(file, 'utf8'), lines.map(l => JSON.stringify(l) + '\n').join(''));
  await value(a, 'notes-reviews-append', [{ reviews: [{ card: 'x', g: 3, t: '2026-10-14T09:02:00.000Z' }] }]);
  const after = await value(a, 'notes-reviews');
  assert.equal(after.reviews.length, 5);
  assert.equal(after.reviews[after.reviews.length - 1].card, 'x');
  assert.equal((await a.call('notes-reviews-append', [{ reviews: 'no' }])).code, 'bad_request');
  /* .reviews is a dot-directory: never indexed. */
  assert.ok(!(await value(a, 'notes-nodes', [{}])).nodes.some((n: Msg) => n.path.startsWith('.reviews')));
  a.close();
});

test('R14.8 notes-reviews-append writes through the real path: a symlinked .reviews or log never leaves the write roots', async () => {
  const a = await client();
  const reviewsDir = path.join(dir.dirs.notes, '.reviews'), log = path.join(reviewsDir, 'test.jsonl');
  /* ~/.ssh is on the refusal list of the test configuration (the root itself is writable). */
  const refused = path.join(dir.dirs.home, '.ssh');
  fs.mkdirSync(refused, { recursive: true });
  fs.writeFileSync(path.join(refused, 'leak.jsonl'), 'keep\n');
  const one = [{ card: 'y', g: 1, t: '2026-10-14T10:00:00.000Z' }];
  /* The log itself is a symlink to a refused file. */
  fs.renameSync(log, log + '.keep');
  fs.symlinkSync(path.join(refused, 'leak.jsonl'), log);
  try {
    assert.equal((await a.call('notes-reviews-append', [{ reviews: one }])).code, 'refused_path');
    assert.equal(fs.readFileSync(path.join(refused, 'leak.jsonl'), 'utf8'), 'keep\n');
  } finally { fs.unlinkSync(log); fs.renameSync(log + '.keep', log); }
  /* A dangling symlink as the log is refused too (appendFileSync would create its target). */
  fs.renameSync(log, log + '.keep');
  fs.symlinkSync(path.join(dir.root, 'outside', 'dangling.jsonl'), log);
  try {
    assert.equal((await a.call('notes-reviews-append', [{ reviews: one }])).code, 'refused_path');
    assert.ok(!fs.existsSync(path.join(dir.root, 'outside', 'dangling.jsonl')));
  } finally { fs.unlinkSync(log); fs.renameSync(log + '.keep', log); }
  /* The .reviews directory is a symlink to a refused directory. */
  fs.renameSync(reviewsDir, reviewsDir + '.keep');
  fs.symlinkSync(refused, reviewsDir);
  try {
    assert.equal((await a.call('notes-reviews-append', [{ reviews: one }])).code, 'refused_path');
    assert.ok(!fs.existsSync(path.join(refused, 'test.jsonl')));
  } finally { fs.unlinkSync(reviewsDir); fs.renameSync(reviewsDir + '.keep', reviewsDir); }
  /* Restored, the append works again. */
  assert.deepEqual(await value(a, 'notes-reviews-append', [{ reviews: one }]), { dir: reviewsDir, appended: 1 });
  a.close();
});

test('R11.10 from Lisp: notes-query, notes-backlinks, notes-file, notes-tasks, notes-cards, notes-find, unlinked-mentions, notes-grep', async () => {
  const a = await client();
  const ev = async (form: string) => { const r = await a.form(form); assert.equal(r.t, 'result', JSON.stringify(r)); assert.equal(r.error, undefined, JSON.stringify(r)); return r.value; };
  const nFiles = (await value(a, 'notes-nodes', [{}])).nodes.filter((n: Msg) => n.kind === 'file').length;
  assert.equal(await ev('(length (notes-query :kind "file"))'), String(nFiles));
  assert.equal(await ev('(length (notes-query))'), String((await value(a, 'notes-nodes', [{}])).nodes.length));
  assert.equal(await ev('(map (lambda (r) (cdr (assq (quote id) r))) (notes-query :kind "file" :tag "proj"))'), '("beta.md")');
  assert.equal(await ev('(map (lambda (r) (cdr (assq (quote id) r))) (notes-query :kind "heading" :text "under a setext"))'), '("beta.md#18")');
  assert.equal(await ev('(map (lambda (r) (cdr (assq (quote id) r))) (notes-query :kind "file" :path "gamma"))'), '("gamma/delta.org")');
  assert.equal(await ev('(map (lambda (r) (cdr (assq (quote id) r))) (notes-query :kind "file" :linked-from "Delta"))'), '("alpha.md" "beta.md")');
  assert.equal(await ev('(map (lambda (r) (cdr (assq (quote id) r))) (notes-query :kind "file" :linked-to "sub/alpha"))'), '("alpha.md")');
  assert.equal(await ev('(map (lambda (r) (cdr (assq (quote title) r))) (notes-query :task-kw "WAITING"))'), '("on [[Beta]] to answer")');
  const due = await ev('(map (lambda (r) (cdr (assq (quote id) r))) (notes-tasks :due-before "2026-10-22"))');
  assert.ok(due.includes('"gamma/delta.org:11"'), due);
  assert.equal(await ev('(notes-tasks :due-before "2026-10-20")'), '()');
  assert.equal(await ev('(length (notes-tasks :task-kw (quote ("TODO" "NEXT"))))'), String((await value(a, 'notes-tasks')).tasks.filter((t: Msg) => t.kw === 'TODO' || t.kw === 'NEXT').length));
  assert.equal(await ev('(map (lambda (l) (cdr (assq (quote srcFile) l))) (notes-backlinks "sub/alpha.md"))'), '("alpha.md")');
  assert.equal(await ev('(length (notes-backlinks "B"))'), String((await value(a, 'notes-links')).backlinks['beta.md']), 'by alias');
  assert.equal(await ev('(cdr (assq (quote title) (notes-file "gamma/delta")))'), '"Delta"');
  assert.equal(await ev('(cdr (assq (quote path) (notes-file "Big Delta")))'), '"gamma/delta.org"');
  assert.equal(await ev('(notes-file "nothing here")'), '#f');
  assert.equal(await ev('(length (notes-cards "grc/vocab"))'), '4');
  assert.equal(await ev('(length (notes-cards))'), String((await value(a, 'notes-cards')).cards.length));
  assert.equal(await ev('(notes-find "alp")'), '("Alpha")');
  assert.equal(await ev('(member "Big Delta" (notes-find))') !== '#f', true);
  const um = await ev('(unlinked-mentions "Alpha")');
  assert.match(um, /#\("beta\.md" 12 \d+ "The first block's text, with a mention of Alpha\."\)/);
  assert.ok(!um.includes('"alpha.md" 1 '), 'the file itself is not a mention of itself');
  assert.ok(!um.includes('journal/2026-10-01.md'), 'links and block references are not mentions');
  const g = await ev('(notes-grep "Beta#\\\\^b1")');
  assert.match(g, /#\("alpha\.md" 9 \d+ /); assert.match(g, /#\("cards\/vocab\.md" 7 \d+ /);
  assert.equal(await ev('(notes-grep "ZZZnothing")'), '()');
  const cs = await ev('(notes-grep "alpha" "g")');
  assert.ok(cs.includes('#("beta.md" 16 ') && !cs.includes('"# Alpha"'), 'explicit flags: case-sensitive: ' + cs);
  const bad = await a.form('(notes-grep "(")');
  assert.ok(bad.error, 'a bad pattern is a Scheme error');
  assert.equal(await ev('(length (notes-ambiguous-links))'), String((await value(a, 'notes-ambiguous-links')).length));
  assert.equal(await ev('notes-generation'), String((await info(a)).gen));
  assert.equal(await ev('(notes-rebuild)'), '#t');
  a.close();
});

test('R11.6 snapshot at shutdown: a restart re-parses only the files that changed', async () => {
  const d2 = fixtureDir(); tmpRoots.push(d2.root);
  let ch = await start(d2);
  let c = await client({ kind: 'web' }, d2.cfg.socket);
  const i1 = await info(c);
  assert.equal(i1.startup.parsed, EXPECTED_FILES.length); assert.equal(i1.startup.reused, 0);
  const gen1 = i1.gen;
  c.close();
  await stop(ch);
  const snap = JSON.parse(fs.readFileSync(path.join(d2.dirs.state, 'notes-index', 'index.json'), 'utf8'));
  assert.equal(snap.v, 1); assert.equal(snap.files.length, EXPECTED_FILES.length); assert.equal(snap.gen, gen1);
  await sleep(20);
  fs.writeFileSync(path.join(d2.dirs.notes, 'sub', 'alpha.md'), '# Alpha Two\n\nRenamed on disk while edwind was down.\n');
  fs.unlinkSync(path.join(d2.dirs.notes, 'journal', '2026-10-01.md'));
  fs.writeFileSync(path.join(d2.dirs.notes, 'added.md'), '# Added\n');
  ch = await start(d2);
  c = await client({ kind: 'web' }, d2.cfg.socket);
  const i2 = await info(c);
  assert.equal(i2.startup.total, EXPECTED_FILES.length, 'one removed, one added');
  assert.equal(i2.startup.parsed, 2, 'the changed and the added file');
  assert.equal(i2.startup.reused, EXPECTED_FILES.length - 2);
  assert.ok(i2.gen > gen1, 'the generation continues across restarts');
  const nodes = (await value(c, 'notes-nodes', [{}])).nodes;
  assert.equal(nodes.find((n: Msg) => n.id === 'sub/alpha.md').title, 'Alpha Two');
  assert.ok(nodes.some((n: Msg) => n.id === 'added.md'));
  assert.ok(!nodes.some((n: Msg) => n.path === 'journal/2026-10-01.md'));
  /* No ambiguity remains: Alpha names one file now. */
  assert.equal((await value(c, 'notes-ambiguous-links')).length, 0);
  assert.equal((await value(c, 'notes-links')).links.find((l: Msg) => l.srcFile === 'beta.md' && l.dst === 'Alpha').dstFile, 'alpha.md');
  c.close();
  await stop(ch);
});

test('R11.5 a full rebuild of 10,000 files fits the budget and never stops the server answering', async () => {
  const d3 = makeDir(); tmpRoots.push(d3.root);
  const t0 = Date.now();
  for (let i = 0; i < 10000; i++) {
    const sub = path.join(d3.dirs.notes, 'd' + (i % 50));
    if (i < 50) fs.mkdirSync(sub, { recursive: true });
    const org = i % 10 === 0;
    const text = org
      ? `#+title: Note ${i}\n#+filetags: :gen:\n\n* TODO Task ${i} :work:\nSCHEDULED: <2026-11-01 Sun>\nLinks to [[Note ${(i + 1) % 10000}]] and ((^a${(i + 1) % 10000})).\n`
      : `# Note ${i}\n\nA generated note #gen linking [[Note ${(i + 1) % 10000}]] and [[Note ${(i + 7) % 10000}|seven]].\n\n## Section ^a${i}\n\n- TODO Task ${i} [#B]\n  session:: tmux:${i}\n- DONE Old ${i}\n\n## Card ^c${i}\ncard:: basic\ndeck:: gen\nback:: ${i}\n`;
    fs.writeFileSync(path.join(sub, `note-${i}.${org ? 'org' : 'md'}`), text);
  }
  const written = Date.now() - t0;
  const ch = await start(d3);
  const c = await client({ kind: 'web' }, d3.cfg.socket);
  /* The server answers while the startup build runs (notes-info waits for it; a form does not). */
  const t1 = Date.now();
  const pong = await c.form('(+ 1 1)');
  assert.equal(pong.value, '2');
  const answered = Date.now() - t1;
  const i = await value(c, 'notes-info', [], BUDGET_MS + 30000);
  assert.equal(i.files, 10000);
  const r = await value(c, 'notes-rebuild', [], BUDGET_MS + 30000);
  assert.equal(r.files, 10000);
  process.stderr.write(`notes: 10,000 files written in ${written} ms; startup build ${i.startup.ms} ms; full rebuild ${r.ms} ms (budget ${BUDGET_MS} ms); a form answered in ${answered} ms during the build\n`);
  assert.ok(r.ms <= BUDGET_MS, `rebuild took ${r.ms} ms, budget ${BUDGET_MS}`);
  assert.ok(i.startup.ms <= BUDGET_MS, `startup build took ${i.startup.ms} ms, budget ${BUDGET_MS}`);
  const tasks = (await value(c, 'notes-tasks')).tasks;
  assert.equal(tasks.length, 9000 * 2 + 1000);
  assert.equal((await value(c, 'notes-cards')).cards.length, 9000);
  const { links, backlinks } = await value(c, 'notes-links');
  assert.equal(links.filter((l: Msg) => l.dstFile).length, links.length, 'every generated link resolves');
  assert.equal(Object.keys(backlinks).length, 10000);
  c.close();
  await stop(ch);
});
