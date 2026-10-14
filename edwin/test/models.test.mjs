// The model layer (spec §12, §14.3, R14.4–R14.7, R12.13–R12.14; the security tests R16.15 and R16.19) against a
// real edwind, a loopback HTTP test backend started here and a fake credentials directory (CREDENTIALS_DIRECTORY).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { makeDir, startEdwind, stopEdwind, EditClient } from './edit-client.mjs';

/* Distinctive key bytes: the whole run is scanned for them at the end (R16.19). */
const KEY = 'sk-test-' + randomBytes(12).toString('hex');
const KEY2 = 'sk-spare-' + randomBytes(12).toString('hex');
const TIERS = { default: 'tier-default', quick: 'tier-quick' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- the loopback test backend: the Messages API shape and a few plain routes ---------- */
function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))); }
function body(req) { return new Promise(r => { let s = ''; req.setEncoding('utf8'); req.on('data', d => { s += d; }); req.on('end', () => r(s)); }); }
function makeBackend() {
  const A = { requests: [], sawKey: 0, failNext: false, holds: [], slow: [], holdOff: false, aborted: 0, origin: null, other: null };
  A.server = http.createServer(async (req, res) => {
    const text = await body(req);
    const rec = { method: req.method, path: req.url, headers: req.headers, body: text ? JSON.parse(text) : null };
    A.requests.push(rec);
    let closed = false;
    res.on('close', () => { closed = true; if (!res.writableFinished) A.aborted++; });
    if (req.headers['x-api-key'] === KEY) A.sawKey++;
    const json = (code, obj, extra = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(obj)); };
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/echo') return json(200, { auth: 'x-api-key' in req.headers, authValue: req.headers['x-api-key'] === KEY, bearer: req.headers.authorization === 'Bearer ' + KEY2, path: u.pathname });
    if (u.pathname === '/redir-same') { res.writeHead(302, { location: '/echo' }); return res.end(); }
    if (u.pathname === '/redir-cross') { res.writeHead(302, { location: A.other.origin + '/echo' }); return res.end(); }
    if (u.pathname === '/fail-next') { A.failNext = true; return json(200, { ok: true }); }
    if (u.pathname === '/release') { A.holdOff = true; for (const h of [...A.holds.splice(0), ...A.slow.splice(0)]) h(); return json(200, { ok: true }); }
    if (u.pathname === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      ev({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Loc' } }] });
      ev({ choices: [{ index: 0, delta: { content: 'al' }, finish_reason: 'stop' }] });
      ev({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } });
      res.write('data: [DONE]\n\n'); return res.end();
    }
    if (u.pathname !== '/v1/messages' || req.method !== 'POST') return json(404, { error: 'no such route' });
    if (req.headers['x-api-key'] !== KEY) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    if (A.failNext) { A.failNext = false; return json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { 'retry-after': '0' }); }
    const b = rec.body;
    const last = b.messages[b.messages.length - 1];
    const lastText = typeof last.content === 'string' ? last.content : last.content.map(p => p.text || '').join('');
    const toolResult = Array.isArray(last.content) ? last.content.find(p => p.type === 'tool_result') : null;
    if (lastText.includes('hold') && !A.holdOff) await new Promise(r => A.holds.push(r));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
    ev('message_start', { message: { id: 'msg_1', role: 'assistant', usage: { input_tokens: 7, output_tokens: 0 } } });
    if (b.tools && b.tools.length && !toolResult) {
      ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: b.tools[0].name, input: {} } });
      ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"id": "x"}' } });
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } });
      ev('message_stop', {}); return res.end();
    }
    const answer = toolResult ? `Tool said: ${toolResult.content}` : lastText.includes('slow') ? 'He' : 'Hello';
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    const parts = answer === 'Hello' ? ['Hel', 'lo'] : [answer];
    for (const p of parts) { ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: p } }); await sleep(10); }
    if (lastText.includes('slow')) {
      /* Stay open until the client cancels (R12.8) or the test releases it. */
      if (!closed) await new Promise(r => { A.slow.push(r); res.on('close', r); });
      if (res.writableEnded || res.destroyed) return;
    }
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
    ev('message_stop', {}); res.end();
  });
  return A;
}
/* Another origin (another loopback port): it must never see the key. */
function makeOther() {
  const B = { requests: [] };
  B.server = http.createServer(async (req, res) => {
    await body(req);
    B.requests.push({ path: req.url, hasKey: 'x-api-key' in req.headers || 'authorization' in req.headers, keyValue: req.headers['x-api-key'] === KEY });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ other: true }));
  });
  return B;
}

