/* Org mode for Edwin: the parts of Org, org-modern, evil-org, org-super-agenda, org-capture and
   org-roam that the desktop configuration uses every day. Buffers are rendered through the span
   mechanism of renderBuffer: hooks.lexSeg classifies the shown segment only (a class per character
   and hidden markers), and b.folds lists the hidden ranges that TAB cycling makes. Headlines are
   found by searching the rope for the next or previous line that starts with stars, never by
   scanning the whole buffer on a key. The agenda and roam indexes are built by a pure job function
   that runs in the worker pool when it offers EdPool.run, else on the main thread. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks, EC = globalThis.EvilCore;
const { intern, signal, truthy, listOf, arr, NIL, Sym } = L;
const { D, CMD } = L;
const cur = () => E.current;
const { bol, eol, lineNoB, lineStartB, lineCountB } = Ed;
const str = (x: SchemeValue) => { if (typeof x !== 'string') signal('wrong-type-argument', 'expected a string, got', x); return x as string; };
const num = (x: SchemeValue) => { if (typeof x !== 'number') signal('wrong-type-argument', 'expected an integer, got', x); return Math.trunc(x as number); };
const sval = (x: SchemeValue) => x instanceof Sym ? x.name : typeof x === 'string' ? x : x === true ? 't' : x === false ? '' : String(x);
/* One key picks an entry, as org-mks does for the capture templates and the agenda views. */
const keyOf = async (prompt: string, keys: string[]) => { const c = await Ed.readChar(prompt); const k = L.chr(c) ?? String(c); if (!keys.includes(k)) signal('user-error', `Invalid key ${k}`); return k; };

/* ---------- variables (org.scm sets the real defaults; these keep the code working without it) ---------- */
L.defvar('org-todo-keywords', L.read('((sequence "TODO(t)" "NEXT(n)" "WAITING(w)" "HOLD(h)" "SOMEDAY(s)" "|" "DONE(d)" "CANCELLED(c)"))'), 'Org TODO keyword sequences; keywords after | are done states.');
L.defvar('org-ellipsis', ' [...]', 'What a folded headline ends with.');
L.defvar('org-modern-star', '◉○◈◇✳', 'Bullets shown for the last star of a headline, one per level, cycling.');
L.defvar('org-hide-emphasis-markers', true, 'Non-#f hides the markers of *bold* /italic/ =code= ~verbatim~ text.');
L.defvar('org-directory', '', 'Directory of the Org files, relative to the store (empty: the store itself).');
L.defvar('org-agenda-files', false, '#f: every .org file in the store, else a list of file names.');
L.defvar('org-tags-column', -77, 'Column where tags end (negative: right-aligned to that column).');
L.defvar('org-agenda-start-on-weekday', 1, 'Day the week agenda starts on, 0 Sunday to 6 Saturday; #f starts it today.');
L.defvar('org-deadline-warning-days', 14, 'Days ahead that a deadline appears in the agenda.');
L.defvar('org-super-agenda-groups', NIL, 'Groups of the agenda: a list of plists with :name and selectors.');
L.defvar('org-capture-templates', NIL, 'Capture templates: (KEY DESCRIPTION entry TARGET TEMPLATE . OPTIONS).');
L.defvar('org-roam-directory', 'roam/', 'Directory of the roam notes, relative to the store.');
L.defvar('org-roam-dailies-directory', 'daily/', 'Directory of the dailies, relative to org-roam-directory.');
L.defvar('org-roam-capture-templates', NIL, 'Roam note templates: (KEY DESCRIPTION plain TEMPLATE (file+head FILE HEAD)).');
L.defvar('org-roam-dailies-capture-templates', NIL, 'Daily note templates: (KEY DESCRIPTION entry TEMPLATE (file+head FILE HEAD)).');
L.defvar('org-after-todo-state-change-hook', NIL, 'Procedures of no arguments called after org-todo changes a state; they read org-state and org-last-state.');
L.defvar('org-state', false, 'The new TODO state (a string, or #f for none) while org-after-todo-state-change-hook runs.');
L.defvar('org-last-state', false, 'The previous TODO state (a string, or #f) while org-after-todo-state-change-hook runs.');
L.defvar('org-capture-after-finalize-hook', NIL, 'Procedures called after a capture is stored.');
L.defvar('after-save-hook', NIL, 'Procedures called after a buffer is saved.');
Ed.MODE_NAMES['markdown-mode'] = 'Markdown'; Ed.MODE_NAMES['org-agenda-mode'] = 'Org Agenda'; Ed.MODE_NAMES['org-roam-mode'] = 'Org Roam';
for (const mode of ['markdown-mode', 'org-agenda-mode', 'org-roam-mode'])
  CMD(mode, '', '', `Switch the current buffer to ${Ed.MODE_NAMES[mode]} mode.`, () => Ed.switchMajorMode(cur(), mode));
H.modeFor = name => /\.org$/i.test(name) ? 'org-mode' : /\.(md|markdown)$/i.test(name) ? 'markdown-mode' : null;
H.ellipsis = () => String(L.get('org-ellipsis') ?? '...');
const isOrg = (b: { mode: string }) => b.mode === 'org-mode' || b.mode === 'org-roam-mode';
const isMd = (b: { mode: string }) => b.mode === 'markdown-mode';
const isOutline = (b: { mode: string }) => isOrg(b) || isMd(b);
const starOf = (b: { mode: string }) => isMd(b) ? '#' : '*';

/* The keyword sets: {all, todo, done, keys: {t: 'TODO'}} from org-todo-keywords, parsed once per value. */
let kwCache: OrgKeywords | null = null;
function todoKeywords() {
  const v = L.get('org-todo-keywords');
  if (kwCache && kwCache.src === v) return kwCache;
  const todo: string[] = [], done: string[] = [], keys: Record<string, string> = {};
  for (const seq of arr(v ?? NIL)) {
    let after = false;
    for (const x of arr(seq)) {
      if (x instanceof Sym) continue;
      const s = String(x);
      if (s === '|') { after = true; continue; }
      const m = /^([^(]+?)(?:\(([^)]*)\))?$/.exec(s); if (!m) continue;
      (after ? done : todo).push(m[1]); if (m[2]) keys[m[2][0]] = m[1];
    }
    if (!after && todo.length) { done.push(todo.pop()!); }
  }
  return kwCache = { src: v, all: [...todo, ...done], todo, done, keys };
}

/* ---------- dates and timestamps ---------- */
const ORG: OrgState = { now: () => new Date() };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const p2 = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const hm = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
const fromYmd = (s: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const addDays = (d: Date, n: number) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
const dayDiff = (a: string, b: string) => Math.round(((fromYmd(a) as unknown as number) - (fromYmd(b) as unknown as number)) / 86400000);
/* <2026-10-11 Sat 10:00> or [2026-10-11 Sat]: active or inactive, with or without the time. */
function stamp(d: Date, active: boolean, withTime: boolean) {
  const s = `${ymd(d)} ${DAYS[d.getDay()]}${withTime ? ' ' + hm(d) : ''}`;
  return active ? `<${s}>` : `[${s}]`;
}
/* strftime for the formats the templates use. */
function strftime(f: string, d: Date) {
  return f.replace(/%([YmdHMSFTzaAbBeIpjuwy%])/g, (m, c) => {
    switch (c) {
      case 'Y': return String(d.getFullYear()); case 'm': return p2(d.getMonth() + 1); case 'd': return p2(d.getDate());
      case 'H': return p2(d.getHours()); case 'M': return p2(d.getMinutes()); case 'S': return p2(d.getSeconds());
      case 'F': return ymd(d); case 'T': return `${hm(d)}:${p2(d.getSeconds())}`;
      case 'z': { const o = -d.getTimezoneOffset(), a = Math.abs(o); return (o < 0 ? '-' : '+') + p2(Math.floor(a / 60)) + p2(a % 60); }
      case 'a': return DAYS[d.getDay()]; case 'A': return DAYS_LONG[d.getDay()];
      case 'b': return MONTHS[d.getMonth()].slice(0, 3); case 'B': return MONTHS[d.getMonth()];
      case 'e': return String(d.getDate()).padStart(2, ' '); case 'y': return p2(d.getFullYear() % 100);
      case 'j': return String(Math.floor(((d as unknown as number) - (new Date(d.getFullYear(), 0, 1) as unknown as number)) / 86400000) + 1).padStart(3, '0');
      case 'u': return String(d.getDay() || 7); case 'w': return String(d.getDay());
      case 'I': return p2(d.getHours() % 12 || 12); case 'p': return d.getHours() < 12 ? 'AM' : 'PM';
      default: return '%';
    }
  });
}
/* The ISO week number, for the agenda header. */
function isoWeek(d: Date) { const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() + 4 - day); const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1)); return Math.ceil((((x as unknown as number) - (y0 as unknown as number)) / 86400000 + 1) / 7); }
/* org-read-date, the usual part: empty for today, 2026-10-11, 10-11, 11 (this month or next), +3d +2w +1m,
   today tomorrow yesterday, a weekday name (the next one), each with an optional HH:MM. */
function parseDate(input: string, base?: Date) {
  base = base || ORG.now();
  let s = String(input || '').trim().toLowerCase(), time: string | null = null;
  const tm = /(?:^|\s)(\d{1,2}):(\d{2})\s*$/.exec(s);
  if (tm) { time = `${p2(+tm[1])}:${tm[2]}`; s = s.slice(0, tm.index).trim(); }
  let d = new Date(base.getFullYear(), base.getMonth(), base.getDate()), m: RegExpExecArray | null;
  if (s === '' || s === 'today' || s === '.') { /* today */ }
  else if (s === 'tomorrow' || s === 'tom') d = addDays(d, 1);
  else if (s === 'yesterday') d = addDays(d, -1);
  else if ((m = /^([+-]?)(\d+)([dwmy])?$/.exec(s)) && m[1]) {
    const n = +m[2] * (m[1] === '-' ? -1 : 1), u = m[3] || 'd';
    if (u === 'd') d = addDays(d, n); else if (u === 'w') d = addDays(d, 7 * n);
    else if (u === 'm') d = new Date(d.getFullYear(), d.getMonth() + n, d.getDate()); else d = new Date(d.getFullYear() + n, d.getMonth(), d.getDate());
  }
  else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) d = new Date(+m[1], +m[2] - 1, +m[3]);
  else if ((m = /^(\d{1,2})[-/](\d{1,2})$/.exec(s))) { d = new Date(d.getFullYear(), +m[1] - 1, +m[2]); if (d < base && ymd(d) !== ymd(base)) d = new Date(d.getFullYear() + 1, +m[1] - 1, +m[2]); }
  else if ((m = /^(\d{1,2})$/.exec(s))) { d = new Date(d.getFullYear(), d.getMonth(), +m[1]); if (+m[1] < base.getDate()) d = new Date(d.getFullYear(), d.getMonth() + 1, +m[1]); }
  else if ((m = /^(sun|mon|tue|wed|thu|fri|sat)/.exec(s))) { const want = DAYS.findIndex(x => x.toLowerCase() === m![1]); let k = (want - d.getDay() + 7) % 7; if (!k) k = 7; d = addDays(d, k); }
  else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) d = new Date(+m[1], +m[2] - 1, +m[3]);
  else return null;
  if (isNaN(d.getTime())) return null;
  if (time) { const [h, mi] = time.split(':'); d.setHours(+h, +mi); }
  return { date: d, time };
}
async function readDate(prompt: string, def?: string) {
  const v = await Ed.readMini(prompt, '', null, { kind: 'org-date', history: ORG.dateHistory || (ORG.dateHistory = []) });
  const r = parseDate(v === '' && def !== undefined ? def : v);
  if (!r) signal('user-error', `Not a date: ${v}`);
  return r!;
}
D('org-read-date', '&optional PROMPT DEFAULT', 'Read a date in the minibuffer (today when empty) and return it as YYYY-MM-DD.', async ([p, d]: SchemeValue[]) => ymd((await readDate(L.absent(p) ? 'Date: ' : str(p), L.absent(d) ? undefined : str(d))).date));
D('org-parse-date', 'STRING', 'The date STRING names, as YYYY-MM-DD, or #f.', ([s]: SchemeValue[]) => { const r = parseDate(str(s)); return r ? ymd(r.date) : false; });
D('org-time-stamp-string', '&optional ACTIVE WITH-TIME', 'The current time as an Org timestamp.', ([a, t]: SchemeValue[]) => stamp(ORG.now(), L.absent(a) ? true : truthy(a), truthy(t)));
function uuid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  const h = '0123456789abcdef'; let s = '';
  for (let i = 0; i < 36; i++) s += i === 8 || i === 13 || i === 18 || i === 23 ? '-' : i === 14 ? '4' : i === 19 ? h[8 + Math.floor(Math.random() * 4)] : h[Math.floor(Math.random() * 16)];
  return s;
}
D('org-id-new', '', 'A new UUID for an :ID: property.', () => uuid());

/* ---------- the outline: headlines, subtrees, children ---------- */
/* Level of the headline that starts at LS, or 0. A headline is stars (or #) at column 0 followed by a blank. */
function levelAt(b: OrgOutline, ls: number) {
  const r = b.rope, st = starOf(b);
  if (r.charAt(ls) !== st) return 0;
  let k = ls + 1; while (r.charAt(k) === st) k++;
  const c = r.charAt(k);
  if (c !== ' ' && c !== '\t') return 0;
  return st === '#' && inFence(b, ls) ? 0 : k - ls;
}
/* Markdown: whether the line at LS is inside a ``` fence, where # starts a code comment, not a heading.
   The fence lines are found once per buffer version, and only when a # line asks. */
function inFence(b: OrgOutline, ls: number) {
  let c = b._fences as OrgFences | undefined;
  if (!c || c.ver !== b.ver) {
    const r = b.rope, list: number[] = [];
    for (let k = r.indexOf('```'); k >= 0; ) {
      const l = bol(r, k);
      if (/^[ \t]*$/.test(r.slice(l, k))) { list.push(l); k = eol(r, k); }
      k = r.indexOf('```', k + 1);
    }
    c = b._fences = { ver: b.ver, list };
  }
  const F = c.list;
  let lo = 0, hi = F.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (F[m] < ls) lo = m + 1; else hi = m; }
  return (lo & 1) === 1;
}
/* Start of the headline whose entry holds POS: that line, or the nearest one before it; null above the first. */
function headlineBefore(b: OrgOutline, pos: number) {
  const r = b.rope, st = starOf(b);
  let ls = bol(r, pos);
  for (;;) {
    if (levelAt(b, ls)) return ls;
    if (ls === 0) return null;
    const k = r.lastIndexOf('\n' + st, ls - 2);
    if (k < 0) { ls = 0; continue; }
    ls = k + 1;
  }
}
/* Start of the first headline on a line after position P, or -1. */
function nextHeadline(b: OrgOutline, p: number) {
  const r = b.rope, st = starOf(b);
  if (p === 0 && levelAt(b, 0)) return 0;
  for (let k = r.indexOf('\n' + st, Math.max(0, p - 1)); k >= 0; k = r.indexOf('\n' + st, k + 1)) if (levelAt(b, k + 1)) return k + 1;
  return -1;
}
/* Start of the last headline on a line before position P, or -1. */
function prevHeadline(b: OrgOutline, p: number) {
  const r = b.rope, st = starOf(b);
  for (let k = r.lastIndexOf('\n' + st, p - 2); k >= 0; k = r.lastIndexOf('\n' + st, k - 1)) if (levelAt(b, k + 1)) return k + 1;
  return p > 0 && levelAt(b, 0) ? 0 : -1;
}
/* End of the subtree of the headline at HS: the newline before the next headline of its level or above, or the end of the text. */
function subtreeEnd(b: OrgOutline, hs: number, level?: number) {
  const r = b.rope; level = level || levelAt(b, hs);
  for (let h = nextHeadline(b, eol(r, hs) + 1); h >= 0; h = nextHeadline(b, eol(r, h) + 1)) if (levelAt(b, h) <= level) return h - 1;
  return r.length;
}
/* End of the entry's own text: the newline before the next headline of any level, or the end of the text. */
function entryEnd(b: OrgOutline, hs: number) { const h = nextHeadline(b, eol(b.rope, hs) + 1); return h >= 0 ? h - 1 : b.rope.length; }
/* Where a fold of the region after EOH up to EOS ends: trailing blank lines are hidden too, except that one
   stays visible when there are two or more (org-cycle-separator-lines); -1 when there is nothing to hide. */
