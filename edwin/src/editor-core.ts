/* Lmacs editor core: buffers, keymaps, the command loop, the minibuffer, undo and redisplay.
   Keys go into a queue; one sequential loop reads them, as in Emacs. Commands that need
   more input (operators, the minibuffer, isearch) read the next key from the same queue,
   so keyboard macros and repeat can push keys back in front of it. */
(function () {
'use strict';
/* editor-core's own types: window configurations, the moved markers of an edit, redisplay's lines, options and
   caches, and the fields the core keeps on page elements. */
type EcWinLeaf = { dir?: undefined; buffer: EdBuffer; pt: number; start: number; sel: boolean; popup: boolean };
type EcWinSplit = { dir: 'h' | 'v'; children: EcWinConfig[] };
type EcWinConfig = EcWinLeaf | EcWinSplit;
type EcMoved = [m: EdMarker | EdTempMarker, pos: number, dead: boolean, to: number][];
type EcLexInfo = { dirty?: boolean };
type EcIsearchFrame = { pt: number; str: string; failing: boolean; match: [number, number] | null; dir: number; wrapped: boolean };
type EcFoldPre = { ver: number | undefined; n: number; pre: Int32Array };
type EcFoldBuffer = { _foldPre?: EcFoldPre | null };
type EcLineBoth = { html: string; runs: EdRun[] };
type EcLineVal = string | EdRun[] | EcLineBoth;
type EcLine = { o: number; n: number | null; cl: boolean; html: string | undefined; pulse: boolean; runs?: EdRun[]; text?: string };
type EcRendered = EcLine[] & { seg?: string; cache?: Map<string, EcLineVal> | null };
type EcLexSeg = { cls: ArrayLike<number>; names: string[] };
type EcPulse = { b: EdBuffer; ls: number };
interface EcRenderOpts extends EdRenderOpts {
  active?: boolean; numbers?: 'relative' | 'absolute' | null; cursorClass?: string; onChar?: boolean; hl?: RegExp | null;
  current?: [number, number] | null; isearch?: EdIsearch | null; avy?: Map<number, string> | null; pulse?: number; cache?: Map<string, EcLineVal> | null;
}
interface EcWindowState extends EdWindowState { opts: EcRenderOpts }
interface EcMetrics extends EdMetrics { sgen: number; ch: number; mono: boolean; padT: number; padX: number; nowrap: boolean; cw0: number; oh0: number; ow0: number; cw: number; top: number; oh: number }
type EcView = HTMLElement & { _win?: EdWindow; _buf?: EdBuffer; _lines?: EcRendered };
type EcLineEl = HTMLElement & { _o?: number; _h?: string; _cn?: string; _n?: number | null };
type EcTextEl = HTMLElement & { _t?: string; _st?: string; _hid?: boolean };
type EcEcho = HTMLElement & { _e?: string; _eh?: boolean; _dirty?: boolean; _h?: number };
const L: LispApi = globalThis.L;
const { intern, NIL, signal, pr, arr, listOf, truthy, SchemeError, Sym } = L;
/* The host (host-browser.ts or host-node.cts) is everything the core needs from where it runs. */
const host: EdHost = globalThis.EdHost;
if (!host) throw new Error('Edwin needs a host: load host-browser.js or host-node.js first');
const hooks: EdHooks = {};

/* ---------- file store: the host's storage, under its own prefix ---------- */
/* A host with a file system (host.files: the desktop shell, DT1) keeps files there instead: NAME is a path,
   read gives the text or null, write throws when the file cannot be written, list names the files that
   completion offers. */
const PFX = 'lmacs:file:';
const Store = {
  get(n: string) { return host.files ? host.files.read(n) : host.storage.get(PFX + n); },
  set(n: string, v: string) { if (host.files) { host.files.write(n, v); return true; } return host.storage.set(PFX + n, v) !== false; },
  del(n: string) { if (host.files) host.files.remove(n); else host.storage.remove(PFX + n); },
  list() { return host.files ? host.files.list() : host.storage.keys().filter(k => k.startsWith(PFX)).map(k => k.slice(PFX.length)).sort(); },
};

/* ---------- buffers ---------- */
interface Buffer extends EdBuffer { _mark: EdMarker; _marks: Map<string, EdMarker>; _jumps: EdMarker[]; _lv: number }
class Buffer {
  declare static count: number | undefined;
  constructor(name: string) {
    this.id = Buffer.count = (Buffer.count || 0) + 1;
    /* The text lives in a rope; every change is logged as a delta (VER, POS, DEL, INS) so caches,
       undo and the worker mirrors can follow it without keeping copies of the whole text. */
    this.rope = new globalThis.Rope(''); this.ver = 0; this.log = []; this.pin = Infinity;
    /* Markers (R6.11): every position that must follow edits, in one set that shiftMarkers moves.
       Plain { pos } objects in it (temps) are before markers. Point is an after marker, kept as a number. */
    this.markers = new Set(); this.temps = this.markers;
    this._mark = this.marker(null); this._marks = new Map(); this._jumps = []; this.locals = null;
    this.name = name; this.pt = 0; this.markActive = false;
    this.mode = modeFor(name); this.file = null; this.modified = false; this.readOnly = false;
    this.undo = []; this.redo = []; this.pendingUndo = null; this.typeRun = 0; this.scroll = 0;
    this.jumpIdx = 0;
    this.visual = null; this.evilState = undefined; this._lv = -1; this._lc = null;
  }
  marker(pos: number | null, type?: 'before' | 'after') { const m = new Marker(this, pos, type); this.markers.add(m); return m; }
  /* The mark is a before marker; b.mark reads and sets its position (null when unset). */
  get mark() { return this._mark.pos; }
  set mark(v: number | null) { this._mark.pos = v === null || v === undefined ? null : v; }
  /* Evil's marks: a table of before markers, read and written as positions (b.marks[k] = pos). */
  get marks() { return this._marksView || (this._marksView = marksView(this)); }
  set marks(o: Record<string, number | undefined>) { for (const m of this._marks.values()) this.markers.delete(m); this._marks.clear(); for (const k in o) this.marks[k] = o[k]; }
  /* The jump list: an array of before markers. Assigning it drops the markers left out. */
  get jumps() { return this._jumps; }
  set jumps(a: EdMarker[]) {
    const keep = new Set<EdMarker>();
    this._jumps = a.map((x: EdMarker | number) => { const m = x instanceof Marker ? x : this.marker(x as number); keep.add(m); return m; });
    for (const m of this.markers) if ((m as EdMarker).jump && !keep.has(m as EdMarker)) this.markers.delete(m);
    for (const m of keep) { m.jump = true; this.markers.add(m); }
  }
  /* The whole text as one string (built once per change, then cached). Hot paths read the rope. */
  get text() { return this.rope.toString(); }
  set text(v: string) { setText(this, String(v)); }
  __print() { return '#<buffer ' + this.name + '>'; }
  get __type() { return 'buffer'; }
}
/* A marker: a position in a buffer that follows its edits, with an insertion type (R6.11). A before
   marker stays before text inserted at it; an after marker advances past it. A released marker
   (set-marker m #f) points nowhere and is no longer moved. */
interface Marker extends EdMarker {}
class Marker {
  constructor(buffer: EdBuffer | null, pos: number | null, type?: 'before' | 'after') { this.buffer = buffer; this.pos = pos; this.type = type === 'after' ? 'after' : 'before'; }
  set(buffer: EdBuffer | null, pos: number | null) {
    if (this.buffer && this.buffer !== buffer) this.buffer.markers.delete(this);
    this.buffer = pos === null ? null : buffer; this.pos = pos;
    if (this.buffer) this.buffer.markers.add(this);
    return this;
  }
  release() { if (this.buffer) this.buffer.markers.delete(this); this.buffer = null; this.pos = null; }
  __print() { return this.buffer && this.pos !== null ? `#<marker at ${this.pos + 1} in ${this.buffer.name}>` : '#<marker in no buffer>'; }
  get __type() { return 'marker'; }
}
function marksView(b: Buffer): Record<string, number | undefined> {
  const t = b._marks;
  return new Proxy(Object.create(null), {
    get: (_, k: string) => { const m = typeof k === 'string' ? t.get(k) : undefined; return m ? m.pos : undefined; },
    set: (_, k: string, v) => { let m = t.get(k); if (!m) { m = b.marker(v); t.set(k, m); } else m.pos = v; return true; },
    deleteProperty: (_, k: string) => { const m = t.get(k); if (m) { b.markers.delete(m); t.delete(k); } return true; },
    has: (_, k: string) => t.has(k),
    ownKeys: () => [...t.keys()],
    getOwnPropertyDescriptor: (_, k: string) => (t.has(k) ? { value: t.get(k)!.pos, writable: true, enumerable: true, configurable: true } : undefined),
  });
}
function modeFor(name: string): string {
  if (hooks.modeFor) { const m = hooks.modeFor(name); if (m) return m; }
  if (name === '*scratch*') return 'scheme-interaction-mode';
  if (/\.(scm|ss|sld|el)$/.test(name)) return 'scheme-mode';
  if (/^\*(Help|Buffer List|Messages|Registers|Marks)\*$/.test(name)) return 'special-mode';
  return 'fundamental-mode';
}
const MODE_NAMES: Record<string, string> = { 'scheme-interaction-mode': 'Scheme Interaction', 'scheme-mode': 'Scheme', 'fundamental-mode': 'Fundamental', 'special-mode': 'Special', 'minibuffer-mode': 'Minibuffer', 'org-mode': 'Org', 'text-mode': 'Text' };
const isLisp = (b: EdBuffer) => b.mode === 'scheme-mode' || b.mode === 'scheme-interaction-mode' || b.mode === 'minibuffer-mode';

/* E.headless: no page to draw on (edwind, tests), as the host says. Redisplay and the browser wiring are
   then skipped, and everything else runs as in the page. */
const E = {
  headless: !!host.headless, host, frames: [], frame: null,
  buffers: [], win: null, current: null as unknown as EdBuffer,
  history: [], pendingKeys: '',
  prefixArg: null, keepPrefix: false, uArg: false, uDigits: null, depth: 0,
  lastCommand: false, thisCommand: false, thisKeys: '', killRing: [], killIdx: 0,
  isearch: null, lastSearch: '', goalCol: null, cmdSeq: 0,
  inhibitRO: false, pasteText: '', timers: new Map(), suppressUndo: false, noUndo: false,
} as Partial<EdState> as EdState;
/* The minibuffer, the echo area and the window tree are per frame (R9.2): E.minibuf, E.mini, E.echo,
   E.root, E.sel and the rest are accessors onto the selected frame (below, after Window). */

function getBuffer(name: string) { return E.buffers.find(b => b.name === name) || null; }
function getBufferCreate(name: string) {
  let b = getBuffer(name);
  if (!b) { b = new Buffer(name); E.buffers.push(b); if (E.booted) runHookSafely('buffer-list-update-hook', []); }
  return b;
}
/* signal does not return */
function toBuffer(x: SchemeValue): EdBuffer;
function toBuffer(x: SchemeValue) {
  if (x instanceof Buffer) return x;
  if (typeof x === 'string') { const b = getBuffer(x); if (!b) signal('error', 'No such buffer ' + x); return b!; }
  if (x === false || x === undefined) return E.current;
  signal('wrong-type-argument', intern('bufferp'), x);
}
/* ---------- windows: a tree of splits whose leaves show buffers ---------- */
interface Window extends EdWindow {}
class Window {
  declare static count: number | undefined;
  constructor(buffer: EdBuffer) {
    this.id = Window.count = (Window.count || 0) + 1;
    this.buffer = buffer; this.pt = buffer ? buffer.pt : 0; this.start = 0; this.lastLine = 0; this.rows = 20; this.prev = []; this.popup = false;
    this.el = null; this.view = null; this.ml = null; this.parent = null; this.dedicated = false;
  }
  __print() { return '#<window ' + this.id + ' on ' + (this.buffer ? this.buffer.name : 'nothing') + '>'; }
  get __type() { return 'window'; }
}
interface Split extends EdSplit {}
class Split { constructor(dir: 'h' | 'v', children: EdWindowNode[]) { this.dir = dir; this.children = children; this.parent = null; this.el = null; for (const c of children) c.parent = this; } }
/* The per-frame state (R9.2): a window tree (wroot, sel, the winner history), a minibuffer with its
   echo area, prompt and flash, and whether the frame has the keyboard. A Frame (below) adds the page
   parts. With no frame (headless: edwind, the tests, a served runtime before its first card) the
   implicit state E.implicit holds one window tree, so the core works unchanged. */
interface FrameState extends EdFrameState {}
class FrameState {
  constructor() {
    this.wroot = null; this.sel = null; this.winHistory = []; this.winFuture = [];
    this.minibuf = new Buffer(' *Minibuf-1*'); this.minibuf.mode = 'minibuffer-mode'; this.minibuf.minibuf = true;
    this.mini = null; this.miniFlash = ''; this.echo = ''; this.prompt = null; this.focused = false;
    this.restoreScroll = false; this.recenter = null;
  }
}
E.implicit = new FrameState();
/* The frame the core is working on: the one being drawn (render swaps it in), else the selected one,
   else the implicit state. E.root, E.sel, E.mini, E.minibuf, E.echo and the rest read and write it. */
let rendering: EdFrameState | null = null;
const FS = () => rendering || E.frame || E.implicit;
for (const [k, f] of [['root', 'wroot'], ['sel', 'sel'], ['winHistory', 'winHistory'], ['winFuture', 'winFuture'], ['mini', 'mini'], ['minibuf', 'minibuf'],
  ['miniFlash', 'miniFlash'], ['echo', 'echo'], ['prompt', 'prompt'], ['focused', 'focused'], ['restoreScroll', 'restoreScroll'], ['recenter', 'recenter']] as [string, keyof EdFrameState][])
  Object.defineProperty(E, k, { get() { return FS()[f]; }, set(v) { (FS() as Record<keyof EdFrameState, unknown>)[f] = v; }, enumerable: true, configurable: true });
Object.defineProperty(E, 'win', { get() { return E.sel ? E.sel.buffer : null; }, set(b) { if (E.sel) E.sel.buffer = b; } });
function leaves(node: EdWindowNode | null, out?: EdWindow[]): EdWindow[] { out = out || []; if (!node) return out; if (node instanceof Window) out.push(node); else for (const c of (node as EdSplit).children) leaves(c, out); return out; }
function windowList() { return leaves(E.root); }
/* Every window of every frame, the implicit tree included. */
function allWindows() { const out = leaves(E.implicit.wroot); for (const f of E.frames) leaves(f.wroot, out); return out; }
/* The selected window of the selected frame, whatever frame is being drawn. */
const selWin = () => (E.frame || E.implicit).sel;
/* Every minibuffer (one per frame, plus the implicit one). */
function allMinibufs() { return [E.implicit.minibuf, ...E.frames.map(f => f.minibuf)]; }
/* Run FN with frame F as the one the accessors read (redisplay of a frame that is not selected). */
function withFrame<T>(f: EdFrameState | null, fn: () => T): T { const save = rendering; rendering = f; try { return fn(); } finally { rendering = save; } }
function selectWindow(w: EdWindow | null | undefined, keepPoint?: boolean) {
  if (!w || w === E.sel) { if (w) E.current = E.mini ? E.minibuf : w.buffer; return; }
  if (E.sel && E.sel.buffer) { E.sel.pt = E.sel.buffer.pt; }
  E.sel = w;
  if (!keepPoint && w.buffer) w.buffer.pt = Math.min(w.pt, w.buffer.rope.length);
  E.current = E.mini ? E.minibuf : w.buffer; E.restoreScroll = true;
}
function setWindowBuffer(b: EdBuffer, w?: EdWindow | null) {
  w = w || E.sel!;
  if (w.buffer && w.buffer !== b) {
    w.prev = [w.buffer, ...w.prev.filter(x => x !== w.buffer)].slice(0, 20);
    w.buffer.lastStart = w.start; w.start = b.lastStart || 0;
  }
  const i = E.buffers.indexOf(b);
  if (i > 0) { E.buffers.splice(i, 1); E.buffers.unshift(b); }
  w.buffer = b; w.pt = b.pt;
  if (w === E.sel) { E.current = E.mini ? E.minibuf : b; E.restoreScroll = true; }
}
function otherBuffer() { return E.buffers.find(b => b !== E.win && !b.name.startsWith(' ') && !windowList().some(w => w.buffer === b)) || E.buffers.find(b => b !== E.win && !b.name.startsWith(' ')) || E.win!; }
function replaceNode(oldNode: EdWindowNode, newNode: EdWindowNode) {
  const p = oldNode.parent;
  newNode.parent = p;
  if (!p) E.root = newNode; else p.children[p.children.indexOf(oldNode)] = newNode;
}
function splitWindow(w: EdWindow | null, dir: string, size?: number) {
  // dir: 'below' or 'right'. The new window shows the same buffer and goes after W.
  w = w || E.sel!;
  saveWinConfig();
  const nw = new Window(w.buffer); nw.pt = w.buffer.pt; nw.start = w.start;
  const axis = dir === 'right' ? 'h' : 'v';
  const p = w.parent;
  if (p && p.dir === axis) { p.children.splice(p.children.indexOf(w) + 1, 0, nw); nw.parent = p; }
  else { const parent = w.parent; const sp = new Split(axis, [w, nw]); sp.parent = parent; if (!parent) E.root = sp; else parent.children[parent.children.indexOf(w)] = sp; }
  return nw;
}
function deleteWindow(w: EdWindow | null) {
  w = w || E.sel!;
  if (windowList().length === 1) signal('user-error', 'Attempt to delete the sole window');
  saveWinConfig();
  const p = w.parent!;
  p.children.splice(p.children.indexOf(w), 1);
  if (p.children.length === 1) replaceNode(p, p.children[0]);
  if (w.el && w.el.parentNode) w.el.parentNode.removeChild(w.el);
  if (E.sel === w) { const ws = windowList(); E.sel = null; selectWindow(ws[0]); }
  return true;
}
function deleteOtherWindows(w: EdWindow | null) {
  w = w || E.sel!;
  if (windowList().length === 1) return;
  saveWinConfig();
  for (const x of windowList()) if (x !== w && x.el && x.el.parentNode) x.el.parentNode.removeChild(x.el);
  w.parent = null; E.root = w; selectWindow(w);
}
function winConfig() {
  const snap = (n: EdWindowNode): EcWinConfig => n instanceof Window ? { buffer: n.buffer, pt: n === E.sel ? n.buffer.pt : n.pt, start: n.start, sel: n === E.sel, popup: n.popup }
    : { dir: (n as EdSplit).dir, children: (n as EdSplit).children.map(snap) };
  return snap(E.root!);
}
function restoreWinConfig(cfg: EcWinConfig) {
  for (const x of windowList()) if (x.el && x.el.parentNode) x.el.parentNode.removeChild(x.el);
  let sel: EdWindow | null = null;
  const build = (c: EcWinConfig): EdWindowNode => {
    if (c.dir) return new Split(c.dir, c.children.map(build));
    const b = E.buffers.includes(c.buffer) ? c.buffer : (E.buffers.find(x => !x.name.startsWith(' ')) || E.buffers[0]);
    const w = new Window(b); w.pt = Math.min(c.pt, b.rope.length); w.start = Math.min(c.start || 0, b.rope.length); w.popup = c.popup; if (c.sel) sel = w; return w;
  };
  E.root = build(cfg); E.root.parent = null;
  E.sel = null; selectWindow(sel || windowList()[0]);
}
function saveWinConfig() { E.winHistory.push(winConfig()); if (E.winHistory.length > 50) E.winHistory.shift(); E.winFuture = []; }
function windowFor(b: EdBuffer) { return windowList().find(w => w.buffer === b) || null; }
/* Show B in a window other than the selected one: reuse one, or split. */
function popToBuffer(b: EdBuffer, select?: boolean) {
  const existing = windowFor(b);
  let w: EdWindow;
  if (existing) w = existing;
  else {
    const others = windowList().filter(x => x !== E.sel);
    if (others.length) w = others.find(x => x.popup) || others[others.length - 1];
    else { const sel = E.sel; w = splitWindow(sel, 'below'); w.popup = true; }
    setWindowBuffer(b, w);
  }
  if (select) selectWindow(w);
  return w;
}

/* ---------- frames: the page areas Edwin draws into ----------
   A frame is one view of the editor on a page (R9.2): a root element holding the window tree, the echo
   area and the input, with the menubar, the completion popup and the snipe boxes. The core never looks
   up page elements itself: it asks the selected frame for a part by name (frame.el), so a page can hold
   several frames. With no frame (headless) nothing is drawn. */
interface Frame extends EdFrame {}
class Frame extends FrameState {
  declare static count: number | undefined;
  constructor(root: HTMLElement | null, parts: Record<string, HTMLElement>) {
    super();
    this.id = Frame.count = (Frame.count || 0) + 1;
    this.root = root; this.parts = Object.assign(Object.create(null), parts);
    this.kind = 'console'; this.fontSize = null; this.legacy = true; this.listeners = [];
  }
  /* The part NAME (frame, menubar, windows, echo, input, corfu, snipe, presence): given at creation, or the
     element with that id inside the root, or the root itself. Parts made later (the popups) are found once made.
     A model frame (no root, DT0) has no parts: null. */
  el(name: string) {
    const p = this.parts[name];
    if (p) return p;
    const r = this.root; if (!r) return null;
    const el = r.id === name ? r : r.querySelector<HTMLElement>('#' + name);
    if (el) this.parts[name] = el;
    return el;
  }
  /* The buffer of the frame's selected window. */
  get buffer() { return this.sel ? this.sel.buffer : null; }
  focus() { const ta = this.el('input'); if (ta && ta.focus) ta.focus({ preventScroll: true }); else { selectFrame(this); this.focused = true; } }
  blur() { const ta = this.el('input'); if (ta && ta.blur && ta.ownerDocument.activeElement === ta) ta.blur(); else { this.focused = false; frameEvent('blur', this); } }
  /* Show B in the frame's selected window. */
  showBuffer<T extends EdBuffer | string>(b: T): T { withFrame(this, () => setWindowBuffer(toBuffer(b)!, this.sel)); if (E.frame === this) E.current = this.mini ? this.minibuf : this.sel!.buffer; scheduleRender(); return b; }
  point(): number { return E.frame === this ? this.sel!.buffer.pt : this.sel!.pt; }
  setPoint(p: number) { const b = this.sel!.buffer; p = Math.max(0, Math.min(b.rope.length, p)); if (E.frame === this) b.pt = p; this.sel!.pt = p; scheduleRender(); return p; }
  /* Pixels from the top of the frame's element to the top of the drawn line holding POS, or null (R9.12). */
  lineTop(pos: number) {
    const w = this.sel; if (!w || !w.view) return null;
    const ls = bol(w.buffer.rope, Math.max(0, Math.min(w.buffer.rope.length, pos)));
    const ln = w.view.querySelector(`.ln[data-o="${ls}"]`); if (!ln) return null;
    const sc = frameScale(this), rr = this.root!.getBoundingClientRect(), lr = ln.getBoundingClientRect();
    return (lr.top - rr.top) / sc;
  }
  /* The buffer position under the client point, in this frame (works under a CSS transform, R9.9). */
  posFromPoint(x: number, y: number) { return withFrame(this, () => { const w = windowAt(x, y); return w ? posFromPoint(x, y, w) : null; }); }
  /* True while the frame's buffer has edits the server has not acknowledged (R9.15). */
  unacked() { const b = this.buffer; return !!(b && (b.inflight || (b.queue && b.queue.length))); }
  setFontSize(px: number) { this.fontSize = px; if (this.root) this.root.style.setProperty('--text-size', px + 'px'); E.metricsGen++; scheduleRender(); }
  destroy() { deleteFrame(this); }
  __print() { return '#<frame ' + this.id + '>'; }
  get __type() { return 'frame'; }
}
/* Ed.makeFrame(el, {buffer, kind: 'card' | 'console', fontSize}) builds a frame's parts inside EL: the
   windows, the echo area, the hidden input textarea and the presence layer, with a menubar for a console
   (R9.2, R9.3). The older form makeFrame(root, parts) takes a page that already holds the parts
   (edwin/index.html). The window tree starts with one window on BUFFER (else the current buffer).
   Ed.makeFrame(null, {backend, buffer, kind, theme}) makes a model frame (DT0): no page, no DOM; each redisplay
   lays the frame out on backend.size()'s cell grid and hands the result to backend.draw (display.ts). */
function makeFrame(root: HTMLElement | null, opts?: EdMakeFrameOpts) {
  opts = opts || {};
  if (!root) return makeModelFrame(opts);
  const built = 'kind' in opts || 'buffer' in opts || 'fontSize' in opts;
  const f = new Frame(root, built ? {} : opts as Record<string, HTMLElement>);
  if (built) buildFrame(f, root, opts);
  const b = (opts.buffer && toBuffer(opts.buffer)) || E.current || E.buffers[0];
  f.wroot = f.sel = new Window(b); f.sel.pt = b.pt;
  E.frames.push(f);
  E.headless = false;
  if (!E.frame) selectFrame(f);
  if (built && hooks.wireFrame) hooks.wireFrame(f);
  if (built) { watchTheme(root); scheduleRender(); }
  return f;
}
function makeModelFrame(opts: EdMakeFrameOpts) {
  const be = opts.backend;
  if (!be || typeof be.size !== 'function' || typeof be.draw !== 'function') signal('error', 'Ed.makeFrame: a frame needs an element, or a backend with size() and draw()');
  const f = new Frame(null, {});
  f.backend = be; f.legacy = false; f.kind = opts.kind === 'card' ? 'card' : 'console'; f.theme = opts.theme || null;
  const b = (opts.buffer && toBuffer(opts.buffer)) || E.current || E.buffers[0];
  f.wroot = f.sel = new Window(b); f.sel.pt = b.pt;
  E.frames.push(f);
  E.headless = false;
  if (!E.frame) selectFrame(f);
  scheduleRender();
  return f;
}
function buildFrame(f: Frame, root: HTMLElement, opts: EdMakeFrameOpts) {
  const doc = root.ownerDocument;
  host.page.addStyle('edwin-frame-style', FRAME_CSS);
  root.classList.add('edwin-frame', 'unfocused');
  f.kind = opts.kind === 'card' ? 'card' : 'console'; f.legacy = false;
  root.dataset.kind = f.kind;
  const mk = (tag: string, cls: string) => { const el = doc.createElement(tag); el.className = cls; root.appendChild(el); return el; };
  if (f.kind === 'console') {
    const nav = mk('nav', 'ed-menubar'); nav.setAttribute('aria-label', 'Commands');
    nav.innerHTML = '<span class="name">Edwin</span><button type="button" data-key="ESC">Esc</button><button type="button" data-cmd="evil-ex">Ex <kbd>:</kbd></button>' +
      '<button type="button" data-cmd="list-buffers">Buffers <kbd>:ls</kbd></button><button type="button" data-cmd="save-buffer">Save <kbd>:w</kbd></button>' +
      '<button type="button" data-cmd="evil-undo">Undo <kbd>u</kbd></button><button type="button" data-cmd="evil-help">Keys <kbd>:h</kbd></button>' +
      '<button type="button" data-cmd="evil-toggle-emacs-state">Vim ⇄ Emacs <kbd>C-z</kbd></button><span class="spacer"></span>';
    f.parts.menubar = nav;
  }
  f.parts.windows = mk('div', 'ed-windows');
  const echo = mk('div', 'ed-echo'); echo.setAttribute('aria-live', 'polite'); f.parts.echo = echo;
  const pres = mk('div', 'ed-presence'); f.parts.presence = pres;
  const ta = mk('textarea', 'ed-input');
  for (const [k, v] of [['autocapitalize', 'off'], ['autocomplete', 'off'], ['autocorrect', 'off'], ['spellcheck', 'false'], ['aria-label', 'Keyboard input']]) ta.setAttribute(k, v);
  f.parts.input = ta;
  f.parts.frame = root;
  if (opts.fontSize) { f.fontSize = opts.fontSize; root.style.setProperty('--text-size', opts.fontSize + 'px'); }
}
/* A change of data-theme on <html> redraws every frame (R9.10); the colours themselves are CSS variables. */
let themeWatched = false;
function watchTheme(root: HTMLElement) {
  if (themeWatched) return;
  const doc = root.ownerDocument, win = doc.defaultView;
  if (!win || typeof win.MutationObserver !== 'function') return;
  themeWatched = true;
  new win.MutationObserver(() => { E.metricsGen++; frameRender(); }).observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
/* The CSS scale an ancestor's transform applies to frame F (1 without one): layout pixels are divided by it
   to place overlays, and measured rectangles are divided by it to get layout pixels (R9.9). */
function frameScale(f: EdFrame) { const r = f.root; if (!r || !r.offsetWidth) return 1; const w = r.getBoundingClientRect().width; return w > 0 ? w / r.offsetWidth : 1; }
function selectFrame(f: EdFrame) {
  if (!(f instanceof Frame) || !E.frames.includes(f)) signal('wrong-type-argument', 'not a live frame', f);
  if (E.frame === f) return f;
  const old = E.frame || E.implicit;
  if (old.sel && old.sel.buffer) old.sel.pt = old.sel.buffer.pt;
  E.frame = f;
  if (f.sel && f.sel.buffer) { const b = f.sel.buffer; b.pt = Math.min(f.sel.pt, b.rope.length); E.current = f.mini ? f.minibuf : b; }
  return f;
}
function deleteFrame(f: EdFrame) {
  const i = E.frames.indexOf(f); if (i < 0) return false;
  E.frames.splice(i, 1);
  for (const w of leaves(f.wroot)) if (w.view && sizeWatch) sizeWatch.unobserve(w.view);
  for (const [el, type, fn, o] of f.listeners) el.removeEventListener(type, fn, o);
  f.listeners = [];
  if (!f.legacy && f.root) { for (const p of Object.values(f.parts)) if (p !== f.root && p.parentNode) p.parentNode.removeChild(p); f.root.classList.remove('edwin-frame', 'unfocused'); delete f.root.dataset.kind; }
  if (E.frame === f) {
    E.frame = null;
    const next = E.frames[0] || null;
    if (next) selectFrame(next);
    else { const s = E.implicit.sel; if (s && s.buffer) E.current = E.implicit.mini ? E.implicit.minibuf : s.buffer; }
  }
  if (!E.frames.length) E.headless = true;
  frameEvent('blur', f);
  return true;
}
/* Ed.onFrameEvent(fn): fn({type, frame, buffer}) for edited, point, focus, blur and status (the page's title,
   snapshot and status refresh). */
const frameListeners: ((ev: EdFrameEvent) => void)[] = [];
function onFrameEvent(fn: (ev: EdFrameEvent) => void) { frameListeners.push(fn); return () => { const i = frameListeners.indexOf(fn); if (i >= 0) frameListeners.splice(i, 1); }; }
function frameEvent(type: string, frame: EdFrame | null, buffer?: EdBuffer | null) {
  if (!frameListeners.length) return;
  const ev = { type, frame, buffer: buffer || (frame && frame.sel ? frame.sel.buffer : null) };
  for (const fn of frameListeners.slice()) { try { fn(ev); } catch (e) { console.error(e); } }
}
/* A part of the frame being drawn or selected, or null with no frame. */
const $ = (name: string) => { const f = FS(); return f instanceof Frame ? f.el(name) : null; };

/* The stylesheet a built frame needs, injected once per page. Faces are the board's tokens with Edwin's
   modus values as fallbacks (R9.10); fonts are the page's (R9.11). */
const FRAME_CSS = `
.edwin-frame { --ed-bg: var(--panel, #fbf7f0); --ed-fg: var(--fg, #000000); --ed-dim: var(--muted, #595959); --ed-rule: var(--dot, #c4b8ab);
  --ed-menu-bg: var(--panel-2, #efe9dd); --ed-ml-bg: var(--panel-2, #cab9b2); --ed-ml-inactive: var(--bg, #dfd9cf);
  --ed-cursor: var(--fg, #000000); --ed-cursor-fg: var(--panel, #fbf7f0); --ed-region: var(--accent-soft, #c2bcb5); --ed-match: var(--accent, #79a8ff); --ed-lazy: var(--accent-soft, #c0efff);
  --ed-paren: var(--accent-soft, #7fdfcf); --ed-mismatch: #ffa0a0; --ed-hl: color-mix(in srgb, var(--fg, #000) 7%, transparent); --ed-pulse: var(--accent-soft, #ffdfa0);
  --ed-kw: var(--syn-keyword, #531ab6); --ed-fn: var(--syn-fnname, #721045); --ed-st: var(--syn-string, #3548cf); --ed-dc: var(--syn-docstring, #2a5045); --ed-cm: var(--syn-comment, #7f0000); --ed-co: var(--syn-constant, #0000b0); --ed-pa: var(--muted, #7f7f7f);
  --ed-rb0: var(--syn-keyword, #0000b0); --ed-rb1: var(--syn-comment, #a60000); --ed-rb2: var(--syn-type, #006800); --ed-rb3: var(--syn-variable, #884900); --ed-rb4: var(--syn-builtin, #721045); --ed-rb5: var(--syn-string, #005e8b);
  --ed-font: var(--mono, var(--font-mono, "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace)); --ed-font-ui: var(--sans, var(--font-ui, system-ui, sans-serif));
  display: flex; flex-direction: column; min-width: 0; min-height: 0; position: relative; background: var(--ed-bg); color: var(--ed-fg); font-family: var(--ed-font); box-sizing: border-box; }
.edwin-frame[data-kind="console"] { height: 100%; border: 1px solid var(--ed-rule); border-radius: 6px; overflow: hidden; }
.edwin-frame[data-kind="card"] { background: transparent; }
.edwin-frame { --md-heading: var(--syn-keyword, var(--ed-kw)); --md-code: var(--syn-string, var(--ed-st)); --md-link: var(--syn-fnname, var(--ed-fn)); --md-ref: var(--syn-constant, var(--ed-co)); --md-field: var(--syn-variable, var(--ed-rb3)); --md-table: var(--syn-type, var(--ed-rb2));
  --md-task-todo: var(--syn-keyword, var(--ed-kw)); --md-task-next: var(--syn-fnname, var(--ed-fn)); --md-task-waiting: var(--syn-type, var(--ed-rb2)); --md-task-done: var(--muted, var(--ed-dim)); --md-priority: var(--syn-constant, var(--ed-co));
  --md-markup: var(--muted, var(--ed-dim)); --md-quote: var(--muted, var(--ed-dim)); --md-list: var(--syn-keyword, var(--ed-kw)); --md-tag: var(--syn-constant, var(--ed-co)); --md-date: var(--syn-constant, var(--ed-co)); --md-checkbox: var(--syn-constant, var(--ed-co)); --md-image: var(--syn-docstring, var(--ed-dc)); --md-anchor: var(--muted, var(--ed-dim)); }
.edwin-frame .ed-menubar { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 4px; padding: 4px 8px; background: var(--ed-menu-bg); border-bottom: 1px solid var(--ed-rule); font-family: var(--ed-font-ui); font-size: 13px; color: var(--ed-dim); }
.edwin-frame .ed-menubar .name { font-weight: 600; letter-spacing: 0.04em; color: var(--ed-fg); margin-right: 6px; }
.edwin-frame .ed-menubar button { font: inherit; color: inherit; background: transparent; border: 1px solid transparent; border-radius: 4px; padding: 2px 8px; cursor: pointer; display: inline-flex; gap: 6px; align-items: baseline; }
.edwin-frame .ed-menubar button:hover { background: var(--ed-bg); border-color: var(--ed-rule); }
.edwin-frame .ed-menubar kbd { font-family: var(--ed-font); font-size: 11px; color: var(--ed-dim); }
.edwin-frame .ed-menubar .spacer { flex: 1; }
.edwin-frame .ed-windows { flex: 1; min-height: 0; display: flex; flex-direction: column; min-width: 0; }
.edwin-frame .ed-windows > * { flex: 1; min-height: 0; min-width: 0; }
.edwin-frame .split { display: flex; min-height: 0; min-width: 0; }
.edwin-frame .split.v { flex-direction: column; }
.edwin-frame .split.h { flex-direction: row; }
.edwin-frame .split > * { flex: 1; min-height: 0; min-width: 0; }
.edwin-frame .split.h > * + * { border-left: 1px solid var(--ed-rule); }
.edwin-frame .win { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.edwin-frame .text { flex: 1; min-height: 0; overflow: hidden; position: relative; margin: 0; padding: 6px 10px 6px 12px; font-size: var(--text-size, 14px); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 8; cursor: text; user-select: none; -webkit-user-select: none; }
.edwin-frame .text.nowrap { white-space: pre; overflow-x: auto; overflow-wrap: normal; }
.edwin-frame .text.nowrap .ln { width: max-content; min-width: 100%; }
.edwin-frame .ln { min-height: 1.5em; }
.edwin-frame .win.selected .ln.cl { background: var(--ed-hl); }
.edwin-frame .text.numbers .ln { position: relative; padding-left: calc(var(--gw, 2) * 1ch + 2ch); }
.edwin-frame .text.numbers .ln::before { content: attr(data-n); position: absolute; left: 0; width: calc(var(--gw, 2) * 1ch); text-align: right; color: var(--ed-dim); font-variant-numeric: tabular-nums; }
.edwin-frame .text.numbers .ln.cl::before { color: var(--ed-fg); font-weight: 500; }
.edwin-frame .rg { background: var(--ed-region); }
.edwin-frame .lz { background: var(--ed-lazy); }
.edwin-frame .im { background: var(--ed-match); }
.edwin-frame .pm { background: var(--ed-paren); }
.edwin-frame .px { background: var(--ed-mismatch); }
.edwin-frame .cur { background: var(--ed-cursor); color: var(--ed-cursor-fg) !important; border-radius: 1px; }
.edwin-frame .cur.bar { background: transparent; color: inherit !important; box-shadow: inset 2px 0 0 var(--ed-cursor); border-radius: 0; }
.edwin-frame .cur.hbar { background: transparent; color: inherit !important; box-shadow: inset 0 -3px 0 var(--ed-cursor); border-radius: 0; }
.edwin-frame .cur.half { background: linear-gradient(transparent 55%, var(--ed-cursor) 55%); color: inherit !important; }
.edwin-frame .cur.ghost, .edwin-frame.unfocused .text .cur { background: transparent; color: inherit !important; box-shadow: inset 0 0 0 1.5px var(--ed-cursor); }
:root[data-evil-state="insert"] .edwin-frame:not(.unfocused) .win.selected .cur { --ed-cursor: var(--syn-type, #006800); }
:root[data-evil-state="emacs"] .edwin-frame:not(.unfocused) .win.selected .cur { --ed-cursor: var(--accent, #005e8b); --ed-cursor-fg: #ffffff; }
:root[data-evil-state="visual"] .edwin-frame:not(.unfocused) .win.selected .cur { --ed-cursor: var(--syn-variable, #884900); background: transparent; color: inherit !important; box-shadow: inset 0 0 0 1.5px var(--ed-cursor); }
:root[data-evil-state="replace"] .edwin-frame:not(.unfocused) .win.selected .cur { --ed-cursor: var(--syn-comment, #a60000); }
.edwin-frame .kw { color: var(--ed-kw); font-weight: 500; }
.edwin-frame .fn { color: var(--ed-fn); font-weight: 500; }
.edwin-frame .st { color: var(--ed-st); }
.edwin-frame .dc { color: var(--ed-dc); font-style: italic; }
.edwin-frame .cm { color: var(--ed-cm); font-style: italic; }
.edwin-frame .co, .edwin-frame .nu, .edwin-frame .qu { color: var(--ed-co); }
.edwin-frame .pa { color: var(--ed-pa); }
.edwin-frame .pa.d0 { color: var(--ed-rb0); } .edwin-frame .pa.d1 { color: var(--ed-rb1); } .edwin-frame .pa.d2 { color: var(--ed-rb2); } .edwin-frame .pa.d3 { color: var(--ed-rb3); } .edwin-frame .pa.d4 { color: var(--ed-rb4); } .edwin-frame .pa.d5 { color: var(--ed-rb5); }
.edwin-frame .avy { background: var(--syn-variable, #ffc000); color: var(--panel, #000000); font-weight: 700; border-radius: 2px; }
.edwin-frame .ln.pulse { animation: edwin-pulse 0.45s ease-out; }
@keyframes edwin-pulse { from { background: var(--ed-pulse); } to { background: transparent; } }
.edwin-frame .text.centered .ln { max-width: calc(var(--center-cols, 100) * 1ch); margin-inline: auto; }
.edwin-frame .modeline { display: flex; gap: 0 2ch; flex-wrap: wrap; align-items: center; padding: 2px 10px 2px 2px; background: var(--ed-ml-bg); color: var(--ed-fg); font-size: 13px; line-height: 1.5; white-space: pre; font-variant-numeric: tabular-nums; border-top: 1px solid var(--ed-rule); }
.edwin-frame .ml-tag { font-family: var(--ed-font-ui); font-weight: 600; font-size: 12px; letter-spacing: 0.08em; padding: 0 8px; border-radius: 3px; background: var(--accent, #3548cf); color: var(--panel, #ffffff); margin-left: 2px; }
.edwin-frame .ml-tag[data-state="insert"] { background: var(--syn-type, #006800); }
.edwin-frame .ml-tag[data-state="visual"] { background: var(--syn-variable, #884900); }
.edwin-frame .ml-tag[data-state="replace"] { background: var(--syn-comment, #a60000); }
.edwin-frame .ml-tag[data-state="operator"] { background: var(--muted, #595959); }
.edwin-frame .ml-tag[data-state="motion"] { background: var(--syn-string, #005e8b); }
.edwin-frame .ml-tag[data-state="emacs"] { background: var(--syn-constant, #531ab6); }
.edwin-frame .ml-state { color: var(--ed-dim); margin-left: 8px; }
.edwin-frame .ml-name { font-weight: 600; }
.edwin-frame .ml-pos, .edwin-frame .ml-mode { color: var(--ed-dim); }
.edwin-frame .ml-extra { color: var(--syn-comment, #a60000); font-weight: 500; }
.edwin-frame .ml-sync { color: var(--syn-comment, #a60000); font-weight: 600; }
.edwin-frame .ml-cmd { margin-left: auto; color: var(--ed-fg); font-weight: 500; min-width: 6ch; text-align: right; }
.edwin-frame .win:not(.selected) .modeline { background: var(--ed-ml-inactive); color: var(--ed-dim); }
.edwin-frame .win:not(.selected) .ml-tag { opacity: 0.55; }
.edwin-frame.unfocused .modeline { opacity: 0.85; }
.edwin-frame.bell .win.selected .modeline { animation: edwin-bell 0.18s ease-out; }
@keyframes edwin-bell { from { background: var(--syn-comment, #a60000); color: #fff; } }
.edwin-frame .ed-echo { min-height: 1.5em; padding: 3px 10px 5px; font-size: 13.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ed-fg); max-height: 50%; overflow-y: auto; flex-shrink: 0; }
.edwin-frame .ed-echo .prompt { color: var(--ed-fn); font-weight: 500; }
.edwin-frame .ed-echo .miniline { display: flex; align-items: baseline; gap: 0; }
.edwin-frame .ed-echo .mb { flex: 1; min-width: 0; }
.edwin-frame .ed-echo .cc { color: var(--ed-dim); min-width: 7ch; font-variant-numeric: tabular-nums; }
.edwin-frame .ed-echo .flash { color: var(--ed-co); margin-left: 1ch; }
.edwin-frame .ed-echo .cands { display: flex; flex-direction: column; margin-top: 3px; border-top: 1px solid var(--ed-rule); padding-top: 3px; }
.edwin-frame .ed-echo .cand, .edwin-frame .corfu .cand { display: flex; gap: 2ch; padding: 0 6px; border-radius: 3px; white-space: pre; overflow: hidden; }
.edwin-frame .ed-echo .cand .cl { flex: 0 0 auto; min-width: 24ch; }
.edwin-frame .ed-echo .cand .cl b, .edwin-frame .corfu .cand .cl b { color: var(--ed-co); font-weight: 600; }
.edwin-frame .ed-echo .cand .ca, .edwin-frame .corfu .cand .ca { color: var(--ed-dim); overflow: hidden; text-overflow: ellipsis; }
.edwin-frame .corfu .cand .ca { margin-left: auto; }
.edwin-frame .ed-echo .cand.sel, .edwin-frame .corfu .cand.sel { background: var(--ed-region); }
.edwin-frame .ed-echo .wkp { color: var(--ed-dim); margin-right: 2ch; }
.edwin-frame .ed-echo .wk { display: inline-flex; gap: 0.75ch; margin-right: 2.5ch; white-space: nowrap; }
.edwin-frame .ed-echo .wk kbd { font-family: var(--ed-font); color: var(--ed-kw); font-weight: 600; }
.edwin-frame .corfu { position: absolute; z-index: 5; background: var(--ed-bg); border: 1px solid var(--ed-rule); border-radius: 4px; box-shadow: 0 8px 24px -12px rgb(20 24 36 / 0.5); font-size: 13px; line-height: 1.5; padding: 3px; max-width: min(60ch, 90%); min-width: 20ch; }
.edwin-frame .snipe { position: absolute; inset: 0; pointer-events: none; z-index: 4; }
.edwin-frame .snipe div { position: absolute; background: var(--syn-variable, #ffc000); opacity: 0.45; border-radius: 2px; }
.edwin-frame .ed-presence { position: absolute; inset: 0; pointer-events: none; z-index: 3; overflow: hidden; }
.edwin-frame .ed-presence .pc { position: absolute; width: 2px; border-radius: 1px; }
.edwin-frame .ed-presence .pc span { position: absolute; left: 0; bottom: 100%; font: 10px var(--ed-font-ui); line-height: 1.3; padding: 0 4px; border-radius: 3px 3px 3px 0; color: #fff; white-space: nowrap; }
.edwin-frame .ed-presence .pr { position: absolute; opacity: 0.3; border-radius: 2px; }
.edwin-frame .ed-presence .faded { transition: opacity 0.6s; opacity: 0; }
.edwin-frame .ed-input { position: absolute; left: 0; bottom: 0; width: 1px; height: 1px; opacity: 0; border: 0; padding: 0; font-size: 16px; resize: none; pointer-events: none; }
`;

/* ---------- text primitives (0-based internally; Lisp sees 1-based) ---------- */
function checkRO(b: EdBuffer) { if (b.readOnly && !E.inhibitRO && !(L.get('inhibit-read-only') && (L.get('inhibit-read-only') as SchemeParam).value)) signal('buffer-read-only', b); }
/* ---------- the edit log ----------
   Each change appends { v, pos, del, ins, len, o }: at POS, DEL was replaced by INS, leaving a text of
   LEN characters at version V; O is the edit's origin (E.editOrigin: local, remote, server, agent, disk). Caches remember the version they were built from and ask spanOf for
   the part that changed since; undo goes back by applying the deltas in reverse. Entries older than
   every snapshot that may still be restored are dropped. */
function logEdit(b: EdBuffer, pos: number, del: string, ins: string) {
  const log = b.log;
  log.push({ v: ++b.ver, pos, del, ins, len: b.rope.length, o: E.editOrigin });
  if (log.length > 512 && (log.length & 127) === 0) trimLog(b);
  if (hooks.edited) hooks.edited(b);
}
function trimLog(b: EdBuffer) {
  let min = b.ver;
  for (const s of b.undo) if (s.ver < min) min = s.ver;
  for (const s of b.redo) if (s.ver < min) min = s.ver;
  if (b.pendingUndo && b.pendingUndo.ver < min) min = b.pendingUndo.ver;
  if (b.pin < min) min = b.pin;
  if (b._lv! >= 0 && b._lv! < min && b.ver - b._lv! < 4096) min = b._lv!;
  if (hooks.logFloor) min = Math.min(min, hooks.logFloor(b));
  const log = b.log;
  let k = 0; while (k < log.length && log[k].v <= min) k++;
  if (k) log.splice(0, k);
}
/* Low-level change: no read-only check, no marker adjustment and no change hooks. Returns the removed text. */
function ropeEdit(b: EdBuffer, pos: number, n: number, ins: string) {
  const removed = b.rope.splice(pos, n, ins);
  if (removed || ins) logEdit(b, pos, removed, ins);
  return removed;
}
/* The one marker-shift routine (R6.11, R6.12), for a change at POS of DEL characters into INS:
   - markers after the changed text, and at its end when text was deleted, move by INS - DEL;
   - a marker at POS, or inside the deleted text, goes to POS (before) or POS + INS (after);
   - point and the points of the other windows on the buffer are after markers.
   A marker whose character was deleted is flagged dead (the :g and :normal line markers skip it).
   Markers a deletion moved are remembered by ENTRY, the log entry, so undo puts them back. */
function shiftMarkers(b: EdBuffer, pos: number, del: number, ins: number, entry?: EdLogEntry | null) {
  const e = pos + del, d = ins - del;
  const after = (p: number) => (p < pos ? p : p > e || (del && p === e) ? p + d : pos + ins);
  b.pt = after(b.pt);
  const sw = selWin();
  for (const w of allWindows()) if (w.buffer === b && w !== sw) w.pt = after(w.pt);
  if (!b.markers.size) return;
  let moved: EcMoved | null = null;
  for (const m of b.markers) {
    const p = m.pos;
    if (p === null || p < pos) continue;
    if (p > e || (del && p === e)) {
      if (p === e && del) (moved || (moved = [])).push([m, p, !!m.dead, p + d]);
      m.pos = p + d; continue;
    }
    const q = (m as EdMarker).type === 'after' ? pos + ins : pos;
    if (del) { if (p > pos) (moved || (moved = [])).push([m, p, !!m.dead, q]); m.dead = true; }
    m.pos = q;
  }
  if (moved && entry) markersMoved.set(entry, moved);
}
/* Markers a deletion moved, by log entry: [marker, old position, old dead flag, new position]. */
const markersMoved = new WeakMap<EdLogEntry, EcMoved>();
/* Undoing ENTRY: markers follow the inverse change, and those the deletion moved go back where they
   were, when nothing has moved them since. */
function unshiftMarkers(b: EdBuffer, entry: EdLogEntry) {
  const moved = markersMoved.get(entry);
  const back = moved ? moved.filter(([m, , , q]) => b.markers.has(m) && m.pos === q) : null;
  shiftMarkers(b, entry.pos, entry.ins.length, entry.del.length, null);
  if (back) for (const [m, p, dead] of back) { m.pos = p; m.dead = dead; }
}

/* ---------- change hooks (R4.22, R4.23) ----------
   before-change-functions get (beg end) of the text about to change, after-change-functions get
   (beg end old-len) of the new text, 1-based, with the changed buffer current. They do not run for
   the changes they make themselves (inhibit-modification-hooks is #t inside them). A function that
   signals is reported and removed from the hook, as Emacs does. (edit-origin) says who made the change. */
E.editOrigin = 'local';
let inChangeHook = false;
function changeHooks() {
  if (inChangeHook || E.inhibitModHooks) return false;
  const bf = L.get('before-change-functions'), af = L.get('after-change-functions');
  return (bf && bf !== NIL) || (af && af !== NIL) ? true : false;
}
function runChangeHook(b: EdBuffer, name: string, args: SchemeValue[]) {
  const save = E.current;
  inChangeHook = true; E.current = b;
  try { runHookSafely(name, args); }
  finally { inChangeHook = false; E.current = save; }
}
/* Run the hook NAME with ARGS; a function that signals is reported and taken off the hook, both its
   buffer-local and its default value, so one broken function cannot break every later edit. */
function runHookSafely(name: string, args?: SchemeValue[]) {
  for (const f of L.hookFns(name)) {
    try { L.apply(f, args); }
    catch (e) {
      if (L.isQuit(e)) throw e;
      removeHookEverywhere(name, f);
      message(`Error in ${name} (${(f as SchemeProcedure).procName || pr(f, true)}): ${errorText(e)}; removed it from the hook`);
    }
  }
}
function removeHookEverywhere(name: string, f: SchemeValue) {
  const drop = (v: SchemeValue) => (v && v !== NIL && typeof v !== 'function' ? listOf(arr(v).filter(x => x !== f)) : v === f ? NIL : v);
  const ent = localized.get(name);
  if (ent) { ent.def = drop(ent.def); for (const b of E.buffers) if (b.locals && b.locals.has(name)) b.locals.set(name, drop(b.locals.get(name))); }
  else L.set(name, drop(L.get(name)));
}

/* ---------- buffer-local variables (R4.26) ----------
   A variable made local in some buffer gets an accessor on its global box: reads and writes go to the
   current buffer's own value when it has one, else to the default value. An automatically local
   variable (defvar-local, make-variable-buffer-local) gets a local value whenever it is set.
   Buffer-locals live with the buffer in each runtime; (put 'var 'shared-local #t) marks the ones that
   travel with the buffer's meta once frames share buffers (E3). */
const localized = new Map<string, EdLocalized>();
function localize(name: string) {
  let ent = localized.get(name);
  if (ent) return ent;
  const box = L.S.gbox(name), d = Object.getOwnPropertyDescriptor(box, 'value');
  if (d && d.get) signal('error', `${name} is computed from editor state and cannot be buffer-local`);
  ent = { def: box.value, auto: false };
  Object.defineProperty(box, 'value', {
    get() { const l = E.current && E.current.locals; return l && l.has(name) ? l.get(name) : ent.def; },
    set(v) {
      const b = E.current;
      if (b && ((b.locals && b.locals.has(name)) || (ent.auto && v !== undefined))) (b.locals || (b.locals = new Map())).set(name, v);
      else ent.def = v;
    },
    configurable: true, enumerable: true,
  });
  localized.set(name, ent);
  return ent;
}
function makeLocal(b: EdBuffer, name: string) {
  const ent = localize(name);
  if (!b.locals) b.locals = new Map();
  if (!b.locals.has(name)) b.locals.set(name, ent.def);
}
function localValue(b: EdBuffer, name: string) {
  const ent = localized.get(name);
  if (!ent) return L.get(name);
  return b && b.locals && b.locals.has(name) ? b.locals.get(name) : ent.def;
}
const defaultValue = (name: string) => { const ent = localized.get(name); return ent ? ent.def : L.get(name); };
function setDefault<T extends SchemeValue>(name: string, v: T): T { const ent = localized.get(name); if (ent) ent.def = v; else L.set(name, v); return v; }
L.hooking.defaultValue = defaultValue;
/* Run F with (edit-origin) answering ORIGIN: remote, server, disk or agent (E1 applies edits with it). */
function withOrigin<T>(origin: string, f: () => T): T { const save = E.editOrigin; E.editOrigin = origin; try { return f(); } finally { E.editOrigin = save; } }
/* One change: hooks, the rope, the log, the markers. WHOLE is the whole new text when the caller has it
   (assigning b.text), so a large replacement resets the rope instead of splicing it. */
function editOne(b: EdBuffer, pos: number, n: number, ins: string, whole?: string) {
  const hk = changeHooks();
  if (hk) runChangeHook(b, 'before-change-functions', [pos + 1, pos + n + 1]);
  let removed: string;
  if (whole !== undefined && n + ins.length > (whole.length >> 1)) { removed = b.rope.slice(pos, pos + n); b.rope.reset(whole); if (removed || ins) logEdit(b, pos, removed, ins); }
  else removed = ropeEdit(b, pos, n, ins);
  if (removed || ins) shiftMarkers(b, pos, removed.length, ins.length, b.log[b.log.length - 1]);
  if (hk) runChangeHook(b, 'after-change-functions', [pos + 1, pos + ins.length + 1, removed.length]);
  return removed;
}
/* The one way text changes (R6.8): OPS, an array of [pos, del, ins] applied in order, change the rope,
   shift every marker, append to the log, run the change hooks with (edit-origin) = ORIGIN (local when
   absent: a command), bump b.ver (logEdit) and schedule redisplay. Local commands, remote batches,
   reverts and undo all come through here; hooks.applied tells the protocol client (sync.ts). Returns
   the ops as applied, with the removed text read from the buffer. */
function applyOps(b: EdBuffer, ops: EdEditOp[], origin?: string, whole?: string) {
  const out: EdAppliedOp[] = [], eff = origin || E.editOrigin;
  withOrigin(eff, () => {
    for (const op of ops) {
      const pos = op[0], n = typeof op[1] === 'string' ? op[1].length : op[1], ins = op[2];
      const removed = editOne(b, pos, n, ins, whole);
      if (removed || ins) out.push([pos, removed, ins]);
    }
  });
  if (whole !== undefined && b.rope.length === whole.length) b.rope.flat = whole;
  if (out.length) {
    if (hooks.applied) hooks.applied(b, out, eff);
    for (const f of E.frames) if (f.sel && leaves(f.wroot).some(w => w.buffer === b)) frameEvent('edited', f, b);
    scheduleRender();
  }
  return out;
}
/* The per-op entry the server and the editing primitives use: one change at POS of N characters into INS;
   the origin is the current one (Ed.withOrigin). Returns the removed text. */
function editText(b: EdBuffer, pos: number, n: number, ins: string) {
  const r = applyOps(b, [[pos, n, ins]]);
  return r.length ? r[0][1] : '';
}
/* Assigning b.text: change the differing middle only, as one edit. */
function setText(b: EdBuffer, v: string) {
  const r = b.rope;
  if (r.flat === v) return;
  const old = r.toString();
  if (old === v) return;
  const { pre, suf } = diffSpan(old, v);
  applyOps(b, [[pre, old.length - suf - pre, v.slice(pre, v.length - suf)]], undefined, v);
}
/* Redisplay in the next frame, once for any number of changes. */
let renderQueued = false;
function scheduleRender() {
  if (renderQueued || !E.frames.length) return;
  renderQueued = true;
  host.nextFrame(() => { renderQueued = false; frameRender(); });
}
/* The span changed since version OLD: { pre, suf } lengths of the untouched prefix and suffix, or null
   when the log no longer reaches back that far. */
function spanOf(b: EdBuffer, old: number) {
  const log = b.log;
  let pre = Infinity, suf = Infinity, k = log.length - 1;
  for (; k >= 0 && log[k].v > old; k--) {
    const e = log[k];
    if (e.pos < pre) pre = e.pos;
    const s = e.len - e.pos - e.ins.length; if (s < suf) suf = s;
  }
  if (k < 0 && (!log.length || log[0].v !== old + 1)) return old === b.ver ? { pre: b.rope.length, suf: 0 } : null;
  if (pre === Infinity) return { pre: b.rope.length, suf: 0 };
  return { pre, suf };
}
/* Whether the text differs from what it was at version VER (an edit undone by another is no change). */
function changedSince(b: EdBuffer, ver: number) {
  if (ver === b.ver) return false;
  const log = b.log;
  let k = log.length - 1, pre = Infinity, suf = Infinity, n = 0;
  for (; k >= 0 && log[k].v > ver; k--, n++) { const e = log[k]; if (e.pos < pre) pre = e.pos; const s = e.len - e.pos - e.ins.length; if (s < suf) suf = s; }
  if (k < 0 && (!log.length || log[0].v !== ver + 1)) return true;
  const len = b.rope.length;
  if (n > 64 || len - suf - pre > 1 << 20) return true;
  const now = b.rope.slice(pre, len - suf);
  let then = now;
  for (let j = log.length - 1; j > k; j--) { const e = log[j], a = e.pos - pre; then = then.slice(0, a) + e.del + then.slice(a + e.ins.length); }
  return then !== now;
}
function insertText(b: EdBuffer, s: string) {
  if (!s) return;
  checkRO(b);
  editText(b, b.pt, 0, s);
  b.modified = true;
}
function deleteText(b: EdBuffer, s: number, e: number) {
  if (s > e) [s, e] = [e, s];
  s = Math.max(0, s); e = Math.min(b.rope.length, e);
  if (s === e) return '';
  checkRO(b);
  const gone = editText(b, s, e - s, '');
  b.modified = true;
  return gone;
}
/* Replace [s, e) with str as one edit, keeping point relative to the end of the text when it was after e. */
function replaceText(b: EdBuffer, s: number, e: number, str: string) {
  const pt = b.pt;
  b.pt = s; deleteText(b, s, e); b.pt = s; insertText(b, str);
  b.pt = pt >= e ? pt - (e - s) + str.length : Math.min(pt, s + str.length);
}
/* Line and column helpers take a string or a rope (the rope has the String read methods). */
const bol = (t: EdText, p: number) => p <= 0 ? 0 : t.lastIndexOf('\n', p - 1) + 1;
const eol = (t: EdText, p: number) => { const k = t.indexOf('\n', p); return k < 0 ? t.length : k; };
/* The rope behind T: T itself, or the buffer whose cached whole text is T. */
function ropeOf(t: EdText) {
  if (typeof t !== 'string') return t;
  const c = E.current;
  if (c && c.rope.flat === t) return c.rope;
  if (E.sel && E.sel.buffer && E.sel.buffer.rope.flat === t) return E.sel.buffer.rope;
  for (const b of E.buffers) if (b.rope.flat === t) return b.rope;
  return null;
}
const lineNo = (t: EdText, p: number) => { const r = ropeOf(t); if (r) return r.lineOf(p); let n = 1; for (let k = t.indexOf('\n'); k >= 0 && k < p; k = t.indexOf('\n', k + 1)) n++; return n; };
function column(t: EdText, p: number) { let c = 0; for (let k = bol(t, p); k < p; k++) c = t.charCodeAt(k) === 9 ? (c + 8) & ~7 : c + 1; return c; }
/* Position of COL on the line starting at LS (clamped to the line end). */
function posAtColumn(t: EdText, ls: number, col: number) { const le = eol(t, ls); let c = 0, k = ls; while (k < le) { const w = t.charCodeAt(k) === 9 ? ((c + 8) & ~7) - c : 1; if (c + w > col) break; c += w; k++; } return k; }
/* Number of the last line that holds text: a final newline ends the last line rather than starting a new one. */
function lastLineStart(t: EdText) { return t.length && t.charCodeAt(t.length - 1) === 10 ? bol(t, t.length - 1) : bol(t, t.length); }
function lineStartOf(t: EdText, n: number) { const r = ropeOf(t); if (r) return r.lineStart(n); let p = 0; for (let k = 1; k < n; k++) { const q = t.indexOf('\n', p); if (q < 0) return p; p = q + 1; } return p; }
/* Line numbers and line starts come from the rope's newline counts, O(log n). */
function lineNoB(b: EdBuffer, p: number) { return b.rope.lineOf(p); }
function lineStartB(b: EdBuffer, n: number) { return b.rope.lineStart(Math.max(1, n)); }
function lineCountB(b: EdBuffer) { const r = b.rope, nl = r.newlines(); return r.length && r.charCodeAt(r.length - 1) === 10 ? nl : nl + 1; }
function lineIndex(b: EdBuffer) { const r = b.rope, out = [0]; for (let k = r.indexOf('\n'); k >= 0; k = r.indexOf('\n', k + 1)) out.push(k + 1); return out; }
/* Syntax classes and paren depths, cached per text version and updated incrementally: an edit
   re-lexes only from the top-level form (a paren in column 0, as Emacs assumes) before the change
   to the one after it, and the untouched classes on both sides are kept. The class and depth arrays
   are updated in place (with spare capacity), so an edit moves the tail instead of copying both. */
function lexOf(b: EdBuffer, soft?: boolean) {
  if (b._lv === b.ver && b._lc) return b._lc;
  /* Redisplay (SOFT) does not wait for the lex of a big buffer when most of it must be lexed (the
     first time, or after a change of more than 1MB): the worker pool makes it and the text shows
     plain until then. A command that needs the classes lexes at once. */
  if (soft && b.rope.length > (1 << 19) && globalThis.EdPool && EdPool.ok) {
    if (b._lexBusy) return null;
    const sp = b._lc ? spanOf(b, b._lv!) : null;
    if ((!sp || b.rope.length - sp.suf - sp.pre > (1 << 20)) && EdPool.lexAsync(b)) return null;
  }
  const r = b.rope, n = r.length;
  const span = b._lc ? spanOf(b, b._lv!) : null;
  if (!span || Math.abs(n - b._llen!) > 100000) {
    const t = r.toString();
    b._lcb = b._lc = markDocstrings(t, lex(t)); b._ldb = b._ld = parenDepths(t, b._lc, 0, n, 0); b._lv = b.ver; b._llen = n;
    return b._lc;
  }
  /* _lc and _ld are views of length n on buffers with spare capacity (_lcb, _ldb), so reads past
     the end give undefined as they do on an exact-size array. */
  const oc = b._lcb as Uint8Array, od = b._ldb as Uint8Array, oldN = b._llen!, shift = n - oldN;
  /* Clean restart points: a column-0 paren the old lex saw as a real paren. */
  let s = span.pre;
  for (;;) { s = s === 0 ? 0 : r.lastIndexOf('\n(', s - 1) + 1; if (s <= 0) { s = 0; break; } if (oc[s] === C.PAR && oc[s - 1] !== C.STR && oc[s - 1] !== C.DOC) break; s--; }
  let e = n - span.suf;
  for (;;) { e = r.indexOf('\n(', e); if (e < 0) { e = n; break; } e++; if (oc[e - shift] === C.PAR) break; }
  const info: EcLexInfo = {};
  let mid = lex(r.slice(s, e), info);
  if (info.dirty && e < n) { e = n; mid = lex(r.slice(s), info); }
  const startDepth = s < n && r.charCodeAt(s) === 40 ? od[s] : 0;
  let cls = oc, d = od;
  if (cls.length < n) {
    const cap = n + (n >> 2) + 4096;
    cls = new Uint8Array(cap); cls.set(oc.subarray(0, s)); if (e < n) cls.set(oc.subarray(e - shift, oldN), e);
    d = new Uint8Array(cap); d.set(od.subarray(0, s)); if (e < n) d.set(od.subarray(e - shift, oldN), e);
  } else if (e < n && shift) { cls.copyWithin(e, e - shift, oldN); d.copyWithin(e, e - shift, oldN); }
  cls.set(mid, s);
  const base = Math.max(0, s - 1);
  markDocstrings(r.slice(base, Math.min(n, e + 65536)), cls, Math.max(0, s - 1), e, base);
  d.fill(0, s, e);
  const end = parenDepths(r, cls, s, e, startDepth, d) as number;
  if (e < n && ((end % 6) + 6) % 6 !== d[e]) parenDepths(r, cls, e, n, end, d);
  b._lcb = cls; b._ldb = d; b._lc = cls.subarray(0, n); b._ld = d.subarray(0, n); b._lv = b.ver; b._llen = n;
  return b._lc;
}
/* A lex made elsewhere (the worker pool) for version VER of B. */
function installLex(b: EdBuffer, ver: number, cls: Uint8Array | number[], d: unknown) { b._lcb = b._lc = cls; b._ldb = b._ld = d; b._lv = ver; b._llen = cls.length; }
/* Lengths of the common prefix and suffix of two texts (the suffix never overlaps the prefix). */
function diffSpan(a: string, b: string) {
  const n = Math.min(a.length, b.length);
  let pre = 0; while (pre < n && a.charCodeAt(pre) === b.charCodeAt(pre)) pre++;
  let suf = 0; while (suf < n - pre && a.charCodeAt(a.length - 1 - suf) === b.charCodeAt(b.length - 1 - suf)) suf++;
  return { pre, suf };
}
function parenDepths(t: EdText, cls: ArrayLike<number>, from: number, to: number, depth: number, d?: Uint8Array): number | Uint8Array {
  const ret = arguments.length > 5;
  d = d || new Uint8Array(t.length);
  for (let k = from; k < to; k++) if (cls[k] === C.PAR) { if (t.charCodeAt(k) === 40) { d[k] = ((depth % 6) + 6) % 6; depth++; } else { depth--; d[k] = ((depth % 6) + 6) % 6; } }
  return ret ? depth : d;
}

/* ---------- Lisp lexer: syntax classes for highlighting and sexp motion ---------- */
const C = { PLAIN: 0, CMT: 1, STR: 2, PAR: 3, NUM: 4, KW: 5, FN: 6, CONST: 7, QUO: 8, DOC: 9 };
const KEYWORDS = new Set(('define define-syntax define-macro define-record-type define-command define-values lambda let let* letrec letrec* ' +
  'named-lambda if when unless cond case and or not do while until dolist dotimes begin set! quote quasiquote syntax-rules ' +
  'parameterize guard dynamic-wind call/ec catch throw unwind-protect ignore-errors save-excursion with-current-buffer interactive ' +
  'let-values receive assert delay push! pop! inc! dec! when-let if-let and-let* -> ->> evil-define-motion evil-define-operator ' +
  'evil-define-text-object evil-define-key evil-ex-define-cmd define-key global-set-key').split(' '));
const isWS = (c: string) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';
const isDelim = (c: string | undefined) => c === undefined || isWS(c) || '()";\'`,[]'.includes(c);
function lex(t: string, info?: EcLexInfo) {
  const n = t.length, cls = new Uint8Array(n);
  if (info) info.dirty = false;
  let i = 0, quoted = false, afterParen = false, defName = false;
  while (i < n) {
    const ch = t[i];
    if (ch === ';') { while (i < n && t[i] !== '\n') cls[i++] = C.CMT; continue; }
    if (ch === '"') {
      cls[i++] = C.STR;
      while (i < n && t[i] !== '"') { if (t[i] === '\\' && i + 1 < n) cls[i++] = C.STR; cls[i++] = C.STR; }
      if (i < n) cls[i++] = C.STR; else if (info) info.dirty = true;
      quoted = false; afterParen = false; continue;
    }
    if (ch === '(' || ch === ')') { if (ch === '(' && i > 0 && t[i - 1] === '\n') { quoted = false; defName = false; } cls[i++] = C.PAR; afterParen = ch === '('; continue; }
    if (isWS(ch)) { i++; continue; }
    if (ch === "'" || ch === '`' || ch === ',' || ch === '@' || (ch === '#' && t[i + 1] === "'")) {
      cls[i++] = C.QUO; if (ch === '#') cls[i++] = C.QUO; quoted = ch !== ',' && ch !== '@'; afterParen = false; continue;
    }
    if (ch === '#' && t[i + 1] === '\\') {
      cls[i++] = C.NUM; cls[i++] = C.NUM; while (i < n && !isDelim(t[i])) cls[i++] = C.NUM; afterParen = false; continue;
    }
    if (ch === '#' && (t[i + 1] === 't' || t[i + 1] === 'f') && isDelim(t[i + 2])) { cls[i++] = C.CONST; cls[i++] = C.CONST; afterParen = false; continue; }
    if (ch === '#' && t[i + 1] === ':') { let j = i + 2; while (j < n && !isDelim(t[j])) j++; for (let m = i; m < j; m++) cls[m] = C.CONST; i = j; afterParen = false; continue; }
    if (ch === '#' && t[i + 1] === '|') { let j = t.indexOf('|#', i + 2); if (j < 0 && info) info.dirty = true; j = j < 0 ? n : j + 2; for (let m = i; m < j; m++) cls[m] = C.CMT; i = j; continue; }
    let j = i; while (j < n && !isDelim(t[j])) { if (t[j] === '\\') j++; j++; }
    if (j === i) { i++; continue; }
    const tok = t.slice(i, j);
    let k = C.PLAIN;
    if (defName) { k = C.FN; defName = false; }
    else if (quoted || tok[0] === ':' || tok[tok.length - 1] === ':' || tok === '#t' || tok === '#f') k = C.CONST;
    else if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) k = C.NUM;
    else if (afterParen && KEYWORDS.has(tok)) { k = C.KW; defName = /^(define|define-syntax|define-macro|define-record-type|define-command|evil-define-(motion|operator|text-object|command))$/.test(tok); }
    for (let m = i; m < Math.min(j, n); m++) cls[m] = k;
    i = j; quoted = false; afterParen = false;
  }
  return cls;
}
/* Docstrings: a string that directly follows the argument list of a defun/defmacro.
   T may be a piece of the text that starts at BASE; FROM and TO are positions in the whole text. */
function markDocstrings(t: string, cls: Uint8Array, from?: number, to?: number, base?: number) {
  base = base || 0;
  const view = base ? cls.subarray(base) : cls;
  const re = /\((?:define|define-command|evil-define-(?:motion|operator|text-object|command))\s+\(/g;
  let m: RegExpExecArray | null;
  re.lastIndex = from ? from - base : 0;
  while ((m = re.exec(t))) {
    if (to !== undefined && m.index + base >= to) break;
    const open = m.index + m[0].length - 1;
    if (view[open] !== C.PAR) continue;
    const close = forwardSexp(t, view, open); if (close === null) continue;
    let k = close; while (k < t.length && isWS(t[k])) k++;
    if (t[k] === '"' && view[k] === C.STR) { const e = forwardSexp(t, view, k)!; for (let q = k; q < e; q++) view[q] = C.DOC; }
  }
  return cls;
}
/* The sexp scanners read characters with charAt, so they work on a string or on the buffer's rope. */
const inStr = (c: number) => c === C.STR || c === C.DOC;
function forwardSexp(t: EdText, cls: ArrayLike<number>, p: number) {
  const n = t.length;
  for (;;) { while (p < n && isWS(t.charAt(p))) p++; if (p < n && cls[p] === C.CMT) { while (p < n && t.charCodeAt(p) !== 10) p++; continue; } break; }
  while (p < n && cls[p] === C.QUO) p++;
  if (p >= n) return null;
  const c = t.charAt(p);
  if (c === '"' && inStr(cls[p])) { let k = p + 1; while (k < n && t.charCodeAt(k) !== 34) { if (t.charCodeAt(k) === 92) k++; k++; } return Math.min(n, k + 1); }
  if (c === ')' && cls[p] === C.PAR) return null;
  if (c === '(' && cls[p] === C.PAR) {
    let d = 0;
    for (; p < n; p++) if (cls[p] === C.PAR) { if (t.charCodeAt(p) === 40) d++; else if (--d === 0) return p + 1; }
    return null;
  }
  while (p < n && (cls[p] === C.NUM || !isDelim(t.charAt(p)))) p++;
  return p;
}
function backwardSexp(t: EdText, cls: ArrayLike<number>, p: number) {
  for (;;) { while (p > 0 && isWS(t.charAt(p - 1))) p--; if (p > 0 && cls[p - 1] === C.CMT) { while (p > 0 && cls[p - 1] === C.CMT) p--; continue; } break; }
  if (p <= 0) return null;
  const c = t.charAt(p - 1);
  if (inStr(cls[p - 1])) { p--; while (p > 0 && inStr(cls[p - 1])) p--; }
  else if (c === '(' && cls[p - 1] === C.PAR) return null;
  else if (c === ')' && cls[p - 1] === C.PAR) {
    let d = 0;
    for (p = p - 1; p >= 0; p--) if (cls[p] === C.PAR) { if (t.charCodeAt(p) === 41) d++; else if (--d === 0) break; }
    if (p < 0) return null;
  } else {
    while (p > 0 && (cls[p - 1] === C.NUM || !isDelim(t.charAt(p - 1)))) p--;
  }
  while (p > 0 && cls[p - 1] === C.QUO) p--;
  return p;
}
function upList(t: EdText, cls: ArrayLike<number>, p: number) { let d = 0; for (let k = p - 1; k >= 0; k--) if (cls[k] === C.PAR) { if (t.charCodeAt(k) === 41) d++; else if (d-- === 0) return k; } return null; }
function matchParen(t: EdText, cls: ArrayLike<number>, k: number) {
  if (t.charAt(k) === '(') { const e = forwardSexp(t, cls, k); return e === null ? null : e - 1; }
  return backwardSexp(t, cls, k + 1);
}

/* ---------- Lisp indentation ---------- */
const BODY: Record<string, number> = { lambda: 1, let: 1, 'let*': 1, letrec: 1, 'letrec*': 1, 'named-lambda': 1, when: 1, unless: 1, while: 1, until: 1, if: 2, dolist: 1, dotimes: 1,
  'condition-case': 2, 'unwind-protect': 1, catch: 1, 'with-current-buffer': 1, 'save-excursion': 0, begin: 0, 'ignore-errors': 0, do: 2,
  parameterize: 1, guard: 1, 'let-values': 1, receive: 2, 'syntax-rules': 1, 'define-record-type': 2, 'when-let': 1, 'if-let': 1, 'and-let*': 1,
  'define-syntax': 1, 'define-macro': 1, 'call/ec': 0, 'dynamic-wind': 0, 'let-syntax': 1, case: 1 };
function lispIndentFor(t: EdText, cls: ArrayLike<number>, ls: number) {
  if (ls > 0 && inStr(cls[ls - 1]) && inStr(cls[ls])) return null;
  const open = upList(t, cls, ls);
  if (open === null) return 0;
  const oc = column(t, open), le = eol(t, open);
  let k = open + 1;
  if (k >= le || t.charAt(k) === '(' || t.charAt(k) === '"' || t.charAt(k) === ';' || cls[k] === C.QUO) return oc + 1;
  let j = k; while (j < t.length && !isDelim(t.charAt(j))) j++;
  const head = t.slice(k, j);
  let spec = BODY[head];
  if (spec === undefined && /^(def|evil-define-(motion|operator|text-object|command)$)/.test(head)) spec = 0;
  if (spec !== undefined) {
    let n = 0, p = j;
    /* Stop when a sexp makes no progress (a stray delimiter): the original looped forever there. */
    for (;;) { const e = forwardSexp(t, cls, p); if (e === null || e > ls || e <= p) break; n++; p = e; }
    return n < spec ? oc + 4 : oc + 2;
  }
  let a = j; while (a < le && (t.charAt(a) === ' ' || t.charAt(a) === '\t')) a++;
  return a < le && t.charAt(a) !== ';' ? column(t, a) : oc + 1;
}
function indentLine(b: EdBuffer) {
  const t = b.rope, ls = bol(t, b.pt);
  const cls = lexOf(b)!;
  const want = lispIndentFor(t, cls, ls);
  if (want === null) return;
  let ie = ls; while (ie < t.length && (t.charAt(ie) === ' ' || t.charAt(ie) === '\t')) ie++;
  const have = column(t, ie);
  const offset = b.pt - ie;
  if (have !== want) {
    const save = b.pt; b.pt = ls; deleteText(b, ls, ie); b.pt = ls; insertText(b, ' '.repeat(want));
    b.pt = offset > 0 ? ls + want + offset : ls + want; void save;
  } else if (offset < 0) b.pt = ie;
}

/* ---------- keymaps ---------- */
interface Keymap extends EdKeymap {}
class Keymap {
  constructor(name?: string | null) { this.name = (name || null) as string; this.map = new Map(); this.parent = null; }
  __print() { return '#<keymap' + (this.name ? ' ' + this.name : '') + '>'; }
  get __type() { return 'keymap'; }
}
const PREFIX = Symbol('prefix');
const ALIAS: Record<string, string> = { '<return>': 'RET', '<tab>': 'TAB', '<backtab>': 'S-TAB', '<backspace>': 'DEL', '<escape>': 'ESC', '<space>': 'SPC', ' ': 'SPC', '<delete>': '<deletechar>', 'C-[': 'ESC', 'C-i': 'TAB', 'C-m': 'RET' };
function normKey(k: string) {
  if (ALIAS[k]) return ALIAS[k];
  const mods = new Set();
  let rest = k;
  while (/^[ACHMSs]-./.test(rest)) { mods.add(rest[0]); rest = rest.slice(2); }
  rest = ALIAS[rest] || rest;
  const out = (mods.has('C') ? 'C-' : '') + (mods.has('M') ? 'M-' : '') + (mods.has('S') ? 'S-' : '') + rest;
  return ALIAS[out] || out;
}
function kbd(s: string) { return String(s).trim().split(/\s+/).filter(Boolean).map(normKey).join(' '); }
function defineKey(km: EdKeymap, keys: string, def: EdBinding) {
  const parts = kbd(keys).split(' ');
  let m = km;
  for (let k = 0; k < parts.length - 1; k++) {
    let sub = m.map.get(parts[k]);
    if (!(sub instanceof Keymap)) { sub = new Keymap(); m.map.set(parts[k], sub); }
    m = sub as EdKeymap;
  }
  const last = parts[parts.length - 1];
  if (def === false) m.map.delete(last); else m.map.set(last, def);
  return def;
}
function lookupIn(km: EdKeymap, parts: string[]) {
  let m: EdBinding | undefined = km;
  for (const p of parts) {
    if (!(m instanceof Keymap)) return undefined;
    let d = m.map.get(p);
    for (let par = m.parent; d === undefined && par; par = par.parent) d = par.map.get(p);
    if (d instanceof Sym) { const v = L.get(d.name); if (v instanceof Keymap) d = v; }
    m = d;
  }
  return m;
}
const KM = (name: string) => { const v = L.get(name); return v instanceof Keymap ? v : null; };
/* ---------- minor and derived modes (R4.25) ----------
   A minor mode is a command and a variable that holds its state, buffer-local unless the mode is
   global. Edwin Scheme has one binding per name, so the variable cannot share the command's name as in
   Emacs: it is NAME without -mode plus -enabled (electric-pair-mode sets electric-pair-enabled),
   unless define-minor-mode names one with :variable. Its keymap, the
   variable NAME-map, is searched after the Evil state maps and before the major mode's map. A derived
   major mode records its parent: its keymap inherits the parent's, and Evil's per-mode maps of the
   parent apply to it too. */
const minorModes = new Map<string, EdMinorMode>();
const minorOn = (b: EdBuffer, m: EdMinorMode) => { const v = m.global ? L.get(m.variable) : localValue(b, m.variable); return v !== undefined && v !== false && v !== NIL; };
function minorMaps(b: EdBuffer) {
  const out: EdKeymap[] = [];
  for (const m of minorModes.values()) if (minorOn(b, m)) { const km = KM(m.name + '-map'); if (km) out.push(km); }
  return out;
}
function lighters(b: EdBuffer) { let s = ''; for (const m of minorModes.values()) if (m.lighter && minorOn(b, m)) s += m.lighter; return s; }
const modeParents = new Map<string, string>();
/* MODE and the modes it derives from, nearest first. */
function modeChain(mode: string) { const out = [mode]; for (let m = modeParents.get(mode), n = 0; m && n < 32; m = modeParents.get(m), n++) out.push(m); return out; }
function activeMaps(b?: EdBuffer | null) {
  b = b || E.current;
  const out: EdKeymap[] = [];
  if (b.minibuf && E.mini) { const m = KM('minibuffer-local-map'); if (m) out.push(m); }
  if (hooks.stateMaps) out.push(...hooks.stateMaps(b));
  if (minorModes.size) out.push(...minorMaps(b));
  const mm = KM(b.mode + '-map'); if (mm) out.push(mm);
  const g = KM('global-map'); if (g) out.push(g);
  return out;
}
function lookupWith(maps: EdKeymap[], seq: string) {
  const parts = seq.split(' ');
  let prefix = false;
  for (const m of maps) {
    const d = lookupIn(m, parts);
    if (d instanceof Keymap) { prefix = true; continue; }
    if (d !== undefined && d !== false && !prefix) return d;
  }
  return prefix ? PREFIX : undefined;
}
const lookupKey = (seq: string, b?: EdBuffer | null) => lookupWith(activeMaps(b), seq);
function whereIs(cmd: SchemeValue, maps?: EdKeymap[]) {
  const out: string[] = [];
  const walk = (m: EdKeymap, pre: string, seen: Set<EdKeymap>) => {
    if (seen.has(m)) return; seen.add(m);
    for (const [k, d] of m.map) {
      const seq = pre ? pre + ' ' + k : k;
      if (d instanceof Keymap) walk(d, seq, seen); else if (sameCmd(d, cmd)) out.push(seq);
    }
    if (m.parent) walk(m.parent, pre, seen);
  };
  for (const m of maps || activeMaps(E.win)) walk(m, '', new Set());
  return [...new Set(out)].filter(s => maps || sameCmd(lookupKey(s, E.win), cmd)).sort((a, b) => a.length - b.length);
}
/* Two command designators name the same command: the same symbol, the same procedure, or a symbol and the procedure it holds. */
function sameCmd(a: EdBinding | undefined, b: EdBinding | undefined) {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === PREFIX || b === PREFIX) return false;
  const fa = L.fnOrNull(a as SchemeValue), fb = L.fnOrNull(b as SchemeValue);
  return !!fa && fa === fb;
}

/* ---------- decoding browser key events into Emacs key descriptions ---------- */
const SPECIAL: Record<string, string> = { Enter: 'RET', Backspace: 'DEL', Tab: 'TAB', Escape: 'ESC', ArrowUp: '<up>', ArrowDown: '<down>', ArrowLeft: '<left>', ArrowRight: '<right>',
  Delete: '<deletechar>', Home: '<home>', End: '<end>', PageUp: '<prior>', PageDown: '<next>', Insert: '<insert>' };
const CODEMAP: Record<string, string[]> = { Comma: [',', '<'], Period: ['.', '>'], Slash: ['/', '?'], Semicolon: [';', ':'], Quote: ["'", '"'], BracketLeft: ['[', '{'],
  BracketRight: [']', '}'], Backslash: ['\\', '|'], Minus: ['-', '_'], Equal: ['=', '+'], Backquote: ['`', '~'], Space: ['SPC', 'SPC'] };
const SHIFT_DIGIT = ')!@#$%^&*(';
function keyName(e: EdKeyEvent) {
  if (/^(Shift|Control|Alt|Meta|CapsLock|AltGraph|OS|Hyper|Super|Fn|Dead|Unidentified|Process)$/.test(e.key) || e.isComposing) return null;
  if (e.metaKey) return null;                        // leave Cmd/Super shortcuts to the browser
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') return null; // let the browser paste
  if (e.getModifierState && e.getModifierState('AltGraph') && e.key.length === 1) return e.key;
  const ctrl = e.ctrlKey, meta = e.altKey;
  let base;
  if (SPECIAL[e.key]) base = SPECIAL[e.key];
  else if (/^F\d{1,2}$/.test(e.key)) base = '<f' + e.key.slice(1) + '>';
  else if (ctrl || meta) {
    const c = e.code!;
    if (/^Key[A-Z]$/.test(c)) base = e.shiftKey && !ctrl ? c[3] : c[3].toLowerCase();
    else if (/^Digit\d$/.test(c)) base = e.shiftKey ? SHIFT_DIGIT[+c[5]] : c[5];
    else if (CODEMAP[c]) base = CODEMAP[c][e.shiftKey ? 1 : 0];
    else if (e.key.length === 1) base = e.key;
    else return null;
  } else if ([...e.key].length === 1) base = e.key === ' ' ? 'SPC' : e.key;
  else return null;
  return normKey((ctrl ? 'C-' : '') + (meta ? 'M-' : '') + (e.shiftKey && base.length > 1 && (base[0] === '<' || base === 'TAB') ? 'S-' : '') + base);
}
const selfInsertable = (k: string) => k === 'SPC' || [...k].length === 1;
const keyChar = (k: string) => k === 'SPC' ? ' ' : k === 'RET' ? '\n' : k === 'TAB' ? '\t' : selfInsertable(k) ? k : null;

/* ---------- echo area and messages ---------- */
function message(s: string) {
  E.echo = s;
  if (s) {
    const m = getBufferCreate('*Messages*');
    const was = E.inhibitRO; E.inhibitRO = true;
    const atEnd = m.pt === m.rope.length;
    const save = m.pt; m.pt = m.rope.length; insertText(m, s + '\n'); m.pt = atEnd ? m.rope.length : save; m.modified = false;
    E.inhibitRO = was;
  }
}
function ding() { if (E.frame && E.frame.backend) { if (E.frame.backend.bell) E.frame.backend.bell(); return; } const f = E.frame && E.frame.root; if (!f) return; f.classList.remove('bell'); void f.offsetWidth; f.classList.add('bell'); }
function errorText(e: unknown) {
  if (e instanceof SchemeError) return L.errorMessage(e);
  if (e instanceof L.S.Raise) return L.errorMessage(e);
  if (e instanceof L.Escape) return 'Escape procedure called outside its extent';
  if (e instanceof RangeError) return 'Recursion too deep (stack overflow)';
  console.error(e);
  return 'Internal error: ' + (e && (e as Error).message);
}
const QUIET = L.QUIET;
function quietQuit(): never { L.quit(true); }
function reportError(e: unknown) {
  if (L.isQuit(e)) { if (!L.isQuietQuit(e)) { E.echo = 'Quit'; ding(); } return; }
  message(errorText(e)); ding();
}

/* ---------- the input queue ---------- */
const SENTINEL = '\u0000end-of-keys';
const queue: EdQueuedKey[] = [];
let wake: (() => void) | null = null;
function wakeUp() { if (wake) { const w = wake; wake = null; w(); } }
function feedKey(k: string) { queue.push({ k, real: true }); wakeUp(); }
/* Push keys in front of the queue. Replayed keys are not recorded into keyboard macros. */
function unreadKeys(keys: string[], real = false) { queue.unshift(...keys.map(k => ({ k, real, noRecord: real }))); wakeUp(); }
function pushSentinel(keys: string[]) { queue.unshift(...keys.map(k => ({ k, real: false })), { k: SENTINEL, real: false }); wakeUp(); }
function flushReplay() { for (let i = queue.length - 1; i >= 0; i--) if (!queue[i].real && queue[i].k !== SENTINEL) queue.splice(i, 1); }
async function nextKey(opts?: { sentinel?: boolean }) {
  for (;;) {
    if (queue.length) {
      const it = queue.shift()!;
      if (it.k === SENTINEL && !(opts && opts.sentinel)) { queue.unshift(it); quietQuit(); }
      E.lastKeyReal = it.real;
      if (it.k !== SENTINEL && !it.noRecord && hooks.recordKey) hooks.recordKey(it);
      return it.k;
    }
    render();
    E.idle = true;
    for (const r of idleWaiters.splice(0)) r();
    await new Promise<void>(r => { wake = r; });
    E.idle = false;
  }
}
const idleWaiters: (() => void)[] = [];
function whenIdle() { return new Promise<void>(r => { if (E.idle && !queue.length) r(); else idleWaiters.push(r); }); }

/* ---------- minibuffer: a recursive edit that runs commands until exit or abort ---------- */
async function readMini(prompt: string, initial?: string, completer?: EdCompleter | null, opts?: EdMiniOpts) {
  opts = opts || {};
  if (E.mini) signal('error', 'Command attempted to use minibuffer while in minibuffer');
  const mb = E.minibuf;
  mb.text = initial || ''; mb.pt = mb.rope.length; mb.mark = null; mb.markActive = false; mb.undo = []; mb.redo = []; mb.pendingUndo = null;
  const saved = { cur: E.current, prefix: E.prefixArg, cmd: E.thisCommand, keys: E.thisKeys, last: E.lastCommand };
  const m: EdMini = E.mini = { prompt, completer: completer || null, opts, histIdx: -1, history: opts.history || historyFor(opts.kind), done: null, index: opts.noIndex ? -1 : 0, cache: null, cacheKey: null, scroll: 0 };
  E.current = mb; E.echo = ''; E.miniFlash = '';
  E.depth++;
  try {
    if (opts.onChange) opts.onChange(mb.text);
    while (!m.done) {
      const k = await nextKey();
      const before = mb.text;
      await dispatch(k);
      if (E.mini === m && mb.text !== before) { m.index = opts.noIndex ? -1 : 0; m.scroll = 0; if (opts.onChange) opts.onChange(mb.text); }
      if (E.mini === m && opts.onSelect) { const c = miniCandidates(); opts.onSelect(m.index >= 0 && m.index < c.length ? c[m.index] : null, mb.text); }
    }
  } finally {
    E.depth--;
    if (E.mini === m) E.mini = null;
    E.current = E.buffers.includes(saved.cur) ? saved.cur : E.win!;
    E.prefixArg = saved.prefix; E.thisCommand = saved.cmd; E.thisKeys = saved.keys; E.lastCommand = saved.last; E.miniFlash = '';
    if (opts.onExit) opts.onExit();
    if (hooks.miniExit) hooks.miniExit(m);
  }
  if (m.done.quit) L.quit(false);
  return m.done.value;
}
/* Orderless matching: the input is split into terms; each term must match somewhere, in any order.
   A term is a regexp when it looks like one, else a literal. Matches are case-insensitive unless the term has capitals.
   Candidates that match at the start sort first, then by recent use, then alphabetically. */
function termRegex(term: string) {
  const ci = term === term.toLowerCase() ? 'i' : '';
  if (/[\\^$.*+?()[\]{}|]/.test(term)) { try { return new RegExp(term, ci); } catch (e) { /* literal */ } }
  return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ci);
}
const recentUse = new Map<string, Map<string, number>>(); // completer kind -> Map(candidate -> tick)
let useTick = 0;
/* Minibuffer histories, one per completer kind as in Emacs (M-x, buffers, files...); the others share
   E.history. savehist (stack.ts) persists them. */
const histories = new Map<string, string[]>();
function historyFor(kind?: string) { if (!kind) return E.history; let h = histories.get(kind); if (!h) { h = []; histories.set(kind, h); } return h; }
/* Prescient: for these kinds a candidate chosen before sorts first, the most recently chosen first
   (the last prescient-history-length choices), then by how often it was chosen, then shorter
   candidates first, as prescient.el does. The table persists (prescient-persist-mode) through
   stack.ts. The tables have no prototype, so a candidate named __proto__ or constructor is
   just a key. */
const PRESCIENT_KINDS = new Set<string | undefined>(['command', 'buffer', 'consult-buffer', 'file']);
const prescient: EdApi['prescient'] = { tick: 0, kinds: Object.create(null), save: null, limit: 300 };
L.defvar('prescient-history-length', 100, 'How many of the last chosen candidates of each kind sort by recency, before the frequency order.');
const histLen = () => Math.max(0, Number(L.get('prescient-history-length')) || 0);
function prescientFor(kind?: string) { return PRESCIENT_KINDS.has(kind) && Object.hasOwn(prescient.kinds, kind!) ? prescient.kinds[kind!] : null; }
/* Candidate -> rank among the last prescient-history-length choices of table K (0 is the newest). */
function prescientRecency(k: Record<string, [number, number]>) {
  const keys = Object.keys(k).sort((a, b) => k[b][1] - k[a][1]), out = new Map(), n = Math.min(keys.length, histLen());
  for (let i = 0; i < n; i++) out.set(keys[i], i);
  return out;
}
function prescientBump(kind: string | undefined, v: string) {
  if (!PRESCIENT_KINDS.has(kind)) return;
  const k = Object.hasOwn(prescient.kinds, kind!) ? prescient.kinds[kind!] : (prescient.kinds[kind!] = Object.create(null));
  const e = Object.hasOwn(k, v) ? k[v] : (k[v] = [0, 0]);
  e[0]++; e[1] = ++prescient.tick;
  const keys = Object.keys(k);
  if (keys.length > prescient.limit) {
    /* Past the limit, drop a quarter: never one of the recent choices (the one just made among
       them), the least used and oldest of the rest first. */
    const recent = prescientRecency(k), old = keys.filter(x => !recent.has(x) && x !== v);
    old.sort((a, b) => k[a][0] - k[b][0] || k[a][1] - k[b][1]);
    for (const x of old.slice(0, keys.length >> 2)) delete k[x];
  }
  if (prescient.save) prescient.save();
}
L.defvar('vertico-cycle', true, 'Non-#f lets the minibuffer highlight wrap from the last candidate to the first and back.');
L.defvar('vertico-resize', true, 'Non-#f shrinks the candidate list to the candidates; #f keeps it vertico-count rows tall.');
/* Whether every candidate that matches query Q2 also matches Q1, so Q2 can filter Q1's results:
   each term of Q1 is a literal inside some literal term of Q2 (typing extends the input). */
const RE_META = /[\\^$.*+?()[\]{}|]/;
function narrows(q1: string, q2: string) {
  const t1 = q1.trim().split(/\s+/).filter(Boolean), t2 = q2.trim().split(/\s+/).filter(Boolean);
  if (!t1.length) return true;
  return t1.every(a => !RE_META.test(a) && t2.some(c => !RE_META.test(c) && c.includes(a)));
}
const ASYNC_MIN = 20000;
/* Candidates for the current input. A longer input filters the previous results instead of the
   whole list; a big list (consult-line on a big buffer) is filtered by the worker pool, and the
   previous results stay on screen until the answer comes. SYNC forces an answer now (RET, TAB). */
function miniCandidates(sync?: boolean) {
  const m = E.mini; if (!m || !m.completer) return [];
  const q = E.minibuf.text;
  if (m.cache && m.cacheKey === q) return m.cache;
  const all = m.completer(q);
  const terms = q.trim().split(/\s+/).filter(Boolean).map(termRegex);
  const recent = recentUse.get(m.opts.kind || m.prompt) || new Map<string, number>();
  const pres = prescientFor(m.opts.kind);
  const finish = (out: string[]) => {
    if (!m.opts.keepOrder) {
      const first = terms.length ? terms[0] : null, def = m.opts.def;
      const score = (c: string) => (c === def && !terms.length ? -1 : first && first.test(c) && c.search(first) === 0 ? 0 : 1);
      /* listOrder keeps the completer's order (recentf) among equals instead of the alphabet. */
      const tie = m.opts.listOrder ? () => 0 : (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
      if (pres) {
        /* Recency, then frequency, then (among the never chosen) the match score and length; the
           completer's order (recentf) stands in for length with listOrder. */
        const isDef = (c: string) => (c === def && !terms.length ? -1 : 0), z = [0, 0], rec = prescientRecency(pres);
        const get = (c: string) => (Object.hasOwn(pres, c) ? pres[c] : z), rank = (c: string) => { const r = rec.get(c); return r === undefined ? Infinity : r; };
        const len = m.opts.listOrder ? () => 0 : (a: string, b: string) => a.length - b.length;
        out.sort((a, b) => isDef(a) - isDef(b) || rank(a) - rank(b) || get(b)[0] - get(a)[0] || score(a) - score(b) || len(a, b) || tie(a, b));
      } else out.sort((a, b) => score(a) - score(b) || (recent.get(b) || 0) - (recent.get(a) || 0) || tie(a, b));
    }
    m.cache = out; m.cacheKey = q; m.cacheAll = all;
    return out;
  };
  if (!terms.length) return finish(all.slice());
  /* The base: the previous matches when this input narrows them (kept in list order), else all. */
  const base = m.matched && m.cacheAll === all && narrows(m.matchedKey!, q) ? m.matched : all;
  const filter = (list: string[]) => { const out = []; for (const c of list) { let ok = true; for (const t of terms) if (!t.test(c)) { ok = false; break; } if (ok) out.push(c); } return out; };
  if (!sync && base.length >= ASYNC_MIN && globalThis.EdPool && EdPool.ok) {
    if (m.asyncKey !== q) {
      m.asyncKey = q;
      const p = EdPool.filterAsync(base, terms);
      if (p) p.then(idx => {
        if (E.mini !== m || E.minibuf.text !== q || (m.cache && m.cacheKey === q)) return;
        const matched = Array.from(idx, i => base[i]);
        m.matched = matched; m.matchedKey = q;
        finish(matched.slice());
        if (m.opts.onSelect) { const c = m.cache!; m.opts.onSelect(m.index >= 0 && m.index < c.length ? c[m.index] : null, q); }
        render();
      }, () => { m.asyncKey = null; });
    }
    if (m.cache) return m.cache;
  }
  const matched = filter(base);
  m.matched = matched; m.matchedKey = q;
  return finish(matched.slice());
}
function markUsed(m: EdMini, v: string) { const key = m.opts.kind || m.prompt; let r = recentUse.get(key); if (!r) { r = new Map(); recentUse.set(key, r); } r.set(v, ++useTick); prescientBump(m.opts.kind, v); }
/* RET: take the highlighted candidate; with none highlighted, the input itself. */
function exitMini(inputOnly?: boolean) {
  const m = E.mini; if (!m) return;
  let v = E.minibuf.text;
  if (m.completer && !inputOnly) {
    const c = miniCandidates(true);
    if (m.index >= 0 && m.index < c.length) v = c[m.index];
    else if (m.opts.require && !m.completer(v).includes(v)) {
      if (v === '' && m.opts.def !== undefined) v = m.opts.def;
      else { E.miniFlash = c.length ? ' [Incomplete]' : ' [No match]'; return; }
    }
  }
  if (v === '' && m.opts.def !== undefined) v = m.opts.def;
  if (m.opts.require && m.completer && !m.completer(v).includes(v) && !(v === '' && m.opts.def !== undefined)) { E.miniFlash = ' [No match]'; return; }
  if (m.completer && v) markUsed(m, v);
  if (v && m.history[0] !== v) { m.history.unshift(v); if (m.history.length > 100) m.history.length = 100; }
  m.done = { value: v };
}
function miniMove(d: number, cycle = true) {
  const m = E.mini; if (!m || !m.completer) { historyMove(-d); return; }
  const c = miniCandidates(), min = m.opts.require ? 0 : -1, max = c.length - 1;
  let i = m.index + d;
  /* vertico-cycle: past either end, come round to the other. Page moves (CYCLE #f) stop at the
     end, as vertico-scroll-down/up do. */
  if (cycle && truthy(L.get('vertico-cycle')) && max >= min && (i > max || i < min)) { const span = max - min + 1; i = ((i - min) % span + span) % span + min; }
  m.index = Math.max(min, Math.min(max, i));
}
function miniInsert() {
  const m = E.mini; if (!m || !m.completer) return;
  const c = miniCandidates(true);
  if (m.index >= 0 && m.index < c.length) { E.minibuf.text = c[m.index]; E.minibuf.pt = c[m.index].length; m.cache = null; }
  else completeMini();
}
function abortMini() { if (E.mini) E.mini.done = { quit: true }; }
function completeMini() {
  const m = E.mini!, c = miniCandidates(true), mb = E.minibuf;
  if (m.completer && m.index >= 0 && m.index < c.length && c.length > 1 && !c.every(x => x.startsWith(mb.text))) { miniInsert(); return; }
  if (!c.length) { E.miniFlash = ' [No match]'; return; }
  if (c.length === 1) { mb.text = c[0]; mb.pt = c[0].length; E.miniFlash = ' [Sole completion]'; return; }
  let p = c[0];
  for (const s of c) while (!s.startsWith(p)) p = p.slice(0, -1);
  if (p.length > mb.rope.length) { mb.text = p; mb.pt = p.length; }
  else E.miniFlash = c.includes(mb.text) ? ' [Complete, but not unique]' : '';
}
function historyMove(d: number) {
  const m = E.mini; if (!m) return;
  const k = m.histIdx + d;
  if (k < -1 || k >= m.history.length) { E.miniFlash = d > 0 ? ' [Beginning of history]' : ' [End of history]'; return; }
  m.histIdx = k; const v = k < 0 ? '' : m.history[k]; E.minibuf.text = v; E.minibuf.pt = v.length;
}
async function readKeySeq(prompt: string) {
  E.prompt = prompt;
  try {
    let seq = '';
    for (;;) {
      const k = await nextKey();
      seq = seq ? seq + ' ' + k : k;
      E.prompt = prompt + seq;
      if (lookupKey(seq, E.win) !== PREFIX) return seq;
    }
  } finally { E.prompt = null; }
}
async function readChar(prompt?: string) {
  E.prompt = prompt || '';
  try {
    const k = await nextKey();
    if (k === 'C-g' || k === 'ESC') quietQuit();
    const ch = keyChar(k);
    if (ch === null) signal('error', 'Non-character input event: ' + k);
    return L.mkchar(ch!);
  } finally { E.prompt = null; }
}

/* ---------- annotations shown beside candidates, as marginalia does ---------- */
function firstLine(s?: string | null) { return (s || '').split('\n')[0]; }
function annotateCommand(name: string) {
  const f = L.fnOrNull(intern(name)); if (!f) return '';
  const keys = whereIs(intern(name));
  return (keys.length ? keys.slice(0, 2).join(', ') + '  ' : '') + firstLine(f.doc);
}
function annotateFunction(name: string) { const f = L.fnOrNull(intern(name)); if (!f) return L.S.macros.has(name) ? 'macro' : ''; return firstLine(f.doc); }
function annotateVariable(name: string) { let v: SchemeValue; try { v = L.get(name); } catch (e) { return ''; } const s = v === undefined ? '' : pr(v, true); return (s.length > 40 ? s.slice(0, 40) + '…' : s) + (L.S.gdoc.get(name) ? '  ' + firstLine(L.S.gdoc.get(name)) : ''); }
function annotateBuffer(name: string) { const b = getBuffer(name); if (!b) return ''; return `${b.modified ? '*' : ' '}${b.readOnly ? '%' : ' '} ${String(b.rope.length).padStart(7)}  ${MODE_NAMES[b.mode] || b.mode}${b.file ? '  ' + b.file : ''}`; }
function annotateFile(name: string) { const v = Store.get(name), f = host.files && host.files.resolve ? host.files.resolve(name) : name; const b = E.buffers.find(x => x.file === f); return (v === null ? 'new' : String(v.length).padStart(7) + ' chars') + (b ? '  (visiting)' : ''); }

/* ---------- interactive specs ---------- */
const { commandNames, functionNames, variableNames, isCommand } = L;
const bufferNames = () => E.buffers.map(b => b.name).filter(n => !n.startsWith(' '));
function prefixNumeric(p: SchemeValue) {
  if (p === null || p === undefined || p === false) return 1;
  if (typeof p === 'number') return p;
  if (p === intern('-')) return -1;
  if (Array.isArray(p)) return p[0] as number;
  return 1;
}
function withDefault(prompt: string, def?: string) { return def ? prompt.replace(/:\s*$/, '') + ` (default ${def}): ` : prompt; }
const specCodes: Record<string, () => Promise<SchemeValue[]>> = {};
async function specArgs(spec: string) {
  const out: SchemeValue[] = [];
  let s = spec;
  while (s && '*^@'.includes(s[0])) { if (s[0] === '*') checkRO(E.current); s = s.slice(1); }
  for (const item of (s || '').split('\n')) {
    if (!item) continue;
    if (item[0] === '<') {
      for (const m of item.matchAll(/<([^>]+)>/g)) {
        const h = specCodes[m[1]];
        if (!h) signal('error', 'Unsupported interactive code: <' + m[1] + '>');
        out.push(...await h());
      }
      continue;
    }
    const code = item[0], prompt = item.slice(1);
    switch (code) {
      case 'p': out.push(prefixNumeric(E.prefixArg)); break;
      case 'P': out.push(E.prefixArg === null ? false : E.prefixArg); break;
      case 'r': { const b = E.current; if (b.mark === null) signal('error', 'The mark is not set now, so there is no region'); out.push(Math.min(b.pt, b.mark!) + 1, Math.max(b.pt, b.mark!) + 1); break; }
      case 'd': out.push(E.current.pt + 1); break;
      case 'm': if (E.current.mark === null) signal('error', 'The mark is not set now'); out.push(E.current.mark! + 1); break;
      case 'i': out.push(false); break;
      case 's': case 'M': out.push(await readMini(prompt, '')); break;
      case 'n': { const v = await readMini(prompt, ''); const n = Number(v); if (v.trim() === '' || isNaN(n)) signal('error', 'Please enter a number.'); out.push(n); break; }
      case 'N': if (E.prefixArg !== null) out.push(prefixNumeric(E.prefixArg)); else { const v = await readMini(prompt, ''); out.push(Number(v) || 0); } break;
      case 'x': out.push(L.read(await readMini(prompt, ''))); break;
      case 'X': out.push(L.ev(L.read(await readMini(prompt, '')))); break;
      case 'C': out.push(intern(await readMini(prompt, '', commandNames, { require: true, kind: 'command', annotate: annotateCommand }))); break;
      case 'a': out.push(intern(await readMini(prompt, '', functionNames, { require: true, kind: 'function', annotate: annotateFunction }))); break;
      case 'v': out.push(intern(await readMini(prompt, '', variableNames, { require: true, kind: 'variable', annotate: annotateVariable }))); break;
      case 'b': { const d = E.current.name; out.push(await readMini(withDefault(prompt, d), '', bufferNames, { require: true, def: d, kind: 'buffer', annotate: annotateBuffer })); break; }
      case 'B': { const d = otherBuffer().name; out.push(await readMini(withDefault(prompt, d), '', bufferNames, { def: d, kind: 'buffer', annotate: annotateBuffer })); break; }
      case 'f': case 'F': out.push(await readMini(prompt, '', () => (hooks.recentFiles ? hooks.recentFiles() : Store.list()), { require: code === 'f', kind: 'file', annotate: annotateFile, listOrder: true })); break;
      case 'k': case 'K': out.push(await readKeySeq(prompt)); break;
      case 'c': out.push(await readChar(prompt)); break;
      default: signal('error', 'Unsupported interactive code: ' + code);
    }
  }
  return out;
}
async function callInteractively(cmd: SchemeValue) {
  const f = L.toFn(cmd);
  let spec = f.interactive as SchemeValue;
  if (spec === undefined) signal('wrong-type-argument', `${L.cmdName(cmd)} is not a command`);
  /* A command declared (:where 'server) runs in edwind (R4.27): the protocol client sends call{cmd, ctx}
     and the command loop goes on without waiting. */
  if (f.where === 'server' && hooks.serverCommand) return hooks.serverCommand(L.cmdName(cmd), f) as SchemeValue;
  let args: SchemeValue[];
  if (typeof spec === 'function' && (spec as SchemeProcedure).jsSpec) args = await (spec as () => Promise<SchemeValue[]>)();
  else {
    if (typeof spec === 'function') { spec = L.callProc(spec, []); if (spec && typeof (spec as Promise<SchemeValue>).then === 'function') spec = await spec; }
    if (typeof spec === 'string') args = await specArgs(spec);
    else if (spec === false || spec === undefined || spec === L.UNSPEC) args = [];
    else args = arr(spec);
  }
  L.resetOps();
  const r = L.callProc(f, args);
  return r && typeof (r as Promise<SchemeValue>).then === 'function' ? await r : r;
}
/* An operator whose work was done while reading its motion (surround) throws OpDone: not an error. */
const callInteractively0 = callInteractively;
async function callInteractivelySafe(cmd: SchemeValue) { try { return await callInteractively0(cmd); } catch (e) { if (E.OpDone && e instanceof E.OpDone) return false; throw e; } }

/* ---------- undo: a linear history with redo; an insert session counts as one change ---------- */
/* Snapshots hold a version, not a copy of the text: restoring one replays the edit log backwards. */
const snap = (b: EdBuffer): EdSnap => ({ ver: b.ver, pt: b.pt, mark: b.mark, modified: b.modified });
function recordUndo(b: EdBuffer, before: EdSnap) {
  const self = intern('self-insert-command');
  if (E.thisCommand === self && E.lastCommand === self && b.typeRun < 20 && b.undo.length) { b.typeRun++; b.redo = []; return; }
  b.typeRun = 0; b.undo.push(before); b.redo = [];
  if (b.undo.length > 500) b.undo.shift();
}
/* Bring the text back to its content at snapshot S, then put point at the first changed position. */
function restoreSnap(b: EdBuffer, s: EdSnap) {
  const log = b.log, ops: EdLogEntry[] = [];
  let k = log.length - 1;
  while (k >= 0 && log[k].v > s.ver) ops.push(log[k--]);
  if (k < 0 && ops.length && log[0].v !== s.ver + 1) signal('user-error', 'Undo history is no longer available');
  const r = b.rope, oldLen = r.length;
  let pre = Infinity, suf = Infinity;
  for (const e of ops) { if (e.pos < pre) pre = e.pos; const x = e.len - e.pos - e.ins.length; if (x < suf) suf = x; }
  const oldMid = ops.length ? r.slice(pre, oldLen - suf) : '';
  /* Undo the ops on the changed span as a string, newest first, and apply the result as one edit.
     Replaying them one by one would log every inverse, and the next undo would replay those too,
     doubling the work at each step. */
  let mid = oldMid;
  for (const e of ops) {
    const q = e.pos - pre; mid = mid.slice(0, q) + e.del + mid.slice(q + e.ins.length);
    /* Markers follow each inverse edit, and those a deletion moved go back to where they were. */
    unshiftMarkers(b, e);
  }
  if (mid !== oldMid) {
    const hk = changeHooks();
    if (hk) runChangeHook(b, 'before-change-functions', [pre + 1, pre + oldMid.length + 1]);
    ropeEdit(b, pre, oldMid.length, mid);
    if (hk) runChangeHook(b, 'after-change-functions', [pre + 1, pre + mid.length + 1, oldMid.length]);
  }
  const newLen = r.length, m = Math.min(oldLen, newLen);
  let i = m;
  if (ops.length) {
    const oe = oldLen - suf;
    i = pre;
    while (i < m) { const c = i < oe ? oldMid.charCodeAt(i - pre) : r.charCodeAt(i - oldLen + newLen); if (c !== r.charCodeAt(i)) break; i++; }
  }
  b.modified = s.modified; b.pt = Math.min(i, newLen);
  b.mark = s.mark === null ? null : Math.min(s.mark, newLen);
  for (const m of b.markers) if (m.pos !== null && m.pos > newLen) m.pos = newLen;
}
function flushPendingUndo(b: EdBuffer) {
  if (b.pendingUndo) { if (changedSince(b, b.pendingUndo.ver)) { b.undo.push(b.pendingUndo); b.redo = []; } b.pendingUndo = null; }
}
function undoStep(b: EdBuffer) {
  /* A replica undoes by groups through everyone else's edits (R6.15–R6.19, sync.ts). */
  if (b.shared && hooks.undoShared) { E.noUndo = true; return hooks.undoShared(b); }
  flushPendingUndo(b);
  if (!b.undo.length) signal('user-error', 'Already at oldest change');
  const cur = snap(b), s = b.undo.pop()!;
  b.redo.push(cur); restoreSnap(b, s); E.noUndo = true;
}
function redoStep(b: EdBuffer) {
  if (b.shared && hooks.redoShared) { E.noUndo = true; return hooks.redoShared(b); }
  if (!b.redo.length) signal('user-error', 'Already at newest change');
  const cur = snap(b), s = b.redo.pop()!;
  b.undo.push(cur); restoreSnap(b, s); E.noUndo = true;
}
function finishUndo(b: EdBuffer, before: EdSnap) {
  if (E.suppressUndo) return;
  if (E.noUndo) { b.pendingUndo = null; return; }
  if (hooks.inSession && hooks.inSession(b)) { if (!b.pendingUndo) b.pendingUndo = before; return; }
  const base = b.pendingUndo || before;
  b.pendingUndo = null;
  if (changedSince(b, base.ver)) recordUndo(b, base);
}

/* ---------- the command loop ---------- */
async function runCommand(def: SchemeValue, keys?: string) {
  const ch = keys ? keyChar(keys) : null;
  L.set('last-command-event', ch ? L.mkchar(ch) : (keys ? intern(keys) : false));
  E.thisCommand = L.cmdSym(def);
  E.thisKeys = keys || '';
  E.cmdSeq++;
  if (!E.mini && E.depth === 0) E.echo = '';
  E.miniFlash = '';
  const b = E.current, before = snap(b), wasActive = b.markActive, pin = b.pin;
  if (before.ver < b.pin) b.pin = before.ver;
  E.keepPrefix = false; E.keepMark = false; E.noUndo = false;
  if (E.depth === 0) L.S.resetStack();
  if (hooks.preCommand) hooks.preCommand(def, b);
  try { L.resetOps(); L.runHook('pre-command-hook'); } catch (e) { reportError(e); }
  const layout = windowLayout();
  let failed = false;
  try { await callInteractivelySafe(def); }
  catch (e) { failed = true; reportError(e); flushReplay(); }
  finally {
    finishUndo(b, before);
    b.pin = pin;
    if (!E.keepMark && wasActive && !b.visual && changedSince(b, before.ver)) b.markActive = false;
    E.lastCommand = E.thisCommand;
    if (!E.keepPrefix) { E.prefixArg = null; E.uArg = false; E.uDigits = null; }
    try { if (hooks.postCommand) hooks.postCommand(def, b, failed); } catch (e) { reportError(e); }
    try { L.resetOps(); L.runHook('post-command-hook'); } catch (e) { reportError(e); }
    if (windowLayout() !== layout) try { L.resetOps(); L.runHook('window-configuration-change-hook'); } catch (e) { reportError(e); }
  }
}
/* The window tree and what each window shows, as a string: a command that changes it runs
   window-configuration-change-hook. */
function windowLayout() {
  if (!E.root) return '';
  const walk = (n: EdWindow | Split): string => (n instanceof Split ? n.dir + '(' + n.children.map(walk).join(',') + ')' : n.id + ':' + (n.buffer ? n.buffer.id : 0));
  return walk(E.root);
}
/* Run FN as a callback outside any command (a thread result): its edits become one undo step,
   the log is pinned while it runs, errors go to the echo area, and the screen is redrawn. */
function runCallback<T>(fn: () => T) {
  const b = E.current, before = snap(b), pin = b.pin;
  if (before.ver < b.pin) b.pin = before.ver;
  E.noUndo = false;
  try { L.resetOps(); return fn(); }
  catch (e) { reportError(e); return undefined; }
  finally { finishUndo(b, before); b.pin = pin; render(); }
}
async function dispatch(k: string) {
  if (k.startsWith('<cmd:')) { await runCommand(intern(k.slice(5, -1)), ''); return; }
  if (hooks.beforeKey && await hooks.beforeKey(k)) return;
  if (E.uArg && /^(-|[0-9])$/.test(k)) {
    E.uDigits = (E.uDigits || '') + k;
    E.prefixArg = k === '-' && E.uDigits === '-' ? intern('-') : Number(E.uDigits);
    E.echo = 'C-u ' + E.uDigits + '-'; return;
  }
  let seq = k;
  try {
    for (;;) {
      const def = lookupKey(seq);
      if (def === undefined && seq === 'ESC') {
        E.pendingKeys = 'ESC'; if (!E.mini) E.echo = 'ESC-';
        const k2 = await nextKey();
        seq = normKey(k2.startsWith('M-') ? k2 : 'M-' + k2);
        continue;
      }
      if (def === PREFIX) {
        E.pendingKeys = seq;
        if (!E.mini && /^[CM]-|^ESC/.test(seq)) E.echo = seq + '-';
        const k2 = await nextKey();
        if (k2 === 'ESC' || k2 === 'C-g') {
          E.pendingKeys = ''; E.echo = k2 === 'C-g' ? 'Quit' : '';
          E.prefixArg = null; if (hooks.undefinedKey) hooks.undefinedKey(seq);
          return;
        }
        seq = seq + ' ' + k2;
        continue;
      }
      E.pendingKeys = '';
      if (def === undefined) {
        if (seq === k && selfInsertable(k) && (!hooks.canSelfInsert || hooks.canSelfInsert(E.current))) { await runCommand(intern('self-insert-command'), k); return; }
        message(seq + ' is undefined'); ding();
        E.prefixArg = null; if (hooks.undefinedKey) hooks.undefinedKey(seq);
        return;
      }
      await runCommand(def, seq);
      return;
    }
  } finally { E.pendingKeys = ''; }
}
async function commandLoop() {
  for (;;) {
    try { const k = await nextKey({ sentinel: true }); if (k !== SENTINEL) await dispatch(k); }
    catch (e) { reportError(e); flushReplay(); }
  }
}
/* Run KEYS as if typed, in a nested loop, and return when they are used up (for :normal). */
async function executeKeys(keys: string[]) {
  pushSentinel(keys);
  E.depth++;
  try {
    for (;;) {
      const k = await nextKey({ sentinel: true });
      if (k === SENTINEL) break;
      try { await dispatch(k); }
      catch (e) {
        reportError(e);
        while (queue.length && queue[0].k !== SENTINEL) queue.shift();
      }
    }
  } finally { E.depth--; }
}

/* ---------- incremental search (Emacs style) ---------- */
function isearchStart(dir: number) {
  E.isearch = { dir, str: '', origin: E.current.pt, stack: [], failing: false, wrapped: false, match: null };
}
/* Start of the last match of the global regexp RE (matches at most LEN long) at or before FROM,
   scanning back in windows (slices of a flat string are O(1)), so the cost follows the distance
   to the match, not the size of the text. */
function lastMatch(str: string, re: RegExp, from: number, len: number, win?: number) {
  win = win || 65536;
  for (let hi = from; hi >= 0; hi -= win) {
    const ws = Math.max(0, hi - win + 1), sub = str.slice(ws, Math.min(str.length, hi + len));
    let last = -1, m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(sub)) && ws + m.index <= hi) { last = m.index; re.lastIndex = m.index + 1; }
    if (last >= 0) return ws + last;
  }
  return -1;
}
function isearchFind(next: boolean) {
  const s = E.isearch!, b = E.current;
  if (!s.str) { s.match = null; s.failing = false; return; }
  /* Case folding with a regular expression, not by lowercasing a copy of the whole buffer. */
  const fold = s.str === s.str.toLowerCase();
  const hay = b.text, needle = s.str;
  const re = fold ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null;
  let i: number;
  if (s.dir > 0) {
    const from = s.failing && next ? 0 : next ? b.pt : (s.match ? s.match[0] : s.origin);
    if (s.failing && next) s.wrapped = true;
    if (re) { re.lastIndex = Math.max(0, from); const m = re.exec(hay); i = m ? m.index : -1; } else i = hay.indexOf(needle, from);
    if (i >= 0) { s.match = [i, i + needle.length]; b.pt = s.match[1]; s.failing = false; } else s.failing = true;
  } else {
    const from = s.failing && next ? hay.length : next ? (s.match ? s.match[0] - 1 : b.pt - 1) : (s.match ? s.match[0] : s.origin);
    if (s.failing && next) s.wrapped = true;
    i = from < 0 ? -1 : re ? lastMatch(hay, re, from, needle.length) : hay.lastIndexOf(needle, from);
    if (i >= 0) { s.match = [i, i + needle.length]; b.pt = i; s.failing = false; } else s.failing = true;
  }
}
function isearchExit() {
  const s = E.isearch!, b = E.current;
  if (s.str) E.lastSearch = s.str;
  if (b.pt !== s.origin) { b.mark = s.origin; b.markActive = false; E.echo = 'Mark saved where search started'; }
  E.isearch = null;
}
function isearchKey(k: string) {
  const s = E.isearch!, b = E.current;
  const def = lookupKey(k);
  const name = def instanceof L.Sym ? def.name : '';
  const save = () => s.stack.push({ pt: b.pt, str: s.str, failing: s.failing, match: s.match, dir: s.dir, wrapped: s.wrapped });
  if (k === 'C-g') {
    if (s.failing && s.stack.length) { while (s.failing && s.stack.length) Object.assign(s, s.stack.pop()), b.pt = s.match ? (s.dir > 0 ? s.match[1] : s.match[0]) : s.origin; return true; }
    b.pt = s.origin; E.isearch = null; E.echo = 'Quit'; return true;
  }
  if (name === 'isearch-forward' || name === 'isearch-backward') {
    save();
    const dir = name === 'isearch-forward' ? 1 : -1;
    if (!s.str) { s.str = E.lastSearch; s.dir = dir; isearchFind(false); return true; }
    if (dir !== s.dir) { s.dir = dir; s.failing = false; }
    isearchFind(true); return true;
  }
  if (k === 'DEL') { const p = s.stack.pop() as EcIsearchFrame | undefined; if (p) { Object.assign(s, p); b.pt = p.pt; } else ding(); return true; }
  if (k === 'RET') { isearchExit(); return true; }
  if (k === 'C-w') {
    const end = s.match ? s.match[1] : b.pt; let e = end; while (e < b.rope.length && /\w/.test(b.rope.at(e)!)) e++;
    if (e === end && e < b.rope.length) e++;
    save(); s.str += b.rope.slice(end, e); isearchFind(false); return true;
  }
  const ch = keyChar(k);
  if (ch !== null && ch !== '\n' && ch !== '\t') { save(); s.str += ch; isearchFind(false); return true; }
  isearchExit();
  return false;
}
async function isearch(dir: number) {
  isearchStart(dir);
  while (E.isearch) {
    const k = await nextKey();
    if (!isearchKey(k)) { unreadKeys([k], E.lastKeyReal); break; }
  }
}

/* ---------- redisplay ---------- */
const esc = (s: string) => s.replace(/[&<>"]/g, c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
const CLS_NAMES = ['', 'cm', 'st', 'pa', 'nu', 'kw', 'fn', 'co', 'qu', 'dc'];
const FLAG = { REGION: 1, MATCH: 2, LAZY: 4, PAREN: 8, MISMATCH: 16 };
E.avy = null; E.pulse = null;
function markMatches(t: string, flags: Uint8Array, re: RegExp, limit: number) {
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null, count = 0;
  while ((m = r.exec(t)) && count++ < limit) {
    if (m[0] === '') { r.lastIndex++; continue; }
    for (let j = m.index; j < m.index + m[0].length; j++) flags[j] |= FLAG.LAZY;
  }
}
/* Display flags for the text from FROM to TO only; the array is indexed from FROM. */
function computeFlags(b: EdBuffer, opts: EcRenderOpts, from: number, to: number, slice?: string) {
  const t = b.rope, n = t.length, flags = new Uint8Array(to - from + 1);
  const mark = (a: number, z: number, f: number) => { a = Math.max(a, from); z = Math.min(z, to); for (let k = a; k < z; k++) flags[k - from] |= f; };
  if (b.visual && b.mark !== null) {
    const s = Math.min(b.pt, b.mark), e = Math.max(b.pt, b.mark);
    if (b.visual === 'char') mark(s, Math.min(e + 1, n), FLAG.REGION);
    else if (b.visual === 'line') mark(bol(t, s), Math.min(n, eol(t, e) + 1), FLAG.REGION);
    else if (b.visual === 'block') {
      const c1 = Math.min(column(t, b.pt), column(t, b.mark)), c2 = Math.max(column(t, b.pt), column(t, b.mark));
      for (let ls = bol(t, Math.max(s, from)); ls <= e && ls < to; ) {
        const le = eol(t, ls); let c = 0;
        for (let k = ls; k < le; k++) { const w = t.charCodeAt(k) === 9 ? ((c + 8) & ~7) - c : 1; if (c + w - 1 >= c1 && c <= c2) mark(k, k + 1, FLAG.REGION); c += w; }
        if (le >= n) break; ls = le + 1;
      }
    }
  } else if (b.markActive && b.mark !== null) mark(Math.min(b.pt, b.mark), Math.max(b.pt, b.mark), FLAG.REGION);
  if (slice === undefined) slice = t.slice(from, to);
  if (opts.hl) { const r = new RegExp(opts.hl.source, opts.hl.flags.includes('g') ? opts.hl.flags : opts.hl.flags + 'g'); let m: RegExpExecArray | null, count = 0; while ((m = r.exec(slice)) && count++ < 3000) { if (m[0] === '') { r.lastIndex++; continue; } mark(from + m.index, from + m.index + m[0].length, FLAG.LAZY); } }
  if (opts.isearch && opts.isearch.str) {
    const s = opts.isearch, fold = s.str === s.str.toLowerCase();
    const hay = fold ? slice.toLowerCase() : slice, needle = fold ? s.str.toLowerCase() : s.str;
    for (let k = hay.indexOf(needle); k >= 0; k = hay.indexOf(needle, k + 1)) mark(from + k, from + k + needle.length, FLAG.LAZY);
    if (s.match && !s.failing) mark(s.match[0], s.match[1], FLAG.MATCH);
  }
  if (opts.current) mark(opts.current[0], opts.current[1], FLAG.MATCH);
  return flags;
}
function parenFlags(b: EdBuffer, cls: ArrayLike<number>, flags: Uint8Array, onChar: boolean | undefined, from: number, to: number) {
  const t = b.rope, p = b.pt, c0 = t.charAt(p);
  let k = -1;
  if (onChar && (c0 === '(' || c0 === ')') && cls[p] === C.PAR) k = p;
  else if (p > 0 && t.charAt(p - 1) === ')' && cls[p - 1] === C.PAR) k = p - 1;
  else if (c0 === '(' && cls[p] === C.PAR) k = p;
  const set = (i: number, f: number) => { if (i >= from && i < to) flags[i - from] |= f; };
  if (k >= 0) { const o = matchParen(t, cls, k); if (o === null || o === undefined) set(k, FLAG.MISMATCH); else { set(k, FLAG.PAREN); set(o, FLAG.PAREN); } }
}
function spanClass(cls: string, f: number) {
  let cn = cls;
  if (f & FLAG.REGION) cn += ' rg'; if (f & FLAG.LAZY) cn += ' lz'; if (f & FLAG.MATCH) cn += ' im';
  if (f & FLAG.PAREN) cn += ' pm'; if (f & FLAG.MISMATCH) cn += ' px';
  const d = (f >> 5) & 7; if (d) cn += ' d' + (d - 1);
  return cn.trim();
}
/* Folds: B.folds is a sorted list of {s, e} ranges that org.ts keeps, S the end of the line that stays
   shown and E the end of the last hidden line. The lines that start after S and at or before E are
   not shown; the line that ends at S shows an ellipsis in their place. */
function foldAt(folds: EdFold[], ls: number) {
  let lo = 0, hi = folds.length - 1, f: EdFold | null = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (folds[m].s < ls) { f = folds[m]; lo = m + 1; } else hi = m - 1; }
  return f && ls <= f.e ? f : null;
}
function foldEndingAt(folds: EdFold[], le: number) {
  let lo = 0, hi = folds.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1, s = folds[m].s; if (s === le) return folds[m]; if (s < le) lo = m + 1; else hi = m - 1; }
  return null;
}
const foldsOf = (b: EdBuffer) => b.folds && b.folds.length ? b.folds : null;
/* Lines hidden by F, counted once: an edit inside a fold removes it and one before it shifts it. */
function foldLines(b: EdBuffer, f: EdFold) { if (f.n === undefined) f.n = lineNoB(b, f.e) - lineNoB(b, f.s); return f.n; }
/* Hidden lines before each fold, cumulative, so a shown line number is a binary search away. org.ts keeps
   the folds sorted and bumps b._foldVer when the list changes; an edit before a fold only shifts it. */
function foldPrefix(b: EdBuffer, F: EdFold[]) {
  let c = (b as EcFoldBuffer)._foldPre;
  if (!c || c.ver !== b._foldVer || c.n !== F.length) {
    const pre = new Int32Array(F.length + 1);
    for (let i = 0; i < F.length; i++) pre[i + 1] = pre[i] + foldLines(b, F[i]);
    c = (b as EcFoldBuffer)._foldPre = { ver: b._foldVer, n: F.length, pre };
  }
  return c.pre;
}
/* Line numbers that count shown lines only: the line of P, or of the headline that hides it. */
function vLineNo(b: EdBuffer, p: number) {
  const F = foldsOf(b); if (!F) return lineNoB(b, p);
  const pre = foldPrefix(b, F);
  let lo = 0, hi = F.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (F[mid].s < p) lo = mid + 1; else hi = mid; }
  if (lo > 0 && p <= F[lo - 1].e) return lineNoB(b, F[lo - 1].s) - pre[lo - 1];
  return lineNoB(b, p) - pre[lo];
}
/* Start of the Nth shown line. */
function vLineStart(b: EdBuffer, n: number) {
  const F = foldsOf(b); if (!F) return lineStartB(b, n);
  const pre = foldPrefix(b, F);
  let lo = 0, hi = F.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (lineNoB(b, F[mid].s) - pre[mid] < n) lo = mid + 1; else hi = mid; }
  return lineStartB(b, n + pre[lo]);
}
function vLineCount(b: EdBuffer) { const F = foldsOf(b); if (!F) return lineCountB(b); return lineCountB(b) - foldPrefix(b, F)[F.length]; }
/* Render the lines of B from the line at O.from, at most O.count lines (every line when o.lines is
   false: the minibuffer). Span offsets are relative to the line start, so an edit changes only the
   lines it touches. Returns [{o, n, cl, html}], or one HTML string without lines.
   With o.cache (a Map from the previous render of the same window), the html of a line whose
   inputs (text, classes, flags, depths, the cursor) did not change is reused instead of being
   built again from spans; the Map of the lines just rendered is returned as .cache.
   With o.runs (DT0, the display seam), each line instead carries .text (its text, no newline) and .runs,
   the same spans as data for a backend that is not a page (display.ts): {s, e, cls} with offsets from the
   line start and the class string of the span, plus k: 'cur' (the cursor; e === s at the end of a line),
   'avy' and 'ell' (t: the label or the fold ellipsis shown instead), 'eol' (the region past the end).
   The two never share a cache; o.html === false skips the html. */
