import { check, section, sleep, until, watchErrors } from '../shared.mts';
import { ORIGIN, ctx, palLabels, ptyOf, record, settled } from '../daemon.mts';

// DELTA-1 §B.6: the new-terminal action offers /api/info.shells; the next one defaults to the last pick. The page is
// given a second shell when the server offers fewer than two, since the picker only opens for a choice.
await section('§B.6', async () => {
  const P = await ctx.newPage(); watchErrors(P); record(P);
  await P.route('**/api/info', r => r.fetch().then(async res => {
    const info = await res.json(); if (!(info.shells?.length >= 2)) Object.assign(info, { shells: ['bash', 'sh'], defaultShell: info.defaultShell || 'bash' });
    await r.fulfill({ response: res, json: info });
  }).catch(() => {}));
  try {
    await P.goto(ORIGIN + '/'); await until(() => P.evaluate(() => window.__canvas?.BOOTED));
    await P.evaluate(() => localStorage.removeItem('wb-shell'));
    const ids = () => P.evaluate(() => Object.values<BoardNode>(window.__canvas.S.nodes).filter(n => n.kind === 'term').map(n => n.id));
    const newShell = async () => { if (!await P.isVisible('#add-shell')) await P.click('#toggle-new', { timeout: 5000 }); await P.click('#add-shell', { timeout: 5000 }); await sleep(300); return palLabels(P); };
    const before = await ids(), listed = await newShell();
    const info = await P.evaluate(() => ({ shells: window.__canvas.INFO.shells, def: window.__canvas.INFO.defaultShell }));
    const pick = info.shells.find((s: string) => s !== info.def);
    await P.click(`#pal-list .pi:has(.l:text-is("${pick}"))`, { timeout: 5000 }); await sleep(500);
    const first = (await ids()).find(id => !before.includes(id));
    const one = await P.evaluate(id => ({ shell: window.__canvas.S.nodes[id]?.shell, badge: document.querySelector(`.node[data-id="${id}"] .hdr .badge`)?.textContent }), first!);
    const listed2 = await newShell();
    await P.keyboard.press('Enter'); await sleep(500);
    const second = (await ids()).find(id => !before.includes(id) && id !== first);
    const two = await P.evaluate(id => window.__canvas.S.nodes[id]?.shell, second!);
    check('§B.6: the picker lists /api/info.shells; the card keeps and shows the shell; the next terminal defaults to the last pick',
      [...listed].sort().join() === [...info.shells].sort().join() && listed[0] === info.def && one.shell === pick && one.badge?.includes(pick) && listed2[0] === pick && two === pick, JSON.stringify({ listed, info, one, listed2, two }));
    const sent = (id?: string) => ptyOf(P, id).some(w => w.open?.spawn === true && w.open?.shell === pick);
    await until(() => sent(first) && sent(second), 5000);
    check('§B.6: both terminals\' /pty opens spawn with the picked shell', sent(first) && sent(second), JSON.stringify([first, second].map(id => ptyOf(P, id).map(w => w.open))));
    await P.evaluate(ids => ids.forEach(id => window.__canvas.removeNode(id)), [first, second].filter(Boolean));
    await settled(P);
  } finally { await P.close(); }
});
