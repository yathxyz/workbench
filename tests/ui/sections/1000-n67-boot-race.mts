import { check, section, state, until, watchErrors } from '../shared.mts';
import { ORIGIN, api, barOf, ctx, record, settled } from '../daemon.mts';

const { A } = state;

// N67 (F-A7, §3.5.3): a save between a page's GET /api/board and its /rpc subscription reaches the page. Its boot GET is
// answered with the board as it was, after another writer saved; /rpc opens only after /api/info, so no board notice
// covers that save and only the connect snapshot's board{etag} can tell the page.
await section('N67', async () => {
  await settled(A);
  const target = await A.evaluate(() => { const C = window.__canvas; return C.addrOf(Object.values<BoardNode>(C.S.nodes).find(n => n.kind === 'buffer')); });
  for (const supersede of [false, true]) {
    const P = await ctx.newPage(); watchErrors(P); record(P);
    let put: { id: string; x: number; status: number; etag: string | null; stale: string } | null = null;
    let selected = '';
    await P.route('**/api/board', async r => {
      if (r.request().method() !== 'GET') return r.continue();
      if (put) {
        if (supersede) {
          await P.waitForFunction(() => window.__canvas?.BOOTED);
          selected = await P.evaluate(target => {
            const C = window.__canvas, n = Object.values<BoardNode>(C.S.nodes).find(n => n.id !== target && n.kind !== 'frame')!;
            C.activate(n.id); return n.id;
          }, put.id);
        }
        return r.continue();
      }
      const res = await r.fetch(), stale = await res.json(), board = structuredClone(stale);
      const n = Object.values<BoardNode>(board.nodes).find(n => n.kind === 'buffer')!; n.x += 13; stale.nodes[n.id].name = 'n67-old-name';
      const w = await api('/api/board', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': res.headers().etag }, body: JSON.stringify(board) });
      put = { id: n.id, x: n.x, status: w.status, etag: w.headers.get('ETag'), stale: res.headers().etag };
      await r.fulfill({ response: res, json: stale });
    });
    try {
      await P.goto(ORIGIN + '/#' + target); await until(() => P.evaluate(() => window.__canvas?.BOOTED));
      const took = await until(() => P.evaluate(({ id, x }) => window.__canvas.S.nodes[id]?.x === x, put!), 8000);
      const st = await P.evaluate(id => ({ x: window.__canvas.S.nodes[id]?.x, etag: window.__canvas.BOARD_ETAG }), put!.id), b = await barOf(P);
      check('N67: a save between the page\'s GET /api/board and its /rpc subscription reaches the page: a clean page takes that board and its tag, with no bar',
        put!.status === 204 && put!.etag !== put!.stale && !!took && st.etag === put!.etag && b.hidden, JSON.stringify({ put, st, b }));
      const active = await P.locator('.node.active').getAttribute('data-id', { timeout: 2000 }).catch(() => null);
      check('N67: ' + (supersede ? 'board adoption does not override a newer card selection' : 'a boot address missing from the stale board opens when its target arrives'),
        active === (supersede ? selected : put!.id), String(active));
    } finally { await P.close(); await settled(A); }
  }

  // Keep the index response pending across boot, with and without a newer navigation.
  for (const supersede of [false, true]) {
    const tab = await ctx.newPage(); watchErrors(tab);
    let release!: () => void; const held = new Promise<void>(r => { release = r; });
    await tab.route('**/api/nodes?*', async r => {
      await held;
      await r.fulfill({ json: { nodes: [
        { id: 'cold', title: 'Cold note', path: 'cold.md', kind: 'file', line: 1 },
        { id: 'head', title: 'A heading', path: 'cold.md', kind: 'heading', level: 1, line: 2 },
      ] } });
    });
    try {
      await tab.goto(ORIGIN + '/#note:Cold%20note'); await tab.waitForFunction(() => window.__canvas?.BOOTED);
      if (supersede) await tab.evaluate(() => window.__canvas.goAddr('tag:', true));
      release();
      const ready = await until(() => tab.evaluate(() => window.__canvas.addrToKey('note:Cold note') === 'note:cold'));
      const dir = await tab.evaluate(() => window.__canvas.RG.dir);
      check('N67: a cold note address ' + (supersede ? 'does not override newer navigation' : 'opens after the index arrives'),
        ready && dir === (supersede ? 'tag:' : 'note:cold'), dir);
    } finally { release(); await tab.close(); }
  }
});
