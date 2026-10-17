// Golden test for edwin/scm/address.scm (spec §16.1 row `edit-address`, §10.1 "Addresses"):
// block-address, format-address and resolve-address in Scheme give the same results as
// bufferAddress, fmtAddr and resolveBufferAddress in web/app.js over generated cases.
//
// The three JavaScript functions are cut out of app.js by their source text and run in a vm
// context with small stand-ins for the page: nodeList() over generated buffers, live[id].view
// .state.doc as a real CodeMirror Text, and clamp. Cases come from a seeded generator, so a
// failing case is one integer; those go to address-seeds.json and are replayed first (R16.1).
// Run: node --test edwin/test/address.test.mts (ADDRESS_RUNS, ADDRESS_SEED tune fast-check).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { loadScheme, MODE, ROOT } from './scheme-load.mts';
import type { SchemeValue } from './scheme-load.mts';

/* A generated page: a buffer (or a frame, which addresses skip) with its name and text. */
interface Page { name: string; text: string; kind?: string }
/* A page as the page's nodeList() gives it. */
interface PageNode { id: string; kind: string; name: string }
/* A CodeMirror Text from @codemirror/state, opaque here: only app.js reads it. */
type Doc = unknown;
/* An address as bufferAddress gives it. */
interface JsAddress { name: string; path: string[]; para: number; quote: string }
/* The three functions cut out of web/app.js, run in the vm context. */
interface AppAddresses {
  bufferAddress(n: { name: string }, state: { doc: Doc }, pos: number): JsAddress;
  fmtAddr(a: JsAddress): string;
  resolveBufferAddress(q: string): { node: PageNode; pos: number } | null;
}
interface Rand { next(): number; int(lo: number, hi: number): number; pick<T>(xs: readonly T[]): T; chance(p: number): boolean }
interface Case { seed: number; pages: Page[]; name: string; text: string; pos: number; q: string }

const require = createRequire(import.meta.url);
// fast-check and @codemirror/state are pinned in tools/package-lock.json; NODE_PATH names tools/node_modules.
const fc = require('fast-check'); // any: fast-check's types are not resolvable from edwin/ (it lives in tools/node_modules)
const { Text } = require('@codemirror/state'); // any: as fast-check, @codemirror/state lives in tools/node_modules
const SEEDS: number[] = JSON.parse(readFileSync(new URL('./address-seeds.json', import.meta.url), 'utf8'));
const RUNS = Number(process.env.ADDRESS_RUNS || 500);

// ---------------------------------------------------------------- the Scheme side
const S = loadScheme(MODE);
S.evalString(readFileSync(join(ROOT, 'scm', 'address.scm'), 'utf8'), 'address.scm');
const call = (name: string, ...args: SchemeValue[]): SchemeValue => S.callProc(S.gref(name), args);
const schemeFormat = (name: string, text: string, pos: number) => call('format-address', call('block-address', name, text, pos));
const schemeResolve = (q: string, pages: Page[]) => {
  // Only buffer pages are addressable; frames and the like are passed to the JS and skipped there.
  const r = call('resolve-address', q, S.listOf(pages.filter(p => (p.kind || 'buffer') === 'buffer').map(p => S.cons(p.name, p.text))));
  return r === false ? null : { name: r.car, pos: r.cdr };
};

