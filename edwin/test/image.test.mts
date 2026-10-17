// The edit-image gate (spec §16.1, R16.20 A4): the image log and its replication (§4.4, R4.14–R4.21,
// R7.19, R13.9, §18.2 Q2). Two edwind restarts, three simulated frames: each frame is an isolated Scheme
// (src/scheme.js alone) that evaluates every image{forms} it receives in order, skips on-server forms as
// emacs.scm does in a frame, applies var messages, and starts a fresh runtime when welcome.imageEpoch
// changes. The compaction threshold is lowered through EDWIND_IMAGE_COMPACT_ENTRIES.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { makeDir, startEdwind, stopEdwind, EditClient, EDWIN } from './edit-client.mts';
import { loadSchemeIn } from './scheme-load.mts';
import { fromJSON, LOG_BUFFER_ID } from '../server/image.mts';

const SCHEME_SRC = fs.readFileSync(path.join(EDWIN, 'src/scheme.js'), 'utf8');
const COMPACT_ENTRIES = 12;
const ENV = { EDWIND_IMAGE_COMPACT_ENTRIES: String(COMPACT_ENTRIES) };
/* What a frame runtime has that bare scheme.js lacks, as far as this suite's forms go: a global-map and a
   define-key that records bindings, and the E2 macros of emacs.scm in their frame-side reading. */
const PRELUDE = `
(define global-map 'global-map)
(define key-bindings '())
(define (define-key map key def) (set! key-bindings (cons (list map key def) key-bindings)) def)
(define (declare-definitional head) head)
(define-syntax on-frames (syntax-rules () ((_ body ...) (begin body ...))))
(define-syntax defvar-shared (syntax-rules () ((_ name init) (define name init)) ((_ name init doc) (define name init))))
`;

let dir, child;
before(async () => { dir = makeDir(); child = await startEdwind(dir, { env: ENV }); });
after(async () => { for (const f of frames) f.close(); await stopEdwind(child); fs.rmSync(dir.root, { recursive: true, force: true }); });

const until = async (cond, what, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = cond(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await new Promise(r => setTimeout(r, 15)); } };
const cli = async (extra = {}) => { const c = new EditClient(dir.cfg.socket); await c.connect(); const w = await c.hello(extra); assert.equal(w.t, 'welcome'); c.welcome = w; return c; };
const status = async c => (await c.call('status')).value;
const restart = async () => { await stopEdwind(child); child = await startEdwind(dir, { env: ENV }); };

/* A simulated frame runtime. */
class Frame {
  constructor() { this.cid = randomBytes(16).toString('hex'); this.S = null; this.gen = 0; this.epoch = null; this.applied = []; this.skipped = []; this.errors = []; this.vars = []; this.boots = 0; }
  boot() { this.S = loadSchemeIn(SCHEME_SRC); this.S.evalString(PRELUDE); this.gen = 0; this.applied = []; this.skipped = []; this.errors = []; this.boots++; }
  /* hello, then R7.19: a new imageEpoch means a fresh runtime from generation 0; otherwise image?{from} resumes. */
  async connect() {
    this.client = new EditClient(dir.cfg.socket, { kind: 'frame', cid: this.cid });
    await this.client.connect();
    const w = await this.client.hello(); assert.equal(w.t, 'welcome');
    this.welcome = w;
    if (!this.S || w.imageEpoch !== this.epoch) { this.boot(); this.epoch = w.imageEpoch; }
    this.pump();
    const r = await this.client.request({ t: 'image?', from: this.gen });
    assert.equal(r.t, 'result'); this.synced = r.value.gen;
    return w;
  }
  pump() { this.loop = (async () => { for (;;) { let m; try { m = await this.client.next(x => x.t === 'image' || x.t === 'var', 1e9); } catch (e) { return; } this.apply(m); } })(); }
  apply(m) {
    const S = this.S;
    if (m.t === 'var') { this.vars.push(m); S.gdef(m.name, fromJSON(S, m.value)); return; }
    for (const text of m.forms) {
      const f = S.read(text);
      if (f instanceof S.Pair && f.car instanceof S.Sym && f.car.name === 'on-server') { this.skipped.push(text); continue; } // R4.16
      try { S.evalForm(f); this.applied.push(text); } catch (e) { this.errors.push({ gen: m.gen, form: text, error: S.errorMessage(e) }); } // reported and skipped, the frame keeps going
    }
    this.gen = m.gen;
  }
  ev(text) { return this.S.write(this.S.evalString(text)); }
  msgs() { return this.client.queue.filter(m => m.t === 'msg').map(m => m.text); }
  close() { try { this.client.close(); } catch (e) { /* closed */ } }
}
const frames = [new Frame(), new Frame(), new Frame()];
const synced = async gen => until(() => frames.every(f => f.gen >= gen), `frames at generation ${gen} (at ${frames.map(f => f.gen)})`);
const reconnectAll = async () => { await until(() => frames.every(f => f.client.closed), 'frames disconnected after the epoch change'); for (const f of frames) await f.connect(); };

