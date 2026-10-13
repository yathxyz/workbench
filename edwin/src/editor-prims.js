/* Lmacs primitives: the editor as seen from Lisp, plus the built-in commands and startup. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E;
const { intern, NIL, signal, pr, arr, listOf, truthy, Sym } = L;
const bool = b => !!b, T = true;
const host = Ed.host;

const cur = () => E.current;
const num = x => { if (typeof x !== 'number') signal('wrong-type-argument', 'expected an integer, got', x); return Math.trunc(x); };
const str = x => { if (typeof x !== 'string') signal('wrong-type-argument', 'expected a string, got', x); return x; };
const optNum = (x, d) => L.absent(x) ? d : num(x);
const clampPos = (b, p) => Math.max(0, Math.min(b.rope.length, p));
function pos(b, x) { const p = num(x) - 1; if (p < 0 || p > b.rope.length) signal('args-out-of-range', x); return p; }
function region(b, s, e) { let a = pos(b, s), z = pos(b, e); return a <= z ? [a, z] : [z, a]; }

/* D: plain function.  CMD: interactive command (spec is a string, a JS async function, or '' for none). */
const { D, CMD, alias } = L;
const getter = L.magic;

/* ---------- variables that reflect editor state ---------- */
getter('kill-ring', () => listOf(E.killRing.slice()), v => { E.killRing = arr(v).filter(s => typeof s === 'string'); });
getter('this-command', () => E.thisCommand, v => { E.thisCommand = v; });
getter('last-command', () => E.lastCommand, v => { E.lastCommand = v; });
getter('current-prefix-arg', () => E.prefixArg ?? false, null, 'The raw prefix argument of this command.');
getter('deactivate-mark', () => bool(!E.keepMark), v => { E.keepMark = !truthy(v); });
L.defvar('post-command-hook', NIL, 'Procedures called after each command.');
L.set('inhibit-read-only', new L.S.Param(false, null, 'inhibit-read-only')); L.S.gdoc.set('inhibit-read-only', 'Parameter: non-#f lets read-only buffers be changed. (parameterize ((inhibit-read-only #t)) ...)');

/* ---------- commands, hooks and signals as seen from Scheme ---------- */
D('set-interactive!', 'name spec', 'Make the procedure named NAME a command. SPEC is a spec string, "" for no arguments, or a thunk returning the spec or the argument list.', ([n, spec]) => {
  const f = L.toFn(n); f.interactive = spec === '' || spec === false ? '' : spec; return n;
});
D('interactive-spec', 'command', 'The interactive spec of COMMAND, or #f.', ([c]) => { const f = L.fnOrNull(c); return f && f.interactive !== undefined ? f.interactive : false; });
D('command?', 'x', '#t if X names or is a command.', ([x]) => L.isCommand(x));
D('%add-hook', 'hook f append', 'Add F to the hook variable named HOOK.', ([h, f, ap]) => { L.addHook(h instanceof Sym ? h.name : str(h), f, truthy(ap)); return false; });
D('%remove-hook', 'hook f', 'Remove F from the hook variable named HOOK.', ([h, f]) => { L.removeHook(h instanceof Sym ? h.name : str(h), f); return false; });
D('%run-hook', 'hook . args', 'Call every procedure in HOOK with ARGS.', ([h, ...a]) => { L.runHook(h instanceof Sym ? h.name : str(h), ...a); return false; });
D('signal', 'kind . data', 'Signal an error of KIND, a symbol such as end-of-buffer or user-error.', ([k, ...d]) => signal(k instanceof Sym ? k.name : str(k), ...d));
D('prefix-numeric-value', 'raw', 'Numeric value of a raw prefix argument.', ([p]) => Ed.prefixNumeric(p));
D('alias!', 'new old', 'Make NEW name the same procedure as OLD.', ([a, b]) => { L.alias(a.name, b.name); return a; });

/* ---------- position and motion ---------- */
D('point', '', 'Current position of point (1-based).', () => cur().pt + 1);
D('point-min', '', 'Minimum position in the buffer, always 1.', () => 1);
D('point-max', '', 'Maximum position in the buffer.', () => cur().rope.length + 1);
D('buffer-size', '&optional BUFFER', 'Number of characters in BUFFER.', ([b]) => Ed.toBuffer(b).rope.length);
D('goto-char', 'POSITION', 'Set point to POSITION, clamped to the buffer.', ([p]) => { const b = cur(); b.pt = clampPos(b, num(p) - 1); return p; });
D('char-after', '&optional POS', 'Character at POS (default point), or nil at the end.', ([p]) => { const b = cur(); const k = L.absent(p) ? b.pt : num(p) - 1; return k >= 0 && k < b.rope.length ? L.mkchar(b.rope.codePointAt(k)) : false; });
D('char-before', '&optional POS', 'Character before POS (default point), or nil at the start.', ([p]) => { const b = cur(); const k = (L.absent(p) ? b.pt : num(p) - 1) - 1; return k >= 0 && k < b.rope.length ? L.mkchar(b.rope.codePointAt(k)) : false; });
D('following-char', '', 'Character after point, or #f.', () => { const b = cur(); return b.pt < b.rope.length ? L.mkchar(b.rope.codePointAt(b.pt)) : false; });
D('preceding-char', '', 'Character before point, or #f.', () => { const b = cur(); return b.pt > 0 ? L.mkchar(b.rope.codePointAt(b.pt - 1)) : false; });
D('bobp', '', 'Non-nil at the beginning of the buffer.', () => bool(cur().pt === 0));
D('eobp', '', 'Non-nil at the end of the buffer.', () => bool(cur().pt === cur().rope.length));
D('bolp', '', 'Non-nil at the beginning of a line.', () => { const b = cur(); return bool(b.pt === 0 || b.rope.at(b.pt - 1) === '\n'); });
D('eolp', '', 'Non-nil at the end of a line.', () => { const b = cur(); return bool(b.pt === b.rope.length || b.rope.at(b.pt) === '\n'); });
D('line-beginning-position', '&optional N', 'Position of the start of the line (N-1 lines away).', ([n]) => { const b = cur(), save = b.pt; forwardLine(b, optNum(n, 1) - 1); const r = Ed.bol(b.rope, b.pt) + 1; b.pt = save; return r; });
D('line-end-position', '&optional N', 'Position of the end of the line (N-1 lines away).', ([n]) => { const b = cur(), save = b.pt; forwardLine(b, optNum(n, 1) - 1); const r = Ed.eol(b.rope, b.pt) + 1; b.pt = save; return r; });
alias('pos-bol', 'line-beginning-position'); alias('pos-eol', 'line-end-position');
D('line-number-at-pos', '&optional POS', 'Line number of POS.', ([p]) => { const b = cur(); return Ed.lineNo(b.rope, L.absent(p) ? b.pt : pos(b, p)); });
D('count-lines', 'START END', 'Number of lines between START and END.', ([s, e]) => {
  const b = cur(), [a, z] = region(b, s, e); if (a === z) return 0;
  let n = 0; for (let k = a; k < z; k++) if (b.rope.at(k) === '\n') n++;
  return b.rope.at(z - 1) === '\n' ? n : n + 1;
});
D('current-column', '', 'Horizontal position of point (tabs count to the next multiple of 8).', () => Ed.column(cur().rope, cur().pt));
D('current-indentation', '', 'Column of the first non-blank character on this line.', () => { const b = cur(); let k = Ed.bol(b.rope, b.pt); while (b.rope.at(k) === ' ' || b.rope.at(k) === '\t') k++; return Ed.column(b.rope, k); });
D('move-to-column', 'COLUMN', 'Move point to COLUMN on the current line, or to its end.', ([c]) => { const b = cur(); b.pt = moveToCol(b, num(c)); return Ed.column(b.rope, b.pt); });
function moveToCol(b, col) { const t = b.rope, e = Ed.eol(t, b.pt); let k = Ed.bol(t, b.pt); while (k < e && Ed.column(t, k + 1) <= col) k++; return k; }
function forwardLine(b, n) {
  const t = b.rope; let p = b.pt, short = 0;
  if (n > 0) { for (let k = 0; k < n; k++) { const e = t.indexOf('\n', p); if (e < 0) { p = t.length; short = n - k; break; } p = e + 1; } }
  else { p = Ed.bol(t, p); for (let k = 0; k < -n; k++) { if (p === 0) { short = -n - k; break; } p = Ed.bol(t, p - 1); } }
  b.pt = p; return n > 0 && short && p === t.length && t.at(t.length - 1) !== '\n' ? short : (n > 0 ? short : -short);
}
CMD('forward-char', '^p', '&optional N', 'Move point N characters forward.', ([n]) => {
  const b = cur(), p = b.pt + optNum(n, 1);
  if (p > b.rope.length) { b.pt = b.rope.length; signal('end-of-buffer'); }
  if (p < 0) { b.pt = 0; signal('beginning-of-buffer'); }
  b.pt = p; return false;
});
CMD('backward-char', '^p', '&optional N', 'Move point N characters backward.', ([n]) => L.call('forward-char', [-optNum(n, 1)]));
CMD('forward-line', '^p', '&optional N', 'Move to the start of the Nth next line. Return the count of lines not moved.', ([n]) => forwardLine(cur(), optNum(n, 1)));
CMD('beginning-of-line', '^p', '&optional N', 'Move point to the beginning of the line.', ([n]) => { const b = cur(); if (optNum(n, 1) !== 1) forwardLine(b, optNum(n, 1) - 1); b.pt = Ed.bol(b.rope, b.pt); return false; });
CMD('end-of-line', '^p', '&optional N', 'Move point to the end of the line.', ([n]) => { const b = cur(); if (optNum(n, 1) !== 1) forwardLine(b, optNum(n, 1) - 1); b.pt = Ed.eol(b.rope, b.pt); return false; });
alias('move-beginning-of-line', 'beginning-of-line'); alias('move-end-of-line', 'end-of-line');
function lineMove(n) {
  const b = cur();
  const vert = [intern('next-line'), intern('previous-line')];
  if (!vert.includes(E.lastCommand) || E.goalCol === null) E.goalCol = Ed.column(b.rope, b.pt);
  const short = forwardLine(b, n);
  b.pt = moveToCol(b, E.goalCol);
  if (short) signal(n > 0 ? 'end-of-buffer' : 'beginning-of-buffer');
  return false;
}
CMD('next-line', '^p', '&optional N', 'Move down N lines, keeping the goal column.', ([n]) => lineMove(optNum(n, 1)));
CMD('previous-line', '^p', '&optional N', 'Move up N lines, keeping the goal column.', ([n]) => lineMove(-optNum(n, 1)));
function visibleLines() { return Math.max(1, (E.sel.rows || Ed.windowRows(E.sel)) - 2); }
CMD('scroll-up-command', '^P', '&optional ARG', 'Scroll the text up nearly a full screen.', ([a]) => { const b = cur(); if (b.pt === b.rope.length) signal('end-of-buffer'); forwardLine(b, L.absent(a) ? visibleLines() : Ed.prefixNumeric(a)); E.recenter = 'center'; return false; });
CMD('scroll-down-command', '^P', '&optional ARG', 'Scroll the text down nearly a full screen.', ([a]) => { const b = cur(); if (b.pt === 0) signal('beginning-of-buffer'); forwardLine(b, -(L.absent(a) ? visibleLines() : Ed.prefixNumeric(a))); E.recenter = 'center'; return false; });
CMD('recenter', 'P', '&optional ARG', 'Scroll so that the line with point is in the middle of the window.', () => { E.recenter = 'center'; return false; });
alias('recenter-top-bottom', 'recenter');