let KBUF = new Uint16Array(1024);
function renderBuffer(b: EdBuffer, o: EcRenderOpts & { runs: true }): EcRendered;
function renderBuffer(b: EdBuffer, o: EcRenderOpts): EcRendered | string;
function renderBuffer(b: EdBuffer, o: EcRenderOpts) {
  const r = b.rope, n = r.length;
  const lines = o.lines !== false;
  const pt = o.pt === undefined ? b.pt : o.pt;
  const curLine = lines ? lineNoB(b, pt) : 1;
  const folds = lines ? foldsOf(b) : null;
  let ls = lines ? bol(r, Math.max(0, Math.min(o.from || 0, n))) : 0;
  if (folds) { const f = foldAt(folds, ls); if (f) ls = Math.min(n, f.e + 1); }
  const count = lines ? (o.count || 1e9) : 1e9;
  let endPos = ls, cnt = 0;
  for (let p = ls; cnt < count; cnt++) {
    const le = eol(r, p); endPos = Math.min(n, le + 1); if (le >= n) { endPos = n; break; }
    p = le + 1;
    if (folds) { const f = foldAt(folds, p); if (f) { p = f.e + 1; if (p > n) { endPos = n; break; } } }
  }
  const from = ls, to = endPos;
  /* Work on the shown lines only: SEG is the text from FROM to TO, and t reads it with buffer positions. */
  const seg = r.slice(from, to);
  const t = { charAt: (k: number) => seg.charAt(k - from), slice: (a: number, z: number) => seg.slice(a - from, z - from) };
  const eolS = (p: number) => { const q = seg.indexOf('\n', p - from); return q < 0 ? to : q + from; };
  const cls = isLisp(b) && !b.minibuf ? lexOf(b, true) : null;
  /* A mode's own lexer (hooks.lexSeg, org.ts) classifies the shown segment: ECLS is indexed from FROM
     and named by its own table. */
  const ext = !cls && lines && hooks.lexSeg ? hooks.lexSeg(b, from, to, seg) as EcLexSeg : null;
  const ecls = ext ? ext.cls : null, names = ext ? ext.names : CLS_NAMES;
  const ellT = folds ? String(hooks.ellipsis ? hooks.ellipsis(b) : '...') : '';
  const ell = folds ? `<span class="oe">${esc(ellT)}</span>` : '';
  const flags = computeFlags(b, o, from, to, seg);
  if (cls && o.active) parenFlags(b, cls, flags, o.onChar, from, to);
  const depths = cls && b._ld && truthy(L.get('rainbow-delimiters-enabled')) ? b._ld as Uint8Array : null;
  const key = (k: number) => ((cls && k < n ? cls[k] : ecls ? ecls[k - from] || 0 : 0) << 8) | flags[k - from] | (depths && cls![k] === C.PAR ? (depths[k] + 1) << 5 : 0);
  const last = lastLineStart(r);
  const showPhantom = pt === n || n === 0;
  const out: EcRendered = [];
  const wantRuns = !!o.runs, wantHtml = o.html !== false || !wantRuns;
  let R: EdRun[] | null = null;
  const cache = (lines || wantRuns) && !o.avy ? o.cache || null : null, next = (lines || wantRuns) && !o.avy ? new Map<string, EcLineVal>() : null;
  /* The cache key also names the class table (a mode's own lexer numbers its classes differently) and
     the fold ellipsis, which change a line's html without changing its text or keys. */
  const ckPre = (o.active ? 1 : 0) + '|' + (o.cursorClass || '') + '|' + (ext ? 'x' : '') + '|' + ell + '|' + (wantRuns ? 'R' + (wantHtml ? 'H' : '') + '|' : '');
  let ln = lines ? lineNoB(b, ls) : 1, made = 0, vis = '';
  for (; ls <= n && made < count; ln++, made++) {
    const le = eolS(ls);
    if (lines && ls === n && ls > 0 && !showPhantom && ls > last) break;
    /* VIS is what fitsRows measures: a folded line also shows the ellipsis after its text. */
    if (folds) vis += seg.slice(ls - from, le - from) + (foldEndingAt(folds, le) ? ellT : '') + seg.slice(le - from, le - from + 1);
    let html = '', start = ls;
    const rel = lines ? ls : 0;
    /* The keys (class, flags, depth) of the line's characters and of its end, read once. */
    const len = le - ls + 1;
    if (KBUF.length < len) KBUF = new Uint16Array(len + (len >> 1) + 1024);
    const kb = KBUF;
    for (let k = ls; k <= le; k++) kb[k - ls] = key(k);
    let ck: string | null = null;
    if (next && len <= 8192) {
      ck = ckPre + (pt >= ls && pt <= le ? pt - ls : -1) + '|' + (le < n ? 1 : 0) + (folds && foldEndingAt(folds, le) ? 'E' : '') + '|' + seg.slice(ls - from, le - from) + '\u0000' + String.fromCharCode.apply(null, kb.subarray(0, len) as unknown as number[]);
      const hit = cache ? cache.get(ck) : undefined;
      if (hit !== undefined) { next.set(ck, hit); pushLine(hit, le); continue; }
    }
    if (wantRuns) R = [];
    const flush = (end: number) => {
      if (end <= start) return;
      const kk = kb[start - ls];
      if (R) R.push({ s: start - ls, e: end - ls, cls: spanClass(names[kk >> 8], kk & 255) });
      if (wantHtml) html += `<span class="${spanClass(names[kk >> 8], kk & 255)}" data-o="${start - rel}">${esc(t.slice(start, end))}</span>`;
    };
    for (let k = ls; k <= le; k++) {
      if (o.avy && o.avy.has(k)) {
        flush(k);
        const lab = o.avy.get(k)!, w = Math.min(lab.length, Math.max(1, le - k));
        if (R) R.push({ s: k - ls, e: k - ls + w, cls: 'avy', k: 'avy', t: lab.slice(0, w) });
        if (wantHtml) html += `<span class="avy" data-o="${k - rel}">${esc(lab.slice(0, w))}</span>`;
        start = k + w; k += w - 1; continue;
      }
      if (k === pt) {
        flush(k);
        const ch = t.charAt(k), atEnd = k === le;
        const kc = atEnd ? '' : cls ? CLS_NAMES[cls[k]] : ecls ? names[ecls[k - from]] || '' : '';
        const fk = flags[k - from] || 0;
        const ccls = `cur ${o.cursorClass || ''}${o.active ? '' : ' ghost'}${kc ? ' ' + kc : ''}${fk & FLAG.REGION ? ' rg' : ''}${fk & FLAG.PAREN ? ' pm' : ''}`;
        if (R) R.push({ s: k - ls, e: atEnd ? k - ls : k - ls + 1, cls: ccls, k: 'cur' });
        if (wantHtml) html += `<span class="${ccls}" data-o="${k - rel}" data-len="${atEnd ? 0 : 1}">${atEnd ? ' ' : esc(ch)}</span>`;
        start = atEnd ? k : k + 1;
        continue;
      }
      if (k === le) {
        flush(k);
        if (le < n && (flags[le - from] & FLAG.REGION)) { if (R) R.push({ s: le - ls, e: le - ls, cls: 'rg eolsel', k: 'eol', t: ' ' }); if (wantHtml) html += `<span class="rg eolsel" data-o="${le - rel}"> </span>`; }
        if (folds && foldEndingAt(folds, le)) { if (R) R.push({ s: le - ls, e: le - ls, cls: 'oe', k: 'ell', t: ellT }); if (wantHtml) html += ell; }
        break;
      }
      if (k > start && kb[k - ls] !== kb[start - ls]) { flush(k); start = k; }
    }
    const val: EcLineVal = !R ? html : wantHtml ? { html, runs: R } : R;
    if (ck !== null) next!.set(ck, val);
    pushLine(val, le);
  }
  function pushLine(val: EcLineVal, le: number) {
    const num = o.numbers ? (o.numbers === 'relative' && ln !== curLine ? Math.abs(ln - curLine) : ln) : null;
    if (wantRuns) {
      const x = { o: ls, n: num, cl: ln === curLine, html: wantHtml ? (val as EcLineBoth).html : undefined, pulse: o.pulse === ls, runs: wantHtml ? (val as EcLineBoth).runs : val as EdRun[], text: seg.slice(ls - from, le - from) };
      out.push(x);
    } else out.push({ o: ls, n: num, cl: ln === curLine, html: val as string, pulse: o.pulse === ls });
    ls = le >= n ? n + 1 : le + 1;
    if (folds && ls <= n) { const f = foldAt(folds, ls); if (f) { ls = f.e + 1; if (ls > n) ls = n + 1; else ln = lineNoB(b, ls) - 1; } }
  }
  if (lines || wantRuns) { out.seg = folds ? vis : seg; out.cache = next; return out; }
  return out.map(x => x.html).join('\n');
}
function syncLines(view: EcView, lines: EcLine[]) {
  const kids = view.children as HTMLCollectionOf<EcLineEl>;
  /* When the window scrolls, the line at index i is the one that was at i+1 (or i-1): its element
     is moved into place rather than refilled, since parsing innerHTML costs more than the rest. */
  let byO: Map<number | undefined, EcLineEl> | null = null;
  for (let i = 0; i < lines.length; i++) {
    const L0 = lines[i];
    let el = kids[i];
    if (!el || el._o !== L0.o) {
      /* Only the elements from this index on are candidates: the earlier ones hold their lines. */
      if (byO === null) { byO = new Map(); for (let j = i; j < kids.length; j++) byO.set(kids[j]._o, kids[j]); }
      const m = byO.get(L0.o);
      if (m && m !== el && m._h === L0.html) { view.insertBefore(m, el || null); el = m; }
      else if (!el) { el = view.ownerDocument.createElement('div'); view.appendChild(el); }
    }
    if (byO !== null) byO.delete(el._o);
    if (el._h !== L0.html) { el.innerHTML = L0.html!; el._h = L0.html; }
    /* Compare against values kept on the element: reading className and dataset costs more. */
    const cn = (L0.cl ? 'ln cl' : 'ln') + (L0.pulse ? ' pulse' : '');
    if (el._cn !== cn) { el.className = cn; el._cn = cn; }
    if (el._o !== L0.o) { el.dataset.o = String(L0.o); el._o = L0.o; }
    if (el._n !== L0.n) { if (L0.n === null) el.removeAttribute('data-n'); else el.dataset.n = String(L0.n); el._n = L0.n; }
  }
  while (kids.length > lines.length) view.removeChild(view.lastChild!);
}
/* Scrolling moves the window start by whole lines, as in Emacs; the view itself never scrolls. */
function scrollWindow(w: EdWindow, lines: number) {
  const b = w.buffer, cur = vLineNo(b, w.start), total = vLineCount(b);
  const target = Math.max(1, Math.min(total, cur + lines));
  w.start = vLineStart(b, target);
}
function onScroll(w: EdWindow) { void w; }
function percent(w: EdWindow) {
  const b = w.buffer, total = lineCountB(b), first = lineNoB(b, w.start), lastShown = w.lastLine || first;
  if (first <= 1 && lastShown >= total) return 'All';
  if (first <= 1) return 'Top';
  if (lastShown >= total) return 'Bot';
  return Math.round((first - 1) / Math.max(1, total - 1) * 100) + '%';
}
function lineHeight() { return metrics(E.sel!).lh; }
/* Geometry of a window's text view. The style-derived parts (line height, character width,
   padding) are cached until the view's classes or the font (E.metricsGen, bumped by the face
   commands and on web-font loads) change, since getComputedStyle and the probe force style work.
   The size is cached too, against E.sizeGen: the view's box only changes with the frame (a window
   resize, a split), the echo area above it or the view's own classes, and each of those bumps the
   generation; a ResizeObserver catches what they miss (a wrapping modeline, an echo area that
   changed after the windows were drawn) and redraws. Reading
   the size on every render forced a layout of the lines the previous render had changed, which
   cost more than the rest of redisplay together. With long lines truncated the view can grow a
   scrollbar as its content changes, so the size is read every time then. */