// ---------------------------------------------------------------- the JavaScript side
const appSource = readFileSync(join(ROOT, '..', 'web', 'app.js'), 'utf8');
const cut = appSource.match(/function bufferAddress\(n, state, pos\) \{[\s\S]*?\n(?=\/\/ -{10,} )/);
assert.ok(cut, 'bufferAddress is in web/app.js');
const jsSource = cut[0];
for (const fn of ['function fmtAddr(', 'function resolveBufferAddress(']) assert.ok(jsSource.includes(fn), `${fn} follows bufferAddress`);

const page: { pages: PageNode[]; live: Record<string, { view: { state: { doc: Doc } } }> } = { pages: [], live: {} };
const ctx = vm.createContext({
  clamp: (v: number, a: number, b: number) => Math.max(a, Math.min(b, v)),
  nodeList: () => page.pages,
  live: page.live,
  // the page's state in either editor mode (app.js pageState): here always the CodeMirror view's
  pageState: (n: PageNode) => page.live[n.id]?.view?.state || null,
});
vm.runInContext(jsSource, ctx, { filename: 'app.js (addresses)' });
const { bufferAddress, fmtAddr, resolveBufferAddress } = ctx as AppAddresses;
const makeDoc = (text: string): Doc => Text.of(text.split('\n'));
const setPages = (pages: Page[]) => {
  page.pages = pages.map((p, i) => ({ id: 'n' + i, kind: p.kind || 'buffer', name: p.name }));
  for (const k of Object.keys(page.live)) delete page.live[k];
  pages.forEach((p, i) => { page.live['n' + i] = { view: { state: { doc: makeDoc(p.text) } } }; });
};
const jsFormat = (name: string, text: string, pos: number) => fmtAddr(bufferAddress({ name }, { doc: makeDoc(text) }, pos));
const jsResolve = (q: string, pages: Page[]) => {
  setPages(pages);
  const r = resolveBufferAddress(q);
  return r ? { name: r.node.name, pos: r.pos } : null;
};

// ---------------------------------------------------------------- the generator
// mulberry32: one integer seed gives the whole case.
function rng(seed: number): Rand {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[int(0, xs.length - 1)];
  const chance = (p: number) => next() < p;
  return { next, int, pick, chance };
}

const WORDS = ['plan', 'notes', 'alpha', 'beta', 'Gamma', 'delta', 'Épée', 'naïve', 'über', 'straße', 'Ωmega', 'день', '日本語', 'emoji😀', 'x', 'y2', 'a-b', 'c_d', 'ok', 'Plan', 'NOTES', 'the', 'and', 'of'];
const PUNCT = ['', '', '', ',', '.', ':', ';', '!', '?', '"', '"', '(', ')', '#', '>', '*', '-', '¶', '›'];
const NAMES = ['Notes', 'Plan', 'plan', 'Plan B', 'Alpha', 'alpha-notes', 'Épée', 'A', 'Todo'];

function word(r: Rand) { return r.pick(WORDS) + r.pick(PUNCT); }
function words(r: Rand, n: number) { const out: string[] = []; for (let i = 0; i < n; i++) out.push(word(r)); return out.join(r.chance(0.1) ? '  ' : ' '); }
function heading(r: Rand, level: number) {
  const hashes = '#'.repeat(level);
  const sep = r.pick([' ', ' ', ' ', '\t', '  ']);
  let title = words(r, r.int(1, 4));
  if (r.chance(0.15)) title = r.pick(['', ' ', '"quoted"', '# nested', title + ' ']);
  return hashes + sep + title;
}
function line(r: Rand) {
  const kind = r.int(0, 12);
  if (kind <= 1) return '';
  if (kind === 2) return r.pick([' ', '\t', '   ']);
  if (kind === 3) return r.pick(['- ', '* ', '+ ', '1. ', '12. ', '  - ', '\t* ']) + words(r, r.int(1, 5));
  if (kind === 4) return '> ' + words(r, r.int(1, 5));
  if (kind === 5) return r.pick(['#', '#tag', '##', '####### seven', '-', '-x', '1.x', '*']) + (r.chance(0.5) ? ' ' + words(r, 2) : '');
  if (kind === 6) return '"' + words(r, r.int(1, 3)) + '"' + (r.chance(0.5) ? ' ' + words(r, 2) : '');
  if (kind === 7) return ' '.repeat(r.int(1, 4)) + words(r, r.int(1, 4)) + ' '.repeat(r.int(0, 2));
  return words(r, r.int(1, 8));
}
// A Markdown text: optionally one H1 title (or several), headings of mixed levels, paragraphs, lists.
function markdown(r: Rand, name: string) {
  const lines: string[] = [];
  const titleMode = r.int(0, 3);
  if (titleMode === 1) lines.push('# ' + name, '');
  if (titleMode === 2) lines.push('# ' + r.pick([name.toUpperCase(), name.toLowerCase(), words(r, 2)]), '');
  if (titleMode === 3) lines.push('# ' + words(r, 2), '', '# ' + words(r, 1), '');
  const n = r.int(0, 14);
  for (let i = 0; i < n; i++) {
    if (r.chance(0.3)) lines.push(heading(r, r.int(1, 6)));
    else if (lines.length && r.chance(0.2)) lines.push(r.pick(lines));   // a repeated line: the quote search scopes matter
    else lines.push(line(r));
  }
  if (r.chance(0.3)) lines.push('');
  return lines.join('\n');
}
// A tidy document from a small vocabulary: sections with several paragraphs, so a word repeats across
// paragraphs and sections and the order of the quote search scopes (paragraph, section, buffer) shows.
function structured(r: Rand) {
  const vocab = ['alpha', 'beta', 'gamma', 'delta', 'plan', 'notes'];
  const lines: string[] = [];
  if (r.chance(0.5)) lines.push('# Title', '');
  const sections = r.int(1, 4);
  for (let s = 0; s < sections; s++) {
    lines.push('#'.repeat(r.int(2, 3)) + ' Section ' + r.pick(vocab) + ' ' + s);
    const paras = r.int(1, 3);
    for (let k = 0; k < paras; k++) {
      lines.push('');
      const n = r.int(1, 3), ws: string[] = [];
      for (let i = 0; i < n; i++) ws.push(r.pick(vocab));
      lines.push((r.chance(0.2) ? '- ' : '') + ws.join(' '));
    }
  }
  return lines.join('\n');
}
function pages(r: Rand) {
  const count = r.int(1, 4);
  const out: Page[] = [];
  const used = new Set<string>();
  for (let i = 0; i < count; i++) {
    let name = r.pick(NAMES);
    if (used.has(name)) name += ' ' + i;
    used.add(name);
    out.push({ name, text: r.chance(0.3) ? structured(r) : markdown(r, name), kind: r.chance(0.08) ? 'frame' : 'buffer' });
  }
  return out;
}
// An address string: a derived one (from block-address on a random spot), a mangled one, or noise.
function address(r: Rand, ps: Page[]) {
  const p = r.pick(ps);
  const pos = r.int(0, p.text.length);
  const mode = r.int(0, 9);
  if (mode <= 3) return jsFormat(p.name, p.text, pos);
  const a = bufferAddress({ name: p.name }, { doc: makeDoc(p.text) }, pos);
  const mangleCase = (s: string) => r.pick([s, s.toLowerCase(), s.toUpperCase(), s]);
  const prefix = (s: string) => r.chance(0.5) ? s.slice(0, r.int(0, s.length)) : s;
  if (mode <= 6) {
    const parts = [mangleCase(prefix(p.name)), ...a.path.map(t => mangleCase(prefix(t)))];
    if (r.chance(0.3)) parts.push(words(r, 1));
    let s = parts.join(r.pick([' › ', '›', ' ›  ', ' › ']));
    const para = r.chance(0.6) ? a.para : r.int(0, 5);
    if (para || r.chance(0.2)) s += r.pick([' ¶', '¶', ' ¶ ']) + para;
    if (a.quote && r.chance(0.7)) s += r.pick([' "', '"', '  "']) + mangleCase(prefix(a.quote)) + r.pick(['"', '"', '']);
    else if (r.chance(0.3)) s += ' "' + words(r, 1) + '"';
    return s;
  }
  if (mode === 7 && r.chance(0.5)) {
    // One word of the text as the quote, under the right heading path but a paragraph number that may be wrong.
    const w = r.pick(p.text.split(/\s+/).filter(Boolean).concat(['x']));
    return [p.name, ...a.path].join(' › ') + (r.chance(0.7) ? ' ¶' + r.int(0, 4) : '') + ' "' + w.replace(/"/g, '') + '"';
  }
  if (mode === 7) return r.pick(['', ' ', '›', '› ›', '¶3', '"q"', 'Unknown', 'unknown › x', 'zzz "quote"', 'Notes › › Plan', p.name + ' ›']);
  if (mode === 8) return r.pick(['', ' ']) + mangleCase(p.name) + r.pick(['', ' ¶1', ' ¶2 "' + words(r, 1), ' › ' + words(r, 1) + ' ¶1 "a" "b"']);
  return words(r, r.int(1, 4)) + r.pick(['', ' ¶1', ' "x"']);
}
function makeCase(seed: number) {
  const r = rng(seed);
  const ps = pages(r);
  const target = r.pick(ps);
  const pos = r.int(0, target.text.length);
  const q = address(r, ps);
  return { pages: ps, name: target.name, text: target.text, pos, q };
}

// ---------------------------------------------------------------- the properties
const seeds = fc.integer({ min: 1, max: 2 ** 31 - 1 });
const params = { numRuns: RUNS, examples: SEEDS.map(s => [s]), seed: Number(process.env.ADDRESS_SEED || 0) || undefined, verbose: 1 };
const show = (c: Case) => `seed ${c.seed}: name ${JSON.stringify(c.name)} pos ${c.pos} q ${JSON.stringify(c.q)}\ntext ${JSON.stringify(c.text)}\npages ${JSON.stringify(c.pages)}`;

test('block-address and format-address match bufferAddress and fmtAddr', () => {
  fc.assert(fc.property(seeds, (seed: number) => {
    const c = { seed, ...makeCase(seed) };
    assert.equal(schemeFormat(c.name, c.text, c.pos), jsFormat(c.name, c.text, c.pos), show(c));
  }), params);
});

test('resolve-address matches resolveBufferAddress', () => {
  fc.assert(fc.property(seeds, (seed: number) => {
    const c = { seed, ...makeCase(seed) };
    assert.deepEqual(schemeResolve(c.q, c.pages), jsResolve(c.q, c.pages), show(c));
  }), params);
});

test('resolve-address round trip: an address of a position resolves inside its line', () => {
  fc.assert(fc.property(seeds, (seed: number) => {
    const c = { seed, ...makeCase(seed) };
    const buffers = c.pages.filter(p => p.kind === 'buffer');
    if (!buffers.some(p => p.name === c.name)) return;
    const a = bufferAddress({ name: c.name }, { doc: makeDoc(c.text) }, c.pos);
    const q = fmtAddr(a);
    const got = schemeResolve(q, buffers);
    assert.deepEqual(got, jsResolve(q, buffers), show(c));
    // A "›" inside a heading or the quote splits the address, so such addresses do not resolve in the JS either.
    if (![c.name, ...a.path, a.quote].some(s => s.includes('›'))) assert.ok(got, show(c));
  }), params);
});

test('parse-address and the address alist', () => {
  const read = (q: string) => { const a = call('parse-address', q); return a === false ? null : Object.fromEntries(S.arr(a).map(p => [p.car.name, p.cdr instanceof S.Pair || p.cdr === S.NIL ? S.arr(p.cdr) : p.cdr])); };
  assert.deepEqual(read('Notes › Plan › Step ¶2 "first words"'), { name: 'Notes', path: ['Plan', 'Step'], para: 2, quote: 'first words' });
  assert.deepEqual(read('notes ¶ 3'), { name: 'notes', path: [], para: 3, quote: '' });
  assert.deepEqual(read('Notes › Plan "unterminated'), { name: 'Notes', path: ['Plan'], para: 0, quote: 'unterminated' });
  assert.deepEqual(read('¶2'), { name: '', path: [], para: 2, quote: '' });
  assert.equal(read(''), null);
  assert.equal(read(' › '), null);
  assert.equal(call('format-address', call('parse-address', 'Notes › Plan ¶2 "x y"')), 'Notes › Plan ¶2 "x y"');
  const a = call('block-address', 'Notes', '# Notes\n\n## Plan\n\nfirst para\n- item "one"\n- item two\n', 31);
  assert.equal(call('address-name', a), 'Notes');
  assert.deepEqual(S.arr(call('address-path', a)), ['Plan']);
  assert.equal(call('address-para', a), 2);
  assert.equal(call('address-quote', a), 'item one');
  assert.equal(call('format-address', a), 'Notes › Plan ¶2 "item one"');
});