/* ---------- insertion and deletion ---------- */
const asText = x => typeof x === 'string' ? x : L.chr(x) ?? signal('wrong-type-argument', 'insert: expected a string or character, got', x);
D('insert', '&rest ARGS', 'Insert strings or characters at point.', a => { const b = cur(); Ed.insertText(b, a.map(asText).join('')); return false; });
D('insert-char', 'CHAR &optional COUNT', 'Insert COUNT copies of CHAR.', ([c, n]) => { Ed.insertText(cur(), L.chr(c).repeat(optNum(n, 1))); return false; });
D('delete-region', 'START END', 'Delete the text between START and END.', ([s, e]) => { const b = cur(), [a, z] = region(b, s, e); Ed.deleteText(b, a, z); return false; });
D('delete-and-extract-region', 'START END', 'Delete the text and return it.', ([s, e]) => { const b = cur(), [a, z] = region(b, s, e); return Ed.deleteText(b, a, z); });
CMD('delete-char', '*p', 'N', 'Delete the N characters after point (before point if N is negative).', ([n]) => {
  const b = cur(); n = num(n);
  const e = b.pt + n;
  if (e > b.rope.length) signal('end-of-buffer');
  if (e < 0) signal('beginning-of-buffer');
  Ed.deleteText(b, b.pt, e); return false;
});
D('buffer-substring', 'START END', 'Text between START and END.', ([s, e]) => { const b = cur(), [a, z] = region(b, s, e); return b.rope.slice(a, z); });
alias('buffer-substring-no-properties', 'buffer-substring');
D('buffer-string', '', 'The whole text of the current buffer.', () => cur().text);
D('erase-buffer', '', 'Delete the entire contents of the current buffer.', () => { const b = cur(); Ed.deleteText(b, 0, b.rope.length); return false; });
CMD('self-insert-command', '*p', 'N', 'Insert the character you typed, N times.', ([n]) => {
  const c = L.chr(L.get('last-command-event'));
  if (c === null || c === undefined) return false;
  Ed.insertText(cur(), c.repeat(Math.max(0, optNum(n, 1)))); return false;
});
CMD('clipboard-yank', '*', '', 'Insert text pasted from the system clipboard.', () => { const s = E.pasteText; if (s) { const b = cur(); b.mark = b.pt; Ed.insertText(b, s); E.killRing.unshift(s); } return false; });
D('skip-chars-forward', 'STRING &optional LIM', 'Move forward over characters in STRING (a set like "a-z" or "^ \\n").', ([s, lim]) => skipChars(s, lim, 1));
D('skip-chars-backward', 'STRING &optional LIM', 'Move backward over characters in STRING.', ([s, lim]) => skipChars(s, lim, -1));
function skipChars(set, lim, dir) {
  const b = cur(); let neg = false, body = str(set);
  if (body[0] === '^') { neg = true; body = body.slice(1); }
  const re = new RegExp('[' + body.replace(/[\]\\[]/g, '\\$&') + ']', 'u');
  const ok = c => c !== undefined && re.test(c) !== neg;
  const stop = L.absent(lim) ? (dir > 0 ? b.rope.length : 0) : clampPos(b, num(lim) - 1);
  const start = b.pt;
  if (dir > 0) while (b.pt < stop && ok(b.rope.at(b.pt))) b.pt++;
  else while (b.pt > stop && ok(b.rope.at(b.pt - 1))) b.pt--;
  return b.pt - start;
}
const caseRegion = (name, f) => CMD(name, '*r', 'START END', 'Convert the region’s case.', ([s, e]) => {
  const b = cur(), [a, z] = region(b, s, e), save = b.pt, t = f(b.rope.slice(a, z));
  if (t !== b.rope.slice(a, z)) { Ed.checkRO(b); b.text = b.rope.slice(0, a) + t + b.rope.slice(z); b.modified = true; }
  b.pt = save; return false;
});
caseRegion('upcase-region', s => s.toUpperCase());
caseRegion('downcase-region', s => s.toLowerCase());
caseRegion('capitalize-region', s => s.toLowerCase().replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (m, a, c) => a + c.toUpperCase()));

/* ---------- Emacs-syntax regular expressions and match data ---------- */
/* Emacs regexp syntax → JS RegExp source. In Emacs, \( \) \| \{ \} are operators and bare ( ) | { } are literals. */
function emacsRe(src) {
  let out = '', k = 0, inClass = false;
  while (k < src.length) {
    const c = src[k];
    if (inClass) {
      if (src.startsWith('[:', k)) {
        const e = src.indexOf(':]', k);
        const nm = src.slice(k + 2, e);
        out += ({ space: '\\s', alpha: '\\p{L}', digit: '0-9', alnum: '\\p{L}\\p{N}', upper: '\\p{Lu}', lower: '\\p{Ll}', word: '\\w', blank: ' \\t', punct: '\\p{P}' })[nm] || '';
        k = e + 2; continue;
      }
      if (c === ']' && out[out.length - 1] !== '[') { inClass = false; out += ']'; k++; continue; }
      out += (c === '\\' || (c === '[')) ? '\\' + c : c; k++; continue;
    }
    if (c === '[') { inClass = true; out += '['; k++; if (src[k] === '^') { out += '^'; k++; } if (src[k] === ']') { out += '\\]'; k++; } continue; }
    if (c === '\\') {
      const d = src[k + 1]; k += 2;
      if ('()|{}'.includes(d)) out += d === '(' && src.startsWith('?:', k) ? '(?:' + (k += 2, '') : d;
      else if (d === '`') out += '^';
      else if (d === "'") out += '$';
      else if (d === '_') { out += '\\b'; k++; }
      else if (d === '<' || d === '>') out += '\\b';
      else if (d === 's') { const cl = src[k++]; out += cl === '-' || cl === ' ' ? '\\s' : '\\p{P}'; }
      else if (d === 'S') { k++; out += '\\S'; }
      else if (/[wWbB1-9]/.test(d)) out += '\\' + d;
      else out += '\\' + d;
      continue;
    }
    if ('()|{}/'.includes(c)) { out += '\\' + c; k++; continue; }
    out += c; k++;
  }
  try { return new RegExp(out, 'mu'); }
  catch (e) { signal('invalid-regexp', e.message); }
}
let matchData = [];
function setMatchData(m, offset) {
  matchData = [];
  if (!m) return;
  for (let g = 0; g < m.length; g++) {
    if (m[g] === undefined) { matchData.push(null); continue; }
    const s = m.indices ? m.indices[g][0] : (g === 0 ? m.index : m.index + m[0].indexOf(m[g]));
    matchData.push([s + offset, s + offset + m[g].length]);
  }
}
D('string-match', 'REGEXP STRING [START]', 'Index of the first match of the Emacs-syntax REGEXP in STRING, or #f.', ([re, s, st]) => {
  const r = new RegExp(emacsRe(str(re)).source, 'gmud'); r.lastIndex = typeof st === 'number' ? st : 0;
  const m = r.exec(str(s)); matchOneBased = false; setMatchData(m, 0); return m ? m.index : false;
});
D('string-match-p', 'REGEXP STRING [START', 'Like string-match, without changing the match data.', ([re, s, st]) => {
  const r = new RegExp(emacsRe(str(re)).source, 'gmu'); r.lastIndex = typeof st === 'number' ? st : 0;
  const m = r.exec(str(s)); return m ? m.index : false;
});
D('match-beginning', 'SUBEXP', 'Start of group SUBEXP in the last match.', ([n]) => matchData[n] ? matchData[n][0] + (matchOneBased ? 1 : 0) : false);
D('match-end', 'SUBEXP', 'End of group SUBEXP in the last match.', ([n]) => matchData[n] ? matchData[n][1] + (matchOneBased ? 1 : 0) : false);
let matchOneBased = false;

