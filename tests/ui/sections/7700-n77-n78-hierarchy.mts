import fs from 'node:fs';
import path from 'node:path';
import { TMP, check, section, skip, state, until, watchErrors } from '../shared.mts';
import { H, ORIGIN, ctx, settled } from '../daemon.mts';
import { acpIdle } from '../acp.mts';

const { STUB } = state;

// N77/N78 hierarchy: real reports and a handwritten checkout/linked worktree, isolated from N77's graph/count fixtures.
await section('N77/N78 hierarchy', async () => {
  const P = await ctx.newPage(); watchErrors(P);
  const prefix = 'n77-tree-', sid = 'n78_hierarchy_api', repo = 'example/hierarchy', otherRepo = 'example/other';
  const dir = fs.mkdtempSync(path.join(TMP, 'n77-hierarchy-')), checkout = path.join(dir, 'checkout'), git = path.join(checkout, '.git');
  const worktrees = ['observed-one', 'observed-two', 'hub-worktree'].map(n => path.join(dir, n)), hubGit = path.join(git, 'worktrees', 'hub-worktree');
  fs.mkdirSync(hubGit, { recursive: true });
  for (const cwd of worktrees) fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(git, 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@example.invalid:example/hierarchy.git\n');
  fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(worktrees[2], '.git'), 'gitdir: ' + hubGit + '\n');
  fs.writeFileSync(path.join(hubGit, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(hubGit, 'gitdir'), path.join(worktrees[2], '.git') + '\n');
  fs.writeFileSync(path.join(hubGit, 'HEAD'), 'ref: refs/heads/topic/hub\n');
  const ids: Record<string, string> = {};
  // Reports currently expose only direct subagents. Rewrite only existing parent edges on the real RPC feed to
  // exercise its arbitrary-depth consumer contract, without adding a parent/title API or inventing session records.
  const hierarchy = (o: ObservedSession): void => {
    if (!o.sessionId.startsWith(prefix)) return;
    const name = o.key.endsWith('/cross') ? 'cross' : o.sessionId.slice(prefix.length);
    ids[name] = o.id;
    const parent = name === 'deep' ? ids.cross : name === 'waiting' ? ids.deep : name === 'quiet' ? ids.root : name === 'missing' ? 'o_missing_hierarchy_parent' : undefined;
    if (parent) o.parent = parent;
  };
  await P.routeWebSocket(/\/rpc$/, ws => {
    const server = ws.connectToServer();
    server.onMessage(message => {
      const m = JSON.parse(message as string) as HubMsg;
      if (m.t === 'observed') { m.sessions.forEach(hierarchy); ws.send(JSON.stringify(m)); }
      else if (m.t === 'observed_put') { hierarchy(m.session); ws.send(JSON.stringify(m)); }
      else ws.send(message);
    });
  });
  const meshApi = (url: string, method = 'GET', body?: Record<string, unknown>) => fetch(H.api + '/v1' + url, {
    method, headers: { Authorization: 'Bearer ' + fs.readFileSync(H.apiTokenFiles.near, 'utf8').trim(), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const report = async (name: string, payload: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) =>
    (await meshApi('/events', 'POST', { harness: 'pi', payload: { session_id: prefix + name, kind: 'prompt', text: 'hierarchy ' + name, ...payload }, ...metadata })).status;
  const reported = async (name: string, payload: Record<string, unknown>, metadata: Record<string, unknown>) => {
    const status = await report(name, payload, metadata);
    if (status !== 204 || !await until(() => ids[name], 8000)) throw new Error('hierarchy report ' + name + ': ' + status);
  };
  const metadata = (i: number) => ({ repoRoot: checkout, repo, worktree: path.basename(worktrees[i]), branch: i ? 'topic/two' : 'topic/one', projectRoot: worktrees[i] });
  const row = (name: string) => P.locator(`#mesh-list .mesh-row[data-id="${ids[name] || name}"]`);
  const group = (name: string) => row(name).evaluate(e => { let prev = e.previousElementSibling; while (prev && !prev.classList.contains('mesh-group')) prev = prev.previousElementSibling; return prev?.textContent; });
  try {
    await P.goto(ORIGIN + '/'); await P.waitForFunction(() => window.__canvas?.BOOTED); await settled(P);
    // N77's assertions are finished; end its remaining waiting fixture so the status chip has one unambiguous target.
    await fetch(H.api + '/v1/events', { method: 'POST', headers: { Authorization: 'Bearer ' + fs.readFileSync(H.apiTokenFiles.far, 'utf8').trim(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ harness: 'pi', payload: { session_id: 'a1', kind: 'end' } }) });
    await reported('root', { cwd: worktrees[0] }, metadata(0));
    await reported('two', { cwd: worktrees[1] }, metadata(1));
    const crossStatus = await report('root', { kind: 'subagent_start', agent_id: 'cross', agent_type: 'explorer', cwd: '/srv/other' },
      { repoRoot: '/srv/other', repo: otherRepo, worktree: 'other-tree', branch: 'topic/other', projectRoot: '/srv/other' });
    if (crossStatus !== 204 || !await until(() => ids.cross, 8000)) throw new Error('hierarchy cross-repo subagent did not arrive');
    await reported('deep', { cwd: '/srv/deep' }, { repo: 'example/deep', branch: 'topic/deep' });
    await reported('waiting', { cwd: '/srv/waiting' }, { repo: 'example/waiting', branch: 'topic/waiting' });
    await reported('quiet', { cwd: worktrees[0] }, metadata(0));
    await reported('missing', { cwd: '/srv/missing' }, { repo: 'example/missing' });
    await reported('legacy', { cwd: '/srv/n77-legacy' }, {});
    await report('waiting', { kind: 'permission', tool: { name: 'Bash', input: { command: 'hierarchy permission' } } });
    await P.evaluate(() => window.__canvas.meshOpen());
    await row('waiting').waitFor();
    const ready = await until(() => row('waiting').evaluate(e => e.classList.contains('bad')), 8000);
    const observed = await P.evaluate((ids: Record<string, string>) => Object.fromEntries(['root', 'two', 'cross', 'deep', 'waiting', 'quiet', 'missing', 'legacy'].map(name => {
      const e = document.querySelector<HTMLElement>(`#mesh-list .mesh-row[data-id="${ids[name]}"]`)!;
      return [name, { depth: e.dataset.depth, branch: e.querySelector('.mesh-branch')?.getAttribute('title'), repo: e.querySelector('.mesh-repo')?.getAttribute('title'), worktree: e.querySelector('.mesh-worktree')?.getAttribute('title'), context: e.querySelector('.mesh-context')?.textContent || '' }];
    })), ids);
    const groups = await P.locator('#mesh-list .mesh-group').allTextContents();
    check('N77: observed worktrees share one repository group with distinct branch/worktree labels; older reports fall back to project',
      ready && groups.filter(g => g === repo).length === 1 && await group('root') === repo && await group('two') === repo
      && observed.root.branch === 'topic/one' && observed.two.branch === 'topic/two' && observed.root.worktree === 'observed-one' && observed.two.worktree === 'observed-two'
      && observed.root.context.includes('topic/one') && observed.two.context.includes('topic/two') && observed.root.context.includes('observed-one') && observed.two.context.includes('observed-two')
      && await group('legacy') === 'n77-legacy' && !observed.legacy.branch && !observed.legacy.worktree, JSON.stringify({ groups, observed }));
    check('N77: a cross-repository parent chain nests at arbitrary depth; a missing parent promotes its child to a root',
      observed.root.depth === '0' && observed.cross.depth === '1' && observed.deep.depth === '2' && observed.waiting.depth === '3' && observed.missing.depth === '0'
      && observed.cross.repo === otherRepo && await group('cross') === repo && !groups.includes(otherRepo), JSON.stringify(observed));
    await row('deep').click();
    await P.locator('#mesh-detail .mesh-parent').click();
    check('N77: the detail parent link selects the cross-repository parent', await row('cross').evaluate(e => e.classList.contains('on')));
    await row('root').click(); await row('root').locator('.mesh-collapse').click();
    const collapsed = await row('root').locator('.mesh-collapsed').evaluate(e => ({ count: e.getAttribute('data-count'), state: e.getAttribute('data-state'), hidden: e.getAttribute('data-hidden'), text: e.textContent }));
    check('N77: collapsing hides the subtree while its summary retains descendant count and worst waiting state',
      collapsed.count === '4' && collapsed.state === 'waiting_permission' && collapsed.hidden === '4' && /4 descendants/.test(collapsed.text || '')
      && !await row('quiet').count() && !await row('cross').count() && !await row('deep').count() && !await row('waiting').count(),
      JSON.stringify(collapsed));
    await P.evaluate(() => window.__canvas.statusRender());
    await P.locator('#st-host .stc').filter({ hasText: /^mesh \d+/ }).click();
    const firstWaiting = await row('waiting').evaluate(e => e.classList.contains('on'));
    const expanded = await row('root').locator('.mesh-collapse').getAttribute('aria-expanded');
    check('N77: first-waiting opens the deep descendant and expands its ancestors', firstWaiting && expanded === 'true' && await row('quiet').count() === 1, JSON.stringify({ firstWaiting, expanded }));
    await row('root').locator('.mesh-collapse').click(); await row('root').locator('.mesh-collapse').click();
    check('N77: expanding restores quiet descendants at their original depth', await row('quiet').getAttribute('data-depth') === '1' && !await row('root').locator('.mesh-collapsed').isVisible());
    await row('cross').click(); await P.locator('#mesh-list').focus(); await P.keyboard.press('ArrowDown');
    const down = await row('deep').evaluate(e => e.classList.contains('on'));
    await P.keyboard.press('k');
    const up = await row('cross').evaluate(e => e.classList.contains('on'));
    const stableRow = await row('cross').elementHandle(), stableDetail = await P.locator('#mesh-detail h3').elementHandle();
    const count = await P.evaluate((id: string) => window.__canvas.OBS[id].counts.events, ids.cross);
    const update = await report('root', { kind: 'note', agent_id: 'cross', text: 'hierarchy stable activity' });
    const updated = await until(() => P.evaluate(({ id, count }) => window.__canvas.OBS[id].counts.events > count, { id: ids.cross, count }), 8000);
    check('N77: keyboard follows the expanded tree and an ordinary report preserves selected row/detail DOM and valid metadata',
      down && up && update === 204 && !!updated && await stableRow!.evaluate(e => e.isConnected && e === document.querySelector('#mesh-list .mesh-row.on'))
      && await stableDetail!.evaluate(e => e === document.querySelector('#mesh-detail h3'))
      && await row('cross').locator('.mesh-repo').getAttribute('title') === otherRepo && await row('cross').locator('.mesh-branch').getAttribute('title') === 'topic/other', JSON.stringify({ down, up, update, updated }));

    if (STUB) {
      const created = await meshApi('/sessions', 'POST', { sid, agent: 'stub', cwd: worktrees[2] });
      if (created.status !== 201) throw new Error('hierarchy hub ACP: ' + created.status + ' ' + await created.text());
      const joined = await until(async () => await row(sid).count() && await row(sid).locator('.mesh-branch').getAttribute('title') === 'topic/hub' && (await row(sid).textContent())?.includes('topic/hub'), 15000);
      const hubMetadata = await P.evaluate((sid: string) => { const s = window.__canvas.SESS[sid]; return { repoRoot: s?.repoRoot, repo: s?.repo, worktree: s?.worktree, branch: s?.branch, card: !!window.__canvas.S.nodes[sid] }; }, sid);
      check('N78: a hub ACP in a handwritten linked worktree derives repository metadata and joins observed worktrees without a board card',
        !!joined && await group(sid) === repo && hubMetadata.repoRoot === checkout && hubMetadata.repo === repo && hubMetadata.worktree === 'hub-worktree' && hubMetadata.branch === 'topic/hub' && !hubMetadata.card,
        JSON.stringify(hubMetadata));
      // The only report for this session is a real child event: its parent must never enter OBS.
      await P.evaluate(({ sid, cwd }) => {
        const C = window.__canvas; C.setView('canvas');
        C.addNode({ id: sid, kind: 'acp', name: 'hierarchy hub card', agent: 'stub', cwd, x: 100, y: 100, w: 560, h: 520, adopted: true, _spawn: false });
      }, { sid, cwd: worktrees[2] });
      try {
        await acpIdle(P, sid);
        const hubState = await P.evaluate((sid: string) => window.__canvas.SESS[sid].state, sid);
        const started = await report('orphan', { kind: 'subagent_start', agent_id: 'child', agent_type: 'explorer', cwd: worktrees[0] }, { ...metadata(0), wbSession: sid });
        if (started !== 204 || !await until(() => ids.orphan, 8000)) throw new Error('hierarchy orphan subagent did not arrive: ' + started);
        const permission = await report('orphan', { kind: 'permission', agent_id: 'child', tool: { name: 'Bash', input: { command: 'orphan permission' } } }, { wbSession: sid });
        await P.evaluate((id: string) => window.__canvas.meshOpen(id), ids.orphan);
        await row('orphan').waitFor();
        const waiting = await until(() => row('orphan').evaluate(e => e.classList.contains('bad')), 8000);
        await P.evaluate((sid: string) => window.__canvas.meshOpen(sid), sid);
        const separate = await P.evaluate(({ id, sid, sessionId }) => {
          const C = window.__canvas, o = C.OBS[id], s = C.SESS[sid];
          const child = document.querySelector<HTMLElement>(`#mesh-list .mesh-row[data-id="${id}"]`);
          const hub = document.querySelector<HTMLElement>(`#mesh-list .mesh-row[data-id="${sid}"]`);
          return { parent: o.parent, parentAbsent: !!o.parent && !C.OBS[o.parent],
            onlyChild: Object.values<ObservedSession>(C.OBS).filter(o => o.sessionId === sessionId).every(o => !!o.parent),
            sameHost: o.host === s.host, wbSession: o.wbSession, observedState: o.state, hubState: s.state,
            child: child && { depth: child.dataset.depth, card: child.dataset.card, dot: child.querySelector('.dot')?.className },
            hub: hub && { card: hub.dataset.card, dot: hub.querySelector('.dot')?.className, selected: hub.classList.contains('on') },
            selected: C.MESH.open, cardPresent: C.S.nodes[sid]?.kind === 'acp' };
        }, { id: ids.orphan, sid, sessionId: prefix + 'orphan' });
        check('N77/N78: an unreported parent cannot let its child inherit a same-host hub session, card, alias, or state',
          permission === 204 && !!waiting && separate.parentAbsent && separate.onlyChild && separate.sameHost && separate.wbSession === sid
          && separate.child?.depth === '0' && separate.child.card === '' && separate.child.dot === 'dot st-waiting_permission'
          && separate.observedState === 'waiting_permission' && separate.hubState === hubState && separate.hub?.card === sid
          && separate.hub.dot === 'dot st-' + hubState && separate.hub.selected && separate.selected === sid && separate.cardPresent,
          JSON.stringify({ hubState, separate }));
      } finally {
        await report('orphan', { kind: 'end', agent_id: 'child' });
        await P.evaluate((sid: string) => { const C = window.__canvas; if (C.S.nodes[sid]) C.removeNode(sid); }, sid);
      }
      const hubRow = await row(sid).elementHandle();
      fs.writeFileSync(path.join(hubGit, 'HEAD'), 'ref: refs/heads/topic/switched\n');
      const refreshed = await until(async () => await row(sid).locator('.mesh-branch').getAttribute('title') === 'topic/switched', 15000);
      check('N78: a quiet hub session refreshes a filesystem branch change over RPC without an activity event or row remount',
        !!refreshed && await hubRow!.evaluate(e => e.isConnected && e === document.querySelector(`#mesh-list .mesh-row[data-id="${e.getAttribute('data-id')}"]`)));
    } else skip('N78 hierarchy hub', 'no `stub` agent (wb-fake-acp) in /api/info.agents');

    await P.evaluate(() => window.__canvas.setView('graph'));
    const graphed = await until(() => P.evaluate((repo: string) => window.__canvas.G.N.has('proj:' + repo), repo), 8000);
    const graph = await P.evaluate(({ ids, repo, sid }: { ids: Record<string, string>; repo: string; sid: string }) => {
      const C = window.__canvas, edge = (a: string, b: string, type: string) => C.G.E.some((e: { a: string; b: string; type: string }) => e.type === type && ((e.a === a && e.b === b) || (e.a === b && e.b === a)));
      return { groups: [...C.G.N.keys()].filter(k => k === 'proj:' + repo), one: edge('proj:' + repo, 'mesh:' + ids.root, 'mesh'), two: edge('proj:' + repo, 'mesh:' + ids.two, 'mesh'),
        cross: edge('mesh:' + ids.root, 'mesh:' + ids.cross, 'spawn'), deep: edge('mesh:' + ids.cross, 'mesh:' + ids.deep, 'spawn'), hub: edge('proj:' + repo, 'mesh:' + sid, 'mesh') };
    }, { ids, repo, sid });
    check('N77/N78: the graph shares one repository node across worktrees and preserves cross-repository spawn ancestry',
      !!graphed && graph.groups.length === 1 && graph.one && graph.two && graph.cross && graph.deep && (!STUB || graph.hub), JSON.stringify(graph));
    await P.evaluate((id: string) => window.__canvas.meshOpen(id), ids.two);
    await row('two').click();
    await report('deep', { kind: 'end' });
    const promoted = await until(() => row('waiting').getAttribute('data-depth').then(d => d === '0'), 8000);
    check('N77: a child of an ended, hidden parent is promoted to its own repository root', !!promoted && !await row('deep').count() && await group('waiting') === 'example/waiting');
  } finally {
    await P.evaluate(() => window.__canvas.setView('canvas'));
    await meshApi('/sessions/' + sid + '?forget=true', 'DELETE');
    for (const name of ['root', 'two', 'deep', 'waiting', 'quiet', 'missing', 'legacy']) await report(name, { kind: 'end' });
    await settled(P); await P.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
