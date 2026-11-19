import type { Page } from 'playwright-core';
import { check, until } from './shared.mts';

export async function focusFlights(p: Page, shell: string) {
  const paper = await p.context().newPage();
  let src: string;
  try {
    await paper.setContent('<p>First page</p><p style="break-before:page">The focus flight quote</p>');
    src = 'data:application/pdf;base64,' + (await paper.pdf()).toString('base64');
  } finally { await paper.close(); }
  await p.bringToFront();
  const id = await p.evaluate(src => window.__canvas.addNode({ kind: 'pdf', name: 'n50-paper', src, in: null, x: 18000, y: 14000, w: 510, h: 320 }).id, src);
  try {
    await p.evaluate(async id => { const C = window.__canvas; await C.live[id].pdf.load; }, id);
    await p.evaluate(id => { const C = window.__canvas; C.jumpRef({ text: 'focus flight quote', src: { node: id, page: 1 } }); C.focusOpen(C.S.nodes[id]); }, id);
    const found = await until(() => p.evaluate(id => { const C = window.__canvas; return C.FOCUS.cur === id && C.pdfWhere(C.S.nodes[id]).page === 2 && document.activeElement === C.live[id].pdf.scroll; }, id), 5000);
    check('N50: opening the source PDF in focus before the quote flight lands finds the text on its new page and focuses the reader', found);

    const stolen = await p.evaluate(async ({ id, shell }) => {
      const C = window.__canvas; C.focusHide(); let calls = 0;
      C.jumpNode(C.S.nodes[shell], 1, () => { calls++; C.typeInto(C.S.nodes[shell]); });
      C.activate(id); C.focusOpen(C.S.nodes[id]); C.live[id].pdf.scroll.focus();
      await new Promise(r => setTimeout(r, C.MOTION.slow));
      return { calls, reader: document.activeElement === C.live[id].pdf.scroll };
    }, { id, shell });
    check('N50: an interrupted flight to another card cannot run its keyboard-focus callback', !stolen.calls && stolen.reader, JSON.stringify(stolen));

    const back = await p.evaluate(async ({ id, shell }) => {
      const C = window.__canvas; C.focusHide();
      const land = (id: string) => new Promise<void>(done => C.jumpNode(C.S.nodes[id], 1, done));
      const rect = () => C.live[shell].el.getBoundingClientRect().toJSON();
      await land(shell); const before = rect(); await land(id); const away = rect();
      C.CMDS.find((c: PaletteItem) => c.l === 'Back to the previous view').run(); C.focusOpen(C.S.nodes[id]); C.focusHide();
      return { before, away, after: rect() };
    }, { id, shell });
    check('N50: interrupting Back with a focus tab returns to the destination when the tab is hidden', back.away.x !== back.before.x && back.after.x === back.before.x && back.after.y === back.before.y && back.after.width === back.before.width, JSON.stringify(back));

    const addrs = await p.evaluate(id => { const C = window.__canvas; return [C.addrOf(C.S.nodes[id]), C.addrOf(C.wsTop()[0]), 'board:/']; }, id);
    const geometry = () => p.evaluate(id => { const C = window.__canvas; const r = C.live[id].el.getBoundingClientRect(); return { world: document.getElementById('world')!.style.transform, w: r.width, h: r.height, focus: C.FOCUS.cur }; }, id);
    for (const target of addrs) {
      await p.evaluate(target => { const C = window.__canvas; C.focusHide(); C.goAddr(target, false); }, target);
      await until(() => p.evaluate(() => !window.__canvas.LOD.busy()));
      const expected = await geometry();
      await p.evaluate(async ({ target, id, shell }) => {
        const C = window.__canvas; C.goAddr(target); C.goAddr(C.addrOf(C.S.nodes[shell])); C.focusOpen(C.S.nodes[id]);
        await new Promise(r => setTimeout(r, 0)); // the address writer has released hashchange
      }, { target, id, shell });
      await p.goBack();
      const landed = await until(() => p.evaluate(target => decodeURIComponent(location.hash.slice(1)) === target && !window.__canvas.LOD.busy(), target));
      const actual = await geometry();
      check(`N50: browser Back from focus restores canvas geometry before navigating to ${target}`, landed && !actual.focus && actual.world === expected.world && actual.w === expected.w && actual.h === expected.h, JSON.stringify({ expected, actual }));
    }
  } finally { await p.evaluate(id => { const C = window.__canvas; C.focusClose(id); C.removeNode(id); }, id); }
}
