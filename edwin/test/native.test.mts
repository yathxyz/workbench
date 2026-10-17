// The core's seams for the desktop program (DT1): a host file system (host.files), leaving with an exit status
// (hooks.killEmacs), suspending, the input half of the display seam, and persistent tables read again.
// The Node host stands in for host-native.js; the program itself is tested by edwin/native/tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FILES, createHost, loadEdwin } from './headless.mts';
import type { Edwin, NodeHost } from './headless.mts';

type Globals = typeof globalThis & { L: Edwin };
/* host.files, as host-native.js shapes it (the Node host has none of its own). */
interface HostFiles {
  resolve(n: string): string; label(p: string): string; read(n: string): string | null; write(n: string, t: string): void; remove(n: string): void;
  list(): string[]; exists(n: string): boolean; truename(n: string): string;
}

const host = createHost({ workers: false }) as NodeHost & { files?: HostFiles };
const Ed = loadEdwin(host);
Ed.boot({ host });
await Ed.whenIdle();
const E = Ed.E, L = (globalThis as Globals).L;
const feed = async (keys: string[]) => { for (const k of keys) Ed.feedKey(k); await Ed.whenIdle(); };
const keys = (s: string) => feed(Ed.kbd(s).split(' '));
const type = (s: string) => feed([...s].map(ch => (ch === ' ' ? 'SPC' : ch === '\n' ? 'RET' : ch)));
const ev = (src: string) => { L.resetOps(); return L.evalText(src); };
ev('(set! display-line-numbers #f)');

/* A file system in memory, rooted at /w, as host-native.js shapes host.files. */
const disk = new Map<string, string>(), links = new Map<string, string>();   // links: a symbolic link's path -> its target's
let failWrites = false;
host.files = {
  resolve: (n: string) => (n.startsWith('/') ? n : '/w/' + n),
  label: (p: string) => (p.startsWith('/w/') ? p.slice(3) : p),
  read(n: string) { const p = this.resolve(n); return disk.has(p) ? disk.get(p)! : null; },
  write(n: string, t: string) { if (failWrites) throw new Error('Permission denied'); disk.set(this.resolve(n), t); },
  remove(n: string) { disk.delete(this.resolve(n)); },
  list: () => [...disk.keys()].filter(p => p.startsWith('/w/')).map(p => p.slice(3)),
  exists(n: string) { return disk.has(this.resolve(n)); },
  truename(n: string) { const p = this.resolve(n); return links.get(p) || p; },
};
const exits: number[] = [];
let suspended = 0;
Ed.hooks.killEmacs = (code: number) => exits.push(code);
Ed.hooks.suspendFrame = () => { suspended++; };