/* ---------- searching ---------- */
D('search-forward', 'STRING &optional BOUND NOERROR COUNT', 'Search forward for STRING; move point to the end of the match.', ([s, bound, noerr, count]) => searchStr(s, bound, noerr, count, 1));
D('search-backward', 'STRING &optional BOUND NOERROR COUNT', 'Search backward for STRING; move point to the start of the match.', ([s, bound, noerr, count]) => searchStr(s, bound, noerr, count, -1));
function searchStr(s, bound, noerr, count, dir) {
  const b = cur(); str(s);
  const fold = truthy(L.get('case-fold-search')) && s === s.toLowerCase();
  const hay = fold ? b.text.toLowerCase() : b.text, needle = fold ? s.toLowerCase() : s;
  const lim = L.absent(bound) ? null : clampPos(b, num(bound) - 1);
  let p = b.pt, n = optNum(count, 1); if (n < 0) { dir = -dir; n = -n; }
  for (let k = 0; k < n; k++) {
    const i = dir > 0 ? hay.indexOf(needle, p) : (p - 1 >= 0 ? hay.lastIndexOf(needle, p - needle.length) : -1);
    const ok = i >= 0 && (lim === null || (dir > 0 ? i + needle.length <= lim : i >= lim));
    if (!ok) return failSearch(b, noerr, lim, dir, s);
    matchOneBased = true; setMatchData([needle], i); matchData[0] = [i, i + needle.length];
    p = dir > 0 ? i + needle.length : i;
  }
  b.pt = p; return p + 1;
}
function failSearch(b, noerr, lim, dir, what) {
  if (!truthy(noerr)) signal('search-failed', what);
  if (noerr !== T) b.pt = lim !== null ? lim : (dir > 0 ? b.rope.length : 0);
  return false;
}
function reSearch(re, bound, noerr, count, dir) {
  const b = cur();
  const src = emacsRe(str(re)).source;
  const fold = truthy(L.get('case-fold-search')) && re === re.toLowerCase();
  const rx = new RegExp(src, 'gmud' + (fold ? 'i' : ''));
  const lim = L.absent(bound) ? null : clampPos(b, num(bound) - 1);
  let n = optNum(count, 1), p = b.pt;
  for (let k = 0; k < n; k++) {
    let m = null;
    if (dir > 0) { rx.lastIndex = p; m = rx.exec(b.text); }
    else { rx.lastIndex = lim ?? 0; for (let x; (x = rx.exec(b.text)) && x.index < p;) { m = x; if (x[0] === '') rx.lastIndex++; } }
    if (!m || (lim !== null && (dir > 0 ? m.index + m[0].length > lim : m.index < lim))) return failSearch(b, noerr, lim, dir, re);
    matchOneBased = true; setMatchData(m, 0);
    p = dir > 0 ? m.index + m[0].length : m.index;
  }
  b.pt = p; return p + 1;
}
D('re-search-forward', 'REGEXP &optional BOUND NOERROR COUNT', 'Search forward for REGEXP (Emacs syntax).', ([r, b, n, c]) => reSearch(r, b, n, c, 1));
D('re-search-backward', 'REGEXP &optional BOUND NOERROR COUNT', 'Search backward for REGEXP (Emacs syntax).', ([r, b, n, c]) => reSearch(r, b, n, c, -1));
D('looking-at', 'REGEXP', 'Non-nil if the text after point matches REGEXP.', ([re]) => {
  const b = cur(), rx = new RegExp(emacsRe(str(re)).source, 'ymud'); rx.lastIndex = b.pt;
  const m = rx.exec(b.text); if (m) { matchOneBased = true; setMatchData(m, 0); } return bool(m);
});
D('looking-back', 'REGEXP &optional LIMIT', 'Non-nil if the text before point ends with a match for REGEXP.', ([re]) => {
  const b = cur(), rx = new RegExp('(?:' + emacsRe(str(re)).source + ')$', 'u');
  return bool(rx.test(b.rope.slice(Math.max(0, b.pt - 500), b.pt)));
});
D('match-string', 'NUM &optional STRING', 'Text matched by group NUM of the last search.', ([n, s]) => {
  const d = matchData[num(n)]; if (!d) return false;
  return typeof s === 'string' ? s.slice(d[0], d[1]) : cur().rope.slice(d[0], d[1]);
});
D('replace-match', 'NEWTEXT', 'Replace the text of the last buffer match with NEWTEXT (\\& and \\N refer to the match).', ([nt]) => {
  const b = cur(), md = matchData, d = md[0]; if (!d) signal('error', 'No previous search');
  const groups = md.map(g => g ? b.rope.slice(g[0], g[1]) : '');
  const rep = str(nt).replace(/\\(&|\d)/g, (m, g) => g === '&' ? groups[0] : (groups[+g] ?? ''));
  b.pt = d[0]; Ed.deleteText(b, d[0], d[1]); b.pt = d[0]; Ed.insertText(b, rep); return false;
});

/* ---------- mark, region, kill ring ---------- */
D('mark', '&optional FORCE', 'Position of the mark, or nil if it is not set.', () => cur().mark === null ? false : cur().mark + 1);
D('set-mark', 'POS', 'Set the mark to POS and activate it.', ([p]) => { const b = cur(); if (p === false) { b.mark = null; b.markActive = false; } else { b.mark = pos(b, p); b.markActive = true; E.keepMark = true; } return p; });
D('push-mark', '&optional POS NOMSG ACTIVATE', 'Set the mark at POS (default point).', ([p, nomsg, act]) => {
  const b = cur(); b.mark = L.absent(p) ? b.pt : pos(b, p); b.markActive = truthy(act);
  if (b.markActive) E.keepMark = true;
  if (!truthy(nomsg)) Ed.message('Mark set'); return false;
});
D('region-beginning', '', 'Start of the region.', () => { const b = cur(); if (b.mark === null) signal('error', 'The mark is not set now, so there is no region'); return Math.min(b.pt, b.mark) + 1; });
D('region-end', '', 'End of the region.', () => { const b = cur(); if (b.mark === null) signal('error', 'The mark is not set now, so there is no region'); return Math.max(b.pt, b.mark) + 1; });
D('region-active-p', '', 'Non-nil if the region is active.', () => bool(cur().markActive && cur().mark !== null));
alias('use-region-p', 'region-active-p');
D('deactivate-mark', '', 'Deactivate the mark.', () => { cur().markActive = false; return false; });
D('activate-mark', '', 'Activate the mark.', () => { const b = cur(); if (b.mark !== null) { b.markActive = true; E.keepMark = true; } return false; });
CMD('set-mark-command', 'P', 'ARG', 'Set the mark where point is and activate it. With C-u, jump to the mark.', ([a]) => {
  const b = cur();
  if (truthy(a)) { if (b.mark === null) signal('user-error', 'No mark set in this buffer'); b.pt = b.mark; b.markActive = false; return false; }
  b.mark = b.pt; b.markActive = true; E.keepMark = true; Ed.message('Mark set'); return false;
});
CMD('exchange-point-and-mark', '', '', 'Put the mark where point is and point where the mark was.', () => {
  const b = cur(); if (b.mark === null) signal('user-error', 'No mark set in this buffer');
  [b.pt, b.mark] = [b.mark, b.pt]; b.markActive = true; E.keepMark = true; return false;
});
function toClipboard(s) { host.setClipboard(s); }
D('kill-new', 'STRING', 'Make STRING the latest kill.', ([s]) => { E.killRing.unshift(str(s)); if (E.killRing.length > 60) E.killRing.pop(); E.killIdx = 0; toClipboard(s); return false; });
D('kill-append', 'STRING BEFORE-P', 'Append STRING to the latest kill (prepend if BEFORE-P).', ([s, before]) => {
  if (!E.killRing.length) E.killRing.unshift('');
  E.killRing[0] = truthy(before) ? str(s) + E.killRing[0] : E.killRing[0] + str(s); toClipboard(E.killRing[0]); return false;
});
D('current-kill', 'N', 'The Nth most recent kill.', ([n]) => { if (!E.killRing.length) signal('error', 'Kill ring is empty'); return E.killRing[((num(n) % E.killRing.length) + E.killRing.length) % E.killRing.length]; });
CMD('kill-region', 'r', 'BEG END', 'Kill the text between BEG and END, saving it in the kill ring. Consecutive kills append.', ([s, e]) => {
  const b = cur(), [a, z] = region(b, s, e);
  const text = b.rope.slice(a, z);
  if (b.readOnly && !E.inhibitRO) { L.call('kill-new', [text]); signal('buffer-read-only', b); }
  Ed.deleteText(b, a, z);
  if (E.lastCommand === intern('kill-region') && E.killRing.length) L.call('kill-append', [text, bool(num(e) < num(s))]);
  else L.call('kill-new', [text]);
  E.thisCommand = intern('kill-region'); b.markActive = false; return false;
});
CMD('kill-ring-save', 'r', 'BEG END', 'Save the region in the kill ring without deleting it.', ([s, e]) => {
  const b = cur(), [a, z] = region(b, s, e); L.call('kill-new', [b.rope.slice(a, z)]); b.markActive = false; return false;
});
alias('copy-region-as-kill', 'kill-ring-save');
CMD('yank', '*P', '&optional ARG', 'Insert the most recent kill; leave the mark at the start.', ([a]) => {
  if (!E.killRing.length) signal('error', 'Kill ring is empty');
  const b = cur(); E.killIdx = truthy(a) && typeof a === 'number' ? a - 1 : 0;
  b.mark = b.pt; Ed.insertText(b, E.killRing[E.killIdx % E.killRing.length]); E.thisCommand = intern('yank'); return false;
});
CMD('yank-pop', '*p', '&optional N', 'Replace the text just yanked with an earlier kill.', ([n]) => {
  if (E.lastCommand !== intern('yank')) signal('user-error', 'Previous command was not a yank');
  const b = cur(); const s = Math.min(b.pt, b.mark), e = Math.max(b.pt, b.mark);
  Ed.deleteText(b, s, e); b.pt = s; b.mark = s;
  E.killIdx = (E.killIdx + optNum(n, 1)) % E.killRing.length;
  Ed.insertText(b, E.killRing[E.killIdx]); E.thisCommand = intern('yank'); return false;
});

/* ---------- buffers ---------- */
D('current-buffer', '', 'The current buffer.', () => cur());
D('buffer-name', '&optional BUFFER', 'Name of BUFFER.', ([b]) => Ed.toBuffer(b).name);
D('get-buffer', 'NAME', 'The buffer named NAME, or nil.', ([n]) => n instanceof Ed.Buffer ? n : (Ed.getBuffer(str(n)) || false));
D('get-buffer-create', 'NAME', 'The buffer named NAME, created if needed.', ([n]) => n instanceof Ed.Buffer ? n : Ed.getBufferCreate(str(n)));
D('bufferp', 'OBJECT', 'Non-nil if OBJECT is a buffer.', ([b]) => bool(b instanceof Ed.Buffer));
D('buffer-list', '', 'List of all live buffers.', () => listOf(E.buffers.slice()));
D('set-buffer', 'BUFFER', 'Make BUFFER current for Lisp code (the window does not change).', ([b]) => { E.current = Ed.toBuffer(b); return E.current; });
D('buffer-modified-p', '&optional BUFFER', 'Non-nil if BUFFER has unsaved changes.', ([b]) => bool(Ed.toBuffer(b).modified));
D('set-buffer-modified-p', 'FLAG', 'Mark the current buffer as modified or not.', ([f]) => { cur().modified = truthy(f); return f; });
D('generate-new-buffer-name', 'NAME', 'A buffer name based on NAME that is not in use.', ([n]) => { let k = 1, s = str(n); while (Ed.getBuffer(s)) s = `${n}<${++k}>`; return s; });
CMD('switch-to-buffer', 'BSwitch to buffer: ', 'BUFFER-OR-NAME', 'Display BUFFER-OR-NAME in the window, creating it if needed.', ([n]) => {
  const b = n instanceof Ed.Buffer ? n : Ed.getBufferCreate(str(n));
  Ed.setWindowBuffer(b); return b;
});
CMD('kill-buffer', 'bKill buffer: ', '&optional BUFFER-OR-NAME', 'Kill the buffer.', ([n]) => {
  const b = Ed.toBuffer(n === undefined ? false : n);
  if (b === E.minibuf) return false;
  E.buffers = E.buffers.filter(x => x !== b);
  if (!E.buffers.length) Ed.getBufferCreate('*scratch*');
  for (const w of Ed.windowList()) {
    if (w.buffer !== b) continue;
    const prev = w.prev.find(x => E.buffers.includes(x));
    if (w.popup && Ed.windowList().length > 1) { Ed.deleteWindow(w); continue; }
    Ed.setWindowBuffer(prev || E.buffers.find(x => !x.name.startsWith(' ') && x !== b) || E.buffers[0], w);
  }
  for (const w of Ed.windowList()) w.prev = w.prev.filter(x => x !== b);
  if (E.current === b) E.current = E.mini ? E.minibuf : E.win;
  return T;
});
CMD('rename-buffer', 'sRename buffer (to new name): ', 'NEWNAME', 'Change the current buffer’s name.', ([n]) => {
  if (Ed.getBuffer(str(n))) signal('error', `Buffer name ‘${n}’ is in use`); cur().name = n; return n;
});
CMD('read-only-mode', '', '', 'Toggle whether the current buffer is read-only.', () => { const b = cur(); b.readOnly = !b.readOnly; Ed.message(b.readOnly ? 'Read-Only mode enabled in current buffer' : 'Read-Only mode disabled in current buffer'); return false; });
CMD('quit-window', '', '', 'Stop showing this buffer: close its window if it was opened for it, else show the previous buffer.', () => {
  const w = E.sel;
  if (w.popup && Ed.windowList().length > 1) { Ed.deleteWindow(w); return false; }
  const prev = w.prev.find(x => E.buffers.includes(x) && x !== w.buffer) || Ed.otherBuffer();
  Ed.setWindowBuffer(prev); return false;
});
for (const mode of ['fundamental-mode', 'scheme-mode', 'scheme-interaction-mode', 'special-mode', 'text-mode', 'org-mode'])
  CMD(mode, '', '', `Switch the current buffer to ${Ed.MODE_NAMES[mode]} mode.`, () => { cur().mode = mode; return false; });
