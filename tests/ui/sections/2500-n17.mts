import { check, sleep, state, until } from '../shared.mts';
import { ACWD, acpEvs, acpNew, acpSent, acpView, acpWs, stubSection } from '../acp.mts';

await stubSection('N17', async () => {
  const { AP } = state;
  await AP.evaluate(() => {   // every text each acp card's badge shows, from its first paint, by card id
    const seen: Record<string, string[]> = window.__n17b = {};
    window.__n17o = new MutationObserver(() => {
      for (const n of document.querySelectorAll<HTMLElement>('.node.k-acp')) { const b = n.querySelector('.badge'), s = seen[n.dataset.id!] ||= []; if (b && s.at(-1) !== b.textContent) s.push(b.textContent!); }
    });
    window.__n17o.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  const id = state.AID = await acpNew(AP) as string;
  await until(async () => { const v = await acpView(AP, id); return v?.promptable && v.tx === 'idle'; }, 20000);
  const seen = await AP.evaluate((id: string) => { window.__n17o.disconnect(); return (window.__n17b[id] || []).map(t => t.split(' · ').at(-1)); }, id), open = acpWs(AP, id)[0]?.open;
  check('N17: newAgentCard opens with agent and cwd from since 0, and the badge goes … → idle', open?.agent === 'stub' && open?.cwd === ACWD && open?.since === 0 && seen[0] === '…' && seen.at(-1) === 'idle', JSON.stringify({ open, seen }));
  // A page takes the focus, so the turn's end stays done until the card is looked at.
  const nb = await AP.evaluate(() => { const C = window.__canvas, b = C.addNode({ kind: 'buffer', name: 'n17', x: 3000, y: 3000, w: 300, h: 200, text: '# n17' }); C.jumpNode(b); return b.id; });
  await AP.evaluate((id: string) => { const b = window.__canvas.live[id].hdr.querySelector('.badge'); window.__n17 = []; new MutationObserver(() => window.__n17.push(b.className)).observe(b, { attributes: true }); }, id);
  const v0 = await acpView(AP, id), seen0 = acpSent(AP, id, 'seen').length, recv0 = acpWs(AP, id).map(w => w.recv.length);
  await AP.evaluate((id: string) => window.__canvas.live[id].backend.input('stream\r'), id);
  // /rpc may bring the done summary before /acp brings the turn's events, so done counts once turn_end is folded.
  const done = await until(async () => { const v = await acpView(AP, id), end = acpEvs(AP, id, 'turn_end', v0!.seq)[0]; return v!.st === 'done' && end && v!.seq >= end.seq ? v : null; }, 20000, 50);
  await sleep(500);
  // The three chunks come at once and the card paints once per frame (30 §1.3), so `running` is checked in the info
  // frames the card took (its state is info.state) and `done` in the painted badge.
  const infos = acpWs(AP, id).flatMap((w, i) => w.recv.slice(recv0[i] || 0)).filter(f => f.t === 'info').map(f => f.info?.state).filter((s, i, a) => s !== a[i - 1]);
  const states = await AP.evaluate(() => [...new Set(window.__n17)]), chunks = acpEvs(AP, id, 'update', v0!.seq).filter(e => e.update?.sessionUpdate === 'agent_message_chunk').length, noSeen = acpSent(AP, id, 'seen').length === seen0;
  check('N17: "stream" renders its chunks in one .ag-asst item, and the turn goes running → done while the card is not looked at', !!done && done.asst === v0!.asst + 1 && chunks >= 2 && infos.indexOf('running') >= 0 && infos.indexOf('running') < infos.lastIndexOf('done') && states.includes('badge st-done') && noSeen, JSON.stringify({ infos, states, asst: [v0!.asst, done?.asst], chunks, noSeen }));
  const treeOf = () => AP.evaluate((id: string) => document.querySelector(`#tp-list .tp-row[data-id="${id}"] .tp-mt`)?.textContent ?? null, id);
  const tree = await until(async () => { const t = await treeOf(); return /· done/.test(t || '') ? t : null; }, 3000);
  check('N17: the Folders tree row shows the card\'s state as it changes (30 §1.6)', !!tree, JSON.stringify({ tree: await treeOf() }));
  await AP.evaluate((id: string) => window.__canvas.jumpNode(window.__canvas.S.nodes[id]), id);
  const idle = await until(async () => { const v = await acpView(AP, id); return v!.st === 'idle' ? v : null; }, 10000);
  const sent = acpSent(AP, id, 'seen');
  check('N17: once the card is active in a visible, focused page, seen goes with the head seq and the state becomes idle', !!idle && sent.length === seen0 + 1 && sent.at(-1)!.seq === done?.seq, JSON.stringify({ sent, st: idle?.st, head: done?.seq }));
  await AP.evaluate((nb: string) => window.__canvas.removeNode(nb), nb);
});
