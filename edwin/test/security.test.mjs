// The Scheme boundary (spec R16.15, R4.52, NG6): nothing in the image reaches JavaScript. The registry has no
// eval-like name, the host's globals are unbound symbols, a procedure prints and inspects as a handle without
// its JavaScript source, and host objects reach Scheme only as opaque handles. The credential cases of R16.19
// are in models.test.mjs; the limits of R16.17 and the socket checks of R16.12 in conformance.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeDir, startEdwind, stopEdwind, EditClient } from './edit-client.mjs';

let dir, child;
before(async () => { dir = makeDir(); child = await startEdwind(dir); });
after(async () => { await stopEdwind(child); fs.rmSync(dir.root, { recursive: true, force: true }); });
const client = async (opts) => { const c = new EditClient(dir.cfg.socket, opts); await c.connect(); const w = await c.hello(); assert.equal(w.t, 'welcome'); return c; };

test('R16.15 the primitive registry has no JavaScript escape hatch, and the host globals are not bound', async () => {
  const c = await client();
  const prims = (await c.call('primitives')).value;
  const names = prims.map(p => p.name);
  for (const n of names) assert.doesNotMatch(n, /^js|js-eval|javascript|->js$|^js->|eval-js|new-function|^globalthis$|^process$/i, n);
  for (const sym of ['js-eval', 'globalThis', 'process', 'Function', 'eval-js', 'import', 'window', 'document', 'Reflect', 'Proxy', 'WebAssembly']) {
    const r = await c.form(`(${sym})`);
    assert.ok(r.error && (r.error.condition === 'unbound-variable' || r.error.condition === 'error' || r.error.condition === 'wrong-type-argument'), `${sym}: ${JSON.stringify(r)}`);
    if (r.error.condition === 'unbound-variable') continue;
    assert.doesNotMatch(r.error.report, /\[native code\]|function \(/, sym);
  }
  assert.equal((await c.form('(eval (quote (js-eval "1")))')).error.condition, 'unbound-variable', 'R4.52: no js-eval');
  c.close();
});

test('R16.15 procedures, records and host objects print as handles, never as JavaScript source', async () => {
  const c = await client();
  for (const form of ['car', '(lambda (x) x)', '(current-thread)', '(make-mutex)', '(make-mailbox)', '(current-buffer)', '(make-hash-table)', '(run-with-timer 10 #f (lambda () 1))']) {
    const r = await c.form(`(with-output-to-string (lambda () (write ${form}) (display " ") (display ${form})))`);
    assert.equal(r.error, undefined, form + ': ' + JSON.stringify(r.error));
    assert.doesNotMatch(r.value, /function|=>|\[native code\]|\{[^}]*:/, form + ' prints as a handle: ' + r.value);
  }
  assert.doesNotMatch((await c.form('(with-output-to-string (lambda () (write (list-clients-internal))))')).value, /socket|Socket|_handle/, 'a client prints without its socket');
  /* The inspector shows parts of a procedure (name, parameters, documentation), not its JavaScript. */
  await c.form('(inspect car)');
  const o = await c.open('name:*Inspector*');
  assert.match(o.text, /Inspecting the procedure car/);
  assert.doesNotMatch(o.text, /function|=>|\[native code\]/);
  c.close();
});

test('R16.15 a procedure\'s properties cannot be reached or changed from Scheme', async () => {
  const c = await client();
  /* No primitive takes or gives a JavaScript property: the only way at a procedure is to call it. */
  for (const form of ['(car (quote (1)) (quote __proto__))', '(string->symbol "constructor")', '(symbol-value (quote constructor))', '(hash-table-ref/default (make-hash-table) "__proto__" 1)']) {
    const r = await c.form(form);
    if (r.error) assert.ok(['wrong-number-of-arguments', 'unbound-variable', 'error', 'wrong-type-argument'].includes(r.error.condition), form + ': ' + r.error.condition);
    else assert.doesNotMatch(r.value, /function|\[object/, form + ': ' + r.value);
  }
  assert.equal((await c.form('(define x (make-hash-table)) (hash-table-set! x "__proto__" 7) (hash-table-ref/default x "__proto__" #f)')).value, '7', 'hash tables are Maps: prototype keys are plain keys');
  assert.equal((await c.form('(+ 1 1)')).value, '2');
  c.close();
});