D('%save-excursion', 'thunk', 'Call THUNK, then restore the current buffer and point.', ([f]) => {
  const b = cur(), p = b.pt, w = E.current;
  try { return L.apply(f, []); }
  finally { E.current = w; if (E.buffers.includes(b) || b === E.minibuf) b.pt = Math.min(p, b.rope.length); }
});
D('%with-current-buffer', 'buffer thunk', 'Call THUNK with BUFFER current.', ([bufArg, f]) => {
  const saved = E.current;
  E.current = Ed.toBuffer(bufArg);
  try { return L.apply(f, []); } finally { E.current = saved; }
});

/* ---------- windows ---------- */
D('selected-window', '', 'The selected window.', () => E.sel);
D('window-list', '', 'Every window, top to bottom, left to right.', () => listOf(Ed.windowList()));
D('window-buffer', '[window]', 'The buffer WINDOW shows.', ([w]) => (w instanceof Ed.Window ? w : E.sel).buffer);
D('window?', 'x', '#t if X is a window.', ([x]) => x instanceof Ed.Window);
D('get-buffer-window', 'buffer', 'A window showing BUFFER, or #f.', ([b]) => Ed.windowFor(Ed.toBuffer(b)) || false);
D('select-window', 'window', 'Make WINDOW the selected window.', ([w]) => { if (!(w instanceof Ed.Window)) signal('wrong-type-argument', 'expected a window, got', w); Ed.selectWindow(w); return w; });
D('set-window-buffer', 'window buffer', 'Show BUFFER in WINDOW.', ([w, b]) => { Ed.setWindowBuffer(Ed.toBuffer(b), w instanceof Ed.Window ? w : E.sel); return false; });
D('window-point', '[window]', 'Point in WINDOW.', ([w]) => { const win = w instanceof Ed.Window ? w : E.sel; return (win === E.sel ? win.buffer.pt : win.pt) + 1; });
D('pop-to-buffer', 'buffer [select]', 'Show BUFFER in another window (splitting if needed) and select it unless SELECT is #f.', ([b, sel]) => { const buf = b instanceof Ed.Buffer ? b : Ed.getBufferCreate(str(b)); return Ed.popToBuffer(buf, sel === undefined || truthy(sel)); });
D('display-buffer', 'buffer', 'Show BUFFER in another window without selecting it.', ([b]) => Ed.popToBuffer(b instanceof Ed.Buffer ? b : Ed.getBufferCreate(str(b)), false));
CMD('split-window-below', 'P', '[size]', 'Split the selected window in two, one above the other (C-x 2).', () => { Ed.splitWindow(E.sel, 'below'); return E.sel; });
CMD('split-window-right', 'P', '[size]', 'Split the selected window in two, side by side (C-x 3).', () => { Ed.splitWindow(E.sel, 'right'); return E.sel; });
CMD('delete-window', '', '', 'Close the selected window (C-x 0).', () => { Ed.deleteWindow(E.sel); return false; });
CMD('delete-other-windows', '', '', 'Make the selected window the only one (C-x 1).', () => { Ed.deleteOtherWindows(E.sel); return false; });
CMD('other-window', 'p', 'count', 'Select the COUNTth next window (C-x o, M-o).', ([n]) => { const ws = Ed.windowList(); const k = ws.indexOf(E.sel); Ed.selectWindow(ws[((k + optNum(n, 1)) % ws.length + ws.length) % ws.length]); return false; });
CMD('winner-undo', '', '', 'Go back to the previous window arrangement (C-c <left>).', () => {
  if (!E.winHistory.length) signal('user-error', 'No earlier window configuration');
  E.winFuture.push(Ed.winConfig()); Ed.restoreWinConfig(E.winHistory.pop()); return false;
});
CMD('winner-redo', '', '', 'Go forward again after winner-undo (C-c <right>).', () => {
  if (!E.winFuture.length) signal('user-error', 'No later window configuration');
  E.winHistory.push(Ed.winConfig()); Ed.restoreWinConfig(E.winFuture.pop()); return false;
});
function windowRect(w) { if (!w.el) Ed.ensureWindowDom(); return w.el.getBoundingClientRect(); }
function windowInDirection(dir) {
  const me = windowRect(E.sel), cx = (me.left + me.right) / 2, cy = (me.top + me.bottom) / 2;
  let best = null, bestD = Infinity;
  for (const w of Ed.windowList()) {
    if (w === E.sel) continue;
    const r = windowRect(w);
    const ok = dir === 'left' ? r.right <= me.left + 1 && r.bottom > me.top && r.top < me.bottom
      : dir === 'right' ? r.left >= me.right - 1 && r.bottom > me.top && r.top < me.bottom
      : dir === 'up' ? r.bottom <= me.top + 1 && r.right > me.left && r.left < me.right
      : r.top >= me.bottom - 1 && r.right > me.left && r.left < me.right;
    if (!ok) continue;
    const d = Math.hypot((r.left + r.right) / 2 - cx, (r.top + r.bottom) / 2 - cy);
    if (d < bestD) { bestD = d; best = w; }
  }
  return best;
}
for (const dir of ['left', 'right', 'up', 'down'])
  CMD(`windmove-${dir}`, '', '', `Select the window ${dir === 'up' ? 'above' : dir === 'down' ? 'below' : 'to the ' + dir} (C-w ${dir[0] === 'l' ? 'h' : dir === 'right' ? 'l' : dir === 'up' ? 'k' : 'j'}).`, () => {
    const w = windowInDirection(dir); if (!w) signal('user-error', `No window ${dir}`); Ed.selectWindow(w); return false;
  });
alias('evil-window-left', 'windmove-left'); alias('evil-window-right', 'windmove-right'); alias('evil-window-up', 'windmove-up'); alias('evil-window-down', 'windmove-down');
alias('evil-window-split', 'split-window-below'); alias('evil-window-vsplit', 'split-window-right'); alias('evil-window-delete', 'delete-window'); alias('evil-window-next', 'other-window');
CMD('evil-window-prev', '', '', 'Select the previous window (C-w W).', () => { const ws = Ed.windowList(); const k = ws.indexOf(E.sel); Ed.selectWindow(ws[(k - 1 + ws.length) % ws.length]); return false; });
CMD('evil-window-new', '', '', 'Split the window and show a new empty buffer (C-w n).', () => { Ed.splitWindow(E.sel, 'below'); Ed.selectWindow(Ed.windowList()[Ed.windowList().indexOf(E.sel) + 1]); Ed.setWindowBuffer(Ed.getBufferCreate(L.call('generate-new-buffer-name', ['*new*']))); return false; });
CMD('evil-window-rotate-downwards', '', '', 'Rotate the buffers through the windows (C-w r).', () => { const ws = Ed.windowList(); if (ws.length < 2) return false; const bs = ws.map(w => w.buffer), ps = ws.map(w => w === E.sel ? w.buffer.pt : w.pt); ws.forEach((w, i) => { Ed.setWindowBuffer(bs[(i - 1 + ws.length) % ws.length], w); w.pt = ps[(i - 1 + ws.length) % ws.length]; if (w === E.sel) w.buffer.pt = w.pt; }); return false; });

/* ---------- keymaps ---------- */
function keymapOf(x) { if (x instanceof Ed.Keymap) return x; if (x instanceof Sym && L.get(x.name) instanceof Ed.Keymap) return L.get(x.name); signal('wrong-type-argument', 'expected a keymap, got', x); }
D('make-sparse-keymap', '&optional NAME', 'A new empty keymap.', ([n]) => new Ed.Keymap(typeof n === 'string' ? n : null));
D('keymapp', 'OBJECT', 'Non-nil if OBJECT is a keymap.', ([x]) => bool(x instanceof Ed.Keymap));
D('kbd', 'KEYS', 'Normalize a key description such as "C-x C-f".', ([k]) => Ed.kbd(str(k)));
D('define-key', 'KEYMAP KEY DEF', 'Bind KEY to DEF in KEYMAP. DEF nil removes the binding.', ([m, k, d]) => Ed.defineKey(keymapOf(m), str(k), d));
D('keymap-set', 'KEYMAP KEY DEF', 'Bind KEY to DEF in KEYMAP.', ([m, k, d]) => Ed.defineKey(keymapOf(m), str(k), d));
D('set-keymap-parent', 'KEYMAP PARENT', 'Make KEYMAP inherit from PARENT.', ([m, p]) => { keymapOf(m).parent = p === false ? null : keymapOf(p); return p; });
D('current-global-map', '', 'The global keymap.', () => L.get('global-map'));
CMD('global-set-key', 'kSet key globally: \nCSet key to command: ', 'KEY COMMAND', 'Bind KEY to COMMAND in the global keymap.', ([k, c]) => Ed.defineKey(L.get('global-map'), str(k), c));
D('global-unset-key', 'KEY', 'Remove the global binding of KEY.', ([k]) => Ed.defineKey(L.get('global-map'), str(k), false));
CMD('local-set-key', 'kSet key locally: \nCSet key locally to command: ', 'KEY COMMAND', 'Bind KEY in the current major mode’s keymap.', ([k, c]) => {
  const s = intern(cur().mode + '-map'); if (!(s.value instanceof Ed.Keymap)) s.value = new Ed.Keymap(s.name);
  return Ed.defineKey(s.value, str(k), c);
});
D('lookup-key', 'KEYMAP KEY', 'The binding of KEY in KEYMAP.', ([m, k]) => { const d = Ed.lookupIn(keymapOf(m), Ed.kbd(str(k)).split(' ')); return d === undefined ? false : d; });
D('key-binding', 'KEY', 'The command KEY runs in the current buffer.', ([k]) => { const d = Ed.lookupKey(Ed.kbd(str(k))); return d === undefined || d === Ed.PREFIX ? false : d; });
D('where-is-internal', 'COMMAND', 'List of keys that run COMMAND.', ([c]) => listOf(Ed.whereIs(c)));