E.metricsGen = 0; E.sizeGen = 0;
host.page.onFontsLoaded(() => { E.metricsGen++; render(); });
function sizeChanged() { E.sizeGen!++; }
/* A render from inside a frame callback (an animation frame, a resize observer, a media query
   change): the layout is computed in this frame anyway, so overlays place themselves at once
   instead of a frame late (E.inFrame). */
function frameRender() { E.inFrame = true; try { render(); } finally { E.inFrame = false; } }
host.page.onResize(sizeChanged);
/* index.html's narrow-screen rule changes the text's font size and padding, which the style cache holds:
   read it again when the rule starts or stops applying. */
host.page.onMedia('(max-width: 560px)', () => { E.metricsGen++; frameRender(); });
/* The observer watches each view's border box and compares it with the one the last render read,
   whatever the generation: the echo area changes after the windows are drawn, and that resize
   would otherwise wait for the next key. A scrollbar coming or going (long lines truncated) changes
   the client size but not the box; redrawing for it changed the row count, which flipped the
   scrollbar again, every frame. */
const sizeWatch = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
  let stale = false;
  for (const en of entries) {
    const v = en.target as EcView, m = v._win && v._win._m;
    if (!m || !v.isConnected) continue;
    if (v.offsetHeight !== m.oh0 || v.offsetWidth !== m.ow0) stale = true;
  }
  if (stale) { sizeChanged(); frameRender(); }
}) : null;
function metrics(w: EdWindow) {
  const v = w.view!, key = v.className + '|' + E.metricsGen;
  let m = w._m as EcMetrics | undefined;
  if (!m || m.key !== key) {
    const cs = v.ownerDocument.defaultView!.getComputedStyle(v);
    const probe = v.ownerDocument.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:0;top:0';
    probe.textContent = '0'.repeat(64);
    v.appendChild(probe);
    /* Measured rectangles are scaled by an ancestor's transform (a card at zoom z, R9.9); the layout
       sizes (clientWidth) are not, so the measurements are divided by the scale. */
    const sc = viewScale(v);
    const ch = probe.getBoundingClientRect().width / 64 / sc;
    probe.textContent = 'iW'.repeat(32);
    const mono = Math.abs(probe.getBoundingClientRect().width / 64 / sc - ch) < 0.01;
    v.removeChild(probe);
    m = w._m = { key, sgen: -1, lh: parseFloat(cs.lineHeight) || 21, ch, mono, padT: parseFloat(cs.paddingTop) || 0, padX: (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0), nowrap: v.classList.contains('nowrap') } as EcMetrics;
  }
  if (m.sgen !== E.sizeGen || m.nowrap) {
    m.ch0 = v.clientHeight; m.cw0 = v.clientWidth; m.oh0 = v.offsetHeight; m.ow0 = v.offsetWidth; m.cw = m.cw0 - m.padX; m.top = v.clientTop + m.padT; m.oh = v.getBoundingClientRect().height / viewScale(v); m.sgen = E.sizeGen!;
  }
  return m;
}
/* The scale an ancestor's CSS transform applies to element V (1 without one). */
function viewScale(v: HTMLElement) { const ow = v.offsetWidth; if (!ow) return 1; const w = v.getBoundingClientRect().width; return w > 0 ? w / ow : 1; }
/* Whether every shown line fits on one row, judged without layout: printable ASCII and tabs only
   in a monospace font, with three columns to spare (the cursor at the line end, the end-of-line
   region mark, rounding). Anything else is measured in the DOM. */
