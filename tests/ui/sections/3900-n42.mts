import { check, state, until } from '../shared.mts';
import { settled, webRestart } from '../daemon.mts';
import { acpIdle, acpShow, acpView, gatedPage, stubSection } from '../acp.mts';

await stubSection('N42', async () => {
  const { AP, AID } = state;
  const id = AID; await acpIdle(AP, id); await settled(AP);
  const { P: D, g } = await gatedPage();
  try {
    await until(async () => (await acpView(D, id))?.promptable, 20000);
    g.drop = m => m?.t === 'prompt';   // the prompt never arrives, so there is no echo
    const ta = `.node[data-id="${id}"] .ag-in textarea`, TEXT = 'n42 draft survives a restart';
    await acpShow(D, id); await D.fill(ta, TEXT); await D.press(ta, 'Enter');
    const pending = await until(async () => { const v = await acpView(D, id); return v!.ro && v!.go === 'Sending…' ? v : null; }, 5000);
    await webRestart();
    const back = await until(async () => { const v = await acpView(D, id); return v?.promptable ? v : null; }, 30000);
    check('N42: a prompt typed before a wb-web restart, with no echo, is still in the composer after the reconnect',
      !!pending && !!back && back.ta === TEXT && !back.ro && back.go === 'Send' && g.sent.filter(m => m?.t === 'open').length >= 2, JSON.stringify({ pending: !!pending, back: back && { ta: back.ta, ro: back.ro, go: back.go } }));
  } finally { await D.close(); }
});
