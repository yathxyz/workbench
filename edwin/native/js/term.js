/* The terminal half of desktop Edwin (DT1): a model frame's cell grid to escape sequences, and the bytes a
   terminal sends to Edwin key descriptions, mouse, paste, focus and query replies. It knows nothing of Ed:
   the native shell (host-native.js, main.js) wires it to a frame, and the tests drive it from Node.

   EdTerm.encoder({ color, defaultColors }) draws models:
     enter()        the setup string: alternate screen, no autowrap, mouse, bracketed paste, focus events,
                    the kitty keyboard protocol's "disambiguate" level, and the queries (background colour,
                    kitty flags, then device attributes as a fence)
     leave()        undoes enter(), the cursor shape and colour too
     draw(model)    the rows that changed since the last draw, then the cursor; one synchronized update
     invalidate()   forget what the screen holds (after a resize, a suspend, or anything that wrote to it)
     clipboard(s)   an OSC 52 copy;  title(s)  an OSC 2 title;  bell()  BEL
   color is 'truecolor', '256' or '16'; defaultColors draws the default face in the terminal's own colours.

   EdTerm.decoder() turns input into events: feed(text) gives the complete events in TEXT and keeps an
   unfinished escape sequence; pending() says one is kept; flush() gives it up as keys (a lone ESC after
   the escape timeout). Events: {type: 'key', key}, {type: 'paste', text}, {type: 'focus', focused},
   {type: 'mouse', action, x, y, button, shift, meta, ctrl, dy}, {type: 'reply', kind, value}. */
