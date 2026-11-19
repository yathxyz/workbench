import { check, section, sleep } from '../shared.mts';
import { api, dpage, settled } from '../daemon.mts';
import { ACWD, acpWs } from '../acp.mts';

// N26 needs no agent: a board acp card mounts, and opens (if the server has /acp) without spawn fields
await section('N26', async () => {
  const cur = await api('/api/board'), etag = cur.headers.get('ETag')!, board = await cur.json();
  board.nodes.n26a = { id: 'n26a', kind: 'agent', name: 'old-chat', x: 100, y: 1300, w: 400, h: 300, tier: 'quick', turns: [{}], log: [{ t: 'user', text: 'hi' }, { t: 'assistant', text: 'hello' }] };
  board.nodes.n26b = { id: 'n26b', kind: 'acp', name: 'agent26', agent: 'stub', cwd: ACWD, x: 600, y: 1300, w: 560, h: 520 };
  const r = await api('/api/board', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': etag }, body: JSON.stringify(board) });
  const P = await dpage();
  try {
    await sleep(1500);
    const st = await P.evaluate(() => { const C = window.__canvas, a = C.S.nodes.n26a, b = C.S.nodes.n26b; return { a: a && { kind: a.kind, text: C.pageText(a.id), log: 'log' in a, turns: 'turns' in a }, b: b && { kind: b.kind, agent: b.agent, cwd: b.cwd }, mounted: !!C.live.n26b?.backend }; });
    const spawned = acpWs(P, 'n26b').some(w => 'agent' in w.open! || 'cwd' in w.open!);
    check('N26: migrateV9 still turns a legacy agent node into a page and leaves an acp node as it was; a board acp card opens without spawn fields',
      r.status === 204 && st.a?.kind === 'buffer' && /\(former agent node\)/.test(st.a.text) && /> hi\n\nhello/.test(st.a.text) && !st.a.log && !st.a.turns && st.b?.kind === 'acp' && st.b.agent === 'stub' && st.b.cwd === ACWD && st.mounted && !spawned, JSON.stringify({ put: r.status, st, spawned }));
    await P.evaluate(() => ['n26a', 'n26b'].forEach(id => window.__canvas.removeNode(id))); await settled(P);
  } finally { await P.close(); }
});
