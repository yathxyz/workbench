// Edwin's editing core with no browser: `node --test edwin/test/`.
// One Edwin per process (it keeps its state in globals), so the cases run in order on fresh buffers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startEdwin } from './headless.mts';
import type { Edwin } from './headless.mts';

type Globals = typeof globalThis & { EvilCore: Edwin };
declare const document: unknown, window: unknown;

const ed = await startEdwin();
let n = 0;
async function fresh(ext = 'txt') { await ed.type(`:e t${++n}.${ext}\n`); assert.equal(ed.text(), ''); }

test('boots into *scratch* in Normal state with the shipped config loaded', () => {
  assert.equal(ed.E.current.name, '*scratch*');
  assert.equal((globalThis as Globals).EvilCore.stateOf(ed.E.current), 'normal');
  for (const b of ['emacs.scm', 'evil.scm', 'init.scm']) assert.ok(ed.Ed.getBuffer(b), b);
});

test('Insert, Normal, operators, undo and redo', async () => {
  await fresh();
  await ed.type('ihello world foo'); await ed.keys('ESC');
  assert.equal(ed.text(), 'hello world foo');
  assert.equal((globalThis as Globals).EvilCore.stateOf(ed.E.current), 'normal');
  await ed.type('0wdw'); assert.equal(ed.text(), 'hello foo');
  await ed.type('u'); assert.equal(ed.text(), 'hello world foo');
  await ed.keys('C-r'); assert.equal(ed.text(), 'hello foo');
  await ed.type('u');
  await ed.type('ciwthere'); await ed.keys('ESC');
  assert.equal(ed.text(), 'hello there foo');
});

test('lines, counts, the dot command and a macro', async () => {
  await fresh();
  await ed.type('ione'); await ed.keys('ESC');
  await ed.type('yy2p'); assert.equal(ed.text(), 'one\none\none');
  await ed.type('ggA!'); await ed.keys('ESC');
  await ed.type('j.j.'); assert.equal(ed.text(), 'one!\none!\none!');
  await ed.type('ggqaI- '); await ed.keys('ESC'); await ed.type('jq2@a');
  assert.equal(ed.text(), '- one!\n- one!\n- one!');
});

test('ex commands: substitute, global and sort', async () => {
  await fresh();
  await ed.type('ipear\napple\nfig'); await ed.keys('ESC');
  await ed.type(':%s/p/P/g\n'); assert.equal(ed.text(), 'Pear\naPPle\nfig');
  await ed.type(':sort\n'); assert.equal(ed.text(), 'Pear\naPPle\nfig');
  await ed.type(':%s/^/x/\n:sort!\n'); assert.equal(ed.text(), 'xfig\nxaPPle\nxPear');
  await ed.type(':g/fig/d\n'); assert.ok(!ed.text().includes('fig'));
});

test('a malformed name in evil-ex-commands leaves the other ex commands working', async () => {
  await fresh();
  await ed.type('ib\na'); await ed.keys('ESC');
  ed.eval('(set! evil-ex-commands (cons (cons "bad[name" \'ignore) evil-ex-commands))');
  try { await ed.type(':sort\n'); assert.equal(ed.text(), 'a\nb'); }
  finally { ed.eval('(set! evil-ex-commands (cdr evil-ex-commands))'); }
});

test(':bn visits every buffer when some have a shared buffer\'s string id', async () => {
  const names = ['bn1.txt', 'bn2.txt', 'bn3.txt', 'bn4.txt'];
  for (const f of names) await ed.type(`:e ${f}\n`);
  for (const f of ['bn2.txt', 'bn3.txt']) ed.Ed.getBuffer(f).id = 'srv/' + f;
  const seen = new Set<string>(), all = ed.E.buffers.filter((b: Edwin) => !b.name.startsWith(' ') && !/^\*(Messages|Help|Registers|Marks|Buffer List)\*$/.test(b.name)).length;
  for (let i = 0; i < all; i++) { await ed.type(':bn\n'); seen.add(ed.E.win.name); }
  assert.equal(seen.size, all);
  for (const f of names) assert.ok(seen.has(f), f);
});

test('visual mode and text objects', async () => {
  await fresh();
  await ed.type('i(alpha beta) gamma'); await ed.keys('ESC');
  await ed.type('0lvi(d'); assert.equal(ed.text(), '() gamma');
  await ed.type('$viwU'); assert.equal(ed.text(), '() GAMMA');
});

