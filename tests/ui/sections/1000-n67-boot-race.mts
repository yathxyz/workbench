import { check, section, state, until, watchErrors } from '../shared.mts';
import { ORIGIN, api, barOf, record, settled } from '../daemon.mts';

const { A } = state;

// N67 (F-A7, §3.5.3): a save between a page's GET /api/board and its /rpc subscription reaches the page. Its boot GET is
// answered with the board as it was, after another writer saved; /rpc opens only after /api/info, so no board notice
// covers that save and only the connect snapshot's board{etag} can tell the page.
await section('N67', async () => {
  await settled(A);
  const target = await A.evaluate(() => { const C = window.__canvas; return C.addrOf(Object.values<BoardNode>(C.S.nodes).find(n => n.kind === 'buffer')); });
  for (const action of ['open', 'select', 'miss', 'timeout']) {
    const P = await state.browser.newPage({ serviceWorkers: 'block' }); watchErrors(P); record(P);
    if (action !== 'open') await P.clock.install();
    let put: { id: string; x: number; status: number; etag: string | null; stale: string } | null = null;
    let selected = '';
    await P.route('**/api/board', async r => {
      if (r.request().method() !== 'GET') return r.continue();
      if (put) {
        if (action === 'miss') {
          await P.waitForFunction(() => window.__canvas?.BOOTED);
          await P.evaluate(() => { const C = window.__canvas; C.boardAdopt(JSON.parse(C.serialize())); });
        }
        if (action === 'timeout') { await P.waitForFunction(() => window.__canvas?.BOOTED); await P.clock.fastForward(60_000); }
        if (action === 'select') {
          await P.waitForFunction(() => window.__canvas?.BOOTED);
          selected = await P.evaluate(target => {
            const C = window.__canvas, n = Object.values<BoardNode>(C.S.nodes).find(n => n.id !== target && n.kind !== 'frame')!;
            C.activate(n.id); return n.id;
          }, put.id);
          await P.clock.runFor(450); // keep the response pending past the old boot timer
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
      if (action !== 'open') await P.clock.runFor(600); // include the old delayed boot jump
      const active = await P.evaluate(() => document.querySelector<HTMLElement>('.node.active')?.dataset.id);
      check(`N67: boot address on board adoption: ${action}`, action === 'timeout' || action === 'miss' ? active !== put!.id
        : active === (action === 'select' ? selected : put!.id), String(active));
    } finally { await P.close(); await settled(A); }
  }

  // Hold the index across the action; the view at boot matters for navigation within the same view.
  for (const action of ['open', 'address', 'desk', 'click', 'arrow', 'file', 'timeout', 'reject']) {
    const tab = await state.browser.newPage({ viewport: { width: 1500, height: 950 }, serviceWorkers: 'block' }); watchErrors(tab);
    await tab.clock.install();
    const view = action === 'file' ? 'editor' : ['click', 'arrow'].includes(action) ? 'ranger' : 'canvas';
    await tab.route('**/api/board', async r => {
      if (r.request().method() !== 'GET') return r.fulfill({ status: 204 }); // keep the fixture local to this tab
      const res = await r.fetch(); await r.fulfill({ response: res, json: { ...await res.json(), view } });
    });
    let release!: () => void; const held = new Promise<void>(r => { release = r; });
    await tab.route('**/api/nodes?*', async r => {
      await held;
      if (action === 'reject') return r.fulfill({ json: { nodes: [null] } }); // index processing rejects
      await r.fulfill({ json: { nodes: [
        { id: 'cold', title: 'Cold note', path: 'cold.md', kind: 'file', line: 1 },
        { id: 'head', title: 'A heading', path: 'cold.md', kind: 'heading', level: 1, line: 2 },
      ] } });
    });
    try {
      const place = () => tab.evaluate(() => ({ view: document.body.dataset.view, desk: window.__canvas.DESK.cur, dir: window.__canvas.RG.dir, row: document.querySelector<HTMLElement>('#rg-cur .rg-row.on')?.dataset.key, file: window.__canvas.ED.node?.id }));
      await tab.goto(ORIGIN + '/#note:Cold%20note'); await tab.waitForFunction(() => window.__canvas?.BOOTED);
      const initial = await place();
      if (action === 'address') await tab.evaluate(() => window.__canvas.goAddr('tag:', true));
      if (action === 'desk') await tab.evaluate(() => window.__canvas.deskGo(7));
      if (action === 'click') await tab.locator('#rg-cur .rg-row:not(.on)').first().click();
      if (action === 'arrow') await tab.keyboard.press('ArrowDown');
      if (action === 'file') await tab.locator('#ed-list .ed-item:not(.on)').first().click();
      if (action === 'timeout') { await tab.clock.fastForward(60_000); await tab.clock.runFor(1600); }
      const before = await place();
      await tab.clock.runFor(450); // superseding navigation has committed, the index is still unavailable
      const response = tab.waitForResponse(r => new URL(r.url()).pathname === '/api/nodes');
      release();
      await (await response).finished();
      if (action !== 'reject') await tab.waitForFunction(() => window.__canvas.addrToKey('note:Cold note') === 'note:cold');
      await tab.clock.runFor(action === 'reject' ? 1600 : 600);
      const after = await place();
      const reached = action === 'address' ? before.dir === 'tag:' : action === 'desk' ? before.desk === 7
        : action === 'file' ? !!before.file && before.file !== initial.file : ['click', 'arrow'].includes(action) ? !!before.row && before.row !== initial.row : true;
      check('N67: cold note restore: ' + action, action === 'open' ? after.dir === 'note:cold'
        : reached && JSON.stringify(before) === JSON.stringify(after) && (!['timeout', 'reject'].includes(action) || !tab.url().includes('#note:')), JSON.stringify({ initial, before, after }));
    } finally { release(); await tab.close(); }
  }
});
