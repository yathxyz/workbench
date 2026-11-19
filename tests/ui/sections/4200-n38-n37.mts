import { check, skip, sleep, state, until } from '../shared.mts';
import { hubCtl } from '../daemon.mts';
import { acpClick, acpIdle, acpNew, acpSay, acpSent, acpShow, acpView, stubSection } from '../acp.mts';

let N38: string | null = null;
await stubSection('N38', async () => {
  const { AP, AID } = state;
  const a = AID; await acpIdle(AP, a);
  const b = N38 = await acpNew(AP) as string; await acpIdle(AP, b);
  for (const id of [a, b]) await acpSay(AP, id, 'perm');
  await until(async () => (await acpView(AP, a))!.st === 'waiting_permission' && (await acpView(AP, b))!.st === 'waiting_permission', 15000);
  await AP.evaluate(() => window.__canvas.jumpNode(window.__canvas.addNode({ kind: 'buffer', name: 'n38', x: 3600, y: 3600, w: 300, h: 200, text: '# n38' })));
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    await AP.evaluate(() => window.__canvas.statusRender());
    await AP.click('#st-host .stc:has-text("waiting")');
    await sleep(600); seen.push(await AP.evaluate(() => window.__canvas.activeId));
  }
  check('N38: with two waiting cards, successive clicks on the waiting chip focus one, then the other, then the first again', seen[0] !== seen[1] && seen[2] === seen[0] && [a, b].every(id => seen.includes(id)), JSON.stringify({ seen, a, b }));
  await AP.evaluate(() => { const C = window.__canvas, n = Object.values<BoardNode>(C.S.nodes).find(n => n.name === 'n38'); if (n) C.removeNode(n.id); });
  for (const id of [a, b]) { await acpShow(AP, id); await acpClick(AP, id, '.ag-perm button[data-kind="allow_once"]'); await acpIdle(AP, id); }
});
await stubSection('N37', async () => {
  const { AP, AID } = state;
  const ids = [AID, N38].filter(Boolean) as string[];
  if (ids.length < 2) return check('N37: two stub cards to revive', false, 'N38 made no second card');
  if (!await hubCtl('stop')) return skip('N37', 'the harness did not acknowledge "stop hub"');
  await sleep(1000); await hubCtl('start');
  const ready = await until(() => AP.evaluate((ids: string[]) => {
    const C = window.__canvas, t = document.querySelector('#toast')!, det = C.agentsDetached().map((n: BoardNode) => n.id);
    return t.classList.contains('show') && t.querySelector('button')?.textContent === 'Revive all agents' && ids.every(id => det.includes(id))
      ? { toast: t.textContent, line: C.attnItems().find((i: RgEntry) => i.key === 'attn:detached')?.name } : null;
  }, ids), 40000);
  if (ready) await AP.click('#toast button');
  const back = await until(async () => { for (const id of ids) { const v = await acpView(AP, id); if (!v?.alive || !v.promptable) return null; } return true; }, 30000);
  check('N37: after a hub restart the toast offers Revive all agents, Attention says 2 agents detached, and the button revives both cards', !!ready && /hub restarted/.test(ready.toast) && ready.line === '2 agents detached' && !!back && ids.every(id => acpSent(AP, id, 'revive').length >= 1), JSON.stringify({ ready, back, views: await Promise.all(ids.map(id => acpView(AP, id).then(v => v && { st: v.st, alive: v.alive }))) }));
  if (N38) await AP.evaluate((id: string) => window.__canvas.removeNode(id), N38);
});