let dir, child, A, B, creds;
const received = [];                                     // every message edwind sent to any client of this run
before(async () => {
  A = makeBackend(); B = makeOther();
  A.origin = await listen(A.server); B.origin = await listen(B.server); A.other = B;
  dir = makeDir({ models: { anthropic: { baseUrl: A.origin, credential: 'anthropic-api-key' }, tiers: TIERS, credentials: { 'spare-key': { origin: 'https://example.invalid' } } } });
  creds = path.join(dir.root, 'creds');
  fs.mkdirSync(creds, { mode: 0o700 });
  fs.writeFileSync(path.join(creds, 'anthropic-api-key'), KEY + '\n', { mode: 0o400 });
  fs.writeFileSync(path.join(creds, 'spare-key'), KEY2, { mode: 0o400 });
  child = await startEdwind(dir, { env: { CREDENTIALS_DIRECTORY: creds } });
});
after(async () => {
  await stopEdwind(child);
  await new Promise(r => A.server.close(() => r())); await new Promise(r => B.server.close(() => r()));
  fs.rmSync(dir.root, { recursive: true, force: true });
});
const client = async (opts, d = dir) => {
  const c = new EditClient(d.cfg.socket, opts); await c.connect();
  const push = c.push.bind(c); c.push = m => { received.push(JSON.stringify(m)); push(m); };
  const w = await c.hello(); assert.equal(w.t, 'welcome'); return c;
};
const value = async (c, form) => { const r = await c.form(form); assert.equal(r.error, undefined, JSON.stringify(r.error)); return r.value; };
const failure = async (c, form) => { const r = await c.form(form); assert.ok(r.error, `expected a condition from ${form}, got ${r.value}`); return r.error; };
const note = (name, text) => { fs.writeFileSync(path.join(dir.dirs.notes, name), text); return name; };

test('R12.3, R12.4, R15.11: the default backend comes from edit.json models; status reports sample and the tiers', async () => {
  const c = await client();
  const st = (await c.call('status')).value;
  assert.equal(st.sample, true); assert.deepEqual(st.models, TIERS);
  const bs = (await c.call('model-backends')).value;
  assert.equal(bs.length, 1); assert.equal(bs[0].name, 'workbench'); assert.equal(bs[0].kind, 'anthropic'); assert.equal(bs[0].credential, 'anthropic-api-key'); assert.equal(bs[0].usable, true);
  assert.equal(bs[0].url, A.origin + '/v1/messages'); assert.deepEqual(bs[0].models, ['tier-default', 'tier-quick']);
  assert.equal(await value(c, 'gptel-backend'), '"workbench"');
  assert.equal(await value(c, 'gptel-tiers'), '((default . "tier-default") (quick . "tier-quick"))');
  assert.equal(await value(c, '(gptel-backends)'), '("workbench")');
  assert.equal(await value(c, '(assq-ref (gptel-backend-info) (quote usable))'), '#t');
  assert.equal((await c.call('sample-limits')).value.maxPromptBytes, 4 * 1024 * 1024);
  assert.deepEqual((await c.call('sample-limits')).value, { maxPromptBytes: 4194304, images: true, tools: true });
  c.close();
});

