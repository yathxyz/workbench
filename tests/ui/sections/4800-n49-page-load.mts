import { check, section, sleep, until, watchErrors } from '../shared.mts';
import { ORIGIN, REQ, ctx, record, status } from '../daemon.mts';

// N49: a server without a model says nothing about one at load, and no boot request is refused.
await section('N49', async () => {
  const since = Date.now(), P = await ctx.newPage(); watchErrors(P); record(P);
  await P.addInitScript(() => { window.__toasts = []; new MutationObserver(() => { const t = document.querySelector('#toast'); if (t?.classList.contains('show') && window.__toasts.at(-1) !== t.textContent) window.__toasts.push(t.textContent!); }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true, characterData: true }); });
  try {
    await P.goto(ORIGIN + '/'); await until(() => P.evaluate(() => window.__canvas?.BOOTED)); await sleep(2500);
    const toasts = await P.evaluate(() => window.__toasts), sample = await P.evaluate(() => window.__canvas.INFO.sample);
    const refused: string[] = []; for (const e of REQ.filter(e => e.t >= since && e.url.startsWith(ORIGIN + '/api/'))) if (await status(e) as number >= 400) refused.push(e.url);
    check('N49: with /api/info.sample false the load shows no toast about a model or an API key, and no /api request of the load is refused', sample === false && !toasts.some(t => /claude|anthropic|api.?key|model/i.test(t)) && !refused.length, JSON.stringify({ sample, toasts, refused }));
  } finally { await P.close(); }
});