function fitsRows(seg: string, m: EcMetrics, cols: number, nowrap: boolean) {
  if (!m.mono || !(m.ch > 0) || /[^\t\n\x20-\x7e]/.test(seg)) return false;
  if (nowrap) return true;
  const lim = cols - 3;
  if (lim <= 0) return false;
  let c = 0;
  for (let k = 0; k < seg.length; k++) {
    const x = seg.charCodeAt(k);
    if (x === 10) { c = 0; continue; }
    c = x === 9 ? (c + 8) & ~7 : c + 1;
    if (c > lim) return false;
  }
  return true;
}
/* Build or update the DOM for the window tree, then draw each window. */
function ensureWindowDom() {
  const root = $('windows')!, doc = root.ownerDocument;
  const build = (node: EdWindowNode): HTMLElement => {
    if (node instanceof Window) {
      if (!node.el) {
        node.el = doc.createElement('div'); node.el.className = 'win'; node.el.dataset.wid = node.id as unknown as string;
        node.view = doc.createElement('div'); node.view.className = 'text'; node.view.setAttribute('role', 'textbox'); node.view.setAttribute('aria-multiline', 'true');
        node.ml = doc.createElement('div'); node.ml.className = 'modeline';
        node.ml.innerHTML = '<span class="ml-tag" hidden></span><span class="ml-state"></span><span class="ml-name"></span><span class="ml-pos"></span><span class="ml-mode"></span><span class="ml-extra"></span><span class="ml-sync"></span><span class="ml-cmd"></span>';
        node.el.appendChild(node.view); node.el.appendChild(node.ml);
        (node.view as EcView)._win = node; if (sizeWatch) sizeWatch.observe(node.view, { box: 'border-box' });
        if (hooks.wireWindow) hooks.wireWindow(node);
      }
      return node.el;
    }
    if (!node.el) { node.el = doc.createElement('div'); }
    node.el.className = 'split ' + (node as EdSplit).dir;
    const kids = (node as EdSplit).children.map(build);
    // Keep children in order; move or append as needed without rebuilding their contents.
    for (let i = 0; i < kids.length; i++) if (node.el.children[i] !== kids[i]) { node.el.insertBefore(kids[i], node.el.children[i] || null); sizeChanged(); }
    while (node.el.children.length > kids.length) { node.el.removeChild(node.el.lastChild!); sizeChanged(); }
    return node.el;
  };
  const top = build(E.root!);
  if (root.firstChild !== top) { root.textContent = ''; root.appendChild(top); sizeChanged(); }
  while (root.children.length > 1) { root.removeChild(root.lastChild!); sizeChanged(); }
}
function windowRows(w: EdWindow) { if (!w.view) return w.rows || 24; const m = metrics(w); return Math.max(1, Math.floor(m.ch0 / m.lh)); }
/* What window W shows this redisplay, for the page and for display.ts alike: whether it is the selected window
   of the frame being drawn, its point, Evil's look, and the options its text is rendered with. */