test('R14.7, R16.15: credential handles print as their name and never give up, compare or serialize their contents', async () => {
  const c = await client();
  assert.equal(await value(c, '(credential "anthropic-api-key")'), '#<credential anthropic-api-key>');
  assert.equal(await value(c, '(with-output-to-string (lambda () (display (credential "spare-key"))))'), '"#<credential spare-key>"');
  assert.equal(await value(c, '(with-output-to-string (lambda () (write (credential "anthropic-api-key"))))'), '"#<credential anthropic-api-key>"');
  assert.equal(await value(c, '(format "~a / ~s" (credential "spare-key") (credential "spare-key"))'), '"#<credential spare-key> / #<credential spare-key>"');
  assert.equal(await value(c, '(list (credential? (credential "spare-key")) (string? (credential "spare-key")) (credential-name (credential "spare-key")) (credential-origin (credential "spare-key")) (credential-available? (credential "spare-key")))'), '(#t #f "spare-key" "https://example.invalid" #t)');
  assert.equal(await value(c, '(credential-names)'), '("anthropic-api-key" "spare-key")');
  /* Not a string: nothing that reads characters accepts it. */
  for (const f of ['(string-append (credential "spare-key") "x")', '(string-length (credential "spare-key"))', '(string->symbol (credential "spare-key"))', '(string->list (credential "spare-key"))', '(substring (credential "spare-key") 0 1)', '(string=? (credential "spare-key") "x")']) {
    const e = await failure(c, f);
    assert.equal(e.condition, 'wrong-type-argument', f); assert.doesNotMatch(e.report, /sk-/, f); assert.match(e.report, /#<credential spare-key>/, f);
  }
  /* Not insertable into a buffer, not comparable to anything but itself. */
  assert.equal((await failure(c, '(with-current-buffer (get-buffer-create "*cred*") (insert (credential "spare-key")))')).condition, 'wrong-type-argument');
  assert.equal(await value(c, '(let ((a (credential "spare-key"))) (list (equal? a (credential "spare-key")) (equal? a "x") (eq? a a) (equal? a a)))'), '(#f #f #t #t)');
  /* Only configured names, and the image sees the form, never a key. */
  assert.equal((await failure(c, '(credential "no-such-key")')).condition, 'user-error');
  assert.equal((await failure(c, '(credential "../etc/passwd")')).condition, 'user-error');
  assert.equal(await value(c, '(define my-cred (credential "anthropic-api-key")) my-cred'), '#<credential anthropic-api-key>');
  await sleep(100);
  const image = fs.readFileSync(path.join(dir.dirs.state, 'image.jsonl'), 'utf8');
  assert.match(image, /\(define my-cred \(credential \\"anthropic-api-key\\"\)\)/); assert.ok(!image.includes(KEY));
  /* R16.15: no js-eval-like escape exists; nothing returns the secret. */
  assert.equal(await value(c, '(list (bound? (quote js-eval)) (bound? (quote eval-js)) (bound? (quote js)) (bound? (quote credential-secret)) (bound? (quote credential-value)) (bound? (quote credential->string)))'), '(#f #f #f #f #f #f)');
  assert.equal(await value(c, '(map (lambda (n) (bound? n)) (quote (credential credential? credential-name credential-origin credential-available? credential-names http-request)))'), '(#t #t #t #t #t #t #t)');
  c.close();
});

test('R14.4, R16.19: http-request binds a credential to its origin; same-origin redirects keep the header, cross-origin ones fail', async () => {
  const c = await client();
  const n0 = B.requests.length;
  /* Any URL without a credential. */
  let r = await value(c, `(let ((r (http-request "${A.origin}/echo"))) (list (assq-ref r (quote status)) (assq-ref r (quote body))))`);
  assert.equal(r, '(200 "{\\"auth\\":false,\\"authValue\\":false,\\"bearer\\":false,\\"path\\":\\"/echo\\"}")');
  /* The credential on its own origin, as the named header. */
  r = await value(c, `(assq-ref (http-request "${A.origin}/echo" :credential (credential "anthropic-api-key") :credential-header "x-api-key") (quote body))`);
  assert.match(r, /"authValue\\":true/);
  const saw = A.sawKey; assert.ok(saw >= 1);
  /* Another origin: refused before any request is made (condition credential-origin, the report names the handle only). */
  let e = await failure(c, `(http-request "${B.origin}/echo" :credential (credential "anthropic-api-key") :credential-header "x-api-key")`);
  assert.equal(e.condition, 'credential-origin'); assert.match(e.report, /#<credential anthropic-api-key>/); assert.doesNotMatch(e.report, /sk-test/);
  assert.equal(B.requests.length, n0, 'the other origin saw nothing');
  e = await failure(c, `(http-request "${A.origin}/echo" :credential (credential "spare-key"))`);
  assert.equal(e.condition, 'credential-origin');
  assert.equal(await value(c, `(guard (e ((credential-origin? e) (quote bound))) (http-request "${B.origin}/echo" :credential (credential "anthropic-api-key")))`), 'bound');
  /* A same-origin redirect keeps the header. */
  r = await value(c, `(let ((r (http-request "${A.origin}/redir-same" :credential (credential "anthropic-api-key") :credential-header "x-api-key"))) (list (assq-ref r (quote status)) (assq-ref r (quote url)) (assq-ref r (quote body))))`);
  assert.match(r, /^\(200 "[^"]*\/echo" .*authValue\\":true/);
  assert.equal(A.sawKey, saw + 2, 'both same-origin hops carried the header');
  /* A cross-origin redirect fails the request while a credential is attached: not followed, with or without the header. */
  e = await failure(c, `(http-request "${A.origin}/redir-cross" :credential (credential "anthropic-api-key") :credential-header "x-api-key")`);
  assert.equal(e.condition, 'credential-origin'); assert.doesNotMatch(e.report, /sk-test/);
  assert.equal(B.requests.length, n0, 'the cross-origin redirect was not followed');
  /* Without a credential the same redirect is followed. */
  r = await value(c, `(assq-ref (http-request "${A.origin}/redir-cross") (quote body))`);
  assert.equal(r, '"{\\"other\\":true}"');
  assert.equal(B.requests.length, n0 + 1); assert.equal(B.requests[n0].hasKey, false);
  /* Plain http only to loopback; a credential must be a handle; the on-chunk callback streams the body. */
  e = await failure(c, '(http-request "http://example.invalid/")'); assert.equal(e.condition, 'http-error'); assert.match(e.report, /loopback/);
  e = await failure(c, `(http-request "${A.origin}/echo" :credential "${'not-a-handle'}")`); assert.equal(e.condition, 'wrong-type-argument');
  e = await failure(c, '(http-request "ftp://127.0.0.1/x")'); assert.equal(e.condition, 'http-error');
  r = await value(c, `(let ((chunks (quote ()))) (http-request "${A.origin}/echo" :on-chunk (lambda (s) (set! chunks (cons s chunks)))) (string-prefix? "{\\"auth\\"" (apply string-append (reverse chunks))))`);
  assert.equal(r, '#t');
  c.close();
});

test('R12.1, R12.2: Scheme defines backends with credential handles only; a local backend needs none', async () => {
  const c = await client();
  let e = await failure(c, `(gptel-make-anthropic "typed" :key "${'sk-literal'}")`);
  assert.equal(e.condition, 'user-error'); assert.match(e.report, /credential NAME/);
  e = await failure(c, `(gptel-make-anthropic "wrong" :host "${A.origin}" :key (credential "spare-key"))`);
  assert.equal(e.condition, 'credential-origin');
  assert.equal(await value(c, `(gptel-make-openai "local" :host "${A.origin}" :models (quote ("m1" "m2")) :tiers (quote ((default . "m1"))))`), '#<gptel-backend local>');
  assert.equal(await value(c, '(gptel-backends)'), '("workbench" "local")');
  const r = await value(c, '(gptel-request "hi there" :backend "local" :caller "wb")');
  assert.match(r, /\(text . "Local"\)/); assert.match(r, /\(model . "m1"\)/); assert.match(r, /\(input-tokens . 5\)/);
  const last = A.requests[A.requests.length - 1];
  assert.equal(last.path, '/v1/chat/completions'); assert.equal(last.headers.authorization, undefined);
  assert.equal(last.body.model, 'm1'); assert.deepEqual(last.body.messages, [{ role: 'user', content: 'hi there' }]); assert.deepEqual(last.body.stream_options, { include_usage: true });
  /* A credential of another kind's header: the anthropic backend's own request uses x-api-key. */
  assert.equal(await value(c, `(gptel-make-anthropic "again" :host "${A.origin}" :key (credential "anthropic-api-key") :tiers gptel-tiers)`), '#<gptel-backend again>');
  assert.match(await value(c, '(gptel-request "hello" :backend "again" :tier (quote quick))'), /\(text . "Hello"\) \(truncated . #f\) \(model . "tier-quick"\)/);
  assert.equal(A.requests[A.requests.length - 1].headers['x-api-key'], KEY);
  assert.equal((await failure(c, '(gptel-request "x" :backend "nope")')).condition, 'user-error');
  c.close();
});

test('§12.2 sample: the stream of a web client in the shape edit_client.rs routes, tools answered by the tab, model and tier', async () => {
  const web = await client({ kind: 'web' });
  const tools = [{ name: 'read_node', description: 'd', inputSchema: { type: 'object' } }];
  web.send({ t: 'sample', sid: 's1', tab: 'tab1', input: 'hello', modelTier: 'quick', model: '', effort: 'low', images: [], tools });
  const tool = await web.next(m => m.t === 'sample.tool');
  assert.deepEqual(tool, { t: 'sample.tool', sid: 's1', callId: 'toolu_1', name: 'read_node', input: { id: 'x' } });
  web.send({ t: 'tool_result', sid: 's1', callId: 'toolu_1', result: 'the node' });
  const texts = [];
  for (;;) { const m = await web.next(m => m.sid === 's1' && (m.t === 'sample.text' || m.t === 'sample.done' || m.t === 'sample.error')); if (m.t === 'sample.text') texts.push(m.text); else { assert.equal(m.t, 'sample.done', JSON.stringify(m)); assert.deepEqual(m, { t: 'sample.done', sid: 's1', text: 'Tool said: the node', truncated: false, modelTierApplied: 'quick', modelApplied: 'tier-quick' }); break; } }
  assert.ok(texts.length >= 1 && texts[texts.length - 1] === 'Tool said: the node', JSON.stringify(texts));
  const reqs = A.requests.filter(r => r.path === '/v1/messages').slice(-2);
  assert.equal(reqs[0].body.model, 'tier-quick'); assert.equal(reqs[0].headers['x-api-key'], KEY); assert.deepEqual(reqs[0].body.output_config, { effort: 'low' });
  assert.deepEqual(reqs[0].body.tools, [{ name: 'read_node', description: 'd', input_schema: { type: 'object' } }]);
  assert.equal(reqs[1].body.messages.length, 3); assert.equal(reqs[1].body.messages[2].content[0].tool_use_id, 'toolu_1');
  /* R12.6: a listed model overrides the tier; an unknown one falls back to the tier. */
  web.send({ t: 'sample', sid: 's2', tab: 'tab1', input: 'hi', modelTier: 'quick', model: 'tier-default' });
  let done = await web.next(m => m.sid === 's2' && m.t === 'sample.done');
  assert.equal(done.modelApplied, 'tier-default'); assert.equal(done.text, 'Hello');
  web.send({ t: 'sample', sid: 's3', tab: 'tab1', input: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }], modelTier: 'nonsense', model: 'gpt-x', images: [{ media_type: 'image/png', data: 'AAAA' }] });
  done = await web.next(m => m.sid === 's3' && m.t === 'sample.done');
  assert.equal(done.modelApplied, 'tier-default'); assert.equal(done.modelTierApplied, 'default');
  const last = A.requests[A.requests.length - 1].body;
  assert.equal(last.system, 'be brief'); assert.deepEqual(last.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  /* A tool error goes back to the model as text. */
  web.send({ t: 'sample', sid: 's4', tab: 'tab1', input: 'x', tools });
  const t4 = await web.next(m => m.t === 'sample.tool' && m.sid === 's4');
  web.send({ t: 'tool_error', sid: 's4', callId: t4.callId, message: 'denied' });
  done = await web.next(m => m.sid === 's4' && m.t === 'sample.done');
  assert.equal(done.text, 'Tool said: Error: denied');
  /* Bad input, and a non-web client (§7.9). */
  web.send({ t: 'sample', sid: 's5', tab: 'tab1', input: 42 });
  assert.equal((await web.next(m => m.sid === 's5')).code, 'bad_request');
  const cli = await client();
  cli.send({ t: 'sample', sid: 'c1', input: 'hi' });
  const refused = await cli.next(m => m.t === 'sample.error');
  assert.equal(refused.code, 'bad_request');
  cli.close(); web.close();
});

test('R12.8, R12.13: cancel aborts the HTTP request; rate limits are retried; four requests run at once and the rest queue', async () => {
  const web = await client({ kind: 'web' });
  web.send({ t: 'sample', sid: 'slow1', tab: 't', input: 'slow please' });
  const first = await web.next(m => m.sid === 'slow1' && m.t === 'sample.text');
  assert.equal(first.text, 'He');
  const aborted = A.aborted;
  web.send({ t: 'cancel', sid: 'slow1' });
  const err = await web.next(m => m.sid === 'slow1' && m.t === 'sample.error');
  assert.equal(err.code, 'cancelled'); assert.equal(err.text, 'He');
  for (let i = 0; i < 50 && A.aborted === aborted; i++) await sleep(20);
  assert.equal(A.aborted, aborted + 1, 'edwind closed the upstream request');
  /* A 429 with retry-after is retried (R12.13). */
  await fetch(A.origin + '/fail-next');
  const n = A.requests.filter(r => r.path === '/v1/messages').length;
  web.send({ t: 'sample', sid: 'r1', tab: 't', input: 'hi' });
  const done = await web.next(m => m.sid === 'r1' && (m.t === 'sample.done' || m.t === 'sample.error'));
  assert.equal(done.t, 'sample.done'); assert.equal(done.text, 'Hello');
  assert.equal(A.requests.filter(r => r.path === '/v1/messages').length, n + 2);
  /* At most four model requests at once; the fifth waits for a slot. */
  const before = A.requests.filter(r => r.path === '/v1/messages').length;
  for (let i = 1; i <= 5; i++) web.send({ t: 'sample', sid: 'h' + i, tab: 't', input: 'hold ' + i });
  for (let i = 0; i < 50 && A.holds.length < 4; i++) await sleep(20);
  await sleep(150);
  assert.equal(A.holds.length, 4); assert.equal(A.requests.filter(r => r.path === '/v1/messages').length, before + 4);
  const st = (await web.call('status')).value; assert.equal(st.modelRequests, 4); assert.equal(st.modelQueued, 1);
  await fetch(A.origin + '/release');
  const dones = [];
  for (let i = 1; i <= 5; i++) dones.push(await web.next(m => m.sid === 'h' + i && (m.t === 'sample.done' || m.t === 'sample.error')));
  assert.ok(dones.every(d => d.t === 'sample.done' && d.text === 'Hello'), JSON.stringify(dones));
  A.holdOff = false;
  web.close();
});

test('R12.9, R12.14: gptel-send streams into the buffer as the agent gptel:<backend>; usage is accounted', async () => {
  const id = note('chat.md', 'Say hi');
  const f = await client({ kind: 'frame' }), w = await client();
  const o = await f.open(id); assert.equal(o.text, 'Say hi');
  await w.open(id);
  const r = await f.request({ t: 'call', cmd: 'gptel-send', args: [], ctx: { point: 7 }, buf: id });
  assert.equal(r.error, undefined, JSON.stringify(r.error)); assert.match(r.msg || '', /asking workbench/);
  let text = 'Say hi'; const bys = [];
  const apply = (t, ops) => { for (const [pos, del, ins] of ops) t = t.slice(0, pos) + ins + t.slice(pos + del.length); return t; };
  for (let i = 0; i < 40 && !text.endsWith('Hello'); i++) { const e = await w.next(m => m.t === 'edits' && m.buf === id); text = apply(text, e.ops); bys.push(e.by); }
  assert.equal(text, 'Say hi\n\nHello');
  assert.ok(bys.some(b => b.kind === 'frame' && b.via === 'server'), 'the separator comes from the command thread for the frame');
  assert.ok(bys.some(b => b.kind === 'agent' && b.agent === 'gptel:workbench'), JSON.stringify(bys));
  assert.equal((await w.request({ t: 'call', form: '(buffer-string)', ctx: {}, buf: id })).value, '"Say hi\\n\\nHello"');
  /* The agent is a writer of the buffer (R6.21: undo-writer picks it once thread batches carry undo groups). */
  const writers = (await w.call('list-writers', [], {}, id)).value;
  assert.ok(writers.some(b => b.kind === 'agent' && b.agent === 'gptel:workbench'), JSON.stringify(writers));
  /* Nothing to send; a request per buffer. */
  assert.equal((await w.request({ t: 'call', form: '(with-current-buffer (get-buffer-create "*empty*") (gptel-send))', ctx: {} })).error.condition, 'user-error');
  for (let i = 0; i < 50 && await value(w, '(null? gptel--running)') !== '#t'; i++) await sleep(20);
  assert.equal((await w.request({ t: 'call', form: '(gptel-abort)', ctx: {}, buf: id })).msg, 'gptel: no request is running here');
  /* Accounting: one line per request, never the prompt or the key; model-usage sums them. */
  await sleep(50);
  const usage = fs.readFileSync(path.join(dir.dirs.state, 'usage.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(usage.length >= 10, String(usage.length));
  const gp = usage.find(l => l.caller === 'gptel' && l.backend === 'workbench');
  assert.ok(gp); assert.equal(gp.model, 'tier-default'); assert.equal(gp.tier, 'default'); assert.equal(gp.inputTokens, 7); assert.equal(gp.outputTokens, 3); assert.ok(gp.latencyMs >= 0);
  assert.ok(usage.some(l => l.caller === 'board' && l.error === 'cancelled'));
  assert.ok(usage.every(l => !JSON.stringify(l).includes('Say hi') && !JSON.stringify(l).includes('hello')));
  const sum = (await w.call('model-usage')).value;
  assert.equal(sum.days, 30); assert.equal(sum.requests, usage.length); assert.ok(sum.byCaller.board.requests >= 8); assert.ok(sum.byModel['tier-default'].inputTokens >= 7);
  const scm = await w.request({ t: 'call', form: '(model-usage)', ctx: {} });
  assert.match(scm.msg, /^Model usage, 30 days: \d+ requests/); assert.match(scm.value, /\(by-model/);
  assert.match(await value(w, '(assq-ref (model-usage-summary 30) (quote requests))'), /^\d+$/);
  f.close(); w.close();
});

test('R12.4: without a usable credential sample is off, models is empty and gptel names the missing credential', async () => {
  const empty = path.join(dir.root, 'nocreds'); fs.mkdirSync(empty, { mode: 0o700 });
  const d2 = makeDir({ models: { anthropic: { baseUrl: A.origin, credential: 'anthropic-api-key' }, tiers: TIERS } });
  const c2 = await startEdwind(d2, { env: { CREDENTIALS_DIRECTORY: empty } });
  try {
    const c = await client({}, d2);
    const st = (await c.call('status')).value;
    assert.equal(st.sample, false); assert.deepEqual(st.models, {});
    assert.equal(await value(c, '(credential-available? (credential "anthropic-api-key"))'), '#f');
    const e = (await c.request({ t: 'call', form: '(with-current-buffer (get-buffer-create "*q*") (insert "hi") (gptel-send))', ctx: {} })).error;
    assert.equal(e.condition, 'user-error'); assert.match(e.report, /#<credential anthropic-api-key> is not loaded/);
    const web = await client({ kind: 'web' }, d2);
    web.send({ t: 'sample', sid: 'x', tab: 't', input: 'hi' });
    const err = await web.next(m => m.t === 'sample.error');
    assert.equal(err.code, 'sampling_disabled'); assert.match(err.message, /anthropic-api-key/);
    c.close(); web.close();
    await stopEdwind(c2);
    assert.ok(!c2.logs.includes(KEY));
  } finally { await stopEdwind(c2); fs.rmSync(d2.root, { recursive: true, force: true }); }
});

test('R16.19: the key appears in no log line, journal, image entry, usage line or protocol message of the run', async () => {
  const c = await client();
  await value(c, '(credential "anthropic-api-key")');
  c.close();
  await sleep(100);
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(p); } };
  walk(dir.dirs.state); walk(dir.dirs.notes); walk(dir.dirs.config);
  assert.ok(files.some(f => f.endsWith('image.jsonl')) && files.some(f => f.endsWith('usage.jsonl')) && files.some(f => f.includes('/buffers/')), files.join(','));
  for (const f of files) { const t = fs.readFileSync(f, 'latin1'); assert.ok(!t.includes(KEY) && !t.includes(KEY2), `${f} holds key bytes`); }
  assert.ok(child.logs.length > 100 && !child.logs.includes(KEY) && !child.logs.includes(KEY2), 'the log holds key bytes');
  assert.ok(received.length > 50);
  for (const m of received) assert.ok(!m.includes(KEY) && !m.includes(KEY2), `a protocol message holds key bytes: ${m.slice(0, 200)}`);
  /* The loopback backend saw the key only on its own origin. */
  assert.ok(A.sawKey > 5); assert.ok(B.requests.every(r => !r.hasKey && !r.keyValue));
});
