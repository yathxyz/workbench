import { check, sleep, state, until } from '../shared.mts';
import { settled } from '../daemon.mts';
import { acpClick, acpEvs, acpIdle, acpSay, acpView, gatedPage, toastOf, stubSection } from '../acp.mts';

await stubSection('N29', async () => {
  const { AP, AID } = state;
  const id = AID; await acpIdle(AP, id); await settled(AP);
  const { P: S2, g } = await gatedPage();
  try {
    await until(async () => (await acpView(S2, id))?.promptable, 20000);
    await acpSay(AP, id, 'perm');
    await until(async () => (await acpView(S2, id))!.perm === 1 && (await acpView(AP, id))!.perm === 1, 15000);
    const old = (await acpView(S2, id))!.epoch;
    // The stale tab loses its socket and stays off while the other tab starts a new session; /rpc's `gone` would tell
    // it first (ROB-19), so it is held back here and the answer reaches the hub's epoch check.
    g.rpcDrop = m => m.t === 'gone' && m.sid === id;
    g.refuse = true; g.kick();
    await until(() => S2.evaluate((id: string) => window.__canvas.live[id].el.classList.contains('net-wait'), id), 5000);
    const t1 = Date.now();
    await AP.evaluate((id: string) => { const C = window.__canvas; C.jumpNode(C.S.nodes[id]); C.CMDS.find((c: PaletteItem) => c.l.startsWith('Agent: start a new session')).run(); }, id);
    const fresh = await until(async () => { const v = await acpView(AP, id); return v!.promptable && v!.epoch !== old ? v : null; }, 30000);
    const opensOf = () => g.sent.filter(m => m?.t === 'open' && m.id === id).length, opens = opensOf();
    g.hold = true; g.refuse = false;   // it reconnects, but hears nothing before it answers the old request
    await until(() => opensOf() > opens, 40000);
    const clicked = await acpClick(S2, id, '.ag-perm button[data-kind="allow_once"]');
    await until(() => g.sent.some(m => m?.t === 'permission'), 5000); await sleep(800); g.release();
    const toast = await until(async () => /belongs to an ended session/.test(await toastOf(S2)), 10000);
    await sleep(1000);
    const got = acpEvs(AP, id, null, 0, t1).filter(e => /^permission/.test(e.e));
    check('N29: a stale tab that answers a permission after Start new session in another tab toasts "this request belongs to an ended session", and the new session gets nothing',
      !!fresh && clicked && g.sent.find(m => m?.t === 'permission')?.epoch === old && g.recv.some(m => m?.t === 'error' && m.code === 'stale') && toast && !got.length, JSON.stringify({ fresh: !!fresh, clicked, sent: g.sent.find(m => m?.t === 'permission') ?? null, errors: g.recv.filter(m => m?.t === 'error'), toast: await toastOf(S2), got }));
  } finally { await S2.close(); }
});
