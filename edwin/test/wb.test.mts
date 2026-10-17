// Workbench as Lisp objects, the session family and the events (spec §5: R5.2, R5.3, R5.4, R5.7, R5.8; R13.9)
// against a real edwind and a fake hub (fake-hub.mts). The board family is absent until EW-M4 (R5.3).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeDir, startEdwind, stopEdwind, EditClient } from './edit-client.mts';
import type { TestDir, EdwindChild, ClientOptions } from './edit-client.mts';
import { FakeHub } from './fake-hub.mts';
import type { AcpSession } from './fake-hub.mts';
import { Wb } from '../server/wb.mts';

let dir: TestDir, child: EdwindChild, hub: FakeHub, boardsDir: string;
before(async () => {
  dir = makeDir();
  boardsDir = path.join(dir.root, 'boards'); fs.mkdirSync(boardsDir, { mode: 0o700 });
  fs.writeFileSync(path.join(boardsDir, 'test.json'), JSON.stringify({ nodes: { n_shell1: { id: 'n_shell1', kind: 'term', x: 0, y: 0 } }, edges: [] }));
  const hubPath = path.join(dir.dirs.sock, 'hub.sock');
  fs.writeFileSync(dir.file, JSON.stringify({ ...dir.cfg, hubSocket: hubPath, boardsDir }));
  hub = await new FakeHub(hubPath).start();
  hub.addPty('n_shell1', { viewers: 1 });
  hub.addPty('n_dead', { alive: false, viewers: 0, exit: { code: 2, signal: null, reason: 'exited', at: 1 } });
  hub.addAcp('n_agent1');
  hub.acpReplays.set('n_agent1', [
    { seq: 1, ts: 1, e: 'prompt', prompt: [{ type: 'text', text: 'hello agent' }] },
    { seq: 2, ts: 2, e: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' } } },
    { seq: 3, ts: 3, e: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'user' } } },
    { seq: 4, ts: 4, e: 'turn_end', stopReason: 'end_turn' },
  ]);
  (hub.sessions.get('n_agent1') as AcpSession).summary.acp.headSeq = 4; (hub.sessions.get('n_agent1') as AcpSession).summary.acp.seenSeq = 4;
  child = await startEdwind(dir);
});
after(async () => { await stopEdwind(child); await hub.stop(); fs.rmSync(dir.root, { recursive: true, force: true }); });
const client = async (opts?: ClientOptions) => { const c = new EditClient(dir.cfg.socket, opts); await c.connect(); const w = await c.hello(); assert.equal(w.t, 'welcome'); return c; };
const value = async (c: EditClient, form: string) => { const r = await c.form(form); assert.equal(r.error, undefined, JSON.stringify(r.error)); return r.value; };
const until = async (fn: () => unknown, what: string, ms = 10000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await new Promise(r => setTimeout(r, 25)); } };
const hubUp = (c: EditClient) => until(async () => (await value(c, '(hub-status)')) === 'up', 'the hub to be up');

