// The intrinsics lockdown (edwin/server/lockdown.mts, R14.11, R16.16): `node --test edwin/test/lockdown.test.mts`.
//
// Each case runs in a child process, so the test runner's own realm stays open: the child locks down, then
// prints what it found as JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LOCKDOWN = fileURLToPath(new URL('../server/lockdown.mts', import.meta.url));

function inChild(body, flags = []) {
  const src = `'use strict'; import { lockdown, lockdownState } from ${JSON.stringify(LOCKDOWN)};
    const out = {}; const tryIt = (k, f) => { try { out[k] = f(); } catch (e) { out[k] = 'threw ' + e.constructor.name; } };
    ${body}
    console.log(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, [...flags, '--input-type=module', '-e', src], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('before and after: open, then locked; a second call changes nothing', () => {
  const o = inChild(`out.before = lockdownState(); out.first = lockdown(); out.second = lockdown();`);
  assert.deepEqual(o, { before: 'open', first: 'locked', second: 'locked' });
});

test('Object.prototype and Array.prototype are sealed: no new keys, none deleted (prototype pollution)', () => {
  const o = inChild(`lockdown();
    tryIt('objAdd', () => { Object.prototype.polluted = 1; return ({}).polluted; });
    tryIt('objMerge', () => { const t = {}; const p = JSON.parse('{"__proto__": {"polluted": 1}}'); Object.assign(t, p); return ({}).polluted; });
    tryIt('arrAdd', () => { Array.prototype.polluted = 1; return [].polluted; });
    tryIt('arrIndex', () => { Array.prototype[0] = 'x'; return [,][0]; });
    tryIt('objDelete', () => delete Object.prototype.hasOwnProperty);
    tryIt('arrDelete', () => delete Array.prototype.map);
    tryIt('setProto', () => Object.setPrototypeOf(Object.prototype, {}));
    out.sealed = [Object.isSealed(Object.prototype), Object.isSealed(Array.prototype)];
    out.methodsFrozen = [Object.isFrozen(Array.prototype.map), Object.isFrozen(Object.prototype.toString)];`);
  for (const k of ['objAdd', 'arrAdd', 'arrIndex', 'objDelete', 'arrDelete', 'setProto']) assert.equal(o[k], 'threw TypeError', k);
  assert.equal(o.objMerge, undefined, 'a parsed __proto__ key stays an own key');
  assert.deepEqual(o.sealed, [true, true]);
  assert.deepEqual(o.methodsFrozen, [true, true]);
});

test('every other intrinsic is frozen, deeply', () => {
  const o = inChild(`lockdown();
    const gen = Object.getPrototypeOf(function* () {});
    const objs = { Function: Function.prototype, String: String.prototype, Map: Map.prototype, Set: Set.prototype, Promise: Promise.prototype,
      Error: Error.prototype, TypeError: TypeError.prototype, RegExp: RegExp.prototype, Date: Date.prototype, JSON, Math, Reflect,
      ArrayCtor: Array, ObjectCtor: Object, Generator: gen.prototype, GeneratorFunction: gen,
      ArrayIterator: Object.getPrototypeOf([][Symbol.iterator]()), Uint8Array: Uint8Array.prototype, console, setTimeout };
    for (const [k, v] of Object.entries(objs)) out[k] = Object.isFrozen(v);
    tryIt('replaceMethod', () => { String.prototype.trim = () => 'pwned'; return ' a '.trim(); });
    tryIt('replaceJSON', () => { JSON.parse = () => 'pwned'; return JSON.parse('1'); });
    tryIt('replaceStatic', () => { Object.keys = () => []; return Object.keys({ a: 1 }).length; });
    tryIt('replaceGlobalThis', () => { globalThis = {}; return typeof globalThis.Object; });`);
  for (const k of ['Function', 'String', 'Map', 'Set', 'Promise', 'Error', 'TypeError', 'RegExp', 'Date', 'JSON', 'Math', 'Reflect',
    'ArrayCtor', 'ObjectCtor', 'Generator', 'GeneratorFunction', 'ArrayIterator', 'Uint8Array', 'console', 'setTimeout']) assert.equal(o[k], true, k);
  for (const k of ['replaceMethod', 'replaceJSON', 'replaceStatic', 'replaceGlobalThis']) assert.equal(o[k], 'threw TypeError', k);
});

test('derived objects still override by assignment (the override mistake), as under --frozen-intrinsics', () => {
  const o = inChild(`lockdown();
    tryIt('errName', () => { const e = new Error('x'); e.name = 'Mine'; return String(e); });
    tryIt('toString', () => { const x = {}; x.toString = () => 'own'; return String(x); });
    tryIt('fnName', () => { class A { } A.prototype.constructor = A; const f = function () {}; f.toString = () => 'f'; return String(f); });
    tryIt('mapGet', () => { const m = new Map(); m.get = () => 7; return m.get(1); });
    tryIt('arrPush', () => { const a = []; a.push = () => 'own'; return a.push(1); });
    tryIt('onProto', () => { Error.prototype.name = 'X'; return Error.prototype.name; });`);
  assert.equal(o.errName, 'Mine: x');
  assert.equal(o.toString, 'own');
  assert.equal(o.fnName, 'f');
  assert.equal(o.mapGet, 7);
  assert.equal(o.arrPush, 'own');
  assert.equal(o.onProto, 'threw TypeError', 'the prototype itself is still read-only');
});

test('the lockdown keeps code generation from strings off under edwind\'s flag', () => {
  const o = inChild(`lockdown(); tryIt('fn', () => new Function('return 1')()); tryIt('eval', () => (0, eval)('1'));`, ['--disallow-code-generation-from-strings']);
  assert.deepEqual(o, { fn: 'threw EvalError', eval: 'threw EvalError' });
});

test('generators, async functions, iterators and promises work after the lockdown', () => {
  const o = inChild(`lockdown();
    function* g() { yield 1; yield 2; } out.gen = [...g()];
    out.forOf = 0; for (const x of new Set([1, 2, 3])) out.forOf += x;
    out.map = [...new Map([[1, 'a']]).entries()];
    await (async () => { out.awaited = await Promise.resolve(5); })();
    out.json = JSON.stringify({ a: [1, { b: 2 }] });
    out.regexp = 'a1b2'.replace(/\\d/g, '#');`);
  assert.deepEqual(o, { gen: [1, 2], forOf: 6, map: [[1, 'a']], awaited: 5, json: '{"a":[1,{"b":2}]}', regexp: 'a#b#' });
});