/* ---------- command loop from Lisp ---------- */
D('commandp', 'FUNCTION', 'Non-nil if FUNCTION can be called interactively.', ([f]) => bool(Ed.isCommand(f)));
D('prefix-numeric-value', 'RAW', 'Numeric value of a raw prefix argument.', ([p]) => Ed.prefixNumeric(p));
D('call-interactively', 'COMMAND', 'Call COMMAND, reading its arguments as if invoked by a key.', ([c]) => {
  const f = L.toFn(c), spec = f.interactive;
  const codes = typeof spec === 'string' ? spec.split('\n').map(x => x.replace(/^[*^@]+/, '')[0] || '').join('') : null;
  if (codes !== null && !/[sMnNxXCavbBfFkKc<]/.test(codes)) return L.callProc(f, syncSpec(spec));
  return Ed.callInteractively(c);
});
function syncSpec(spec) {
  const b = cur(), out = [];
  for (let item of spec.split('\n')) {
    item = item.replace(/^[*^@]+/, ''); if (!item) continue;
    const c = item[0];
    if (c === 'p') out.push(Ed.prefixNumeric(E.prefixArg));
    else if (c === 'P') out.push(E.prefixArg ?? false);
    else if (c === 'r') { if (b.mark === null) signal('error', 'The mark is not set now, so there is no region'); out.push(Math.min(b.pt, b.mark) + 1, Math.max(b.pt, b.mark) + 1); }
    else if (c === 'd') out.push(b.pt + 1);
    else if (c === 'm') out.push(b.mark === null ? false : b.mark + 1);
    else out.push(false);
  }
  return out;
}
CMD('execute-extended-command', async () => {
  const label = E.prefixArg !== null ? (Array.isArray(E.prefixArg) ? 'C-u ' : E.prefixArg + ' ') : '';
  return [await Ed.readMini(label + 'M-x ', '', Ed.commandNames, { require: true, kind: 'command', annotate: Ed.annotateCommand })];
}, 'COMMAND-NAME', 'Read a command name in the minibuffer and run it.', async ([name]) => {
  const s = intern(name);
  E.keepPrefix = true;
  E.thisCommand = s; E.thisKeys = '';
  E.echo = '';
  await Ed.callInteractively(s);
  const keys = Ed.whereIs(s);
  if (keys.length && !E.echo) Ed.message(`You can run the command ‘${name}’ with ${keys[0]}`);
  E.keepPrefix = false;
  return false;
});
CMD('universal-argument', '', '', 'Begin a numeric argument for the next command (C-u = 4, C-u C-u = 16).', () => {
  E.prefixArg = Array.isArray(E.prefixArg) ? [E.prefixArg[0] * 4] : E.uArg && typeof E.prefixArg === 'number' ? E.prefixArg : [4];
  E.uArg = true; E.uDigits = null; E.keepPrefix = true;
  E.echo = 'C-u' + (E.prefixArg[0] > 4 ? ' C-u'.repeat(Math.log(E.prefixArg[0]) / Math.log(4) - 1) : '') + '-';
  return false;
});
CMD('keyboard-quit', '', '', 'Cancel the current operation and deactivate the mark.', () => { cur().markActive = false; E.pendingKeys = ''; signal('quit'); });
CMD('undo', '', '', 'Undo the last change.', () => { Ed.undoStep(cur()); Ed.message('Undo'); return false; });
CMD('undo-redo', '', '', 'Redo the last change that was undone.', () => { Ed.redoStep(cur()); Ed.message('Redo'); return false; });
CMD('ding', '', '', 'Flash the mode line.', () => { Ed.ding(); return false; });
D('message', 'FORMAT . ARGS', 'Show a formatted message in the echo area and log it in *Messages* (~a ~s or %s %d).', ([f, ...a]) => { if (f === false) { E.echo = ''; return false; } const s = L.S.fmt(str(f), a); Ed.message(s); return s; });
D('beep', '', 'Flash the mode line.', () => { Ed.ding(); return false; });
const noWait = () => signal('error', 'Lisp code cannot stop and wait for input here; read arguments with an (interactive "s…") spec instead');
for (const n of ['read-string', 'read-from-minibuffer', 'y-or-n-p', 'yes-or-no-p', 'read-char', 'read-key', 'completing-read']) D(n, '&rest ARGS', 'Not available: commands read input through their interactive spec.', noWait);
D('run-with-timer', 'SECS REPEAT FUNCTION &rest ARGS', 'Call FUNCTION after SECS seconds, then every REPEAT seconds if REPEAT is a number.', ([s, rep, f, ...a]) => {
  const id = Symbol('timer'), tick = () => {
    try { L.resetOps(); L.apply(f, a); } catch (e) { Ed.reportError(e); clearInterval(h); E.timers.delete(id); }
    Ed.render();
  };
  let h = setTimeout(() => { tick(); if (typeof rep === 'number' && rep > 0 && E.timers.has(id)) { h = setInterval(tick, rep * 1000); E.timers.set(id, h); } else E.timers.delete(id); }, num(s) * 1000);
  E.timers.set(id, h);
  return { __print: () => '#<timer>', id };
});
D('cancel-timer', 'TIMER', 'Stop TIMER.', ([t]) => { const h = E.timers.get(t && t.id); if (h) { clearTimeout(h); clearInterval(h); E.timers.delete(t.id); } return false; });

/* ---------- incremental search and minibuffer commands ---------- */
CMD('isearch-forward', '', '', 'Search forward as you type. C-s again for the next match, RET to stop, C-g to go back.', () => Ed.isearch(1));
CMD('isearch-backward', '', '', 'Search backward as you type.', () => Ed.isearch(-1));
CMD('exit-minibuffer', '', '', 'Accept the highlighted candidate, or the input when none is highlighted (RET).', () => { Ed.exitMini(false); return false; });
CMD('exit-minibuffer-input', '', '', 'Accept the input exactly as typed, ignoring the candidates (M-RET).', () => { Ed.exitMini(true); return false; });
CMD('minibuffer-next', 'p', 'n', 'Highlight the next candidate (C-n, <down>).', ([n]) => { Ed.miniMove(optNum(n, 1)); return false; });
CMD('minibuffer-previous', 'p', 'n', 'Highlight the previous candidate (C-p, <up>). Above the first comes the input itself.', ([n]) => { Ed.miniMove(-optNum(n, 1)); return false; });
CMD('minibuffer-first', '', '', 'Highlight the first candidate.', () => { if (E.mini) E.mini.index = 0; return false; });
CMD('minibuffer-last', '', '', 'Highlight the last candidate.', () => { if (E.mini) E.mini.index = Ed.miniCandidates().length - 1; return false; });
CMD('minibuffer-scroll-down', '', '', 'Move the highlight a page down.', () => { Ed.miniMove(Math.max(1, (Number(L.get('vertico-count')) || 12) - 1), false); return false; });
CMD('minibuffer-scroll-up', '', '', 'Move the highlight a page up.', () => { Ed.miniMove(-Math.max(1, (Number(L.get('vertico-count')) || 12) - 1), false); return false; });
CMD('minibuffer-insert', '', '', 'Put the highlighted candidate in the input (TAB).', () => { Ed.miniInsert(); return false; });
L.defvar('vertico-count', 12, 'How many candidates the minibuffer lists at once.');
CMD('abort-minibuffers', '', '', 'Cancel the minibuffer.', () => { Ed.abortMini(); return false; });
CMD('minibuffer-complete', '', '', 'Put the highlighted candidate in the input, or complete the common prefix.', () => { Ed.completeMini(); return false; });
CMD('previous-history-element', '', '', 'Recall the previous minibuffer input.', () => { Ed.historyMove(1); return false; });
CMD('next-history-element', '', '', 'Recall the next minibuffer input.', () => { Ed.historyMove(-1); return false; });