test('unit: the Org transcript of an ACP replay', () => {
  const t = Wb.transcript([{ e: 'prompt', prompt: [{ type: 'text', text: 'hi' }] }, { e: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' } } }, { e: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'there' } } }, { e: 'turn_end', stopReason: 'end_turn' }]);
  assert.equal(t, '* User\n\nhi\n\n* Agent\n\nhello there\n');
});

test('R5.3 the features: wb-hub is present, wb-board is absent and its procedures are unbound', async () => {
  const c = await client(); await hubUp(c);
  assert.equal(await value(c, "(list (featurep 'wb-hub) (featurep 'wb-board) (featurep 'process))"), '(#t #f #t)');
  for (const f of ['board-cards', 'find-card', 'open-card', 'link-cards', 'card-move']) assert.equal((await c.form(`(${f})`)).error.condition, 'unbound-variable', f + ' is absent');
  c.close();
});

test('R5.2, R5.3 session-list, session-get, interned handles, stale-object and hub-error', async () => {
  const c = await client(); await hubUp(c);
  assert.equal(await value(c, '(sort (map session-id (session-list)) string<?)'), '("n_agent1" "n_dead" "n_shell1")');
  assert.equal(await value(c, '(define s (session-get "n_shell1")) (list (session? s) (eq? s (session-get "n_shell1")) (eq? s (car (member s (session-list)))))'), '(#t #t #t)');
  assert.equal(await value(c, "(list (session-get s 'kind) (session-get s 'alive) (session-get s 'viewers) (session-get s 'cwd) (session-get s 'title) (session-get s 'agent))"), '(pty #t 1 "/home/test" "bash" #f)');
  assert.equal(await value(c, "(define a (session-get \"n_agent1\")) (list (session-get a 'kind) (session-get a 'agent) (session-get a 'title) (session-get a 'activity))"), '(acp "agent" "Fix flaky test" none)');
  assert.equal(await value(c, "(list (session-get \"n_dead\" 'alive) (cdr (assq 'code (session-get \"n_dead\" 'exit))))"), '(#f 2)');
  assert.equal(await value(c, "(cdr (assq 'sid (session-summary s)))"), '"n_shell1"');
  assert.equal((await c.form('(session-get "n_nothere")')).error.condition, 'stale-object');
  assert.equal((await c.form("(session-get s 'bogus)")).error.condition, 'error');
  assert.equal(await value(c, '(object->string s)'), '"#<session pty n_shell1>"');
  c.close();
});

test('R5.3 card-send, card-read, card-interrupt and card-kill on PTY and agent sessions; R5.4 confirmation', async () => {
  const c = await client(); await hubUp(c);
  assert.equal(await value(c, '(session-id (card-send (session-get "n_shell1") "make\\n"))'), '"n_shell1"');
  const [inp] = await hub.waitFor(r => r.t === 'pty.input' && r.sid === 'n_shell1');
  assert.equal(inp.d, 'make\n', 'R5.8: (card-send (find-card "build") "make\\n") reaches the PTY as pty.input, no attach needed');
  assert.equal(hub.requests.filter(r => r.t === 'pty.open' && r.sid === 'n_shell1').length, 0, 'no attach for a send');
  assert.equal(await value(c, '(session-id (card-send "n_agent1" "do it"))'), '"n_agent1"');
  const [pr] = await hub.waitFor(r => r.t === 'acp.prompt' && r.sid === 'n_agent1');
  assert.deepEqual(pr.prompt, [{ type: 'text', text: 'do it' }], 'one text block');
  hub.emitOut('n_shell1', 'line one\r\nline two\r\n\x1b[32mgreen\x1b[0m\r\n');
  assert.equal(await value(c, '(card-read "n_shell1")'), '"line one\\nline two\\ngreen"');
  const [cap] = await hub.waitFor(r => r.t === 'pty.capture' && r.sid === 'n_shell1');
  assert.equal(cap.lines, 200);
  assert.equal(await value(c, '(card-read "n_shell1" :lines 1)'), '"green"');
  await until(() => (hub.sessions.get('n_agent1') as AcpSession).summary.acp.activity === 'none' && (hub.sessions.get('n_agent1') as AcpSession).summary.acp.headSeq > 4, 'the fake turn');
  const t = await value(c, '(card-read "n_agent1")');
  assert.equal(JSON.parse(t), '* User\n\nhello agent\n\n* Agent\n\nhello user\n\n* User\n\ndo it\n\n* Agent\n\nYou said: do it\n', 'the Org transcript of the replay');
  await hub.waitFor(r => r.t === 'acp.detach' && r.sid === 'n_agent1');
  assert.equal(await value(c, '(session-id (card-interrupt "n_shell1"))'), '"n_shell1"');
  await hub.waitFor(r => r.t === 'pty.input' && r.sid === 'n_shell1' && r.d === '\x03');
  await value(c, '(card-interrupt "n_agent1")');
  await hub.waitFor(r => r.t === 'acp.cancel' && r.sid === 'n_agent1');
  const refused = await c.form('(card-kill "n_shell1")');
  assert.equal(refused.error.condition, 'user-error', 'a cli has no frame to confirm in: :force is required from code (R5.4)');
  assert.equal(hub.requests.filter(r => r.t === 'pty.kill').length, 0);
  assert.equal(await value(c, '(session-id (card-kill "n_dead" :force #t))'), '"n_dead"');
  const [kill] = await hub.waitFor(r => r.t === 'pty.kill' && r.sid === 'n_dead');
  assert.equal(kill.forget, false);
  assert.equal((await c.form('(card-send "nope" "x")')).error.condition, 'stale-object');
  c.close();
});

test('R5.3 acp-prompt blocks until the turn ends and returns the message; acp-prompt-async gives a mailbox; the turn-end hook fires', async () => {
  const c = await client(); await hubUp(c);
  const head = (hub.sessions.get('n_agent1') as AcpSession).summary.acp.headSeq;
  assert.equal(await value(c, "(define turns '()) (add-hook! 'wb-acp-turn-end-functions (lambda (s outcome) (set! turns (cons (list (session-id s) outcome) turns)))) (acp-prompt (session-get \"n_agent1\") \"ping\")"), '"You said: ping"');
  const opens = hub.requests.filter(r => r.t === 'acp.open' && r.sid === 'n_agent1');
  const last = opens[opens.length - 1];
  assert.equal(last.since, head, 'attached from the head: no replay'); assert.ok(typeof last.epoch === 'number');
  await until(async () => (await value(c, 'turns')) !== '()', 'wb-acp-turn-end-functions');
  assert.equal(await value(c, 'turns'), '(("n_agent1" "end_turn"))');
  assert.equal(await value(c, '(define mb (acp-prompt-async "n_agent1" "pong")) (mailbox-receive! mb 5)'), '"You said: pong"');
  assert.equal((await c.form('(acp-prompt "n_shell1" "x")')).error.condition, 'wrong-type-argument');
  c.close();
});

test('R5.3 shell-run opens an interactive shell card, sends the command and returns the output once the shell is back in front', async () => {
  const c = await client(); await hubUp(c);
  hub.programs.set('build', async io => { io.write('compiling\r\n'); await io.delay(30); io.write('done\r\n'); return 0; });
  const out = JSON.parse(await value(c, '(shell-run "build" :cwd "/home/test/proj")'));
  assert.match(out, /^(\$ )?build\ncompiling\ndone\n\$ $/, 'the echo of the command, its output and the new prompt, ANSI stripped');
  const [open] = await hub.waitFor(r => r.t === 'pty.open' && r.spawn && r.spawn.argv.length === 1);
  assert.deepEqual(open.spawn, { argv: ['bash'], shell: 'bash', cwd: '/home/test/proj' }, 'a single-item argv: the hub starts the shell interactively');
  assert.match(open.sid, /^ed-/);
  assert.equal(await value(c, '(process-card-p (get-process "shell-run"))'), '#t', ':card t (§5)');
  assert.equal((await c.form('(shell-run "sleep 30" :timeout 0.3)')).error.condition, 'timeout');
  c.close();
});

test('§5 events: wb-session-exit-functions (R5.8), wb-session-output-functions attaches only while non-empty (R5.7), wb-page-saved-functions', async () => {
  const c = await client(); await hubUp(c);
  assert.equal(await value(c, "(define exits '()) (add-hook! 'wb-session-exit-functions (lambda (s code) (unless (zero? code) (set! exits (cons (list (session-get s 'title) code) exits))))) 'ok"), 'ok');
  hub.addPty('n_shell2', { viewers: 1 });
  await until(async () => (await value(c, '(and (member "n_shell2" (map session-id (session-list))) #t)')) === '#t', 'the new session');
  hub.exitSession('n_shell2', { code: 3 });
  await until(async () => (await value(c, 'exits')) !== '()', 'wb-session-exit-functions');
  assert.equal(await value(c, 'exits'), '(("bash" 3))');
  /* Output hook: edwind attaches to n_shell1 (viewers 1, not spawned by edwind) only once the hook is non-empty. */
  assert.equal(hub.requests.filter(r => r.t === 'pty.open' && r.sid === 'n_shell1').length, 0);
  assert.equal(await value(c, "(define outs '()) (define (on-out s text) (set! outs (cons (cons (session-id s) text) outs))) (add-hook! 'wb-session-output-functions on-out) 'ok"), 'ok');
  const [att] = await hub.waitFor(r => r.t === 'pty.open' && r.sid === 'n_shell1');
  assert.equal(att.spawn, undefined, 'an attach never spawns (R5.7)');
  assert.equal(hub.requests.filter(r => r.t === 'pty.resize').length, 0, 'edwind never resizes a session it did not spawn');
  await until(async () => (await c.call('status')).value.wbAttached === 1, 'the attachment to complete');
  hub.emitOut('n_shell1', 'a'); hub.emitOut('n_shell1', 'b'); hub.emitOut('n_shell1', 'c');
  await until(async () => (await value(c, 'outs')) !== '()', 'wb-session-output-functions');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(await value(c, 'outs'), '(("n_shell1" . "abc"))', 'coalesced into one call');
  assert.equal(await value(c, "(remove-hook! 'wb-session-output-functions on-out) 'ok"), 'ok');
  await hub.waitFor(r => r.t === 'pty.detach' && r.sid === 'n_shell1');
  hub.emitOut('n_shell1', 'late');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(await value(c, 'outs'), '(("n_shell1" . "abc"))', 'detached: nothing more');
  /* Page saved. */
  assert.equal(await value(c, "(define saved '()) (add-hook! 'wb-page-saved-functions (lambda (b) (set! saved (cons (buffer-name b) saved)))) 'ok"), 'ok');
  fs.writeFileSync(path.join(dir.dirs.notes, 'page.md'), 'hello\n');
  const o = await c.open('page.md'); assert.equal(o.text, 'hello\n');
  const ack = await c.edit('page.md', 0, [[5, '', ' world']]); assert.equal(ack.t, 'ack');
  const sv = await c.request({ t: 'save', buf: 'page.md' }); assert.equal(sv.t, 'result', JSON.stringify(sv));
  await until(async () => (await value(c, 'saved')) !== '()', 'wb-page-saved-functions');
  assert.equal(await value(c, 'saved'), '("page.md")');
  c.close();
});

test('§5 card events come from diffing saves of the board file, with no leader', async () => {
  const c = await client(); await hubUp(c);
  assert.equal(await value(c, "(define cards '()) (define (note kind) (lambda (id node) (set! cards (cons (list kind id (cdr (assq 'kind node))) cards)))) (add-hook! 'wb-card-created-functions (note 'created)) (add-hook! 'wb-card-deleted-functions (note 'deleted)) (add-hook! 'wb-card-moved-functions (note 'moved)) 'ok"), 'ok');
  const file = path.join(boardsDir, 'test.json'), tmp = file + '.tmp';
  const write = (nodes: Record<string, unknown>) => { fs.writeFileSync(tmp, JSON.stringify({ nodes, edges: [] })); fs.renameSync(tmp, file); };
  write({ n_shell1: { id: 'n_shell1', kind: 'term', x: 10, y: 0 }, n_page: { id: 'n_page', kind: 'buffer', x: 1, y: 1 } });
  await until(async () => (await value(c, '(length cards)')) === '2', 'created and moved', 5000);
  assert.equal(await value(c, "(list (assq 'created cards) (assq 'moved cards))"), '((created "n_page" "buffer") (moved "n_shell1" "term"))');
  write({ n_page: { id: 'n_page', kind: 'buffer', x: 1, y: 1 } });
  await until(async () => (await value(c, '(length cards)')) === '3', 'deleted', 5000);
  assert.equal(await value(c, "(assq 'deleted cards)"), '(deleted "n_shell1" "term")');
  c.close();
});
