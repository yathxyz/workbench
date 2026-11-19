import fs from 'node:fs';
import { check, section, until } from '../shared.mts';
import { H, dpage, newTerm, settled } from '../daemon.mts';

// N77 (F-A47): the mesh in the page (harness --api). Sessions that harnesses report from two hosts list in the Agents
// view by project with the one waiting first, count in the status line and in the Attention list, and stand in the
// graph under their host and project; one that runs in a shell card of this board is tied to that card.
await section('N77', async () => {
  const D = await dpage();
  try {
    await settled(D);
    const token = (who: 'near' | 'far') => fs.readFileSync(H.apiTokenFiles[who], 'utf8').trim();
    const report = async (who: 'near' | 'far', payload: Record<string, unknown>, more: Record<string, unknown> = {}) =>
      (await fetch(H.api + '/v1/events', { method: 'POST', headers: { Authorization: 'Bearer ' + token(who), 'Content-Type': 'application/json' }, body: JSON.stringify({ harness: 'pi', payload, ...more }) })).status;
    const shell = await newTerm(D, 'n77');
    const before = await D.evaluate(() => { const C = window.__canvas; return { mesh: C.INFO.mesh, agents: !!document.querySelector('#v-agents'), toggle: document.querySelector<HTMLElement>('#g-mesh')!.closest('label')!.hidden, obs: Object.keys(C.OBS).length, view: C.S.view }; });
    const sent = [
      await report('far', { session_id: 'a1', kind: 'prompt', cwd: '/srv/alpha', text: 'fix the parser' }),
      await report('far', { session_id: 'a1', kind: 'subagent_start', agent_id: 'sub1', agent_type: 'explorer', cwd: '/srv/alpha' }),
      await report('far', { session_id: 'a2', kind: 'prompt', cwd: '/srv/beta', text: 'write the docs' }),
      await report('far', { session_id: 'a2', kind: 'permission', cwd: '/srv/beta', text: 'run make', tool: { name: 'Bash', input: { command: 'make docs' } } }),
      await report('near', { session_id: 'b1', kind: 'prompt', cwd: '/srv/alpha', text: 'review the diff' }, { wbSession: shell }),
    ];
    await until(() => D.evaluate(() => Object.keys(window.__canvas.OBS).length === 4), 8000);
    const st = await D.evaluate(async (shell: string) => {
      const C = window.__canvas, out: Record<string, any> = {}, $$ = (s: string) => [...document.querySelectorAll<HTMLElement>(s)]; // any: each step's findings, read by the checks below
      const ids: Record<string, string> = {}; for (const o of Object.values<ObservedSession>(C.OBS)) ids[o.sessionId + (o.parent ? '/sub' : '')] = o.id;
      C.meshOpen(); await new Promise(r => setTimeout(r, 400));
      out.pane = { view: C.S.view, hidden: document.querySelector<HTMLElement>('#v-agents')!.hidden, sum: document.querySelector('#mesh-sum')!.textContent };
      out.groups = $$('#mesh-list .mesh-group').map(e => e.textContent).filter(t => t === 'beta' || t === 'alpha');
      out.rows = $$('#mesh-list .mesh-row').filter(e => !!C.OBS[e.dataset.id!]).map(e => ({ id: e.dataset.id, cls: e.className, title: e.querySelector('b')!.textContent, sub: e.querySelector('.mesh-sub')!.textContent, d: e.style.getPropertyValue('--d'), card: !!e.querySelector('.mesh-canvas:not([hidden])') }));
      out.ids = ids;
      document.querySelector<HTMLElement>(`#mesh-list .mesh-row[data-id="${ids.a2}"]`)!.click();
      out.detail = document.querySelector('#mesh-detail')?.textContent; out.sameRow = document.querySelector('#mesh-list .mesh-row.on')?.getAttribute('data-id');
      C.statusRender(); out.chip = $$('#st-host .stc').map(e => e.textContent).find(t => /^mesh /.test(t || '')); out.counts = C.statusCounts();
      out.attn = C.attnItems().filter((i: RgEntry) => i.key.startsWith('obs:')).map((i: RgEntry) => ({ key: i.key, name: i.name, meta: i.meta, n: i.n?.id }));
      C.setView('graph'); await new Promise(r => setTimeout(r, 300));
      const N = C.G.N, edge = (a: string, b: string, type: string) => C.G.E.some((e: { a: string; b: string; type: string }) => e.type === type && ((e.a === a && e.b === b) || (e.a === b && e.b === a)));
      out.graph = { hosts: [...N.keys()].filter(k => k.startsWith('host:')).sort(), projects: [...N.keys()].filter(k => k.startsWith('proj:')).sort(), a2: N.get('mesh:' + ids.a2)?.state, first: [...N.keys()][0],
        tied: edge(shell, 'mesh:' + ids.b1, 'mesh'), sub: edge('mesh:' + ids.a1, 'mesh:' + ids['a1/sub'], 'spawn'), far: edge('host:farbox', 'mesh:' + ids.a1, 'mesh'), shared: edge('proj:alpha', 'mesh:' + ids.a1, 'mesh') && edge('proj:alpha', 'mesh:' + ids.b1, 'mesh') };
      C.graphSelect('mesh:' + ids.a2); out.card = document.querySelector('#g-card')!.textContent; C.graphSelect('host:farbox'); out.hostCard = document.querySelector('#g-card')!.textContent; C.graphSelect(null);
      const box = document.querySelector<HTMLInputElement>('#g-mesh')!; box.click(); out.off = [...C.G.N.keys()].filter(k => /^(mesh|host|proj):/.test(k)).length; box.click();
      return out;
    }, shell);
    const { ids } = st, row = (id: string) => st.rows.find((r: { id: string }) => r.id === id);
    check('N77: /api/info says the mesh is there; the Agents view and the graph toggle exist; the events were taken', before.mesh === true && before.agents && !before.toggle && before.obs === 0 && sent.every(s => s === 204), JSON.stringify({ before, sent }));
    check('N77: the Agents view lists the mesh by project, the session that waits first, a subagent under its session',
      st.pane.view === 'agents' && !st.pane.hidden && /sessions on \d+ hosts? · 1 waiting for you$/.test(st.pane.sum) && String(st.groups) === 'beta,alpha' && st.rows.length === 4 && st.rows[0].id === ids.a2 && /\bbad\b/.test(st.rows[0].cls)
      && /needs permission: Bash make docs/.test(st.rows[0].sub) && /@farbox/.test(st.rows[0].sub) && row(ids['a1/sub'])?.d === '1' && /pi\/explorer/.test(row(ids['a1/sub'])?.sub) && st.rows.findIndex((r: { id: string }) => r.id === ids['a1/sub']) === st.rows.findIndex((r: { id: string }) => r.id === ids.a1) + 1, JSON.stringify(st));
    check('N77: a click opens the detail pane; a session in a shell card of this board has the way to its card', st.sameRow === ids.a2 && /write the docs/.test(st.detail || '') && /Started in a terminal the hub cannot reach/.test(st.detail || '') && row(ids.b1)?.card === true && row(ids.a1)?.card === false, JSON.stringify({ detail: st.detail, rows: st.rows }));
    check('N77: the status line counts the mesh and the Attention list names the session that waits', st.chip === 'mesh 4 · 1 waiting' && st.counts.mesh === 4 && st.counts.meshWaiting === 1 && st.attn.length === 1 && st.attn[0].key === 'obs:' + ids.a2 && st.attn[0].name === 'pi in beta needs permission' && /^@farbox/.test(st.attn[0].meta), JSON.stringify({ chip: st.chip, counts: st.counts, attn: st.attn }));
    check('N77: the graph has the hosts, the projects and the sessions: a subagent off its session, a project shared by two hosts, the shell card tied to its session',
      st.graph.hosts.length === 2 && st.graph.hosts.includes('host:farbox') && String(st.graph.projects) === 'proj:alpha,proj:beta' && st.graph.a2 === 'waiting_permission' && !/^(mesh|host|proj):/.test(st.graph.first) && st.graph.tied && st.graph.sub && st.graph.far && st.graph.shared, JSON.stringify(st.graph));
    check('N77: a session and a host open their card in the graph; the toggle takes the mesh out', /needs permission: Bash make docs/.test(st.card) && /pi in beta @farbox/.test(st.card) && /2 live sessions on this host/.test(st.hostCard) && st.off === 0, JSON.stringify({ card: st.card, hostCard: st.hostCard, off: st.off }));
    // the end of a session reaches the page: it leaves the list and the graph, and nothing waits any more
    await D.evaluate(() => window.__canvas.graphSelect('host:farbox'));
    await report('far', { session_id: 'a2', kind: 'end' });
    const gone = await until(() => D.evaluate((id: string) => { const C = window.__canvas; return !C.G.N.has('mesh:' + id) && C.statusCounts().meshWaiting === 0 && C.statusCounts().mesh === 3; }, ids.a2), 8000);
    // the host's card was open: it names the sessions that are left, and a button for the one that went opens nothing
    const stale = await D.evaluate((id: string) => { const C = window.__canvas, card = document.querySelector('#g-card')!.textContent; C.graphSelect('mesh:' + id); return { card, sel: C.G.sel, hidden: document.querySelector<HTMLElement>('#g-card')!.hidden }; }, ids.a2);
    check('N77: the open card of a host follows the sessions that end, and a node that went cannot be selected', /1 live session on this host/.test(stale.card || '') && !/write the docs/.test(stale.card || '') && stale.sel === null && stale.hidden, JSON.stringify(stale));
    await D.evaluate((id: string) => window.__canvas.meshOpen(id), ids.a1);
    const absent = !await D.locator(`#mesh-list .mesh-row[data-id="${ids.a2}"]`).count();
    const ended = await D.evaluate((id: string) => { document.querySelector<HTMLInputElement>('#mesh-ended')!.click(); return document.querySelector(`#mesh-list .mesh-row[data-id="${id}"]`)?.className; }, ids.a2);
    check('N77: an ended session leaves the graph and the counts, and lists again under Ended', gone === true && absent && /\bended\b/.test(ended || ''), JSON.stringify({ gone, absent, ended }));
    // the Attention list, open in the navigator, takes a session that starts to wait
    await D.evaluate(() => { const C = window.__canvas; C.setView('ranger'); C.rgGo('attn:'); });
    await settled(D);
    await report('far', { session_id: 'a1', kind: 'permission', cwd: '/srv/alpha', text: 'run the tests', tool: { name: 'Bash', input: { command: 'make test' } } });
    const listed = await D.waitForSelector(`#rg-cur .rg-row[data-key="obs:${ids.a1}"]`, { timeout: 8000 }).then(() => true, () => false);
    check('N77: an Attention list that is open takes a session that starts to wait', listed, JSON.stringify(await D.evaluate(() => [...document.querySelectorAll<HTMLElement>('#rg-cur .rg-row')].map(r => r.dataset.key))));
    // the host's cap drops the ended record, and observed_gone takes it out of the page
    for (let i = 0; i < 260; i++) await report('far', { session_id: 'f' + i, kind: 'prompt', cwd: '/srv/gamma', text: 'task ' + i });
    const dropped = await until(() => D.evaluate((id: string) => { const C = window.__canvas, far = Object.values<ObservedSession>(C.OBS).filter(o => o.host === 'farbox'); return !C.OBS[id] && far.length === 256 && far.some(o => o.sessionId === 'f259'); }, ids.a2), 15000);
    check('N77: a record dropped at the host\'s cap leaves the page', dropped === true, JSON.stringify(await D.evaluate((id: string) => { const C = window.__canvas; return { still: !!C.OBS[id], far: Object.values<ObservedSession>(C.OBS).filter(o => o.host === 'farbox').length }; }, ids.a2)));
    const busyId = await D.evaluate(() => Object.values<ObservedSession>(window.__canvas.OBS).find(o => o.host === 'farbox' && o.sessionId === 'f259')!.id);
    await D.evaluate((id: string) => window.__canvas.meshOpen(id), busyId);
    const busyRow = await D.locator(`#mesh-list .mesh-row[data-id="${busyId}"]`).elementHandle();
    const eventCount = await D.evaluate((id: string) => window.__canvas.OBS[id].counts.events, busyId);
    await report('far', { session_id: 'f259', kind: 'note', text: 'n77 stable activity update' });
    const updated = await until(() => D.evaluate(({ id, n }) => window.__canvas.OBS[id].counts.events > n, { id: busyId, n: eventCount }), 8000);
    check('N77: a hundreds-row Agents list keeps its selected row DOM through an ordinary activity update',
      !!updated && await D.locator('#mesh-list .mesh-row').count() >= 256 && await busyRow!.evaluate(e => e.isConnected && e === document.querySelector('#mesh-list .mesh-row.on')),
      JSON.stringify({ updated, rows: await D.locator('#mesh-list .mesh-row').count() }));
    await D.evaluate(({ shell, before }: { shell: string; before: { view: string } }) => { const C = window.__canvas; document.querySelector<HTMLInputElement>('#mesh-ended')!.click(); C.setView(before.view || 'canvas'); C.removeNode(shell); }, { shell, before });
    await settled(D);
  } finally { await D.close(); }
});
