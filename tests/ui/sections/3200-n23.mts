import { check, skip, sleep, state, until } from '../shared.mts';
import { hubCtl } from '../daemon.mts';
import { acpEvs, acpIdle, acpSay, acpSent, acpView, acpWs, stubSection } from '../acp.mts';

await stubSection('N23', async () => {
  const { AP, AID } = state;
  const id = AID, name = await AP.evaluate((id: string) => window.__canvas.S.nodes[id].name, id), before = (await acpIdle(AP, id))?.items || [];
  // A page takes the focus, so the interrupted turn stays unseen until the card is looked at.
  const nb = await AP.evaluate(() => { const C = window.__canvas, b = C.addNode({ kind: 'buffer', name: 'n23', x: 3000, y: 3000, w: 300, h: 200, text: '# n23' }); C.jumpNode(b); return b.id; });
  const seen0 = acpSent(AP, id, 'seen').length;
  await AP.evaluate((id: string) => window.__canvas.live[id].backend.input('slow\r'), id);
  const turn = await until(async () => (await acpView(AP, id))!.activity === 'turn', 15000);
  if (!await hubCtl('stop')) { await AP.evaluate((nb: string) => window.__canvas.removeNode(nb), nb); return skip('N23', 'the harness did not acknowledge "stop hub"'); }
  await sleep(1000); const t1 = Date.now(); await hubCtl('start');
  // ↻ shows from the exit the card saw before the stop; the state is read once the card is attached to the new hub.
  const err = await until(async () => { const v = await acpView(AP, id); return v!.st === 'error' && v!.revive && acpWs(AP, id, t1).some(w => w.hello && !w.closed) ? v : null; }, 40000);
  const head = await AP.evaluate((id: string) => window.__canvas.live[id].backend.sum?.acp?.headSeq, id), last = acpEvs(AP, id, 'turn_error').at(-1);
  const attn = await AP.evaluate((id: string) => window.__canvas.attnItems().filter((i: RgEntry) => i.key === id).map((i: RgEntry) => i.name), id), unseen = acpSent(AP, id, 'seen').length === seen0;
  check('N23: a mid-turn hub restart shows error (interrupted) with ↻ and "failed" in Attention while the card is not looked at, and sends no seen',
    turn && !!err && last?.code === 'interrupted' && attn.includes(name + ' failed') && unseen, JSON.stringify({ turn, st: (await acpView(AP, id))?.st, last, attn, unseen }));
  await AP.evaluate((id: string) => window.__canvas.jumpNode(window.__canvas.S.nodes[id]), id);
  const det = await until(async () => { const v = await acpView(AP, id); return v!.st === 'detached' && v!.revive ? v : null; }, 10000), seen = acpSent(AP, id, 'seen');
  check('N23: once the card is looked at, seen goes with the head seq and the state becomes detached with ↻', !!det && seen.length === seen0 + 1 && seen.at(-1)!.seq === head, JSON.stringify({ st: (await acpView(AP, id))?.st, seen, head }));
  await AP.evaluate((id: string) => window.__canvas.live[id].revive.click(), id);
  const back = await until(async () => { const v = await acpView(AP, id); return v!.alive && v!.promptable ? v : null; }, 30000);
  const intact = !!back && before.length > 0 && before.every((x, i) => back.items[i] === x);
  if (back) await acpSay(AP, id, 'stream');
  const more = back && await until(async () => { const v = await acpView(AP, id); return v!.asst > back.asst && v!.promptable ? v : null; }, 20000);
  check('N23: ↻ revives it with its transcript, and a new prompt works', !!det && acpSent(AP, id, 'revive').length >= 1 && intact && !!more, JSON.stringify({ intact, before: before.length, after: back?.items.length, more: !!more }));
  await AP.evaluate((nb: string) => window.__canvas.removeNode(nb), nb);
});
