// The notes parser (spec R11.2): one pure function, parseFile(id, text, grammar), from a note's text to its
// records (file, headings, blocks, links, tasks, cards) under the grammar of edwin/scm/notes-syntax.scm.
// It runs in-process (a buffer re-parse after an edit, the task editor) and as the body of a worker thread
// (R11.5): started with workerData.notesWorker, this module reads and parses files off the event loop,
// scans the tree and greps it, so the server never parses on its own thread except one buffer at a time.
// The parser knows nothing about the server, the file system layout or Edwin; it can move into EdPool's jobs.
import fs from 'node:fs';
import path from 'node:path';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import { lockdown } from './lockdown.mts';

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const NOTE_EXT = /\.(md|org)$/i;

/* ---------- the grammar ---------- */

/* The grammar alist of notes-grammar as a plain object: name -> regexp source string or list of strings. */
export type RawGrammar = Record<string, unknown>;
/* The compiled grammar (a type alias, so it is also a RawGrammar and compileGrammar takes either). */
export type Grammar = {
  compiled: true; source: RawGrammar;
  kws: string[]; done: Set<string>;
  task: RegExp;
  wiki: RegExp; ref: RegExp; inline: RegExp;
  anchor: RegExp; field: RegExp; priority: RegExp; planning: RegExp;
  mdHeading: RegExp; orgHeading: RegExp; setext: RegExp; listItem: RegExp;
  orgKeyword: RegExp; drawerBegin: RegExp; drawerEnd: RegExp; orgProperty: RegExp; orgTags: RegExp;
  inlineTag: RegExp; frontMatter: RegExp; frontKeys: Set<string>;
  fence: RegExp; cardField: string; cardKinds: Set<string>; cloze: RegExp;
  journalPath: RegExp; url: RegExp;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* Compile the grammar alist (as a plain object name -> source string or list) into RegExp objects. */
export function compileGrammar(g: RawGrammar): Grammar {
  if (g && g.compiled) return g as Grammar;
  const src = (name: string) => { const s = g[name]; if (typeof s !== 'string') throw new Error(`notes grammar: ${name} is not a regexp source`); return s; };
  const re = (name: string, flags = '') => new RegExp(src(name), flags);
  const list = (name: string): string[] => { const l = g[name]; if (!Array.isArray(l) || !l.every(x => typeof x === 'string')) throw new Error(`notes grammar: ${name} is not a list of strings`); return l; };
  const kws = list('task-keywords');
  return {
    compiled: true, source: g,
    kws, done: new Set(list('done-keywords')),
    /* A task line: indentation, a bullet (with an optional checkbox), stars or hashes, the keyword, the rest. */
    task: new RegExp(`^(\\s*)((?:[-*+]|\\d+[.)])\\s+(?:\\[[ xX-]\\]\\s+)?|\\*+\\s+|#{1,6}\\s+)(${kws.map(escapeRe).join('|')})(?:\\s+|$)(.*)$`),
    wiki: re('wiki-link', 'g'), ref: re('block-ref', 'g'), inline: re('inline-link', 'g'),
    anchor: re('anchor'), field: re('field'), priority: re('priority'), planning: re('planning', 'g'),
    mdHeading: re('md-heading'), orgHeading: re('org-heading'), setext: re('md-setext'), listItem: re('list-item'),
    orgKeyword: re('org-keyword'), drawerBegin: re('org-drawer-begin'), drawerEnd: re('org-drawer-end'), orgProperty: re('org-property'), orgTags: re('org-tags'),
    inlineTag: re('inline-tag', 'g'), frontMatter: re('front-matter'), frontKeys: new Set(list('front-matter-keys')),
    fence: re('fence'), cardField: String(g['card-field'] || 'card'), cardKinds: new Set(list('card-kinds')), cloze: re('cloze', 'g'),
    journalPath: re('journal-path'), url: re('url'),
  };
}

/* ---------- small helpers ---------- */

const indentOf = (l: string) => l.match(/^\s*/)![0].length;
const stripAnchor = (s: string, G: Grammar) => s.replace(G.anchor, '').trimEnd();
/* Values of a YAML-ish list: `[a, "b c"]`, `a, b`, `a b`. */
function splitList(s: string): string[] {
  const body = String(s).trim().replace(/^\[|\]$/g, '');
  if (/["']/.test(body)) { const out: string[] = []; const re = /"([^"]*)"|'([^']*)'|([^,\s][^,]*)/g; let m; while ((m = re.exec(body))) out.push((m[1] ?? m[2] ?? m[3]).trim()); return out.filter(Boolean); }
  return body.split(body.includes(',') ? ',' : /\s+/).map(x => x.trim()).filter(Boolean);
}
/* Org :ROAM_ALIASES: value: words, or quoted strings with spaces. */
function splitAliases(s: string): string[] {
  const out: string[] = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
const pushUniq = <T,>(arr: T[], x: T) => { if (x && !arr.includes(x)) arr.push(x); };
const trimBlank = (lines: string[]) => { const out = lines.slice(); while (out.length && !out[out.length - 1].trim()) out.pop(); while (out.length && !out[0].trim()) out.shift(); return out; };

/* ---------- the records (R11.2) ---------- */

export interface FileRec {
  id: string; path: string; title: string | null; kind: 'file'; tags: string[]; aliases: string[];
  props: Record<string, string>; body: string; mtime: number | null; line: number; orgId: string | null;
}
export interface HeadingRec {
  id: string; title: string; level: number; kind: 'heading'; tags: string[]; body: string; line: number; path: string; orgId: string | null;
}
export interface BlockRec { id: string; title: string; kind: 'block'; line: number; path: string }
export type LinkKind = 'wiki' | 'title' | 'file' | 'url' | 'ref';
export interface LinkRec {
  src: string; srcFile: string; dst: string; dstFile: string | null; kind: LinkKind; label: string | null; line: number; path: string;
}
/* The planning keys of a task line (the grammar's planning regexp names them; group 1, lowercased). */
export type PlanningKey = 'scheduled' | 'deadline' | 'closed';
export interface TaskRec {
  id: string; node: string; kw: string; title: string; priority: string | null;
  scheduled: string | null; deadline: string | null; closed: string | null;
  tags: string[]; session: string | null; dispatched: string | null; target: string | null; prompt: string;
  path: string; line: number; endLine: number; fields: Record<string, string>;
}
interface CardCommon {
  deck: string | null; title: string; props: Record<string, string>; body: string; status: string; src: string;
  file: string; path: string; line: number;
}
/* A basic or reverse card, or one of another card kind of the grammar. */
export interface FrontBackCard extends CardCommon { id: string; kind: string; front: string; back: string; extra: string }
export interface ClozeCard extends CardCommon { id: string; kind: 'cloze'; text: string; cloze: number; extra: string }
export type CardRec = FrontBackCard | ClozeCard;
export interface ParseResult { file: FileRec; headings: HeadingRec[]; blocks: BlockRec[]; links: LinkRec[]; tasks: TaskRec[]; cards: CardRec[] }

/* Classify a link target as the index knows it (R11.2): wiki, title (an id: link), file, url. */
function linkKind(target: string, G: Grammar): LinkKind {
  if (/^id:/i.test(target)) return 'title';
  if (/^file:/i.test(target)) return 'file';
  if (G.url.test(target)) return 'url';
  if (NOTE_EXT.test(target.split('#')[0])) return 'file';
  return 'wiki';
}

/* ---------- the parser ---------- */

/* Parse TEXT of the note ID (its notesDir-relative path) under GRAMMAR (compiled or raw). The result is
   {file, headings, blocks, links, tasks, cards}; every id is built from ID as R11.2 says. */
export function parseFile(id: string, text: string, grammar: RawGrammar): ParseResult {
  const G = compileGrammar(grammar);
  const isOrg = /\.org$/i.test(id);
  const lines = text.split('\n');
  const n = lines.length;
  const base = path.basename(id).replace(/\.[^.]+$/, '');
  const file: FileRec = { id, path: id, title: null, kind: 'file', tags: [], aliases: [], props: {}, body: trimBlank(lines.slice(0, 12)).join('\n'), mtime: null, line: 1, orgId: null };
  const headings: HeadingRec[] = [], blocks: BlockRec[] = [], links: LinkRec[] = [], tasks: TaskRec[] = [], cards: CardRec[] = [];
  const fenced = new Set<number>();
  let inFront = false, inFence = false, inDrawer = false, cur: HeadingRec | null = null, firstHeadingTitle: string | null = null;
  let taskUntil = -1;   // the last line (index) of the task whose continuation we are inside

  const headingOf = (line: string, i: number): { level: number; text: string; setext: boolean } | null => {
    let m;
    if (isOrg) { m = G.orgHeading.exec(line); return m ? { level: m[1].length, text: m[2], setext: false } : null; }
    m = G.mdHeading.exec(line);
    if (m) return { level: m[1].length, text: m[2], setext: false };
    /* Setext: a text line over === or --- (not a list item, not blank). */
    if (i + 1 < n && line.trim() && !G.listItem.test(line) && !G.field.test(line) && G.setext.test(lines[i + 1]) && lines[i + 1].trim().length >= 3 && !/^\s/.test(line)) return { level: lines[i + 1].trim()[0] === '=' ? 1 : 2, text: line.trim(), setext: true };
    return null;
  };
  const isHeadingLine = (line: string, i: number) => !!headingOf(line, i);
  const addTag = (owner: { tags: string[] }, t: string) => pushUniq(owner.tags, t);
  /* Inline #tags: every one is a tag of the file; on a heading or task line also of that record. */
  const inlineTags = (s: string, owner: { tags: string[] } | null) => { G.inlineTag.lastIndex = 0; let m; while ((m = G.inlineTag.exec(s))) { addTag(file, m[1]); if (owner && owner !== file) addTag(owner, m[1]); } };

  /* The task at line I with head match M; scans its continuation. */
  const makeTask = (i: number, m: RegExpExecArray, node: string, headingTags: string[] | null): TaskRec => {
    const ln = i + 1, indent = m[1].length, isBullet = !(isOrg && /^\*+\s/.test(m[2])) && /^(?:[-*+]|\d+[.)])\s/.test(m[2]);
    let rest = m[4];
    let priority = null, pm = G.priority.exec(rest);
    if (pm) { priority = pm[1]; rest = (rest.slice(0, pm.index) + rest.slice(pm.index + pm[0].length)).trim(); }
    // The anchor follows any tags (anchorCard appends it), so it goes first.
    rest = stripAnchor(rest, G);
    const tm = G.orgTags.exec(rest); if (tm) rest = rest.slice(0, tm.index);
    rest = rest.trim();
    const t: TaskRec = { id: `${id}:${ln}`, node, kw: m[3], title: rest, priority, scheduled: null, deadline: null, closed: null, tags: [], session: null, dispatched: null, target: null, prompt: '', path: id, line: ln, endLine: ln, fields: {} };
    for (const x of headingTags || []) addTag(t, x);
    if (tm) for (const x of tm[1].split(':').filter(Boolean)) addTag(t, x);
    inlineTags(m[4], t);
    const body: string[] = [];
    for (let j = i + 1; j < n; j++) {
      const l = lines[j];
      if (!l.trim() || fenced.has(j) || isHeadingLine(l, j) || G.task.test(l)) break;
      if (isBullet && indentOf(l) <= indent) break;
      let pm2; G.planning.lastIndex = 0; let planned = false;
      while ((pm2 = G.planning.exec(l))) { t[pm2[1].toLowerCase() as PlanningKey] = pm2[2]; planned = true; }
      if (planned) { t.endLine = j + 1; continue; }
      if (isOrg && (G.drawerBegin.test(l) || G.drawerEnd.test(l))) { t.endLine = j + 1; continue; }
      let fm;
      if ((fm = G.field.exec(l))) t.fields[fm[1].toLowerCase()] = fm[2];
      else if (isOrg && (fm = G.orgProperty.exec(l))) t.fields[fm[1].toLowerCase()] = fm[2];
      else body.push(l.trim());
      t.endLine = j + 1;
    }
    t.session = t.fields.session ?? null; t.dispatched = t.fields.dispatched ?? null; t.target = t.fields.target ?? null;
    t.prompt = body.join('\n');
    return t;
  };

  for (let i = 0; i < n; i++) {
    const line = lines[i], ln = i + 1;
    let m;
    if (i === 0 && !isOrg && G.frontMatter.test(line)) { inFront = true; continue; }
    if (inFront) {
      if (G.frontMatter.test(line)) { inFront = false; continue; }
      if ((m = /^([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(line)) && G.frontKeys.has(m[1].toLowerCase())) {
        const key = m[1].toLowerCase(), val = m[2];
        if (key === 'title') file.title = val.replace(/^["']|["']$/g, '');
        else if (key === 'tags') for (const t of splitList(val)) addTag(file, t);
        else if (key === 'aliases' || key === 'alias') for (const a of splitList(val)) pushUniq(file.aliases, a);
        else if (key === 'id') file.orgId = val;
        file.props[key] = val;
      } else if ((m = /^\s*-\s+(.+?)\s*$/.exec(line))) {
        /* A YAML block list under tags: or aliases:. */
        const prev = Object.keys(file.props).pop();
        if (prev === 'tags') addTag(file, m[1].replace(/^["']|["']$/g, ''));
        else if (prev === 'aliases' || prev === 'alias') pushUniq(file.aliases, m[1].replace(/^["']|["']$/g, ''));
      }
      continue;
    }
    if (G.fence.test(line)) { inFence = !inFence; fenced.add(i); continue; }
    if (inFence) { fenced.add(i); continue; }
    if (isOrg) {
      if (G.drawerBegin.test(line)) { inDrawer = true; continue; }
      if (inDrawer) {
        if (G.drawerEnd.test(line)) { inDrawer = false; continue; }
        if ((m = G.orgProperty.exec(line))) {
          const owner = cur || file, key = m[1], val = m[2];
          if (key.toUpperCase() === 'ROAM_ALIASES') { if (owner === file) for (const a of splitAliases(val)) pushUniq(file.aliases, a); }
          else if (key.toUpperCase() === 'ID') owner.orgId = val;
          if (owner === file) file.props[key.toLowerCase()] = val;
        }
        continue;
      }
      if (!cur && (m = G.orgKeyword.exec(line))) {
        const key = m[1].toLowerCase(), val = m[2];
        if (key === 'title') file.title = val;
        else if (key === 'filetags') for (const t of val.split(':').filter(Boolean)) addTag(file, t);
        else if (key === 'alias' || key === 'roam_alias' || key === 'roam_aliases') for (const a of splitAliases(val)) pushUniq(file.aliases, a);
        else file.props[key] = val;
        continue;
      }
    }
    const am = G.anchor.exec(line);
    const anchor = am ? am[1] : null;
    const h = headingOf(line, i);
    let srcId = cur ? cur.id : id;
    if (h) {
      /* The anchor ends the line, after any org tags. */
      let text = stripAnchor(h.text, G), tags: string[] = [];
      const tm = G.orgTags.exec(text); if (tm) { tags = tm[1].split(':').filter(Boolean); text = text.slice(0, tm.index); }
      text = text.trim();
      const rec: HeadingRec = { id: `${id}#${ln}`, title: text, level: h.level, kind: 'heading', tags, body: trimBlank(lines.slice(i + (h.setext ? 2 : 1), i + (h.setext ? 2 : 1) + 5)).join('\n'), line: ln, path: id, orgId: null };
      inlineTags(h.text, rec);
      headings.push(rec); cur = rec; srcId = rec.id;
      if (firstHeadingTitle === null) firstHeadingTitle = text.replace(new RegExp(`^(?:${G.kws.map(escapeRe).join('|')})\\s+`), '') || text;
      if (anchor) { srcId = `${id}#^${anchor}`; blocks.push({ id: srcId, title: text, kind: 'block', line: ln, path: id }); }
      if (h.setext) fenced.add(i + 1);   // the underline is not content
    } else if (anchor) {
      let text = line.trim();
      const lm = G.listItem.exec(line); if (lm) text = lm[3];
      text = stripAnchor(text, G).trim();
      srcId = `${id}#^${anchor}`;
      blocks.push({ id: srcId, title: text, kind: 'block', line: ln, path: id });
    }
    if ((m = G.task.exec(line))) {
      const node = anchor ? `${id}#^${anchor}` : h ? cur!.id : (cur ? cur.id : id);
      const t = makeTask(i, m, node, h ? cur!.tags : null);
      tasks.push(t);
      taskUntil = Math.max(taskUntil, t.endLine - 1);
    } else if (!h && (m = G.field.exec(line))) {
      /* A key:: value line outside a task: a file property when no heading is open yet. */
      if (!cur && i > taskUntil) {
        const key = m[1].toLowerCase(), val = m[2];
        if (key === 'title' && !file.title) file.title = val;
        else if (key === 'tags') for (const t of splitList(val)) addTag(file, t);
        else if (key === 'alias' || key === 'aliases') for (const a of splitList(val)) pushUniq(file.aliases, a);
        file.props[key] = val;
      }
    } else if (!h) inlineTags(line, null);
    /* Links. */
    G.wiki.lastIndex = 0;
    while ((m = G.wiki.exec(line))) {
      const target = m[1].trim();
      if (!target) continue;
      links.push({ src: srcId, srcFile: id, dst: target, dstFile: null, kind: linkKind(target, G), label: (m[2] ?? m[3] ?? null), line: ln, path: id });
    }
    G.ref.lastIndex = 0;
    while ((m = G.ref.exec(line))) links.push({ src: srcId, srcFile: id, dst: m[1].trim(), dstFile: null, kind: 'ref', label: null, line: ln, path: id });
    G.inline.lastIndex = 0;
    while ((m = G.inline.exec(line))) {
      const target = m[2];
      if (G.url.test(target)) links.push({ src: srcId, srcFile: id, dst: target, dstFile: null, kind: 'url', label: m[1] || null, line: ln, path: id });
      else if (NOTE_EXT.test(target.split('#')[0])) links.push({ src: srcId, srcFile: id, dst: target, dstFile: null, kind: 'file', label: m[1] || null, line: ln, path: id });
    }
  }
  if (!file.title) file.title = (!isOrg && firstHeadingTitle) || base;

  /* Flashcards: a block whose fields hold `card:: kind` (the deck syntax of web/app.ts). */
  for (let i = 0; i < n; i++) {
    if (fenced.has(i)) continue;
    const fm = G.field.exec(lines[i]);
    if (!fm || fm[1].toLowerCase() !== G.cardField) continue;
    let j = i - 1;
    while (j >= 0 && G.field.test(lines[j]) && lines[j].trim()) j--;
    if (j < 0 || !lines[j].trim() || fenced.has(j)) continue;
    const head = lines[j], hh = headingOf(head, j), lm = hh ? null : G.listItem.exec(head), headIndent = indentOf(head);
    let end = j + 1;
    while (end < n && lines[end].trim() && !fenced.has(end) && !isHeadingLine(lines[end], end) && (!lm || indentOf(lines[end]) > headIndent)) end++;
    const props: Record<string, string> = {}, body: string[] = [];
    for (let k = j + 1; k < end; k++) { const f = G.field.exec(lines[k]); if (f) props[f[1].toLowerCase()] = f[2]; else body.push(lines[k].trim()); }
    let title = stripAnchor(hh ? hh.text : lm ? lm[3] : head.trim(), G);
    const tm = G.orgTags.exec(title); if (tm) title = title.slice(0, tm.index);
    const am = G.anchor.exec(head);
    title = title.trim();
    const km = G.task.exec(head); if (km) title = title.replace(new RegExp(`^${escapeRe(km[3])}\\s+`), '');
    const baseId = am ? `${id}#^${am[1]}` : `${id}#${j + 1}`;
    const kind = G.cardKinds.has(String(props[G.cardField]).toLowerCase()) ? String(props[G.cardField]).toLowerCase() : 'basic';
    const bodyText = body.join('\n');
    const common = { deck: props.deck ?? null, title, props, body: bodyText, status: props.status ?? 'active', src: lines.slice(j, end).join('\n'), file: id, path: id, line: j + 1 };
    if (kind === 'reverse') {
      cards.push({ ...common, id: baseId + '#fwd', kind: 'basic', front: title, back: props.back ?? '', extra: bodyText });
      cards.push({ ...common, id: baseId + '#rev', kind: 'reverse', front: props.back ?? '', back: title, extra: bodyText });
    } else if (kind === 'cloze') {
      const text = body.join(' ').replace(/\s+/g, ' ').trim();
      const nums: number[] = []; G.cloze.lastIndex = 0; let cm;
      while ((cm = G.cloze.exec(text))) pushUniq(nums, Number(cm[1]));
      nums.sort((a, b) => a - b);
      if (!nums.length) nums.push(1);
      for (const c of nums) cards.push({ ...common, id: `${baseId}#c${c}`, kind: 'cloze', text, cloze: c, extra: '' });
    } else cards.push({ ...common, id: baseId, kind, front: title, back: props.back ?? '', extra: bodyText });
    i = Math.max(i, end - 1);
  }
  return { file, headings, blocks, links, tasks, cards };
}

/* ---------- files and the tree (used by the worker, and by the module on the main thread) ---------- */

const decoder = new TextDecoder('utf-8', { fatal: true });

/* Read a note: {text, mtimeMs, size} or {skipped: 'big' | 'missing' | 'not_text' | 'error'}. */
export type SkipReason = 'big' | 'missing' | 'not_text' | 'error';
export type NoteRead =
  | { text: string; mtimeMs: number; size: number; skipped?: undefined }
  | { skipped: 'missing' | 'error' }
  | { skipped: 'big' | 'not_text'; mtimeMs: number; size: number };
export function readNote(abs: string): NoteRead {
  let st;
  try { st = fs.statSync(abs); } catch (e) { return { skipped: 'missing' }; }
  if (!st.isFile()) return { skipped: 'missing' };
  if (st.size > MAX_FILE_BYTES) return { skipped: 'big', mtimeMs: st.mtimeMs, size: st.size };
  let bytes;
  try { bytes = fs.readFileSync(abs); } catch (e) { return { skipped: e.code === 'ENOENT' ? 'missing' : 'error' }; }
  let text;
  try { text = decoder.decode(bytes); } catch (e) { return { skipped: 'not_text', mtimeMs: st.mtimeMs, size: st.size }; }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  if (text.includes('\r\n')) text = text.replace(/\r\n/g, '\n');
  return { text, mtimeMs: st.mtimeMs, size: st.size };
}

/* An ignore pattern of notes-index-ignore as a test on a relative path: `dir/` names a directory anywhere,
   `*` matches inside a segment, a pattern without / matches any segment. */
export type IgnoreTest = (rel: string, isDir?: boolean) => boolean;
export function ignoreMatcher(patterns: readonly unknown[] | null | undefined): IgnoreTest {
  const tests: Array<(rel: string, isDir: boolean) => boolean> = [];
  for (const p of patterns || []) {
    if (typeof p !== 'string' || !p) continue;
    const dirOnly = p.endsWith('/');
    const body = dirOnly ? p.slice(0, -1) : p;
    const re = new RegExp('^' + body.split('*').map(escapeRe).join('[^/]*') + '$');
    if (body.includes('/')) tests.push((rel, isDir) => re.test(rel) && (!dirOnly || isDir));
    else tests.push((rel, isDir) => { const segs = rel.split('/'); if (dirOnly) return segs.slice(0, -1).some(s => re.test(s)) || (isDir && re.test(segs[segs.length - 1])); return segs.some(s => re.test(s)); });
  }
  return (rel, isDir = false) => tests.some(t => t(rel, isDir));
}

/* Every *.md and *.org under ROOT (R11.1): no dot-directories, no symlinks out of ROOT, no file over 4 MiB,
   nothing matching IGNORE. Returns [{id, mtimeMs, size}] with notesDir-relative ids. */
export interface ScanEntry { id: string; mtimeMs: number; size: number }
export function scanTree(root: string, ignorePatterns: readonly unknown[] | null | undefined): ScanEntry[] {
  const ignored = ignoreMatcher(ignorePatterns);
  let realRoot;
  try { realRoot = fs.realpathSync.native(root); } catch (e) { return []; }
  const out: ScanEntry[] = [], seen = new Set([realRoot]), stack = [{ dir: root, rel: '' }];
  while (stack.length) {
    const { dir, rel } = stack.pop()!;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      const name = ent.name, r = rel ? rel + '/' + name : name, abs = path.join(dir, name);
      let isDir = ent.isDirectory(), isFile = ent.isFile();
      if (ent.isSymbolicLink()) {
        let real;
        try { real = fs.realpathSync.native(abs); } catch (e) { continue; }
        if (real !== realRoot && !real.startsWith(realRoot + '/')) continue;
        let st; try { st = fs.statSync(real); } catch (e) { continue; }
        isDir = st.isDirectory(); isFile = st.isFile();
        if (isDir) { if (seen.has(real)) continue; seen.add(real); }
      }
      if (isDir) {
        if (name.startsWith('.') || ignored(r, true)) continue;
        stack.push({ dir: abs, rel: r });
      } else if (isFile && NOTE_EXT.test(name) && !ignored(r, false)) {
        let st; try { st = fs.statSync(abs); } catch (e) { continue; }
        if (st.size > MAX_FILE_BYTES) continue;
        out.push({ id: r, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/* Grep TEXT of note ID with RE (global): hits as [path, line, column, text]. With EXCLUDELINKS, matches inside
   [[...]] and ((...)) do not count (unlinked mentions). */
export type GrepHit = [path: string, line: number, column: number, text: string];
export interface GrepOptions { excludeLinks?: boolean; wiki?: RegExp | null; ref?: RegExp | null; max?: number }
export function grepText(id: string, text: string, re: RegExp, { excludeLinks = false, wiki = null, ref = null, max = Infinity }: GrepOptions = {}, out: GrepHit[] = []): GrepHit[] {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const line = lines[i];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let spans: Array<[number, number]> | null = null;
    while ((m = re.exec(line))) {
      if (m[0] === '') { re.lastIndex++; continue; }
      if (excludeLinks && wiki) {
        if (!spans) { spans = []; for (const rx of [wiki, ref]) { if (!rx) continue; rx.lastIndex = 0; let w; while ((w = rx.exec(line))) spans.push([w.index, w.index + w[0].length]); } }
        if (spans.some(([a, b]) => m!.index >= a && m!.index < b)) continue;
      }
      out.push([id, i + 1, m.index, line]);
      if (out.length >= max) break;
    }
  }
  return out;
}

/* ---------- the worker ---------- */

/* The parse of one job item: {id, file} (read from disk) or {id, text} (a buffer's text). */
export interface ParseItem { id: string; file?: string; text?: string; mtimeMs?: number }
export interface ParsedFile { id: string; mtimeMs: number; size: number; rec: ParseResult; fromBuffer?: boolean; skipped?: undefined; error?: undefined }
export type ParseOutcome =
  | ParsedFile
  | { id: string; skipped: SkipReason; error?: undefined }
  | { id: string; error: string; skipped?: undefined };
function parseItem(item: ParseItem, G: Grammar): ParseOutcome {
  try {
    if (typeof item.text === 'string') {
      const rec = parseFile(item.id, item.text, G);
      rec.file.mtime = item.mtimeMs ?? null;
      return { id: item.id, mtimeMs: item.mtimeMs ?? -1, size: item.text.length, rec, fromBuffer: true };
    }
    const r = readNote(item.file!);
    if (r.skipped) return { id: item.id, skipped: r.skipped };
    const rec = parseFile(item.id, r.text, G);
    rec.file.mtime = r.mtimeMs;
    return { id: item.id, mtimeMs: r.mtimeMs, size: r.size, rec };
  } catch (e) { return { id: item.id, error: e.message }; }
}

/* The jobs the main thread posts (with a jobId) and the replies (notes.mts; the grammar job is not used there). */
export interface GrepFile { id: string; text?: string; file?: string }
export interface ParseJob { t: 'parse'; items: ParseItem[] }
export interface ScanJob { t: 'scan'; root: string; ignore: unknown[] }
export interface GrepJob { t: 'grep'; files: GrepFile[]; source: string; flags: string; excludeLinks: boolean; max: number }
export interface GrammarJob { t: 'grammar'; grammar: RawGrammar }
export type WorkerJob = (ParseJob | ScanJob | GrepJob | GrammarJob) & { jobId: number };
export interface ParsedReply { t: 'parsed'; jobId: number; results: ParseOutcome[] }
export interface ScannedReply { t: 'scanned'; jobId: number; files: ScanEntry[] }
export interface GreppedReply { t: 'grepped'; jobId: number; hits: GrepHit[] }
export interface ErrorReply { t: 'error'; jobId: number; error: string }
export type WorkerReply = ParsedReply | ScannedReply | GreppedReply | ErrorReply;
/* The one reply on the synchronous channel. */
export type SyncReply = { jobId: number; hits: GrepHit[]; error?: undefined } | { jobId: number; error: string; hits?: undefined };

if (!isMainThread && workerData && workerData.notesWorker) {
  lockdown();
  let G = compileGrammar(workerData.grammar);
  const { syncPort, signal }: { syncPort?: MessagePort; signal: Int32Array } = workerData;
  /* A grep job over MSG.files (live text or a file to read): the hits, at most MSG.max. */
  const grepJob = (msg: GrepJob) => {
    const re = new RegExp(msg.source, msg.flags.includes('g') ? msg.flags : msg.flags + 'g');
    const out: GrepHit[] = [];
    for (const f of msg.files) {
      if (out.length >= msg.max) break;
      const text = typeof f.text === 'string' ? f.text : (() => { const r = readNote(f.file!); return r.skipped ? null : r.text; })();
      if (text === null) continue;
      grepText(f.id, text, re, { excludeLinks: msg.excludeLinks, wiki: G.wiki, ref: G.ref, max: msg.max }, out);
    }
    return out;
  };
  parentPort!.on('message', (msg: WorkerJob) => {
    try {
      switch (msg.t) {
        case 'grammar': G = compileGrammar(msg.grammar); parentPort!.postMessage({ t: 'grammar', ok: true }); break;
        case 'parse': parentPort!.postMessage({ t: 'parsed', jobId: msg.jobId, results: msg.items.map(it => parseItem(it, G)) }); break;
        case 'scan': parentPort!.postMessage({ t: 'scanned', jobId: msg.jobId, files: scanTree(msg.root, msg.ignore) }); break;
        case 'grep': parentPort!.postMessage({ t: 'grepped', jobId: msg.jobId, hits: grepJob(msg) }); break; // a thread waits (R4.42)
        default: parentPort!.postMessage({ t: 'error', jobId: (msg as { jobId: number }).jobId, error: `unknown job ${(msg as { t: string }).t}` });
      }
    } catch (e) { parentPort!.postMessage({ t: 'error', jobId: msg.jobId, error: e.message }); }
  });
  /* The synchronous channel (callers outside a thread): the main thread posts a job, waits on SIGNAL and
     reads the one reply. */
  if (syncPort) syncPort.on('message', (msg: { t: string; jobId: number } & Partial<GrepJob>) => {
    let reply: SyncReply;
    try {
      if (msg.t === 'grep') reply = { jobId: msg.jobId, hits: grepJob(msg as GrepJob) };
      else reply = { jobId: msg.jobId, error: `unknown sync job ${msg.t}` };
    } catch (e) { reply = { jobId: msg.jobId, error: e.message }; }
    syncPort.postMessage(reply);
    Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
  });
}
