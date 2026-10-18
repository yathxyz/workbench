// Evaluator benchmarks for Edwin Scheme: `node edwin/test/scheme-bench.mts [repetitions]`.
//
// Runs each benchmark on src/scheme.js with the shadow stack compiled in and compiled out
// (globalThis.SCHEME_SHADOW_STACK = false at load), in generator mode (globalThis.SCHEME_MODE = 'gen',
// edwind's evaluator, R4.38), and, for information, on the evaluator before the shadow stack (the
// newest commit whose scheme.js has none). Every evaluator is loaded into its own contexts; the runs
// are interleaved and the best is kept. Prints a table and exits 1 when the shadow stack costs more
// than 10% or generator mode more than 3x direct mode (geometric means over the benchmarks).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import v8 from 'node:v8';
import vm from 'node:vm';
import { ROOT, SCHEME_FILE, loadSchemeIn } from './scheme-load.mts';
import type { Scheme, SchemeValue } from './scheme-load.mts';

/* An evaluator to time: how to load it, and its loaded instances. */
interface Variant { name: string; load: () => Scheme; instances?: Scheme[] }
interface Run { vi: number; thunk: () => SchemeValue }
interface Row { name: string; best: number[]; info: boolean }

const REPS = Number(process.argv[2]) || 7;
const LIMIT = 0.10;
const GEN_LIMIT = 3.0;

const BENCHES: [name: string, setup: string, expr: string][] = [
  ['fib 25', '(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))', '(fib 25)'],
  ['tak 18 12 6', '(define (tak x y z) (if (not (< y x)) z (tak (tak (- x 1) y z) (tak (- y 1) z x) (tak (- z 1) x y))))', '(tak 18 12 6)'],
  ['do loop 3e5', '', '(do ((i 0 (+ i 1)) (s 0 (+ s i))) ((= i 300000) s))'],
  ['list map/fold', '(define (sum-sq k) (fold + 0 (map (lambda (x) (* x x)) (iota k))))',
    '(let loop ((k 0) (acc 0)) (if (= k 120) acc (loop (+ k 1) (+ acc (sum-sq 1000)))))'],
  ['recursive list sum', '(define (sum-list l) (if (null? l) 0 (+ (car l) (sum-list (cdr l))))) (define big-list (iota 1000))',
    '(let loop ((k 0) (acc 0)) (if (= k 120) acc (loop (+ k 1) (+ acc (sum-list big-list)))))'],
  ['string ops', `(define (str-work n)
      (let loop ((i 0) (acc ""))
        (if (= i n) (string-length acc)
            (loop (+ i 1) (let ((s (string-append "item-" (number->string i))))
                            (if (string-prefix? "item-1" s) (string-append (substring acc 0 (min 20 (string-length acc))) (string-upcase s)) acc))))))`,
    '(let loop ((k 0)) (if (< k 10) (begin (str-work 2000) (loop (+ k 1))) (str-work 2000)))'],
  ['closures', `(define (make-counter) (let ((n 0)) (lambda () (set! n (+ n 1)) n)))
    (define (compose2 f g) (lambda (x) (f (g x))))
    (define (closure-work n)
      (let ((c (make-counter)) (h (compose2 (lambda (x) (+ x 1)) (lambda (x) (* x 2)))))
        (let loop ((i 0) (acc 0)) (if (= i n) (+ acc (c)) (begin (c) (loop (+ i 1) (+ acc (h i))))))))`,
    '(closure-work 80000)'],
  ['assoc & hash tables', `(define alist (map (lambda (i) (cons i (* i i))) (iota 50)))
    (define (table-work n)
      (let ((h (make-hash-table)))
        (do ((i 0 (+ i 1))) ((= i n))
          (hash-table-set! h i (cdr (assv (modulo i 50) alist))))
        (let loop ((i 0) (acc 0)) (if (= i n) acc (loop (+ i 1) (+ acc (hash-table-ref/default h i 0)))))))`,
    '(table-work 40000)'],
];

