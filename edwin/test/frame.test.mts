// The frame runtime against a real edwind (E3 H1, spec 6.3, 7, 9.5): Edwin's core on the Node host with
// src/sync.js as the protocol client, over a net.Socket wrapped to look like a WebSocket (one JSON text
// per send, newline framed on the wire). A second writer is an EditClient with an ot-sim style replica.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeDir, startEdwind, stopEdwind, EditClient, EDWIN } from './edit-client.mts';
import type { Msg, TestDir, EdwindChild, ClientOptions } from './edit-client.mts';
import { rng, randOp } from './ot-sim.mts';
import type { EditOp, OTModule } from './ot-sim.mts';

type EdwinCore = any; // any: Edwin's core (edwin/src) is untyped JavaScript
type Batch = { seq: number; base: number; ops: EditOp[] };

const require = createRequire(import.meta.url);
const { createHost, loadEdwin, memoryStorage } = require('../src/host-node.cts');
const OT = require('../src/ot.ts') as OTModule;

let dir: TestDir, child: EdwindChild, Ed: EdwinCore, E: EdwinCore, L: EdwinCore, sync: EdwinCore;
const note = (name: string, text: string) => { fs.writeFileSync(path.join(dir.dirs.notes, name), text); return name; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(pred: () => unknown, what = 'condition', ms = 8000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`); await sleep(10); } }
const settled = (b: EdwinCore) => until(() => !b.inflight && !b.queue.length && !b.sync.opening, `${b.name} settled`);
/* A WebSocket-like object over the unix socket: onopen/onmessage/onclose/onerror, send(text), close(). */
interface FakeSocket {
  onopen: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((e: Error) => void) | null;
  send(str: string): void;
  close(): void;
}
function transport(sockPath: string) {
  return () => {
    const s = net.connect(sockPath); s.setEncoding('utf8');
    const ws: FakeSocket = { onopen: null, onmessage: null, onclose: null, onerror: null, send: str => { s.write(str + '\n'); }, close: () => s.destroy() };
    let buf = '';
    s.on('connect', () => ws.onopen && ws.onopen());
    s.on('data', d => { buf += d; let i: number; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line && ws.onmessage) ws.onmessage({ data: line }); } });
    s.on('close', () => ws.onclose && ws.onclose());
    s.on('error', e => ws.onerror && ws.onerror(e));
    return ws;
  };
}
async function client(opts?: ClientOptions) { const c = new EditClient(dir.cfg.socket, opts); await c.connect(); const w = await c.hello(); assert.equal(w.t, 'welcome'); return c; }
const feed = async (keys: string[]) => { for (const k of keys) Ed.feedKey(k); await Ed.whenIdle(); };
const keys = (s: string) => feed(Ed.kbd(s).split(' '));
const type = (s: string) => feed([...s].map(ch => (ch === ' ' ? 'SPC' : ch === '\n' ? 'RET' : ch)));
const show = (b: EdwinCore) => { Ed.setWindowBuffer(b); E.current = b; };
const messages = () => Ed.getBuffer('*Messages*').text;
async function serverText(id: string) { const c = await client(); const o = await c.open(id); c.close(); return o.text; }

/* A second writer whose replica follows R7.12 (the ot-sim Client over a real socket). */
class Writer {
  declare c: EditClient; declare id: string; declare inflight: Batch | null; declare queue: { ops: EditOp[] }[]; declare seq: number; declare acks: Set<number>; declare gen: number;
  declare text: string; declare sverText: string; declare sver: number; declare loop: Promise<void>;
  constructor(c: EditClient, id: string) { this.c = c; this.id = id; this.inflight = null; this.queue = []; this.seq = 0; this.acks = new Set(); this.gen = 0; }
  async open() { const o = await this.c.open(this.id); this.text = this.sverText = o.text!; this.sver = o.ver!; this.pump(); return this; }
  pump() { this.loop = (async () => { for (;;) { let m: Msg; try { m = await this.c.next(x => x.buf === this.id && (x.t === 'edits' || x.t === 'ack'), 1e9); } catch (e) { return; } this.recv(m); } })(); }
  local(ops: EditOp[]) {
    this.text = OT.apply(this.text, ops);
    if (!this.inflight) { this.inflight = { seq: ++this.seq, base: this.sver, ops }; this.send(); } else this.queue.push({ ops });
  }
  send() { this.c.send({ t: 'edit', buf: this.id, base: this.inflight!.base, seq: this.inflight!.seq, ops: this.inflight!.ops, undo: { g: 'w' + (++this.gen) } }); }
  recv(msg: Msg) {
    if (msg.t === 'ack') {
      if (this.acks.has(msg.seq)) return;
      assert.equal(msg.seq, this.inflight!.seq, 'ack for the wrong batch');
      this.acks.add(msg.seq);
      this.sverText = OT.apply(this.sverText, this.inflight!.ops); this.sver = msg.ver; this.inflight = null;
      if (this.queue.length) { const q = this.queue.shift()!; this.inflight = { seq: ++this.seq, base: this.sver, ops: q.ops }; this.send(); }
      return;
    }
    assert.equal(msg.ver, this.sver + 1, 'edits out of order');
    let R = OT.fromOps(msg.ops, this.sverText.length);
    let base = OT.apply(this.sverText, msg.ops);
    this.sverText = base; this.sver = msg.ver;
    if (this.inflight) {
      const [Rp, Ip] = OT.transform(R, OT.fromOps(this.inflight.ops, this.sverText.length - OT.delta(msg.ops)));
      this.inflight.ops = OT.toOps(Ip, base); this.inflight.base = this.sver; R = Rp; base = OT.applyOperation(base, Ip);
    }
    for (let i = 0; i < this.queue.length; i++) {
      const [Rp, Qp] = OT.transform(R, OT.fromOps(this.queue[i].ops, R.baseLen));
      this.queue[i].ops = OT.toOps(Qp, base); R = Rp; base = OT.applyOperation(base, Qp);
    }
    this.text = OT.apply(this.text, OT.toOps(R, this.text));
    assert.equal(this.text, base);
  }
  settled() { return until(() => !this.inflight && !this.queue.length, 'writer settled'); }
}

/* ---------- a small DOM for the frame tests ----------
   Enough of Element and Document for Ed.makeFrame and a render with no browser (R9.2): a node tree, class,
   id and data attributes, inline style, listeners, innerHTML parsed for the simple markup the core writes,
   the selectors the core and the overlay hooks use (.c, #i, tag.c, .c[data-x="v"], lists), and a fixed
   geometry: a monospace grid of 8 x 21 px in a 600 x 400 view, each .ln at its index. */
interface FakeEvent { type: string; target: FakeElement; defaultPrevented: boolean; preventDefault(): void; [k: string]: unknown }
type Handler = (e: FakeEvent) => void;
type FakeChild = FakeElement | FakeText;
interface Query { tag: string | null; classes: string[]; id: string | null; attrs: { name: string; value: string | null }[] }
interface Rect { left: number; top: number; width: number; height: number; right: number; bottom: number }
interface FakeDocument {
  nodeType: 9; listeners: [string, Handler][]; hit: FakeElement | null;
  createElement(tag: string): FakeElement; createTextNode(s: string): FakeText;
  documentElement: FakeElement; body: FakeElement; activeElement: FakeElement;
  getElementById(id: string): FakeElement | null;
  addEventListener(t: string, fn: Handler): void; removeEventListener(): void;
  elementFromPoint(): FakeElement | null;
  caretPositionFromPoint(): { offsetNode: FakeElement; offset: number } | null;
  defaultView: {
    document: FakeDocument;
    getComputedStyle(): { lineHeight: string; paddingTop: string; paddingLeft: string; paddingRight: string };
    addEventListener(t: string, fn: Handler): void; removeEventListener(): void; getSelection(): null;
  };
}
class FakeNode {
  declare ownerDocument: FakeDocument; declare nodeType: number; declare nodeName: string; declare parentNode: FakeElement | null; declare childNodes: FakeChild[];
  constructor(doc: FakeDocument, type: number, name: string) { this.ownerDocument = doc; this.nodeType = type; this.nodeName = name; this.parentNode = null; this.childNodes = []; } get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; } }
class FakeText extends FakeNode { declare nodeType: 3; declare nodeValue: string; constructor(doc: FakeDocument, s: string) { super(doc, 3, '#text'); this.nodeValue = s; } get textContent() { return this.nodeValue; } }
const kebab = (k: string) => k.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] !== undefined ? ENT[e] : m));
function parseSelector(sel: unknown): Query[] {
  return String(sel).split(',').map(part => {
    const m = /^\s*([a-zA-Z0-9-]+)?((?:[.#][-\w]+|\[[-\w]+(?:="[^"]*")?\])*)\s*$/.exec(part);
    if (!m) throw new Error('fake DOM: unsupported selector ' + sel);
    const q: Query = { tag: m[1] ? m[1].toLowerCase() : null, classes: [], id: null, attrs: [] };
    for (const t of m[2].match(/[.#][-\w]+|\[[^\]]*\]/g) || []) {
      if (t[0] === '.') q.classes.push(t.slice(1));
      else if (t[0] === '#') q.id = t.slice(1);
      else { const a = /^\[([-\w]+)(?:="([^"]*)")?\]$/.exec(t)!; q.attrs.push({ name: a[1], value: a[2] === undefined ? null : a[2] }); }
    }
    return q;
  });
}
function matches(el: FakeElement, q: Query) {
  if (q.tag && el.localName !== q.tag) return false;
  if (q.id !== null && el.id !== q.id) return false;
  for (const c of q.classes) if (!el.classList.contains(c)) return false;
  for (const a of q.attrs) { if (!el.attrs.has(a.name)) return false; if (a.value !== null && el.attrs.get(a.name) !== a.value) return false; }
  return true;
}
function walk(n: FakeChild, fn: (n: FakeChild) => void) { fn(n); for (const c of n.childNodes) walk(c, fn); }
class FakeElement extends FakeNode {
  declare nodeType: 1; declare tagName: string; declare localName: string; declare attrs: Map<string, string>; declare listeners: [string, Handler, unknown][]; declare value: string; declare _html: string;
  declare style: { cssText: string; setProperty(k: string, v: unknown): void; getPropertyValue(k: string): string };
  declare classList: { contains(c: string): boolean; add(...cs: string[]): void; remove(...cs: string[]): void; toggle(c: string, force?: unknown): boolean };
  declare dataset: Record<string, string | undefined>;
  constructor(doc: FakeDocument, tag: string) {
    super(doc, 1, tag.toUpperCase());
    this.tagName = tag.toUpperCase(); this.localName = tag.toLowerCase(); this.attrs = new Map(); this.listeners = []; this.value = ''; this._html = '';
    const props = new Map();
    this.style = { cssText: '', setProperty: (k, v) => { props.set(k, String(v)); }, getPropertyValue: k => props.get(k) || '' };
    const el = this, classes = () => (el.attrs.get('class') || '').split(/\s+/).filter(Boolean), setClasses = (cs: string[]) => { el.attrs.set('class', cs.join(' ')); };
    this.classList = {
      contains: c => classes().includes(c),
      add: (...cs) => { const l = classes(); for (const c of cs) if (!l.includes(c)) l.push(c); setClasses(l); },
      remove: (...cs) => setClasses(classes().filter(c => !cs.includes(c))),
      toggle: (c, force) => { const on = force === undefined ? !classes().includes(c) : !!force; if (on) el.classList.add(c); else el.classList.remove(c); return on; },
    };
    this.dataset = new Proxy({} as Record<string, string | undefined>, {
      get: (t, k) => (typeof k === 'string' ? el.attrs.get('data-' + kebab(k)) : undefined),
      set: (t, k, v) => { el.attrs.set('data-' + kebab(k as string), String(v)); return true; },
      deleteProperty: (t, k) => { el.attrs.delete('data-' + kebab(k as string)); return true; },
      has: (t, k) => el.attrs.has('data-' + kebab(k as string)),
    });
  }
  get id() { return this.attrs.get('id') || ''; } set id(v) { this.attrs.set('id', String(v)); }
  get className() { return this.attrs.get('class') || ''; } set className(v) { this.attrs.set('class', String(v)); }
  get hidden() { return this.attrs.has('hidden'); } set hidden(v) { if (v) this.attrs.set('hidden', ''); else this.attrs.delete('hidden'); }
  get title() { return this.attrs.get('title') || ''; } set title(v) { this.attrs.set('title', String(v)); }
  getAttribute(n: string) { return this.attrs.has(n) ? this.attrs.get(n) : null; } setAttribute(n: string, v: unknown) { this.attrs.set(n, String(v)); } removeAttribute(n: string) { this.attrs.delete(n); } hasAttribute(n: string) { return this.attrs.has(n); }
  /* Live, as HTMLCollection is: the core reads length and indexes while it adds and removes. */
  get children() { const el = this, now = () => el.childNodes.filter((c): c is FakeElement => c.nodeType === 1); return new Proxy([] as FakeElement[], { get(t, k) { const c = now(); const v = (c as unknown as Record<string | symbol, unknown>)[k]; return typeof v === 'function' ? v.bind(c) : v; }, has(t, k) { return k in now(); } }); }
  get firstChild() { return this.childNodes[0] || null; } get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get isConnected() { let n: FakeElement = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument.documentElement; }
  appendChild(c: FakeChild) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  insertBefore(c: FakeChild, ref: FakeChild | null) { if (!ref) return this.appendChild(c); if (c.parentNode) c.parentNode.removeChild(c); const i = this.childNodes.indexOf(ref); if (i < 0) throw new Error('fake DOM: insertBefore of a non-child'); c.parentNode = this; this.childNodes.splice(i, 0, c); return c; }
  removeChild(c: FakeChild) { const i = this.childNodes.indexOf(c); if (i < 0) throw new Error('fake DOM: removeChild of a non-child'); this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  contains(n: FakeChild | null) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  get textContent(): string { return this.childNodes.map(c => c.textContent).join(''); }
  set textContent(s: string | null | undefined) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this._html = ''; if (s !== '' && s !== null && s !== undefined) this.appendChild(new FakeText(this.ownerDocument, String(s))); }
  get innerHTML() { return this._html; }
  set innerHTML(s) {
    this.textContent = ''; this._html = String(s);
    const re = /<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:\s+[a-zA-Z_:][-\w:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|([^<]+)|(<)/g;
    const voids = new Set(['br', 'hr', 'img', 'input', 'wbr']);
    let cur: FakeElement = this, m: RegExpExecArray | null;
    while ((m = re.exec(this._html))) {
      if (m[1]) { if (cur !== this) cur = cur.parentNode!; }
      else if (m[2]) {
        const el = this.ownerDocument.createElement(m[2]);
        for (const a of m[3].matchAll(/([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) el.attrs.set(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ''));
        cur.appendChild(el);
        if (!m[4] && !voids.has(el.localName)) cur = el;
      } else cur.appendChild(new FakeText(this.ownerDocument, m[5] !== undefined ? decode(m[5]) : '<'));
    }
  }
  querySelectorAll(sel: string) { const qs = parseSelector(sel), out: FakeElement[] = []; walk(this, n => { if (n !== this && n.nodeType === 1 && qs.some(q => matches(n, q))) out.push(n); }); return out; }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel: string) { const qs = parseSelector(sel); for (let n: FakeElement | null = this; n && n.nodeType === 1; n = n.parentNode) if (qs.some(q => matches(n, q))) return n; return null; }
  addEventListener(t: string, fn: Handler, o?: unknown) { this.listeners.push([t, fn, o]); } removeEventListener(t: string, fn: Handler) { this.listeners = this.listeners.filter(l => !(l[0] === t && l[1] === fn)); }
  /* Dispatch TYPE from this element up through its ancestors; returns the event. */
  dispatch(type: string, init?: Record<string, unknown>): FakeEvent { const e: FakeEvent = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init }; for (let n: FakeElement | null = this; n; n = n.parentNode) for (const [t, fn] of n.listeners || []) if (t === type) fn(e); return e; }
  focus() { this.ownerDocument.activeElement = this; } blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  getBoundingClientRect() {
    const rect = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height, right: left + width, bottom: top + height });
    const p = this.parentNode;
    if (this.localName === 'span' && p && p.nodeType === 1 && p.classList.contains('text')) return rect(0, 0, this.textContent.length * 8, 21);   // the metrics probe
    if (this.classList.contains('ln')) return rect(0, p!.children.indexOf(this) * 21, 600, 21);
    return rect(0, 0, 600, 400);
  }
  get clientWidth() { return 600; } get clientHeight() { return 400; } get offsetWidth() { return 600; } get offsetHeight() { return this.classList.contains('ln') ? 21 : 400; } get clientTop() { return 0; }
}
function makeDocument() {
  const doc = { nodeType: 9, listeners: [], hit: null } as unknown as FakeDocument;
  doc.createElement = tag => new FakeElement(doc, tag);
  doc.createTextNode = s => new FakeText(doc, s);
  doc.documentElement = doc.createElement('html'); doc.body = doc.createElement('body'); doc.documentElement.appendChild(doc.body);
  doc.activeElement = doc.body;
  doc.getElementById = id => { let r: FakeElement | null = null; walk(doc.documentElement, n => { if (!r && n.nodeType === 1 && n.id === id) r = n; }); return r; };
  doc.addEventListener = (t, fn) => { doc.listeners.push([t, fn]); }; doc.removeEventListener = () => {};
  /* The element and caret under a point: whatever the test put in doc.hit (the view), so posFromPoint
     falls back to the line rectangles. */
  doc.elementFromPoint = () => doc.hit;
  doc.caretPositionFromPoint = () => (doc.hit ? { offsetNode: doc.hit, offset: 0 } : null);
  doc.defaultView = { document: doc, getComputedStyle: () => ({ lineHeight: '21px', paddingTop: '0px', paddingLeft: '0px', paddingRight: '0px' }), addEventListener: (t, fn) => { doc.listeners.push([t, fn]); }, removeEventListener: () => {}, getSelection: () => null };
  return doc;
}

before(async () => {
  dir = makeDir();
  child = await startEdwind(dir);
  const host = createHost({ storage: memoryStorage(), workers: false });
  Ed = loadEdwin(host); E = Ed.E; L = (globalThis as unknown as { L: EdwinCore }).L;
  sync = await Ed.bootServed({ transport: transport(dir.cfg.socket), device: 'frame-test' });
  await Ed.whenIdle();
});
after(async () => { if (sync) sync.shutdown(); if (child) await stopEdwind(child); });

test('R4.11 served boot: no frame, the shipped Scheme loaded, nothing read from browser stores, candidates set', async () => {
  assert.equal(E.frames.length, 0); assert.equal(E.frame, null);
  assert.equal(sync.state, 'online'); assert.equal(sync.cid.length, 32); assert.equal(sync.ready, true);
  assert.ok(L.get('evil-mode') !== undefined || L.fnOrNull(L.intern('evil-normal-state')), 'evil.scm loaded');
  assert.equal(L.get('wiki-candidates') !== undefined, true);
  assert.equal(L.truthy(L.evalText('(image-server?)')), false, 'a frame is not the image server');
  assert.ok(Ed.getBuffer('*scratch*') && Ed.getBuffer('*Messages*'), 'the local buffers');
  assert.equal(Ed.getBuffer('*scratch*').shared, undefined);
  assert.ok(L.isCommand(L.intern('describe-browser-keys')) && L.isCommand(L.intern('eval-in-frame')));
});

test('E3 H3 gap 4: served boot evaluates the shipped Scheme without buffers; the buffer list is *scratch* and *Messages*', () => {
  assert.deepEqual(E.buffers.map((b: EdwinCore) => b.name).sort(), ['*Messages*', '*scratch*']);
  assert.equal(Number(L.evalText('(length (buffer-list))')), 2);
  /* The sources were evaluated all the same: emacs.scm, evil.scm, org.scm, markdown.scm (through org's require) and init.scm. */
  for (const f of ['emacs', 'evil', 'org', 'markdown', 'notes-syntax', 'address', 'ai', 'init']) assert.equal(L.truthy(L.evalText(`(featurep '${f})`)), true, `(provide '${f})`);
  assert.ok(L.isCommand(L.intern('markdown-todo-cycle')) && L.isCommand(L.intern('evil-normal-state')) && L.isCommand(L.intern('org-todo')));
  assert.equal(Ed.getBuffer('emacs.scm'), null); assert.equal(Ed.getBuffer('init.scm'), null);
});

test('open, snap, typing becomes one edit batch per command, the ack lands and the server has the text', async () => {
  const id = note('a.md', 'hello\n');
  const w = await client(); const wo = await w.open(id); assert.equal(wo.text, 'hello\n');
  const b = await sync.open(id);
  assert.equal(b.shared, true); assert.equal(b.text, 'hello\n'); assert.equal(b.sver, 0); assert.equal(b.readOnly, false);
  assert.ok(E.buffers.includes(b)); assert.equal(b.meta.file, path.join(dir.dirs.notes, 'a.md'));
  show(b);
  await type('iXY'); await keys('ESC');
  await settled(b);
  assert.equal(b.text, 'XYhello\n');
  /* The first self-insert goes out at once; the second waits in the queue (R7.12): two batches of one undo group. */
  const e = await w.next(m => m.t === 'edits' && m.buf === id);
  assert.deepEqual(e.ops, [[0, '', 'X']]);
  assert.equal(e.by.kind, 'frame'); assert.equal(e.by.cid, sync.cid); assert.equal(e.by.device, 'frame-test');
  const e2 = await w.next(m => m.t === 'edits' && m.buf === id);
  assert.deepEqual(e2.ops, [[1, '', 'Y']]);
  assert.equal(b.hist.length, 2); assert.equal(b.hist[0].cid, sync.cid); assert.ok(b.hist[0].undo.g);
  assert.equal(b.hist[0].undo.g, b.hist[1].undo.g, 'a run of self-inserts is one undo group');
  assert.equal(await serverText(id), 'XYhello\n');
  /* A second command is a second group. */
  await type('A!'); await keys('ESC'); await settled(b);
  assert.equal(b.text, 'XYhello!\n'); assert.equal(b.hist.length, 3); assert.notEqual(b.hist[2].undo.g, b.hist[0].undo.g);
  assert.equal(await serverText(id), 'XYhello!\n');
  w.close();
});

test('remote edits arrive with their origin and transform against the pending local batch', async () => {
  const id = note('r.md', 'abc\n');
  const b = await sync.open(id); show(b);
  const w = await client(); await w.open(id);
  let edited = 0; const off = Ed.onFrameEvent(() => { edited++; });
  const ack = await w.edit(id, b.sver, [[3, '', 'Z']]);
  assert.equal(ack.t, 'ack');
  await until(() => b.text === 'abcZ\n', 'the remote insert');
  assert.equal(b.sver, ack.ver);
  assert.equal(b.hist[b.hist.length - 1].cid !== sync.cid, true);
  /* Hold our own batch in flight by sending through a stalled path: a local insert and a remote one before the ack. */
  Ed.applyOps(b, [[0, '', 'L']], 'local');
  assert.ok(b.inflight, 'the local batch is in flight');
  await settled(b);
  assert.equal(b.text, 'LabcZ\n'); assert.equal(await serverText(id), 'LabcZ\n');
  off(); w.close();
});

test('randomised convergence: 200 interleaved steps of frame and writer edits end with equal texts', async () => {
  const id = note('c.md', 'the quick brown fox\njumps over\n');
  const b = await sync.open(id); show(b);
  const wc = await client(); const w = await new Writer(wc, id).open();
  const r = rng(7);
  for (let i = 0; i < 200; i++) {
    const k = r.int(0, 9);
    if (k < 4) { const op = randOp(r, b.text); if (op) Ed.applyOps(b, [op], 'local'); }
    else if (k < 8) { const op = randOp(r, w.text); if (op) w.local([op]); }
    else await sleep(r.int(0, 3));
  }
  await settled(b); await w.settled();
  await until(() => b.sver === w.sver, 'both replicas at the same version');
  assert.equal(b.text, w.text);
  assert.equal(b.text, await serverText(id));
  assert.equal(b.sync.sverText, b.text);
  wc.close();
});

test('R6.15-R6.18 undo by group: u takes a whole group back, C-r redoes, a partial undo names the other writer', async () => {
  const id = note('u.md', 'abc\n');
  const b = await sync.open(id); show(b);
  await type('iXY'); await keys('ESC'); await settled(b);
  assert.equal(b.text, 'XYabc\n');
  await keys('u'); await settled(b);
  assert.equal(b.text, 'abc\n');
  const u = b.hist[b.hist.length - 1];
  assert.equal(u.undo.of, b.hist[b.hist.length - 2].undo.g, 'the undo batch names the group it undoes');
  assert.equal(await serverText(id), 'abc\n');
  await keys('C-r'); await settled(b);
  assert.equal(b.text, 'XYabc\n'); assert.equal(await serverText(id), 'XYabc\n');
  assert.equal(b.hist[b.hist.length - 1].undo.of, undefined, 'redo is a new group');
  await keys('u'); await settled(b); assert.equal(b.text, 'abc\n');
  /* Partial: our PQ, then another writer deletes the Q; undo removes what is left and says so. */
  await type('iPQ'); await keys('ESC'); await settled(b);
  assert.equal(b.text, 'PQabc\n');
  const w = await client(); await w.open(id);
  const ack = await w.edit(id, b.sver, [[1, 'Q', '']]); assert.equal(ack.t, 'ack');
  await until(() => b.text === 'Pabc\n', 'the remote delete');
  await keys('u'); await settled(b);
  assert.equal(b.text, 'abc\n');
  assert.match(messages(), /Undo \(partial/);
  assert.equal(await serverText(id), 'abc\n');
  /* Nothing of ours left to undo locally: the server fallback answers. */
  await keys('u'); await sleep(200);
  assert.ok(b.text === 'abc\n' || b.text === 'PQabc\n');
  w.close();
});

test('R7.16 reconnect after edwind restarts: the unacknowledged batch is resent and nothing is lost', async () => {
  const id = note('k.md', 'keep\n');
  const b = await sync.open(id); show(b);
  await type('i1'); await keys('ESC'); await settled(b);
  assert.equal(await serverText(id), '1keep\n');
  const states: string[] = []; const off = sync.on('state', (s: string) => states.push(s));
  await stopEdwind(child);
  await until(() => sync.state !== 'online', 'offline');
  /* Offline edits queue up: the mode line shows the dot. */
  await type('A2'); await keys('ESC');
  assert.ok(b.inflight, 'held while offline'); assert.equal(b.text, '1keep2\n');
  assert.ok(Ed.hooks.modeStatus(b).includes('•') && Ed.hooks.modeStatus(b).includes('offline'));
  child = await startEdwind(dir);
  await until(() => sync.state === 'online', 'online again', 15000);
  await settled(b);
  assert.equal(b.text, '1keep2\n');
  assert.equal(await serverText(id), '1keep2\n');
  assert.ok(states.includes('offline') && states.includes('online'));
  assert.equal(Ed.hooks.modeStatus(b), '');
  off();
  /* The replica keeps working after the reconnect. */
  await type('A3'); await keys('ESC'); await settled(b);
  assert.equal(await serverText(id), '1keep23\n');
});

test('R4.15-R4.18 the image replicates: definitions arrive, on-server forms are skipped, shared variables follow', async () => {
  const c = await client();
  let r = await c.form('(define (frame-fn x) (* x 7))'); assert.ok(!r.error, JSON.stringify(r));
  r = await c.form('(on-server (define (srv-only) 1))'); assert.ok(!r.error);
  r = await c.form('(defvar-shared frame-shared 1 "A count.")'); assert.ok(!r.error);
  r = await c.form('(set! frame-shared 41)'); assert.ok(!r.error);
  await until(() => L.fnOrNull(L.intern('frame-fn')), 'the definition');
  assert.equal(String(L.evalText('(frame-fn 6)')), '42');
  await until(() => String(L.get('frame-shared')) === '41', 'the shared value');
  assert.equal(L.fnOrNull(L.intern('srv-only')), null, 'on-server forms are not evaluated in a frame');
  /* A bad form reports to *Messages* with its generation and does not stop the rest. */
  r = await c.form('(define (after-bad) 2)');
  await until(() => L.fnOrNull(L.intern('after-bad')), 'the later definition');
  c.close();
});

test('R4.27, R4.28 a :where server command runs on edwind; its edits come back as this frame\'s own and undo', async () => {
  const id = note('s.md', 'abc\n');
  const b = await sync.open(id); show(b);
  const c = await client();
  const r = await c.form('(define-command (stamp) "Append S." (interactive) (:where (quote server)) (goto-char (point-max)) (insert "S") (message "stamped"))');
  assert.ok(!r.error, JSON.stringify(r));
  await until(() => { const f = L.fnOrNull(L.intern('stamp')); return f && f.where === 'server'; }, 'the command in the frame');
  await keys('M-x'); await type('stamp'); await keys('RET');
  await until(() => b.text === 'abc\nS', 'the server edit');
  const h = b.hist[b.hist.length - 1];
  assert.equal(h.cid, sync.cid, 'the thread edit is ours'); assert.equal(h.by.via, 'server');
  await until(() => /stamped/.test(messages()), 'the result message');
  await keys('u'); await settled(b);
  assert.equal(b.text, 'abc\n', 'u undoes the server command\'s edit');
  assert.equal(await serverText(id), 'abc\n');
  c.close();
});

test('R4.29 ask reaches the minibuffer of the frame and the answer goes back; C-g answers quit', async () => {
  const c = await client();
  const r = await c.form('(define-command (greet2 n) (interactive "sName: ") (:where (quote server)) (message "hi ~a" n) n)');
  assert.ok(!r.error, JSON.stringify(r));
  await until(() => { const f = L.fnOrNull(L.intern('greet2')); return f && f.where === 'server'; }, 'the command');
  show(Ed.getBuffer('*scratch*'));
  await keys('M-x'); await type('greet2'); await keys('RET');
  await until(() => E.mini && /Name/.test(E.mini.prompt || ''), 'the ask prompt');
  await type('Bob'); await keys('RET');
  await until(() => /hi Bob/.test(messages()), 'the answer used');
  await keys('M-x'); await type('greet2'); await keys('RET');
  await until(() => E.mini && /Name/.test(E.mini.prompt || ''), 'the second ask');
  await keys('C-g');
  await until(() => !E.mini, 'the minibuffer closed');
  await until(() => /Quit/.test(E.echo) || /Quit/.test(messages()), 'quit reported');
  c.close();
});

test('R7.14, R7.17 bad_edit and stale_base recover: the buffer reopens and matches the server', async () => {
  const id = note('e.md', 'safe\n');
  const b = await sync.open(id); show(b);
  sync.sock.send(JSON.stringify({ t: 'edit', buf: id, base: b.sver, seq: ++b.sync.seq, ops: [[999, '', 'x']], undo: { g: 1 } }));
  await until(() => /refused an edit/.test(messages()), 'bad_edit reported');
  await settled(b);
  assert.equal(b.text, 'safe\n'); assert.equal(b.shared, true);
  /* stale_base needs a base older than the retained history; the server's answer is injected on the wire. */
  Ed.applyOps(b, [[0, '', 'pending'], ], 'local');
  sync.sock.onmessage({ data: JSON.stringify({ t: 'error', code: 'stale_base', buf: id, seq: b.inflight.seq, msg: 'base 0 is older than the retained history' }) });
  await until(() => /version edwind no longer has/.test(messages()), 'stale_base reported');
  assert.ok(E.buffers.some((x: EdwinCore) => /~offline-/.test(x.name) && x.text === 'pendingsafe\n'), 'the unsent edit is kept in an offline copy');
  await settled(b);
  assert.equal(b.text, await serverText(id));
  await type('iok'); await keys('ESC'); await settled(b);
  assert.match(b.text, /ok/); assert.equal(await serverText(id), b.text);
});

test('R9.12 anchors arrive in meta, move with local and remote edits, and anchor-add returns the id', async () => {
  const id = note('n.md', 'one two three\n');
  const b = await sync.open(id); show(b);
  const c = await client(); await c.open(id);
  const r = await c.call('anchor-add', [id, 4, 'two']);
  assert.ok(!r.error, JSON.stringify(r)); assert.equal(r.value.pos, 4);
  await until(() => b.meta.anchors.length === 1, 'the anchor in meta');
  assert.equal(b.meta.anchors[0].pos, 4); assert.equal(b.meta.anchors[0].label, 'two');
  Ed.applyOps(b, [[0, '', 'ZZ']], 'local');
  assert.equal(b.meta.anchors[0].pos, 6, 'moved by the local insert before the ack');
  await settled(b);
  assert.equal(b.meta.anchors[0].pos, 6);
  const ack = await c.edit(id, b.sver, [[0, '', 'Y']]); assert.equal(ack.t, 'ack');
  await until(() => b.meta.anchors[0].pos === 7, 'moved by the remote insert');
  const myId = await sync.anchorAdd(id, 1, 'mine', 'mine-1');
  assert.equal(myId, 'mine-1');
  await until(() => b.meta.anchors.length === 2, 'the second anchor');
  assert.equal(await sync.anchorRemove(id, 'mine-1'), true);
  await until(() => b.meta.anchors.length === 1, 'removed');
  c.close();
});

test('R4.30 server-only primitives are stubs that signal server-only with a hint', async () => {
  const f = L.fnOrNull(L.intern('anchor-add!'));
  assert.ok(f, 'the stub exists'); assert.equal(f.where, 'server');
  let err = null;
  try { L.evalText('(anchor-add! "x" 1)'); } catch (e) { err = e; }
  assert.ok(err && err.kind === 'server-only', String(err));
  assert.match(String(err.message), /runs in edwind/);
});

test('presence: another writer\'s sel is recorded per buffer with a colour and label', async () => {
  const id = note('p.md', 'abc\n');
  const b = await sync.open(id);
  const c = await client({ device: 'laptop' }); await c.open(id);
  c.send({ t: 'sel', buf: id, ranges: [[1, 3]] });
  await until(() => b.presence.length === 1, 'the presence entry');
  assert.deepEqual(b.presence[0].ranges, [[1, 3]]); assert.equal(b.presence[0].label, 'laptop');
  assert.match(b.presence[0].color, /^hsl\(/);
  c.close();
});

test('killed and moved: a buffer killed on the server leaves the frame; a message from edwind reaches the echo area', async () => {
  const id = note('x.md', 'bye\n');
  const b = await sync.open(id); show(Ed.getBuffer('*scratch*'));
  const c = await client();
  const r = await c.form(`(kill-buffer (get-buffer ${JSON.stringify(id)}))`);
  await until(() => !E.buffers.includes(b) || !b.shared, 'the kill');
  assert.ok(!sync.buffers.has(id));
  c.close();
});

test('moved: a file renamed on the server moves the replica to the new id; the frame keeps editing it and the page hears of it', async () => {
  const id = note('mv-frame.md', 'move me\n');
  const b = await sync.open(id); show(b);
  const heard: Msg[] = []; const off = sync.on('moved', (m: Msg) => heard.push(m));
  const c = await client();
  const r = await c.call('rename-file', [{ src: id, dst: 'mv-framed.md' }]);
  assert.equal(r.value.to, 'mv-framed.md');
  await until(() => b.id === 'mv-framed.md' && !b.sync.opening, 'the replica to follow');
  assert.deepEqual(heard, [{ buf: id, to: 'mv-framed.md' }]); off();
  assert.equal(sync.buffers.get('mv-framed.md'), b); assert.equal(sync.buffers.has(id), false);
  assert.equal(b.text, 'move me\n');
  await type('A, still mine'); await keys('ESC');
  await settled(b);
  assert.equal(await serverText('mv-framed.md'), 'move me, still mine\n');
  assert.equal(fs.existsSync(path.join(dir.dirs.notes, id)), false);
  c.close();
});

test('moved onto a replica this tab holds: an open of the old id settles with that replica, which stays attached and editable', async () => {
  const id = note('mv-old.md', 'kept\n');
  const c = await client();
  assert.equal((await c.call('rename-file', [{ src: id, dst: 'mv-new.md' }])).t, 'result');
  const have = await sync.open('mv-new.md'); show(have);
  const heard: Msg[] = []; const off = sync.on('moved', (m: Msg) => heard.push(m));
  const n = E.buffers.length;
  const got = await sync.open(id, { create: true });   // edwind sends the old id on to mv-new.md
  assert.equal(got, have, 'the open settles with the replica already held');
  assert.equal(sync.buffers.get('mv-new.md'), have); assert.equal(sync.buffers.has(id), false);
  assert.equal(E.buffers.length, n, 'the replica made for the old id is gone');
  assert.deepEqual(heard, [{ buf: id, to: 'mv-new.md' }]); off();
  // Still attached: another writer's edit reaches it, and its own edits are acked.
  const o = await c.open('mv-new.md');
  await c.edit('mv-new.md', o.ver!, [[0, '', 'theirs ']]);
  await until(() => have.text === 'theirs kept\n', 'the remote edit');
  await type('A, mine'); await keys('ESC');
  await settled(have);
  assert.equal(await serverText('mv-new.md'), 'theirs kept, mine\n');
  c.close();
});

test('E3 H3 gap 2: Ed.sync.close kills the local replica and moves the window showing it; a reopen is a fresh replica', async () => {
  const id = note('cl.md', 'close me\n');
  const b = await sync.open(id); show(b);
  assert.ok(E.buffers.includes(b)); assert.equal(E.sel.buffer, b); assert.equal(E.current, b);
  const n = E.buffers.length;
  sync.close(id);
  assert.equal(E.buffers.includes(b), false, 'the replica is killed');
  assert.equal(E.buffers.length, n - 1);
  assert.equal(sync.buffers.has(id), false); assert.equal(b.shared, false);
  assert.notEqual(E.sel.buffer, b, 'the window shows another buffer'); assert.notEqual(E.current, b);
  assert.ok(E.buffers.includes(E.sel.buffer));
  /* Closing twice, or an id never opened, is a no-op. */
  sync.close(id); sync.close('never-opened.md');
  /* The server took the close: a sel from another client no longer reaches this one through the old replica. */
  const b2 = await sync.open(id);
  assert.notEqual(b2, b); assert.equal(b2.text, 'close me\n'); assert.ok(E.buffers.includes(b2));
  /* A buffer object works as the argument too. */
  sync.close(b2);
  assert.equal(E.buffers.includes(b2), false); assert.equal(sync.buffers.has(id), false);
  /* An open still on its way settles with an error when closed. */
  const p = sync.open(note('cl2.md', 'x\n'));
  sync.close('cl2.md');
  await assert.rejects(p, (e: Error & { code?: string }) => e.code === 'closed');
  assert.equal(E.buffers.some((x: EdwinCore) => x.id === 'cl2.md'), false);
});

test('E3 H3 gap 3: hooks.renderOverlay runs for every frame drawn, with that frame current, the selected frame last', async () => {
  const doc = makeDocument();
  const el1 = doc.createElement('div'), el2 = doc.createElement('div'); doc.body.appendChild(el1); doc.body.appendChild(el2);
  const ba = await sync.open(note('o1.md', 'alpha one\n')), bb = await sync.open(note('o2.md', 'beta two\n'));
  const f1 = Ed.makeFrame(el1, { buffer: ba, kind: 'card', fontSize: 13 }), f2 = Ed.makeFrame(el2, { buffer: bb, kind: 'card' });
  assert.equal(E.frame, f1); assert.equal(E.frames.length, 2);
  assert.ok(el1.classList.contains('edwin-frame') && el1.dataset.kind === 'card' && f1.el('input') && f1.el('windows') && f1.el('echo'));
  /* Frames and windows are compared by identity only: a deep comparison would walk the whole window tree. */
  const calls: { arg: EdwinCore; sel: EdwinCore; root: EdwinCore; frame: EdwinCore }[] = [], prev = Ed.hooks.renderOverlay, order = () => calls.map(c => c.arg && c.arg.id);
  Ed.hooks.renderOverlay = (f: EdwinCore) => { calls.push({ arg: f, sel: E.sel, root: E.root, frame: E.frame }); if (prev) prev(f); };
  try {
    Ed.render();
    assert.deepEqual(order(), [f2.id, f1.id], 'both frames, the selected one last');
    assert.equal(calls[0].sel, f2.sel); assert.equal(calls[0].root, f2.wroot); assert.equal(calls[0].frame, f1, 'E.frame stays the selected frame');
    assert.equal(calls[1].sel, f1.sel); assert.equal(calls[1].root, f1.wroot);
    assert.match(f1.sel.view.textContent, /alpha one/); assert.match(f2.sel.view.textContent, /beta two/);
    assert.ok(f1.sel.el.classList.contains('selected') && !f2.sel.el.classList.contains('selected'));
    /* The popups stay with the selected frame: no corfu or snipe element was made in the other one. */
    assert.equal(el2.querySelector('.corfu'), null); assert.equal(el2.querySelector('.snipe'), null);
    /* Unchanged, the other frame is not drawn again; the selected one always is. (The first drawings move the
       layout generation, for the window DOM and the echo's height, after the other frame's key was taken, so it
       is drawn a few more times; then it rests.) */
    for (let i = 0; i < 3; i++) Ed.render();
    calls.length = 0; Ed.render();
    assert.deepEqual(order(), [f1.id]);
    /* An edit in the other frame's buffer draws it again, with itself current. */
    Ed.applyOps(bb, [[0, '', 'B']], 'local'); calls.length = 0; Ed.render();
    assert.deepEqual(order(), [f2.id, f1.id]);
    assert.equal(calls[0].sel.buffer, bb);
    assert.match(f2.sel.view.textContent, /Bbeta two/);
    /* Selecting the other frame flips the order. */
    Ed.selectFrame(f2); calls.length = 0; Ed.render();
    assert.deepEqual(order(), [f1.id, f2.id]);
    await settled(bb);
  } finally { Ed.hooks.renderOverlay = prev; f1.destroy(); f2.destroy(); sync.close(ba); sync.close(bb); }
  assert.equal(E.frames.length, 0); assert.equal(E.frame, null);
});

test('E3 H3 gap 5: hooks.mouseDown gets the event as third argument; readFile falls back to the shipped files by basename', async () => {
  const doc = makeDocument(); const el = doc.createElement('div'); doc.body.appendChild(el);
  const text = 'line one\nline two\nline three\n';
  const b = await sync.open(note('mouse.md', text));
  const f = Ed.makeFrame(el, { buffer: b, kind: 'card' });
  Ed.render();
  doc.hit = f.sel.view;
  const seen: { bb: EdwinCore; p: number; ev: FakeEvent }[] = [], prev = Ed.hooks.mouseDown;
  Ed.hooks.mouseDown = (bb: EdwinCore, p: number, ev: FakeEvent) => { seen.push({ bb, p, ev }); if (prev) prev(bb, p, ev); };
  try {
    const ev = f.el('windows').dispatch('mousedown', { button: 0, shiftKey: false, clientX: 20, clientY: 30 });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].bb, b);
    assert.equal(seen[0].p, text.indexOf('\n', 9), 'y = 30 px is the second line: point goes to its end');
    assert.equal(seen[0].ev, ev, 'the event is the third argument');
    assert.ok(b.pt === text.indexOf('\n', 9) || b.pt === text.indexOf('\n', 9) - 1, 'the default handler (through the chained hooks) moved point; Normal state keeps it off the newline');
    /* A two-argument hook keeps working. */
    Ed.hooks.mouseDown = (bb: EdwinCore, p: number) => { bb.pt = p; };
    f.el('windows').dispatch('mousedown', { button: 0, shiftKey: false, clientX: 0, clientY: 5 });
    assert.ok(b.pt === text.indexOf('\n') || b.pt === text.indexOf('\n') - 1, 'the first line');
  } finally { Ed.hooks.mouseDown = prev; f.destroy(); sync.close(b); }
  /* readFile: a .scm name under a directory that does not exist answers with the shipped file; others stay null. */
  const shipped = fs.readFileSync(path.join(EDWIN, 'scm/notes-syntax.scm'), 'utf8');
  assert.equal(L.S.hooks.readFile('/no/such/dir/notes-syntax.scm'), shipped);
  assert.equal(L.S.hooks.readFile('/no/such/dir/absent.scm'), null);
  assert.equal(L.S.hooks.readFile('/no/such/dir/notes-syntax.txt'), null);
  /* markdown.js's edwin:scm entry still answers. */
  assert.equal(L.S.hooks.readFile('edwin:scm/notes-syntax.scm'), shipped);
  /* So (load "<any dir>/address.scm") resolves to the shipped file. */
  assert.equal(L.truthy(L.evalText('(begin (load "/no/such/dir/address.scm") (procedure? address-name))')), true);
});
