import fs from 'node:fs';
import type { Locator } from 'playwright-core';
import { TMP, check, section, shot, skip, state, until } from '../shared.mts';
import { H } from '../daemon.mts';
import { acpIdle, gatedPage } from '../acp.mts';
import { measureTranscript } from '../transcript-stress.mts';

// Keep the real viewer, socket, reducer and reset handshake; only this page receives the fixture journal.
type Body<E = JournalEvent> = E extends JournalEvent ? Omit<E, 'seq' | 'ts'> : never;
await section('N81', async () => {
  if (!state.STUB) return skip('N81', 'no private stub ACP agent');
  const { P, g } = await gatedPage(), sid = 'n81_navigation';
  const api = (path: string, method: string, body?: object) => fetch(H.api + '/v1/sessions' + path, {
    method, headers: { Authorization: 'Bearer ' + fs.readFileSync(H.apiTokenFiles.near, 'utf8').trim(), 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const open = () => P.evaluate(sid => window.__canvas.meshOpen(sid), sid);
  const replaySocket = async () => {
    const s = await until(() => g.socks.find(s => s.buf.some(m => { const f = JSON.parse(String(m)); return f.t === 'hello' && f.info.sid === sid; })
      && s.buf.some(m => JSON.parse(String(m)).t === 'replayed')), 15000);
    if (!s) throw new Error('N81 missing ACP replay');
    return s;
  };
  const reader = P.locator('#mesh-detail .ag-reader'), composer = P.locator('#mesh-detail .ag-in textarea');
  const key = (k: string) => P.keyboard.press(k);
  const command = async (k: string) => { await key('Control+c'); await key(k); };
  const z = async (k: string) => { await key('z'); await key(k); };
  const top = async () => { await key('g'); await key('g'); };
  const readUntil = (text: string) => P.waitForFunction(text => window.__canvas.live.$agents?.backend.transcript?.buf.text.includes(text), text);
  const text = () => P.evaluate(() => window.__canvas.live.$agents.backend.transcript.buf.text as string);
  const view = () => P.evaluate(async () => {
    await new Promise<void>(r => requestAnimationFrame(() => r()));
    const { buf, frame } = window.__canvas.live.$agents.backend.transcript as { buf: EdwinBuffer; frame: EdwinFrame };
    const t = buf.text, pos = frame.point();
    const at = (n: number) => {
      const start = n ? t.lastIndexOf('\n', n - 1) + 1 : 0, end = t.indexOf('\n', n);
      return { line: t.slice(start, end < 0 ? t.length : end), col: n - start };
    };
    return { pos, end: t.length, at: at(pos), mark: buf.mark == null ? null : at(buf.mark), first: frame.root.querySelector('.ln')?.textContent,
      inFrame: frame.root.contains(document.activeElement), selected: window.__canvas.MESH.open, undo: buf.undo.length };
  });
  // Edwin virtualizes the transcript. A row outside the clipped text viewport is not evidence about a fold.
  const display = () => reader.evaluate(async root => {
    await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const area = root.querySelector('.text')!.getBoundingClientRect();
    const visible = (e: Element) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > Math.max(0, area.top) && r.top < Math.min(innerHeight, area.bottom)
        && r.right > Math.max(0, area.left) && r.left < Math.min(innerWidth, area.right);
    };
    const rows = [...root.querySelectorAll('.ln')].filter(visible), line = (e: Element) => (e.textContent || '').trimEnd();
    const buf = window.__canvas.live.$agents.backend.transcript.buf as EdwinBuffer, t = buf.text;
    if (!window.Ed.getBufferFolds) throw new Error('N81 requires native fold readback from the pinned Edwin');
    const closed = window.Ed.getBufferFolds(buf).map(({ s }) => t.slice(t.lastIndexOf('\n', s - 1) + 1, s));
    return { rows: rows.map(line), marked: rows.filter(e => { const mark = e.querySelector('.oe'); return mark && visible(mark); }).map(line), closed };
  });
  type Display = Awaited<ReturnType<typeof display>>;
  const has = (rows: string[], part: string) => rows.some(s => s.includes(part));
  const shut = (d: Display, head: string, body: string) => has(d.marked, head) && !has(d.rows, body) && d.closed.includes(head);
  const expanded = (d: Display, head: string, body: string) => has(d.rows, head) && has(d.rows, body) && !has(d.marked, head) && !d.closed.includes(head);
  let created = false;
  try {
    if (!await P.evaluate(() => window.__canvas.FR.on)) throw new Error('N81 requires Edwin in the private harness');
    await P.waitForFunction(() => window.__canvas.FR.ready && window.__canvas.FR.online, undefined, { timeout: 30000 });
    const response = await api('', 'POST', { sid, agent: 'stub', cwd: TMP });
    if (!response.ok) throw new Error(`N81 spawn: ${response.status} ${await response.text()}`);
    created = true;
    await P.waitForFunction(sid => { const a = window.__canvas.SESS[sid]?.acp; return a?.agentSessionId && a.activity === 'none'; }, sid);
    await P.bringToFront();
    g.hold = true; await open();
    let socket = await replaySocket(); g.release();
    const idle = await acpIdle(P, '$agents'); if (!idle) throw new Error('N81 viewer did not finish replay');
    await reader.locator('.ed-input').waitFor();
    let seq = idle.seq;
    const event = (body: Body) => { socket.ws.send(JSON.stringify({ t: 'ev', ev: { ...body, ts: Date.now(), seq: ++seq } })); return seq; };
    const update = (update: JsonObject) => event({ e: 'update', update });
    const prompt = (s: string) => event({ e: 'prompt', prompt: [{ type: 'text', text: s }] });
    const chunk = (kind: string, id: string, text: string) => update({ sessionUpdate: kind, messageId: id, content: { type: 'text', text } });
    const tool = (id: string, title: string) => update({ sessionUpdate: 'tool_call', toolCallId: id, kind: 'edit', title, status: 'pending',
      locations: [{ path: 'dir/[literal].md', line: 7 }], rawInput: { command: '**not bold**' }, content: [
        { type: 'diff', path: 'dir/[literal].md', oldText: 'old', newText: 'new' },
        { type: 'content', content: { type: 'text', text: id + ' output' } },
      ] });
    const a = 'N81 A', b = 'N81 B', first = 'Prompt: N81 first', second = 'Prompt: N81 second';
    const aHead = 'Tool: edit [pending] ' + a, aDone = 'Tool: edit [completed] ' + a + ' (updated)', bHead = 'Tool: edit [pending] ' + b;
    const thought = 'Thinking:', privateThought = 'private thought body', outA = 'tool-a output', outB = 'tool-b output';
    prompt('N81 first');
    chunk('user_message_chunk', 'quoted', 'Prompt: forged\nTool: fake\n* TODO [[file:/etc/passwd]]\n[x](https://example.test/x) <button>not a control</button>');
    chunk('agent_thought_chunk', 'think', 'private thought body');
    tool('tool-a', a);
    chunk('agent_message_chunk', 'middle', Array.from({ length: 95 }, (_, i) => 'N81 reader line ' + i).join('\n'));
    event({ e: 'turn_end', stopReason: 'end_turn' }); prompt('N81 second'); tool('tool-b', b);
    chunk('agent_message_chunk', 'tail', 'tail one');
    update({ sessionUpdate: 'plan', entries: [{ content: 'one', status: 'completed', priority: 'high' }, { content: 'work on two', status: 'in_progress', priority: 'medium' }] });
    event({ e: 'mode', modeId: 'n81-mode' });
    event({ e: 'config', configOptions: [{ type: 'select', category: 'model', id: 'model', name: 'Model', currentValue: 'n81-small' }] });
    await readUntil('n81-small'); await readUntil('tail one');
    const initial = await text();
    check('N81: labelled messages and untrusted headings, Org, Markdown, a path, URL and markup stay literal',
      initial.includes('User:\n  Prompt: forged\n  Tool: fake\n  * TODO [[file:/etc/passwd]]\n  [x](https://example.test/x) <button>not a control</button>\n')
      && initial.includes('Thinking:\n  private thought body\n') && initial.includes('Assistant:\n  tail one\n')
      && initial.split('\n').filter(l => l.startsWith('Prompt:')).length === 2 && initial.split('\n').filter(l => l.startsWith('Tool:')).length === 2);
    check('N81: the tool projects location, raw input, diff and output under its heading',
      initial.includes(aHead + '\n  Location: dir/[literal].md:7\n') && initial.includes('  Input:\n  {"command":"**not bold**"}\n')
      && initial.includes('  Diff: dir/[literal].md\n  - old\n  + new\n') && initial.includes('  Output:\n  tool-a output\n'));
    check('N81: current plan progress, active step, mode and selected config are compact status lines',
      /^Plan: 1\/2 completed · work on two$/m.test(initial) && /^Settings: .*Mode=n81-mode.*Model=n81-small/m.test(initial));
    update({ sessionUpdate: 'config_option_update', configOptions: [{ type: 'select', category: 'model', id: 'model', name: 'Model', currentValue: 'n81-large' }] });
    update({ sessionUpdate: 'plan', entries: [{ content: 'done', status: 'completed', priority: 'high' }] });
    await readUntil('Plan: 1/1 completed');
    const status = await text();
    check('N81: new plan and config replace their old values, not a second status', !status.includes('work on two') && !status.includes('n81-small') && status.includes('Model=n81-large')
      && status.split('\n').filter(l => l.startsWith('Plan:')).length === 1 && status.split('\n').filter(l => l.startsWith('Settings:')).length === 1);

    // Two identical requests with different sequence numbers, resolved in reverse order through the real panels.
    g.drop = m => m?.t === 'permission' || m?.t === 'elicitation';
    const req = () => event({ e: 'permission', toolCall: { title: 'same title' }, options: [{ optionId: 'no', name: 'Reject', kind: 'reject_once' }] });
    const r1 = req(), q = event({ e: 'elicitation', request: { mode: 'form', message: 'an answer?', requestedSchema: { type: 'object', properties: { word: { type: 'string' } } } } }), r2 = req();
    const p1 = `Permission #${r1}: `, p2 = `Permission #${r2}: `, elicit = `Elicitation #${q}: `;
    await readUntil(p2 + 'waiting');
    const pending = await text();
    check('N81: each request starts a distinct waiting heading in journal order', pending.includes(p1 + 'waiting — same title') && pending.includes(elicit + 'waiting — an answer?')
      && pending.indexOf(p1) < pending.indexOf(elicit) && pending.indexOf(elicit) < pending.indexOf(p2));
    await P.locator('#mesh-detail .ag-perm').last().getByRole('button', { name: 'Reject' }).click();
    await P.locator('#mesh-detail .ag-form input').fill('not for the transcript');
    await P.locator('#mesh-detail .ag-form').getByRole('button', { name: 'Accept' }).click();
    const replies = await until(() => g.sent.some(m => m?.t === 'permission' && m.req === r2 && m.outcome.optionId === 'no')
      && g.sent.some(m => m?.t === 'elicitation' && m.req === q && m.response.content?.word === 'not for the transcript'));
    event({ e: 'permission_resolved', req: r2, by: 'user', outcome: { outcome: 'selected', optionId: 'no' } });
    event({ e: 'elicitation_resolved', req: q, by: 'user', response: { action: 'accept', content: { word: 'not for the transcript' } } });
    await readUntil(elicit + 'question answered');
    const resolved = await text();
    check('N81: DOM replies keep their request ids; outcomes replace those exact headings and never echo form answers', replies
      && resolved.includes(p1 + 'waiting') && resolved.includes(p2 + 'rejected: Reject') && resolved.split(p2).length === 2
      && resolved.indexOf(p1) < resolved.indexOf(elicit) && resolved.indexOf(elicit) < resolved.indexOf(p2) && resolved.split(elicit).length === 2
      && !resolved.includes('not for the transcript') && await P.locator('#mesh-detail .ag-perm').count() === 1 && !await P.locator('#mesh-detail .ag-form').count());
    event({ e: 'permission_resolved', req: r1, by: 'user', outcome: { outcome: 'cancelled' } });
    await readUntil(p1 + 'permission cancelled');
    const auto = await view();
    check('N81: a new reader follows the tail without a command', auto.pos >= auto.end - 1);

    await reader.locator('.ed-input').focus(); await top();
    const jump = async (k: string) => { await command(k); return (await view()).at.line; };
    const jumps = [await jump('n'), await jump('n'), await jump('p'), await jump(']'), await jump(']'), await jump('[')];
    check('N81: next/previous turn and tool jump to actual headings, not literal lookalikes',
      JSON.stringify(jumps) === JSON.stringify([first, second, first, aHead, bHead, aHead]), jumps);
    await command('p'); await key('z'); await key('z');
    const literal = reader.locator('.ln').filter({ hasText: '<button>not a control</button>' });
    check('N81: Edwin displays the literal URL and markup as text, not link or button widgets',
      has((await display()).rows, '[x](https://example.test/x) <button>not a control</button>')
      && !await literal.locator('a, button, [role="link"]').count());
    await key('j'); const down = await view(); await key('k'); const up = await view();
    await key('Enter'); await key('Escape'); const inside = await view();
    await key('Control+Space'); await key('Escape');
    check('N81: editor movement, Enter and Escape stay inside; leader Escape returns to Sessions', down.at.line !== first && up.at.line === first && inside.inFrame && inside.selected === sid
      && await P.locator('#mesh-list').evaluate(e => e === document.activeElement));
    await P.locator('#mesh-list').press('Enter'); // reopen the detail before changing to the single-pane layout
    await composer.fill('outside: '); await command('n'); await command(']');
    check('N81: the composer receives the suffixes of transcript-local key sequences as text', await composer.inputValue() === 'outside: n]' && (await view()).pos === inside.pos);

    await reader.locator('.ed-input').focus(); await top();
    await command('n'); await z('t');
    const before = await display();
    await command('Tab'); const turn = await display();
    const jumped = await jump(']'); await z('t'); const folded = await display();
    await command('Tab'); const opened = await display();
    check('N81: native thought/tool folds start closed; C-c TAB folds the turn, the tool jump reveals its parent, and C-c TAB opens the tool',
      shut(before, thought, privateThought) && before.closed.includes(aHead) && before.closed.includes(bHead)
      && shut(turn, first, aHead) && jumped === aHead && shut(folded, aHead, outA) && expanded(opened, aHead, outA),
      { before, turn, jumped, folded, opened });
    await command('Tab'); // Closed starting point for the native toggle.
    // No Workbench command between the native key and the edit that discards Edwin's owner ranges.
    const keyThenAppend = async (k: string, marker: string) => {
      if (k === 'Tab') await key(k); else await z(k);
      chunk('agent_message_chunk', 'fold-probe', '\n' + marker);
      await readUntil(marker); return display();
    };
    const za = await keyThenAppend('a', 'after za');
    const zc = await keyThenAppend('c', 'after zc');
    const zo = await keyThenAppend('o', 'after zo');
    const closedAgain = await keyThenAppend('c', 'before recursive open');
    const zO = await keyThenAppend('O', 'after recursive open');
    const tabClosed = await keyThenAppend('Tab', 'after first TAB'), tabOpen = await keyThenAppend('Tab', 'after second TAB');
    check('N81: an append preserves native za/zc/zo/zO/TAB choices, and an open item remains a keyboard fold target after an edit',
      expanded(za, aHead, outA) && shut(zc, aHead, outA) && expanded(zo, aHead, outA) && shut(closedAgain, aHead, outA)
      && expanded(zO, aHead, outA) && shut(tabClosed, aHead, outA) && expanded(tabOpen, aHead, outA),
      { za, zc, zo, closedAgain, zO, tabClosed, tabOpen });

    await command('p'); const parentClosed = await keyThenAppend('c', 'inside a closed turn');
    const childJump = await jump(']'); await z('t'); const children = await display();
    await command('p'); await z('t'); const sibling = await display();
    check('N81: jumping into a closed turn reopens it, keeping its tool open and its thought closed',
      shut(parentClosed, first, aHead) && childJump === aHead && expanded(children, aHead, outA) && shut(sibling, thought, privateThought),
      { parentClosed, childJump, children, sibling });

    const nativeAll = await keyThenAppend('M', 'after native close all');
    await top(); await command('n'); await z('t');
    const nativeNone = await keyThenAppend('R', 'after native open all');
    await command(']'); await z('t'); const nativeBodies = await display();
    check('N81: native zM closes both turns; zR opens the children too, with both choices surviving a subsequent append',
      shut(nativeAll, first, aHead) && shut(nativeAll, second, bHead) && nativeAll.closed.length === 2
      && !nativeNone.closed.length && expanded(nativeBodies, aHead, outA) && expanded(nativeNone, thought, privateThought),
      { nativeAll, nativeNone, nativeBodies });
    await command('a'); const closedAll = await display(); await command('a'); await top(); await command('n'); await z('t');
    const thoughts = await display(); await command(']'); await z('t'); const openAll = await display();
    check('N81: Workbench fold all collapses turns; unfold all restores tool and thought bodies without changing text',
      shut(closedAll, first, aHead) && shut(closedAll, second, bHead) && expanded(openAll, aHead, outA) && expanded(thoughts, thought, privateThought)
      && (await text()).includes(privateThought), { closedAll, openAll, thoughts });
    await command(']'); await command('Tab'); // A expanded and B collapsed, distinct choices to carry over the reset.

    // Point and mark refer to existing characters, not absolute offsets: the earlier tool grows underneath this reader.
    await top(); await key('6'); await key('5'); await key('j'); await key('z'); await key('z'); await key('v'); await key('l');
    const middle = await view();
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-a', status: 'completed', title: a + ' (updated)' });
    chunk('agent_message_chunk', 'tail', ' two'); await readUntil('tail one two');
    const kept = await view();
    check('N81: a length-changing earlier tool update and a later streamed chunk preserve reader text position, selection, viewport and focus',
      middle.at.line.includes('N81 reader line') && !!middle.mark && !!middle.first && kept.pos > middle.pos && kept.inFrame && !kept.undo
      && JSON.stringify(kept.at) === JSON.stringify(middle.at) && JSON.stringify(kept.mark) === JSON.stringify(middle.mark) && kept.first === middle.first, { middle, kept });
    await key('Escape'); await command('f'); chunk('agent_message_chunk', 'tail', ' three'); await readUntil('tail one two three');
    const resumed = await view();
    check('N81: C-c f explicitly resumes following subsequent chunks', resumed.pos >= resumed.end - 1 && resumed.end > kept.end && resumed.inFrame);
    await command('['); await command('['); await z('t');
    const patched = await text();
    check('N81: one tool heading is patched in place and its body survives the live update', patched.split(aDone).length === 2
      && !patched.includes(aHead) && patched.indexOf(aDone) < patched.indexOf(second) && patched.includes('tool-a output')
      && expanded(await display(), aDone, outA));

    await P.setViewportSize({ width: 390, height: 844 });
    await P.evaluate(() => { if (document.body.classList.contains('side-open')) window.__canvas.toggleDockTerm(); });
    const nav = P.getByRole('group', { name: 'Transcript navigation' }), btn = (name: string) => nav.getByRole('button', { name, exact: true });
    const cdp = await P.context().newCDPSession(P);
    const tap = async (target: Locator) => {
      // Closing the sliding dock takes several frames; a visible button can still be behind the terminal.
      await target.click({ trial: true }); const r = await target.boundingBox();
      if (!r || r.x < 0 || r.y < 0 || r.x + r.width > 390 || r.y + r.height > 844) throw new Error('N81 touch action outside viewport: ' + await target.textContent());
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x + r.width / 2, y: r.y + r.height / 2 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    try {
      await composer.focus();
      const touchJump = async (label: string) => { await tap(btn(label)); return (await view()).at.line; };
      const touch = [await touchJump('Previous turn'), await touchJump('Next turn'), await touchJump('Next tool'), await touchJump('Previous tool')];
      check('N81: phone touch can go both directions by turn and tool', JSON.stringify(touch) === JSON.stringify([first, second, bHead, aDone]), touch);
      // The last output line of a long tool can lie below a phone screen. Put this short heading at the top;
      // its first body row and Edwin's fold indicator are the visible changes, even when its last row never fits.
      const phoneTarget = await touchJump('Next tool');
      await reader.locator('.ed-input').focus(); await z('t'); await composer.focus();
      const location = 'Location: dir/[literal].md:7', initially = await display();
      await tap(btn('Toggle fold at point')); const oneOpen = await display();
      await tap(btn('Toggle fold at point')); const oneShut = await display();
      check('N81: phone touch expands and collapses the visible tool at point',
        phoneTarget === bHead && shut(initially, bHead, location) && expanded(oneOpen, bHead, location) && shut(oneShut, bHead, location),
        { phoneTarget, initially, oneOpen, oneShut });
      await tap(btn('Toggle all folds')); const all = await display();
      await tap(btn('Toggle all folds')); const none = await display();
      check('N81: phone touch folds and unfolds both turns, not just the tool at point',
        shut(all, second, bHead) && all.closed.includes(first) && !has(all.rows, aDone)
        && has(none.rows, second) && !has(none.marked, second) && !none.closed.length, { all, none });
      const backToB = await touchJump('Next tool');
      await tap(btn('Toggle fold at point')); const forReplay = await display();
      check('N81: the unfolded phone turn reveals the tool, which can be closed independently',
        backToB === bHead && shut(forReplay, bHead, outB) && !forReplay.closed.includes(aDone), { backToB, forReplay });
      await tap(btn('Follow tail')); chunk('agent_message_chunk', 'tail', ' four'); await readUntil('tail one two three four');
      const phone = await view();
      check('N81: touch follow and live output preserve the focused composer and its draft', phone.pos >= phone.end - 1 && await composer.inputValue() === 'outside: n]'
        && await composer.evaluate(e => e === document.activeElement));
      await shot(P, 'n81-transcript-navigation');
    } finally { await cdp.detach(); }

    await P.setViewportSize({ width: 1280, height: 800 });
    const beginReplay = async () => {
      socket = await replaySocket();
      const frames = socket.buf.splice(0).map(m => JSON.parse(String(m)) as AcpServerMsg), hello = frames.find(m => m.t === 'hello');
      if (!hello || hello.info.createdAt !== idle.epoch) throw new Error('N81 expected replay in epoch ' + idle.epoch + ', got ' + hello?.info.createdAt);
      for (const f of frames) if (f.t !== 'replayed') socket.ws.send(JSON.stringify(f));
      seq = hello.head;
      return hello;
    };
    const endReplay = async (lastHeading: string) => {
      socket.ws.send(JSON.stringify({ t: 'replayed', truncated: false, head: seq })); g.release();
      await readUntil(lastHeading); await reader.locator('.ed-input').focus(); await top();
    };
    // The real hub has a lower head than this viewer's synthetic cursor, forcing a reset of the same epoch.
    const cursor = seq, sentBeforeKick = g.sent.length;
    g.hold = true; g.kick(); const resetHello = await beginReplay();
    const reconnect = g.sent.slice(sentBeforeKick).find(m => m?.t === 'open' && m.id === sid);
    check('N81: the dropped viewer reconnects from its cursor and epoch; the real hub resets it',
      reconnect?.t === 'open' && reconnect.since === cursor && reconnect.epoch === idle.epoch && resetHello.reset,
      { cursor, epoch: idle.epoch, reconnect, reset: resetHello.reset });
    prompt('N81 reset'); tool('tool-b', 'reset B'); tool('tool-a', 'reset A'); await endReplay('reset A');
    const resetTurn = await jump('n'), resetB = await jump(']'); await z('t'); const bView = await display();
    const resetA = await jump(']'); await z('t'); const aView = await display();
    check('N81: reset replay rebuilds the text and jump destinations, discarding stale items', !(await text()).includes('N81 first')
      && resetTurn === 'Prompt: N81 reset' && resetB === 'Tool: edit [pending] reset B' && resetA === 'Tool: edit [pending] reset A',
      { resetTurn, resetB, resetA });
    check('N81: reset replay restores fold choices by tool call id, not heading text, offset or ordinal',
      shut(bView, resetB, outB) && expanded(aView, resetA, outA), { bView, aView });

    // Reverse those choices, then hide both children. Leave without another edit or touch action to save them.
    await z('c'); await command('['); await z('o'); await command('p'); await z('c');
    const beforeLeave = await display(), old = await P.evaluateHandle(() => {
      const backend = window.__canvas.live.$agents.backend, { buf, frame } = backend.transcript;
      return { backend, buf, frame };
    });
    try {
      await P.evaluate(() => window.__canvas.setView('canvas'));
      const destroyed = await old.evaluate(o => o.backend.disposed && !o.frame.root.isConnected && !window.__canvas.live.$agents);
      const sentBeforeAttach = g.sent.length;
      g.hold = true; await open(); await beginReplay();
      const attach = g.sent.slice(sentBeforeAttach).find(m => m?.t === 'open' && m.id === sid);
      prompt('N81 reattached'); tool('tool-a', 'reattached A'); tool('tool-b', 'reattached B'); await endReplay('reattached B');
      const fresh = await old.evaluate(o => {
        const b = window.__canvas.live.$agents.backend;
        return b !== o.backend && b.transcript.buf !== o.buf && b.transcript.frame !== o.frame;
      });
      const parent = await jump('n'), hidden = await display(), childA = await jump(']'); await z('t'); const afterA = await display();
      const childB = await jump(']'); await z('t'); const afterB = await display();
      check('N81: leaving Agents destroys the reader; a fresh attach from zero restores the closed parent and its distinct child choices',
        destroyed && fresh && attach?.t === 'open' && attach.since === 0 && shut(beforeLeave, resetTurn, resetB)
        && parent === 'Prompt: N81 reattached' && shut(hidden, parent, 'reattached A') && !has(hidden.rows, 'reattached B')
        && childA === 'Tool: edit [pending] reattached A' && shut(afterA, childA, outA)
        && childB === 'Tool: edit [pending] reattached B' && expanded(afterB, childB, outB),
        { destroyed, fresh, attach, beforeLeave, hidden, childA, afterA, childB, afterB });
    } finally { await old.dispose(); }

    // The benchmark reopens the session itself for a fresh reader. Check work bounds, not machine-dependent timings.
    g.drop = () => false;
    if (!await acpIdle(P, '$agents')) throw new Error('N81 benchmark viewer did not finish replay');
    const perf = await measureTranscript(P);
    console.log('N81 transcript performance:', perf);
    check('N81: the 5,121-event replay paints in bounded batches and 96 separately painted appends keep 1,280 native folds closed',
      perf.events === 5121 && perf.longTools > 0 && perf.longOutputBytes >= 16 * 1024 && perf.projectionFrames > 1
      && perf.maxAddedChars <= 64 * 1024 + 1 && perf.chunks === 96 && perf.chunkToPaintMeanMs > 0
      && perf.closedBefore === 1280 && perf.closedAfter === 1280, perf);
    check('N81: the independent append measurement keeps exactly 500 native folds closed for all 96 chunks',
      perf.append250.turns === 250 && perf.append250.closedBefore === 500 && perf.append250.closedAfter === 500
      && perf.append250.chunks === 96 && perf.append250.chunkToPaintMeanMs > 0, perf.append250);
  } finally {
    await P.close();
    if (created) { const r = await api('/' + sid + '?forget=true', 'DELETE'); if (!r.ok) throw new Error('N81 cleanup: ' + r.status); }
  }
});