/* ---------- Lisp evaluation ---------- */
function bufLex(b) { return Ed.lexOf(b); }
function sexpEnd(b) { return Ed.hooks.sexpEnd ? Ed.hooks.sexpEnd(b) : b.pt; }
function lastSexp(b) {
  const end = sexpEnd(b);
  const start = Ed.backwardSexp(b.text, bufLex(b), end);
  if (start === null) signal('scan-error', 'Containing expression ends prematurely');
  return L.read(b.rope.slice(start, end));
}
function evalForm(f) { L.resetOps(); return L.ev(f); }
function showValue(v) { const s = pr(v, true); Ed.message(typeof v === 'number' && Number.isInteger(v) && v >= 0 ? `${s} (#x${v.toString(16)}, #o${v.toString(8)}${v >= 32 && v < 127 ? ', #\\' + String.fromCharCode(v) : ''})` : s); return v; }
CMD('eval-last-sexp', 'P', 'INSERT', 'Evaluate the sexp before point and show its value. With C-u, insert the value.', ([ins]) => {
  const b = cur(), v = evalForm(lastSexp(b));
  if (truthy(ins)) { b.pt = sexpEnd(b); Ed.insertText(b, pr(v, true)); } else showValue(v);
  return v;
});
CMD('eval-print-last-sexp', '*', '', 'Evaluate the sexp before point and insert its value on a new line.', () => {
  const b = cur(), v = evalForm(lastSexp(b));
  b.pt = sexpEnd(b); Ed.insertText(b, '\n' + pr(v, true) + '\n'); return v;
});
CMD('eval-defun', '', '', 'Evaluate the top-level form around or after point.', () => {
  const b = cur(), t = b.rope, cls = bufLex(b);
  let s = Ed.bol(t, b.pt);
  while (s > 0 && !(t.at(s) === '(' && cls[s] === Ed.C.PAR)) s = Ed.bol(t, s - 1);
  if (!(t.at(s) === '(' && cls[s] === Ed.C.PAR)) { s = t.indexOf('(', b.pt); if (s < 0) signal('user-error', 'No top-level form here'); }
  const e = Ed.forwardSexp(t, cls, s); if (e === null) signal('scan-error', 'Unbalanced parentheses');
  return showValue(evalForm(L.read(t.slice(s, e))));
});
function evalText(text) { let last = false; for (const f of L.readAll(text)) last = evalForm(f); return last; }
CMD('eval-buffer', '', '&optional BUFFER', 'Evaluate every form in the buffer.', ([b]) => { const buf = Ed.toBuffer(b === undefined ? false : b); evalText(buf.text); Ed.message(`Evaluated ${buf.name}`); return false; });
CMD('eval-region', 'r', 'START END', 'Evaluate every form in the region.', ([s, e]) => { const b = cur(), [a, z] = region(b, s, e); evalText(b.rope.slice(a, z)); b.markActive = false; return false; });
CMD('eval-expression', 'xEval: ', 'EXP', 'Evaluate EXP and show its value.', ([x]) => showValue(evalForm(x)));
CMD('forward-sexp', '^p', '&optional N', 'Move forward over N balanced expressions.', ([n]) => sexpMove(optNum(n, 1)));
CMD('backward-sexp', '^p', '&optional N', 'Move backward over N balanced expressions.', ([n]) => sexpMove(-optNum(n, 1)));
function sexpMove(n) {
  const b = cur(), cls = bufLex(b);
  for (let k = 0; k < Math.abs(n); k++) {
    const p = n > 0 ? Ed.forwardSexp(b.text, cls, b.pt) : Ed.backwardSexp(b.text, cls, b.pt);
    if (p === null) signal('scan-error', 'Containing expression ends prematurely');
    b.pt = p;
  }
  return false;
}
CMD('backward-up-list', '^p', '&optional N', 'Move backward out of N levels of parentheses.', ([n]) => {
  const b = cur(), cls = bufLex(b);
  for (let k = 0; k < optNum(n, 1); k++) { const p = Ed.upList(b.text, cls, b.pt); if (p === null) signal('scan-error', 'Unbalanced parentheses'); b.pt = p; }
  return false;
});
CMD('lisp-indent-line', '*', '', 'Indent the current line as Lisp code.', () => { Ed.indentLine(cur()); return false; });
L.defvar('tab-always-indent', intern('complete'), "TAB indents; 'complete also completes the word at point once the line is indented, as corfu does on the desktop.");
L.defvar('indent-tabs-mode', true, 'Non-#f: TAB in a text buffer inserts a tab character; #f: spaces up to the next tab-width stop.');
L.defvar('tab-width', 8, 'Columns between tab stops for the spaces TAB inserts when indent-tabs-mode is #f.');
CMD('indent-for-tab-command', '*', '', 'Expand a snippet key before point; else indent the line in Scheme buffers; when it is already indented, or elsewhere after a word, complete the word (TAB).', () => {
  const b = cur();
  if (b === E.minibuf) return L.call('minibuffer-complete', []);
  const complete = L.get('tab-always-indent') === intern('complete');
  /* yasnippet binds TAB itself, whatever tab-always-indent says. */
  if (globalThis.Yas && globalThis.Yas.keyAt(b)) return globalThis.Yas.expand(b);
  const ver = b.ver, pt = b.pt;
  if (Ed.isLisp(b)) Ed.indentLine(b);
  if (!Ed.changedSince(b, ver) && b.pt === pt) {
    if (complete && globalThis.Complete && globalThis.Complete.prefixAt(b) && globalThis.Complete.open(b, false)) { if (E.corfu.cands.length === 1) globalThis.Complete.accept(); return false; }
    if (!Ed.isLisp(b)) {
      /* tab-to-tab-stop: a tab, or with indent-tabs-mode #f spaces to the next tab-width column. */
      const tw = Math.max(1, Math.floor(Number(L.get('tab-width'))) || 8);
      if (truthy(L.get('indent-tabs-mode'))) Ed.insertText(b, '\t');
      else { const col = Ed.column(b.rope, b.pt); Ed.insertText(b, ' '.repeat(tw - (col % tw))); }
    }
  }
  return false;
});
CMD('indent-region', '*r', 'START END', 'Indent each line in the region.', ([s, e]) => {
  const b = cur(), [a, z0] = region(b, s, e); let z = z0;
  const save = b.pt; b.pt = a;
  for (;;) {
    const len = b.rope.length; Ed.indentLine(b); z += b.rope.length - len;
    const nx = b.rope.indexOf('\n', b.pt); if (nx < 0 || nx + 1 >= z) break; b.pt = nx + 1;
  }
  b.pt = Math.min(save, b.rope.length); b.markActive = false; return false;
});

/* ---------- help ---------- */
function helpBuffer(text) {
  const h = Ed.getBufferCreate('*Help*'); h.mode = 'special-mode'; h.readOnly = true;
  h.text = text; h.pt = 0; h.mark = null; h.modified = false; h.undo = [];
  Ed.popToBuffer(h, true);
  Ed.message('Type q to close');
}
function signature(name, f) {
  if (f.params !== undefined && f.params !== null && typeof f.params !== 'string') return pr(L.cons(intern(name), f.params), true);
  return `(${name}${f.params ? ' ' + f.params : ''})`;
}
function describeFn(sym) {
  const name = L.cmdName(sym);
  if (L.S.macros.has(name)) return `${name} is a macro.\n\n${L.S.gdoc.get(name) || 'Not documented.'}\n`;
  let f; try { f = L.toFn(sym); } catch (e) { return `${name} is not defined as a procedure.`; }
  const scheme = typeof f.params !== 'string';
  const kind = scheme ? 'a procedure defined in Scheme' : 'a built-in procedure written in JavaScript';
  const inter = Ed.isCommand(f) ? 'an interactive command, ' + kind : kind;
  const keys = Ed.whereIs(sym);
  let out = `${name} is ${inter}.\n\n`;
  if (keys.length) out += `It is bound to ${keys.join(', ')}.\n\n`;
  out += signature(name, f) + '\n\n' + (f.doc || 'Not documented.') + '\n';
  if (f.props && f.props.size) out += '\nProperties: ' + [...f.props].map(([k, v]) => `${k.name} = ${pr(v, true)}`).join(', ') + '\n';
  if (f.procName && f.procName !== name) out = `${name} is an alias for ‘${f.procName}’.\n\n` + out;
  return out;
}
CMD('describe-function', 'aDescribe function: ', 'FUNCTION', 'Show the documentation of FUNCTION.', ([s]) => { helpBuffer(describeFn(s)); return false; });
CMD('describe-variable', 'vDescribe variable: ', 'VARIABLE', 'Show the value and documentation of VARIABLE.', ([s]) => {
  let v; try { v = L.get(s.name); } catch (e) { v = undefined; }
  helpBuffer(`${s.name}’s value is ${v === undefined ? 'unbound' : pr(v, true)}\n\n${L.S.gdoc.get(s.name) || 'Not documented as a variable.'}\n`); return false;
});
CMD('describe-key', 'kDescribe key: ', 'KEY', 'Show which command KEY runs, with its documentation.', ([k]) => {
  const d = Ed.lookupKey(k, E.win);
  if (d === undefined || d === Ed.PREFIX) { Ed.message(`${k} is undefined`); return false; }
  helpBuffer(`${k} runs the command ${L.cmdName(d)} (found in ${keyOwner(k)}).\n\n` + describeFn(d));
  return false;
});
CMD('describe-key-briefly', 'kDescribe key briefly: ', 'KEY', 'Show which command KEY runs in the echo area.', ([k]) => {
  const d = Ed.lookupKey(k, E.win); Ed.message(d === undefined || d === Ed.PREFIX ? `${k} is undefined` : `${k} runs the command ${pr(d)}`); return false;
});
function keyOwner(k) { for (const m of Ed.activeMaps(E.win)) { const d = Ed.lookupIn(m, k.split(' ')); if (d !== undefined && !(d instanceof Ed.Keymap)) return m.name || 'a keymap'; } return 'global-map'; }
CMD('where-is', 'CWhere is command: ', 'COMMAND', 'Show the keys that run COMMAND.', ([c]) => {
  const k = Ed.whereIs(c); Ed.message(k.length ? `${L.cmdName(c)} is on ${k.join(', ')}` : `${L.cmdName(c)} is not on any key`); return false;
});
CMD('describe-bindings', '', '', 'List every key binding active in the current buffer.', () => {
  const b = E.win, seen = new Set();
  let out = `Key bindings for ${b.name}\n\n`;
  for (const m of Ed.activeMaps(b)) {
    const rows = [];
    const walk = (km, pre) => {
      for (const [k, d] of km.map) {
        const seq = pre ? pre + ' ' + k : k;
        if (d instanceof Ed.Keymap) walk(d, seq);
        else if (!seen.has(seq)) { seen.add(seq); rows.push([seq, L.cmdName(d)]); }
      }
      if (km.parent) walk(km.parent, pre);
    };
    walk(m, '');
    if (!rows.length) continue;
    rows.sort((x, y) => x[0].localeCompare(y[0]));
    out += `${m.name || 'keymap'}\n${'-'.repeat((m.name || 'keymap').length)}\n` + rows.map(([k, c]) => k.padEnd(18) + c).join('\n') + '\n\n';
  }
  helpBuffer(out); return false;
});
CMD('list-buffers', '', '', 'Show a list of buffers.', () => {
  const rows = E.buffers.filter(b => !b.name.startsWith(' ')).map(b =>
    `${b === E.win ? '.' : ' '}${b.readOnly ? '%' : ' '}${b.modified ? '*' : ' '} ${b.name.padEnd(18)} ${String(b.rope.length).padStart(7)}  ${(Ed.MODE_NAMES[b.mode] || b.mode).padEnd(17)} ${b.file || ''}`);
  const h = Ed.getBufferCreate('*Buffer List*'); h.mode = 'special-mode'; h.readOnly = true;
  h.text = `CRM Buffer                Size  Mode              File\n--- ------                ----  ----              ----\n${rows.join('\n')}\n`;
  h.pt = 0; h.modified = false; Ed.popToBuffer(h, true); return false;
});
CMD('view-messages', '', '', 'Show the *Messages* buffer.', () => { Ed.setWindowBuffer(Ed.getBufferCreate('*Messages*')); return false; });

