// The intrinsics lockdown of edwind's threads (R14.11, R16.16), in place of Node's --frozen-intrinsics.
//
// --frozen-intrinsics made the Scheme evaluator 2.3 times slower: V8 leaves its fast paths for every object
// once a property of Array.prototype or Object.prototype is read-only. lockdown() does what the flag did,
// with Node's own lists (lib/internal/freeze_intrinsics.js), except for those two prototypes: they are
// sealed, not frozen. A sealed prototype takes no new keys and loses none (the prototype-pollution case);
// what it no longer refuses is an assignment over one of its existing methods. The functions they hold are
// frozen like every other intrinsic. As with the flag, a data property of a frozen prototype becomes an
// accessor whose setter makes an own property on the derived object, so `err.name = 'X'` still works; the
// iterator and generator prototypes (those with their own `next`) keep plain read-only data properties,
// because an accessor `next` costs every for-of loop and every generator step (15% on map/fold in gen mode)
// and nothing assigns `next` on an iterator.
//
// The lockdown is plain JavaScript and engine-neutral. It runs once per realm: main() in main.mts (the main
// thread and the server thread), worker.mts (the pool) and notes-parse.mts (the notes thread).

export type LockdownState = 'locked' | 'partial' | 'open';
/* Constructors looked up by name (WebAssembly.Module, Intl.Collator, …), any of which a build may lack. */
type Ctors = Record<string, { prototype: object } | undefined>;
declare const WebAssembly: Ctors; // the lib has no WebAssembly types without DOM

const SEALED = new Set<object>([Object.prototype, Array.prototype]);
let state: LockdownState | null = null;

const protoOf = Object.getPrototypeOf;
const fnProto = (f: Function) => protoOf(f);
const has = (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k);

function lists(): { prototypes: object[]; intrinsics: unknown[] } {
  const TypedArray = protoOf(Int8Array);
  const typed = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array];
  const ArrayIteratorPrototype = protoOf([][Symbol.iterator]());
  const IteratorPrototype = protoOf(ArrayIteratorPrototype);
  const StringIteratorPrototype = protoOf(''[Symbol.iterator]());
  const RegExpStringIteratorPrototype = protoOf(/./[Symbol.matchAll](''));
  const MapIteratorPrototype = protoOf(new Map()[Symbol.iterator]());
  const SetIteratorPrototype = protoOf(new Set()[Symbol.iterator]());
  const GeneratorFunctionPrototype = fnProto(function* () {});
  const AsyncGeneratorFunctionPrototype = fnProto(async function* () {});
  const AsyncFunctionPrototype = fnProto(async function () {});
  const AsyncIteratorPrototype = protoOf(AsyncGeneratorFunctionPrototype.prototype);
  const IteratorHelperPrototype = typeof Iterator === 'function' && (Iterator.prototype as { map?: unknown }).map ? protoOf([].values().map(x => x)) : null;
  const WrapForValidIteratorPrototype = typeof Iterator === 'function' && Iterator.from ? protoOf(Iterator.from({ next() {} } as Iterator<unknown>)) : null;
  const errors = [Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError, ...(typeof AggregateError === 'function' ? [AggregateError] : [])];

  const prototypes: (object | null)[] = [
    Object.prototype, Function.prototype, Boolean.prototype, Symbol.prototype,
    ...errors.map(e => e.prototype),
    Number.prototype, BigInt.prototype, Date.prototype,
    String.prototype, StringIteratorPrototype, RegExp.prototype, RegExpStringIteratorPrototype,
    Array.prototype, ArrayIteratorPrototype, TypedArray.prototype, ...typed.map(t => t.prototype),
    Map.prototype, MapIteratorPrototype, Set.prototype, SetIteratorPrototype, WeakMap.prototype, WeakSet.prototype,
    ArrayBuffer.prototype, DataView.prototype, WeakRef.prototype, FinalizationRegistry.prototype,
    IteratorHelperPrototype, IteratorPrototype, WrapForValidIteratorPrototype, AsyncIteratorPrototype, Promise.prototype,
    GeneratorFunctionPrototype, AsyncGeneratorFunctionPrototype, GeneratorFunctionPrototype.prototype,
    AsyncGeneratorFunctionPrototype.prototype, AsyncFunctionPrototype,
  ];
  const intrinsics: unknown[] = [
    Object.getOwnPropertyDescriptor(Function.prototype, 'caller')?.get,
    globalThis.eval, isFinite, isNaN, parseFloat, parseInt, decodeURI, decodeURIComponent, encodeURI, encodeURIComponent,
    Object, Function, Boolean, Symbol, ...errors, Number, BigInt, Math, Date,
    String, StringIteratorPrototype, RegExp, RegExpStringIteratorPrototype,
    Array, ArrayIteratorPrototype, TypedArray, ...typed,
    Map, MapIteratorPrototype, Set, SetIteratorPrototype, WeakMap, WeakSet,
    ArrayBuffer, DataView, globalThis.Atomics, JSON, WeakRef, FinalizationRegistry,
    IteratorHelperPrototype, globalThis.Iterator, WrapForValidIteratorPrototype, Promise,
    GeneratorFunctionPrototype, AsyncGeneratorFunctionPrototype, AsyncFunctionPrototype,
    Reflect, Proxy, globalThis.escape, globalThis.unescape,
    globalThis.clearImmediate, globalThis.clearInterval, globalThis.clearTimeout,
    globalThis.setImmediate, globalThis.setInterval, globalThis.setTimeout, globalThis.console,
  ];
  if (typeof SharedArrayBuffer === 'function') { prototypes.push(SharedArrayBuffer.prototype); intrinsics.push(SharedArrayBuffer); }
  if (typeof WebAssembly === 'object') {
    for (const k of ['Module', 'Instance', 'Table', 'Memory', 'CompileError', 'LinkError', 'RuntimeError']) if (WebAssembly[k]) prototypes.push(WebAssembly[k]!.prototype);
    intrinsics.push(WebAssembly);
  }
  if (typeof Intl === 'object') {
    for (const k of ['Collator', 'DateTimeFormat', 'ListFormat', 'NumberFormat', 'PluralRules', 'RelativeTimeFormat']) if ((Intl as unknown as Ctors)[k]) prototypes.push((Intl as unknown as Ctors)[k]!.prototype);
    intrinsics.push(Intl);
  }
  if (globalThis.console && typeof globalThis.console.Console === 'function') prototypes.push(globalThis.console.Console.prototype);
  return { prototypes: prototypes.filter(Boolean) as object[], intrinsics: intrinsics.filter(Boolean) };
}

