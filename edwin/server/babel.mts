// Babel: the block engine of notes (hypernotes H1, docs/HYPERNOTES.md; spec R10.8, R14.15, the R4.15
// amendment). One engine reads two syntaxes: Org's `#+begin_src lang :k v` with `#+name:` and `#+RESULTS:`,
// and markdown fences ```` ```lang {#id k=v} ```` with ```` ```result {of=id} ````. This module is the reader
// and the writer of block text: it finds source, data and result blocks in a note, merges the note's default
// header arguments into each block, expands noweb references, formats results and tangles. scm/babel.scm is
// the engine proper: which executor runs a block, the note environments, where a result goes, the commands.
//
// Primitives (server only, R4.49): %babel-blocks, %babel-data, %babel-result-text, %babel-tangle-files,
// %babel-write-file (blocking), %babel-note-buffer, %babel-expand-home. Nothing here evaluates anything: a block
// runs only when a command of babel.scm runs it (R14.15).
import path from 'node:path';
import { ProtoError } from './proto.mts';
import { jsonToScheme } from './threads.mts';
import { expandHome } from './paths.mts';
import type { Server, Lisp, SchemeValue } from './main.mts';
import type { SBuf, Moved } from './buffers.mts';
import type { SchemeGen } from './threads.mts';
import type { By } from './proto.mts';

type Scheme = Lisp['S'];
export type Syntax = 'markdown' | 'org';
/* A header argument's value: a string, or true for a bare flag (markdown `{noweb}`). */
export type AttrValue = string | true;
/* A block's stored result. form: how it is written (a markdown fence; Org `:` lines, a #+begin_… block, a table,
   or nothing after the #+RESULTS: line). */
export interface Result { begin: number; end: number; text: string; error: boolean; form: 'fence' | 'lines' | 'block' | 'table' | 'empty'; of: string | null }
export interface Block {
  kind: 'src' | 'data' | 'table';
  lang: string;
  id: string | null;
  attrs: Record<string, AttrValue>;
  vars: [string, string][];
  begin: number;            // 0-based offset of the block's first line (an Org #+name: line belongs to the block)
  end: number;              // offset after the closing line and its newline
  line: number;             // 1-based line of the opening fence or #+begin_src
  body: string;
  result: Result | null;
}
export interface Parsed { syntax: Syntax; blocks: Block[]; results: Result[] }

/* Fences whose text is data bound to the block's id (HYPERNOTES "The format"); nothing runs them. */
export const DATA_LANGS = new Set(['json', 'csv', 'tsv', 'sexp']);
/* Org writes results of this many lines or more as an example block (org-babel-min-lines-for-block-output). */
export const MIN_BLOCK_LINES = 10;
/* :tangle yes names the file after the note, with this extension per language. */
const TANGLE_EXT: Record<string, string> = { scheme: 'scm', sh: 'sh', bash: 'sh', zsh: 'sh', python: 'py', javascript: 'js', js: 'js', json: 'json', csv: 'csv', tsv: 'tsv', sexp: 'sexp' };
/* noweb values that expand references when a block runs, and when it is tangled (Org's :noweb). */
const NOWEB_EVAL = new Set(['yes', 'eval', 'no-export', 'strip-export', 'strip-tangle']);
const NOWEB_TANGLE = new Set(['yes', 'tangle', 'no-export', 'strip-export']);
const NOWEB_DEPTH = 64, NOWEB_MAX = 4 * 1024 * 1024;

export class BabelError extends Error {}

/* ---------- lines ---------- */
interface Line { text: string; start: number; end: number; next: number }
function linesOf(text: string): Line[] {
  const out: Line[] = [];
  let pos = 0;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const end = nl < 0 ? text.length : nl;
    out.push({ text: text.slice(pos, end), start: pos, end, next: nl < 0 ? text.length : nl + 1 });
    if (nl < 0) break;
    pos = nl + 1;
  }
  return out;
}
const blank = (s: string) => /^[ \t]*$/.test(s);
const onlyBlank = (text: string, a: number, b: number) => a <= b && /^[ \t\n]*$/.test(text.slice(a, b));

