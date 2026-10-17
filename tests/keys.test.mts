// The board's key contexts (docs/DESIGN.md §6.4): web/keys.ts with no browser. check() walks every context stack
// over every key; the rows below are the conflicts measured before K0, each pinned to its fixed outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const K: WBKeysAPI = require(process.env.WB_KEYS || path.join(here, '../web/keys.ts'));

const ctx = (o: Partial<WBKeyContext> = {}): WBKeyContext => ({ transient: null, interior: null, view: 'canvas', place: 'board', ...o });
const last = (c: WBKeyContext, k: string): Partial<WBKeyStep> => K.resolve(c, k).at(-1) || {};
const outcome = (c: WBKeyContext, k: string) => { const s = last(c, k); return s.cmd || (s.pass ? 'pass' : s.swallow ? 'swallow' : s.fn ? 'fn' : 'none'); };

test('the checker finds no conflict in any context', () => {
  const r = K.check();
  assert.deepEqual(r.errors, []);
  assert.ok(r.stacks > 100 && r.lookups > 50000, `walked ${r.stacks} stacks, ${r.lookups} lookups`);
});

test('a terminal gets the keys the board used to take (K2)', () => {
  const t = ctx({ interior: 'term' });
  for (const k of ['C-k', 'C-j', 'C-S-p', 'M-b', 'M-v', 'M-1', 'M-%', 'M-<left>', 'ESC', 'TAB', 'h', 'C-z'])
    assert.equal(outcome(t, k), 'pass', k);
  assert.equal(outcome(t, 'C-`'), 'dock.toggle');
});

test('a page leaves the palette, the dock, the tree and the views to the board', () => {
  const p = ctx({ interior: 'page' });
  assert.equal(outcome(p, 'C-k'), 'palette.open');
  assert.equal(outcome(p, 'C-j'), 'dock.toggle');
  assert.equal(outcome(p, 'M-b'), 'tree.toggle');
  assert.equal(outcome(p, 'M-3'), 'view.graph');
  for (const k of ['ESC', 'h', 'C-z', 'TAB', 'M-<left>']) assert.equal(outcome(p, k), 'pass', k);
});

test('an Edwin frame or a web frame owns every key', () => {
  for (const i of ['edwin', 'frame'] as const) for (const k of ['C-k', 'C-`', 'M-1', 'ESC']) assert.equal(outcome(ctx({ interior: i }), k), 'pass', i + ' ' + k);
});

test('the palette moves its selection with C-j and C-k instead of toggling the dock', () => {
  const p = ctx({ transient: 'palette' });
  assert.equal(outcome(p, 'C-j'), 'pass');
  assert.equal(outcome(p, 'C-k'), 'pass');
  assert.equal(outcome(p, 'ESC'), 'overlay.close');
});

test('hints and arrange swallow what they do not bind', () => {
  assert.equal(outcome(ctx({ transient: 'hints' }), 'j'), 'hints.letter');
  assert.equal(outcome(ctx({ transient: 'hints' }), 'M-b'), 'swallow');
  assert.equal(outcome(ctx({ transient: 'arrange' }), 'l'), 'arrange.right');
  assert.equal(outcome(ctx({ transient: 'arrange' }), 'r'), 'swallow');
});

test('the board keeps its keys; views with key functions are tried first', () => {
  assert.equal(outcome(ctx(), 'f'), 'hints');
  assert.equal(outcome(ctx(), '.'), 'card.actions');
  assert.equal(outcome(ctx(), 'm'), 'arrange');
  assert.equal(outcome(ctx({ view: 'graph' }), 'l'), 'graph.right');
  const r = K.resolve(ctx({ view: 'ranger' }), 'j');
  assert.equal(r[0].fn, 'ranger');
  assert.equal(outcome(ctx({ view: 'ranger' }), 'M-b'), 'tree.toggle');
});

test('the leader: Esc leaves any card (K3), ; opens hints, v is a prefix', () => {
  assert.equal(K.leaderResolve('ESC')!.cmd, 'leave');
  assert.equal(K.leaderResolve(';')!.cmd, 'hints');
  assert.equal(K.leaderResolve('v')!.cmd, '>leader-v');
  assert.equal(K.leaderResolve('m', 'leader-v')!.cmd, 'persp.manual');
});

test('key names follow Edwin, with symbols for shifted digits', () => {
  const e = (key: string, code: string, m: Partial<WBKeyNameEvent> = {}): WBKeyNameEvent => ({ key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...m });
  assert.equal(K.keyName(e(' ', 'Space', { ctrlKey: true })), 'C-SPC');
  assert.equal(K.keyName(e('K', 'KeyK', { ctrlKey: true, shiftKey: true })), 'C-S-k');
  assert.equal(K.keyName(e('%', 'Digit5', { altKey: true, shiftKey: true })), 'M-%');
  assert.equal(K.keyName(e('∫', 'KeyB', { altKey: true })), 'M-b');
  assert.equal(K.keyName(e('ArrowLeft', 'ArrowLeft', { altKey: true })), 'M-<left>');
  assert.equal(K.keyName(e('L', 'KeyL', { shiftKey: true })), 'L');
  assert.equal(K.keyName(e('Shift', 'ShiftLeft', { shiftKey: true })), null);
});

