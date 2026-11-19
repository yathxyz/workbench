import { check, state, until } from '../shared.mts';
import { acpEvs, acpSay, acpSent, acpView, stubSection } from '../acp.mts';

await stubSection('N22', async () => {
  const { AP, AID } = state;
  const id = AID, s0 = (await acpView(AP, id))!.seq, c0 = acpSent(AP, id, 'cancel').length;
  await acpSay(AP, id, 'slow');
  await until(async () => (await acpView(AP, id))!.activity === 'turn', 10000);
  await AP.click(`.node[data-id="${id}"] .ag-row .stop`);
  const end = await until(() => acpEvs(AP, id, 'turn_end', s0)[0], 15000), v = await until(async () => { const v = await acpView(AP, id); return v!.st === 'idle' ? v : null; }, 10000);
  check('N22: Stop sends cancel; the turn ends cancelled and the card is idle, not done', acpSent(AP, id, 'cancel').length === c0 + 1 && end?.stopReason === 'cancelled' && !!v, JSON.stringify({ cancels: acpSent(AP, id, 'cancel').length - c0, end, st: v?.st }));
  const m0 = await acpView(AP, id), other = m0!.modes.find(m => m !== m0!.mode);
  if (other != null) await AP.selectOption(`.node[data-id="${id}"] .ag-mode`, other);
  const follow = await until(async () => { const v = await acpView(AP, id); return acpEvs<'mode' | 'update'>(AP, id, null, m0!.seq).some(e => e.e === 'mode' || e.update?.sessionUpdate === 'current_mode_update') && v!.mode === other ? v : null; }, 10000);
  check('N22: the mode select (two modes) sends set_mode and follows the mode the agent reports', m0!.modes.length === 2 && other != null && acpSent(AP, id, 'set_mode').some(m => m.modeId === other) && !!follow, JSON.stringify({ modes: m0!.modes, mode: m0!.mode, other, sent: acpSent(AP, id, 'set_mode'), now: follow?.mode }));
});