/* ---------- header arguments ---------- */
/* Tokens of an info string or header-argument list; double- or single-quoted runs stay one token (quotes kept). */
function tokens(s: string): string[] {
  const out: string[] = [];
  const re = /(?:[^\s"']+|"(?:[^"\\]|\\.)*"|'[^']*')+/g;
  for (let m; (m = re.exec(s));) out.push(m[0]);
  return out;
}
const unquote = (s: string) => (/^"(?:[^"\\]|\\.)*"$/.test(s) ? s.slice(1, -1).replace(/\\(.)/g, '$1') : /^'[^']*'$/.test(s) ? s.slice(1, -1) : s);
/* in= / :var items: `name=ref` or a bare `ref` that binds its own name. */
function varItems(s: string, sep: RegExp): [string, string][] {
  const out: [string, string][] = [];
  for (const it of s.split(sep).map(x => x.trim()).filter(Boolean)) {
    const i = it.indexOf('=');
    if (i > 0) out.push([it.slice(0, i).trim(), it.slice(i + 1).trim()]);
    else out.push([it, it]);
  }
  return out;
}
/* A markdown info string's braces: {#id .class key=value flag}. */
export function markdownAttrs(s: string | undefined): { id: string | null; classes: string[]; attrs: Record<string, AttrValue>; vars: [string, string][] } {
  const attrs: Record<string, AttrValue> = {}, classes: string[] = [];
  let id: string | null = null, vars: [string, string][] = [];
  for (const t of tokens(s || '')) {
    if (t[0] === '#' && t.length > 1) id = t.slice(1);
    else if (t[0] === '.' && t.length > 1) classes.push(t.slice(1));
    else {
      const i = t.indexOf('=');
      if (i > 0) { const k = t.slice(0, i), v = unquote(t.slice(i + 1)); if (k === 'in') vars = vars.concat(varItems(v, /,/)); else attrs[k] = v; }
      else attrs[t] = true;
    }
  }
  return { id, classes, attrs, vars };
}
/* Org header arguments: `:key value…` pairs (switches such as -n before the first key are ignored); :var
   may repeat and holds space- or comma-separated assignments. */
export function orgArgs(s: string): { attrs: Record<string, AttrValue>; vars: [string, string][] } {
  const attrs: Record<string, AttrValue> = {};
  let vars: [string, string][] = [], key: string | null = null, val: string[] = [];
  const flush = () => {
    if (key === null) return;
    const v = val.join(' ');
    if (key === 'var') vars = vars.concat(varItems(v, /[\s,]+(?=[^\s,=]+=)/));
    else if (key === 'session') attrs.env = unquote(v) || true;
    else attrs[key] = v === '' ? true : unquote(v);
    key = null; val = [];
  };
  for (const t of tokens(s)) {
    if (t[0] === ':' && t.length > 1) { flush(); key = t.slice(1).toLowerCase(); }
    else if (key !== null) val.push(t);
  }
  flush();
  return { attrs, vars };
}
/* Org's escaped lines in a block (a comma before * or #+), and the indentation the block's lines share. */
function orgBody(lines: string[]): string {
  const un = lines.map(l => l.replace(/^([ \t]*),(\*|#\+)/, '$1$2'));
  let min = Infinity;
  for (const l of un) if (!blank(l)) min = Math.min(min, /^[ \t]*/.exec(l)![0].length);
  return (min === Infinity || min === 0 ? un : un.map(l => l.slice(Math.min(min, /^[ \t]*/.exec(l)![0].length)))).join('\n');
}
const orgEscape = (l: string) => (/^[ \t]*(\*|#\+|,\*|,#\+)/.test(l) ? l.replace(/^([ \t]*)/, '$1,') : l);

/* ---------- the readers ---------- */
export function syntaxOf(name: string | null | undefined, mode?: string | null): Syntax {
  if (mode === 'org-mode' || (name && /\.org$/i.test(name))) return 'org';
  return 'markdown';
}
export function parse(text: string, syntax: Syntax): Parsed {
  return syntax === 'org' ? parseOrg(text) : parseMarkdown(text);
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s{`~]*)[ \t]*(?:\{([^}\n]*)\})?/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
function parseMarkdown(text: string): Parsed {
  const ls = linesOf(text);
  const blocks: Block[] = [], results: Result[] = [];
  const defaults: Record<string, AttrValue> = {};
  let i = 0;
  /* YAML front matter: `env:` names the note's environment. */
  if (ls.length > 1 && /^---[ \t]*$/.test(ls[0].text)) {
    let j = 1;
    while (j < ls.length && !/^(---|\.\.\.)[ \t]*$/.test(ls[j].text)) j++;
    if (j < ls.length) {
      for (const l of ls.slice(1, j)) { const m = /^env:[ \t]*(.*?)[ \t]*$/.exec(l.text); if (m && m[1]) defaults.env = unquote(m[1]); }
      i = j + 1;
    }
  }
  for (; i < ls.length; i++) {
    const m = FENCE_OPEN.exec(ls[i].text);
    if (!m) continue;
    const indent = m[1].length, fence = m[2];
    if (fence[0] === '`' && /`/.test(ls[i].text.slice(m[0].length))) continue;   // a backtick fence's info string has none
    let j = i + 1;
    for (; j < ls.length; j++) { const c = FENCE_CLOSE.exec(ls[j].text); if (c && c[1][0] === fence[0] && c[1].length >= fence.length) break; }
    const closed = j < ls.length;
    const bodyLines = ls.slice(i + 1, j).map(l => l.text.replace(new RegExp(`^ {0,${indent}}`), ''));
    const a = markdownAttrs(m[4]);
    const lang = (m[3] || a.classes[0] || '').toLowerCase();
    const end = closed ? ls[j].next : text.length;
    if (lang === 'result') {
      results.push({ begin: ls[i].start, end, text: bodyLines.join('\n'), error: a.attrs.error !== undefined, form: 'fence', of: typeof a.attrs.of === 'string' ? a.attrs.of : null });
    } else if (lang) {
      blocks.push({ kind: DATA_LANGS.has(lang) ? 'data' : 'src', lang, id: a.id, attrs: { ...defaults, ...a.attrs }, vars: a.vars, begin: ls[i].start, end, line: i + 1, body: bodyLines.join('\n'), result: null });
    }
    i = closed ? j : ls.length;
  }
  attach(text, blocks, results);
  return { syntax: 'markdown', blocks, results };
}

function parseOrg(text: string): Parsed {
  const ls = linesOf(text);
  const blocks: Block[] = [], results: Result[] = [];
  /* #+PROPERTY: header-args[:lang] … lines anywhere in the file are defaults for every block (or one language). */
  const global: Record<string, AttrValue> = {}, perLang: Record<string, Record<string, AttrValue>> = {};
  const globalVars: [string, string][] = [], perLangVars: Record<string, [string, string][]> = {};
  for (const l of ls) {
    const m = /^[ \t]*#\+property:[ \t]+header-args(?::([^\s+]+))?\+?[ \t]+(.*)$/i.exec(l.text);
    if (!m) continue;
    const a = orgArgs(m[2]);
    if (m[1]) { Object.assign(perLang[m[1].toLowerCase()] ||= {}, a.attrs); (perLangVars[m[1].toLowerCase()] ||= []).push(...a.vars); }
    else { Object.assign(global, a.attrs); globalVars.push(...a.vars); }
  }
  let name: string | null = null, header = '', affStart = -1;
  const reset = () => { name = null; header = ''; affStart = -1; };
  for (let i = 0; i < ls.length; i++) {
    const t = ls[i].text;
    let m: RegExpExecArray | null;
    if ((m = /^[ \t]*#\+name:[ \t]*(.*?)[ \t]*$/i.exec(t))) { if (affStart < 0) affStart = ls[i].start; name = m[1] || null; continue; }
    if ((m = /^[ \t]*#\+header:[ \t]*(.*)$/i.exec(t))) { if (affStart < 0) affStart = ls[i].start; header += ' ' + m[1]; continue; }
    if (/^[ \t]*#\+(caption|attr_\w+|plot|tblfm)\b/i.test(t)) { if (affStart < 0) affStart = ls[i].start; continue; }
    if ((m = /^[ \t]*#\+begin_src(?:[ \t]+(\S+))?(.*)$/i.exec(t))) {
      let j = i + 1;
      while (j < ls.length && !/^[ \t]*#\+end_src[ \t]*$/i.test(ls[j].text)) j++;
      const closed = j < ls.length;
      const lang = (m[1] || '').toLowerCase();
      const a = orgArgs(header + ' ' + (m[2] || ''));
      const attrs = { ...global, ...(perLang[lang] || {}), ...a.attrs };
      blocks.push({ kind: DATA_LANGS.has(lang) ? 'data' : 'src', lang, id: name, attrs, vars: [...globalVars, ...(perLangVars[lang] || []), ...a.vars], begin: affStart >= 0 ? affStart : ls[i].start, end: closed ? ls[j].next : text.length, line: i + 1, body: orgBody(ls.slice(i + 1, j).map(l => l.text)), result: null });
      i = closed ? j : ls.length; reset(); continue;
    }
    if ((m = /^[ \t]*#\+results(?:\[[^\]\n]*\])?:[ \t]*(.*?)[ \t]*$/i.exec(t))) {
      const r = orgResult(ls, i, m[1] || null);
      results.push(r.result);
      i = r.last; reset(); continue;
    }
    if (/^[ \t]*\|/.test(t) && name !== null) {
      let j = i;
      while (j + 1 < ls.length && /^[ \t]*\|/.test(ls[j + 1].text)) j++;
      blocks.push({ kind: 'table', lang: 'table', id: name, attrs: {}, vars: [], begin: affStart, end: ls[j].next, line: i + 1, body: ls.slice(i, j + 1).map(l => l.text).join('\n'), result: null });
      i = j; reset(); continue;
    }
    if ((m = /^[ \t]*#\+begin_(\w+)/i.exec(t))) {   // other blocks: skip their contents
      const endRe = new RegExp(`^[ \\t]*#\\+end_${m[1]}[ \\t]*$`, 'i');
      let j = i + 1;
      while (j < ls.length && !endRe.test(ls[j].text)) j++;
      i = j; reset(); continue;
    }
    reset();
  }
  attach(text, blocks, results);
  return { syntax: 'org', blocks, results };
}
/* The result after a #+RESULTS: line at index I: `:` lines, a #+begin_… block, a table, or nothing. A #+begin_src
   right below is the next source block, not this result (babel never writes a result as one). */
function orgResult(ls: Line[], i: number, of: string | null): { result: Result; last: number } {
  const begin = ls[i].start;
  let j = i + 1;
  if (j < ls.length && /^[ \t]*:( |$)/.test(ls[j].text)) {
    while (j + 1 < ls.length && /^[ \t]*:( |$)/.test(ls[j + 1].text)) j++;
    return { result: { begin, end: ls[j].next, text: ls.slice(i + 1, j + 1).map(l => l.text.replace(/^[ \t]*: ?/, '')).join('\n'), error: false, form: 'lines', of }, last: j };
  }
  let m: RegExpExecArray | null;
  if (j < ls.length && (m = /^[ \t]*#\+begin_(?!src\b)(\w+)/i.exec(ls[j].text))) {
    const endRe = new RegExp(`^[ \\t]*#\\+end_${m[1]}[ \\t]*$`, 'i');
    let k = j + 1;
    while (k < ls.length && !endRe.test(ls[k].text)) k++;
    const last = Math.min(k, ls.length - 1);
    return { result: { begin, end: ls[last].next, text: orgBody(ls.slice(j + 1, k).map(l => l.text)), error: m[1].toLowerCase() === 'error', form: 'block', of }, last };
  }
  if (j < ls.length && /^[ \t]*\|/.test(ls[j].text)) {
    while (j + 1 < ls.length && /^[ \t]*\|/.test(ls[j + 1].text)) j++;
    return { result: { begin, end: ls[j].next, text: ls.slice(i + 1, j + 1).map(l => l.text).join('\n'), error: false, form: 'table', of }, last: j };
  }
  return { result: { begin, end: ls[i].next, text: '', error: false, form: 'empty', of }, last: i };
}
/* A result names its block (of=id, #+RESULTS: id); a nameless one belongs to the block right above it, with
   only blank lines between. The first result found for a block is its result. */
function attach(text: string, blocks: Block[], results: Result[]) {
  for (const r of results) {
    let b: Block | undefined;
    if (r.of) b = blocks.find(x => x.id === r.of && x.kind === 'src');
    else { for (let k = blocks.length - 1; k >= 0; k--) if (blocks[k].end <= r.begin) { if (blocks[k].kind === 'src' && onlyBlank(text, blocks[k].end, r.begin)) b = blocks[k]; break; } }
    if (b && !b.result) b.result = r;
  }
}

/* ---------- noweb (<<name>>) ---------- */
/* The body of B with every <<name>> replaced by the bodies of the blocks named name (or whose noweb-ref is
   name), expanded in turn; a reference's line prefix is repeated on each line it brings in, as Org does. */
const expanded = new WeakMap<Parsed, Map<Block, string>>();   // a block expands the same wherever it is referenced
export function expand(parsed: Parsed, b: Block, depth = 0, seen: Set<Block> = new Set()): string {
  if (depth > NOWEB_DEPTH) throw new BabelError('noweb references nest too deep');
  if (seen.has(b)) throw new BabelError(`noweb reference cycle through ${b.id || 'the block at line ' + b.line}`);
  let memo = expanded.get(parsed);
  if (!memo) expanded.set(parsed, memo = new Map());
  const done = memo.get(b);
  if (done !== undefined) return done;
  seen.add(b);
  try {
    /* Each reference on a line expands in place; its prefix is the line's text before it. */
    const out = b.body.split('\n').map(line => line.replace(/<<([^<>\s()]+)>>/g, (all, ref: string, at: number) => {
      const parts = parsed.blocks.filter(x => x.kind !== 'table' && (x.id === ref || x.attrs['noweb-ref'] === ref));
      if (!parts.length) throw new BabelError(`noweb: no block named ${ref}`);
      const pre = line.slice(0, at);
      return parts.map(x => expand(parsed, x, depth + 1, seen)).join('\n').split('\n').join('\n' + pre);
    })).join('\n');
    if (out.length > NOWEB_MAX) throw new BabelError(`noweb: ${b.id || 'the block at line ' + b.line} expands past ${NOWEB_MAX} characters`);
    memo.set(b, out);
    return out;
  } finally { seen.delete(b); }
}
const nowebOn = (b: Block, set: Set<string>) => { const v = b.attrs.noweb; return v === true || (typeof v === 'string' && set.has(v.toLowerCase())); };

/* ---------- data ---------- */
const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
const cell = (s: string): SchemeValue => (NUMBER.test(s.trim()) ? Number(s.trim()) : s);
/* One CSV/TSV record per line (quoted fields may hold the separator, "" and newlines). */
export function delimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], f = '', q = false, any = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"' && f === '') { q = true; any = true; }
    else if (c === sep) { row.push(f); f = ''; any = true; }
    else if (c === '\n') { if (any || f !== '') { row.push(f.replace(/\r$/, '')); rows.push(row); } row = []; f = ''; any = false; }
    else { f += c; any = true; }
  }
  if (any || f !== '') { row.push(f.replace(/\r$/, '')); rows.push(row); }
  return rows;
}
/* An Org table's rows, rules (|-…) left out, cells trimmed. */
export function orgTable(text: string): string[][] {
  return text.split('\n').filter(l => /^[ \t]*\|/.test(l) && !/^[ \t]*\|-/.test(l))
    .map(l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
}
export function dataValue(S: Scheme, L: Lisp, kind: string, text: string): SchemeValue {
  const rows = (rs: string[][]) => S.listOf(rs.map(r => S.listOf(r.map(c => cell(c)))));
  switch (kind) {
    case 'json': { let v; try { v = JSON.parse(text); } catch (e) { throw new S.SchemeError('error', `json: ${e.message}`, []); } return jsonToScheme(S, v); }
    case 'csv': return rows(delimited(text, ','));
    case 'tsv': return rows(delimited(text, '\t'));
    case 'table': return rows(orgTable(text));
    case 'sexp': { const xs = L.readAll(text); return xs.length === 1 ? xs[0] : S.listOf(xs); }
    /* A value result is the written value: read it back when it is exactly one datum, else keep the text. */
    case 'result': { try { const xs = L.readAll(text); if (xs.length === 1) return xs[0]; } catch (e) { /* not Scheme */ } return text; }
    case 'text': return text;
    default: throw new S.SchemeError('error', `%babel-data: unknown kind ${kind}`, []);
  }
}

/* ---------- results ---------- */
/* The text of a result for ID (or none) in SYNTAX, ending in a newline: PAYLOAD is a string, or rows (an
   Org table, a list of lists). */
export function resultText(syntax: Syntax, id: string | null, payload: string | string[][], error: boolean): string {
  if (syntax === 'markdown') {
    const text = Array.isArray(payload) ? payload.map(r => r.join('\t')).join('\n') : payload;
    let run = 2;
    for (const m of text.matchAll(/^ {0,3}(`+)/gm)) run = Math.max(run, m[1].length);
    const fence = '`'.repeat(run + 1);
    const attrs = [id ? `of=${id}` : '', error ? 'error' : ''].filter(Boolean).join(' ');
    return `${fence}result${attrs ? ` {${attrs}}` : ''}\n${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${fence}\n`;
  }
  const head = `#+RESULTS:${id ? ' ' + id : ''}\n`;
  if (Array.isArray(payload)) {
    const w: number[] = [];
    for (const r of payload) r.forEach((c, k) => { w[k] = Math.max(w[k] || 0, c.length); });
    return head + payload.map(r => '| ' + w.map((n, k) => (r[k] ?? '').padEnd(n)).join(' | ') + ' |').join('\n') + '\n';
  }
  const lines = payload.replace(/\n$/, '').split('\n');
  if (error) return head + '#+begin_error\n' + lines.map(orgEscape).join('\n') + '\n#+end_error\n';
  if (lines.length >= MIN_BLOCK_LINES) return head + '#+begin_example\n' + lines.map(orgEscape).join('\n') + '\n#+end_example\n';
  return head + lines.map(l => (l === '' ? ':' : ': ' + l)).join('\n') + '\n';
}

/* ---------- tangle ---------- */
/* Files the blocks of PARSED tangle to: [path as written (relative to the note), text]; BASE names :tangle yes. */
export function tangleFiles(parsed: Parsed, base: string): [string, string][] {
  const files = new Map<string, string[]>();
  for (const b of parsed.blocks) {
    if (b.kind === 'table') continue;
    const t = b.attrs.tangle;
    if (t === undefined || t === 'no') continue;
    const p = t === true || t === 'yes' ? `${base}.${TANGLE_EXT[b.lang] || b.lang || 'txt'}` : t;
    if (!files.has(p)) files.set(p, []);
    files.get(p)!.push(nowebOn(b, NOWEB_TANGLE) ? expand(parsed, b) : b.body);
  }
  return [...files].map(([p, parts]) => [p, parts.join('\n\n').replace(/\n*$/, '\n')]);
}

/* ---------- Scheme ---------- */
function blockToScheme(S: Scheme, parsed: Parsed, b: Block): SchemeValue {
  const pair = (k: string, v: SchemeValue) => S.cons(S.intern(k), v);
  let code: SchemeValue = b.body, codeError: SchemeValue = false;
  if (b.kind === 'src' && nowebOn(b, NOWEB_EVAL)) { try { code = expand(parsed, b); } catch (e) { if (!(e instanceof BabelError)) throw e; code = false; codeError = e.message; } }
  const r = b.result;
  const result = r ? S.listOf([pair('begin', r.begin + 1), pair('end', r.end + 1), pair('text', r.text), pair('error', r.error), pair('form', S.intern(r.form))]) : false;
  return S.listOf([
    pair('kind', S.intern(b.kind)), pair('lang', b.lang), pair('id', b.id === null ? false : b.id),
    pair('begin', b.begin + 1), pair('end', b.end + 1), pair('line', b.line),
    pair('body', b.body), pair('code', code), pair('code-error', codeError),
    pair('attrs', S.listOf(Object.entries(b.attrs).map(([k, v]) => S.cons(k, v)))),
    pair('vars', S.listOf(b.vars.map(([n, ref]) => S.cons(n, ref)))),
    pair('result', result),
  ]);
}

export const name = 'babel';
export async function install(srv: Server): Promise<void> {
  const { L } = srv, S = L.S;
  const D = (nm: string, args: string, doc: string, fn: (args: SchemeValue[]) => SchemeValue, gen?: (args: SchemeValue[]) => SchemeGen) => { const f = L.D(nm, args, doc, fn); f.where = 'server'; if (gen) f.gen = gen; return f; };
  const syntaxArg = (x: SchemeValue, who: string): Syntax => { const s = x instanceof S.Sym ? x.name : x; if (s !== 'org' && s !== 'markdown') throw new S.SchemeError('wrong-type-argument', `${who}: syntax must be org or markdown`, [x]); return s; };
  const wrap = <T,>(who: string, f: () => T): T => { try { return f(); } catch (e) { if (e instanceof BabelError) throw new S.SchemeError('user-error', `${who}: ${e.message}`, []); throw e; } };

  D('%babel-blocks', 'text syntax', 'The source, data and table blocks of TEXT, a note in SYNTAX (org or markdown), as alists with their results (babel.scm).', ([text, syn]) => {
    const parsed = parse(S.str(text, '%babel-blocks'), syntaxArg(syn, '%babel-blocks'));
    return S.listOf(parsed.blocks.map(b => blockToScheme(S, parsed, b)));
  });
  D('%babel-data', 'kind text', 'TEXT as Scheme data: KIND json, csv, tsv, table (an Org table), sexp, result (a written value read back when it is one datum) or text.', ([kind, text]) =>
    dataValue(S, L, kind instanceof S.Sym ? kind.name : S.str(kind, '%babel-data'), S.str(text, '%babel-data')));
  D('%babel-result-text', 'syntax id payload error', 'The text of a result block for ID (#f: none) in SYNTAX; PAYLOAD is a string or, for an Org table, a list of rows.', ([syn, id, payload, error]) => {
    const p = typeof payload === 'string' ? payload : S.arr(payload).map((r: SchemeValue) => S.arr(r).map((c: SchemeValue) => (typeof c === 'string' ? c : S.display(c))));
    return resultText(syntaxArg(syn, '%babel-result-text'), id === false || id === undefined ? null : S.str(id, '%babel-result-text'), p, S.truthy(error));
  });
  D('%babel-tangle-files', 'text syntax base', 'The files the blocks of TEXT tangle to, as (path . text) with paths as the blocks write them; BASE names :tangle yes.', ([text, syn, base]) => wrap('babel-tangle', () => {
    const parsed = parse(S.str(text, '%babel-tangle-files'), syntaxArg(syn, '%babel-tangle-files'));
    return S.listOf(tangleFiles(parsed, S.str(base, '%babel-tangle-files')).map(([p, t]) => S.cons(p, t)));
  }));
  D('%babel-expand-home', 'path', 'PATH with a leading ~/ (or a lone ~) made the home directory of the user edwind runs as.', ([p]) => expandHome(S.str(p, '%babel-expand-home')));
  /* The shared buffer of a note (an id as wb and the board name it: notes-relative, ~/… or absolute), for
     babel-run; the file is opened when no buffer has it. */
  D('%babel-note-buffer', 'file', 'The shared buffer of FILE (a notes-relative, ~/ or absolute path), opened when needed.', ([file]) => sbufOf(S.str(file, '%babel-note-buffer'), false).ed);
  D('%babel-write-file', 'file text [note]', 'Make FILE (absolute) hold TEXT through its shared buffer, then save it (babel-tangle): the authority\'s write rules apply. FILE may not be NOTE, the note that tangles.', () => {
    throw new S.SchemeError('cannot-block', '%babel-write-file: cannot wait here', []);
  }, function* ([file, text, note]) {
    const f = S.str(file, '%babel-write-file'), t = S.str(text, '%babel-write-file');
    if (!path.isAbsolute(f)) throw new S.SchemeError('error', `%babel-write-file: ${f} is not an absolute path`, []);
    const self = typeof note === 'string' ? (() => { try { return sbufOf(note, false); } catch (e) { return null; } })() : null;
    const sb = sbufOf(f, true);
    if (sb === self) throw new S.SchemeError('file-error', `${f}: a note cannot tangle onto itself`, []);
    const cur = srv.threads && srv.threads.current;
    const by: By = cur ? cur.by : { kind: 'server', thread: 'babel-tangle' };
    yield new S.Block((async () => { await srv.buffers.replaceText(sb, t, by); if (sb.modified) await srv.buffers.save(sb); })(), `tangling ${sb.id}`);
    return sb.id;
  });

  /* An id for FILE as the buffers know it; an absolute path inside notesDir becomes notes-relative, so a new
     file there gets its directories (Buffers.resolve). */
  function sbufOf(file: string, create: boolean): SBuf {
    let id = file;
    if (path.isAbsolute(file)) {
      const nd = srv.auth.realNotesDir(), norm = path.normalize(file);
      const rel = norm.startsWith(nd + '/') ? norm.slice(nd.length + 1) : null;
      // A notes-relative id names the same buffer the note's own links open, unless it would read as another kind
      // of id (name:BUFFER, ~/PATH).
      id = rel !== null && !/^(name:|~)/.test(rel) ? rel : norm;
    }
    let r: SBuf | Moved;
    try { r = srv.buffers.resolve(id, create); if ((r as Moved).moved) r = srv.buffers.resolve((r as Moved).moved, create); }
    catch (e) { if (e instanceof ProtoError) throw new S.SchemeError('file-error', `${file}: ${e.message}`, []); throw e; }
    const sb = r as SBuf;
    if (sb.readOnly) throw new S.SchemeError('file-error', `${file}: ${sb.readOnly}`, []);
    return sb;
  }
}