/* ---------- files (kept in this browser's local storage) ---------- */
/* hooks.visited(b, name, fresh) lets stack.js keep recentf and restore the saved place (save-place). */
function visit(name) {
  const existing = E.buffers.find(b => b.file === name);
  if (existing) { Ed.setWindowBuffer(existing); if (Ed.hooks.visited) Ed.hooks.visited(existing, name, false); return existing; }
  const b = Ed.getBufferCreate(Ed.getBuffer(name) ? L.call('generate-new-buffer-name', [name]) : name);
  const content = Ed.Store.get(name) ?? shippedConfig(name);
  b.text = content ?? ''; b.pt = 0; b.file = name; b.mode = Ed.modeFor(name); b.modified = false; b.undo = [];
  if (Ed.hooks.visited) Ed.hooks.visited(b, name, true);
  Ed.setWindowBuffer(b);
  if (content === null) Ed.message('(New file)');
  return b;
}
Ed.visit = visit;
CMD('find-file', 'FFind file: ', 'FILENAME', 'Visit FILENAME. Files are kept in this browser’s storage.', ([n]) => { if (!str(n).trim()) signal('user-error', 'No file name given'); return visit(n.trim()); });
function writeTo(b, name) {
  const ok = Ed.Store.set(name, b.text);
  b.file = name; b.modified = false;
  if (Ed.hooks.wrote) Ed.hooks.wrote(b, name);
  Ed.message(ok ? `Wrote ${name}` : `Wrote ${name} (kept for this session only: browser storage is unavailable)`);
}
CMD('save-buffer', async () => (cur().file ? [] : [await Ed.readMini('File to save in: ', cur().name.replace(/[*\s]/g, '') || 'untitled', () => Ed.Store.list())]),
  '&optional FILENAME', 'Save the current buffer to its file, asking for a name if it has none.', ([n]) => {
    const b = cur();
    if (b.file && !b.modified && n === undefined) { Ed.message('(No changes need to be saved)'); return false; }
    writeTo(b, n === undefined ? b.file : str(n)); return false;
  });