test('R4.14, R4.15, R4.16, R4.18, R13.9, Q2, A4: definitions from wb eval reach three frames in order; non-definitional forms stay on the server', async () => {
  for (const f of frames) { const w = await f.connect(); assert.equal(w.gen, 0); assert.match(w.imageEpoch, /^[0-9a-f]{16}$/); }
  const a = await cli({ session: 'acp-1' });
  let r = await a.form('(define (f1) 1)'); assert.equal(r.value, 'f1');
  r = await a.form('(define-key global-map "C-c t" (lambda () (insert "x")))'); assert.ok(!r.error, 'A4: define-key from wb eval');
  r = await a.form('(defvar-shared shared-count 1 "The count.")'); assert.equal(r.value, 'shared-count');
  r = await a.form('(set! shared-count 41)'); assert.ok(!r.error);
  r = await a.form('(on-server (define (srv-secret) 42))'); assert.equal(r.value, 'srv-secret');
  r = await a.form('(on-frames (define (frame-only) 3))'); assert.equal(r.value, '#f', 'R4.17: the server skips on-frames');
  assert.equal((await a.form("(bound? 'frame-only)")).value, '#f');
  assert.equal((await a.form('(+ 1 2)')).value, '3');
  r = await a.form('(begin (define (helper) 7) (display "x"))'); assert.equal(r.out, 'x', 'a begin with a non-definitional form is not logged');
  r = await a.form('(define uses-helper (helper))'); assert.equal(r.value, 'uses-helper');
  const st = await status(a);
  assert.equal(st.imageGen, 7);
  await synced(7);
  const entries = (await a.call('image-entries')).value;
  assert.deepEqual(entries.map(e => e.form), ['(define (f1) 1)', '(define-key global-map "C-c t" (lambda () (insert "x")))', '(defvar-shared shared-count 1 "The count.")', '(set! shared-count 41)', '(on-server (define (srv-secret) 42))', '(on-frames (define (frame-only) 3))', '(define uses-helper (helper))']);
  assert.deepEqual(entries.map(e => e.gen), [1, 2, 3, 4, 5, 6, 7]);
  for (const e of entries) { assert.deepEqual(e.by, { kind: 'cli', device: a.device, session: 'acp-1' }); assert.equal(e.origin, 'cli:acp-1'); assert.ok(Number.isInteger(e.at)); }
  for (const f of frames) {
    assert.deepEqual(f.applied, entries.map(e => e.form).filter(t => !t.startsWith('(on-server')).filter(t => !t.startsWith('(define uses-helper')), 'every logged form, in order');
    assert.deepEqual(f.skipped, ['(on-server (define (srv-secret) 42))']);
    assert.equal(f.ev('(f1)'), '1');
    assert.equal(f.ev('(cadr (car key-bindings))'), '"C-c t"', 'A4: the binding reached the frame without a reload');
    assert.equal(f.ev('shared-count'), '41');
    assert.equal(f.ev("(bound? 'srv-secret)"), '#f');
    assert.equal(f.ev('(frame-only)'), '3');
    assert.equal(f.errors.length, 1); assert.equal(f.errors[0].gen, 7); assert.match(f.errors[0].error, /helper/);
    assert.ok(f.vars.some(v => v.name === 'shared-count' && v.value === 41), 'var{name, value} after the assignment');
    assert.ok(f.msgs().some(t => /^Image changed by cli:acp-1: f1 /.test(t)), 'Q2: the banner names the origin and the definition');
    assert.ok(!f.client.queue.some(m => m.t === 'image' && m.forms.some(t => /\(\+ 1 2\)|display "x"/.test(t))));
  }
  /* R4.18: a value that is not JSON, or too large, is refused at assignment and the value stays. */
  r = await a.form("(set! shared-count 'dark)"); assert.equal(r.error.condition, 'error'); assert.match(r.error.report, /JSON-serialisable/);
  r = await a.form('(set! shared-count (make-string 70000 #\\a))'); assert.match(r.error.report, /64 KiB/);
  assert.equal((await a.form('shared-count')).value, '41');
  assert.equal((await status(a)).imageGen, 7, 'a failed assignment is not logged');
  r = await a.form('(set! shared-count (list 1 "two" #t))'); assert.ok(!r.error);
  await synced(8);
  for (const f of frames) assert.equal(f.ev('shared-count'), '(1 "two" #t)');
  a.close();
});