function windowState(w: EdWindow): EcWindowState {
  /* The selected window of a frame that is not the selected frame shows its own point (w.pt) with a ghost cursor. */
  const b = w.buffer, selected = w === E.sel && FS() === (E.frame || E.implicit);
  const look: EdLook = hooks.look ? hooks.look(b, w) : {};
  const nums = L.get('display-line-numbers');
  const numbers = nums === intern('relative') ? 'relative' : truthy(nums) && nums !== NIL ? 'absolute' : null;
  const centered = truthy(localValue(b, 'centered-view-enabled'));
  const nowrap = truthy(L.get('truncate-lines')) && !truthy(localValue(b, 'visual-line-enabled'));
  const active = selected && !E.mini && E.focused;
  const pt = selected ? b.pt : Math.min(w.pt, b.rope.length);
  const opts: EcRenderOpts = { active, numbers, cursorClass: look.cursor || '', onChar: look.onChar, hl: look.hl as RegExp | null | undefined, current: selected ? look.current as [number, number] | null : null, isearch: selected ? E.isearch : null, pt, avy: E.avy && E.avy.win === w ? E.avy.labels as Map<number, string> : null, pulse: selected && E.pulse && (E.pulse as EcPulse).b === b ? (E.pulse as EcPulse).ls : -1 };
  return { b, selected, look, numbers, centered, nowrap, active, pt, opts };
}
/* The first shown line (shown-line numbers: folds hide some) of a window ROWS rows tall with point on shown
   line PTLINE: the window's start, unless point left the window or a recenter (C-l, zz) is pending. */
