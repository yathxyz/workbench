import { check, loadSection, section, sectionFiles, skip, state, until } from '../shared.mts';
import { H, sessions, settled } from '../daemon.mts';
import { openFixture, type N78Fixture, type N78Resources } from './7400-n78/fixtures.mts';

// N78 (F-A48): real, externally started ACP/PTY sessions and observed attachments, never implicit board cards.
await section('N78', async () => {
  if (!state.STUB) return skip('N78', 'no `stub` agent (wb-fake-acp) in /api/info.agents');
  const helpers = await openFixture();
  const {
    D, owner, sid, cwd, meshApi, startPty, report, reportClaude, row, info, nodes, attachSid, attachOpens,
    composer, reader, log, readerText, liveView, liveIdle,
  } = helpers;
  const journalText = async () => await readerText() ?? await D.locator(log).textContent();
  const resources: N78Resources = {};
  try {
    const before = await nodes();
    const created = await meshApi('/sessions', 'POST', { sid, agent: 'stub', cwd });
    if (created.status !== 201) throw new Error('N78 API ACP spawn: ' + created.status + ' ' + await created.text());
    const ready = await until(async () => { const s = (await sessions()).find(s => s.sid === sid); return s?.acp?.agentSessionId && s.acp.activity === 'none'; }, 15000);
    if (!ready) throw new Error('N78 external ACP did not finish setup');
    const original = await meshApi('/sessions/' + sid + '/prompt', 'POST', {
      text: ['n78 original conversation', ...Array.from({ length: 70 }, (_, i) => 'replay line ' + i)].join('\n'),
    });
    if (!original.ok) throw new Error('N78 external prompt: ' + original.status + ' ' + await original.text());
    const externalPty = resources.externalPty = 'n78_external_pty';
    await startPty(externalPty);
    const sent = [await report('near', 'n78-readonly'), await report('near', 'n78-claude', { attach: { kind: 'claude', id: 'deadbeef' } }),
      await report('far', 'n78-tmux', { attach: { kind: 'tmux', socket: '/tmp/n78-tmux/default', pane: 12 } }),
      await report('near', 'n78-hubpty', { wbSession: externalPty, attach: { kind: 'claude', id: '0123abcd' } }),
      await reportClaude('n78-claude-tmux', { attach: { kind: 'tmux', socket: '/tmp/n78-tmux/default', pane: 7 } }, 'PermissionRequest'),
      await report('near', 'n78-fail', { attach: { kind: 'claude', id: 'badc0ffe' } })];
    const ids = await until(() => D.evaluate((sid: string) => {
      const ids: Record<string, string> = {};
      for (const o of Object.values<ObservedSession>(window.__canvas.OBS)) if (o.sessionId.startsWith('n78-')) ids[o.sessionId] = o.id;
      return Object.keys(ids).length === 6 && window.__canvas.SESS[sid] ? ids : null;
    }, sid), 10000);
    if (!ids) throw new Error('N78 observed sessions did not arrive');
    const edwin = await D.evaluate(() => window.__canvas.FR.on);
    if (edwin) await D.waitForFunction(() => window.__canvas.FR.ready && window.__canvas.FR.online, undefined, { timeout: 30000 });
    await D.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await D.keyboard.press('Alt+Digit8');
    await D.waitForSelector('#v-agents:not([hidden])');
    await row(ids['n78-claude-tmux']).waitFor();
    const highlights = await D.locator('#mesh-list .mesh-row').evaluateAll(es => es.map(e => (e as HTMLElement).dataset.id));
    const first = await D.locator('#mesh-list .mesh-row.on').getAttribute('data-id');
    const selectedIds = [first], hasTerminal = () => D.locator('#mesh-detail .xterm').isVisible();
    let terminalOnHighlight = !!await attachSid();
    await D.locator('#mesh-list').focus();
    for (let i = 1; i <= highlights.indexOf(ids['n78-claude']); i++) {
      await D.keyboard.press(i % 2 ? 'ArrowDown' : 'j');
      selectedIds.push(await D.locator('#mesh-list .mesh-row.on').getAttribute('data-id'));
      terminalOnHighlight ||= !!await attachSid();
    }
    const highlightedSummary = await D.locator('#mesh-detail .mesh-hint').innerText();
    check('N78: automatic and keyboard highlights across eligible Claude rows show a summary, without opening any viewer',
      first === ids['n78-claude-tmux'] && selectedIds.at(-1) === ids['n78-claude'] && !terminalOnHighlight && !attachOpens().length
      && /press Enter/.test(highlightedSummary), JSON.stringify({ selectedIds, terminalOnHighlight, highlightedSummary }));
    await reportClaude('n78-claude-tmux');
    await until(() => D.evaluate((id: string) => window.__canvas.OBS[id]?.state === 'running', ids['n78-claude-tmux']), 10000);
    await row(sid).click(); await liveIdle();
    const noSwitch = !await D.locator('#mesh-detail .mesh-switch').count();
    await D.keyboard.press('t');
    const selectedAfterT = await D.locator('#mesh-list .mesh-row.on').getAttribute('data-id');
    check('N78: t on a hub ACP row without an observed attach leaves the selection and transcript unchanged',
      noSwitch && selectedAfterT === sid && await D.locator(composer).isVisible() && !await hasTerminal() && !attachOpens().length,
      JSON.stringify({ noSwitch, selectedAfterT, opens: attachOpens().length }));
    const initial = await journalText();
    if (edwin) {
      const local = await D.evaluate((sid: string) => {
        const b = window.__canvas.live.$agents.backend.transcript?.buf;
        return b && !b.shared && b.file === null && b.mode === 'wb-agent-transcript-mode' && b.name.includes(sid);
      }, sid);
      check('N78: the local transcript frame replaces the DOM journal and displays replay',
        local && await D.locator(reader + '.edwin-frame').count() === 1 && !await D.locator(log).count()
        && initial?.includes('Assistant:\n  echo: n78 original conversation'), { local, initial: initial?.slice(0, 200) });
    }
    const rowEl = await row(sid).elementHandle(), controlEl = await D.locator(composer).elementHandle();
    await D.fill(composer, 'n78 shared conversation'); await D.press(composer, 'Enter');
    const shared = await until(async () => {
      const v = await liveView(), text = await journalText();
      return v?.promptable && v.items.includes('asst:echo: n78 shared conversation') && text?.includes('echo: n78 shared conversation') ? { items: v.items, text } : null;
    }, 20000);
    const stable = { row: await rowEl!.evaluate((e, sid: string) => e === document.querySelector(`#mesh-list .mesh-row[data-id="${sid}"]`), sid),
      control: await controlEl!.evaluate(e => e === document.querySelector('#mesh-detail .mesh-live .ag-in textarea')) };
    const listed = await D.evaluate(({ sid, ids }) => ({ view: window.__canvas.S.view, ids: [...document.querySelectorAll<HTMLElement>('#mesh-list .mesh-row')].map(e => e.dataset.id),
      expected: [sid, ...Object.values(ids)], card: !!window.__canvas.S.nodes[sid] }), { sid, ids });
    check('N78: Alt-8 opens Agents; an API-started ACP session replays and accepts real prompts without a card, preserving row and composer identity during activity',
      sent.every(s => s === 204) && listed.view === 'agents' && listed.expected.every(id => listed.ids.includes(id)) && !listed.card && noSwitch && initial?.includes('echo: n78 original conversation') && !!shared && stable.row && stable.control && await nodes() === before,
      JSON.stringify({ sent, listed, initial, shared, stable, nodes: await nodes(), before }));
    const prefixOrphan = await D.evaluate((sid: string) => window.__canvas.attnItems().some((i: RgEntry) => i.key === 'orphan:' + sid), sid);
    check('N78: an ordinary hub ACP session whose id starts attach_ remains in Agents and Attention as an orphan',
      sid.startsWith('attach_') && listed.ids.includes(sid) && prefixOrphan, JSON.stringify({ sid, prefixOrphan, ids: listed.ids }));
    const hubInfo = await until(async () => { const i = await info(); return i.model && i.reasoning && i.mode ? i : null; }, 10000);
    const known = await D.evaluate(() => {
      const b = window.__canvas.live.$agents.backend, opts = b.session.configOptions;
      return { mode: b.mode(), model: opts?.find((o: { category?: string; currentValue?: string }) => o.category === 'model')?.currentValue, reasoning: opts?.find((o: { category?: string; currentValue?: string }) => o.category === 'thinking')?.currentValue };
    });
    const harnessLabel = await D.evaluate(() => window.__canvas.INFO.agents.find((a: { name: string; label: string }) => a.name === 'stub')?.label);
    const hubRow = await row(sid).evaluate(e => ({ harness: e.querySelector('.mesh-harness')?.getAttribute('title'), model: e.querySelector('.mesh-model')?.getAttribute('title') }));
    check('N78: ACP journal config metadata supplies the full model title, mode and reasoning; host, folder, start and activity times are shown',
      !!harnessLabel && !!hubInfo && hubInfo.harness === harnessLabel && hubInfo.host === H.host && hubInfo.folder === cwd && hubInfo.mode === known.mode && hubInfo.model === known.model && hubInfo.reasoning === known.reasoning
      && known.model === 'stub-model' && known.reasoning === 'high' && !!hubInfo.started && !!hubInfo['last active'] && hubRow.harness === harnessLabel && hubRow.model === known.model, JSON.stringify({ hubInfo, known, hubRow, harnessLabel }));

    const fixture: N78Fixture = { ...helpers, before, ids, edwin, externalPty, hasTerminal };
    // Import failures skip one file. An unwrapped throw while running a step still stops N78.
    for (const file of sectionFiles(new URL('./7400-n78/', import.meta.url))) {
      const step = await loadSection(file);
      if (step) await step.default(fixture, resources);
    }
  } finally {
    const { externalPty, unloadPage, owned, ownedPty } = resources;
    await unloadPage?.close();
    await D.evaluate((ids: (string | undefined)[]) => { const C = window.__canvas; C.setView('canvas'); for (const id of ids) if (id && C.S.nodes[id]) C.removeNode(id); }, [sid, externalPty, owned, ownedPty]);
    if (externalPty) await meshApi('/sessions/' + externalPty + '?forget=true', 'DELETE');
    await meshApi('/sessions/' + sid + '?forget=true', 'DELETE');
    await meshApi('/sessions/n78_layout_api?forget=true', 'DELETE');
    for (const id of [owned, ownedPty]) if (id) await meshApi('/sessions/' + id + '?forget=true', 'DELETE');
    for (const id of ['n78-readonly', 'n78-claude', 'n78-hubpty', 'n78-layout', 'n78-fail']) await report('near', id, {}, 'end');
    await reportClaude('n78-claude-tmux', {}, 'SessionEnd');
    await report('far', 'n78-tmux', {}, 'end');
    await settled(D); await owner.close(); await D.close();
  }
});
