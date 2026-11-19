import { check, state, until } from '../shared.mts';
import { acpEvs, acpSay, acpView, stubSection } from '../acp.mts';

await stubSection('N18', async () => {
  const { AP, AID } = state;
  const id = AID, s0 = (await acpView(AP, id))!.seq;
  await acpSay(AP, id, 'tool');
  // The card can read idle between the prompt's echo and the turn's info: idle counts once turn_end is folded.
  const v = await until(async () => { const v = await acpView(AP, id), end = acpEvs(AP, id, 'turn_end', s0)[0]; return end && v?.promptable && v.seq >= end.seq ? v : null; }, 20000);
  const sts = acpEvs(AP, id, 'update', s0).map(e => e.update).filter(u => /^tool_call/.test(u?.sessionUpdate || '')).map(u => u.status || (u.sessionUpdate === 'tool_call' ? 'pending' : '')).filter((x, i, a) => x && x !== a[i - 1]);
  const st = await AP.evaluate((id: string) => { const t = [...window.__canvas.live[id].body.querySelectorAll('.ag-log .ag-tool')].at(-1); return t && { status: t.dataset.status, glyph: t.querySelector('.tg').textContent, add: t.querySelectorAll('.ag-diff .add').length, del: t.querySelectorAll('.ag-diff .del').length }; }, id);
  check('N18: "tool" goes pending → in_progress → completed and its diff has .add and .del rows', !!v && sts.join() === 'pending,in_progress,completed' && st?.status === 'completed' && st.glyph === '✓' && st.add > 0 && st.del > 0, JSON.stringify({ sts, st }));
});