function scrollStart(w: EdWindow, b: EdBuffer, ptLine: number, rows: number, selected: boolean) {
  if (w.start > b.rope.length) w.start = 0;
  w.start = bol(b.rope, w.start);
  let startLine = vLineNo(b, w.start);
  const rc = selected ? E.recenter : null;
  if (rc === 'top') startLine = ptLine;
  else if (rc === 'bottom') startLine = Math.max(1, ptLine - rows + 1);
  else if (rc) startLine = Math.max(1, ptLine - Math.floor(rows / 2));
  else if (ptLine < startLine) startLine = startLine - ptLine <= 2 ? ptLine : Math.max(1, ptLine - Math.floor(rows / 2));
  else if (ptLine >= startLine + rows) startLine = ptLine - (startLine + rows) <= 1 ? ptLine - rows + 1 : Math.max(1, ptLine - Math.floor(rows / 2));
  if (selected) E.recenter = null;
  return startLine;
}
/* The modeline's fields for window W (ST from windowState), read after the window is drawn (percent needs
   w.lastLine): the Evil tag and its state, the modified mark, the buffer name, the position, the modes, the
   macro note, the sync status and the pending command. */
function modelineFields(w: EdWindow, st: EdWindowState, ptLine: number): EdModelineFields {
  const { b, look, pt, selected } = st;
  return {
    tag: look.tag || '', state: look.state || '', mark: b.readOnly ? '%%' : b.modified ? '**' : '--', name: b.name,
    pos: `L${foldsOf(b) ? lineNoB(b, pt) : ptLine} C${column(b.rope, pt)}  ${percent(w)}`,
    mode: `(${MODE_NAMES[b.mode] || b.mode}${lighters(b)}${selected && E.isearch ? ' Isearch' : ''})`,
    extra: look.extra || '', sync: hooks.modeStatus ? hooks.modeStatus(b, FS()) : '', cmd: selected ? look.showcmd || '' : '',
  };
}
function renderWindow(w: EdWindow) {
  const st = windowState(w), { b, selected, look, numbers, centered, nowrap, pt, opts } = st, view = w.view as EcView;
  const total = lineCountB(b);
  /* Style and class writes only when they change: each one dirties style and layout. */
  const gw = String(Math.max(2, String(total).length));
  if ((w as { _gw?: string })._gw !== gw) { view.style.setProperty('--gw', gw); (w as { _gw?: string })._gw = gw; }
  const vc = (numbers ? 'n' : '') + (nowrap ? 'w' : '') + (centered ? 'c' : '');
  if (w._vc !== vc) { view.classList.toggle('numbers', !!numbers); view.classList.toggle('nowrap', nowrap); view.classList.toggle('centered', centered); w._vc = vc; }
  if (w._selected !== selected) { w.el!.classList.toggle('selected', selected); w._selected = selected; }
  if (view._buf !== b) { view.textContent = ''; view._buf = b; }
  const m = metrics(w), rows = Math.max(1, Math.floor(m.ch0 / m.lh));
  /* Line numbers here count shown lines (folds hide some); w.lastLine stays a real line number. */
  const ptLine = vLineNo(b, pt);
  let startLine = scrollStart(w, b, ptLine, rows, selected);
  let lines!: EcRendered, fits = false;
  let cols = Math.floor((m.cw - (numbers ? (Math.max(2, String(total).length) + 2) * m.ch : 0)) / m.ch);
  /* centered-view-mode caps each line's text at --center-cols (index.html, set by extras.ts). */
  if (centered) cols = Math.min(cols, Number(host.page.getVar('center-cols')) || 100);
  // Wrapped lines take more than one row: render, measure, and move the start down until point fits.
  // When no shown line can wrap, every line is one row of m.lh and the geometry is known without layout.
  for (let tries = 0; tries < 4; tries++) {
    w.start = vLineStart(b, startLine);
    lines = renderBuffer(b, { ...opts, from: w.start, count: rows + 1, cache: w._lcache as Map<string, EcLineVal> | undefined }) as EcRendered;
    w._lcache = lines.cache;
    syncLines(view, lines);
    fits = fitsRows(lines.seg!, m, cols, nowrap);
    if (fits) {
      if (ptLine <= startLine || ptLine >= startLine + lines.length) break;
      const over = m.top + (ptLine - startLine + 1) * m.lh - (m.oh + 1);
      if (over <= 0) break;
      startLine += Math.max(1, Math.ceil(over / m.lh));
      continue;
    }
    const cur = view.querySelector('.cur');
    if (!cur) break;
    const vr = view.getBoundingClientRect(), cr = cur.getBoundingClientRect();
    if (cr.bottom <= vr.bottom + 1 || ptLine <= startLine) break;
    startLine += Math.max(1, Math.ceil((cr.bottom - vr.bottom) / (cr.height || 21)));
  }
  let lastLine = startLine - 1;
  if (fits) {
    let k = 0; while (k < lines.length && m.top + k * m.lh < m.oh) k++;
    while (view.children.length > k) view.removeChild(view.lastChild!);
    lastLine += k;
  } else {
    /* Read every position first, then remove: a removal between reads would force a new layout. */
    const vb = view.getBoundingClientRect().bottom, kids = [...view.children], tops = kids.map(el => el.getBoundingClientRect().top);
    for (let i = 0; i < kids.length; i++) { if (tops[i] >= vb) view.removeChild(kids[i]); else lastLine++; }
  }
  const shown = Math.min(lastLine - startLine + 1, lines.length);
  w.lastLine = foldsOf(b) && shown > 0 ? lineNoB(b, lines[shown - 1].o) : lastLine; w.rows = rows;
  view._lines = lines;
  /* The modeline fields are set only when they change: a DOM write dirties the layout even when
     the text is the same. */
  const ml = modelineFields(w, st, ptLine), mq = (w._mq || (w._mq = {})) as Record<string, EcTextEl>, q = (c: string) => mq[c] || (mq[c] = w.ml!.querySelector<EcTextEl>('.' + c)!);
  const tag = q('ml-tag');
  if (ml.tag) { putText(tag, ml.tag); if (tag._st !== ml.state) { tag.dataset.state = ml.state; tag._st = ml.state; } }
  if (tag._hid !== !ml.tag) { tag.hidden = !ml.tag; tag._hid = !ml.tag; }
  putText(q('ml-state'), ml.mark);
  putText(q('ml-name'), ml.name);
  putText(q('ml-pos'), ml.pos);
  putText(q('ml-mode'), ml.mode);
  putText(q('ml-extra'), ml.extra);
  putText(q('ml-sync'), ml.sync);
  putText(q('ml-cmd'), ml.cmd);
  return look;
}
function putText(el: EcTextEl, s: string) { if (el._t !== s) { el.textContent = s; el._t = s; } }
/* The echo area is written only when its content changes, and a change can change its height,
   and with it the windows above. Its height is read at the start of the next render, before that
   render writes anything, and the windows' sizes are read again only when it moved: most changes
   (isearch, ex and minibuffer typing) keep it. The resize observer redraws in between. */