test('R4.21 one entry is at most 1 MiB: a larger form is evaluated but refused from the log with a msg', async () => {
  const a = await cli();
  const g = (await status(a)).imageGen;
  const r = await a.form(`(define big-string "${'a'.repeat((1 << 20) + 1000)}")`);
  assert.equal(r.value, 'big-string'); assert.match(r.msg, /Not logged to the image/);
  assert.equal((await a.form('(string-length big-string)')).value, String((1 << 20) + 1000));
  assert.equal((await status(a)).imageGen, g);
  a.close();
});

test('R4.19, R7.19 a plain restart replays the log after boot: boot differs, imageEpoch stays, frames resume from their gen; a failed replay is listed by image-problems', async () => {
  const a0 = await cli();
  /* A definition that calls a module's primitive at definition time replays: modules install before the replay. */
  assert.equal((await a0.form('(on-server (define saved-mutex (make-mutex "saved")))')).value, 'saved-mutex');
  const before = await status(a0); a0.close();
  await restart();
  for (const f of frames) { const w = await f.connect(); assert.notEqual(w.boot, before.boot); assert.equal(w.imageEpoch, before.imageEpoch); assert.equal(w.gen, before.imageGen); }
  assert.ok(frames.every(f => f.boots === 1), 'the runtime stays when only boot differs');
  assert.ok(frames.every(f => f.synced === before.imageGen && f.gen === before.imageGen));
  const a = await cli();
  assert.equal((await a.form('(f1)')).value, '1');
  assert.equal((await a.form('(srv-secret)')).value, '42', 'on-server forms replay on the server');
  assert.equal((await a.form('(mutex? saved-mutex)')).value, '#t', 'a define using a module primitive replays in the full runtime');
  assert.equal((await a.form("(bound? 'frame-only)")).value, '#f', 'on-frames forms are skipped at replay too');
  assert.equal((await a.form('shared-count')).value, '(1 "two" #t)');
  const p = await a.call('image-problems');
  assert.equal(p.value.length, 1); assert.equal(p.value[0].form, '(define uses-helper (helper))'); assert.match(p.value[0].error, /helper/); assert.equal(p.value[0].gen, 7);
  assert.match(p.msg, /1 image entry failed/);
  assert.equal((await status(a)).imageProblems, 1);
  const r = await a.form('(define (f2) 2)'); assert.equal(r.value, 'f2');
  await synced(before.imageGen + 1);
  for (const f of frames) { assert.equal(f.applied[f.applied.length - 1], '(define (f2) 2)'); assert.equal(f.ev('(f2)'), '2'); assert.equal(f.applied.filter(t => t === '(define (f1) 1)').length, 1, 'no entry twice'); }
  a.close();
});

