import { check, state, until } from '../shared.mts';
import { api, dpage, settled } from '../daemon.mts';
import { ACWD, acpIdle, acpWs, stubSection } from '../acp.mts';

await stubSection('N25', async () => {
  const id = state.AID, epoch = (await acpIdle(state.AP, id))?.epoch;
  await settled(state.AP); await state.AP.close();   // the session stays: a page that goes sends no kill
  // the test hook: the node leaves the board without a kill, as a lost card would
  const cur = await api('/api/board'), etag = cur.headers.get('ETag')!, board = await cur.json(); delete board.nodes[id];
  const r = await api('/api/board', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': etag }, body: JSON.stringify(board) });
  state.AP = await dpage();
  const item = await until(() => state.AP.evaluate((id: string) => { const i = window.__canvas.attnItems().find((i: RgEntry) => i.key === 'orphan:' + id); return i && { name: i.name, attn: i.attn, meta: i.meta }; }, id), 10000);
  const t1 = Date.now();
  if (item) await state.AP.evaluate((id: string) => window.__canvas.attnItems().find((i: RgEntry) => i.key === 'orphan:' + id).go(), id);
  const w = await until(() => acpWs(state.AP, id, t1).find(w => w.hello), 10000);
  check('N25: a live session with no card is listed as running without a card; adopting it makes a card with the same id that attaches without spawning',
    r.status === 204 && /running without a card$/.test(item?.name || '') && item.attn === 'bad' && item.meta === ACWD && !!w && !('agent' in w.open!) && w.hello!.info?.createdAt === epoch && await state.AP.evaluate((id: string) => window.__canvas.S.nodes[id]?.kind === 'acp', id), JSON.stringify({ put: r.status, item, open: w?.open, epoch, got: w?.hello?.info?.createdAt }));
  await acpIdle(state.AP, id);
});