function setEcho(echo: EcEcho, s: string, html: boolean) {
  if (echo._e === s && echo._eh === html) return;
  if (html) echo.innerHTML = s; else echo.textContent = s;
  echo._e = s; echo._eh = html; echo._dirty = true;
}
function echoMoved(echo: EcEcho) {
  if (!echo._dirty) return;
  echo._dirty = false;
  const h = echo.offsetHeight;
  if (h !== echo._h) { echo._h = h; sizeChanged(); }
}
/* The minibuffer as data, for the page and display.ts: the candidate count ("3/41", "0", null without completion),
   the prompt, the flash, and the shown candidates (vertico-count of them around the selected one), each with its
   label, annotation, whether it is selected, and MARKS, the [from, to) spans of the label that the input's
   terms match. PAD is how many empty rows keep the list vertico-count tall when vertico-resize is #f. */
function miniView(): EdMiniView {
  const m = E.mini!, cands = m.completer ? miniCandidates() : [];
  const label = m.opts.label || (s => s);
  const annotate = m.opts.annotate || null;
  const N = Math.max(3, Math.min(20, Number(L.get('vertico-count')) || 12));
  if (m.index < m.scroll) m.scroll = Math.max(0, m.index);
  if (m.index >= m.scroll + N) m.scroll = m.index - N + 1;
  const terms = E.minibuf.text.trim().split(/\s+/).filter(Boolean).map(termRegex);
  const items = cands.slice(m.scroll, m.scroll + N).map((c, i) => {
    const lab = String(label(c));
    return { label: lab, ann: annotate ? String(annotate(c) || '') : '', sel: i + m.scroll === m.index, marks: matchSpans(lab, terms) };
  });
  const pad = items.length && !truthy(L.get('vertico-resize')) ? Math.max(0, N - items.length) : 0;
  return { count: m.completer ? (cands.length ? (m.index + 1) + '/' + cands.length : '0') : null, prompt: m.prompt, flash: E.miniFlash || '', items, pad };
}
/* The echo area outside the minibuffer, for the page and display.ts: TEXT (a message, the isearch line, a key
   prompt, else Evil's state line), or WHICH when a prefix key is pending and its bindings are shown instead. */
