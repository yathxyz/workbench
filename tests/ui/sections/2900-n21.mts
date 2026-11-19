import { check, state, until } from '../shared.mts';
import { acpClick, acpEvs, acpIdle, acpSay, acpSent, acpView, stubSection } from '../acp.mts';

await stubSection('N21', async () => {
  const { AP, AID } = state;
  const id = AID, s0 = (await acpView(AP, id))!.seq;
  await AP.evaluate(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; }; });   // no real tab
  await acpSay(AP, id, 'url');
  const ev = await until(() => acpEvs(AP, id, 'elicitation', s0)[0], 15000);
  await until(async () => (await acpView(AP, id))!.url === 1, 5000);
  const href = String(ev?.request?.url || '');
  const st = await AP.evaluate((id: string) => {
    const C = window.__canvas, d = C.live[id].body.querySelector('.ag-url'), o = d.querySelector('button.open');
    const js = C.AcpBackend.prototype.elicitPanel.call({ answerElicitation() {} }, 1, { request: { mode: 'url', url: 'javascript:alert(1)', message: 'm', elicitationId: 'x' } });
    return { off: o.disabled, host: d.querySelector('code b')?.textContent ?? null, links: d.querySelectorAll('a').length, jsOff: js.querySelector('button.open').disabled };
  }, id);
  if (!st.off) await acpClick(AP, id, '.ag-url button.open');
  const opened = await AP.evaluate(() => window.__opened);
  const waiting = await until(async () => (await acpView(AP, id))!.items.some(x => /waiting/.test(x)), 5000);
  const complete = await until(() => acpEvs(AP, id, 'elicitation_complete', s0)[0], 15000);
  const shown = await until(async () => (await acpView(AP, id))!.items.some(x => /completed/.test(x)), 5000);
  const u = href.startsWith('https:') ? new URL(href) : null;
  check('N21: Open is disabled for a javascript: URL; for https: it shows the host, opens with noopener, sends accept, and the log waits until elicitation/complete',
    st.jsOff && !!u && !st.off && st.host === u.host && st.links === 0 && opened.length === 1 && opened[0][0] === u.href && /noopener/.test(opened[0][2]!) && acpSent(AP, id, 'elicitation').some(m => m.response?.action === 'accept') && waiting && !!complete && shown, JSON.stringify({ href, st, opened, waiting, complete: !!complete, shown }));
  await acpIdle(AP, id);
});
