// The core's seams for the desktop program (DT1): a host file system (host.files), leaving with an exit status
// (hooks.killEmacs), suspending, the input half of the display seam, and persistent tables read again.
// The Node host stands in for host-native.js; the program itself is tested by edwin/native/tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FILES, createHost, loadEdwin } from './headless.mjs';

const host = createHost({ workers: false });
const Ed = loadEdwin(host);
Ed.boot({ host });
await Ed.whenIdle();
const E = Ed.E, L = globalThis.L;
const feed = async keys => { for (const k of keys) Ed.feedKey(k); await Ed.whenIdle(); };
const keys = s => feed(Ed.kbd(s).split(' '));
const type = s => feed([...s].map(ch => (ch === ' ' ? 'SPC' : ch === '\n' ? 'RET' : ch)));
const ev = src => { L.resetOps(); return L.evalText(src); };
ev('(set! display-line-numbers #f)');

/* A file system in memory, rooted at /w, as host-native.js shapes host.files. */
const disk = new Map();
let failWrites = false;
host.files = {
  resolve: n => (n.startsWith('/') ? n : '/w/' + n),
  label: p => (p.startsWith('/w/') ? p.slice(3) : p),
  read(n) { const p = this.resolve(n); return disk.has(p) ? disk.get(p) : null; },
  write(n, t) { if (failWrites) throw new Error('Permission denied'); disk.set(this.resolve(n), t); },
  remove(n) { disk.delete(this.resolve(n)); },
  list: () => [...disk.keys()].filter(p => p.startsWith('/w/')).map(p => p.slice(3)),
  exists(n) { return disk.has(this.resolve(n)); },
};
const exits = [];
let suspended = 0;
Ed.hooks.killEmacs = code => exits.push(code);
Ed.hooks.suspendFrame = () => { suspended++; };

let size = { cols: 60, rows: 16 }, model = null;
const frame = Ed.makeFrame(null, { backend: { tty: true, size: () => size, draw: m => { model = m; } } });
frame.focused = true;
const fresh = async () => {
  await keys('ESC'); if (E.mini) Ed.abortMini();
  Ed.deleteOtherWindows();
  for (const b of E.buffers.slice()) if (b.file) { b.modified = false; L.call('kill-buffer', [b]); }
  exits.length = 0;
};