function echoView(look: EdLook) {
  let text = E.echo || (E.depth === 0 ? look.stateEcho || '' : '');
  const prompting = E.prompt !== null && E.prompt !== undefined;
  if (E.isearch) { const s = E.isearch; text = `${s.failing ? 'Failing ' : ''}${s.wrapped ? 'Wrapped ' : ''}I-search${s.dir < 0 ? ' backward' : ''}: ${s.str}`; }
  else if (prompting) text = E.prompt!;
  return { text: String(text), which: !!look.prefixHelp && !E.isearch && !prompting };
}
/* The spans of S that any of the regexps TERMS match, sorted and merged: [[from, to), ...]. */
function matchSpans(s: string, terms: RegExp[]) {
  const spans: [number, number][] = [];
  for (const t of terms) {
    let re: RegExp; try { re = new RegExp(t.source, t.flags.includes('g') ? t.flags : t.flags + 'g'); } catch (e) { continue; }
    for (const x of s.matchAll(re)) if (x[0]) spans.push([x.index, x.index + x[0].length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const sp of spans) { const last = out[out.length - 1]; if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]); else out.push(sp); }
  return out;
}
/* Redisplay: every frame with page parts is drawn; a frame that is not selected is drawn only when
   what it shows changed since its last drawing. The selected frame is drawn last: the overlay hooks run
   for every frame drawn (with that frame current), and the ones that place the popups (corfu, snipe) on
   E.frame then leave them placed for the selected frame. */
function render() {
  const sel = E.frame, drawable = (f: EdFrame) => (f.root || f.backend) && f.wroot && f.sel;
  for (const f of E.frames) if (f !== sel && drawable(f)) renderFrame(f);
  if (sel && drawable(sel)) renderFrame(sel);
}
function frameKey(f: EdFrame) {
  let k = (f.mini ? 'm' : '') + f.echo + '|' + f.miniFlash + '|' + E.metricsGen + '|' + E.sizeGen + '|' + (hooks.statusKey ? hooks.statusKey() : '') + (f.backend ? '|' + f.focused + ':' + f.theme + ':' + JSON.stringify(f.backend.size()) : '');
  for (const w of leaves(f.wroot)) { const b = w.buffer; k += `|${w.id}:${b.id}:${b.ver}:${w.pt}:${w.start}:${b.presence ? b.presence.length + ':' + (b._presTick || 0) : ''}`; }
  return k;
}
function renderFrame(f: EdFrame) {
  if (f !== E.frame) { const k = frameKey(f); if (k === f._rkey) return; f._rkey = k; }
  /* A model frame (no page) is laid out and drawn by display.ts, which sets hooks.renderModel. */
  if (f.backend) { if (hooks.renderModel) withFrame(f, () => hooks.renderModel!(f)); return; }
  withFrame(f, () => renderOne(f));
}
function renderOne(f: EdFrame) {
  ensureWindowDom();
  const echo = $('echo') as EcEcho;
  echoMoved(echo);
  let look: EdLook = {};
  for (const w of windowList()) { const l = renderWindow(w); if (w === E.sel) look = l; }
  if (E.mini) {
    const v = miniView();
    const hl = (it: EdMiniView['items'][number]) => { let out = '', k = 0; for (const [a, z] of it.marks) { out += esc(it.label.slice(k, a)) + '<b>' + esc(it.label.slice(a, z)) + '</b>'; k = z; } return out + esc(it.label.slice(k)); };
    let rows = v.items.map(it => `<div class="cand${it.sel ? ' sel' : ''}"><span class="cl">${hl(it)}</span>${it.ann ? `<span class="ca">${esc(it.ann)}</span>` : ''}</div>`).join('');
    rows += '<div class="cand"> </div>'.repeat(v.pad);
    const count = v.count !== null ? `<span class="cc">${v.count}</span>` : '';
    setEcho(echo, `<div class="miniline">${count}<span class="prompt">${esc(v.prompt)}</span><span class="mb">${renderBuffer(E.minibuf, { active: E.focused, lines: false, cursorClass: 'bar' })}</span>` +
      (v.flash ? `<span class="flash">${esc(v.flash)}</span>` : '') + `</div>` + (rows ? `<div class="cands">${rows}</div>` : ''), true);
    echo.classList.add('active');
  } else {
    echo.classList.remove('active');
    const v = echoView(look);
    if (v.which) setEcho(echo, `<span class="wkp">${esc(look.showcmd || '')}-</span>${look.prefixHelp}`, true);
    else setEcho(echo, v.text, false);
  }
  f.root!.classList.toggle('unfocused', !f.focused);
  /* Display overlays (block-ref text, the popups) for this frame: F is current (withFrame) for the duration. */
  if (hooks.renderOverlay) hooks.renderOverlay(f);
  if (hooks.renderPresence) hooks.renderPresence(f);
}
/* The client rect of LEN characters at buffer position P in window W, from the drawn lines (null when
   the line is not drawn). Overlays (snipe, presence) place themselves with it. */
function rectAt(w: EdWindow, p: number, len: number) {
  const view = w.view!, t = w.buffer.rope, ls = bol(t, p);
  const ln = view.querySelector(`.ln[data-o="${ls}"]`);
  if (!ln) return null;
  let off = p - ls, startNode: Node | null = null, startOff = 0;
  const doc = ln.ownerDocument, walker = doc.createTreeWalker(ln, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const n = node.nodeValue!.length;
    if (!startNode) { if (off < n || (off === n && len === 0)) { startNode = node; startOff = off; off += len; } else { off -= n; continue; } }
    if (startNode && off <= n) { const r = doc.createRange(); r.setStart(startNode, startOff); r.setEnd(node, off); const rs = r.getClientRects(); return rs.length ? rs[0] : r.getBoundingClientRect(); }
    if (startNode) off -= n;
  }
  return null;
}

/* ---------- pointer: map a screen point to a buffer position ---------- */
function windowAt(x: number, y: number) {
  const f = FS() as Partial<EdFrame>; if (!f.root) return null;
  const el = f.root.ownerDocument.elementFromPoint(x, y);
  const we = el && el.closest ? el.closest('.win') : null;
  return we ? windowList().find(w => w.el === we) || null : null;
}
function posFromPoint(x: number, y: number, w?: EdWindow | null) {
  w = w || windowAt(x, y) || E.sel;
  if (!w || !w.view) return null;
  let node: Node, off: number;
  const doc = (FS() as EdFrame).root!.ownerDocument;
  if (doc.caretPositionFromPoint) { const r = doc.caretPositionFromPoint(x, y); if (!r) return null; node = r.offsetNode; off = r.offset; }
  else if (doc.caretRangeFromPoint) { const r = doc.caretRangeFromPoint(x, y); if (!r) return null; node = r.startContainer; off = r.startOffset; }
  else return null;
  const view = w.view, t = w.buffer.text;
  if (node === view) {
    for (const ln of view.querySelectorAll<HTMLElement>('.ln')) { const r = ln.getBoundingClientRect(); if (y >= r.top && y < r.bottom) return eol(t, +ln.dataset.o!); }
    return t.length;
  }
  const el = (node.nodeType === 3 ? node.parentElement : node) as HTMLElement;
  if (!view.contains(el)) return null;
  if (el.classList.contains('ln')) {
    const ls = +el.dataset.o!;
    if (off >= el.childNodes.length) return eol(t, ls);
    return posOfEl(el.childNodes[off] as HTMLElement, 0, t) ?? ls;
  }
  return posOfEl(el.closest<HTMLElement>('[data-o]'), node.nodeType === 3 ? off : 0, t);
}
function posOfEl(el: HTMLElement | null, off: number, t: string) {
  if (!el || !el.dataset) return null;
  if (el.classList.contains('ln')) return off ? eol(t, +el.dataset.o!) : +el.dataset.o!;
  const line = el.closest<HTMLElement>('.ln'), base = (line ? +line.dataset.o! : 0) + (+el.dataset.o!);
  if (el.classList.contains('cur')) return base + Math.min(off, +el.dataset.len!);
  if (el.classList.contains('eolsel')) return base;
  return Math.min(base + off, t.length);
}

/* The lexer's source, for the worker pool (pool.ts) to lex big buffers off the main thread. */
const LEX_SOURCE = `const C = ${JSON.stringify(C)}; const KEYWORDS = new Set(${JSON.stringify([...KEYWORDS])});
const isWS = ${isWS}; const isDelim = ${isDelim}; const inStr = ${inStr};
${lex}
${markDocstrings}
${forwardSexp}
${parenDepths}`;
globalThis.Ed = {
  E, hooks, host, Frame, FrameState, makeFrame, selectFrame, deleteFrame, onFrameEvent, frameEvent, frameScale, withFrame, allWindows, allMinibufs, renderFrame, rectAt, scheduleRender, FRAME_CSS,
  Marker, shiftMarkers, editText, applyOps, withOrigin, runHookSafely, removeHookEverywhere,
  localized, localize, makeLocal, localValue, defaultValue, setDefault, minorModes, minorOn, modeParents, modeChain, lighters, LEX_SOURCE, Store, Buffer, Keymap, PREFIX, C, SENTINEL, getBuffer, getBufferCreate, toBuffer, setWindowBuffer, otherBuffer, checkRO,
  insertText, deleteText, replaceText, spanOf, changedSince, installLex, metrics, lastMatch, bol, eol, lineNo, column, posAtColumn, lastLineStart, lineStartOf, lex, lexOf, markDocstrings,
  forwardSexp, backwardSexp, upList, matchParen, indentLine, lispIndentFor, isLisp, modeFor, MODE_NAMES,
  normKey, kbd, defineKey, lookupIn, lookupKey, lookupWith, activeMaps, whereIs, keyName, keyChar, selfInsertable, message, ding,
  reportError, errorText, quietQuit, QUIET, feedKey, unreadKeys, flushReplay, nextKey, readMini, exitMini, abortMini, completeMini, historyMove,
  miniCandidates, miniMove, miniInsert, markUsed, termRegex, histories, historyFor, prescient, annotateCommand, annotateFunction, annotateVariable, annotateBuffer, annotateFile, readKeySeq, readChar, commandNames, functionNames, variableNames, bufferNames, isCommand, prefixNumeric, specArgs,
  specCodes, callInteractively, undoStep, redoStep, snap, runCommand, dispatch, commandLoop, executeKeys, isearch, render, renderBuffer,
  posFromPoint, windowAt, lineHeight, whenIdle, frameRender, windowState, scrollStart, modelineFields, miniView, echoView, matchSpans, percent, foldsOf, onScroll, scrollWindow, lineIndex, lineNoB, lineStartB, lineCountB, foldAt, vLineNo, vLineStart, vLineCount, windowRows, ensureWindowDom, Window, Split, windowList, selectWindow, splitWindow, deleteWindow, deleteOtherWindows, winConfig, restoreWinConfig, saveWinConfig, windowFor, popToBuffer, leaves, get queueLength() { return queue.length; },
  runCallback,
} satisfies Partial<EdApi> as unknown as EdApi;
})();
