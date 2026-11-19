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
  const visibleLines = () => reader.evaluate(async root => {
    await new Promise<void>(r => requestAnimationFrame(() => r()));
    return [...root.querySelectorAll('.ln')].map(e => e.textContent || '');
  });
  let created = false;
  try {
    if (!await P.evaluate(() => window.__canvas.FR.on)) return skip('N81', 'Edwin disabled in private harness');
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
    const native = await P.evaluate(() => typeof Reflect.get(window.Ed, 'setBufferFolds') === 'function');
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
      (await visibleLines()).some(s => s.includes('[x](https://example.test/x) <button>not a control</button>'))
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
    if (native) {
      await command('n'); await key('z'); await key('z');
      const before = await visibleLines();
      await command('Tab'); const turn = await visibleLines();
      await command(']'); await key('z'); await key('z'); const folded = await visibleLines();
      await command('Tab'); const opened = await visibleLines();
      check('N81: native thought/tool folds start closed, the turn toggles at point, and a tool jump reveals its parent',
        before.some(s => s.includes('Thinking:')) && !before.some(s => s.includes('private thought body'))
        && turn.some(s => s.includes(first)) && !turn.some(s => s.includes(aHead)) && (await view()).at.line === aHead
        && folded.some(s => s.includes(aHead)) && !folded.some(s => s.includes('tool-a output')) && opened.some(s => s.includes('tool-a output')));
      await command('a'); const closedAll = await visibleLines(); await command('a'); await top(); await command(']');
      await key('z'); await key('z');
      const openAll = await visibleLines();
      check('N81: fold all collapses turns; unfold all restores tool and thought bodies without changing text',
        closedAll.some(s => s.includes(first) || s.includes(second)) && !closedAll.some(s => s.includes(aHead) || s.includes(bHead))
        && openAll.some(s => s.includes('tool-a output')) && openAll.some(s => s.includes('private thought body')) && (await text()).includes('private thought body'));
      await command(']'); await command('Tab'); // A expanded and B collapsed, distinct choices to carry over the reset.
    } else console.log('N81: native fold behavior not exercised: this Edwin pin has no Ed.setBufferFolds.');

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
    await command('['); await command('['); await key('z'); await key('z');
    const patched = await text();
    check('N81: one tool heading is patched in place and its body survives the live update', patched.split(aDone).length === 2
      && !patched.includes(aHead) && patched.indexOf(aDone) < patched.indexOf(second) && patched.includes('tool-a output')
      && (!native || (await visibleLines()).some(s => s.includes('tool-a output'))));

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
      if (native) {
        await tap(btn('Toggle fold at point')); const folded = await visibleLines(); await tap(btn('Toggle fold at point')); const expanded = await visibleLines();
        await tap(btn('Toggle all folds')); const all = await visibleLines(); await tap(btn('Toggle all folds'));
        check('N81: phone touch folds at point and across the transcript', folded.some(s => s.includes(aDone)) && !folded.some(s => s.includes('tool-a output'))
          && expanded.some(s => s.includes('tool-a output')) && !all.some(s => s.includes(aDone)));
        await tap(btn('Next tool')); if ((await view()).at.line !== bHead) await tap(btn('Next tool'));
        await tap(btn('Toggle fold at point')); // restore B collapsed for the replay
      } else check('N81: a reader without native fold support offers no fold actions', !await nav.getByRole('button', { name: /fold/i }).count());
      await tap(btn('Follow tail')); chunk('agent_message_chunk', 'tail', ' four'); await readUntil('tail one two three four');
      const phone = await view();
      check('N81: touch follow and live output preserve the focused composer and its draft', phone.pos >= phone.end - 1 && await composer.inputValue() === 'outside: n]'
        && await composer.evaluate(e => e === document.activeElement));
      await shot(P, 'n81-transcript-navigation');
    } finally { await cdp.detach(); }

    await P.setViewportSize({ width: 1280, height: 800 });
    // The real hub has a lower head than the synthetic cursor, hence re-open returns a genuine reset of the same epoch.
    g.hold = true; g.kick(); socket = await replaySocket();
    const frames = socket.buf.splice(0).map(m => JSON.parse(String(m)) as AcpServerMsg);
    const hello = frames.find(m => m.t === 'hello'); if (!hello?.reset || hello.info.createdAt !== idle.epoch) throw new Error('N81 expected same-incarnation reset replay');
    for (const f of frames) if (f.t !== 'replayed') socket.ws.send(JSON.stringify(f));
    seq = hello.head;
    prompt('N81 reset'); tool('tool-b', 'reset B'); tool('tool-a', 'reset A');
    socket.ws.send(JSON.stringify({ t: 'replayed', truncated: false, head: seq })); g.release();
    await readUntil('reset A'); await reader.locator('.ed-input').focus(); await top();
    const resetTurn = await jump('n'), resetB = await jump(']'); await key('z'); await key('z'); const bLines = await visibleLines();
    const resetA = await jump(']'); await key('z'); await key('z'); const aLines = await visibleLines();
    check('N81: reset replay rebuilds the text and jump destinations, discarding stale items', !(await text()).includes('N81 first')
      && resetTurn === 'Prompt: N81 reset' && resetB === 'Tool: edit [pending] reset B' && resetA === 'Tool: edit [pending] reset A');
    if (native) check('N81: reset replay restores fold choices by tool call id, not heading text, offset or ordinal',
      bLines.some(s => s.includes('reset B')) && !bLines.some(s => s.includes('tool-b output')) && aLines.some(s => s.includes('tool-a output')));

    // The benchmark reopens the session itself for a fresh reader. Check work bounds, not machine-dependent timings.
    g.drop = () => false;
    if (!await acpIdle(P, '$agents')) throw new Error('N81 benchmark viewer did not finish replay');
    const perf = await measureTranscript(P);
    console.log('N81 transcript performance:', perf);
    check('N81: a journal of at least 5,000 events with long outputs paints in bounded batches and each streamed chunk paints separately',
      perf.events >= 5000 && perf.longTools > 0 && perf.longOutputBytes >= 16 * 1024 && perf.projectionFrames > 1
      && perf.maxAddedChars <= 64 * 1024 + 1 && perf.chunks > 1 && perf.chunkToPaintMeanMs > 0, perf);
  } finally {
    await P.close();
    if (created) { const r = await api('/' + sid + '?forget=true', 'DELETE'); if (!r.ok) throw new Error('N81 cleanup: ' + r.status); }
  }
});
