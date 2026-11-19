import { check, section, until } from '../shared.mts';
import { api, dpage, pageText, settled } from '../daemon.mts';
import { type TailPage } from '../acp.mts';

// N63 (F-A32): images and the clipboard on the board. A PNG pasted on the board is an image card whose bytes went to
// /api/blob (the board keeps the hash); an SVG is redrawn as a PNG; a dropped file lands where it is dropped; a paste
// into a text field is the field's; Ctrl-C on a card puts the board's items and text on the clipboard and a paste of
// them is a new card on the same bytes; text pastes as a label, a web card or a page; cut takes the item away.
await section('N63', async () => {
  let D: TailPage | undefined;
  try {
    D = await dpage(); await settled(D);
    const st = await D.evaluate(async () => {
      const C = window.__canvas, S = C.S, out: Record<string, any> = {}; // any: each step's findings, read by the checks below
      if (C.WS.cur) C.wsLeave(); if (C.DESK.cur) C.deskGo(0, true); C.pickClear(); (document.activeElement as HTMLElement | null)?.blur?.();
      const png = (w: number, h: number) => new Promise<File>(r => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g!.fillStyle = '#c03'; g!.fillRect(0, 0, w, h); c.toBlob(b => r(new File([b!], 'red.png', { type: 'image/png' })), 'image/png'); });
      const paste = (dt: DataTransfer, target: HTMLElement = document.body) => { const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); target.dispatchEvent(e); return e.defaultPrevented; };
      const images = () => Object.values<BoardNode>(S.nodes).filter(n => n.kind === 'image');
      const until = async <T,>(f: () => T) => { for (let i = 0; i < 100; i++) { const v = f(); if (v) return v; await new Promise(r => setTimeout(r, 100)); } return null; };
      const before = new Set(images().map(n => n.id)), fresh = () => images().filter(n => !before.has(n.id));
      // Ctrl-V on the board is a keymap row that leaves the key to the browser
      const kd = new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true }); document.body.dispatchEvent(kd);
      out.keyKept = !kd.defaultPrevented && window.WBKeys.resolve(C.keyContext(), 'C-v')[0]?.cmd === 'clip.paste';
      // a paste into a text field is the field's
      const inp = document.createElement('input'); document.body.append(inp); inp.focus();
      let dt = new DataTransfer(); dt.items.add(await png(40, 30));
      out.fieldTook = paste(dt, inp); inp.remove(); (document.activeElement as HTMLElement | null)?.blur?.();
      await new Promise(r => setTimeout(r, 300)); out.fieldMade = fresh().length;
      // on the board: an image card from the bytes' hash
      dt = new DataTransfer(); dt.items.add(await png(40, 30));
      out.boardTook = paste(dt);
      const a = await until(() => fresh()[0]);
      out.a = a && { blob: a.blob, iw: a.iw, ih: a.ih, src: 'src' in a, mime: a.mime, picked: C.PICKED.has(a.id) };
      const img = a && C.live[a.id].img; await until(() => img?.complete && img.naturalWidth);
      out.shown = img && { w: img.naturalWidth, src: img.getAttribute('src') };
      // an SVG becomes a PNG on the way in
      dt = new DataTransfer(); dt.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="blue"/></svg>'], 'pic.svg', { type: 'image/svg+xml' }));
      paste(dt);
      const b = await until(() => fresh().find(n => n.name === 'pic'));
      out.svg = b && { mime: b.mime, iw: b.iw, ih: b.ih };
      // a dropped file lands at the drop point
      const vp = document.querySelector('#viewport')!.getBoundingClientRect(), cx = vp.left + vp.width / 2 + 100, cy = vp.top + vp.height / 2 + 80;
      dt = new DataTransfer(); dt.items.add(await png(50, 50));
      document.querySelector('#viewport')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
      const d = await until(() => fresh().find(n => n.iw === 50));
      const at = C.s2w ? C.s2w(cx - vp.left, cy - vp.top) : null;
      out.drop = d && { mid: [d.x + d.w / 2, d.y + d.h / 2], at: at && [at.x, at.y] };
      // copy the first card, paste it: a second card on the same bytes
      C.pickClear(); C.pickToggle(a!.id, true); (document.activeElement as HTMLElement | null)?.blur?.();
      const cp = new DataTransfer(), ce = new ClipboardEvent('copy', { clipboardData: cp, bubbles: true, cancelable: true }); document.body.dispatchEvent(ce);
      out.copy = { taken: ce.defaultPrevented, items: !!cp.getData('application/x-workbench-items'), text: cp.getData('text/plain') };
      const n0 = images().length; paste(cp);
      const c = await until(() => images().length > n0 && images().find(n => n.id !== a!.id && n.blob === a!.blob && !before.has(n.id) && n.id !== b?.id && n.id !== d?.id));
      out.dup = c && { same: c.blob === a!.blob, other: c.id !== a!.id };
      // the system clipboard after an image copy holds a PNG and the text only: the board recalls the card by the text
      const n1 = images().length; dt = new DataTransfer(); dt.items.add(await png(7, 7)); dt.setData('text/plain', out.copy.text); paste(dt);
      const r = await until(() => images().length > n1 && images().find(n => !before.has(n.id) && ![a!.id, b?.id, d?.id, (c as ImageNode | null)?.id].includes(n.id)));
      out.recall = r && { same: r.blob === a!.blob, iw: r.iw, stored: !!C.clipRecall(out.copy.text) };
      // text: a label, a web card, a page
      const shapes0 = S.shapes.length, nodes0 = Object.keys(S.nodes).length;
      dt = new DataTransfer(); dt.setData('text/plain', 'n62 label'); paste(dt);
      out.label = S.shapes.length === shapes0 + 1 && S.shapes[S.shapes.length - 1].type === 'text' && S.shapes[S.shapes.length - 1].text === 'n62 label';
      const label = S.shapes[S.shapes.length - 1];
      dt = new DataTransfer(); dt.setData('text/plain', 'https://example.org/n62'); paste(dt);
      const web = Object.values<BoardNode>(S.nodes).find(n => n.kind === 'web' && n.url === 'https://example.org/n62');
      dt = new DataTransfer(); dt.setData('text/plain', '# n62 notes\n\nfirst line\nsecond line'); paste(dt);
      const pg = Object.values<BoardNode>(S.nodes).find(n => n.kind === 'buffer' && n.name === 'n62 notes');
      out.text = { web: !!web, page: pg && pg.id, nodes: Object.keys(S.nodes).length - nodes0 };
      // cut the label: gone, and on the clipboard
      C.pickClear(); C.SEL.shapes.add(label.id); (document.activeElement as HTMLElement | null)?.blur?.();
      const ct = new DataTransfer(); document.body.dispatchEvent(new ClipboardEvent('cut', { clipboardData: ct, bubbles: true, cancelable: true }));
      out.cut = { gone: !S.shapes.some((s: Shape) => s.id === label.id), text: ct.getData('text/plain') };
      // an arrow between two copied cards comes along unpicked; a pasted shape leaves the folder it was in (Codex on #17)
      let bound: { copied: boolean; rebound: boolean; loose: boolean } | null = null;
      if (web && pg) {
        const arrow = C.addShape({ type: 'arrow', x1: 0, y1: 0, x2: 0, y2: 0, a: { id: web.id, dx: 0, dy: 0 }, b: { id: pg.id, dx: 0, dy: 0 } });
        const box = C.addShape({ type: 'rect', x: web.x, y: web.y - 80, w: 60, h: 40, in: 'n63-folder' });
        C.pickClear(); C.pickToggle(web.id, true); C.pickToggle(pg.id, true); C.SEL.shapes.add(box.id);
        const got = C.copyItems(), had = new Set(S.shapes.map((x: Shape) => x.id)), nodesHad = new Set(Object.keys(S.nodes));
        C.pasteItems(got.items);
        const newShapes = S.shapes.filter((x: Shape) => !had.has(x.id)), newIds = Object.keys(S.nodes).filter(id => !nodesHad.has(id));
        const a2 = newShapes.find((x: Shape) => x.type === 'arrow'), r2 = newShapes.find((x: Shape) => x.type === 'rect');
        bound = { copied: got.items.shapes.some((x: Shape) => x.id === arrow.id), rebound: !!a2 && newIds.includes(a2.a?.id!) && newIds.includes(a2.b?.id!), loose: !!r2 && !('in' in r2) };
        out.extra = newIds; C.pickClear();
      }
      out.bound = bound;
      out.made = [...fresh().map(n => n.id), web?.id, pg?.id, ...(out.extra || [])].filter(Boolean);
      return out;
    });
    const pageOk = st.text.page && /second line/.test(await pageText(D, st.text.page));
    await settled(D);
    // the save is debounced: wait for the board file to name the image
    const boardNow = async () => (await api('/api/board')).text();
    const board = await until(async () => { const t = await boardNow(); return st.a?.blob && t.includes(st.a.blob) ? t : null; }, 8000) || await boardNow();
    const blob = st.a?.blob && await api('/blob/' + st.a.blob);
    const served = blob && { status: blob.status, type: blob.headers.get('content-type'), cache: blob.headers.get('cache-control') };
    const svg = await api('/api/blob', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' });
    check('N63: Ctrl-V on the board leaves the key to the browser; a PNG pasted into a text field is the field\'s; on the board it is an image card holding the sha256 of its bytes, picked, shown from /blob/<hash>, which serves it as image/png for good',
      st.keyKept && !st.fieldTook && st.fieldMade === 0 && st.boardTook && st.a && /^[0-9a-f]{64}$/.test(st.a.blob) && !st.a.src && st.a.mime === 'image/png' && st.a.iw === 40 && st.a.ih === 30 && st.a.picked
      && st.shown?.w === 40 && st.shown.src === '/blob/' + st.a.blob && served?.status === 200 && served.type === 'image/png' && /immutable/.test(served.cache || ''), JSON.stringify({ st, served }));
    check('N63: the board file keeps the hash, not the bytes; an SVG is redrawn as a 20 × 10 PNG; wb-web refuses SVG bytes (415); a dropped image is an image card too',
      board.includes(st.a?.blob) && !board.includes('data:image') && st.svg?.mime === 'image/png' && st.svg.iw === 20 && st.svg.ih === 10 && svg.status === 415
      && !!st.drop, JSON.stringify({ svg: st.svg, status: svg.status, drop: st.drop }));
    check('N63: Ctrl-C on a picked image card puts the board\'s items and its /blob/ URL on the clipboard; pasting them makes a second card on the same bytes, and so does a paste holding another PNG with the copied text (the system clipboard after an image copy); text pastes as a label, a URL as a web card, lines as a page; cut removes the label and carries its text; an arrow between two copied cards comes along unpicked and a pasted shape leaves its folder',
      st.copy.taken && st.copy.items && st.copy.text.endsWith('/blob/' + st.a.blob) && st.dup?.same && st.dup.other && st.recall?.same && st.recall.iw === 40 && st.recall.stored && st.label && st.text.web && pageOk && st.cut.gone && st.cut.text === 'n62 label' && st.bound?.copied && st.bound.rebound && st.bound.loose, JSON.stringify({ copy: st.copy, dup: st.dup, recall: st.recall, label: st.label, text: st.text, pageOk, cut: st.cut, bound: st.bound }));
    await D.evaluate((ids: string[]) => { for (const id of ids) if (window.__canvas.S.nodes[id]) window.__canvas.removeNode(id); window.__canvas.pickClear(); }, st.made);
    await settled(D);
  } finally { await D?.close(); }
});
