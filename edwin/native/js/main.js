/* edwin, the program: Edwin in a terminal (DT1), as a Vim or Emacs would run, and a usable $EDITOR; or in a
   window of its own (DT2, --gui).

     edwin [-nw | -g] [-R] [--standalone | --socket PATH] [+LINE] [FILE | -]...

   The core runs as a model frame (display.js) drawn by term.js, or by the window (gui.js and the Rust side's
   gui/, which opened it before this file runs: N.guiSize() says so). Files are read and written directly
   (host-native.js); when an edwind answers on its socket, the notes under its notes directory are opened
   through it instead, shared with the browser's frames. The process ends with the status the user asked
   for: :q, :wq, ZZ and C-x C-c give 0, :cq gives 1 (or its argument), so git commit and sudoedit can tell
   an abort. C-z suspends to the shell; fg resumes (in the window, C-z iconifies it). */
(function () {
'use strict';
const N = globalThis.__n, H = globalThis.EdNativeHost, T = globalThis.EdTerm;
const VERSION = 'edwin DT2';
const USAGE = `Usage: edwin [OPTION]... [+LINE] [FILE]...
Edit FILEs in Edwin, in this terminal or in a window.

  -nw, --no-window   use this terminal (the default)
  -g, --gui          open a window (EDWIN_FONT="Family 11" sets its font)
  --geometry=COLSxROWS  the window's first size in characters (100x36)
  -R, --read-only    visit the files read-only
  --standalone       never attach to edwind
  --socket PATH      attach to the edwind listening on PATH
  --daemon           start your own edwind in the background (--fg-daemon: in the foreground); each edwin
                     then attaches to it, as emacsclient does to emacs --daemon
  +LINE, +           start on line LINE of the first file (+ alone: its last line)
  -                  edit what arrives on standard input
  -h, --help         show this text;  --version  show the version

Leave with :q (or :wq, ZZ, C-x C-c); :cq leaves with exit status 1.
C-z suspends to the shell. Your init file is ~/.config/edwin/init.scm.
`;
const ESC_MS = Number(N.env('EDWIN_ESC_MS')) || 25;     // how long a lone ESC waits for the rest of a sequence
const FENCE_MS = 60;                                     // how long the first draw waits for the terminal's replies
const DRAIN_MS = 5000;                                   // how long quitting waits for edwind to confirm edits
/* EDWIN_TRACE=1 logs how long each startup step took (in the log file, as console does). */
const trace = N.env('EDWIN_TRACE') ? (what => console.log(`startup ${what} ${N.now().toFixed(1)} ms`)) : () => {};
trace('main');

function parseArgs(argv) {
  const o = { files: [], line: null, readOnly: false, standalone: false, socket: null, stdin: false, help: false, version: false };
  let opts = true;
  for (const a of argv) {
    if (opts && a === '--') { opts = false; continue; }
    if (opts && (a === '-h' || a === '--help')) o.help = true;
    else if (opts && a === '--version') o.version = true;
    else if (opts && (a === '-nw' || a === '--no-window' || a === '-t' || a === '-g' || a === '--gui')) { /* main.rs chose */ }
    else if (opts && /^--geometry=\d+x\d+$/.test(a)) { /* main.rs sized the window */ }
    else if (opts && (a === '-R' || a === '--read-only')) o.readOnly = true;
    else if (opts && a === '--standalone') o.standalone = true;
    else if (opts && a.startsWith('--socket=')) o.socket = a.slice(9);
    else if (opts && a === '--socket') o.socket = '';
    else if (o.socket === '') o.socket = a;
    else if (opts && a === '-') o.stdin = true;
    else if (opts && /^\+\d*$/.test(a)) o.line = a === '+' ? Infinity : Number(a.slice(1));
    else if (opts && a.startsWith('-') && a.length > 1) throw new Error(`unknown option ${a} (edwin --help lists them)`);
    else o.files.push(a);
  }
  if (o.socket === '') throw new Error('--socket needs a path');
  return o;
}

let opts;
try { opts = parseArgs(N.args()); } catch (e) { N.eprint('edwin: ' + e.message + '\n'); N.exit(2); return; }
if (opts.help) { N.print(USAGE); N.exit(0); return; }
if (opts.version) { N.print(VERSION + '\n'); N.exit(0); return; }

/* Standard input as a buffer (edwin -), read before the terminal is taken. */
const stdinText = opts.stdin ? N.readStdin() : null;
/* The window main.rs opened (edwin --gui), else the terminal. */
const gui = N.guiSize() !== null;
if (gui) N.load('native/gui');
if (!gui && !N.ttyOpen()) { N.eprint('edwin: no terminal to draw on (/dev/tty)\n'); N.exit(1); return; }
const screen = gui ? globalThis.EdGui.screen() : null;

/* ---------- the terminal ---------- */
const envOf = k => H.env(k) || '';
const enc = gui ? null : T.encoder({ color: envOf('EDWIN_COLOR') || T.colorMode({ COLORTERM: envOf('COLORTERM'), TERM: envOf('TERM'), TERM_PROGRAM: envOf('TERM_PROGRAM') }), defaultColors: envOf('EDWIN_DEFAULT_COLORS') === '1' });
const dec = gui ? null : T.decoder();
const out = gui ? () => {} : s => N.ttyWrite(s);
let size = gui ? null : N.ttySize();
const backend = gui ? screen.backend : {
  tty: true,
  size: () => ({ cols: Math.max(8, size[0]), rows: Math.max(3, size[1]) }),
  draw: m => out(enc.draw(m)),
  bell: () => out(enc.bell()),
};
/* The theme: EDWIN_THEME, else the background colour the terminal reports (the desktop's, in the window), else
   COLORFGBG, else dark. */
const forced = /^(dark|light)$/.test(envOf('EDWIN_THEME')) ? envOf('EDWIN_THEME') : null;
const fgbg = /;(\d+)$/.exec(envOf('COLORFGBG'));
let theme = forced || (gui && screen.theme()) || (fgbg ? (Number(fgbg[1]) === 7 || Number(fgbg[1]) >= 9 ? 'light' : 'dark') : 'dark');
/* The first draw waits briefly for the terminal's replies (its background colour); a window has none. */
let fenceDone = null;
const fence = new Promise(r => { fenceDone = r; setTimeout(r, gui ? 0 : FENCE_MS); });
if (!gui) { out(enc.enter()); N.ttyFlush(); }

function edwindSocket() {
  if (N.env('EDWIN_NO_ATTACH')) return null;
  if (opts.standalone) return null;
  const user = envOf('XDG_RUNTIME_DIR') ? envOf('XDG_RUNTIME_DIR') + '/edwin/edit.sock' : '';   // edwin --daemon's
  const cands = opts.socket ? [opts.socket] : [envOf('EDWIN_SOCKET'), user, '/run/workbench-edit/edit.sock'].filter(Boolean);
  for (const p of cands) {
    try { const id = N.sockOpen(p); N.sockClose(id); return p; } catch (e) { if (opts.socket) throw new Error(`cannot attach to edwind at ${p}: ${e.message}`); }
  }
  return null;
}

/* ---------- the core: in the startup snapshot already (boot.js), or loaded now ---------- */
let sock = null;
try { sock = edwindSocket(); } catch (e) { if (!gui) { out(enc.leave()); N.ttyFlush(); N.ttyClose(); } N.eprint('edwin: ' + e.message + '\n'); N.exit(1); return; }
/* The shell restores the snapshot only when no edwind answered; one that answers since is not used. */
if (!globalThis.EdBooted) { globalThis.EdBootAttach = !!sock; N.load('native/boot'); trace('core loaded'); }
else sock = null;
const host = globalThis.EdHost;
host.init();
globalThis.__native.thaw();
host.onClipboard = gui ? s => screen.clipboard(s) : s => { if (s.length <= 100000 && envOf('EDWIN_OSC52') !== '0') out(enc.clipboard(s)); };
const Ed = globalThis.Ed, L = globalThis.L, E = Ed.E;

let frame = null, quitting = false, escTimer = null;
function leaveTerminal() { if (gui) return; out(enc.leave()); N.ttyFlush(); N.ttyClose(); }
/* End the program: storage flushed, the terminal given back, then exit with CODE. */
async function quit(code) {
  if (quitting) return;
  quitting = true;
  if (attached) await drain();
  try { host.suspend(); } catch (e) { console.error(e); }
  leaveTerminal();
  if (attached && attached.unconfirmed) N.eprint(`edwin: edwind had not confirmed ${attached.unconfirmed} edit(s) when edwin quit\n`);
  if (attached) for (const b of Ed.sync.buffers.values()) if (b.saveError) N.eprint(`edwin: ${b.name} was not saved: ${b.saveError}\n`);
  N.exit(code);
}
Ed.hooks.killEmacs = code => { quit(code); };
Ed.hooks.suspendFrame = () => {
  try { host.suspend(); } catch (e) { console.error(e); }
  if (gui) { screen.iconify(); return; }
  out(enc.leave()); N.ttyFlush();
  N.suspend();              // returns once the shell has resumed us (SIGCONT)
  resumed();
};
function resumed() {
  size = N.ttySize();
  enc.invalidate(); out(enc.enter()); N.ttyFlush();
  if (frame) Ed.display.input(frame, { type: 'resize' });
}

/* Modified files when the terminal hangs up or edwin is killed: copied into the state directory's rescue/,
   since nobody can be asked any more. */
function rescue() {
  const dir = H.join(host.dirs.state, 'rescue'), stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try { N.mkdirs(dir); } catch (e) { return; }
  for (const b of E.buffers) {
    if (!b.file || !b.modified || b.shared) continue;
    const name = H.resolve(b.file).replace(/\//g, '%');
    try { N.writeFile(H.join(dir, `${name}.${stamp}`), b.text); } catch (e) { console.error('rescue: ' + e.message); }
  }
}

/* ---------- input ---------- */
function dispatch(evs) {
  for (const ev of evs) {
    if (ev.type === 'reply') {
      if (ev.kind === 'background' && !forced) {
        const [r, g, b] = [1, 3, 5].map(i => parseInt(ev.value.slice(i, i + 2), 16));
        const t = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? 'dark' : 'light';
        if (t !== theme) { theme = t; if (frame) Ed.display.setTheme(frame, theme); }
      } else if (ev.kind === 'da1') fenceDone();
      continue;
    }
    if (frame) Ed.display.input(frame, ev);
  }
}
globalThis.__native.handlers.input = s => {
  if (escTimer !== null) { clearTimeout(escTimer); escTimer = null; }
  dispatch(dec.feed(s));
  if (dec.pending()) escTimer = setTimeout(() => { escTimer = null; dispatch(dec.flush()); }, ESC_MS);
};
/* The window's events (keys, text, mouse, focus, resize, its close button, dropped files). */
globalThis.__native.handlers.gui = json => {
  if (!frame) return;
  globalThis.EdGui.handle(json, frame, {
    close: () => Ed.display.input(frame, { type: 'key', key: '<cmd:save-buffers-kill-terminal>' }),
    drop: path => { Promise.resolve(Ed.visit(path)).then(() => Ed.render(), e => { Ed.message(Ed.errorText(e)); Ed.render(); }); },
  });
};
globalThis.__native.handlers.signal = name => {
  if (gui && (name === 'WINCH' || name === 'TSTP' || name === 'CONT')) return;
  if (name === 'WINCH') { size = N.ttySize(); if (frame) Ed.display.input(frame, { type: 'resize' }); }
  else if (name === 'TSTP') Ed.hooks.suspendFrame();
  else if (name === 'CONT') resumed();
  else if (name === 'HUP' || name === 'TERM' || name === 'INT' || name === 'QUIT') {
    rescue();
    try { host.suspend(); } catch (e) { /* best effort */ }
    if (name !== 'HUP') leaveTerminal();
    N.exit(name === 'HUP' ? 1 : 128 + ({ INT: 2, QUIT: 3, TERM: 15 })[name]);
  }
};

/* ---------- edwind: attach when one answers ---------- */
let attached = null;
const sockets = new Map();
globalThis.__native.handlers.sock = (id, line) => {
  const ws = sockets.get(id);
  if (!ws) return;
  if (line === null) { sockets.delete(id); if (ws.onclose) ws.onclose({ code: 1006 }); }
  else if (ws.onmessage) ws.onmessage({ data: line });
};
/* A WebSocket-shaped transport over edwind's Unix socket (one JSON message per line), as sync.js wants. */
const transport = path => () => {
  const ws = { onopen: null, onmessage: null, onclose: null, onerror: null, readyState: 0 };
  let id;
  try { id = N.sockOpen(path); } catch (e) { setTimeout(() => { if (ws.onerror) ws.onerror(e); if (ws.onclose) ws.onclose({ code: 1006 }); }, 0); return ws; }
  sockets.set(id, ws);
  ws.send = s => N.sockSend(id, s);
  ws.close = () => { sockets.delete(id); N.sockClose(id); ws.readyState = 3; };
  setTimeout(() => { ws.readyState = 1; if (ws.onopen) ws.onopen(); }, 0);
  return ws;
};
/* Before quitting attached: wait until edwind has acknowledged every edit and answered every call. */
function drain() {
  const sync = Ed.sync;
  const busy = () => [...sync.buffers.values()].reduce((n, b) => n + (b.inflight ? 1 : 0) + (b.queue ? b.queue.length : 0), 0) + sync.calls.size;
  return new Promise(resolve => {
    const t0 = N.now();
    const check = () => {
      const n = busy();
      if (!n || sync.state !== 'online' || N.now() - t0 > DRAIN_MS) { attached.unconfirmed = n; resolve(); }
      else setTimeout(check, 10);
    };
    check();
  });
}

/* ---------- start ---------- */
function lineMessage(b) {
  const n = b.rope.length ? Ed.lineCountB(b) : 0;
  return `"${Ed.fileLabel(b.file)}" ${n}L, ${b.rope.length}C${b.readOnly ? ' [readonly]' : ''}`;
}
async function start() {
  Ed.reloadPersistent();
  L.set('load-path', L.listOf(host.loadPath));
  if (sock) {
    await Ed.bootServed({ transport: transport(sock), device: gui ? 'window' : 'terminal' });
    attached = { socket: sock, unconfirmed: 0 };
    const served = Ed.hooks.visit, dir = String(L.get('notes-directory') || '');
    /* Compared by true name, so ./notes/a.md, a link into the notes and a linked notes directory all count. */
    const root = dir ? H.truename(dir).replace(/\/$/, '') : '';
    /* Notes go through edwind; every other file is this program's own. */
    const hook = name => {
      const abs = H.truename(name);
      /* edwind names a note by its path under the notes directory. */
      if (root && abs.startsWith(root + '/')) return served(abs.slice(root.length + 1));
      Ed.hooks.visit = null;
      try { return Ed.visit(name); } finally { Ed.hooks.visit = hook; }
    };
    Ed.hooks.visit = hook;
  } else {
    Ed.loadUserInit();
  }
  trace('booted');
  let first = null;
  if (stdinText !== null) {
    const b = Ed.getBufferCreate('*stdin*'); b.text = stdinText; b.pt = 0; b.modified = false; Ed.setWindowBuffer(b); first = b;
  }
  const visited = [], fresh = new Set(), failed = [];
  for (const f of opts.files.slice().reverse()) {
    try {
      const isNew = N.stat(H.resolve(f)) === null;
      const b = await Ed.visit(f);
      if (b) { if (opts.readOnly) b.readOnly = true; visited.unshift(b); if (isNew) fresh.add(b); }
    } catch (e) { failed.push(Ed.errorText(e)); }
  }
  first = visited[0] || first;
  if (first) { Ed.setWindowBuffer(first); E.current = first; }
  trace('visited');
  await fence;
  trace('fence');
  frame = Ed.makeFrame(null, { backend, kind: 'console', theme, buffer: first || undefined });
  frame.focused = true;
  if (first && opts.line !== null) {
    const n = opts.line === Infinity ? Ed.lineCountB(first) : opts.line;
    first.pt = Ed.lineStartB(first, Math.min(n, Ed.lineCountB(first)));
    frame.sel.pt = first.pt;
  }
  /* Said once the frame is there: the echo area belongs to a frame. */
  if (failed.length) Ed.message(failed.join('; '));
  else if (first && first.file) Ed.message(fresh.has(first) ? `"${Ed.fileLabel(first.file)}" [New]` : lineMessage(first));
  Ed.render();
  if (N.env('EDWIN_TRACE')) setTimeout(() => trace('first draw'), 0);
}
start().catch(e => { console.error(e); leaveTerminal(); N.eprint('edwin: ' + (e && e.stack || e) + '\n'); N.exit(70); });
})();
