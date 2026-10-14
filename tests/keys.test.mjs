// The board's key contexts (docs/DESIGN.md §6.4): web/keys.js with no browser. check() walks every context stack
// over every key; the rows below are the conflicts measured before K0, each pinned to its fixed outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const K = require(process.env.WB_KEYS || path.join(here, '../web/keys.js'));

const ctx = (o = {}) => ({ transient: null, interior: null, view: 'canvas', place: 'board', ...o });
const last = (c, k) => K.resolve(c, k).at(-1) || {};
const outcome = (c, k) => { const s = last(c, k); return s.cmd || (s.pass ? 'pass' : s.swallow ? 'swallow' : s.fn ? 'fn' : 'none'); };

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
  for (const i of ['edwin', 'frame']) for (const k of ['C-k', 'C-`', 'M-1', 'ESC']) assert.equal(outcome(ctx({ interior: i }), k), 'pass', i + ' ' + k);
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
  assert.equal(K.leaderResolve('ESC').cmd, 'leave');
  assert.equal(K.leaderResolve(';').cmd, 'hints');
  assert.equal(K.leaderResolve('v').cmd, '>leader-v');
  assert.equal(K.leaderResolve('m', 'leader-v').cmd, 'persp.manual');
});

test('key names follow Edwin, with symbols for shifted digits', () => {
  const e = (key, code, m = {}) => ({ key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...m });
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