(function () {
'use strict';

/* ---------- colours ---------- */
const hexRgb = h => { const n = parseInt(h.slice(1, 7), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const CUBE = [0, 95, 135, 175, 215, 255];
const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
/* The nearest colour of the xterm 256 palette: the 6x6x6 cube or the grey ramp, whichever is closer. */
function to256(rgb) {
  const ci = v => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
  const c = rgb.map(ci), cube = c.map(i => CUBE[i]);
  const avg = Math.round((rgb[0] + rgb[1] + rgb[2]) / 3), gi = avg > 238 ? 23 : Math.max(0, Math.round((avg - 8) / 10)), gv = 8 + gi * 10;
  return d2(rgb, [gv, gv, gv]) < d2(rgb, cube) ? 232 + gi : 16 + 36 * c[0] + 6 * c[1] + c[2];
}
/* The 16 ANSI colours as xterm draws them. */
const ANSI = [[0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]];
function to16(rgb) { let best = 0, bd = Infinity; ANSI.forEach((a, i) => { const d = d2(rgb, a); if (d < bd) { bd = d; best = i; } }); return best; }
function colorSgr(hex, bg, mode) {
  const rgb = hexRgb(hex);
  if (mode === 'truecolor') return `${bg ? 48 : 38};2;${rgb[0]};${rgb[1]};${rgb[2]}`;
  if (mode === '256') return `${bg ? 48 : 38};5;${to256(rgb)}`;
  const i = to16(rgb);
  return String((bg ? 40 : 30) + (i & 7) + (i > 7 ? 60 : 0));
}
/* The colour depth a terminal declares: COLORTERM truecolor/24bit, a TERM naming direct colour or one of the
   terminals known to draw it, else 256 for a *-256color TERM, else 16. */
function colorMode(env) {
  const ct = (env.COLORTERM || '').toLowerCase(), term = (env.TERM || '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit' || /direct|truecolor/.test(term) || /^(xterm-kitty|alacritty|foot|wezterm|xterm-ghostty|contour)/.test(term)) return 'truecolor';
  if (/256/.test(term) || env.TERM_PROGRAM) return '256';
  return '16';
}

/* ---------- output ---------- */
const ESC = '\x1b', CSI = '\x1b[', OSC = '\x1b]', ST = '\x1b\\';
/* DECSCUSR shapes, steady: block 2, underline 4, bar 6. A terminal draws an unfocused cursor hollow itself. */
const SHAPE = { box: 2, hollow: 2, half: 4, hbar: 4, bar: 6 };
function b64(s) {
  /* UTF-8, then base64: OSC 52 carries bytes. */
  const bytes = [];
  for (const ch of s) {
    let c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | c >> 6, 0x80 | c & 63);
    else if (c < 0x10000) bytes.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
    else bytes.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
  }
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = bytes[i] << 16 | (bytes[i + 1] ?? 0) << 8 | (bytes[i + 2] ?? 0);
    out += A[n >> 18 & 63] + A[n >> 12 & 63] + (i + 1 < bytes.length ? A[n >> 6 & 63] : '=') + (i + 2 < bytes.length ? A[n & 63] : '=');
  }
  return out;
}
/* Text a terminal may draw at another width than display.js counted (wide, combining or emoji characters):
   after a segment holding any, the next one is placed with an explicit cursor move. */
const RISKY = /[^\x20-\x7e -˿Ͱ-῿‐-‧‰-⁞←-⏿─-◿]/;
const SAFE_TEXT = s => s.replace(/[\x00-\x1f\x7f-\x9f]/g, '?');

function encoder(opts = {}) {
  const mode = opts.color || 'truecolor';
  let screen = [], size = null, cursorShape = null, cursorColor = null, defaultColors = !!opts.defaultColors;
  function faceSgr(fc, base) {
    let s = '0';
    if (fc.bold || fc.weight >= 600) s += ';1';
    if (fc.italic) s += ';3';
    if (fc.underline || fc.box) s += ';4';
    if (fc.strike) s += ';9';
    s += ';' + (defaultColors && fc.fg === base.fg ? '39' : colorSgr(fc.fg, false, mode));
    s += ';' + (defaultColors && fc.bg === base.bg ? '49' : colorSgr(fc.bg, true, mode));
    return CSI + s + 'm';
  }
  return {
    get color() { return mode; },
    set defaultColors(v) { defaultColors = !!v; screen = []; },
    get defaultColors() { return defaultColors; },
    enter() {
      return CSI + '?1049h' + CSI + '?7l' + CSI + '?1000h' + CSI + '?1002h' + CSI + '?1006h' + CSI + '?2004h' + CSI + '?1004h' +
        CSI + '>1u' + CSI + '?25l' + CSI + '2J' + OSC + '11;?' + ST + CSI + '?u' + CSI + 'c';
    },
    leave() {
      screen = []; size = null; cursorShape = null;
      const color = cursorColor !== null ? OSC + '112' + ST : '';
      cursorColor = null;
      return CSI + '<u' + CSI + '?1004l' + CSI + '?2004l' + CSI + '?1006l' + CSI + '?1002l' + CSI + '?1000l' + CSI + '0 q' + color +
        CSI + '0m' + CSI + '?7h' + CSI + '?25h' + CSI + '?1049l';
    },
    invalidate() { screen = []; size = null; cursorShape = null; cursorColor = null; },
    draw(m) {
      let out = CSI + '?2026h' + CSI + '?25l';
      if (!size || size[0] !== m.cols || size[1] !== m.rows) { out += CSI + '0m' + CSI + '2J'; screen = []; size = [m.cols, m.rows]; }
      const base = m.faces[0], sgr = m.faces.map(fc => faceSgr(fc, base));
      for (let y = 0; y < m.rows; y++) {
        const segs = m.lines[y] || [];
        let row = '', risky = false;
        for (const s of segs) {
          if (risky) row += CSI + (y + 1) + ';' + (s.x + 1) + 'H';
          row += sgr[s.f] + SAFE_TEXT(s.text);
          risky = RISKY.test(s.text);
        }
        if (screen[y] === row) continue;
        screen[y] = row;
        out += CSI + (y + 1) + ';1H' + row;
      }
      out += CSI + '0m';
      const c = m.cursor;
      if (c) {
        const shape = SHAPE[c.shape] || 2;
        if (shape !== cursorShape) { out += CSI + shape + ' q'; cursorShape = shape; }
        if (c.color && c.color !== cursorColor && /^#[0-9a-f]{6}$/i.test(c.color)) { out += OSC + '12;' + c.color + ST; cursorColor = c.color; }
        out += CSI + (c.y + 1) + ';' + (c.x + 1) + 'H' + CSI + '?25h';
      }
      return out + CSI + '?2026l';
    },
    clipboard(s) { return OSC + '52;c;' + b64(s) + ST; },
    title(s) { return OSC + '2;' + SAFE_TEXT(String(s)).slice(0, 200) + ST; },
    bell() { return '\x07'; },
  };
}

/* ---------- input ---------- */
const TILDE = { 1: '<home>', 2: '<insert>', 3: '<deletechar>', 4: '<end>', 5: '<prior>', 6: '<next>', 7: '<home>', 8: '<end>',
  11: '<f1>', 12: '<f2>', 13: '<f3>', 14: '<f4>', 15: '<f5>', 17: '<f6>', 18: '<f7>', 19: '<f8>', 20: '<f9>', 21: '<f10>', 23: '<f11>', 24: '<f12>' };
const LETTER = { A: '<up>', B: '<down>', C: '<right>', D: '<left>', H: '<home>', F: '<end>', P: '<f1>', Q: '<f2>', R: '<f3>', S: '<f4>' };
/* Kitty's functional keys (CSI u) that have a name in Edwin; the keypad sends its plain keys. */
const KITTY = { 9: 'TAB', 13: 'RET', 27: 'ESC', 127: 'DEL', 57399: '0', 57400: '1', 57401: '2', 57402: '3', 57403: '4', 57404: '5', 57405: '6',
  57406: '7', 57407: '8', 57408: '9', 57409: '.', 57410: '/', 57411: '*', 57412: '-', 57413: '+', 57414: 'RET', 57415: '=',
  57417: '<left>', 57418: '<right>', 57419: '<up>', 57420: '<down>', 57421: '<prior>', 57422: '<next>', 57423: '<home>', 57424: '<end>', 57425: '<insert>', 57426: '<deletechar>' };
const MODIFIER_ONLY = c => c >= 57441 && c <= 57452;   // shift, ctrl, alt, super... pressed alone
/* A key name with modifiers, in the core's order (C- M- S-). S- is kept for named keys only, as keyName does. */
function withMods(base, mods) {
  const shift = mods & 1, meta = mods & 2, ctrl = mods & 4;
  let b = base;
  if (b.length === 1 && /[a-zA-Z]/.test(b)) { if (ctrl) b = b.toLowerCase(); else if (shift) b = b.toUpperCase(); }
  if (b === ' ') b = 'SPC';
  const named = b.length > 1 && (b[0] === '<' || b === 'TAB');
  if (b === 'TAB' && shift && !ctrl && !meta) return 'S-TAB';
  return (ctrl ? 'C-' : '') + (meta ? 'M-' : '') + (shift && named ? 'S-' : '') + b;
}
/* One character typed without an escape sequence. */
function plainKey(ch) {
  const c = ch.codePointAt(0);
  if (c === 13) return 'RET';
  if (c === 9) return 'TAB';
  if (c === 127) return 'DEL';
  if (c === 0) return 'C-@';
  if (c === 8) return 'C-h';
  if (c === 27) return 'ESC';
  if (c < 27) return 'C-' + String.fromCharCode(96 + c);
  if (c < 32) return 'C-' + '\\]^_'[c - 28];
  if (c === 32) return 'SPC';
  return ch;
}

function decoder() {
  let buf = '', paste = null;
  /* The length of a complete sequence at buf[i] (ESC there), or 0 while it is unfinished. */
  function seqEnd(i) {
    const n = buf[i + 1];
    if (n === undefined) return 0;
    if (n === '[') {
      for (let j = i + 2; j < buf.length; j++) { const c = buf.charCodeAt(j); if (c >= 0x40 && c <= 0x7e) return j + 1 - i; if (c < 0x20 || c > 0x7e) return j - i; }
      return 0;
    }
    if (n === 'O') return buf.length > i + 2 ? 3 : 0;
    if (n === ']' || n === 'P' || n === '_') {
      for (let j = i + 2; j < buf.length; j++) { if (buf[j] === '\x07') return j + 1 - i; if (buf[j] === '\x1b' && buf[j + 1] === '\\') return j + 2 - i; if (buf[j] === '\x1b' && j + 1 < buf.length) return j - i; }
      return 0;
    }
    /* ESC and one character: Meta. */
    const cp = buf.codePointAt(i + 1);
    return 1 + (cp > 0xffff ? 2 : 1);
  }
  function csi(body, out) {
    const final = body[body.length - 1], params = body.slice(0, -1);
    if (params[0] === '<' && (final === 'M' || final === 'm')) {
      const [b, x, y] = params.slice(1).split(';').map(Number);
      const ev = { type: 'mouse', x: x - 1, y: y - 1, button: b & 3, shift: !!(b & 4), meta: !!(b & 8), ctrl: !!(b & 16) };
      if (b & 64) { if ((b & 3) < 2) out.push({ ...ev, action: 'wheel', button: 0, dy: (b & 1) ? 1 : -1 }); return; }
      out.push({ ...ev, action: final === 'm' ? 'up' : (b & 32) ? 'drag' : 'down' });
      return;
    }
    if (params[0] === '?') {
      if (final === 'u') out.push({ type: 'reply', kind: 'kitty', value: Number(params.slice(1)) || 0 });
      else if (final === 'c') out.push({ type: 'reply', kind: 'da1', value: params.slice(1) });
      return;
    }
    if (final === 'I' && !params) { out.push({ type: 'focus', focused: true }); return; }
    if (final === 'O' && !params) { out.push({ type: 'focus', focused: false }); return; }
    const ps = params.split(';'), mods = ps[1] ? Math.max(0, (Number(ps[1].split(':')[0]) || 1) - 1) : 0;
    if (final === '~') {
      const n = Number(ps[0]);
      if (n === 200) { paste = ''; return; }
      if (n === 27 && ps.length >= 3) { const k = Number(ps[2]), m = Math.max(0, Number(ps[1]) - 1); out.push({ type: 'key', key: withMods(KITTY[k] || String.fromCodePoint(k), m) }); return; }
      if (TILDE[n]) out.push({ type: 'key', key: withMods(TILDE[n], mods) });
      return;
    }
    if (final === 'u') {
      const code = Number(ps[0].split(':')[0]);
      if (!code || MODIFIER_ONLY(code)) return;
      const base = KITTY[code] || (code >= 0xe000 && code <= 0xf8ff ? null : String.fromCodePoint(code));
      if (base) out.push({ type: 'key', key: withMods(base, mods) });
      return;
    }
    if (final === 'Z') { out.push({ type: 'key', key: 'S-TAB' }); return; }
    if (LETTER[final]) out.push({ type: 'key', key: withMods(LETTER[final], mods) });
  }
  function osc(body, out) {
    const m = /^11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(body);
    if (m) {
      const v = m.slice(1).map(h => Math.round(parseInt(h, 16) / (16 ** h.length - 1) * 255));
      out.push({ type: 'reply', kind: 'background', value: '#' + v.map(x => x.toString(16).padStart(2, '0')).join('') });
    }
  }
  function take(out, flushing) {
    let i = 0;
    while (i < buf.length) {
      if (paste !== null) {
        const end = buf.indexOf('\x1b[201~', i);
        if (end < 0) {
          /* Keep a tail that may be the start of the end marker. */
          let keep = 0;
          for (let k = Math.min(5, buf.length - i); k > 0; k--) if ('\x1b[201~'.startsWith(buf.slice(buf.length - k))) { keep = k; break; }
          paste += buf.slice(i, buf.length - keep); i = buf.length - keep;
          break;
        }
        paste += buf.slice(i, end); i = end + 6;
        out.push({ type: 'paste', text: paste.replace(/\r\n?/g, '\n') }); paste = null;
        continue;
      }
      const ch = buf[i];
      if (ch !== '\x1b') { const cp = buf.codePointAt(i), s = String.fromCodePoint(cp); out.push({ type: 'key', key: plainKey(s) }); i += s.length; continue; }
      const len = seqEnd(i);
      if (!len) { if (!flushing) break; out.push({ type: 'key', key: 'ESC' }); i++; continue; }
      const n = buf[i + 1];
      if (n === '[') csi(buf.slice(i + 2, i + len), out);
      else if (n === 'O') { const f = buf[i + 2]; if (LETTER[f]) out.push({ type: 'key', key: LETTER[f] }); else if (f === 'M') out.push({ type: 'key', key: 'RET' }); else out.push({ type: 'key', key: 'M-O' }, ...(f ? [{ type: 'key', key: plainKey(f) }] : [])); }
      else if (n === ']') osc(buf.slice(i + 2, i + len).replace(/(\x07|\x1b\\?)$/, ''), out);
      else if (n === 'P' || n === '_') { /* DCS and APC replies: nothing Edwin reads */ }
      else if (n === '\x1b') { out.push({ type: 'key', key: 'ESC' }); i++; continue; }
      else { const k = plainKey(buf.slice(i + 1, i + len)); out.push({ type: 'key', key: k.startsWith('C-') ? 'C-M-' + k.slice(2) : 'M-' + k }); }
      i += len;
    }
    buf = buf.slice(i);
    return out;
  }
  return {
    feed(text) { buf += text; return take([], false); },
    pending() { return buf.length > 0 && paste === null; },
    flush() { return take([], true); },
  };
}

const EdTerm = { encoder, decoder, colorMode, to256, to16, b64 };
if (typeof module === 'object' && module.exports) module.exports = EdTerm;
globalThis.EdTerm = EdTerm;
})();
