// The Scheme boundary (spec R16.15, R4.52, NG6): nothing in the image reaches JavaScript. The registry has no
// eval-like name, the host's globals are unbound symbols, a procedure prints and inspects as a handle without
// its JavaScript source, and host objects reach Scheme only as opaque handles. The credential cases of R16.19
// are in models.test.mts; the limits of R16.17 and the socket checks of R16.12 in conformance.test.mts.
// rename-file's share of the refusal list (R16.14, R14.8, R8.8) is at the end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeDir, startEdwind, stopEdwind, EditClient } from './edit-client.mts';

let dir, child;
before(async () => { dir = makeDir(); child = await startEdwind(dir); });
after(async () => { await stopEdwind(child); fs.rmSync(dir.root, { recursive: true, force: true }); });
const client = async (opts) => { const c = new EditClient(dir.cfg.socket, opts); await c.connect(); const w = await c.hello(); assert.equal(w.t, 'welcome'); return c; };

test('R16.15 the primitive registry has no JavaScript escape hatch, and the host globals are not bound', async () => {
  const c = await client();
  const prims = (await c.call('primitives')).value;
  const names = prims.map(p => p.name);
  for (const n of names) assert.doesNotMatch(n, /^js|js-eval|javascript|->js$|^js->|eval-js|new-function|^globalthis$|^process$/i, n);
  for (const sym of ['js-eval', 'globalThis', 'process', 'Function', 'eval-js', 'import', 'window', 'document', 'Reflect', 'Proxy', 'WebAssembly']) {
    const r = await c.form(`(${sym})`);
    assert.ok(r.error && (r.error.condition === 'unbound-variable' || r.error.condition === 'error' || r.error.condition === 'wrong-type-argument'), `${sym}: ${JSON.stringify(r)}`);
    if (r.error.condition === 'unbound-variable') continue;
    assert.doesNotMatch(r.error.report, /\[native code\]|function \(/, sym);
  }
  assert.equal((await c.form('(eval (quote (js-eval "1")))')).error.condition, 'unbound-variable', 'R4.52: no js-eval');
  c.close();
});

test('R16.15 procedures, records and host objects print as handles, never as JavaScript source', async () => {
  const c = await client();
  for (const form of ['car', '(lambda (x) x)', '(current-thread)', '(make-mutex)', '(make-mailbox)', '(current-buffer)', '(make-hash-table)', '(run-with-timer 10 #f (lambda () 1))']) {
    const r = await c.form(`(with-output-to-string (lambda () (write ${form}) (display " ") (display ${form})))`);
    assert.equal(r.error, undefined, form + ': ' + JSON.stringify(r.error));
    assert.doesNotMatch(r.value, /function|=>|\[native code\]|\{[^}]*:/, form + ' prints as a handle: ' + r.value);
  }
  assert.doesNotMatch((await c.form('(with-output-to-string (lambda () (write (list-clients-internal))))')).value, /socket|Socket|_handle/, 'a client prints without its socket');
  /* The inspector shows parts of a procedure (name, parameters, documentation), not its JavaScript. */
  await c.form('(inspect car)');
  const o = await c.open('name:*Inspector*');
  assert.match(o.text, /Inspecting the procedure car/);
  assert.doesNotMatch(o.text, /function|=>|\[native code\]/);
  c.close();
});

test('R16.15 a procedure\'s properties cannot be reached or changed from Scheme', async () => {
  const c = await client();
  /* No primitive takes or gives a JavaScript property: the only way at a procedure is to call it. */
  for (const form of ['(car (quote (1)) (quote __proto__))', '(string->symbol "constructor")', '(symbol-value (quote constructor))', '(hash-table-ref/default (make-hash-table) "__proto__" 1)']) {
    const r = await c.form(form);
    if (r.error) assert.ok(['wrong-number-of-arguments', 'unbound-variable', 'error', 'wrong-type-argument'].includes(r.error.condition), form + ': ' + r.error.condition);
    else assert.doesNotMatch(r.value, /function|\[object/, form + ': ' + r.value);
  }
  assert.equal((await c.form('(define x (make-hash-table)) (hash-table-set! x "__proto__" 7) (hash-table-ref/default x "__proto__" #f)')).value, '7', 'hash tables are Maps: prototype keys are plain keys');
  assert.equal((await c.form('(+ 1 1)')).value, '2');
  c.close();
});

test('R16.14 rename-file refuses both ends in, on or above the refusal list, through symlinks and .. paths, outside the writable paths and on edwind\'s own directories', async () => {
  const c = await client();
  const home = dir.dirs.home, at = p => path.join(home, p);
  for (const d of ['.ssh', '.config/systemd/user', '.local/share/systemd', 'mv']) fs.mkdirSync(at(d), { recursive: true });
  fs.symlinkSync(at('.ssh'), at('sshlink')); fs.symlinkSync(at('.config'), at('cfglink'));
  fs.writeFileSync(at('.ssh/authorized_keys'), 'key\n');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'edwind-outside-'));
  fs.writeFileSync(path.join(outside, 'o.md'), 'o\n');
  const src = () => { const p = at('mv/k-' + Math.random().toString(16).slice(2)); fs.writeFileSync(p, 'k\n'); return p; };
  const rename = (s, d) => c.call('rename-file', [{ src: s, dst: d }]);
  try {
    const dsts = ['~/.ssh/authorized_keys2', '~/.ssh', '~/.config/systemd/user/x.service', '~/.local/share/systemd/x', '~/mv/../.ssh/k', at('sshlink/k'), at('sshlink'), at('cfglink/systemd/x')];
    for (const d of dsts) {
      const s = src();
      const r = await rename(s, d);
      assert.equal(r.t, 'error', d); assert.equal(r.code, 'refused_path', d);
      assert.equal(r.msg, 'refused: the destination is in or above ~/.ssh or a systemd user-unit directory', d);
      assert.ok(fs.existsSync(s), `${d}: the source stays`);
    }
    assert.deepEqual(fs.readdirSync(at('.ssh')).sort(), ['authorized_keys']);
    assert.deepEqual(fs.readdirSync(at('.config/systemd/user')), []); assert.deepEqual(fs.readdirSync(at('.local/share/systemd')), []);
    // Sources in or above a refused path: moving them moves the protected file or directory.
    for (const s of ['~/.ssh/authorized_keys', '~/sshlink/authorized_keys', '~/.config', '~/.local/share']) {
      const r = await rename(s, '~/mv/taken');
      assert.equal(r.code, 'refused_path', s); assert.equal(fs.existsSync(at('mv/taken')), false, s);
    }
    // Outside the writable paths, at either end.
    assert.equal((await rename(path.join(outside, 'o.md'), '~/mv/o.md')).code, 'refused_path');
    assert.equal((await rename(src(), path.join(outside, 'k.md'))).code, 'refused_path');
    assert.deepEqual(fs.readdirSync(outside), ['o.md']);
    // edwind's notes, state and config directories, and what holds them, stay put.
    for (const s of [dir.dirs.notes, dir.dirs.state, dir.dirs.config, dir.root]) assert.equal((await rename(s, '~/mv/moved-root')).code, 'refused_path', s);
    // A notesDir-relative path may not climb out of it.
    assert.equal((await rename('../home/mv', '~/mv2')).code, 'bad_request');
    // The control: an ordinary move inside the writable paths.
    const ok = src(); assert.equal((await rename(ok, '~/mv/fine')).t, 'result'); assert.ok(fs.existsSync(at('mv/fine')));
  } finally { fs.rmSync(outside, { recursive: true, force: true }); c.close(); }
});