/* A configurable data property of OBJ becomes an accessor: reading gives the value, assigning on OBJ itself
   throws, assigning on a derived object makes an own property there (the override mistake, ES5 15.2.3.9). */
function enableDerivedOverrides(obj: object): void {
  for (const prop of Reflect.ownKeys(obj)) {
    const desc = Object.getOwnPropertyDescriptor(obj, prop)!;
    if (!has(desc, 'value') || !desc.configurable) continue;
    const value = desc.value;
    const getter = function () { return value; };
    getter.value = value; // so the deep freeze reaches the value through the getter
    const setter = function (this: Record<PropertyKey, unknown>, v: unknown) {
      if (this === obj) throw new TypeError(`Cannot assign to read only property '${String(prop)}' of object`);
      if (has(this, prop)) this[prop] = v;
      else Object.defineProperty(this, prop, { value: v, writable: true, enumerable: true, configurable: true });
    };
    Object.defineProperty(obj, prop, { get: getter, set: setter, enumerable: desc.enumerable, configurable: desc.configurable });
  }
}

/* Freeze ROOT and everything reachable from it through prototypes and properties; SEALED objects are
   sealed instead and their values still followed. */
function deepFreeze(root: unknown, done: WeakSet<object>): void {
  const queue: unknown[] = [root];
  while (queue.length) {
    const obj = queue.pop() as object;
    if (Object(obj) !== obj || done.has(obj)) continue;
    done.add(obj);
    if (SEALED.has(obj)) Object.seal(obj); else Object.freeze(obj);
    queue.push(protoOf(obj));
    for (const d of Object.values(Object.getOwnPropertyDescriptors(obj))) {
      if (has(d, 'value')) queue.push(d.value); else queue.push(d.get, d.set);
    }
  }
}

/* Lock this realm's intrinsics down; a second call does nothing. Returns lockdownState(). */
export function lockdown(): LockdownState {
  if (state) return state;
  const { prototypes, intrinsics } = lists();
  for (const p of prototypes) if (!SEALED.has(p) && !has(p, 'next')) enableDerivedOverrides(p);
  const done = new WeakSet<object>();
  for (const x of intrinsics) deepFreeze(x, done);
  Object.defineProperty(globalThis, 'globalThis', { value: globalThis, writable: false, configurable: false });
  state = lockdownState();
  return state;
}

/* What the realm's intrinsics look like now (the conformance suite and the listen log line read it). */
export function lockdownState(): LockdownState {
  const frozen = [Function.prototype, String.prototype, Map.prototype, Promise.prototype, Error.prototype, JSON, Math, Reflect].every(Object.isFrozen);
  const sealed = [...SEALED].every(Object.isSealed);
  return frozen && sealed ? 'locked' : frozen || sealed ? 'partial' : 'open';
}