test('the checker catches a conflict, a reserved key, and a key a card gives up for nothing', () => {
  const canvas = K.MAPS.canvas, global = K.MAPS.global;
  try {
    K.MAPS.canvas = [...canvas, ['f', 'fit', 'twice'], ['C-w', 'fit', 'closes the tab'], ['C-SPC', 'fit', 'the leader']];
    K.MAPS.global = global.filter(r => r[0] !== 'M-v');
    const r = K.check();
    for (const want of ['K1 canvas: f is bound twice', 'browser canvas: C-w', 'leader canvas: C-SPC', 'K2 page: leaves M-v', 'K2 text: leaves M-v'])
      assert.ok(r.errors.some(x => x.startsWith(want)), want);
    // a key added to the board never reaches past a card that needs it: the walk stops at the card
    K.MAPS.global = [...global, ['C-l', 'fit', 'stolen']]; K.reindex();
    assert.equal(outcome(ctx({ interior: 'term' }), 'C-l'), 'pass');
    assert.equal(outcome(ctx(), 'C-l'), 'fit');
  } finally { K.MAPS.canvas = canvas; K.MAPS.global = global; K.reindex(); }
  assert.deepEqual(K.check().errors, []);
});

test('desks (§10.8): Alt-Shift digits from the board and from a page, leader digits and the desk prefixes', () => {
  assert.equal(outcome(ctx(), 'M-)'), 'desk.0');
  assert.equal(outcome(ctx({ interior: 'page' }), 'M-@'), 'desk.2');
  assert.equal(outcome(ctx({ interior: 'term' }), 'M-@'), 'pass');
  assert.equal(K.leaderResolve('0')!.cmd, 'desk.0');
  assert.equal(K.leaderResolve('`')!.cmd, 'desk.prev');
  assert.equal(K.leaderResolve('m')!.cmd, '>leader-m');
  assert.equal(K.leaderResolve('3', 'leader-M')!.cmd, 'desk.follow.3');
  assert.equal(K.leaderResolve('a', 'leader-d')!.cmd, '>leader-da');
  assert.equal(K.leaderResolve('4', 'leader-da')!.cmd, 'desk.also.4');
  assert.equal(K.whereIs('desk.delete'), 'Ctrl-Space d k');
  assert.ok(![...K.commands()].some(c => c.startsWith('ws.') && c !== 'ws.last'), 'no workspace digit rows remain');
});

test('desks D2 (§10.8): overview, ring, overlay, attention and the new desk keys; the overview and the ring keep the keyboard', () => {
  assert.equal(K.leaderResolve('g')!.cmd, 'overview');
  assert.equal(K.leaderResolve('w')!.cmd, 'ring');
  assert.equal(K.leaderResolve('x')!.cmd, 'overlay');
  assert.equal(K.leaderResolve('!')!.cmd, 'attn.next');
  assert.equal(K.leaderResolve('9')!.cmd, 'desk.9');
  assert.equal(K.leaderResolve('x', 'leader-m')!.cmd, 'overlay.send');
  for (const [k, c] of [['b', 'desk.promote'], ['s', 'desk.sticky'], ['t', 'desk.layout'], ['o', 'desk.open']]) assert.equal(K.leaderResolve(k, 'leader-d')!.cmd, c);
  assert.equal(outcome(ctx({ transient: 'overview' }), 'a'), 'overview.letter');
  assert.equal(outcome(ctx({ transient: 'overview' }), '3'), 'overview.3');
  assert.equal(outcome(ctx({ transient: 'overview' }), '<right>'), 'overview.right');
  assert.equal(outcome(ctx({ transient: 'overview' }), 'C-k'), 'swallow');
  assert.equal(outcome(ctx({ transient: 'ring' }), 'w'), 'ring.next');
  assert.equal(outcome(ctx({ transient: 'ring' }), 'S-TAB'), 'ring.prev');
  assert.equal(outcome(ctx({ transient: 'ring' }), 'h'), 'swallow');
  assert.equal(K.whereIs('desk.sticky'), 'Ctrl-Space d s');
  assert.equal(K.whereIs('overlay.send'), 'Ctrl-Space m x');
});

test('desks D3 (§10.8): revert and keep on the d map; d t steps the layouts', () => {
  assert.equal(K.leaderResolve('u', 'leader-d')!.cmd, 'desk.revert');
  assert.equal(K.leaderResolve('w', 'leader-d')!.cmd, 'desk.keep');
  assert.equal(K.leaderResolve('t', 'leader-d')!.cmd, 'desk.layout');
  assert.equal(K.whereIs('desk.revert'), 'Ctrl-Space d u');
});
