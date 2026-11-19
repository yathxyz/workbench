import { check, state, until, watchErrors } from '../shared.mts';
import { ctx, ORIGIN } from '../daemon.mts';
import { acpIdle, acpSay, acpView, stubSection } from '../acp.mts';

// N34 (F-A12): the page is made hidden and given notifications and a service worker that record their calls, since the
// suite's context blocks service workers. The open path of a notification's click is /?focus=SID.
await stubSection('N34', async () => {
  const { AP, AID } = state;
  const id = AID; await acpIdle(AP, id);
  await AP.evaluate(() => {
    const w = window as unknown as Record<string, unknown>; const calls: { title: string; tag?: string }[] = []; w.__n34 = calls;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(window, 'Notification', { configurable: true, writable: true, value: { permission: 'granted', requestPermission: async () => 'granted' } });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve({ showNotification: (title: string, o: NotificationOptions) => { calls.push({ title, tag: o.tag }); return Promise.resolve(); } }), addEventListener() {} } });
  });
  await acpSay(AP, id, 'perm');
  await until(async () => (await acpView(AP, id))!.st === 'waiting_permission', 15000);
  const sig = await until(() => AP.evaluate(() => { const c = (window as unknown as { __n34: { tag?: string }[] }).__n34; return document.title.startsWith('(1) ') && c.length ? { title: document.title, calls: c } : null; }), 5000);
  check('N34: a hidden page whose card turns waiting_permission titles itself (1) and shows a notification tagged with the sid', !!sig && sig.calls.length === 1 && sig.calls[0].tag === id, JSON.stringify(sig || await AP.evaluate(() => document.title)));
  await AP.evaluate(() => { delete (document as unknown as Record<string, unknown>).hidden; delete (document as unknown as Record<string, unknown>).visibilityState; delete (navigator as unknown as Record<string, unknown>).serviceWorker; document.dispatchEvent(new Event('visibilitychange')); });
  const back = await AP.evaluate(() => ({ title: document.title, unseen: window.__canvas.ATTN_SIG.unseen.size }));
  const P = await ctx.newPage(); watchErrors(P);
  try {
    await P.goto(ORIGIN + '/?focus=' + encodeURIComponent(id)); await until(() => P.evaluate(() => window.__canvas?.BOOTED));
    const opened = await until(() => P.evaluate((id: string) => window.__canvas.FOCUS.cur === id && document.body.classList.contains('focus') ? { search: location.search } : null, id), 8000);
    check('N34: the page is seen again when visible (no title count), and /?focus=SID (a notification click with no open page) opens the card full screen and drops the query', !back.title.startsWith('(') && back.unseen === 0 && !!opened && opened.search === '', JSON.stringify({ back, opened }));
  } finally { await P.close(); }
});