test('Q2 image-revert-entry removes one entry, changes imageEpoch and every frame rebuilds without it', async () => {
  const a = await cli();
  const st = await status(a);
  const r = await a.call('image-revert-entry', [{ gen: st.imageGen }]);
  assert.equal(r.value.form, '(define (f2) 2)'); assert.notEqual(r.value.epoch, st.imageEpoch);
  assert.equal((await a.form('(f2)')).value, '2', 'the server image keeps the definition until its next start');
  await reconnectAll();
  for (const f of frames) { assert.equal(f.boots, 2, 'a fresh runtime'); assert.equal(f.welcome.imageEpoch, r.value.epoch); assert.equal(f.ev("(bound? 'f2)"), '#f'); assert.equal(f.ev('(f1)'), '1'); }
  const log = fs.readFileSync(path.join(dir.dirs.state, 'image.jsonl'), 'utf8');
  assert.ok(!log.includes('(define (f2) 2)')); assert.match(log, new RegExp(`"epoch":"${r.value.epoch}"`));
  await assert.rejects(async () => { const e = await a.call('image-revert-entry', [{ gen: 9999 }]); if (e.t === 'error') throw new Error(e.msg); }, /no image entry/);
  a.close();
});

test('R4.20 image-compact keeps the last definition per name and changes imageEpoch; frames start fresh (R7.19)', async () => {
  const a = await cli();
  const e0 = (await status(a)).imageEpoch;
  await a.form('(define (f1) 11)');
  await a.form('(set! shared-count 5)');
  await a.form('(set! shared-count 5)');
  const r = await a.call('image-compact');
  assert.equal(r.value.dropped, 2, 'the earlier define of f1 and the duplicate set!'); assert.notEqual(r.value.epoch, e0);
  const forms = (await a.call('image-entries')).value.map(e => e.form);
  assert.deepEqual(forms.filter(t => /define \(f1\)/.test(t)), ['(define (f1) 11)']);
  assert.deepEqual(forms.filter(t => /set! shared-count 5/.test(t)), ['(set! shared-count 5)']);
  assert.equal((await status(a)).imageEpoch, r.value.epoch);
  await reconnectAll();
  for (const f of frames) { assert.equal(f.boots, 3); assert.equal(f.ev('(f1)'), '11'); assert.equal(f.ev('shared-count'), '5'); }
  a.close();
});

test('R4.20 image-reset needs {force: true}, archives the log as image.<time>.jsonl and starts fresh at generation 0', async () => {
  const a = await cli();
  const e0 = (await status(a)).imageEpoch;
  const refused = await a.call('image-reset'); assert.equal(refused.t, 'error'); assert.equal(refused.code, 'bad_request');
  const r = await a.call('image-reset', [{ force: true }]);
  assert.match(path.basename(r.value.archived), /^image\.\d{4}-\d{2}-\d{2}T.*\.jsonl$/);
  assert.match(fs.readFileSync(r.value.archived, 'utf8'), /\(define \(f1\) 11\)/);
  const st = await status(a);
  assert.equal(st.imageGen, 0); assert.notEqual(st.imageEpoch, e0); assert.equal(st.imageEntries, 0); assert.equal(st.imageProblems, 0);
  await reconnectAll();
  for (const f of frames) { assert.equal(f.welcome.gen, 0); assert.equal(f.boots, 4); assert.equal(f.ev("(bound? 'f1)"), '#f'); }
  assert.equal((await a.form('(f1)')).value, '11', 'the server image keeps its definitions until the next start');
  a.close();
});