function foldEnd(b: OrgOutline, eoh: number, eos: number) {
  const r = b.rope;
  let e = eos, blanks = 0;
  while (e > eoh) { const ls = bol(r, e); if (/\S/.test(r.slice(ls, e))) break; blanks++; e = ls - 1; }
  if (e <= eoh) return -1;
  return blanks >= 2 ? bol(r, eos) - 1 : eos;
}
/* Fold the subtree or entry after EOH up to EOS, when there is something to hide. */
function foldRegion(b: EdBuffer, eoh: number, eos: number) { const e = foldEnd(b, eoh, eos); if (e > eoh) addFold(b, eoh, e); return e > eoh; }
/* The parts of the headline at HS. */
function headingInfo(b: OrgOutline, hs: number) {
  const r = b.rope, level = levelAt(b, hs), le = eol(r, hs), line = r.slice(hs, le), kw = todoKeywords();
  let k = level; while (line[k] === ' ' || line[k] === '\t') k++;
  const textStart = k;
  let todo: string | null = null, priority: string | null = null;
  for (const w of kw.all) if (line.startsWith(w, k) && (line[k + w.length] === ' ' || k + w.length === line.length)) { todo = w; k += w.length; while (line[k] === ' ') k++; break; }
  const pm = /^\[#([A-Z0-9])\]\s*/.exec(line.slice(k)); if (pm) { priority = pm[1]; k += pm[0].length; }
  let end = line.length, tags = '';
  const tm = /\s+(:[\w@#%:]+:)\s*$/.exec(line); if (tm && tm.index >= k) { tags = tm[1]; end = tm.index; }
  const title = line.slice(k, end).trim();
  return { ls: hs, le, level, line, todo, priority, title, tags, tagList: tags ? tags.split(':').filter(Boolean) : [], textStart, titleStart: hs + k, titleEnd: hs + end, done: !!todo && kw.done.includes(todo) };
}
/* Direct children of the headline at HS: the headlines in its subtree down to the level of the first one. */
function children(b: OrgOutline, hs: number, level?: number, eos?: number) {
  const r = b.rope; level = level || levelAt(b, hs); eos = eos === undefined ? subtreeEnd(b, hs, level) : eos;
  const out: number[] = []; let max = 0;
  for (let h = nextHeadline(b, eol(r, hs) + 1); h >= 0 && h <= eos; h = nextHeadline(b, eol(r, h) + 1)) {
    const lv = levelAt(b, h);
    if (!max) max = lv;
    if (lv <= max) out.push(h);
  }
  return out;
}
const headlineOrError = (b: EdBuffer) => { const hs = headlineBefore(b, b.pt); if (hs === null) signal('user-error', 'Before first headline'); return hs!; };

/* ---------- folds: b.folds, sorted, no two overlapping; renderBuffer skips the hidden lines ---------- */
function foldsOf(b: EdBuffer) { return b.folds && b.folds.length ? b.folds : null; }
function setFolds(b: EdBuffer, list: EdFold[]) { list.sort((x, y) => x.s - y.s); b.folds = list; b._foldVer = (b._foldVer || 0) + 1; }
function addFold(b: EdBuffer, s: number, e: number) {
  if (e <= s) return;
  const list = (b.folds || []).filter(f => f.e < s || f.s > e);
  list.push({ s, e }); setFolds(b, list);
}
function removeFolds(b: EdBuffer, s: number, e: number) { if (!foldsOf(b)) return; setFolds(b, b.folds!.filter(f => f.e < s || f.s > e)); }
function foldHiding(b: EdBuffer, p: number) { const F = foldsOf(b); return F ? Ed.foldAt(F, bol(b.rope, p)) : null; }
const isHidden = (b: EdBuffer, p: number) => !!foldHiding(b, p);
/* The end of the fold that starts at the line end E, or E itself: line-wise operators take the hidden part too. */
H.foldEnd = (b, e) => {
  const F = foldsOf(b); if (!F) return e;
  let lo = 0, hi = F.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (F[mid].s === e) return F[mid].e; if (F[mid].s < e) lo = mid + 1; else hi = mid - 1; }
  return e;
};
/* Show the line of P: remove the fold that hides it. */
function reveal(b: EdBuffer, p: number) { const f = foldHiding(b, p); if (f) setFolds(b, b.folds!.filter(x => x !== f)); return !!f; }
/* Run FN over the subtree from S to E and keep the folds of the headlines inside it (promote, demote,
   planning lines and drawers change the text inside a fold, which would otherwise unfold). Each fold
   remembers its headline, mapped through FN's edits, and whether it hid the entry's body or the whole
   subtree, so a CONTENTS or CHILDREN view comes back the same. */
function mapPos(eds: EdLogEntry[], p: number) {
  for (const ed of eds) {
    const end = ed.pos + ed.del.length;
    if (p >= end && (p > ed.pos || ed.del.length)) p += ed.ins.length - ed.del.length;
    else if (p > ed.pos) p = ed.pos;
  }
  return p;
}
function keepingFolds<T>(b: EdBuffer, s: number, e: number, fn: () => T): T {
  const F = foldsOf(b), saved: { hs: number; f: EdFold; entry: boolean }[] = [];
  if (F) for (const f of F) if (f.s >= s && f.e <= e) {
    const hs = bol(b.rope, f.s), ee = foldEnd(b, f.s, entryEnd(b, hs));
    saved.push({ hs, f, entry: f.e === ee });
  }
  if (saved.length) { const drop = new Set(saved.map(x => x.f)); setFolds(b, b.folds!.filter(f => !drop.has(f))); }
  const v0 = b.ver, r = fn(), eds = saved.length ? b.log.filter(ed => ed.v > v0) : [];
  for (const x of saved) {
    const hs = mapPos(eds, x.hs);
    if (!levelAt(b, hs) || bol(b.rope, hs) !== hs) continue;
    const eoh = eol(b.rope, hs);
    foldRegion(b, eoh, x.entry ? entryEnd(b, hs) : subtreeEnd(b, hs));
  }
  return r;
}
/* Edits move or remove folds: one before a fold shifts it, one inside unfolds it. New lines put right
   after a fold stay outside it, as an Org overlay does not grow at its end (o below a folded headline,
   a capture filed under one). A fold whose headline the edit destroyed (x on its star) is removed. */
const prevEdited = H.edited;
H.edited = b => {
  if (prevEdited) prevEdited(b);
  const F = foldsOf(b); if (!F) return;
  const ed = b.log[b.log.length - 1], pos = ed.pos, end = pos + ed.del.length, d = ed.ins.length - ed.del.length;
  const r = b.rope, iend = pos + ed.ins.length;
  let changed = false, near = true;
  const out = [];
  for (const f of F) {
    if (end <= f.s) {
      if (d) { f.s += d; f.e += d; }
      /* Only the first folds after the edit can have their headline line touched by it. */
      if (near) {
        const ls = bol(r, f.s);
        if (ls > iend) near = false;
        else if (!levelAt(b, ls) || eol(r, ls) !== f.s) { changed = true; continue; }
      }
      out.push(f);
    }
    else if (pos > f.e || (pos === f.e && !ed.del.length && ed.ins[0] === '\n')) out.push(f);
    else changed = true;
  }
  if (changed) setFolds(b, out);
};
/* Line motions step over folded lines (evil-core asks when the buffer has folds). */
H.lineTarget = (b, line, c) => {
  const r = b.rope, last = lineNoB(b, Ed.lastLineStart(r));
  let ln = line;
  if ((c as number) > 0) for (let i = 0; i < (c as number); i++) {
    let nx = ln + 1; if (nx > last) break;
    const f = foldHiding(b, lineStartB(b, nx)); if (f) { nx = lineNoB(b, f.e) + 1; if (nx > last) break; }
    ln = nx;
  } else for (let i = 0; i < -(c as number); i++) {
    let pv = ln - 1; if (pv < 1) break;
    const f = foldHiding(b, lineStartB(b, pv)); if (f) pv = lineNoB(b, f.s);
    ln = pv;
  }
  return ln;
};
/* A search or a jump that leaves point inside a fold opens it, as isearch and org-fold-show-context do.
   Any other command (w, b, }, G, %, a mark) moves point to the edge of the fold and keeps it closed,
   as Emacs adjusts point out of invisible text. */
const REVEALS = /search|^consult-|^isearch|occur|bookmark|xref|imenu|^org-|^find-|^switch-to-buffer/;
const prevPre = H.preCommand;
H.preCommand = (def, b) => {
  if (prevPre) prevPre(def, b);
  if (E.depth === 0 && !E.mini) ORG.pre = { b, pt: b.pt };
};
const prevPost = H.postCommand;
H.postCommand = (def, b, failed) => {
  if (prevPost) prevPost(def, b, failed);
  if (E.depth > 0 || E.mini) return;
  const w = E.win, pre = ORG.pre; ORG.pre = null;
  if (!w || !foldsOf(w)) return;
  const f = foldHiding(w, w.pt); if (!f) return;
  const name = E.lastCommand instanceof Sym ? E.lastCommand.name : '';
  if (!pre || pre.b !== w || pre.pt === w.pt || REVEALS.test(name)) { reveal(w, w.pt); return; }
  const r = w.rope, back = Math.max(bol(r, f.s), f.s - 1);
  w.pt = w.pt > pre.pt && f.e < r.length ? f.e + 1 : back;
};
D('org-fold-hidden-p', '&optional POS', '#t when POS (default point) is inside a fold.', ([p]: SchemeValue[]) => isHidden(cur(), L.absent(p) ? cur().pt : num(p) - 1));
D('org-folds', '&optional BUFFER', 'The folds of BUFFER as a list of (START . END) pairs.', ([bb]: SchemeValue[]) => listOf((Ed.toBuffer(bb === undefined ? false : bb).folds || []).map(f => new L.Pair(f.s + 1, f.e + 1))));

/* ---------- visibility cycling: TAB and S-TAB ---------- */
function cycleLocal(b: EdBuffer, hs: number) {
  const r = b.rope, level = levelAt(b, hs), eoh = eol(r, hs), eos = subtreeEnd(b, hs, level), fe = foldEnd(b, eoh, eos);
  const last = E.lastCommand === intern('org-cycle') && b._cycle && (b._cycle as OrgCycle).hs === hs ? (b._cycle as OrgCycle).status : null;
  if (fe < 0) { b._cycle = null; Ed.message('EMPTY ENTRY'); return; }
  const kids = children(b, hs, level, eos);
  const whole = foldsOf(b) && b.folds!.find(f => f.s === eoh && f.e >= fe);
  if (whole && kids.length) {
    removeFolds(b, eoh, eos);
    for (const c of kids) foldRegion(b, eol(r, c), subtreeEnd(b, c));
    b._cycle = { hs, status: 'children' }; Ed.message('CHILDREN'); return;
  }
  if (whole || (last === 'children')) {
    removeFolds(b, eoh, eos);
    b._cycle = { hs, status: 'subtree' }; Ed.message(whole ? 'SUBTREE (NO CHILDREN)' : 'SUBTREE'); return;
  }
  removeFolds(b, eoh, eos); addFold(b, eoh, fe);
  b._cycle = { hs, status: 'folded' }; Ed.message('FOLDED');
}
/* Fold every top-level subtree (overview), every entry's body (contents), or nothing (all). */
function overview(b: EdBuffer) {
  const r = b.rope, list: EdFold[] = [];
  let top = 0;
  for (let h = nextHeadline(b, 0); h >= 0; ) {
    const lv = levelAt(b, h);
    if (!top || lv < top) top = lv;
    const e = subtreeEnd(b, h, lv);
    const fe = foldEnd(b, eol(r, h), e); if (fe > 0) list.push({ s: eol(r, h), e: fe });
    h = e >= r.length ? -1 : nextHeadline(b, e + 1);
  }
  setFolds(b, list);
}
function contents(b: EdBuffer) {
  const r = b.rope, list: EdFold[] = [];
  for (let h = nextHeadline(b, 0); h >= 0; h = nextHeadline(b, eol(r, h) + 1)) { const s = eol(r, h), e = foldEnd(b, s, entryEnd(b, h)); if (e > s) list.push({ s, e }); }
  setFolds(b, list);
}
function showAll(b: EdBuffer) { setFolds(b, []); }
CMD('org-cycle', '', '', 'On a headline, cycle its visibility: folded, children, subtree (TAB). Elsewhere do nothing.', () => {
  const b = cur(), hs = bol(b.rope, b.pt);
  if (!isOutline(b)) return L.call('indent-for-tab-command', []);
  if (!levelAt(b, hs)) { if (foldHiding(b, b.pt)) reveal(b, b.pt); return false; }
  cycleLocal(b, hs); return false;
});
CMD('org-global-cycle', '', '', 'Cycle the visibility of the whole buffer: overview, contents, show all (S-TAB).', () => {
  const b = cur();
  const last = E.lastCommand === intern('org-global-cycle') ? b._gcycle : null;
  if (last === 'overview') { contents(b); b._gcycle = 'contents'; Ed.message('CONTENTS'); }
  else if (last === 'contents') { showAll(b); b._gcycle = 'all'; Ed.message('SHOW ALL'); }
  else { overview(b); b._gcycle = 'overview'; Ed.message('OVERVIEW'); }
  if (isHidden(b, b.pt)) { const f = foldHiding(b, b.pt); b.pt = bol(b.rope, f!.s); }
  return false;
});
CMD('org-show-all', '', '', 'Show every line of the buffer.', () => { showAll(cur()); return false; });
L.alias('outline-show-all', 'org-show-all');
CMD('org-overview', '', '', 'Show only the top-level headlines.', () => { overview(cur()); const b = cur(); if (isHidden(b, b.pt)) b.pt = bol(b.rope, foldHiding(b, b.pt)!.s); return false; });
CMD('org-content', '', '', 'Show every headline and no body text.', () => { contents(cur()); const b = cur(); if (isHidden(b, b.pt)) b.pt = bol(b.rope, foldHiding(b, b.pt)!.s); return false; });
for (const n of ['org-cycle', 'org-global-cycle', 'org-show-all', 'org-overview', 'org-content']) L.put(intern(n), 'evil-repeat', intern('abort'));
/* Vim's fold keys over outline folding, as evil-fold-list does for outline and Org buffers: zc hides
   the subtree of the headline at or before point (hide-subtree), zo shows its children (show-entry and
   show-children), zO all of it (show-subtree), za toggles between the two (outline-toggle-children),
   zM/zm show the top headlines only and zR/zr everything. */
function foldHeadline(b: EdBuffer) {
  const hs = isOutline(b) ? headlineBefore(b, b.pt) : null;
  if (hs === null) signal('user-error', 'E490: No fold found');
  return hs!;
}
function closeFold(b: EdBuffer, hs: number) {
  const r = b.rope, eoh = eol(r, hs), eos = subtreeEnd(b, hs), fe = foldEnd(b, eoh, eos);
  if (fe < 0) signal('user-error', 'E490: No fold found');
  removeFolds(b, eoh, eos); addFold(b, eoh, fe);
  if (b.pt > eoh) b.pt = hs;
}
function openFold(b: EdBuffer, hs: number) {
  const r = b.rope, eoh = eol(r, hs), eos = subtreeEnd(b, hs);
  if (!(foldsOf(b) && b.folds!.some(f => f.s === eoh))) return;
  removeFolds(b, eoh, eos);
  for (const c of children(b, hs, 0, eos)) foldRegion(b, eol(r, c), subtreeEnd(b, c));
}
const foldClosed = (b: EdBuffer, hs: number) => !!(foldsOf(b) && b.folds!.some(f => f.s === eol(b.rope, hs)));
CMD('evil-close-fold', '', '', 'Hide the subtree of the headline at or before point (zc).', () => { const b = cur(); closeFold(b, foldHeadline(b)); return false; });
CMD('evil-open-fold', '', '', 'Show the entry and the child headlines of the headline at or before point (zo).', () => { const b = cur(); openFold(b, foldHeadline(b)); return false; });
CMD('evil-open-fold-rec', '', '', 'Show the whole subtree of the headline at or before point (zO).', () => { const b = cur(), hs = foldHeadline(b); removeFolds(b, eol(b.rope, hs), subtreeEnd(b, hs)); return false; });
CMD('evil-toggle-fold', '', '', 'Show the children of the headline at or before point when it is folded, else hide its subtree (za).', () => {
  const b = cur(), hs = foldHeadline(b);
  if (foldClosed(b, hs)) openFold(b, hs); else closeFold(b, hs);
  return false;
});
CMD('evil-close-folds', '', '', 'Show only the top-level headlines (zM, zm).', () => L.call('org-overview', []));
CMD('evil-open-folds', '', '', 'Show every line (zR, zr).', () => L.call('org-show-all', []));
for (const n of ['evil-close-fold', 'evil-open-fold', 'evil-open-fold-rec', 'evil-toggle-fold', 'evil-close-folds', 'evil-open-folds']) L.put(intern(n), 'evil-repeat', intern('abort'));

/* ---------- the lexer: a class per character of the shown segment, org-modern style ---------- */
/* Class names: oh hidden (display none), ohs hidden star (blank), obN bullet star, olN headline text per
   level, ot/od todo and done keywords, ox done headline text, og tags, ots timestamp, osd planning keyword,
   obb oit ocd ovb oul ost emphasis, okw #+keyword line, oti title, obd block delimiter, osb/oqb block body,
   olk link, ocb/ocx checkbox, odr drawer, opr priority, ocm comment, oli list bullet, otb table, ohr rule,
   and the agenda's oad/oat date, oag group, oac category, oaw/oao label. */
const ON = ['', 'oh', 'ohs', 'ob1', 'ob2', 'ob3', 'ob4', 'ob5', 'ol1', 'ol2', 'ol3', 'ol4', 'ol5', 'ot', 'od', 'ox', 'og', 'ots', 'osd',
  'obb', 'oit', 'ocd', 'ovb', 'oul', 'ost', 'okw', 'oti', 'obd', 'osb', 'oqb', 'olk', 'ocb', 'ocx', 'odr', 'opr', 'ocm', 'oli', 'otb', 'ohr',
  'oad', 'oat', 'oag', 'oac', 'oaw', 'oao'];
const OC: Record<string, number> = {}; ON.forEach((nm, i) => { if (nm) OC[nm] = i; });
const TS_RE = /[<[]\d{4}-\d{2}-\d{2}(?: [^\s>\]]{1,3}\.?)?(?: \d{1,2}:\d{2}(?:-\d{1,2}:\d{2})?)?(?: [+.]+\d+[hdwmy])?(?: -\d+[hdwmy])?[>\]]/g;
const EM: Record<string, string> = { '*': 'obb', '/': 'oit', '_': 'oul', '=': 'ocd', '~': 'ovb', '+': 'ost' };
const EM_MD: Record<string, string> = { '*': 'oit', '_': 'oit', '`': 'ocd' }, EM_MD2: Record<string, string> = { '*': 'obb', '_': 'obb', '~': 'ost' };
const PRE = /[\s\-('"{]/, POST = /[\s\-.,:!?;'")}\\[]/;
/* The block that holds position FROM: the nearest block delimiter before it (within 64K), or null. A
   delimiter may be indented, as lexLine accepts it; in Org a headline ends any block, so the search stops
   there. Markdown fences are counted, since the same ``` line opens and closes. */
function blockBefore(b: EdBuffer, from: number) {
  if (from === 0) return null;
  const r = b.rope, md = isMd(b), lim = Math.max(0, from - 65536), needle = md ? '```' : '#+';
  let fences = 0;
  /* The delimiter at I, when only blanks precede it on its line: its line start, else -1. */
  const lineOf = (i: number) => { const ls = bol(r, i); return /^[ \t]*$/.test(r.slice(ls, i)) ? ls : -1; };
  /* HL: the newline before the nearest Org headline above FROM (non-headline lines with stars skipped). */
  let p = from - 1, hl = md ? -1 : r.lastIndexOf('\n*', from - 2);
  for (;;) {
    const i = p >= lim ? r.lastIndexOf(needle, p) : -1;
    if (!md) {
      while (hl >= lim && hl >= i && !levelAt(b, hl + 1)) hl = hl > 0 ? r.lastIndexOf('\n*', hl - 1) : -1;
      if (hl >= lim && hl >= i) return null;
    }
    if (i < lim) break;
    const ls = lineOf(i);
    if (ls >= 0) {
      const line = r.slice(ls, Math.min(eol(r, ls), ls + 120));
      if (md) { if (/^\s*```/.test(line)) fences++; }
      else { const m = /^\s*#\+(begin|end)_(\w+)/i.exec(line); if (m) return m[1].toLowerCase() === 'begin' ? m[2].toLowerCase() : null; }
    }
    p = i - 1;
  }
  return md && fences % 2 ? 'src' : null;
}
/* Whether the Markdown front matter that opens the buffer is still open at FROM. */
function frontMatterAt(b: EdBuffer, from: number) {
  const r = b.rope;
  if (!/^---\r?\n/.test(r.slice(0, 5))) return false;
  for (let k = r.indexOf('\n---', 3); k >= 0 && k + 1 < from; k = r.indexOf('\n---', k + 1))
    if (/^---\r?$/.test(r.slice(k + 1, eol(r, k + 1)))) return false;
  return true;
}
function lexOrgSeg(b: EdBuffer, from: number, to: number, seg: string) {
  const n = seg.length, cls = new Uint8Array(n), md = isMd(b), kw = todoKeywords(), F = foldsOf(b);
  const hideEm = truthy(L.get('org-hide-emphasis-markers'));
  let block = blockBefore(b, from);
  if (md && frontMatterAt(b, from)) block = 'frontmatter';
  const fill = (a: number, z: number, c: number) => { for (let k = a; k < z; k++) cls[k] = c; };
  const st = md ? '#' : '*';
  /* Markup inside the text from A to Z (segment positions) over BASE: links, timestamps, emphasis. */
  const inline = (line: string, ls: number, a: number, z: number, base: number) => {
    if (z <= a) return;
    fill(a, z, base);
    const s = line.slice(a - ls, z - ls), off = a;
    let m;
    if (md) {
      const re = /\[([^\]\n]*)\]\(([^)\n]+)\)/g;
      while ((m = re.exec(s))) { const i = off + m.index; cls[i] = OC.oh; fill(i + 1, i + 1 + m[1].length, OC.olk); fill(i + 1 + m[1].length, i + m[0].length, OC.oh); }
    } else {
      const re = /\[\[([^\]\n]+)\](?:\[([^\]\n]*)\])?\]/g;
      while ((m = re.exec(s))) {
        const i = off + m.index;
        if (m[2] !== undefined) { const ds = i + 2 + m[1].length + 2; fill(i, ds, OC.oh); fill(ds, ds + m[2].length, OC.olk); fill(ds + m[2].length, i + m[0].length, OC.oh); }
        else { fill(i, i + 2, OC.oh); fill(i + 2, i + 2 + m[1].length, OC.olk); fill(i + 2 + m[1].length, i + m[0].length, OC.oh); }
      }
      const ang = /<(https?:\/\/[^>\n]+)>/g;
      while ((m = ang.exec(s))) { const i = off + m.index; if (cls[i] === base) fill(i, i + m[0].length, OC.olk); }
    }
    const url = /\bhttps?:\/\/[^\s<>\]]+/g;
    while ((m = url.exec(s))) { const i = off + m.index; if (cls[i] === base) fill(i, i + m[0].length, OC.olk); }
    TS_RE.lastIndex = 0;
    while ((m = TS_RE.exec(s))) { const i = off + m.index; if (cls[i] === base) fill(i, i + m[0].length, OC.ots); }
    const ck = /\[\d*\/\d*\]|\[\d{1,3}%\]/g;
    while ((m = ck.exec(s))) { const i = off + m.index; if (cls[i] === base) fill(i, i + m[0].length, OC.ocb); }
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      let style = md ? EM_MD[ch] : EM[ch], dbl = false;
      if (md && EM_MD2[ch] && s[i + 1] === ch) { style = EM_MD2[ch]; dbl = true; }
      if (!style || cls[off + i] !== base) continue;
      if (i > 0 && !PRE.test(s[i - 1])) continue;
      const w = dbl ? 2 : 1;
      if (i + w >= s.length || /\s/.test(s[i + w]) || (!dbl && s[i + w] === ch)) continue;
      let j = i + w, ok = false;
      for (; j < s.length; j++) {
        if (s[j] !== ch || (dbl && s[j + 1] !== ch)) continue;
        if (j > i + w && !/\s/.test(s[j - 1]) && (j + w >= s.length || POST.test(s[j + w]))) { ok = cls[off + j] === base; break; }
      }
      if (!ok) continue;
      const c = OC[style], mk = hideEm ? OC.oh : c;
      fill(off + i, off + i + w, mk); fill(off + i + w, off + j, c); fill(off + j, off + j + w, mk);
      i = j + w - 1;
    }
  };
  const headline = (line: string, ls: number, le: number, k: number) => {
    const level = k, lv = ((level - 1) % 5) + 1;
    fill(ls, ls + k - 1, OC.ohs); cls[ls + k - 1] = OC['ob' + lv];
    let i = k; while (line[i] === ' ' || line[i] === '\t') i++;
    let done = false;
    if (!md) for (const w of kw.all) if (line.startsWith(w, i) && (line[i + w.length] === ' ' || i + w.length === line.length)) { done = kw.done.includes(w); fill(ls + i, ls + i + w.length, done ? OC.od : OC.ot); i += w.length; while (line[i] === ' ') i++; break; }
    const pm = /^\[#[A-Z0-9]\]\s*/.exec(line.slice(i)); if (pm) { fill(ls + i, ls + i + pm[0].length - (pm[0].length - pm[0].trimEnd().length), OC.opr); i += pm[0].length; }
    let end = line.length;
    const tm = md ? null : /\s+(:[\w@#%:]+:)\s*$/.exec(line);
    if (tm && tm.index >= i) { fill(ls + tm.index + (tm[0].length - tm[0].trimStart().length), ls + tm.index + tm[0].trimEnd().length, OC.og); end = tm.index; }
    inline(line, ls, ls + i, ls + end, done ? OC.ox : OC['ol' + lv]);
  };
  const planning = (line: string, ls: number) => {
    let m; const re = /(SCHEDULED|DEADLINE|CLOSED):/g;
    while ((m = re.exec(line))) fill(ls + m.index, ls + m.index + m[0].length, OC.osd);
    TS_RE.lastIndex = 0;
    while ((m = TS_RE.exec(line))) fill(ls + m.index, ls + m.index + m[0].length, OC.ots);
  };
  const lexLine = (line: string, ls: number, le: number) => {
    let m;
    /* In Org a headline ends any block, closed or not. */
    if (block && !md && line[0] === st && /^\*+[ \t]/.test(line)) block = null;
    if (block) {
      if (block === 'frontmatter') { fill(ls, le, OC.odr); if (from + ls > 0 && /^---\r?$/.test(line)) block = null; return; }
      if (md ? /^\s*```/.test(line) : /^\s*#\+end_/i.test(line)) { fill(ls, le, OC.obd); block = null; return; }
      fill(ls, le, /^(src|example|export|comment|frontmatter)$/.test(block) ? OC.osb : OC.oqb); return;
    }
    if (line[0] === st) { let k = 1; while (line[k] === st) k++; if (line[k] === ' ' || line[k] === '\t') { headline(line, ls, le, k); return; } }
    if (md) {
      if (/^\s*```/.test(line)) { fill(ls, le, OC.obd); block = 'src'; return; }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { fill(ls, le, OC.ohr); return; }
      if (/^\s*>/.test(line)) { fill(ls, le, OC.oqb); return; }
    } else {
      if ((m = /^\s*#\+begin_(\w+)/i.exec(line))) { fill(ls, le, OC.obd); block = m[1].toLowerCase(); return; }
      if (/^\s*#\+end_/i.test(line)) { fill(ls, le, OC.obd); return; }
      if ((m = /^\s*#\+(\w+):/.exec(line))) { fill(ls, le, OC.okw); if (/^title$/i.test(m[1])) { let k = m[0].length; while (line[k] === ' ') k++; fill(ls + k, le, OC.oti); } return; }
      if (/^\s*#(\s|$)/.test(line)) { fill(ls, le, OC.ocm); return; }
      if (/^\s*:[\w@#%-]+:(\s|$)/.test(line)) { fill(ls, le, OC.odr); return; }
      if (/^\s*(SCHEDULED|DEADLINE|CLOSED):/.test(line)) { planning(line, ls); return; }
      if (/^\s*\|/.test(line)) { fill(ls, le, OC.otb); return; }
      if (/^\s*-{5,}\s*$/.test(line)) { fill(ls, le, OC.ohr); return; }
    }
    if ((m = /^(\s*)([-+*]|\d+[.)])(\s+)/.exec(line)) && (m[1] || m[2] !== st)) {
      const bs = ls + m[1].length, be = bs + m[2].length;
      fill(bs, be, OC.oli);
      let k = m[0].length;
      const cb = /^\[([ xX-])\]/.exec(line.slice(k));
      if (cb) { fill(ls + k, ls + k + 3, cb[1] === ' ' ? OC.ocb : OC.ocx); k += 3; }
      inline(line, ls, ls + k, le, 0); return;
    }
    inline(line, ls, ls, le, 0);
  };
  let ls = 0;
  while (ls < n) {
    if (F) { const f = Ed.foldAt(F, from + ls); if (f) { ls = f.e + 1 - from; continue; } }
    let le = seg.indexOf('\n', ls); if (le < 0) le = n;
    lexLine(seg.slice(ls, le), ls, le);
    ls = le + 1;
  }
  return cls;
}
/* The agenda buffer: day headers, group names, categories, labels, keywords and tags. */
function lexAgendaSeg(b: EdBuffer, from: number, to: number, seg: string) {
  const n = seg.length, cls = new Uint8Array(n), kw = todoKeywords(), ag = (b.agenda || {}) as Partial<OrgAgenda>;
  const fill = (a: number, z: number, c: number) => { for (let k = a; k < z; k++) cls[k] = c; };
  let ls = 0;
  while (ls < n) {
    let le = seg.indexOf('\n', ls); if (le < 0) le = n;
    const line = seg.slice(ls, le);
    let m;
    if (from + ls === 0) fill(ls, le, OC.oti);
    else if (/^\S/.test(line)) fill(ls, le, line === ag.todayHeader ? OC.oat : OC.oad);
    else if (/^ \S/.test(line)) fill(ls, le, OC.oag);
    else if ((m = /^  (\S+:)\s+/.exec(line))) {
      fill(ls + 2, ls + 2 + m[1].length, OC.oac);
      let k = m[0].length;
      const lab = /^((?:Scheduled|Deadline|Sched\. \d+x|In +-?\d+ d\.|\d+ d\. ago|Closed):)\s+/.exec(line.slice(k));
      if (lab) { fill(ls + k, ls + k + lab[1].length, /^(Sched\.|\d+ d\. ago)/.test(lab[1]) ? OC.oao : OC.oaw); k += lab[0].length; }
      const tm = /^(\d{1,2}:\d{2}(?:-\d{1,2}:\d{2})?)\s+/.exec(line.slice(k));
      if (tm) { fill(ls + k, ls + k + tm[1].length, OC.ots); k += tm[0].length; }
      for (const w of kw.all) if (line.startsWith(w, k) && (line[k + w.length] === ' ' || k + w.length === line.length)) { fill(ls + k, ls + k + w.length, kw.done.includes(w) ? OC.od : OC.ot); k += w.length; break; }
      const tg = /\s+(:[\w@#%:]+:)\s*$/.exec(line);
      if (tg && tg.index >= k) fill(ls + tg.index + 1, ls + tg.index + 1 + tg[1].length, OC.og);
    }
    ls = le + 1;
  }
  return cls;
}
H.lexSeg = (b, from, to, seg) => {
  const agenda = b.mode === 'org-agenda-mode';
  if (!agenda && !isOutline(b)) return null;
  /* The classes also depend on the mode (Org or Markdown) and on org-hide-emphasis-markers. */
  const c = b._olx as OrgLex | undefined, kw = L.get('org-todo-keywords'), fv = b._foldVer || 0, mode = b.mode, he = truthy(L.get('org-hide-emphasis-markers'));
  if (c && c.ver === b.ver && c.from === from && c.to === to && c.fv === fv && c.kw === kw && c.mode === mode && c.he === he) return c;
  const cls = agenda ? lexAgendaSeg(b, from, to, seg as string) : lexOrgSeg(b, from, to, seg as string);
  return b._olx = { ver: b.ver, from, to, fv, kw, mode, he, cls, names: ON };
};

/* ---------- headline editing: todo states, motions, levels, new headings ---------- */
const optNum = (x: SchemeValue, d: number) => L.absent(x) ? d : num(x);
function withBuffer<T>(b: EdBuffer, fn: () => T): T { const saved = E.current; E.current = b; try { return fn(); } finally { E.current = saved; } }
/* The desktop configuration saves a file-backed Org buffer after every state change. */
function autosave(b: EdBuffer) { if (b.file && b.modified && isOrg(b)) withBuffer(b, () => L.call('save-buffer', [])); }
function setTodo(b: EdBuffer, hs: number, kw: string | null) {
  const info = headingInfo(b, hs), r = b.rope;
  const a = hs + info.textStart;
  let z = a;
  if (info.todo) { z = a + info.todo.length; while (r.charAt(z) === ' ') z++; }
  const rep = kw ? kw + (z < info.le || !kw ? ' ' : ' ') : '';
  if (r.slice(a, z) === rep) return;
  Ed.replaceText(b, a, z, rep);
  if (!kw && b.pt > a && b.pt > eol(r, hs)) b.pt = eol(r, hs);
  /* As in Emacs the hook takes no arguments: it reads org-state and org-last-state, bound while it runs. */
  const oldState = L.get('org-state'), oldLast = L.get('org-last-state');
  L.set('org-state', kw || false); L.set('org-last-state', info.todo || false);
  try { L.runHook('org-after-todo-state-change-hook'); } catch (e) { Ed.reportError(e); }
  finally { L.set('org-state', oldState ?? false); L.set('org-last-state', oldLast ?? false); }
  autosave(b); indexDirty();
}
CMD('org-todo', 'P', '&optional ARG', 'Cycle the TODO state of the headline at point through org-todo-keywords. With C-u, pick the state from a list (as C-c C-t does).', async ([arg]: SchemeValue[]) => {
  const b = cur();
  if (!isOrg(b)) signal('user-error', 'Not in an Org buffer');
  if (truthy(arg)) return L.call('org-todo-select', [await pickTodo(b)]);
  const hs = headlineOrError(b), info = headingInfo(b, hs), kw = todoKeywords();
  const i = info.todo ? kw.all.indexOf(info.todo) : -1;
  setTodo(b, hs, i + 1 < kw.all.length ? kw.all[i + 1] : null);
  return false;
});
async function pickTodo(b: EdBuffer) {
  const kw = todoKeywords(), hs = headlineOrError(b), info = headingInfo(b, hs);
  return Ed.readMini('TODO state: ', '', () => [...kw.all, 'none'], { kind: 'org-todo', require: true, def: info.todo || 'none', annotate: k => kw.done.includes(k) ? 'done' : k === 'none' ? 'no keyword' : 'todo' });
}
CMD('org-todo-select', async () => [await pickTodo(cur())], 'STATE', 'Set the TODO state of the headline at point to STATE, chosen in the minibuffer (C-c C-t).', ([state]: SchemeValue[]) => {
  const b = cur(); setTodo(b, headlineOrError(b), state === 'none' || state === '' ? null : str(state)); return false;
});
D('org-get-todo-state', '', 'The TODO keyword of the headline at point, or #f.', () => { const b = cur(), hs = headlineBefore(b, b.pt); return hs === null ? false : headingInfo(b, hs).todo || false; });
D('org-get-heading', '', 'The title of the headline at point, or #f.', () => { const b = cur(), hs = headlineBefore(b, b.pt); return hs === null ? false : headingInfo(b, hs).title; });
D('org-at-heading-p', '', '#t when point is on a headline.', () => { const b = cur(); return !!levelAt(b, bol(b.rope, b.pt)); });
D('org-back-to-heading', '', 'Move point to the headline of the current entry.', () => { const b = cur(); b.pt = headlineOrError(b); return b.pt + 1; });
D('org-outline-level', '', 'Level of the headline at point, or 0.', () => { const b = cur(); return levelAt(b, bol(b.rope, b.pt)); });

/* Motions over headlines. Folded headlines are skipped. */
function visibleHeadlineAfter(b: EdBuffer, p: number) { let h = nextHeadline(b, p); while (h >= 0 && isHidden(b, h)) h = nextHeadline(b, eol(b.rope, h) + 1); return h; }
function visibleHeadlineBefore(b: EdBuffer, p: number) { let h = prevHeadline(b, p); while (h >= 0 && isHidden(b, h)) h = prevHeadline(b, h); return h; }
CMD('org-next-visible-heading', '<c>', '&optional COUNT', 'Move to the next headline (gj).', ([n]: SchemeValue[]) => {
  const b = cur(), r = b.rope; let p = b.pt, moved = false;
  for (let i = 0; i < optNum(n, 1); i++) { const h = visibleHeadlineAfter(b, eol(r, p) + 1); if (h < 0) break; p = h; moved = true; }
  if (!moved) signal('user-error', 'No following headline');
  b.pt = p; return false;
});
CMD('org-previous-visible-heading', '<c>', '&optional COUNT', 'Move to the previous headline, or to this entry’s headline from its body (gk).', ([n]: SchemeValue[]) => {
  const b = cur(), r = b.rope; let p = b.pt, moved = false;
  for (let i = 0; i < optNum(n, 1); i++) { const ls = bol(r, p); const h = visibleHeadlineBefore(b, ls + (levelAt(b, ls) ? 0 : 1)); if (h < 0) break; p = h; moved = true; }
  if (!moved) signal('user-error', 'No previous headline');
  b.pt = p; return false;
});
CMD('outline-up-heading', '<c>', '&optional COUNT', 'Move to the parent headline (gh).', ([n]: SchemeValue[]) => {
  const b = cur();
  let hs = headlineOrError(b);
  for (let i = 0; i < optNum(n, 1); i++) {
    const level = levelAt(b, hs);
    let h = prevHeadline(b, hs);
    while (h >= 0 && levelAt(b, h) >= level) h = prevHeadline(b, h);
    if (h < 0) { if (hs === b.pt || i > 0) break; signal('user-error', 'Already at top level of the outline'); }
    hs = h;
  }
  b.pt = hs; return false;
});
L.alias('org-up-heading', 'outline-up-heading');
function sameLevel(b: EdBuffer, hs: number, dir: number) {
  const level = levelAt(b, hs), r = b.rope;
  for (let h = dir > 0 ? nextHeadline(b, eol(r, hs) + 1) : prevHeadline(b, hs); h >= 0; h = dir > 0 ? nextHeadline(b, eol(r, h) + 1) : prevHeadline(b, h)) {
    const lv = levelAt(b, h);
    if (lv < level) return -1;
    if (lv === level) return h;
  }
  return -1;
}
CMD('org-forward-heading-same-level', '<c>', '&optional COUNT', 'Move to the next headline of the same level (gl).', ([n]: SchemeValue[]) => {
  const b = cur(); let hs = headlineOrError(b);
  for (let i = 0; i < optNum(n, 1); i++) { const h = sameLevel(b, hs, 1); if (h < 0) break; hs = h; }
  b.pt = hs; return false;
});
CMD('org-backward-heading-same-level', '<c>', '&optional COUNT', 'Move to the previous headline of the same level.', ([n]: SchemeValue[]) => {
  const b = cur(); let hs = headlineOrError(b);
  for (let i = 0; i < optNum(n, 1); i++) { const h = sameLevel(b, hs, -1); if (h < 0) break; hs = h; }
  b.pt = hs; return false;
});
for (const n of ['org-next-visible-heading', 'org-previous-visible-heading', 'outline-up-heading', 'org-forward-heading-same-level', 'org-backward-heading-same-level'])
  L.put(intern(n), 'evil-repeat', intern('abort'));

/* Levels: add or remove a star on the headline at HS, and on its subtree when SUBTREE. */
function changeLevel(b: EdBuffer, hs: number, delta: number, subtree: boolean) {
  const r = b.rope, level = levelAt(b, hs), st = starOf(b);
  if (!level) signal('user-error', 'Not at a headline');
  if (level + delta < 1) signal('user-error', 'Cannot promote to level 0');
  const eos = subtree ? subtreeEnd(b, hs, level) : eol(r, hs);
  const heads = [hs];
  if (subtree) for (let h = nextHeadline(b, eol(r, hs) + 1); h >= 0 && h <= eos; h = nextHeadline(b, eol(r, h) + 1)) heads.push(h);
  const pt = b.pt, ln = lineNoB(b, pt), col = pt - bol(r, pt), onHead = heads.includes(bol(r, pt));
  keepingFolds(b, hs, eos, () => {
    for (let i = heads.length - 1; i >= 0; i--) {
      const h = heads[i];
      if (delta > 0) { b.pt = h; Ed.insertText(b, st); } else Ed.deleteText(b, h, h + 1);
    }
  });
  const ls = lineStartB(b, ln);
  b.pt = Math.max(ls, Math.min(eol(b.rope, ls), ls + col + (onHead ? delta : 0)));
}
CMD('org-promote-subtree', '', '', 'Promote the headline at point and its subtree by one level (M-h, <<).', () => { const b = cur(); changeLevel(b, headlineOrError(b), -1, true); return false; });
CMD('org-demote-subtree', '', '', 'Demote the headline at point and its subtree by one level (M-l, >>).', () => { const b = cur(); changeLevel(b, headlineOrError(b), 1, true); return false; });
CMD('org-promote', '', '', 'Promote the headline at point by one level, leaving its subtree alone.', () => { const b = cur(); changeLevel(b, headlineOrError(b), -1, false); return false; });
CMD('org-demote', '', '', 'Demote the headline at point by one level, leaving its subtree alone.', () => { const b = cur(); changeLevel(b, headlineOrError(b), 1, false); return false; });
L.alias('org-do-promote', 'org-promote'); L.alias('org-do-demote', 'org-demote');
/* evil-org's > and <: on headlines they change levels, COUNT times, elsewhere they shift the lines as
   evil-shift-right and evil-shift-left do (which take the count too). */
function orgShift(beg: number, end: number, type: SchemeValue, count: SchemeValue, delta: number) {
  const b = cur(), r = b.rope, s = beg - 1, e = end - 1;
  const heads: number[] = [];
  if (isOutline(b)) for (let ls = bol(r, s); ls < Math.max(e, s + 1); ls = eol(r, ls) + 1) { if (levelAt(b, ls)) heads.push(ls); if (eol(r, ls) >= r.length) break; }
  if (!heads.length) return L.call(delta > 0 ? 'evil-shift-right' : 'evil-shift-left', [beg, end, type, count === undefined ? false : count]);
  const pt = b.pt, times = Math.max(1, Number(count) || 1);
  for (let i = heads.length - 1; i >= 0; i--) for (let k = 0; k < times; k++) changeLevel(b, heads[i], delta, false);
  b.pt = Math.min(pt, b.rope.length);
  return false;
}
CMD('evil-org->', '<R><c>', 'BEG END TYPE &optional COUNT', 'Demote the headlines in the range, or indent its lines (>).', ([s, e, t, c]: SchemeValue[]) => orgShift(s as number, e as number, t, c, 1));
CMD('evil-org-<', '<R><c>', 'BEG END TYPE &optional COUNT', 'Promote the headlines in the range, or dedent its lines (<).', ([s, e, t, c]: SchemeValue[]) => orgShift(s as number, e as number, t, c, -1));
for (const n of ['evil-org->', 'evil-org-<']) L.put(intern(n), 'evil-operator', true);
/* Move a subtree past its next or previous sibling. The pieces are swapped with their newlines: the
   last subtree of the text carries the final newline, which stays at the end. The folds inside both
   pieces move with them. */
function moveSubtree(b: EdBuffer, dir: number) {
  const hs = headlineOrError(b), r = b.rope, level = levelAt(b, hs), eos = subtreeEnd(b, hs, level), pt = b.pt;
  let s1: number, e1: number, s2: number, e2: number;
  if (dir > 0) {
    const ns = eos + 1;
    if (ns >= r.length || levelAt(b, ns) !== level) signal('user-error', 'Cannot move past superior level or buffer limit');
    s1 = hs; e1 = eos; s2 = ns; e2 = subtreeEnd(b, ns, level);
  } else {
    let h = prevHeadline(b, hs);
    while (h >= 0 && levelAt(b, h) > level) h = prevHeadline(b, h);
    if (h < 0 || levelAt(b, h) < level) signal('user-error', 'Cannot move past superior level or buffer limit');
    s1 = h; e1 = hs - 1; s2 = hs; e2 = eos;
  }
  /* First piece S1..E1 (up to its newline at E1), second S2..E2; the result is second, newline, first. */
  const A = r.slice(s1, e1), tail = e2 === r.length && r.charAt(e2 - 1) === '\n' ? '\n' : '', B = r.slice(s2, e2 - tail.length);
  const F = foldsOf(b), moved: EdFold[] = [];
  if (F) for (const f of F) {
    if (f.s >= s2 && f.e <= e2) moved.push({ s: f.s - s2 + s1, e: Math.min(f.e - s2, B.length) + s1 });
    else if (f.s >= s1 && f.e <= e1) moved.push({ s: f.s - s1 + s1 + B.length + 1, e: f.e - s1 + s1 + B.length + 1 });
  }
  Ed.replaceText(b, s1, e2, B + '\n' + A + tail);
  for (const f of moved) addFold(b, f.s, f.e);
  b.pt = dir > 0 ? s1 + B.length + 1 + (pt - hs) : s1 + (pt - hs);
}
CMD('org-move-subtree-down', '', '', 'Move the subtree at point past the next one of its level (M-j).', () => { moveSubtree(cur(), 1); return false; });
CMD('org-move-subtree-up', '', '', 'Move the subtree at point before the previous one of its level (M-k).', () => { moveSubtree(cur(), -1); return false; });

/* M-RET: a new headline or list item. From Normal state, evil-org first goes to the end of the line and ends in Insert state. */
CMD('org-meta-return', '', '', 'Insert a new headline or list item after this one, or split the line at point (M-RET).', () => {
  const b = cur(), r = b.rope, st = EC.stateOf(b), star = starOf(b);
  const fromNormal = st === 'normal' || st === 'motion' || st === 'visual';
  if (fromNormal) { if (st === 'visual') EC.setState(b, 'normal'); b.pt = eol(r, b.pt); }
  const ls = bol(r, b.pt), le = eol(r, ls), line = r.slice(ls, le), level = levelAt(b, ls);
  let m;
  if (level) {
    const stars = star.repeat(level) + ' ';
    if (b.pt === ls) { Ed.replaceText(b, ls, ls, stars + '\n'); b.pt = ls + stars.length; }
    else if (b.pt < le) { const rest = r.slice(b.pt, le); Ed.replaceText(b, b.pt, le, '\n' + stars + rest); b.pt = b.pt + 1 + stars.length; }
    else { const e = entryEnd(b, ls); Ed.replaceText(b, e, e, '\n' + stars); b.pt = e + 1 + stars.length; }
  } else if ((m = /^(\s*)([-+*]|\d+[.)])(\s+)(\[[ xX-]\]\s+)?/.exec(line)) && (m[1] || m[2] !== star)) {
    const bullet = /^\d/.test(m[2]) ? String(parseInt(m[2], 10) + 1) + m[2].slice(-1) : m[2];
    const head = m[1] + bullet + ' ' + (m[4] ? '[ ] ' : '');
    const rest = b.pt < le ? r.slice(b.pt, le) : '';
    Ed.replaceText(b, b.pt, le, '\n' + head + rest); b.pt = b.pt + 1 + head.length;
  } else {
    const hs = headlineBefore(b, ls), stars = star.repeat(hs === null ? 1 : levelAt(b, hs)) + ' ';
    const rest = b.pt < le ? r.slice(b.pt, le) : '';
    Ed.replaceText(b, b.pt, le, '\n' + stars + rest); b.pt = b.pt + 1 + stars.length;
  }
  if (fromNormal) EC.enterInsert(b, 1, false);
  return false;
});
CMD('org-insert-heading', '', '', 'Insert a new headline after the current entry.', () => L.call('org-meta-return', []));
CMD('org-insert-todo-heading', '', '', 'Insert a new TODO headline after the current entry (M-S-RET).', () => {
  const b = cur(); L.call('org-meta-return', []);
  const ls = bol(b.rope, b.pt); if (levelAt(b, ls)) { const kw = todoKeywords().todo[0] || 'TODO'; Ed.insertText(b, kw + ' '); }
  return false;
});

/* Checkboxes: - [ ] item, with the parent's [n/m] or [n%] cookie kept up to date. */
const ITEM_RE = /^(\s*)([-+*]|\d+[.)])(\s+)(\[([ xX-])\]\s*)?/;
function itemAt(b: EdBuffer, ls: number) { const r = b.rope, le = eol(r, ls), m = ITEM_RE.exec(r.slice(ls, le)); return m && (m[1] || m[2] !== starOf(b)) ? { ls, le, indent: m[1].length, bullet: m[2], box: m[5], boxPos: m[4] ? ls + m[1].length + m[2].length + m[3].length : -1, headLen: m[0].length } : null; }
function updateCookie(b: EdBuffer, ls: number) {
  const r = b.rope, it = itemAt(b, ls);
  const indent = it ? it.indent : 0;
  /* The parent: the nearest item above with less indentation, else the headline of the entry. */
  let p = ls, parent: { ls: number; head: true } | { ls: number; head: false; indent: number } | null = null;
  while (p > 0) {
    p = bol(r, p - 1);
    if (levelAt(b, p)) { parent = { ls: p, head: true }; break; }
    const pit = itemAt(b, p);
    if (pit && pit.indent < indent) { parent = { ls: p, head: false, indent: pit.indent }; break; }
    if (!pit && r.slice(p, eol(r, p)).trim() === '') break;
  }
  if (!parent) return;
  const ple = eol(r, parent.ls), pline = r.slice(parent.ls, ple);
  const cm = /\[(\d*)\/(\d*)\]|\[(\d*)%\]/.exec(pline);
  if (!cm) return;
  const end = parent.head ? entryEnd(b, parent.ls) : r.length;
  let total = 0, done = 0, childIndent = -1;
  for (let q = ple + 1; q < end; q = eol(r, q) + 1) {
    if (levelAt(b, q) || (!parent.head && r.slice(q, eol(r, q)).trim() === '')) break;
    const ci = itemAt(b, q);
    if (!ci) { if (eol(r, q) >= r.length) break; continue; }
    if (!parent.head && ci.indent <= parent.indent) break;
    if (childIndent < 0) childIndent = ci.indent;
    if (ci.indent === childIndent && ci.box) { total++; if (ci.box !== ' ') done++; }
    if (eol(r, q) >= r.length) break;
  }
  const rep = cm[3] !== undefined ? `[${total ? Math.round(done * 100 / total) : 0}%]` : `[${done}/${total}]`;
  if (rep !== cm[0]) Ed.replaceText(b, parent.ls + cm.index, parent.ls + cm.index + cm[0].length, rep);
}
function toggleCheckbox(b: EdBuffer, ls: number, add: boolean) {
  const it = itemAt(b, ls);
  if (!it) return false;
  if (it.box === undefined) { if (!add) return false; Ed.replaceText(b, ls + it.headLen, ls + it.headLen, '[ ] '); }
  else Ed.replaceText(b, it.boxPos, it.boxPos + 3, it.box === ' ' ? '[X]' : '[ ]');
  updateCookie(b, ls);
  return true;
}
CMD('org-toggle-checkbox', '', '', 'Toggle the checkbox of the item at point, adding one when the item has none (C-c C-x C-b).', () => {
  const b = cur(), r = b.rope;
  if (EC.stateOf(b) === 'visual' && b.mark !== null) {
    const [s, e] = EC.visualRange(b, true);
    for (let ls = bol(r, s); ls < e; ls = eol(b.rope, ls) + 1) { toggleCheckbox(b, ls, true); if (eol(b.rope, ls) >= b.rope.length) break; }
    return false;
  }
  if (!toggleCheckbox(b, bol(r, b.pt), true)) signal('user-error', 'Not at a list item');
  return false;
});
CMD('org-ctrl-c-ctrl-c', '', '', 'Do what the context asks: finish a capture, toggle a checkbox, set the tags of a headline (C-c C-c).', () => {
  const b = cur(), ls = bol(b.rope, b.pt);
  if (b.capture) return L.call('org-capture-finalize', []);
  if (itemAt(b, ls) && itemAt(b, ls)!.box !== undefined) { toggleCheckbox(b, ls, false); return false; }
  if (levelAt(b, ls)) return L.call('org-set-tags-command', []);
  signal('user-error', 'C-c C-c can do nothing useful here');
});

/* Links. */
function linkAt(b: EdBuffer, p: number) {
  const r = b.rope, ls = bol(r, p), le = eol(r, p), line = r.slice(ls, le);
  const res: [RegExp, (m: RegExpExecArray) => { target: string; desc?: string }][] = isMd(b) ? [[/\[([^\]\n]*)\]\(([^)\n]+)\)/g, m => ({ target: m[2], desc: m[1] })]]
    : [[/\[\[([^\]\n]+)\](?:\[([^\]\n]*)\])?\]/g, m => ({ target: m[1], desc: m[2] })], [/<(https?:\/\/[^>\n]+)>/g, m => ({ target: m[1] })]];
  res.push([/\bhttps?:\/\/[^\s<>\]]+/g, m => ({ target: m[0] })]);
  for (const [re, mk] of res) { let m; re.lastIndex = 0; while ((m = re.exec(line))) { const s = ls + m.index, e = s + m[0].length; if (p >= s && p < e) return { s, e, ...mk(m) }; } }
  return null;
}
async function openLink(target: string) {
  let m;
  target = target.trim();
  if ((m = /^id:(.+)$/.exec(target))) { await ensureIndex(); const node = entryById(m[1].trim()); if (!node) signal('user-error', `Cannot find entry with ID "${m[1].trim()}"`); visitNode(node!); return; }
  if (/^https?:\/\//.test(target)) { const ok = Ed.host.openUrl(target); Ed.message(ok ? `Opened ${target}` : `Could not open ${target} (popup blocked?)`); return; }
  if ((m = /^file:(.+)$/.exec(target)) || (m = /^(.+\.(?:org|md|txt|scm))(::.*)?$/.exec(target))) {
    let name = m[1], search: string | null = null;
    const k = name.indexOf('::'); if (k >= 0) { search = name.slice(k + 2); name = name.slice(0, k); }
    if (m[2]) search = m[2].slice(2);
    const b = L.call('find-file', [name.replace(/^\.?\//, '')]);
    if (search && b instanceof Ed.Buffer) {
      const r = b.rope;
      if (/^\*/.test(search)) { const want = search.slice(1).trim(); for (let h = nextHeadline(b, 0); h >= 0; h = nextHeadline(b, eol(r, h) + 1)) if (headingInfo(b, h).title === want) { b.pt = h; reveal(b, h); break; } }
      else if (/^\d+$/.test(search)) b.pt = lineStartB(b, +search);
      else { const i = r.indexOf(search); if (i >= 0) { b.pt = i; reveal(b, i); } }
    }
    return;
  }
  if ((m = /^roam:(.+)$/.exec(target))) { await ensureIndex(); const node = nodeByTitle(m[1].trim()); if (!node) signal('user-error', `No roam node titled "${m[1].trim()}"`); visitNode(node!); return; }
  if (Ed.Store.get(target) !== null) { L.call('find-file', [target]); return; }
  await ensureIndex();
  const node = nodeByTitle(target);
  if (node) { visitNode(node); return; }
  signal('user-error', `No link found: ${target}`);
}
CMD('org-open-at-point', '', '', 'Open the link at point: id: links visit the roam node, file: links the file, https links a new tab (C-c C-o).', async () => {
  const b = cur(), lk = linkAt(b, b.pt);
  if (!lk) signal('user-error', 'No link found');
  await openLink(lk!.target); return false;
});
CMD('org-insert-link', async () => {
  const b = cur();
  let sel: { s: number; e: number; text: string } | null = null;
  if (EC.stateOf(b) === 'visual' && b.mark !== null) { const [s, e] = EC.visualRange(b, true); sel = { s, e, text: b.rope.slice(s, e) }; }
  const hist = ORG.linkHistory || (ORG.linkHistory = []);
  const link = await Ed.readMini('Link: ', '', () => [...hist, ...Ed.Store.list().map(f => 'file:' + f)], { kind: 'org-link', history: hist });
  const desc = await Ed.readMini('Description: ', sel ? sel.text : '', null, { kind: 'org-link-desc' });
  return [link, desc, sel ? sel.s + 1 : false, sel ? sel.e + 1 : false];
}, 'LINK DESCRIPTION &optional BEG END', 'Insert a link, [[LINK][DESCRIPTION]], replacing the text from BEG to END when given (C-c C-l).', ([link, desc, s, e]: SchemeValue[]) => {
  const b = cur(), md = isMd(b);
  const text = md ? `[${desc || link}](${link})` : desc ? `[[${link}][${desc}]]` : `[[${link}]]`;
  if (typeof s === 'number') { Ed.replaceText(b, s - 1, (e as number) - 1, text); b.pt = s - 1 + text.length; }
  else Ed.insertText(b, text);
  return false;
});

/* Planning lines: SCHEDULED: and DEADLINE: on the line after the headline. */
function planningLine(b: EdBuffer, hs: number) {
  const r = b.rope, ns = eol(r, hs) + 1;
  if (ns >= r.length) return null;
  const ne = eol(r, ns), line = r.slice(ns, ne);
  return /^\s*(SCHEDULED|DEADLINE|CLOSED):/.test(line) ? { s: ns, e: ne, line } : null;
}
function setPlanning(b: EdBuffer, hs: number, kind: string, tsText: string | null) {
  const r = b.rope, le = eol(r, hs), pl = planningLine(b, hs);
  keepingFolds(b, hs, subtreeEnd(b, hs), () => {
    if (pl) {
      const re = new RegExp('\\s*' + kind + ':\\s*[<[][^>\\]\\n]*[>\\]]');
      let line = pl.line;
      if (re.test(line)) line = tsText ? line.replace(re, m => (m.match(/^\s*/)![0]) + kind + ': ' + tsText) : line.replace(re, '');
      else if (tsText) line = line.trimEnd() + ' ' + kind + ': ' + tsText;
      if (line.trim() === '') Ed.replaceText(b, pl.s, Math.min(r.length, pl.e + 1), '');
      else if (line !== pl.line) Ed.replaceText(b, pl.s, pl.e, line);
    } else if (tsText) Ed.replaceText(b, le, le, '\n' + kind + ': ' + tsText);
  });
  autosave(b); indexDirty();
}
async function planningCommand(kind: string, prompt: string) {
  const b = cur(), hs = headlineOrError(b);
  if (E.prefixArg !== null && E.prefixArg !== undefined && E.prefixArg !== false) { setPlanning(b, hs, kind, null); Ed.message(`${kind} removed`); return false; }
  const d = await readDate(prompt, '');
  const text = stamp(d.date, true, !!d.time);
  setPlanning(b, hs, kind, text);
  Ed.message(`${kind}: ${text}`); return false;
}
CMD('org-schedule', '', '', 'Schedule the entry at point on a date read in the minibuffer, today by default; with C-u remove it (C-c C-s).', () => planningCommand('SCHEDULED', 'Schedule to (default today): '));
CMD('org-deadline', '', '', 'Set the deadline of the entry at point, today by default; with C-u remove it (C-c C-d).', () => planningCommand('DEADLINE', 'Deadline (default today): '));
CMD('org-time-stamp', '', '', 'Insert an active timestamp for a date read in the minibuffer, today by default (C-c .).', async () => {
  const d = await readDate('Date (default today): ', ''); Ed.insertText(cur(), stamp(d.date, true, !!d.time)); return false;
});
CMD('org-time-stamp-inactive', '', '', 'Insert an inactive timestamp [...] for a date read in the minibuffer (C-c !).', async () => {
  const d = await readDate('Date (default today): ', ''); Ed.insertText(cur(), stamp(d.date, false, !!d.time)); return false;
});

/* Tags. */
function tagsInBuffer(b: EdBuffer) {
  const out = new Set<string>(), re = /^\*+\s.*?\s(:[\w@#%:]+:)\s*$/gm; let m;
  const t = b.text;
  while ((m = re.exec(t))) for (const x of m[1].split(':')) if (x) out.add(x);
  if (ORG.ix) for (const f of ORG.ix.files.values()) for (const e of f.entries) for (const x of e.tags) out.add(x);
  return [...out].sort();
}
function setTags(b: EdBuffer, hs: number, tags: SchemeValue) {
  const info = headingInfo(b, hs), r = b.rope;
  const list = String(tags).split(/[\s:]+/).filter(Boolean);
  const tagStr = list.length ? ':' + list.join(':') + ':' : '';
  let rep = '';
  if (tagStr) {
    const col = Number(L.get('org-tags-column')) || -77, titleCol = Ed.column(r, info.titleEnd);
    const want = col < 0 ? -col - tagStr.length : col;
    rep = ' '.repeat(Math.max(1, want - titleCol)) + tagStr;
  }
  if (r.slice(info.titleEnd, info.le) !== rep) Ed.replaceText(b, info.titleEnd, info.le, rep);
  if (b.pt > eol(b.rope, hs)) b.pt = Math.min(b.pt, eol(b.rope, hs));
  autosave(b); indexDirty();
}
CMD('org-set-tags-command', async () => {
  const b = cur(), hs = headlineOrError(b), info = headingInfo(b, hs);
  return [await Ed.readMini('Tags: ', info.tags, () => tagsInBuffer(b), { kind: 'org-tags' })];
}, 'TAGS', 'Set the tags of the headline at point, given as :a:b: or a b (C-c C-q).', ([tags]: SchemeValue[]) => { const b = cur(); setTags(b, headlineOrError(b), tags); return false; });
D('org-get-tags', '', 'The tags of the headline at point as a list of strings.', () => { const b = cur(), hs = headlineBefore(b, b.pt); return hs === null ? NIL : listOf(headingInfo(b, hs).tagList); });

/* ---------- the index: headlines, planning, tags, ids and links of every Org file ----------
   orgParseFile is pure: its source is shipped to the worker pool (EdPool.define), so it uses nothing
   from the page. ITEM is {file, text, keywords, done} or {file, buf} (a buffer mirror for ctx.buffer). */
function orgParseFile(item: OrgParseItem, ctx?: { buffer?: (id: string | number) => unknown } | null): OrgParsed {
  const file = item.file, text = item.text != null ? item.text : (ctx && ctx.buffer ? ctx.buffer(item.buf!) as string : '');
  const md = /\.(md|markdown)$/i.test(file), star = md ? '#' : '*';
  const kwAll = item.keywords || ['TODO', 'NEXT', 'WAITING', 'HOLD', 'SOMEDAY', 'DONE', 'CANCELLED'], kwDone = item.done || ['DONE', 'CANCELLED'];
  const TS = /[<[](\d{4}-\d{2}-\d{2})(?: [^\s>\]]{1,3}\.?)?(?: (\d{1,2}:\d{2})(?:-\d{1,2}:\d{2})?)?(?: [+.]+(\d+)([hdwmy]))?(?: -\d+[hdwmy])?[>\]]/g;
  /* The repeater (+1w, ++1d, .+1m) of a timestamp match, or null. */
  const rep = (t: RegExpExecArray) => t[3] && +t[3] > 0 ? { n: +t[3], u: t[4] } : null;
  const LINK = /\[\[id:([^\]\n]+)\](?:\[([^\]\n]*)\])?\]|\]\(id:([^)\n]+)\)/g;
  const category = file.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
  const entries: OrgEntry[] = [], links: OrgLink[] = [];
  let title: string | null = null, id: string | null = null, tags: string[] = [], cur: OrgEntry | null = null, inFront = false, lineNo = 0, i = 0;
  const n = text.length;
  while (i <= n) {
    let j = text.indexOf('\n', i); if (j < 0) j = n;
    const line = text.slice(i, j); lineNo++;
    let m;
    if (lineNo === 1 && md && /^---\s*$/.test(line)) inFront = true;
    else if (inFront) {
      if (/^---\s*$/.test(line)) inFront = false;
      else if ((m = /^title:\s*(.+?)\s*$/.exec(line))) title = m[1].replace(/^["']|["']$/g, '');
      else if ((m = /^id:\s*(\S+)/.exec(line))) id = m[1];
      else if ((m = /^tags:\s*\[?(.*?)\]?\s*$/.exec(line))) tags = m[1].split(/[\s,]+/).map(s => s.replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    else if (line[0] === star && /^[*#]+[ \t]/.test(line)) {
      let k = 0; while (line[k] === star) k++;
      let rest = line.slice(k).trim(), todo: string | null = null, priority: string | null = null, etags: string[] = [];
      for (const w of kwAll) if (rest.startsWith(w) && (rest[w.length] === ' ' || rest.length === w.length)) { todo = w; rest = rest.slice(w.length).trim(); break; }
      if ((m = /^\[#([A-Z0-9])\]\s*/.exec(rest))) { priority = m[1]; rest = rest.slice(m[0].length); }
      if ((m = /\s+(:[\w@#%:]+:)\s*$/.exec(rest)) || (m = /^(:[\w@#%:]+:)$/.exec(rest))) { etags = m[1].split(':').filter(Boolean); rest = rest.slice(0, m.index).trim(); }
      cur = { file, pos: i, line: lineNo, level: k, todo, done: !!todo && kwDone.includes(todo), title: rest, tags: etags, priority, scheduled: null, deadline: null, closed: null, ts: [], id: null, category };
      entries.push(cur);
    }
    else if (!md && (m = /^#\+(\w+):\s*(.*?)\s*$/.exec(line)) && !cur) {
      const key = m[1].toLowerCase();
      if (key === 'title') title = m[2]; else if (key === 'filetags') tags = m[2].split(':').filter(Boolean); else if (key === 'category') { /* file category */ }
    }
    else if ((m = /^\s*:ID:\s+(\S+)/.exec(line))) { if (cur) cur.id = m[1]; else if (!id) id = m[1]; }
    else if (cur && /^\s*(SCHEDULED|DEADLINE|CLOSED):/.test(line)) {
      const re = /(SCHEDULED|DEADLINE|CLOSED):\s*([<[][^>\]\n]*[>\]])/g;
      while ((m = re.exec(line))) { TS.lastIndex = 0; const t = TS.exec(m[2]); if (t) cur[m[1].toLowerCase() as 'scheduled' | 'deadline' | 'closed'] = { date: t[1], time: t[2] || null, rep: rep(t) }; }
    }
    else if (cur && !/^\s*[:#]/.test(line)) {
      TS.lastIndex = 0;
      while ((m = TS.exec(line))) if (m[0][0] === '<') cur.ts.push({ date: m[1], time: m[2] || null, rep: rep(m) });
    }
    LINK.lastIndex = 0;
    while ((m = LINK.exec(line))) links.push({ to: (m[1] || m[3]).trim(), from: cur ? cur.id : null, file, pos: i + m.index, line: lineNo, ctx: line.trim().slice(0, 120) });
    if (j >= n) break;
    i = j + 1;
  }
  return { file, title: title || category, id, tags, entries, links };
}
if (globalThis.EdPool && EdPool.define) { try { EdPool.define('org-parse', orgParseFile, []); ORG.poolJob = true; } catch (e) { ORG.poolJob = false; } }
function indexDirty() { if (ORG.ix) ORG.ix.dirty = true; }
/* Every Org and Markdown file in the store, plus the open outline buffers (their text wins over the store). */
function indexSources() {
  const out = new Map<string, { file: string; b?: EdBuffer }>();
  for (const f of Ed.Store.list()) if (/\.(org|md|markdown)$/i.test(f)) out.set(f, { file: f });
  for (const b of E.buffers) if (isOutline(b) && b.mode !== 'org-roam-mode' && !b.capture && (b.file || /\.(org|md)$/i.test(b.name))) out.set(b.file || b.name, { file: b.file || b.name, b });
  return [...out.values()];
}
function refreshIndex() {
  const ix: OrgIndex = ORG.ix || (ORG.ix = { files: new Map(), dirty: true, built: 0 });
  if (ix.promise) return ix.promise;
  const kw = todoKeywords(), items: OrgParseItem[] = [], keep = new Map<string, OrgFileIx>(), bufs: EdBuffer[] = [];
  const pool = !!(globalThis.EdPool && EdPool.run as unknown && EdPool.map as unknown && ORG.poolJob);
  for (const src of indexSources()) {
    const old = ix.files.get(src.file);
    if (src.b) {
      if (old && old.bufId === src.b.id && old.ver === src.b.ver && old.kw === kw) { keep.set(src.file, old); continue; }
      items.push(pool ? { file: src.file, buf: src.b.id, keywords: kw.all, done: kw.done } : { file: src.file, text: src.b.text, keywords: kw.all, done: kw.done });
      bufs.push(src.b); items[items.length - 1].meta = { bufId: src.b.id, ver: src.b.ver };
    } else {
      const text = Ed.Store.get(src.file) ?? '';
      if (old && old.src === text && old.kw === kw) { keep.set(src.file, old); continue; }
      items.push({ file: src.file, text, keywords: kw.all, done: kw.done }); items[items.length - 1].meta = { src: text };
    }
  }
  const run = async () => {
    let results: OrgFileIx[] | null = null;
    const plain = items.map(({ file, text, buf, keywords, done }) => ({ file, text, buf, keywords, done }));
    if (items.length && pool) { try { results = await EdPool.map<OrgFileIx>('org-parse', plain, { buffers: bufs }); if (!Array.isArray(results) || results.length !== items.length) results = null; } catch (e) { results = null; } }
    if (!results) { const ctx = { buffer: (id: string | number) => { const b = E.buffers.find(x => x.id === id); return b ? b.text : ''; } }; results = plain.map(it => orgParseFile(it, ctx)); }
    results.forEach((res, i) => { Object.assign(res, items[i].meta); res.kw = kw; keep.set(items[i].file, res); });
    ix.files = keep; ix.dirty = false; ix.built = Date.now();
    buildNodes(ix);
  };
  ix.promise = run().finally(() => { ix.promise = null; });
  return ix.promise;
}
/* The index before a command uses it: refreshIndex keeps the files that did not change, so this is cheap. */
async function ensureIndex() { await refreshIndex(); return ORG.ix; }
function scheduleRefresh() {
  indexDirty();
  clearTimeout(ORG.refreshTimer);
  ORG.refreshTimer = setTimeout(() => { refreshIndex().then(() => { redrawRoamBuffer(); Ed.render(); }, () => {}); }, 300);
}
/* ---------- roam nodes and backlinks, from the index ---------- */
const roamDir = () => String(L.get('org-roam-directory') || 'roam/').replace(/\/?$/, '/');
function buildNodes(ix: OrgIndex) {
  const nodes: OrgNode[] = [], byId = new Map<string, OrgNode>(), byTitle = new Map<string, OrgNode>(), byFile = new Map<string, OrgNode>(), backlinks = new Map<string, OrgBacklink[]>(), ids = new Map<string, OrgNode>();
  /* Every :ID: of every indexed file, as org-id-locations: id: links resolve anywhere, roam or not. */
  for (const f of ix.files.values()) {
    if (f.id) ids.set(f.id, { id: f.id, title: f.title, file: f.file, pos: 0, level: 0, tags: f.tags.slice() });
    for (const e of f.entries) if (e.id) ids.set(e.id, { id: e.id, title: e.title, file: f.file, pos: e.pos, level: e.level, tags: [...f.tags, ...e.tags] });
  }
  ix.ids = ids;
  for (const f of ix.files.values()) {
    if (!f.file.startsWith(roamDir())) continue;
    const fn = { id: f.id, title: f.title, file: f.file, pos: 0, level: 0, tags: f.tags.slice() };
    nodes.push(fn); byFile.set(f.file, fn);
    for (const e of f.entries) if (e.id) nodes.push({ id: e.id, title: e.title, file: f.file, pos: e.pos, level: e.level, tags: [...f.tags, ...e.tags] });
  }
  for (const nd of nodes) { if (nd.id) byId.set(nd.id, nd); if (!byTitle.has(nd.title.toLowerCase())) byTitle.set(nd.title.toLowerCase(), nd); }
  for (const f of ix.files.values()) for (const l of f.links) {
    const src = (l.from && byId.get(l.from)) || byFile.get(f.file) || { id: null, title: f.title, file: f.file, pos: 0 };
    if (!backlinks.has(l.to)) backlinks.set(l.to, []);
    backlinks.get(l.to)!.push({ ...l, src });
  }
  nodes.sort((a, b) => a.title.localeCompare(b.title));
  ix.nodes = nodes; ix.byId = byId; ix.byTitle = byTitle; ix.byFile = byFile; ix.backlinks = backlinks;
}
const nodeById = (id: string) => (ORG.ix && ORG.ix.byId && ORG.ix.byId.get(id)) || null;
const entryById = (id: string) => (ORG.ix && ORG.ix.ids && ORG.ix.ids.get(id)) || nodeById(id);
const nodeByTitle = (t: SchemeValue) => (ORG.ix && ORG.ix.byTitle && ORG.ix.byTitle.get(String(t).toLowerCase())) || null;
function nodeLabels(ix: OrgIndex) {
  const labels: string[] = [], map = new Map<string, OrgNode>(), seen = new Map<string, boolean>();
  for (const nd of ix.nodes || []) { let l = nd.title; if (seen.has(l)) l = `${nd.title} (${nd.file})`; seen.set(l, true); labels.push(l); map.set(l, nd); }
  return { labels, map };
}
const nodeAnnotation = (map: Map<string, OrgNode>, l: string) => { const nd = map.get(l); return nd ? `${nd.file.padEnd(30)} ${nd.tags.map(t => ':' + t + ':').join('')}` : 'new note'; };
function visitNode(node: { file: string; pos: number }) {
  const b = L.call('find-file', [node.file]);
  if (b instanceof Ed.Buffer) { b.pt = node.pos ? Math.min(node.pos, b.rope.length) : 0; if (node.pos) reveal(b, b.pt); }
  return b;
}
/* The node that holds point: the headline with an :ID: around it, else the file. */
function nodeAtPoint(b: EdBuffer): OrgNode | null {
  if (!ORG.ix || !b.file) return null;
  const r = b.rope;
  for (let hs = headlineBefore(b, b.pt); hs !== null; hs = levelAt(b, hs) > 1 ? parentOf(b, hs) : null) {
    const end = entryEnd(b, hs), drawer = r.slice(eol(r, hs) + 1, Math.min(end, eol(r, hs) + 400));
    const m = /^\s*:ID:\s+(\S+)/m.exec(drawer);
    if (m && nodeById(m[1])) return nodeById(m[1]);
  }
  return ORG.ix.byFile!.get(b.file) || null;
}
function parentOf(b: EdBuffer, hs: number) { const level = levelAt(b, hs); let h = prevHeadline(b, hs); while (h >= 0 && levelAt(b, h) >= level) h = prevHeadline(b, h); return h < 0 ? null : h; }
const slugOf = (t: string) => t.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').toLowerCase();
function roamTemplates(varName: string) {
  return arr(L.get(varName) ?? NIL).map(t => {
    const a = arr(t); if (a.length < 4) return null;
    /* The target is the :target property, as org-roam 2 writes it, or the fourth element. */
    let target: SchemeValue = null;
    for (let i = 4; i < a.length; i++) if (a[i] instanceof Sym && (a[i] as SchemeSym).name === ':target') { target = a[i + 1]; break; }
    if (target === null && a.length > 4 && !(a[4] instanceof Sym)) target = a[4];
    const tg = target ? arr(target).map(x => sval(x)) : [];
    return { key: String(a[0]), desc: String(a[1]), type: sval(a[2]), template: String(a[3]), file: tg[1] || '', head: tg[2] || '' };
  }).filter(Boolean) as OrgRoamTemplate[];
}
/* Replace %U %<...> and the ${...} fields of a roam template. */
function fillRoam(s: string, fields: Record<string, string>, now: Date) {
  return s.replace(/\$\{(\w+)\}/g, (m, k) => fields[k] ?? '').replace(/%<([^>]+)>/g, (m, f) => strftime(f, now))
    .replace(/%U/g, stamp(now, false, true)).replace(/%u/g, stamp(now, false, false)).replace(/%T/g, stamp(now, true, true)).replace(/%t/g, stamp(now, true, false));
}
/* Write a new note from a roam template and return its node (the file is in the store, not yet visited). */
function writeNote(tpl: OrgRoamTemplate, title: string, now?: Date) {
  now = now || ORG.now();
  const id = uuid(), fields = { title, slug: slugOf(title), id };
  const file = roamDir() + fillRoam(tpl.file, fields, now);
  const head = fillRoam(tpl.head, fields, now);
  let body = fillRoam(tpl.template, fields, now);
  const cursor = body.indexOf('%?'); body = body.replace('%?', '');
  const pre = /\.md$/i.test(file) ? '' : `:PROPERTIES:\n:ID: ${id}\n:END:\n`;
  Ed.Store.set(file, pre + head + body);
  indexDirty();
  return { id, title, file, pos: 0, level: 0, tags: [], cursor: pre.length + head.length + (cursor < 0 ? body.length : cursor), created: true };
}
async function pickRoamTemplate() {
  const ts = roamTemplates('org-roam-capture-templates');
  if (!ts.length) signal('user-error', 'No org-roam-capture-templates');
  if (ts.length === 1) return ts[0];
  const k = await keyOf('Capture template: ' + ts.map(t => `[${t.key}] ${t.desc}`).join('  ') + ' ', ts.map(t => t.key));
  return ts.find(t => t.key === k)!;
}
async function createNote(title: string) { const tpl = await pickRoamTemplate(); return writeNote(tpl, title); }
/* Give NODE an :ID: (a file-level property drawer, or id: in Markdown front matter) when it has none. */
function ensureNodeId(node: { id: string | null; file: string; pos?: number }) {
  if (node.id) return node.id;
  const id = uuid(), vb = E.buffers.find(x => x.file === node.file), md = /\.md$/i.test(node.file);
  const text = vb ? vb.text : (Ed.Store.get(node.file) ?? '');
  let pos = 0, ins = `:PROPERTIES:\n:ID: ${id}\n:END:\n`;
  if (md) { if (/^---\n/.test(text)) { pos = 4; ins = `id: ${id}\n`; } else ins = `---\nid: ${id}\n---\n`; }
  if (vb) { const pt = vb.pt; Ed.replaceText(vb, pos, pos, ins); vb.pt = pt >= pos ? pt + ins.length : pt; autosave(vb); }
  else Ed.Store.set(node.file, text.slice(0, pos) + ins + text.slice(pos));
  node.id = id; node.pos = 0;
  if (ORG.ix && ORG.ix.byId) ORG.ix.byId.set(id, node as OrgNode);
  if (ORG.ix && ORG.ix.ids) ORG.ix.ids.set(id, node as OrgNode);
  indexDirty();
  return id;
}
CMD('org-roam-node-find', async () => {
  await ensureIndex();
  const { labels, map } = nodeLabels(ORG.ix!);
  return [await Ed.readMini('Node: ', '', () => labels, { kind: 'org-roam-node', annotate: l => nodeAnnotation(map, l) })];
}, 'TITLE', 'Visit the roam node TITLE; with no such node, make a note for it from a template (SPC n r f).', async ([title]: SchemeValue[]) => {
  await ensureIndex();
  const node = nodeLabels(ORG.ix!).map.get(title as string) || nodeByTitle(title);
  if (node) { visitNode(node); return false; }
  if (!String(title).trim()) signal('user-error', 'No title');
  const nd = await createNote(String(title).trim());
  const b = L.call('find-file', [nd.file]) as EdBuffer; b.pt = Math.min(nd.cursor, b.rope.length);
  Ed.message(`New note ${nd.file}`); return false;
});
CMD('org-roam-node-insert', async () => {
  const b = cur(); let sel = null;
  if (EC.stateOf(b) === 'visual' && b.mark !== null) { const [s, e] = EC.visualRange(b, true); sel = { s, e, text: b.rope.slice(s, e) }; }
  await ensureIndex();
  const { labels, map } = nodeLabels(ORG.ix!);
  const v = await Ed.readMini('Node: ', sel ? sel.text : '', () => labels, { kind: 'org-roam-node', annotate: l => nodeAnnotation(map, l) });
  return [v, sel ? sel.s + 1 : false, sel ? sel.e + 1 : false, sel ? sel.text : false];
}, 'TITLE &optional BEG END DESCRIPTION', 'Insert a link to the roam node TITLE, [[id:ID][Title]]; the selection, when there is one, becomes the description (SPC n r i).', async ([title, s, e, desc]: SchemeValue[]) => {
  const b = cur(); await ensureIndex();
  let node = nodeLabels(ORG.ix!).map.get(title as string) || nodeByTitle(title);
  if (!node) { if (!String(title).trim()) signal('user-error', 'No title'); node = await createNote(String(title).trim()); }
  const id = ensureNodeId(node);
  const text = isMd(b) ? `[${desc || node.title}](id:${id})` : `[[id:${id}][${desc || node.title}]]`;
  if (typeof s === 'number') { Ed.replaceText(b, s - 1, (e as number) - 1, text); b.pt = s - 1 + text.length; } else Ed.insertText(b, text);
  indexDirty(); return false;
});
CMD('org-roam-node-random', '', '', 'Visit a roam node chosen at random (SPC n r a).', async () => {
  await ensureIndex(); const nodes = ORG.ix!.nodes!;
  if (!nodes.length) signal('user-error', 'No roam nodes');
  visitNode(nodes[Math.floor(Math.random() * nodes.length)]); return false;
});
function dailiesTemplate() { const ts = roamTemplates('org-roam-dailies-capture-templates'); return ts[0] || { template: '* %<%H:%M> %?', file: '%<%Y-%m-%d>.org', head: '#+title: %<%Y-%m-%d>\n' }; }
function dailyFile(d: Date) { return roamDir() + String(L.get('org-roam-dailies-directory') || 'daily/').replace(/\/?$/, '/') + fillRoam(dailiesTemplate().file, {}, d); }
function gotoDaily(d: Date) {
  const file = dailyFile(d), tpl = dailiesTemplate();
  const now = ORG.now(), when = new Date(d.getFullYear(), d.getMonth(), d.getDate(), now.getHours(), now.getMinutes());
  let cursor = -1;
  if (Ed.Store.get(file) === null && !E.buffers.some(x => x.file === file)) {
    const head = fillRoam(tpl.head, {}, when);
    let body = fillRoam(tpl.template, {}, when); cursor = body.indexOf('%?'); body = body.replace('%?', '');
    const pre = `:PROPERTIES:\n:ID: ${uuid()}\n:END:\n`;
    Ed.Store.set(file, pre + head + body + (body.endsWith('\n') ? '' : '\n'));
    cursor = pre.length + head.length + (cursor < 0 ? body.length : cursor);
    indexDirty();
  }
  const b = L.call('find-file', [file]) as EdBuffer;
  if (cursor >= 0) b.pt = Math.min(cursor, b.rope.length);
  return b;
}
CMD('org-roam-dailies-goto-today', '', '', 'Visit today’s daily note, making it from the dailies template when it is new (SPC n r d t).', () => { gotoDaily(ORG.now()); return false; });
CMD('org-roam-dailies-goto-date', async () => [ymd((await readDate('Daily for date (default today): ', '')).date)], 'DATE', 'Visit the daily note of DATE, making it when it is new (SPC n r d d).', ([d]: SchemeValue[]) => { gotoDaily(fromYmd(str(d)) || ORG.now()); return false; });
L.alias('org-roam-dailies-capture-today', 'org-roam-dailies-goto-today');
/* :ID: properties. */
function propertyIdIn(b: EdBuffer, from: number, to: number) {
  const r = b.rope;
  if (from >= r.length || !/^\s*:PROPERTIES:\s*$/.test(r.slice(from, eol(r, from)))) return null;
  for (let q = eol(r, from) + 1; q < to; q = eol(r, q) + 1) {
    const line = r.slice(q, eol(r, q)), m = /^\s*:ID:\s+(\S+)/.exec(line);
    if (m) return { id: m[1] };
    if (/^\s*:END:\s*$/.test(line)) return { id: null, insertAt: q };
    if (eol(r, q) >= r.length) break;
  }
  return null;
}
function ensureHeadlineId(b: EdBuffer, hs: number) {
  const r = b.rope, pl = planningLine(b, hs), anchor = pl ? pl.e : eol(r, hs);
  const found = propertyIdIn(b, anchor + 1, entryEnd(b, hs));
  if (found && found.id) return found.id;
  const id = uuid();
  keepingFolds(b, hs, subtreeEnd(b, hs), () => {
    if (found) Ed.replaceText(b, found.insertAt!, found.insertAt!, `:ID: ${id}\n`);
    else Ed.replaceText(b, anchor, anchor, `\n:PROPERTIES:\n:ID: ${id}\n:END:`);
  });
  return id;
}
function ensureFileId(b: EdBuffer) {
  if (isMd(b)) { const node: { id: string | null; file: string } = { id: null, file: b.file || b.name }; ensureNodeId(node); return node.id!; }
  const found = propertyIdIn(b, 0, b.rope.length);
  if (found && found.id) return found.id;
  const id = uuid(), pt = b.pt;
  if (found) { Ed.replaceText(b, found.insertAt!, found.insertAt!, `:ID: ${id}\n`); }
  else { Ed.replaceText(b, 0, 0, `:PROPERTIES:\n:ID: ${id}\n:END:\n`); }
  void pt;
  return id;
}
CMD('org-id-get-create', '', '', 'Give the entry at point (or the file, above the first headline) an :ID: property, and return it (SPC m I).', () => {
  const b = cur(), hs = headlineBefore(b, b.pt);
  const id = hs === null ? ensureFileId(b) : ensureHeadlineId(b, hs);
  indexDirty(); Ed.message(id); return id;
});
D('org-id-get', '', 'The :ID: of the entry at point, or #f.', () => {
  const b = cur(), hs = headlineBefore(b, b.pt);
  const f = hs === null ? propertyIdIn(b, 0, b.rope.length) : propertyIdIn(b, (planningLine(b, hs) ? planningLine(b, hs)!.e : eol(b.rope, hs)) + 1, entryEnd(b, hs));
  return f && f.id ? f.id : false;
});
/* The backlinks buffer, in a side window on the right. */
function roamBufferText(node: OrgNode) {
  const ix = ORG.ix!, links = node.id ? (ix.backlinks!.get(node.id) || []) : [];
  const lines = [`#+title: ${node.title}`, `#+filetags: ${node.tags.map(t => ':' + t + ':').join('')}`, '', `* Backlinks (${links.length})`];
  for (const l of links) {
    const s = l.src, link = s.id ? `[[id:${s.id}][${s.title}]]` : `[[file:${s.file}][${s.title}]]`;
    lines.push(`** ${link}`, `   ${l.ctx}`);
  }
  return lines.join('\n') + '\n';
}
function redrawRoamBuffer() {
  const rb = Ed.getBuffer('*org-roam*'); if (!rb || !Ed.windowFor(rb) || !ORG.ix || !ORG.ix.byFile) return;
  const w = E.win, node = w && w !== rb ? nodeAtPoint(w) : rb.roamNode as OrgNode | undefined;
  if (!node) return;
  const text = roamBufferText(node);
  if (rb.text !== text || rb.roamNode !== node) { rb.text = text; rb.pt = Math.min(rb.pt, rb.rope.length); rb.modified = false; rb.undo = []; rb.redo = []; rb.roamNode = node; }
}
CMD('org-roam-buffer-toggle', '', '', 'Show the backlinks of the node at point in a side window, or hide that window (C-c n l).', async () => {
  const rb0 = Ed.getBuffer('*org-roam*'), w0 = rb0 && Ed.windowFor(rb0);
  if (w0) { if (Ed.windowList().length > 1) Ed.deleteWindow(w0); else L.call('quit-window', []); return false; }
  const b = cur(); await ensureIndex();
  const node = nodeAtPoint(b);
  if (!node) signal('user-error', 'Not in a roam node');
  const rb = Ed.getBufferCreate('*org-roam*');
  rb.mode = 'org-roam-mode'; rb.readOnly = true; rb.evilState = 'motion';
  rb.text = roamBufferText(node!); rb.pt = 0; rb.modified = false; rb.undo = []; rb.redo = []; rb.roamNode = node;
  const sel = E.sel, nw = Ed.splitWindow(sel, 'right'); nw.popup = true;
  Ed.setWindowBuffer(rb, nw); Ed.selectWindow(sel!);
  return false;
});
D('org-roam-backlinks', '&optional ID', 'The backlinks of the node ID (default the node at point) as a list of (FILE . CONTEXT).', ([id]: SchemeValue[]) => {
  const ix = ORG.ix; if (!ix || !ix.backlinks) return NIL;
  const key = L.absent(id) ? (nodeAtPoint(cur()) || {} as Partial<OrgNode>).id : str(id);
  return listOf((ix.backlinks.get(key as string) || []).map(l => new L.Pair(l.file, l.ctx)));
});
/* Refresh the roam window when point moves to another node. */
const prevPost2 = H.postCommand;
H.postCommand = (def, b, failed) => {
  if (prevPost2) prevPost2(def, b, failed);
  if (E.depth > 0 || E.mini) return;
  const rb = Ed.getBuffer('*org-roam*');
  if (rb && E.win !== rb && ORG.ix && Ed.windowFor(rb)) { const node = nodeAtPoint(E.win!); if (node && node !== rb.roamNode) redrawRoamBuffer(); }
};

/* ---------- the agenda ---------- */
const lst = (v: SchemeValue) => (v instanceof L.Pair || v === NIL ? arr(v) : [v]).map(sval);
function plistToObj(pl: SchemeValue) { const o: Record<string, SchemeValue> = {}, a = arr(pl); for (let i = 0; i + 1 < a.length; i += 2) if (a[i] instanceof Sym) o[(a[i] as SchemeSym).name.replace(/^:/, '')] = a[i + 1]; return o; }
function groupSpecs() { return arr(L.get('org-super-agenda-groups') ?? NIL).map(plistToObj).filter(g => Object.keys(g).length); }
function inAgendaFiles(file: string) {
  const v = L.get('org-agenda-files');
  if (!v || v === NIL) return true;
  return arr(v).some(x => { const s = sval(x); return file === s || (s.endsWith('/') && file.startsWith(s)); });
}
function agendaEntries(ix: OrgIndex) {
  const out: OrgAgendaEntry[] = [];
  for (const f of ix.files.values()) if (/\.org$/i.test(f.file) && inAgendaFiles(f.file)) for (const e of f.entries) out.push({ ...e, fileTags: f.tags, allTags: [...f.tags, ...e.tags] });
  return out;
}
/* org-super-agenda: the selectors of a group are ORed; an item goes to the first group that takes it. */
function selectorMatch(g: Record<string, SchemeValue>, it: OrgAgendaItem, today: string) {
  const e = it.entry, checks: boolean[] = [];
  const when = (v: SchemeValue, d: OrgTs | null) => { const s = sval(v); if (!d) return false; if (s === 't') return true; const k = dayDiff(d.date, today); return s === 'past' ? k < 0 : s === 'today' ? k === 0 : s === 'future' ? k > 0 : false; };
  if ('deadline' in g) checks.push(when(g.deadline, e.deadline));
  if ('scheduled' in g) checks.push(when(g.scheduled, e.scheduled));
  if ('todo' in g) checks.push(g.todo === true || sval(g.todo) === 't' ? !!e.todo && !e.done : lst(g.todo).includes(e.todo as string));
  if ('tag' in g) checks.push(lst(g.tag).some(t => (e.allTags || e.tags).includes(t)));
  if ('file' in g) checks.push(lst(g.file).some(f => e.file === f || e.file.endsWith('/' + f)));
  if ('category' in g) checks.push(lst(g.category).includes(e.category));
  if ('priority' in g) checks.push(lst(g.priority).includes(e.priority as string));
  if ('regexp' in g) checks.push(lst(g.regexp).some(re => { try { return new RegExp(re).test(e.title); } catch (x) { return false; } }));
  if ('anything' in g) checks.push(true);
  return checks.some(Boolean);
}
function groupItems(items: OrgAgendaItem[], specs: Record<string, SchemeValue>[], today: string) {
  const groups = specs.map((g): OrgGroup => ({ name: g.name ? sval(g.name) : 'Group', items: [], order: typeof g.order === 'number' ? g.order : 0, spec: g }));
  const rest: OrgAgendaItem[] = [];
  for (const it of items) {
    let placed = false;
    for (const g of groups) if (selectorMatch(g.spec!, it, today)) { if (!truthy(g.spec!.discard)) g.items.push(it); placed = true; break; }
    if (!placed) rest.push(it);
  }
  const out = groups.filter(g => g.items.length);
  if (rest.length) out.push({ name: 'Other items', items: rest, order: 0 });
  return out.map((g, i) => [g, i] as [OrgGroup, number]).sort((a, b) => a[0].order - b[0].order || a[1] - b[1]).map(x => x[0]);
}
function agendaLine(it: OrgAgendaItem) {
  const e = it.entry, cat = (e.category + ':').padEnd(11), label = (it.label || '').padEnd(12), time = it.time ? it.time + ' ' : '';
  return `  ${cat} ${label} ${time}${e.todo ? e.todo + ' ' : ''}${e.priority ? '[#' + e.priority + '] ' : ''}${e.title}${e.tags.length ? '  :' + e.tags.join(':') + ':' : ''}`;
}
/* Times sort as minutes: 9:00 before 10:00. */
const minutes = (t: string | null | undefined) => { if (!t) return 1e9; const k = t.indexOf(':'); return +t.slice(0, k) * 60 + +t.slice(k + 1); };
const sortItems = (its: OrgAgendaItem[]) => its.sort((a, b) => a.sort - b.sort || (b.over || 0) - (a.over || 0) || minutes(a.time) - minutes(b.time) || a.entry.file.localeCompare(b.entry.file) || a.entry.line - b.entry.line);
/* Whether the day DS is the timestamp T's date or, with a repeater, one of its later occurrences. */
function occursOn(t: OrgTs, ds: string) {
  const k = dayDiff(ds, t.date);
  if (k === 0) return true;
  if (!t.rep || k < 0) return false;
  const { n, u } = t.rep;
  if (u === 'h' || u === 'd') return k % n === 0;
  if (u === 'w') return k % (7 * n) === 0;
  const a = fromYmd(t.date)!, d = fromYmd(ds)!;
  if (a.getDate() !== d.getDate()) return false;
  const months = (d.getFullYear() - a.getFullYear()) * 12 + d.getMonth() - a.getMonth();
  return u === 'm' ? months % n === 0 : months % 12 === 0 && (months / 12) % n === 0;
}
/* The day line, as org-agenda-format-date-aligned writes it: Mondays carry the ISO week. */
const dayHeader = (day: Date) => `${DAYS_LONG[day.getDay()].padEnd(10)} ${String(day.getDate()).padStart(2)} ${MONTHS[day.getMonth()]} ${day.getFullYear()}${day.getDay() === 1 ? ' W' + p2(isoWeek(day)) : ''}`;
function weekView(ix: OrgIndex, today: Date) {
  /* The week starts on org-agenda-start-on-weekday (Monday by default; #f starts it today). */
  const wd = L.get('org-agenda-start-on-weekday'), start = typeof wd === 'number' ? addDays(today, -((today.getDay() - wd + 7) % 7)) : today;
  const entries = agendaEntries(ix), lines = [`Week-agenda (W${p2(isoWeek(start))}):`], items: OrgViewItem[] = [], specs = groupSpecs(), warn = Number(L.get('org-deadline-warning-days')) || 14;
  const todayYmd = ymd(today);
  let todayHeader = '';
  for (let k = 0; k < 7; k++) {
    const day = addDays(start, k), ds = ymd(day), its: OrgAgendaItem[] = [], isToday = ds === todayYmd, future = ds > todayYmd;
    const header = dayHeader(day);
    if (isToday) todayHeader = header;
    for (const e of entries) {
      if (e.scheduled) {
        const d = dayDiff(ds, e.scheduled.date);
        if (d === 0 || (future && occursOn(e.scheduled, ds))) its.push({ entry: e, label: 'Scheduled:', time: e.scheduled.time, sort: 1 });
        else if (isToday && d > 0 && !e.done) its.push({ entry: e, label: `Sched. ${d}x:`, sort: 0, over: d });
      }
      if (e.deadline) {
        const d = dayDiff(e.deadline.date, ds);
        if (d === 0 || (future && occursOn(e.deadline, ds))) its.push({ entry: e, label: 'Deadline:', time: e.deadline.time, sort: 1 });
        else if (isToday && !e.done) { if (d < 0) its.push({ entry: e, label: `${-d} d. ago:`, sort: 0, over: -d }); else if (d <= warn) its.push({ entry: e, label: `In ${d} d.:`, sort: 2 }); }
      }
      for (const t of e.ts) if (occursOn(t, ds)) its.push({ entry: e, label: '', time: t.time, sort: 1 });
    }
    sortItems(its);
    lines.push(header);
    if (specs.length && its.length) for (const g of groupItems(its, specs, todayYmd)) { lines.push(' ' + g.name); for (const it of g.items) { items.push({ line: lines.length, it }); lines.push(agendaLine(it)); } }
    else for (const it of its) { items.push({ line: lines.length, it }); lines.push(agendaLine(it)); }
  }
  return { lines, items, todayHeader };
}
function todoView(ix: OrgIndex, today: Date) {
  const lines = ['Global list of TODO items of type: ALL'], items: OrgViewItem[] = [], specs = groupSpecs();
  const its = agendaEntries(ix).filter(e => e.todo && !e.done).map(e => ({ entry: e, label: '', sort: 0 }));
  if (specs.length) for (const g of groupItems(its, specs, ymd(today))) { lines.push(' ' + g.name); for (const it of g.items) { items.push({ line: lines.length, it }); lines.push(agendaLine(it)); } }
  else for (const it of its) { items.push({ line: lines.length, it }); lines.push(agendaLine(it)); }
  return { lines, items, todayHeader: '' };
}
async function showAgenda(view: string, keepLine?: number) {
  await refreshIndex();
  const today = ORG.now(), built = view === 'todo' ? todoView(ORG.ix!, today) : weekView(ORG.ix!, today);
  const b = Ed.getBufferCreate('*Org Agenda*');
  b.mode = 'org-agenda-mode'; b.readOnly = true; b.evilState = 'motion';
  b.text = built.lines.join('\n') + '\n';
  b.agenda = { view, items: built.items, byLine: new Map(built.items.map(x => [x.line, x.it])), todayHeader: built.todayHeader, win: b.agenda ? (b.agenda as OrgAgenda).win : null };
  b.modified = false; b.undo = []; b.redo = [];
  /* Point goes to today's line when the view shows it, as in Org, else to the first item. */
  const todayLine = built.todayHeader ? built.lines.indexOf(built.todayHeader) : -1;
  const first = todayLine >= 0 ? todayLine : built.items.length ? built.items[0].line : 0;
  b.pt = lineStartB(b, (keepLine && keepLine <= lineCountB(b) ? keepLine : first + 1));
  /* The agenda takes a window of its own below, and a popup window left from a jump out of it is reused. */
  if (!Ed.windowFor(b)) { (b.agenda as OrgAgenda).win = Ed.winConfig(); if (E.sel!.popup && Ed.windowList().length > 1) Ed.setWindowBuffer(b); else Ed.popToBuffer(b, true); }
  else Ed.selectWindow(Ed.windowFor(b)!);
  return b;
}
CMD('org-agenda', async () => [await keyOf('Agenda command: [a] Agenda for current week  [t] List of all TODO entries ', ['a', 't'])],
  'KEY', 'Show the agenda: a for the week (overdue items first on today), t for the TODO list (SPC m a).', async ([k]: SchemeValue[]) => {
  await showAgenda(String(k)[0] === 't' ? 'todo' : 'week'); return false;
});
CMD('org-agenda-list', '', '', 'Show the agenda of the week (from org-agenda-start-on-weekday).', async () => { await showAgenda('week'); return false; });
CMD('org-todo-list', '', '', 'Show every TODO entry, grouped.', async () => { await showAgenda('todo'); return false; });
function agendaItemAt(b: EdBuffer) { if (!b.agenda) signal('user-error', 'Not in the agenda'); const it = (b.agenda as OrgAgenda).byLine.get(lineNoB(b, b.pt) - 1); if (!it) signal('user-error', 'No item at point'); return it!; }
/* Find the entry's headline in buffer B again: at its indexed position when the line still matches, else by title. */
function locateEntry(b: OrgOutline, e: OrgEntry) {
  const r = b.rope;
  if (e.pos < r.length && levelAt(b, e.pos) && headingInfo(b, e.pos).title === e.title) return e.pos;
  for (let h = nextHeadline(b, 0); h >= 0; h = nextHeadline(b, eol(r, h) + 1)) if (headingInfo(b, h).title === e.title) return h;
  return Math.min(e.pos, r.length);
}
function gotoEntry(e: OrgEntry, other: boolean) {
  const ab = cur();
  let b = E.buffers.find(x => x.file === e.file);
  if (!b) { b = L.call('find-file', [e.file]) as EdBuffer; if (other) { Ed.setWindowBuffer(ab); } }
  const pos = locateEntry(b, e);
  if (other) Ed.popToBuffer(b, true); else Ed.setWindowBuffer(b);
  b.pt = pos; reveal(b, pos); E.recenter = 'center';
  try { L.call('pulse-line', []); } catch (x) { /* no pulse */ }
  return b;
}
CMD('org-agenda-switch-to', '', '', 'Go to the entry at point in its file (RET).', () => { gotoEntry(agendaItemAt(cur()).entry, false); return false; });
CMD('org-agenda-goto', '', '', 'Show the entry at point in another window (TAB).', () => { gotoEntry(agendaItemAt(cur()).entry, true); return false; });
CMD('org-agenda-todo', '', '', 'Cycle the TODO state of the entry at point, in its file (t).', async () => {
  const b = cur(), it = agendaItemAt(b), e = it.entry, kw = todoKeywords();
  const i = e.todo ? kw.all.indexOf(e.todo) : -1, next = i + 1 < kw.all.length ? kw.all[i + 1] : null;
  const vb = E.buffers.find(x => x.file === e.file);
  if (vb) { const pos = locateEntry(vb, e); withBuffer(vb, () => setTodo(vb, pos, next)); }
  else {
    const text = Ed.Store.get(e.file) ?? '';
    const tb = { rope: new globalThis.Rope(text), mode: 'org-mode' };
    const pos = locateEntry(tb, e), info = headingInfo(tb, pos);
    let a = pos + info.textStart, z = a; if (info.todo) { z = a + info.todo.length; while (text[z] === ' ') z++; }
    Ed.Store.set(e.file, text.slice(0, a) + (next ? next + ' ' : '') + text.slice(z));
    indexDirty();
  }
  await showAgenda((b.agenda as OrgAgenda).view, lineNoB(b, b.pt));
  Ed.message(next ? `TODO state: ${next}` : 'TODO state removed');
  return false;
});
CMD('org-agenda-redo', '', '', 'Rebuild the agenda from the files (r).', async () => { const b = cur(); if (!b.agenda) signal('user-error', 'Not in the agenda'); await showAgenda((b.agenda as OrgAgenda).view, lineNoB(b, b.pt)); return false; });
CMD('org-agenda-quit', '', '', 'Leave the agenda: close its window when it was opened for it, else bring the windows back (q).', () => {
  const b = cur(), w = Ed.windowFor(b), win = (b.agenda && (b.agenda as OrgAgenda).win) as EdWinConfig | null | undefined;
  if (b.agenda) (b.agenda as OrgAgenda).win = null;
  if (w && w.popup && Ed.windowList().length > 1) { Ed.deleteWindow(w); return false; }
  if (win) { try { Ed.restoreWinConfig(win); return false; } catch (e) { /* fall through */ } }
  return L.call('quit-window', []);
});
L.alias('org-agenda-exit', 'org-agenda-quit');
for (const n of ['org-agenda-switch-to', 'org-agenda-goto', 'org-agenda-todo', 'org-agenda-redo', 'org-agenda-quit', 'org-agenda']) L.put(intern(n), 'evil-repeat', intern('abort'));

/* ---------- capture ---------- */
function captureTemplates() {
  return arr(L.get('org-capture-templates') ?? NIL).map(t => {
    const a = arr(t); if (a.length < 5) return null;
    const o: OrgCaptureTemplate = { key: String(a[0]), desc: String(a[1]), type: sval(a[2]), target: arr(a[3]).map(x => sval(x)), template: String(a[4]) };
    for (let i = 5; i + 1 < a.length; i += 2) if (a[i] instanceof Sym) o[(a[i] as SchemeSym).name.replace(/^:/, '')] = a[i + 1];
    return o;
  }).filter(Boolean) as OrgCaptureTemplate[];
}
/* %? %U %u %T %t %i %a %x %<fmt> %(sexp) %^{Prompt}: the escapes the templates use. */
async function expandTemplate(tpl: string, ctx: { initial?: SchemeValue; annotation?: string; file?: string }, now?: Date) {
  now = now || ORG.now();
  const re = /%(\?|U|u|T|t|i|a|n|f|F|x|<([^>]+)>|\(|\^\{([^}]*)\})/g;
  let out = '', cursor = -1, i = 0, m;
  while ((m = re.exec(tpl))) {
    out += tpl.slice(i, m.index); i = m.index + m[0].length;
    const c = m[1];
    if (c === '?') cursor = out.length;
    else if (c === 'U') out += stamp(now, false, true); else if (c === 'u') out += stamp(now, false, false);
    else if (c === 'T') out += stamp(now, true, true); else if (c === 't') out += stamp(now, true, false);
    else if (c === 'i') out += ctx.initial || ''; else if (c === 'a') out += ctx.annotation || '';
    else if (c === 'f' || c === 'F') out += ctx.file || ''; else if (c === 'x') out += E.killRing[0] || '';
    else if (c === 'n') out += '';
    else if (c[0] === '<') out += strftime(m[2], now);
    else if (c === '(') {
      let depth = 0, k = m.index + 1;
      for (; k < tpl.length; k++) { if (tpl[k] === '(') depth++; else if (tpl[k] === ')') { depth--; if (!depth) break; } }
      let v; try { v = L.evalText(tpl.slice(m.index + 1, k + 1)); } catch (e) { v = ''; }
      out += v === false || v === undefined || v === L.UNSPEC ? '' : L.pr(v, false);
      i = k + 1; re.lastIndex = i;
    }
    else if (c[0] === '^') out += await Ed.readMini(m[3] + ': ', '', null, { kind: 'org-capture-prompt' });
  }
  out += tpl.slice(i);
  return { text: out, cursor: cursor < 0 ? out.length : cursor };
}
function captureAnnotation(b: EdBuffer) {
  if (!b || b.minibuf || b.capture) return '';
  if (isOrg(b) && b.file) { const hs = headlineBefore(b, b.pt); if (hs !== null) { const t = headingInfo(b, hs).title; return `[[file:${b.file}::*${t}][${t}]]`; } return `[[file:${b.file}][${b.file}]]`; }
  if (b.file) return `[[file:${b.file}::${lineNoB(b, b.pt)}][${b.file}]]`;
  return '';
}
function orgFile(name: string) { const dir = String(L.get('org-directory') || ''); return !dir || name.includes('/') ? name : dir.replace(/\/?$/, '/') + name; }
/* Put ENTRY into FILE under HEADLINE (made when missing), or at the end: in the visiting buffer when there is one, else in the store. */
function storeEntry(file: string, headline: string | null, entry: string, tpl: OrgCaptureTemplate) {
  const vb = E.buffers.find(x => x.file === file);
  const text = vb ? vb.text : (Ed.Store.get(file) ?? '');
  const tb = { rope: new globalThis.Rope(text), mode: 'org-mode' };
  const pad = '\n'.repeat(typeof tpl['empty-lines'] === 'number' ? tpl['empty-lines'] : 0);
  const ops: { pos: number; ins: string }[] = [];
  let pos = text.length;
  if (headline) {
    let hs = -1;
    for (let h = nextHeadline(tb, 0); h >= 0; h = nextHeadline(tb, eol(tb.rope, h) + 1)) if (headingInfo(tb, h).title === headline) { hs = h; break; }
    if (hs >= 0) pos = subtreeEnd(tb, hs);
    else { const add = (text.length && !text.endsWith('\n') ? '\n' : '') + `* ${headline}\n`; ops.push({ pos: text.length, ins: add }); pos = text.length + add.length; }
  }
  const before = pos === text.length && ops.length ? ops[0].ins : text.slice(0, pos);
  const ins = (before.length && !before.endsWith('\n') ? '\n' : '') + pad + entry + pad;
  ops.push({ pos, ins: ins.replace(/\n+$/, '\n') });
  let out = text;
  for (const op of ops.slice().reverse()) out = out.slice(0, op.pos) + op.ins + out.slice(op.pos);
  if (vb) {
    const pt = vb.pt;
    let shift = 0;
    for (const op of ops) { Ed.replaceText(vb, op.pos + shift, op.pos + shift, op.ins); shift += op.ins.length; }
    vb.pt = Math.min(pt, vb.rope.length);
    withBuffer(vb, () => L.call('save-buffer', []));
  } else Ed.Store.set(file, out);
  indexDirty();
}
CMD('org-capture', async () => {
  const ts = captureTemplates(); if (!ts.length) signal('user-error', 'No org-capture-templates');
  const b = cur(); let initial = '';
  if (EC.stateOf(b) === 'visual' && b.mark !== null) { const [s, e] = EC.visualRange(b, true); initial = b.rope.slice(s, e); }
  const k = await keyOf('Capture template: ' + ts.map(t => `[${t.key}] ${t.desc}`).join('  ') + ' ', ts.map(t => t.key));
  return [k, initial];
}, 'KEY &optional INITIAL', 'Write a note in a *Capture* buffer with the template KEY; C-c C-c files it, C-c C-k drops it (SPC o).', async ([key, initial]: SchemeValue[]) => {
  const tpl = captureTemplates().find(t => t.key === String(key)); if (!tpl) signal('user-error', `No capture template ${key}`);
  const origin = cur();
  const { text, cursor } = await expandTemplate(tpl!.template, { initial: initial || '', annotation: captureAnnotation(origin), file: origin.file || '' });
  const win = Ed.winConfig();
  const b = Ed.getBufferCreate('*Capture*');
  b.mode = 'org-mode'; b.readOnly = false; b.evilState = undefined; b.folds = [];
  b.text = text; b.pt = cursor; b.modified = false; b.undo = []; b.redo = [];
  b.capture = { tpl, win };
  Ed.popToBuffer(b, true);
  Ed.message('Capture buffer.  Finish C-c C-c, abort C-c C-k.');
  return false;
});
function endCapture(b: EdBuffer) {
  const win = b.capture!.win; b.capture = null;
  withBuffer(b, () => L.call('kill-buffer', [b]));
  try { Ed.restoreWinConfig(win); } catch (e) { /* windows changed meanwhile */ }
}
CMD('org-capture-finalize', '', '', 'File the capture buffer into its target and close it (C-c C-c).', () => {
  const b = cur(); if (!b.capture) signal('user-error', 'This does not seem to be a capture buffer for Org mode');
  const { tpl } = b.capture as { tpl: OrgCaptureTemplate }, entry = b.text.replace(/\s+$/, '') + '\n';
  const [kind, fileArg, headline] = tpl.target, file = orgFile(fileArg);
  storeEntry(file, kind === 'file+headline' ? headline : null, entry, tpl);
  endCapture(b);
  try { L.runHook('org-capture-after-finalize-hook'); } catch (e) { Ed.reportError(e); }
  Ed.message(`Capture stored in ${file}`); return false;
});
CMD('org-capture-kill', '', '', 'Drop the capture buffer (C-c C-k).', () => {
  const b = cur(); if (!b.capture) signal('user-error', 'This does not seem to be a capture buffer for Org mode');
  endCapture(b); Ed.message('Capture aborted'); return false;
});
for (const n of ['org-capture', 'org-capture-finalize', 'org-capture-kill', 'org-roam-node-find', 'org-roam-node-insert', 'org-roam-node-random', 'org-roam-dailies-goto-today', 'org-roam-dailies-goto-date', 'org-roam-buffer-toggle', 'org-id-get-create']) L.put(intern(n), 'evil-repeat', intern('abort'));

/* ---------- saving: after-save-hook, and the indexes follow the files ---------- */
for (const name of ['save-buffer', 'write-file']) {
  const f = L.toFn(intern(name));
  const g: SchemeProcedure = CMD(name, f.interactive as string, f.params as string, f.doc as string, (args: SchemeValue[]) => {
    const r = f(args), b = cur();
    try { L.runHook('after-save-hook'); } catch (e) { Ed.reportError(e); }
    if (isOutline(b) || /\.(org|md)$/i.test(b.file || '')) scheduleRefresh();
    return r;
  });
  if (f.props) g.props = new Map(f.props);
}

/* ---------- the look: org-modern through CSS classes ---------- */
const CSS = `
.text .oh { display: none; }
.text .cur.oh { display: inline; }
.text .ohs { color: transparent; }
.text .ob1, .text .ob2, .text .ob3, .text .ob4, .text .ob5 { color: transparent; position: relative; }
.text .ob1::after, .text .ob2::after, .text .ob3::after, .text .ob4::after, .text .ob5::after { position: absolute; left: 0; top: 0; color: var(--org-star, var(--kw)); }
.text .ob1::after { content: "◉"; } .text .ob2::after { content: "○"; } .text .ob3::after { content: "◈"; } .text .ob4::after { content: "◇"; } .text .ob5::after { content: "✳"; }
.text .cur.ob1::after, .text .cur.ob2::after, .text .cur.ob3::after, .text .cur.ob4::after, .text .cur.ob5::after { content: none; }
.text .ol1 { color: var(--org-l1, var(--kw)); font-weight: 700; }
.text .ol2 { color: var(--org-l2, var(--fn)); font-weight: 700; }
.text .ol3 { color: var(--org-l3, var(--st)); font-weight: 600; }
.text .ol4 { color: var(--org-l4, var(--dc)); font-weight: 600; }
.text .ol5 { color: var(--org-l5, var(--rb3)); font-weight: 600; }
.text .ox { color: var(--dim); }
.text .ot { color: var(--org-todo, var(--rb1)); font-weight: 700; box-shadow: inset 0 0 0 1px currentColor; border-radius: 3px; }
.text .od { color: var(--dim); font-weight: 600; text-decoration: line-through; box-shadow: inset 0 0 0 1px currentColor; border-radius: 3px; }
.text .og { color: var(--dim); background: var(--org-tag-bg, rgb(127 127 127 / 0.12)); border-radius: 3px; }
.text .ots { color: var(--co); background: var(--org-tag-bg, rgb(127 127 127 / 0.12)); border-radius: 3px; }
.text .osd { color: var(--dim); font-weight: 600; }
.text .obb { font-weight: 700; }
.text .oit { font-style: italic; }
.text .oul { text-decoration: underline; }
.text .ost { text-decoration: line-through; color: var(--dim); }
.text .ocd, .text .ovb { color: var(--st); background: var(--org-code-bg, rgb(127 127 127 / 0.12)); border-radius: 3px; }
.text .okw { color: var(--dim); }
.text .oti { color: var(--fg); font-weight: 700; }
.text .obd { color: var(--dim); }
.text .osb { background: var(--org-block-bg, rgb(127 127 127 / 0.08)); box-shadow: inset 2px 0 0 var(--rule); }
.text .oqb { font-style: italic; color: var(--dim); background: var(--org-block-bg, rgb(127 127 127 / 0.08)); box-shadow: inset 2px 0 0 var(--rule); }
.text .olk { color: var(--st); text-decoration: underline; }
.text .ocb { color: var(--co); font-weight: 600; }
.text .ocx { color: var(--dim); }
.text .odr { color: var(--dim); }
.text .opr { color: var(--rb1); font-weight: 700; }
.text .ocm { color: var(--cm); font-style: italic; }
.text .oli { color: var(--kw); font-weight: 700; }
.text .otb { color: var(--co); }
.text .ohr { color: var(--rule); }
.text .oe { color: var(--dim); }
.text .oad { font-weight: 700; color: var(--fg); }
.text .oat { font-weight: 700; color: var(--kw); }
.text .oag { font-weight: 700; color: var(--fn); }
.text .oac { color: var(--dim); }
.text .oaw { color: var(--co); }
.text .oao { color: var(--rb1); font-weight: 600; }
`;
Ed.host.page.addStyle('org-css', CSS);

globalThis.Org = { ORG, parseFile: orgParseFile, refreshIndex, ensureIndex, index: () => ORG.ix, ON, OC, lexSeg: H.lexSeg, parseDate, stamp, strftime, slugOf, todoKeywords,
  headlineBefore, nextHeadline, prevHeadline, subtreeEnd, entryEnd, children, headingInfo, levelAt, foldsOf, addFold, removeFolds, reveal, isHidden, groupItems, weekView, todoView, expandTemplate, nodeAtPoint, uuid,
  /* The class name of each character of the segment FROM..TO of B, for tests. */
  classesOf(b: EdBuffer, from: number, to: number) { const seg = b.rope.slice(from, to); const r = H.lexSeg!(b, from, to, seg) as OrgLex | null; return r ? Array.from(r.cls, c => ON[c]) : null; } };
/* the keyword sets of org-todo-keywords */
interface OrgKeywords { src: SchemeValue; all: string[]; todo: string[]; done: string[]; keys: Record<string, string> }
/* what the outline functions read: a buffer, or a stand-in over a file's text */
interface OrgOutline { rope: Rope; mode: string; ver?: number; _fences?: unknown }
interface OrgFences { ver: number | undefined; list: number[] }
interface OrgCycle { hs: number; status: 'children' | 'subtree' | 'folded' }
/* what hooks.lexSeg gives back, cached as b._olx */
interface OrgLex { ver: number; from: number; to: number; fv: number; kw: SchemeValue; mode: string; he: boolean; cls: Uint8Array; names: string[] }
interface OrgState {
  now: () => Date;
  dateHistory?: string[];
  linkHistory?: string[];
  pre?: { b: EdBuffer; pt: number } | null;
  poolJob?: boolean;
  ix?: OrgIndex;
  refreshTimer?: number;
}
/* the index: orgParseFile's records */
interface OrgTs { date: string; time: string | null; rep: { n: number; u: string } | null }
interface OrgEntry {
  file: string; pos: number; line: number; level: number; todo: string | null; done: boolean; title: string; tags: string[];
  priority: string | null; scheduled: OrgTs | null; deadline: OrgTs | null; closed: OrgTs | null; ts: OrgTs[]; id: string | null; category: string;
}
interface OrgLink { to: string; from: string | null; file: string; pos: number; line: number; ctx: string }
interface OrgParsed { file: string; title: string; id: string | null; tags: string[]; entries: OrgEntry[]; links: OrgLink[] }
/* an indexed file: the parse, and what it was parsed from */
interface OrgFileIx extends OrgParsed { bufId?: number | string; ver?: number; src?: string; kw?: OrgKeywords }
interface OrgParseItem {
  file: string; text?: string; buf?: number | string; keywords?: string[]; done?: string[];
  meta?: { bufId?: number | string; ver?: number; src?: string };
}
interface OrgNode { id: string | null; title: string; file: string; pos: number; level: number; tags: string[]; cursor?: number; created?: boolean }
interface OrgBacklink extends OrgLink { src: Pick<OrgNode, 'id' | 'title' | 'file' | 'pos'> }
interface OrgIndex {
  files: Map<string, OrgFileIx>;
  dirty: boolean;
  built: number;
  promise?: Promise<void> | null;
  ids?: Map<string, OrgNode>;
  nodes?: OrgNode[];
  byId?: Map<string, OrgNode>;
  byTitle?: Map<string, OrgNode>;
  byFile?: Map<string, OrgNode>;
  backlinks?: Map<string, OrgBacklink[]>;
}
interface OrgRoamTemplate { key: string; desc: string; type: string; template: string; file: string; head: string }
/* a capture template: its fields, and the options after the template by name */
interface OrgCaptureTemplate { key: string; desc: string; type: string; target: string[]; template: string; [opt: string]: SchemeValue }
/* the agenda */
interface OrgAgendaEntry extends OrgEntry { fileTags: string[]; allTags: string[] }
interface OrgAgendaItem { entry: OrgAgendaEntry; label: string; time?: string | null; sort: number; over?: number }
interface OrgGroup { name: string; items: OrgAgendaItem[]; order: number; spec?: Record<string, SchemeValue> }
interface OrgViewItem { line: number; it: OrgAgendaItem }
/* b.agenda of the *Org Agenda* buffer */
interface OrgAgenda { view: string; items: OrgViewItem[]; byLine: Map<number, OrgAgendaItem>; todayHeader: string; win: EdWinConfig | null }
})();
