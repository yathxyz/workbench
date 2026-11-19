import { check, section } from '../shared.mts';
import { ORIGIN, ctx, dpage, settled } from '../daemon.mts';
import { type TailPage } from '../acp.mts';

// N75 (F-A42): Copy as PNG / Copy as SVG of a sketch card's ink and of selected strokes, for Krita and other programs.
await section('N75', async () => {
  let D: TailPage | undefined;
  try {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
    D = await dpage(); await settled(D);
    const st = await D.evaluate(async () => {
      const C = window.__canvas, S = C.S, out: Record<string, any> = {}; // any: each step's findings, read by the checks below
      if (C.WS.cur) C.wsLeave(); if (C.DESK.cur) C.deskGo(0, true); C.pickClear();
      const n = C.newSketch(); C.setTool('select');
      S.strokes.push({ id: 'n70a', color: 'red', size: 8, sim: true, owner: n.id, pts: [[20, 40, .5], [80, 70, .5], [160, 50, .5]] }, { id: 'n70b', color: 'ink', size: 6, sim: true, owner: n.id, pts: [[30, 120, .5], [140, 140, .5]] });
      C.renderInk(n.id);
      const svg = C.sketchSvg(C.sketchInk(n)), doc = new DOMParser().parseFromString(svg, 'image/svg+xml'), root = doc.documentElement;
      out.svg = { paths: doc.querySelectorAll('path').length, fills: [...doc.querySelectorAll('path')].map(p => p.getAttribute('fill')), w: +root.getAttribute('width')!, h: +root.getAttribute('height')!, vb: root.getAttribute('viewBox'), ns: root.namespaceURI, err: !!doc.querySelector('parsererror') };
      const png = await C.sketchPng(C.sketchInk(n)), bmp = await createImageBitmap(png), cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
      const g = cv.getContext('2d')!; g.drawImage(bmp, 0, 0); const px = g.getImageData(0, 0, cv.width, cv.height).data;
      let inked = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 0) inked++;
      out.png = { type: png.type, w: bmp.width, h: bmp.height, corner: px[3], inked };
      // only the selected stroke when strokes are selected
      C.SEL.strokes.add('n70b'); C.pickChip(); out.sel = C.sketchInk(null).map((s: Stroke) => s.id); out.chip = !(document.querySelector('#pick-chip [data-act=svg]') as HTMLElement).hidden || null;
      C.pickClear(); out.chipOff = (document.querySelector('#pick-chip [data-act=svg]') as HTMLElement).hidden;
      // the header buttons copy: SVG lands on the clipboard (as image/svg+xml where Chromium writes it, else as text)
      out.btns = [...C.live[n.id].hdr.querySelectorAll('.hb')].map((b: Element) => b.textContent);
      await C.sketchCopy('svg', n);
      try { const items = await navigator.clipboard.read(); out.clip = await Promise.all(items[0].types.map(async t => [t, (await (await items[0].getType(t)).text()).slice(0, 60)])); } catch (e) { out.clip = String(e); }
      await C.sketchCopy('png', n);
      try { const items = await navigator.clipboard.read(); out.clipPng = items[0].types; } catch (e) { out.clipPng = String(e); }
      out.made = [n.id];
      return out;
    });
    check('N75: a sketch card\'s ink copies as SVG: one filled path per stroke in the light theme\'s ink colours, cut to the ink with a margin; and as PNG at twice the size with a transparent ground',
      !st.svg.err && st.svg.ns === 'http://www.w3.org/2000/svg' && st.svg.paths === 2 && st.svg.fills.join() === '#a60000,#000000' && st.svg.w > 140 && st.svg.w < 200 && st.svg.vb === `0 0 ${st.svg.w} ${st.svg.h}`
      && st.png.type === 'image/png' && Math.abs(st.png.w - 2 * st.svg.w) <= 1 && st.png.corner === 0 && st.png.inked > 200, JSON.stringify({ svg: st.svg, png: st.png }));
    check('N75: with strokes selected the copy is theirs only, and the selection chip offers PNG and SVG; the sketch header has PNG and SVG; both reach the system clipboard',
      st.sel.join() === 'n70b' && st.chip && st.chipOff && st.btns.includes('PNG') && st.btns.includes('SVG') && Array.isArray(st.clip) && st.clip.some((c: string[]) => /^<svg/.test(c[1])) && Array.isArray(st.clipPng) && st.clipPng.includes('image/png'),
      JSON.stringify({ sel: st.sel, chip: st.chip, chipOff: st.chipOff, btns: st.btns, clip: st.clip, clipPng: st.clipPng }));
    await D.evaluate((ids: string[]) => { for (const id of ids) if (window.__canvas.S.nodes[id]) window.__canvas.removeNode(id); window.__canvas.pickClear(); }, st.made);
    await settled(D);
  } finally { await D?.close(); await ctx.clearPermissions(); }
});
