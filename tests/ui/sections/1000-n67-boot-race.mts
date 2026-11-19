import { check, section, state, until, watchErrors } from '../shared.mts';
import { ORIGIN, api, barOf, ctx, record, settled } from '../daemon.mts';

const { A } = state;

// N67 (F-A7, §3.5.3): a save between a page's GET /api/board and its /rpc subscription reaches the page. Its boot GET is
// answered with the board as it was, after another writer saved; /rpc opens only after /api/info, so no board notice
// covers that save and only the connect snapshot's board{etag} can tell the page.
await section('N67', async () => {
  await settled(A);
  const P = await ctx.newPage(); watchErrors(P); record(P);
  let put: { id: string; x: number; status: number; etag: string | null; stale: string } | null = null;
  await P.route('**/api/board', async r => {
    if (r.request().method() !== 'GET' || put) return r.continue();
    put = {} as NonNullable<typeof put>;
    const res = await r.fetch(), stale = await res.json(), board = structuredClone(stale);
    const n = Object.values<BoardNode>(board.nodes).find(n => n.kind === 'buffer')!; n.x += 13;
    const w = await api('/api/board', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': res.headers().etag }, body: JSON.stringify(board) });
    Object.assign(put, { id: n.id, x: n.x, status: w.status, etag: w.headers.get('ETag'), stale: res.headers().etag });
    await r.fulfill({ response: res, json: stale });
  });
  try {
    await P.goto(ORIGIN + '/'); await until(() => P.evaluate(() => window.__canvas?.BOOTED));
    const took = await until(() => P.evaluate(({ id, x }) => window.__canvas.S.nodes[id]?.x === x, put!), 8000);
    const st = await P.evaluate(id => ({ x: window.__canvas.S.nodes[id]?.x, etag: window.__canvas.BOARD_ETAG }), put!.id), b = await barOf(P);
    check('N67: a save between the page\'s GET /api/board and its /rpc subscription reaches the page: a clean page takes that board and its tag, with no bar',
      put!.status === 204 && put!.etag !== put!.stale && !!took && st.etag === put!.etag && b.hidden, JSON.stringify({ put, st, b }));
  } finally { await P.close(); await settled(A); }
});
