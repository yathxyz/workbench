import { check, section, sleep, state, until, watchErrors } from '../shared.mts';
import { ORIGIN, barOf, boardFile, dpage, moveCard, settled } from '../daemon.mts';
import { type TailPage } from '../acp.mts';

const { browser } = state;

// N51: the view is per device (F-A22). The entered workspace, the focus tabs and the perspective stay out of the board
// file; a perspective saves the manual layout; a device inside a perspective takes another device's move and keeps it.
await section('N51', async () => {
  const ctx2 = await browser.newContext({ viewport: { width: 1500, height: 950 }, serviceWorkers: 'block' });
  const devB = async () => { const p = await ctx2.newPage(); watchErrors(p); await p.goto(ORIGIN + '/'); await until(() => p.evaluate(() => window.__canvas?.BOOTED)); return p; };
  const viewOf = (p: TailPage) => p.evaluate(() => { const C = window.__canvas; return { ws: C.WS.cur, tabs: [...C.FOCUS.tabs], persp: C.S.persp || 'manual', derived: Object.values<BoardNode & { derived?: FrameDerived }>(C.S.nodes).filter(n => n.derived || n.kind === 'ghost').length }; });
  const VK = ['ws', 'focusTabs', 'persp', 'manual'];
  let B: TailPage | undefined, D: TailPage | undefined;
  try {
    D = await dpage(); await settled(D);
    const mine = await D.evaluate(() => { const C = window.__canvas, S = C.S; C.perspSet('manual', true); C.focusHide();
      const f = C.wsTop()[0], n = Object.values<BoardNode>(S.nodes).find(n => n.kind === 'buffer' && !C.stashed(n));
      C.wsEnter(f, true); const rect = [n!.x, n!.y, n!.w, n!.h]; C.focusOpen(n); C.dirty(); return { f: f.id, n: n!.id, rect }; });
    await sleep(800); await settled(D);
    let disk = boardFile()!;
    const shown = await D.evaluate((id: string) => { const C = window.__canvas, n = C.S.nodes[id], r = [n.x, n.y, n.w, n.h]; C.focusHide(); return { cur: id, r }; }, mine.n);
    const dn = disk.nodes[mine.n];
    check('N51: a card shown in a focus tab is saved at its place on the canvas, not at the size of the screen',
      JSON.stringify([dn.x, dn.y, dn.w, dn.h]) === JSON.stringify(mine.rect) && shown.r[2] !== mine.rect[2], JSON.stringify({ disk: [dn.x, dn.y, dn.w, dn.h], mine, shown }));
    await sleep(600); await settled(D); disk = boardFile()!;
    B = await devB();
    const b1 = await viewOf(B);
    await D.reload(); await until(() => D!.evaluate(() => window.__canvas?.BOOTED)); await sleep(500);
    const a1 = await viewOf(D);
    check('N51: workspace and focus tabs stay on the device: not in the board file, not on another device, back after a reload',
      VK.every(k => !(k in disk)) && b1.ws === null && !b1.tabs.length && a1.ws === mine.f && a1.tabs.includes(mine.n), JSON.stringify({ keys: VK.filter(k => k in disk), b1, a1, mine }));
    const before = await D.evaluate(() => { const C = window.__canvas, S = C.S; C.wsLeave(); C.focusClose(C.FOCUS.tabs[0]);
      const n = Object.values<BoardNode>(S.nodes).find(n => n.kind === 'buffer'); C.setTags(n, ['n51']);
      const pos = Object.fromEntries(Object.values<BoardNode>(S.nodes).map(n => [n.id, [n.in || null, n.x, n.y, n.w, n.h, n.order ?? null]]));
      C.perspSet('tag', true); return pos; });
    await sleep(800); await settled(D);
    disk = boardFile()!;
    const same = Object.entries(before).every(([id, v]) => disk.nodes[id] && JSON.stringify([disk.nodes[id].in || null, disk.nodes[id].x, disk.nodes[id].y, disk.nodes[id].w, disk.nodes[id].h, disk.nodes[id].order ?? null]) === JSON.stringify(v));
    const derivedOnDisk = Object.values<BoardNode & { derived?: FrameDerived }>(disk.nodes).filter(n => n.derived || n.kind === 'ghost').length, a2 = await viewOf(D);
    check('N51: inside a perspective the board file keeps the manual layout and order exactly, and no view key',
      a2.persp === 'tag' && a2.derived > 0 && same && !derivedOnDisk && Object.keys(disk.nodes).length === Object.keys(before).length && VK.every(k => !(k in disk)), JSON.stringify({ a2, same, derivedOnDisk, keys: VK.filter(k => k in disk) }));
    await B.reload(); await until(() => B!.evaluate(() => window.__canvas?.BOOTED));
    const mv = await moveCard(B, 70); await settled(B);
    const took = await until(() => D!.evaluate((m: { id: string; x: number }) => { const C = window.__canvas; return C.BOARD_ETAG && !C.SAVE.paused && C.S.persp === 'tag' && C.S.manual?.pos?.[m.id]?.[0] === m.x; }, mv), 6000);
    const a3 = await viewOf(D), b3 = await viewOf(B), bar = await barOf(D);
    const back = await D.evaluate((id: string) => { const C = window.__canvas; C.perspSet('manual', true); return C.S.nodes[id].x; }, mv.id);
    await D.reload(); await until(() => D!.evaluate(() => window.__canvas?.BOOTED)); await sleep(500);
    const a4 = await viewOf(D);
    check('N51: a device inside a perspective takes another device\'s move without a bar and stays in its perspective; the other device never leaves manual',
      !!took && a3.persp === 'tag' && a3.derived > 0 && bar.hidden && b3.persp === 'manual' && !b3.derived && back === mv.x && a4.persp === 'manual', JSON.stringify({ took, a3, b3, bar, back, mv, a4 }));
    await D.evaluate(() => { const C = window.__canvas, n = Object.values<BoardNode>(C.S.nodes).find(n => (n.tags || []).includes('n51')); if (n) C.setTags(n, ['n51'], { remove: true }); });
    await settled(D);
    for (const [source, remover] of [['local', D], ['remote', B]] as const) {
      const fixture = await D.evaluate(async () => {
        const C = window.__canvas;
        const card = (name: string, x: number) => C.addNode({ kind: 'sketch', name, in: null, x, y: 14500, w: 360, h: 240 });
        const bg = card('n51-background', 13000), fg = card('n51-current', 14600);
        await new Promise<void>(done => C.jumpNode(bg, 1, done));
        const world = document.getElementById('world')!.style.transform;
        C.focusOpen(bg); C.focusOpen(fg); return { bg: bg.id, fg: fg.id, world };
      });
      await settled(D);
      await until(() => remover.evaluate(id => !!window.__canvas.S.nodes[id], fixture.fg));
      if (source === 'remote') {
        const card = D.locator('.node.focused'), before = await card.boundingBox();
        const viewportWidth = await D.locator('#viewport').evaluate(e => e.clientWidth);
        const incoming = await remover.evaluate(id => {
          const C = window.__canvas, n = C.S.nodes[id]; C.moveTree(n, 750, -310); n.w += 95; n.h += 65;
          C.placeAny(n); C.dirty(); return [n.x, n.y, n.w, n.h];
        }, fixture.fg);
        await settled(remover);
        const tag = await remover.evaluate(() => window.__canvas.BOARD_ETAG);
        const adopted = await until(() => D!.evaluate(tag => window.__canvas.BOARD_ETAG === tag, tag));
        let after: typeof before = null;
        const filled = await until(async () => { after = await card.boundingBox(); return JSON.stringify(after) === JSON.stringify(before); }, 2000);
        const back = await D.evaluate(id => {
          const C = window.__canvas, saved = JSON.parse(C.serialize()).nodes[id]; C.focusHide();
          const n = C.S.nodes[id], restored = [n.x, n.y, n.w, n.h]; C.focusOpen(n);
          return { saved: [saved.x, saved.y, saved.w, saved.h], restored };
        }, fixture.fg);
        check('N51: a remote move and resize preserves the foreground viewport and restores the incoming board rectangle',
          adopted && before?.width === viewportWidth && filled &&
          [back.saved, back.restored].every(r => JSON.stringify(r) === JSON.stringify(incoming)), JSON.stringify({ before, after, incoming, back }));
        await settled(D);
      }
      for (const id of [fixture.bg, fixture.fg]) {
        await remover.evaluate(id => window.__canvas.removeNode(id), id);
        await until(() => D!.evaluate(id => !window.__canvas.S.nodes[id], id));
        const view = await D.evaluate(({ id, fg }) => {
          const C = window.__canvas, world = document.getElementById('world')!;
          const before = world.style.transform;
          document.getElementById('viewport')!.dispatchEvent(new WheelEvent('wheel', { deltaY: 32, bubbles: true, cancelable: true }));
          return { cur: C.FOCUS.cur, focused: document.body.classList.contains('focus'), tab: C.FOCUS.tabs.includes(id),
            stored: JSON.parse(localStorage.getItem(C.viewKey())!).focusTabs.includes(id),
            strip: [...document.querySelectorAll('#focus-tabs [role=tab]')].some(e => e.textContent?.includes(id === fg ? 'n51-current' : 'n51-background')),
            before, panned: world.style.transform !== before };
        }, { id, fg: fixture.fg });
        const current = id === fixture.fg;
        check(`N51: ${source} removal closes the ${current ? 'current' : 'background'} focus tab on this device`,
          !view.tab && !view.stored && !view.strip && (current ? !view.cur && !view.focused && view.before === fixture.world && view.panned : view.cur === fixture.fg && view.focused && !view.panned), JSON.stringify(view));
      }
      await D.evaluate(() => window.__canvas.focusHide()); // reset the device even if a close failed
      await settled(remover);
    }
  } finally { await B?.close(); await D?.close(); await ctx2.close(); }
});