test(`R4.21 automatic compaction past ${COMPACT_ENTRIES} entries keeps the last definition per name and changes imageEpoch`, async () => {
  const a = await cli();
  const e0 = (await status(a)).imageEpoch;
  for (let i = 0; i < 15; i++) assert.ok(!(await a.form(`(define (g${i % 4}) ${i})`)).error);
  const st = await status(a);
  assert.notEqual(st.imageEpoch, e0);
  assert.equal(st.imageEntries, 6, '13 entries compacted to the 4 names, then 2 more');
  assert.equal(st.imageGen, 15);
  const lines = fs.readFileSync(path.join(dir.dirs.state, 'image.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 7); assert.equal(JSON.parse(lines[0]).epoch, st.imageEpoch);
  await reconnectAll();
  for (const f of frames) { assert.equal(f.ev('(g0)'), '12'); assert.equal(f.ev('(g2)'), '14'); assert.equal(f.ev('(g3)'), '11'); }
  a.close();
});

test('R4.20 image-save-to-init appends the live entries to init.scm and resets; they load at the next start', async () => {
  const a = await cli();
  const r = await a.call('image-save-to-init', [{ force: true }]);
  assert.equal(r.value.saved, 6); assert.equal(r.value.file, path.join(dir.dirs.config, 'init.scm'));
  const init = fs.readFileSync(r.value.file, 'utf8');
  assert.match(init, /;;; image log saved /); assert.match(init, /\(define \(g0\) 12\)/); assert.match(init, /;; gen \d+, .* cli@/);
  assert.equal((await status(a)).imageGen, 0);
  a.close();
  await restart();
  const b = await cli();
  const st = await status(b);
  assert.equal(st.imageGen, 0); assert.equal(st.imageEntries, 0);
  assert.equal((await b.form('(g0)')).value, '12', 'defined by init.scm at boot');
  assert.equal((await b.form('(g2)')).value, '14');
  await reconnectAll();
  b.close();
});

test('R4.20 image-log is the read-only server special buffer *image-log*, updated as the log changes; the Scheme commands work in the server image', async () => {
  const a = await cli();
  await a.form('(define (h1) 1)');
  const r = await a.call('image-log');
  assert.equal(r.value.buf, LOG_BUFFER_ID); assert.equal(r.value.entries, 1);
  assert.ok(a.queue.some(m => m.t === 'display' && m.buf === LOG_BUFFER_ID), 'display{buf} to the caller');
  const v = new EditClient(dir.cfg.socket, { kind: 'frame' }); await v.connect(); await v.hello();
  const o = await v.open(LOG_BUFFER_ID);
  assert.equal(o.meta.readOnly, 'server special buffer');
  assert.match(o.text, /^Image log: 1 entries, generation 1/); assert.match(o.text, /#1  \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}  cli@[^\n]*\n\(define \(h1\) 1\)\n/);
  await a.form('(define (h2) 2)');
  const edits = await v.next(m => m.t === 'edits' && m.buf === LOG_BUFFER_ID);
  assert.equal(edits.by.kind, 'server');
  const o2 = await (async () => { const w = new EditClient(dir.cfg.socket, { kind: 'frame' }); await w.connect(); await w.hello(); const x = await w.open(LOG_BUFFER_ID); w.close(); return x; })();
  assert.match(o2.text, /#2 .*\n\(define \(h2\) 2\)/);
  const bad = await v.edit(LOG_BUFFER_ID, o2.ver, [[0, '', 'x']]); assert.equal(bad.code, 'read_only');
  v.close();
  /* The Scheme side: commands in the server image, declare-definitional. */
  assert.equal((await a.form('(image-problems)')).msg, 'Every image entry replayed');
  let s = await a.form('(image-compact)'); assert.match(s.msg, /Image compacted: 0 dropped, 2 kept/);
  await reconnectAll();
  s = await a.form('(image-revert-entry 99)'); assert.equal(s.error.condition, 'error'); assert.match(s.error.report, /no image entry/);
  s = await a.form('(image-reset "no")'); assert.equal(s.msg, 'Image reset cancelled');
  assert.equal((await status(a)).imageGen, 2);
  s = await a.form("(declare-definitional 'my-defthing)"); assert.equal(s.value, 'my-defthing');
  s = await a.form('(define (my-defthing . args) args)'); // the head must exist for the form to evaluate
  s = await a.form('(my-defthing 1 2)'); assert.equal(s.value, '(1 2)');
  const forms = (await a.call('image-entries')).value.map(e => e.form);
  assert.ok(forms.includes("(declare-definitional 'my-defthing)") && forms.includes('(my-defthing 1 2)'), 'declared heads are logged');
  s = await a.form('(image-reset "yes")'); assert.match(s.msg, /^Image reset; the old log is .*\/image\.\d{4}-.*\.jsonl$/);
  assert.equal((await status(a)).imageGen, 0);
  await reconnectAll();
  a.close();
});
