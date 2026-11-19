import { check, sleep, state, until } from '../shared.mts';
import { dpage } from '../daemon.mts';
import { acpView, stubSection } from '../acp.mts';

// N35 (F-A13): with the permission from N34 still pending.
await stubSection('N35', async () => {
  const { AP, AID } = state;
  const id = AID, P = await dpage();
  try {
    await P.setViewportSize({ width: 390, height: 844 }); await sleep(400);
    await until(() => P.evaluate((id: string) => window.__canvas.attnItems().some((i: RgEntry) => i.key === id && i.attn === 'bad'), id), 10000);
    await P.evaluate(() => { const C = window.__canvas; document.body.classList.remove('side-open'); C.setView('ranger'); C.rgGo('attn:'); });   // on a phone the side pane is the whole width
    const row = `#rg-cur .rg-row[data-key="${id}"]`; await P.waitForSelector(row, { timeout: 5000 });
    await P.click(row);
    const full = await until(() => P.evaluate((id: string) => window.__canvas.MODE.v === 'phone' && window.__canvas.FOCUS.cur === id && document.body.classList.contains('focus'), id), 5000);
    await P.click(`.node[data-id="${id}"] .ag-perm button[data-kind="allow_once"]`, { timeout: 5000 });
    const done = await until(async () => (await acpView(AP, id))!.perm === 0, 10000);
    check('N35: on a 390×844 phone one tap on the Attention item opens the card full screen, and its permission button takes the click', !!full && !!done, JSON.stringify({ full, done, view: await acpView(AP, id) }));
  } finally { await P.close(); }
});
