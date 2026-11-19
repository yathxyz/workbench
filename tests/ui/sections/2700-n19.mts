import { check, sleep, state, until } from '../shared.mts';
import { settled } from '../daemon.mts';
import { acpClick, acpEvs, acpIdle, acpSay, acpView, gatedPage, toastOf, stubSection } from '../acp.mts';

await stubSection('N19', async () => {
  const { AP, AID } = state;
  const id = AID; await settled(AP);
  const { P: B, g } = await gatedPage();
  try {
    await until(async () => (await acpView(B, id))?.promptable, 20000);
    const s0 = (await acpView(AP, id))!.seq;
    await acpSay(AP, id, 'perm');
    const both = await until(async () => (await acpView(AP, id))!.perm === 1 && (await acpView(B, id))!.perm === 1, 15000);
    const btns = await AP.evaluate((id: string) => [...window.__canvas.live[id].body.querySelectorAll('.ag-perm button')].map(b => b.dataset.kind + '|' + b.textContent), id);
    g.hold = true;   // B hears nothing more until its own click went out
    await acpClick(AP, id, '.ag-perm button[data-kind="allow_once"]');
    const goneA = await until(async () => (await acpView(AP, id))!.perm === 0, 10000), res = await until(() => acpEvs(AP, id, 'permission_resolved', s0)[0], 5000);
    const stillB = (await acpView(B, id))!.perm === 1;
    await acpClick(B, id, '.ag-perm button[data-kind="allow_once"]');
    await until(() => g.sent.some(m => m?.t === 'permission'), 5000); await sleep(500); g.release();
    const goneB = await until(async () => (await acpView(B, id))!.perm === 0, 10000), late = await until(async () => /already answered/.test(await toastOf(B)), 5000);
    check('N19: a permission shows in both pages; allow in one clears the other, whose late click toasts already answered', both && goneA && res?.by === 'user' && stillB && goneB && late && g.recv.some(m => m?.t === 'error' && m.code === 'already_resolved'), JSON.stringify({ both, goneA, res, stillB, goneB, late, toast: await toastOf(B) }));
    check('N19: the allow_always button says the agent remembers it', btns.some(x => /^allow_always\|.+ · remembered by /.test(x)), btns.join(' / '));
    await acpIdle(AP, id);
  } finally { await B.close(); }
});