function baselineSource(): { src: string; commit: string } | null {
  try {
    const commits = execFileSync('git', ['log', '--format=%H', '--', 'edwin/src/scheme.js'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
    for (const c of commits) {
      const src = execFileSync('git', ['show', `${c}:edwin/src/scheme.js`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
      if (!src.includes('SCHEME_SHADOW_STACK')) return { src, commit: c.slice(0, 8) };
    }
  } catch (e) { /* no git: skip the baseline */ }
  return null;
}

// Each variant is loaded INSTANCES times (identical code in two contexts can differ by a few percent
// once compiled), and a variant's time is the best over its instances and the repetitions; a full
// collection runs before every timed run.
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
const INSTANCES = 2;
const current = readFileSync(SCHEME_FILE, 'utf8');
const base = baselineSource();
const variants: Variant[] = [
  { name: 'shadow on', load: () => loadSchemeIn(current) },
  { name: 'shadow off', load: () => loadSchemeIn(current, { SCHEME_SHADOW_STACK: false }) },
  { name: 'generator mode', load: () => loadSchemeIn(current, { SCHEME_MODE: 'gen' }) },
];
if (base) variants.push({ name: `original ${base.commit}`, load: () => loadSchemeIn(base.src) });
for (const v of variants) v.instances = Array.from({ length: INSTANCES }, v.load);
if (variants[0].instances![0].shadowStack !== true || variants[1].instances![0].shadowStack !== false) throw new Error('could not load the evaluator with the shadow stack in and out');
if (variants[2].instances![0].mode !== 'gen') throw new Error('could not load the evaluator in generator mode');

const rows: Row[] = [];
for (const [name, setup, expr] of [...BENCHES, ['fib 25 inside guard', '', '(guard (e (#t #f)) (fib 25))'] as const]) {
  const runs: Run[] = [];
  for (const [vi, v] of variants.entries()) for (const S of v.instances!) {
    if (setup) S.evalString(setup);
    const form = S.readAll(expr)[0];
    runs.push({ vi, thunk: () => { S.watchdog.reset(); return S.evalForm(form); } });
  }
  const results = runs.map(r => v2s(r.thunk()));
  if (new Set(results).size !== 1) throw new Error(`${name}: the evaluators disagree: ${results.join(' / ')}`);
  for (const r of runs) { r.thunk(); r.thunk(); }
  const best = variants.map(() => Infinity);
  for (let rep = 0; rep < REPS; rep++) {
    for (const r of runs) { gc(); const t0 = performance.now(); r.thunk(); best[r.vi] = Math.min(best[r.vi], performance.now() - t0); }
  }
  rows.push({ name, best, info: name.includes('guard') });
}
function v2s(x: SchemeValue): string { return typeof x === 'bigint' ? x.toString() : String(x); }

const pct = (a: number, b: number): string => ((a / b - 1) * 100).toFixed(1).padStart(6) + '%';
const head = ['benchmark'.padEnd(22), ...variants.map(v => v.name.padStart(18)), 'shadow cost'.padStart(12), 'gen / direct'.padStart(12), base ? 'vs original'.padStart(12) : ''];
/* The stack the run had (nix/checks.nix runs the bench with --stack-size, as the deep recursions need it). */
const stack = [...process.execArgv, ...(process.env.NODE_OPTIONS || '').split(/\s+/)].filter(f => /^--stack[-_]size\b/.test(f)).pop();
console.log(`node ${process.version}, ${stack || 'the default --stack-size'}, best of ${REPS} runs`);
console.log(head.join(' '));
const ratios: number[] = [], genRatios: number[] = [];
for (const r of rows) {
  const cost = r.best[0] / r.best[1], genCost = r.best[2] / r.best[0];
  if (!r.info) { ratios.push(cost); genRatios.push(genCost); }
  console.log([r.name.padEnd(22), ...r.best.map(t => (t.toFixed(2) + ' ms').padStart(18)), pct(r.best[0], r.best[1]).padStart(12), (genCost.toFixed(2) + 'x').padStart(12), base ? pct(r.best[0], r.best[3]).padStart(12) : ''].join(' ') + (r.info ? '   (handler installed: informational)' : ''));
}
const geomean = (xs: number[]): number => Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length);
const geo = geomean(ratios), geoGen = geomean(genRatios);
console.log(`\nshadow stack overhead (geometric mean of ${ratios.length} benchmarks, best of ${REPS} runs x ${INSTANCES} instances): ${((geo - 1) * 100).toFixed(1)}%  (limit ${LIMIT * 100}%)`);
console.log(`generator mode / direct mode (geometric mean): ${geoGen.toFixed(2)}x  (limit ${GEN_LIMIT}x)`);
let failed = false;
if (geo - 1 > LIMIT) { console.log('FAIL: the shadow stack costs more than the limit'); failed = true; }
if (geoGen > GEN_LIMIT) { console.log('FAIL: generator mode is slower than the limit'); failed = true; }
if (failed) process.exit(1);
console.log('ok');
