/* The window (DT2): what main.js uses instead of the terminal when edwin runs with --gui.

   The frame is the same model frame (display.js); its backend hands each model to the window (__n.guiDraw,
   drawn by edwin/native/src/gui). The window's events come back as JSON (__native.gui): keys arrive as the
   browser's keydown does, key and code and modifiers, and are named by the core's own Ed.keyName, so a key means
   in the window what it means on the page; text from an input method arrives whole; mouse, focus, paste and
   resize are display.js's input events already. */
(function () {
'use strict';
const N = globalThis.__n;

/* Each segment's character widths as display.js counts them (charWidth), so the window lays characters out as the
   model did; a segment of characters below U+0300 needs none (each takes one cell). */
const NARROW = /^[\u0000-\u02ff]*$/;
function withWidths(m) {
  const cw = globalThis.Ed.display.charWidth;
  for (const row of m.lines || []) for (const s of row) if (!NARROW.test(s.text)) s.cw = Array.from(s.text, ch => cw(ch.codePointAt(0)));
  return m;
}

function screen() {
  return {
    backend: {
      tty: false, gui: true,
      size: () => { const s = N.guiSize(); return s ? { cols: Math.max(8, s.cols), rows: Math.max(3, s.rows) } : { cols: 80, rows: 24 }; },
      draw: m => N.guiDraw(JSON.stringify(withWidths(m))),
      bell: () => N.guiAction('bell'),
    },
    theme: () => { const s = N.guiSize(); return s && s.theme ? s.theme : null; },
    clipboard: s => N.guiAction('clipboard', s),
    iconify: () => N.guiAction('iconify'),
  };
}

/* A keydown as the page's frame gets it, for Ed.keyName. altGraph: the window found that Control and Alt made the
   character (AltGr on Windows-style layouts), so the key is the character, as on the page. */
const keydown = ev => ({
  key: String(ev.key), code: String(ev.code || ''), isComposing: false,
  ctrlKey: !!ev.ctrlKey, altKey: !!ev.altKey, shiftKey: !!ev.shiftKey, metaKey: !!ev.metaKey,
  getModifierState: m => m === 'AltGraph' && !!ev.altGraph,
});
const charKey = ch => (ch === ' ' ? 'SPC' : ch === '\n' || ch === '\r' ? 'RET' : ch === '\t' ? 'TAB' : ch);

/* One event from the window (JSON) for FRAME. ON holds what the program decides: close (the window's close
   button) and drop (a file dropped on the window). */
function handle(json, frame, on) {
  let ev;
  try { ev = JSON.parse(json); } catch (e) { return; }
  const Ed = globalThis.Ed, D = Ed.display;
  switch (ev.type) {
    case 'key': { const k = Ed.keyName(keydown(ev)); if (k) D.input(frame, { type: 'key', key: k }); return; }
    case 'text': for (const ch of String(ev.text || '')) D.input(frame, { type: 'key', key: charKey(ch) }); return;
    case 'close': on.close(); return;
    case 'drop': on.drop(String(ev.path)); return;
    default: D.input(frame, ev);
  }
}

globalThis.EdGui = { screen, handle, keydown, withWidths };
if (typeof module !== 'undefined') module.exports = globalThis.EdGui;
})();