CMD('write-file', 'FWrite file: ', 'FILENAME', 'Save the current buffer to FILENAME and visit that file.', ([n]) => {
  const b = cur(); writeTo(b, str(n));
  if (!Ed.getBuffer(n) && !b.name.startsWith('*')) b.name = n; b.mode = Ed.modeFor(n) === 'fundamental-mode' ? b.mode : Ed.modeFor(n); return false;
});
D('file-exists-p', 'FILENAME', 'Non-nil if FILENAME is saved in this browser.', ([n]) => bool(Ed.Store.get(str(n)) !== null));
D('delete-file', 'FILENAME', 'Remove FILENAME from this browser’s storage.', ([n]) => { Ed.Store.del(str(n)); return false; });
D('directory-files', '&rest IGNORED', 'Names of all saved files.', () => listOf(Ed.Store.list()));
/* ---------- consult-style commands: pick from a live list with preview ---------- */
CMD('consult-buffer', async () => {
  const bufs = Ed.bufferNames(), files = Ed.Store.list().filter(f => !E.buffers.some(b => b.file === f));
  const items = [...bufs.map(b => 'b ' + b), ...files.map(f => 'f ' + f)];
  const d = Ed.otherBuffer().name;
  const v = await Ed.readMini('Switch to: ', '', () => items, { kind: 'consult-buffer', def: 'b ' + d, label: c => c.slice(2),
    annotate: c => (c[0] === 'b' ? 'Buffer  ' + Ed.annotateBuffer(c.slice(2)) : 'File    ' + Ed.annotateFile(c.slice(2))) });
  return [v];
}, 'choice', 'Switch to a buffer or a saved file, chosen from one list (SPC b b).', ([v]) => {
  if (v.startsWith('f ')) return visit(v.slice(2));
  const name = v.startsWith('b ') ? v.slice(2) : v;
  Ed.setWindowBuffer(Ed.getBufferCreate(name)); return false;
});
CMD('consult-line', async () => {
  const b = cur(), w = E.sel, t = b.text, lines = t.split('\n'), start = b.pt, startScroll = w.start;
  const width = String(lines.length).length;
  const items = lines.map((l, i) => String(i + 1).padStart(width) + ' ' + l).filter(l => l.trim().length > width);
  const cl = Ed.lineNo(t, b.pt);
  let picked = null, cancelled = true;
  try {
    picked = await Ed.readMini('Go to line: ', '', () => items, { kind: 'consult-line', require: true, keepOrder: true,
      def: items.find(l => +l.slice(0, width) === cl),
      onSelect: c => { if (!c) return; b.pt = Math.min(t.length, Ed.lineStartOf(t, +c.slice(0, width))); E.recenter = 'center'; } });
    cancelled = false;
  } finally { if (cancelled) { b.pt = start; w.start = startScroll; } }
  return [+picked.slice(0, width)];
}, 'line', 'Jump to a line chosen by searching its text, with live preview (SPC s s).', ([n]) => {
  const b = cur(); EvilCore.pushJump(b, b.pt); b.pt = Ed.lineStartOf(b.rope, n); b.pt = EvilCore.firstNonBlank(b.rope, b.pt); E.recenter = 'center'; return false;
});
function imenuItems(b) {
  const t = b.text, out = [];
  if (Ed.isLisp(b)) {
    const re = /^\((?:define(?:-command|-syntax|-macro|-record-type)?|evil-define-(?:motion|operator|text-object|command))\s+\(?([^\s()]+)/gm; let m;
    while ((m = re.exec(t))) out.push({ name: m[1], kind: m[0].slice(1).split(/\s/)[0], pos: m.index });
  } else if (b.mode === 'org-mode') {
    const re = /^(\*+)\s+(.*)$/gm; let m;
    while ((m = re.exec(t))) out.push({ name: '  '.repeat(m[1].length - 1) + m[2], kind: 'heading', pos: m.index });
  } else {
    const re = /^(\S.{0,60})$/gm; let m;
    while ((m = re.exec(t))) if (/^[A-Z#*]/.test(m[1]) && m.index > 0 && t[m.index - 1] === '\n' && (m.index < 2 || t[m.index - 2] === '\n')) out.push({ name: m[1], kind: 'paragraph', pos: m.index });
  }
  return out;
}
CMD('consult-imenu', async () => {
  const b = cur(), items = imenuItems(b), w = E.sel, start = b.pt, startScroll = w.start;
  if (!items.length) signal('user-error', 'No definitions found in this buffer');
  const names = items.map((it, i) => it.name + (items.findIndex(x => x.name === it.name) !== i ? ' <' + (i + 1) + '>' : ''));
  let cancelled = true, v;
  try {
    v = await Ed.readMini('Go to definition: ', '', () => names, { kind: 'imenu', require: true, keepOrder: true,
      annotate: c => items[names.indexOf(c)].kind,
      onSelect: c => { if (!c) return; b.pt = items[names.indexOf(c)].pos; E.recenter = 'center'; } });
    cancelled = false;
  } finally { if (cancelled) { b.pt = start; w.start = startScroll; } }
  return [items[names.indexOf(v)].pos + 1];
}, 'position', 'Jump to a definition or heading in this buffer, with live preview (SPC s i).', ([p]) => { const b = cur(); EvilCore.pushJump(b, b.pt); b.pt = p - 1; E.recenter = 'top'; return false; });
CMD('consult-recent-file', async () => [await Ed.readMini('Recent file: ', '', () => (Ed.hooks.recentFiles ? Ed.hooks.recentFiles() : Ed.Store.list()), { kind: 'file', require: true, annotate: Ed.annotateFile, keepOrder: true })], 'file', 'Visit a saved file, the last visited first (SPC f r): recentf order, unsorted, as consult does.', ([f]) => visit(f));
CMD('kill-current-buffer', '', '', 'Kill the current buffer without asking (SPC b k).', () => L.call('kill-buffer', [cur()]));

/* ---------- Scheme-style names for the Emacs predicates ---------- */
for (const [a, b] of [['bob?', 'bobp'], ['eob?', 'eobp'], ['bol?', 'bolp'], ['eol?', 'eolp'], ['region-active?', 'region-active-p'], ['use-region?', 'use-region-p'],
  ['buffer-modified?', 'buffer-modified-p'], ['buffer?', 'bufferp'], ['keymap?', 'keymapp'], ['file-exists?', 'file-exists-p'], ['looking-at?', 'looking-at'],
  ['looking-back?', 'looking-back'], ['string-match?', 'string-match-p'], ['buffer-file-name', 'buffer-file-name']]) if (a !== b && L.fnOrNull(intern(b))) alias(a, b);
D('buffer-file-name', '[buffer]', 'Name of the file BUFFER visits, or #f.', ([b]) => Ed.toBuffer(b === undefined ? false : b).file ?? false);
D('buffer-read-only?', '[buffer]', '#t if BUFFER is read-only.', ([b]) => Ed.toBuffer(b === undefined ? false : b).readOnly);
D('set-buffer-read-only!', 'flag [buffer]', 'Make the buffer read-only or not.', ([f, b]) => { Ed.toBuffer(b === undefined ? false : b).readOnly = truthy(f); return false; });
D('major-mode', '[buffer]', 'The major mode of BUFFER as a symbol.', ([b]) => intern(Ed.toBuffer(b === undefined ? false : b).mode));
D('set-major-mode!', 'mode [buffer]', 'Set the major mode of BUFFER.', ([m, b]) => { Ed.toBuffer(b === undefined ? false : b).mode = m.name; return m; });
D('mark-active?', '', '#t if the mark is active.', () => cur().markActive);

/* ---------- frames (R9.2): headless runtimes have none, and (selected-frame) is then #f ---------- */
const toFrame = f => (L.absent(f) || f === false ? E.frame : f instanceof Ed.Frame ? f : signal('wrong-type-argument', 'expected a frame, got', f));
D('framep', 'x', '#t if X is a frame.', ([x]) => x instanceof Ed.Frame);
alias('frame?', 'framep');
D('frame-live-p', 'x', '#t if X is a frame that has not been deleted.', ([x]) => x instanceof Ed.Frame && E.frames.includes(x));
D('selected-frame', '', 'The selected frame, or #f in a runtime with no frames.', () => E.frame || false);
D('frame-list', '', 'All live frames.', () => listOf(E.frames.slice()));
D('select-frame', 'frame', 'Make FRAME the selected frame.', ([f]) => { Ed.selectFrame(f); Ed.render(); return f; });
D('delete-frame', '[frame]', 'Delete FRAME (the selected frame by default). Its page elements stay; it stops being drawn.', ([f]) => { const fr = toFrame(f); if (fr) Ed.deleteFrame(fr); return false; });
CMD('other-frame', 'p', 'COUNT', 'Select the COUNTth next frame.', ([n]) => {
  const fs = E.frames; if (fs.length < 2) return false;
  const i = fs.indexOf(E.frame), k = ((i + (typeof n === 'number' ? n : 1)) % fs.length + fs.length) % fs.length;
  Ed.selectFrame(fs[k]); return false;
});
D('make-frame', 'parent-element . opts', 'Make a frame drawing into PARENT-ELEMENT, a page element. Not available without a page.', ([el]) => {
  if (!el || typeof el !== 'object' || !el.ownerDocument) signal('error', 'make-frame needs a page element', el);
  return Ed.makeFrame(el, {});
});

/* ---------- configuration files: emacs.scm, evil.scm, org.scm, ai.scm and init.scm ---------- */
/* A lazy config (org.scm) is evaluated at boot without a buffer; :e org.scm then shows the shipped text.
   The host reads the shipped files (R4.1): the page's Scheme blocks in a browser, edwin/scm/ under Node. */
const CONFIG = [['emacs.scm'], ['evil.scm'], ['org.scm', 'lazy'], ['ai.scm', 'lazy'], ['init.scm']];
const shipped = name => host.config(name);
function shippedConfig(name) { const c = CONFIG.find(x => x[0] === name && x[1]); return c ? shipped(name) : null; }
function loadConfig(name, lazy) {
  const saved = Ed.Store.get(name), orig = shipped(name);
  if (orig === null) return null;
  const text = saved ?? orig;
  if (!lazy) { const b = Ed.getBufferCreate(name); b.text = text; b.file = name; b.modified = false; b.pt = 0; }
  try { evalText(text); return null; }
  catch (e) {
    const why = Ed.errorText(e);
    if (saved !== null) { try { evalText(orig); } catch (e2) { /* keep going */ } }
    return `Error in ${name}: ${why}${saved !== null ? ' (loaded the shipped version instead; M-x reset-config discards your copies)' : ''}`;
  }
}
/* R4.11: after the shipped files, the user's own init.scm (~/.config/edwin/init.scm), when the host has one. */
function loadUserInit() {
  const text = host.userConfig('init.scm');
  if (text === null || text === undefined) return null;
  try { evalText(text); return null; } catch (e) { return `Error in ~/.config/edwin/init.scm: ${Ed.errorText(e)}`; }
}
CMD('reset-config', '', '', 'Restore the shipped emacs.scm, evil.scm and init.scm, forget saved copies, and evaluate them again.', () => {
  for (const [name] of CONFIG) {
    const orig = shipped(name);
    if (orig === null) continue;
    Ed.Store.del(name);
    const b = Ed.getBuffer(name);
    if (b) { b.text = orig; b.pt = 0; b.modified = false; b.undo = []; b.redo = []; }
    evalText(orig);
  }
  Ed.message('Restored the shipped configuration'); return false;
});
alias('reset-init', 'reset-config');

/* ---------- startup ---------- */
const SCRATCH = `;; Edwin: a small Emacs in the browser, scripted in Scheme, driven by Vim keys.
;;
;; You are in Normal state.  i a o enter Insert state; ESC returns.
;; Motions: h j k l w b e 0 $ gg G f t % { }   Search: / ? n N * #
;; Operators take a motion or text object: dw ci( yap >ip gUiw
;; Visual: v V C-v.  Repeat: .   Macros: qa ... q @a   Undo: u C-r
;; Ex: :w :e file :b name :s/a/b/g :%s :g/re/d :normal :sort :ls :h
;;
;; Every key runs a Scheme procedure.  evil.scm defines the Vim layer,
;; emacs.scm the plain Emacs commands, init.scm your settings and the
;; SPC leader keys (SPC f f, SPC b b, SPC h k ...).  Open one with
;; :e evil.scm, change it, then :w and :source.
;; C-z switches this buffer between Evil and plain Emacs keys.
;;
;; Evaluate Scheme: put point on a closing paren and press C-x C-e,
;; press C-j to insert the value, or type :(+ 1 2) at the ex prompt.

(+ 1 2 3)

(define-command (shout count)
  "Upcase the next COUNT words, then say so."
  (interactive "<c>")
  (let ((n (or count 1)))
    (upcase-word n)
    (message "Shouted ~a word~a" n (if (= n 1) "" "s"))))

(evil-define-key 'normal 'global "SPC s" 'shout)
`;
/* Ed.boot({host, frame}) starts the editor once all core files have loaded (R9.1). The host is the one
   the core loaded with; FRAME, when given, is the frame to draw into and take keys from. */
let booted = false;
function boot(opts = {}) {
  if (booted) throw new Error('Edwin has already booted');
  if (opts.host && opts.host !== host) throw new Error('Ed.boot: a different host from the one Edwin loaded with');
  booted = true;
  for (const n of ['global-map', 'minibuffer-local-map', 'scheme-mode-map', 'scheme-interaction-mode-map', 'special-mode-map', 'fundamental-mode-map', 'org-mode-map', 'text-mode-map'])
    L.set(n, new Ed.Keymap(n));
  L.get('scheme-interaction-mode-map').parent = L.get('scheme-mode-map');
  if (Ed.hooks.setup) Ed.hooks.setup();

  const msgs = Ed.getBufferCreate('*Messages*'); msgs.readOnly = true;
  const scratch = Ed.getBufferCreate('*scratch*'); scratch.text = SCRATCH; scratch.pt = 0;
  const errors = [];
  for (const [name, lazy] of CONFIG) { const err = loadConfig(name, lazy); if (err) errors.push(err); }
  const userErr = loadUserInit(); if (userErr) errors.push(userErr);
  E.buffers = [scratch, ...CONFIG.filter(c => !c[1]).map(([n]) => Ed.getBuffer(n)).filter(Boolean), msgs];
  E.root = new Ed.Window(scratch); Ed.selectWindow(E.root);
  if (errors.length) errors.forEach(e => Ed.message(e));
  else Ed.message(Ed.Store.get('init.scm') !== null ? 'Loaded your saved init.scm. :h shows the key reference.' : 'Welcome to Edwin. :h shows the key reference; C-z toggles Emacs keys.');
  if (opts.frame) { Ed.selectFrame(opts.frame); wire(opts.frame); }
  Ed.render();
  Ed.commandLoop();
}
Ed.boot = boot;

/* ---------- browser wiring: one frame's input, mouse and menu bar ---------- */
function wire(f) {
  const ta = f.el('input'), frame = f.root, root = f.el('windows'), doc = frame.ownerDocument, win = doc.defaultView;
  const focus = () => { if (doc.activeElement !== ta) ta.focus({ preventScroll: true }); };
  ta.addEventListener('focus', () => { E.focused = true; Ed.render(); });
  ta.addEventListener('blur', () => { E.focused = false; Ed.render(); });
  ta.addEventListener('keydown', e => {
    const k = Ed.keyName(e);
    if (!k) return;
    if (k === 'C-v' && Ed.hooks.nativePaste && Ed.hooks.nativePaste()) return;
    e.preventDefault();
    Ed.feedKey(k);
  });
  ta.addEventListener('beforeinput', e => {
    if (e.inputType === 'deleteContentBackward') { e.preventDefault(); Ed.feedKey('DEL'); }
    else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') { e.preventDefault(); Ed.feedKey('RET'); }
  });
  ta.addEventListener('input', () => {
    const v = ta.value; ta.value = '';
    for (const ch of v) Ed.feedKey(ch === ' ' ? 'SPC' : ch === '\n' ? 'RET' : ch === '\t' ? 'TAB' : ch);
  });
  ta.addEventListener('paste', e => {
    e.preventDefault();
    const s = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!s) return;
    E.pasteText = s; Ed.feedKey('<cmd:clipboard-yank>');
  });
  let dragFrom = null, dragWin = null;
  root.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); focus();
    if (E.mini) return;
    const w = Ed.windowAt(e.clientX, e.clientY);
    if (!w) return;
    if (w !== E.sel) { Ed.selectWindow(w); }
    const p = Ed.posFromPoint(e.clientX, e.clientY, w);
    if (p === null) { Ed.render(); return; }
    const b = w.buffer;
    if (E.isearch) E.isearch = null;
    if (Ed.hooks.mouseDown) Ed.hooks.mouseDown(b, p);
    else { b.pt = p; b.markActive = false; }
    dragFrom = p; dragWin = w; Ed.render();
  });
  win.addEventListener('mousemove', e => {
    if (dragFrom === null || !(e.buttons & 1) || dragWin !== E.sel) return;
    const p = Ed.posFromPoint(e.clientX, e.clientY, dragWin);
    if (p === null) return;
    const b = dragWin.buffer;
    if (Ed.hooks.mouseDrag) Ed.hooks.mouseDrag(b, dragFrom, p);
    else { b.mark = dragFrom; b.pt = p; b.markActive = p !== dragFrom; }
    Ed.render();
  });
  win.addEventListener('mouseup', () => { dragFrom = null; dragWin = null; });
  frame.addEventListener('mousedown', e => { if (!root.contains(e.target) && !e.target.closest('button')) { e.preventDefault(); focus(); } });
  Ed.hooks.wireWindow = w => {
    let acc = 0, queued = false;
    w.view.addEventListener('wheel', e => {
      e.preventDefault();
      acc += e.deltaMode === 1 ? e.deltaY * 20 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      if (!queued) { queued = true; host.nextFrame(() => {
        queued = false; const lh = Ed.lineHeight(); const lines = Math.trunc(acc / lh); if (!lines) return; acc -= lines * lh;
        Ed.scrollWindow(w, lines);
        const b = w.buffer, l = Ed.lineNoB(b, w === E.sel ? b.pt : w.pt), l1 = Ed.lineNoB(b, w.start), l2 = l1 + (w.rows || 20) - 1;
        if (w === E.sel && !E.mini && (l < l1 || l > l2)) { b.pt = Ed.lineStartB(b, l < l1 ? l1 : l2); if (Ed.hooks.clampPoint) Ed.hooks.clampPoint(b); }
        Ed.frameRender();
      }); }
    }, { passive: false });
  };
  for (const btn of frame.querySelectorAll('[data-key], [data-cmd]')) {
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => {
      focus();
      if (btn.dataset.key) for (const k of Ed.kbd(btn.dataset.key).split(' ')) Ed.feedKey(k);
      else Ed.feedKey('<cmd:' + btn.dataset.cmd + '>');
    });
  }
  focus();
}
})();