test('R16.14 rename-file keeps edwind\'s own directories when they are symlinks: neither the link nor its target moves', async () => {
  const d = makeDir();
  // notesDir and configDir as links into other directories (a synced notes folder, a configDir linked by home-manager).
  const notesTarget = path.join(d.root, 'sync-notes'), cfgTarget = path.join(d.root, 'managed-config');
  fs.mkdirSync(notesTarget, { mode: 0o700 }); fs.mkdirSync(cfgTarget, { mode: 0o700 });
  const notesLink = path.join(d.dirs.home, 'notes'), cfgLink = path.join(d.dirs.home, '.config-edwin');
  fs.symlinkSync(notesTarget, notesLink); fs.symlinkSync(cfgTarget, cfgLink);
  fs.writeFileSync(path.join(notesTarget, 'n.md'), 'n\n');
  d.cfg.notesDir = notesLink; d.cfg.configDir = cfgLink;
  fs.writeFileSync(d.file, JSON.stringify(d.cfg));
  const e = await startEdwind(d);
  const c = new EditClient(d.cfg.socket); await c.connect(); await c.hello();
  const rename = (s, t) => c.call('rename-file', [{ src: s, dst: t }]);
  try {
    for (const [s, t] of [['~/notes', '~/notes/old'], ['~/notes', '~/aside'], ['~/.config-edwin', '~/edwin-aside'], [notesTarget, '~/aside2'], [cfgTarget, '~/aside3']]) {
      const r = await rename(s, t);
      assert.equal(r.t, 'error', `${s} -> ${t}`); assert.equal(r.code, 'refused_path', `${s} -> ${t}`);
    }
    assert.equal(fs.readlinkSync(notesLink), notesTarget); assert.equal(fs.readlinkSync(cfgLink), cfgTarget);
    assert.deepEqual(fs.readdirSync(notesTarget), ['n.md']);
    // The control: a note under the linked notesDir still moves.
    const ok = await rename('n.md', 'm.md');
    assert.equal(ok.t, 'result', JSON.stringify(ok)); assert.deepEqual(fs.readdirSync(notesTarget), ['m.md']);
  } finally { c.close(); await stopEdwind(e); fs.rmSync(d.root, { recursive: true, force: true }); }
});