test('boot.js loads the core files in host-node.js\'s order', () => {
  const src = readFileSync(new URL('../native/js/boot.js', import.meta.url), 'utf8');
  const m = /const FILES = (\[[^\]]*\])/.exec(src);
  assert.deepEqual(JSON.parse(m[1].replace(/'/g, '"')), FILES);
});

test('with host.files a file is a path: visit reads it, the buffer keeps the absolute name, save writes it', async () => {
  await fresh();
  disk.set('/w/notes.txt', 'one\ntwo\n');
  await type(':e notes.txt\n');
  const b = E.current;
  assert.equal(b.name, 'notes.txt');
  assert.equal(b.file, '/w/notes.txt');
  assert.equal(b.text, 'one\ntwo\n');
  await type('Ax');
  await keys('ESC');
  await type(':w\n');
  assert.equal(disk.get('/w/notes.txt'), 'onex\ntwo\n');
  assert.equal(E.echo, 'Wrote notes.txt');
});

test('require-final-newline adds the newline a saved file lacks', async () => {
  await fresh();
  ev('(set! require-final-newline #t)');
  try {
    await type(':e bare.txt\n');
    await type('ihi');
    await keys('ESC');
    await type(':w\n');
    assert.equal(disk.get('/w/bare.txt'), 'hi\n');
  } finally { ev('(set! require-final-newline #f)'); }
});

test('a write that fails is an error, and the buffer stays modified', async () => {
  await fresh();
  await type(':e locked.txt\n');
  await type('ix');
  await keys('ESC');
  failWrites = true;
  try { await type(':wq\n'); } finally { failWrites = false; }
  assert.match(E.echo, /Cannot write \/w\/locked.txt: Permission denied/);
  assert.equal(E.current.modified, true);
  assert.deepEqual(exits, [], ':wq did not quit after the failed write');
});

test(':q on the last window ends the program; changes refuse it until :q!', async () => {
  await fresh();
  disk.set('/w/q.txt', 'q\n');
  await type(':e q.txt\n');
  await type(':q\n');
  assert.deepEqual(exits, [0]);
  exits.length = 0;
  await type('x');
  await type(':q\n');
  assert.match(E.echo, /E37/);
  assert.deepEqual(exits, []);
  await type(':q!\n');
  assert.deepEqual(exits, [0]);
});

test(':q in a split closes the window only', async () => {
  await fresh();
  await type(':e q.txt\n');
  await keys('C-w s');
  assert.equal(Ed.windowList().length, 2);
  await type(':q\n');
  assert.equal(Ed.windowList().length, 1);
  assert.deepEqual(exits, []);
});

test(':cq leaves with status 1 or its argument, saving nothing', async () => {
  await fresh();
  disk.set('/w/c.txt', 'c\n');
  await type(':e c.txt\n');
  await type('dd');
  await type(':cq\n');
  await type(':cq 7\n');
  assert.deepEqual(exits, [1, 7]);
  assert.equal(disk.get('/w/c.txt'), 'c\n');
});

test(':wq and ZZ save first; :qa names another changed buffer; :wqa saves them all', async () => {
  await fresh();
  disk.set('/w/a.txt', 'a\n'); disk.set('/w/b.txt', 'b\n');
  await type(':e a.txt\n'); await type('x');
  await type(':e b.txt\n'); await type('x');
  await type(':w\n');
  await type(':qa\n');
  assert.match(E.echo, /E162: No write since last change for buffer "a.txt"/);
  assert.deepEqual(exits, []);
  await type(':wqa\n');
  assert.equal(disk.get('/w/a.txt'), '\n');
  assert.deepEqual(exits, [0]);
  exits.length = 0;
  await type('Ay'); await keys('ESC');
  await type('ZZ');
  assert.equal(disk.get('/w/b.txt'), 'y\n');
  assert.deepEqual(exits, [0]);
});

test('C-x C-c asks about each changed file, then leaves', async () => {
  await fresh();
  disk.set('/w/x.txt', 'x\n');
  await type(':e x.txt\n'); await type('x');
  await keys('C-x C-c');
  assert.match(E.prompt || '', /Save file \/w\/x.txt\?/);
  await type('y');
  assert.equal(disk.get('/w/x.txt'), '\n');
  assert.deepEqual(exits, [0]);
  exits.length = 0;
  await type('ix'); await keys('ESC');
  await keys('C-x C-c'); await type('n');
  assert.match(E.mini ? E.mini.prompt : '', /Modified buffers exist; exit anyway\?/);
  await type('no\n');
  assert.deepEqual(exits, []);
});

test('suspend-frame, can-kill-emacs? and display-graphic-p ask the host', async () => {
  await fresh();
  ev('(suspend-frame)');
  assert.equal(suspended, 1);
  assert.equal(ev('(can-kill-emacs?)'), true);
  assert.equal(ev('(display-graphic-p)'), false);
});

test('without the host hooks the commands say how to leave the page', async () => {
  await fresh();
  const k = Ed.hooks.killEmacs; Ed.hooks.killEmacs = null;
  try {
    assert.equal(ev('(can-kill-emacs?)'), false);
    await type(':cq\n');
    assert.match(E.echo, /Edwin lives in this page/);
    ev('(kill-emacs 3)');
    assert.match(E.echo, /Edwin runs inside this page/);
  } finally { Ed.hooks.killEmacs = k; }
  assert.deepEqual(exits, []);
});

test('display.input: keys, paste, focus, mouse and wheel in cell terms', async () => {
  await fresh();
  const D = Ed.display;
  disk.set('/w/m.txt', Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  await type(':e m.txt\n');
  const b = E.current;
  Ed.render();
  D.input(frame, { type: 'mouse', action: 'down', x: 5, y: 2, button: 0 });
  D.input(frame, { type: 'mouse', action: 'up', x: 5, y: 2, button: 0 });
  await Ed.whenIdle();
  assert.equal(b.pt, Ed.lineStartB(b, 3) + 5, 'the click put point on row 2, column 5');
  D.input(frame, { type: 'mouse', action: 'wheel', x: 5, y: 2, dy: 1 });
  await Ed.whenIdle(); Ed.render();
  assert.equal(Ed.lineNoB(b, frame.sel.start), 4, 'one notch scrolled three lines');
  D.input(frame, { type: 'key', key: 'g' }); D.input(frame, { type: 'key', key: 'g' });
  await Ed.whenIdle();
  assert.equal(b.pt, 0);
  D.input(frame, { type: 'paste', text: 'pasted\n' });
  await Ed.whenIdle();
  assert.ok(b.text.startsWith('pasted\nline 1'));
  D.input(frame, { type: 'focus', focused: false });
  await Ed.whenIdle(); Ed.render();
  assert.equal(frame.focused, false);
  assert.equal(model.focused, false);
  D.input(frame, { type: 'focus', focused: true });
  size = { cols: 40, rows: 10 };
  D.input(frame, { type: 'resize' });
  await Ed.whenIdle(); Ed.render();
  assert.equal(model.cols, 40);
  assert.equal(model.rows, 10);
});

test('Ed.reloadPersistent reads the tables again, replacing what it read before', () => {
  host.storage.set('edwin:recentf', JSON.stringify(['/w/one.txt', '/w/two.txt']));
  disk.set('/w/one.txt', '1'); disk.set('/w/two.txt', '2');
  Ed.reloadPersistent();
  Ed.reloadPersistent();
  const recent = L.arr(ev('(recentf-list)'));
  assert.deepEqual(recent.slice(0, 2), ['one.txt', 'two.txt']);
});

test('save-place leaves commit messages at the top, as Vim and Emacs do', async () => {
  for (const [name, kept] of [['.git/COMMIT_EDITMSG', false], ['kept.txt', true]]) {
    await fresh();
    disk.set('/w/' + name, 'a\nb\nc\n');
    await type(`:e ${name}\n`);
    await type('jj');
    await fresh();
    await type(`:e ${name}\n`);
    assert.equal(E.current.pt, kept ? 4 : 0, name);
  }
});