test('every edit lands in the delta log that edwind will send', async () => {
  await fresh();
  const b = ed.E.current, v0 = b.ver;
  await ed.type('iab'); await ed.keys('ESC'); await ed.type('x');
  const log = b.log.filter((e: Edwin) => e.v > v0);
  assert.ok(log.length >= 2);
  // Replaying the log on the empty text gives the buffer's text.
  let t = '';
  for (const e of log) { assert.equal(t.slice(e.pos, e.pos + e.del.length), e.del); t = t.slice(0, e.pos) + e.ins + t.slice(e.pos + e.del.length); }
  assert.equal(t, ed.text());
});

test('Scheme: define a command, bind it, run it from a key', async () => {
  await fresh();
  await ed.type('ione two'); await ed.keys('ESC');
  await ed.type(':(define-command (shout-all) (interactive) (upcase-region (point-min) (point-max)))\n');
  await ed.type(':(evil-define-key \'normal \'global "g S" \'shout-all)\n');
  await ed.type('gS'); assert.equal(ed.text(), 'ONE TWO');
});

test('saving writes the file store', async () => {
  await fresh();
  await ed.type('isaved text'); await ed.keys('ESC');
  await ed.type(':w\n');
  assert.equal(ed.Ed.Store.get(`t${n}.txt`), 'saved text');
  assert.equal(ed.E.current.modified, false);
});

test('Org: a heading, a TODO state from the minibuffer and a demote', async () => {
  await fresh('org');
  assert.equal(ed.E.current.mode, 'org-mode');
  await ed.type('i* task'); await ed.keys('ESC');
  await ed.keys('C-c C-t'); await ed.type('TODO\n');
  assert.match(ed.text(), /^\* TODO task/);
  await ed.keys('M-<right>');
  assert.match(ed.text(), /^\*\* TODO task/);
});

test('no page objects exist in this process: the core reached none to boot (R4.1)', () => {
  assert.equal(typeof document, 'undefined');
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof localStorage, 'undefined');
  assert.equal(ed.E.headless, true);
  assert.equal(ed.E.frame, null);
  assert.equal(ed.eval('(selected-frame)'), false);
});

test('Org commands exist after boot (R9.1: boot runs after all 13 files)', () => {
  for (const c of ['org-todo', 'org-agenda', 'org-capture', 'org-roam-node-find', 'org-cycle'])
    assert.ok(ed.L.isCommand(ed.L.intern(c)), c);
});

test('the shipped Scheme in scm/ is what index.html carries', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const name of ['emacs', 'evil', 'org', 'ai', 'init']) {
    const m = new RegExp(`<script type="text/x-scheme" id="${name}-scm">\\n([\\s\\S]*?)</script>`).exec(html);
    assert.ok(m, name);
    assert.equal(m[1], readFileSync(new URL(`../scm/${name}.scm`, import.meta.url), 'utf8'), name + '.scm');
  }
});

test('persistent tables flush through the host when the process suspends', async () => {
  await ed.type(':e flush.txt\n');
  ed.host.suspend();
  assert.ok(ed.host.storage.keys().some((k: string) => k === 'edwin:savehist'));
});

test('ws-butler: saving a Scheme buffer drops its trailing blanks', async () => {
  await fresh('scm');
  await ed.type('i(define x 1)   \n(define y 2)\t'); await ed.keys('ESC');
  await ed.type(':w\n');
  assert.equal(ed.Ed.Store.get(`t${n}.scm`), '(define x 1)\n(define y 2)');
  assert.equal(ed.text(), '(define x 1)\n(define y 2)');
  assert.equal(ed.E.current.modified, false);
});

test('avy-goto-char-2 jumps to the only visible pair, matched without case', async () => {
  await fresh();
  await ed.type('ione Two three'); await ed.keys('ESC'); await ed.type('0');
  await ed.keys('M-x'); await ed.type('avy-goto-char-2\ntw');
  assert.equal(ed.point(), 4);
});

test('local-set-key binds in the current major mode’s keymap', async () => {
  await fresh();
  await ed.type('ione two'); await ed.keys('ESC');
  await ed.type(':(define-command (shout-local) (interactive) (upcase-region (point-min) (point-max)))\n');
  await ed.type(`:(local-set-key "C-c z" 'shout-local)\n`);
  assert.ok(ed.eval(`(keymapp ${ed.E.current.mode}-map)`));
  await ed.keys('C-c z'); assert.equal(ed.text(), 'ONE TWO');
  await fresh('scm');
  await ed.type('ione'); await ed.keys('ESC'); await ed.keys('C-c z');
  assert.equal(ed.text(), 'one', 'another major mode keeps its own keys');
});