test('visit-id: the board\'s file opener learns the canonical id and whether edwind would edit the file, without loading it', async () => {
  const c = await client();
  const home = dir.dirs.home;
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Host x\n');
  fs.writeFileSync(path.join(dir.dirs.notes, 'vi.md'), '# vi\n');
  fs.symlinkSync(path.join(dir.dirs.notes, 'vi.md'), path.join(home, 'vi-link.md'));
  fs.writeFileSync(path.join(home, 'bin.dat'), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'edwind-visit-'));
  fs.writeFileSync(path.join(outside, 'ro.md'), 'ro\n');
  const visit = p => c.call('visit-id', [p]);
  try {
    assert.deepEqual((await visit(path.join(dir.dirs.notes, 'vi.md'))).value, { buf: 'vi.md', readOnly: false }, 'an absolute path under notesDir is the relative id');
    assert.deepEqual((await visit('~/vi-link.md')).value, { buf: 'vi.md', readOnly: false }, 'a symlink and its target are one buffer');
    assert.deepEqual((await visit(path.join(outside, 'ro.md'))).value, { buf: path.join(fs.realpathSync(outside), 'ro.md'), readOnly: 'outside the writable paths' });
    assert.equal((await visit('~/.ssh/config')).code, 'refused_path');
    assert.equal((await visit('~/bin.dat')).code, 'not_text');
    assert.equal((await visit('~/nothing-here.md')).code, 'no_buffer');
    fs.mkdirSync(path.join(home, 'vdir'));
    assert.equal((await visit('~/vdir')).code, 'not_text', 'a directory is not a page');
    assert.equal((await visit('../x.md')).code, 'bad_id');
    const listed = (await c.call('buffer-list')).value.map(b => b.id);
    assert.ok(!listed.includes('vi.md') && !listed.some(id => id.endsWith('ro.md')), 'nothing was loaded');
  } finally { fs.rmSync(outside, { recursive: true, force: true }); c.close(); }
});