let size = { cols: 60, rows: 16 }, model: Edwin = null; // any: the display model is built by the untyped core
const frame = Ed.makeFrame(null, { backend: { tty: true, size: () => size, draw: (m: Edwin) => { model = m; } } });
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
  assert.deepEqual(JSON.parse(m![1].replace(/'/g, '"')), FILES);
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

test('a file under a second name (a symbolic link) is the buffer already open', async () => {
  await fresh();
  disk.set('/w/real.txt', 'r\n'); links.set('/w/alias.txt', '/w/real.txt');
  await type(':e real.txt\n');
  const b = E.current;
  await type(':e alias.txt\n');
  assert.equal(E.current, b);
  assert.equal(E.buffers.filter((x: Edwin) => x.file).length, 1);
});

test('host-native.js: foo, ./foo and bar/../foo are one path; ~ is the home directory', () => {
  const src = readFileSync(new URL('../native/js/host-native.js', import.meta.url), 'utf8');
  const N = { env: (k: string) => ({ HOME: '/home/u' } as Record<string, string>)[k], cwd: () => '/w', realpath: (p: string) => (p === '/w/l' ? '/w/t' : null) };
  const ctx = vm.createContext({ __n: N });
  vm.runInContext(src, ctx);
  const H = ctx.EdNativeHost;
  for (const n of ['foo', './foo', 'bar/../foo', './/foo', '/w/./foo', '../w/foo']) assert.equal(H.resolve(n), '/w/foo', n);
  assert.equal(H.resolve('~/a/../b'), '/home/u/b');
  assert.equal(H.resolve('/../x'), '/x');
  assert.equal(H.truename('./l'), '/w/t');
  assert.equal(H.truename('new.txt'), '/w/new.txt');
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
  for (const [name, kept] of [['.git/COMMIT_EDITMSG', false], ['kept.txt', true]] as [string, boolean][]) {
    await fresh();
    disk.set('/w/' + name, 'a\nb\nc\n');
    await type(`:e ${name}\n`);
    await type('jj');
    await fresh();
    await type(`:e ${name}\n`);
    assert.equal(E.current.pt, kept ? 4 : 0, name);
  }
});

test('gui.js: window events reach display.input as the page names them; the backend draws through __n', async () => {
  /* The natives gui.js uses (natives.rs), and what it defines. */
  interface GuiNatives {
    guiSize(): { cols: number; rows: number; theme?: string } | null;
    guiDraw(json: string): void;
    guiAction(name: string, arg?: string): void;
  }
  const G0 = globalThis as typeof globalThis & { __n?: GuiNatives; EdGui?: Edwin };
  const calls: [string, unknown][] = [];
  G0.__n = {
    guiSize: () => ({ cols: 5, rows: 1, theme: 'light' }),
    guiDraw: json => { calls.push(['draw', JSON.parse(json).cols]); },
    guiAction: (name, arg) => { calls.push([name, arg]); },
  };
  vm.runInThisContext(readFileSync(new URL('../native/js/gui.js', import.meta.url), 'utf8'));
  const G = G0.EdGui, s = G.screen();
  assert.deepEqual(s.backend.size(), { cols: 8, rows: 3 }, 'a window is never smaller than 8x3 cells');
  assert.equal(s.backend.tty, false);
  assert.equal(s.theme(), 'light');
  s.backend.draw({ cols: 8 }); s.backend.bell(); s.clipboard('copied'); s.iconify();
  assert.deepEqual(calls, [['draw', 8], ['bell', undefined], ['clipboard', 'copied'], ['iconify', undefined]]);

  const seen: string[] = [], on = { close: () => { seen.push('close'); }, drop: (p: string) => { seen.push('drop ' + p); } };
  const D = Ed.display, input = D.input;
  D.input = (f: Edwin, e: { type: string; key?: string }) => { assert.equal(f, frame); seen.push(e.type === 'key' ? e.key! : e.type); };
  try {
    const key = (k: string, code: string, mods = {}) => G.handle(JSON.stringify({ type: 'key', key: k, code, ...mods }), frame, on);
    key('x', 'KeyX');
    key('x', 'KeyX', { ctrlKey: true });
    key('x', 'KeyX', { altKey: true });
    key('Shift', 'ShiftLeft', { shiftKey: true });
    key('Escape', 'Escape');
    key('Enter', 'Enter');
    key('@', 'KeyQ', { ctrlKey: true, altKey: true, altGraph: true });
    G.handle(JSON.stringify({ type: 'text', text: 'é a\n' }), frame, on);
    G.handle(JSON.stringify({ type: 'mouse', action: 'down', x: 1, y: 1, button: 0 }), frame, on);
    G.handle(JSON.stringify({ type: 'close' }), frame, on);
    G.handle(JSON.stringify({ type: 'drop', path: '/w/d.txt' }), frame, on);
    G.handle('not json', frame, on);
  } finally { D.input = input; delete G0.__n; }
  assert.deepEqual(seen, ['x', 'C-x', 'M-x', 'ESC', 'RET', '@', 'é', 'SPC', 'a', 'RET', 'mouse', 'close', 'drop /w/d.txt']);

  // Segments past U+02FF carry display.js's widths, so the window cannot count a character otherwise.
  const m = G.withWidths({ lines: [[{ x: 0, w: 3, text: 'abc', f: 0 }, { x: 3, w: 4, text: 'a漢\u0627\u0670', f: 0 }]] });
  assert.equal(m.lines[0][0].cw, undefined);
  assert.deepEqual(m.lines[0][1].cw, [1, 2, 1, 0]);
});
