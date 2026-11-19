import fs from 'node:fs';
import path from 'node:path';
import { TMP, check, section } from '../shared.mts';
import { api, dpage, settled } from '../daemon.mts';
import { type TailPage } from '../acp.mts';

// N73 (F-A40): PDFs on the canvas. A two-page PDF with a link from page 1 to page 2, written here by hand.
function testPdf(): Buffer {
  const s1 = 'BT /F1 18 Tf 72 700 Td (Alpha section of the paper) Tj 0 -30 Td (The quote target sits here for N73.) Tj 0 -30 Td (See page two for more.) Tj ET';
  const s2 = 'BT /F1 18 Tf 72 700 Td (Beta section on page two) Tj 0 -30 Td (Second page text is here.) Tj ET';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R /Annots [8 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${s1.length} >>\nstream\n${s1}\nendstream`, `<< /Length ${s2.length} >>\nstream\n${s2}\nendstream`,
    '<< /Type /Annot /Subtype /Link /Rect [72 634 300 658] /Border [0 0 0] /Dest [4 0 R /XYZ 0 720 0] >>'];
  let out = '%PDF-1.4\n'; const at: number[] = [];
  objs.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + at.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(out + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1');
}

await section('N73', async () => {
  let D: TailPage | undefined;
  const file = path.join(TMP, 'n68 paper.pdf'), bytes = testPdf(); fs.writeFileSync(file, bytes); fs.writeFileSync(path.join(TMP, 'n68.txt'), 'not a pdf');
  try {
    const whole = await api('/api/raw?path=' + encodeURIComponent(file)), part = await api('/api/raw?path=' + encodeURIComponent(file), { headers: { Range: 'bytes=0-4' } });
    const raw = { status: whole.status, type: whole.headers.get('content-type'), disp: whole.headers.get('content-disposition'), csp: whole.headers.get('content-security-policy'), len: (await whole.arrayBuffer()).byteLength,
      part: part.status, range: part.headers.get('content-range'), head: await part.text(),
      txt: (await api('/api/raw?path=' + encodeURIComponent(path.join(TMP, 'n68.txt')))).status,
      past: (await api('/api/raw?path=' + encodeURIComponent(file), { headers: { Range: `bytes=${bytes.length + 10}-` } })).status };
    const up = await api('/api/blob', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: new Uint8Array(bytes) }), upj = await up.json();
    const got = await api('/blob/' + upj.hash), blob = { status: up.status, type: upj.type, served: got.headers.get('content-type'), disp: got.headers.get('content-disposition') };
    D = await dpage(); await settled(D);
    const pageErrors: string[] = []; D.on('pageerror', e => pageErrors.push(e.message));
    const st = await D.evaluate(async (file: string) => {
      const C = window.__canvas, S = C.S, out: Record<string, any> = {}; // any: each step's findings, read by the checks below
      if (C.WS.cur) C.wsLeave(); if (C.DESK.cur) C.deskGo(0, true); C.pickClear();
      const until = async <T,>(f: () => T, n = 150) => { for (let i = 0; i < n; i++) { const v = f(); if (v) return v; await new Promise(r => setTimeout(r, 100)); } return null; };
      const n = C.pdfFromPath(file), L = () => C.live[n.id]?.pdf;
      C.jumpNode(n); await new Promise(r => setTimeout(r, 900));
      await until(() => L()?.doc && L().pages.length === 2);
      const p0 = await until(() => L().pages[0].canvas && L().pages[0].text?.querySelector('span') && L().pages[0].el.querySelector('.pdf-link') ? L().pages[0] : null);
      out.open = { name: n.name, pages: n.pages, drawn: !!p0?.canvas?.width, text: !!p0?.text, link: !!p0?.el.querySelector('.pdf-link'), badge: C.badgeOf(n), ident: C.fsIdent(n)?.path === file };
      out.text = await C.pdfText(n, 1, 2);
      // select "quote target" on page 1 and quote it
      const span = [...(p0?.text?.querySelectorAll('span') || [])].find((x: Element) => /quote target/.test(x.textContent!)) as HTMLElement | undefined;
      if (span) { const t = span.firstChild!, i = t.textContent!.indexOf('quote target'), r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 12); getSelection()!.removeAllRanges(); getSelection()!.addRange(r); }
      out.sel = C.pdfSel(n)?.text; out.selOf = C.selectionOf(n);
      const q = await C.pdfQuote(n);
      out.quote = q && { text: q.text, src: q.src, label: q.srcLabel, edge: S.edges.some((e: Edge) => e.from === n.id && e.to === q.id && e.type === 'ref') };
      out.find = await C.pdfFind(n, 'quote target', 1, 'The ', ' sits');   // asked on page 2, found on page 1
      out.hit = !!L().pages[0].text?.querySelector('.pdf-hit');
      out.miss = await C.pdfFind(n, 'no such words anywhere', 0);
      // the link opens a peek of page 2; its ⤴ is there
      const before = Object.keys(S.nodes).length;
      (L().pages[0].el.querySelector('.pdf-link') as HTMLElement).click();
      const peek = await until(() => Object.values<BoardNode>(S.nodes).find(m => m.kind === 'image' && m.at?.node === n.id) as ImageNode | undefined);
      out.peek = peek && { page: peek.at!.page, blob: /^[0-9a-f]{64}$/.test(peek.blob || ''), edge: S.edges.some((e: Edge) => e.from === n.id && e.to === peek.id), btn: [...C.live[peek.id].hdr.querySelectorAll('.hb')].some((b: Element) => b.textContent === '⤴'), more: Object.keys(S.nodes).length - before };
      // the reading position lives in the card
      C.pdfGo(n, 1, 0, true);
      out.pos = await until(() => n.pos?.page === 2 ? { ...n.pos, badge: C.badgeOf(n) } : null, 30);
      // keys: the pages take j/k/G…; G goes to the last page, g to the first
      L().scroll.focus();
      out.keys = { interior: C.keyContext().interior, j: window.WBKeys.resolve(C.keyContext(), 'j')[0]?.cmd, q: window.WBKeys.resolve(C.keyContext(), 'q')[0]?.cmd };
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', bubbles: true, cancelable: true }));
      out.keys.g = await until(() => C.pdfWhere(n).page === 1 && L().scroll.scrollTop === 0 ? 1 : 0, 30) || C.pdfWhere(n).page;   // a smooth scroll
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', code: 'KeyG', shiftKey: true, bubbles: true, cancelable: true }));
      out.keys.G = await until(() => C.pdfWhere(n).page === 2 ? 2 : 0, 30) || C.pdfWhere(n).page;
      (document.activeElement as HTMLElement).blur();
      // an agent reads it, and opens another
      const tool = (name: string) => C.AGENT_TOOLS.find((t: AgentTool) => t.name === name);
      out.read = await tool('read_pdf').run({ path: n.name, from: 2, to: 2 });
      out.readNode = await tool('read_node').run({ path: n.name });
      // Hold the second card in getPage(1) until removal has destroyed its loading task.
      const proto: PdfJsDocument = Object.getPrototypeOf(L().doc), getPage = proto.getPage;
      let first = Promise.withResolvers<PdfJsPage>();
      let waiting = false;
      proto.getPage = function (page) {
        if (this === L().doc || page !== 1) return getPage.call(this, page);
        waiting = true; return first.promise;
      };
      try {
        const p2 = C.findNode(await tool('open_pdf').run({ file }));
        out.opened = p2 && { kind: p2.kind, path: p2.path, other: p2.id !== n.id };
        const P: PdfLive = C.live[p2.id].pdf;
        if (!await until(() => waiting)) throw new Error('second PDF never requested page 1');
        const task = P.task!, destroy = task.destroy.bind(task);
        let destroys = 0, released: Promise<void> | undefined;
        task.destroy = () => { destroys++; released = destroy(); return released.then(() => { throw new Error('N73 destroyed transport'); }); };
        C.removeNode(p2.id);
        first.reject(new Error('Transport destroyed'));
        out.closedLoading = await P.load === null && !P.err && !C.live[p2.id];
        await released; out.destroys = destroys;

        first = Promise.withResolvers<PdfJsPage>(); waiting = false;
        const bad = C.pdfFromPath(file), entry = C.live[bad.id];
        if (!await until(() => waiting)) throw new Error('live PDF never requested page 1');
        const failedTask: PdfJsLoadingTask = entry.pdf.task, destroyFailed = failedTask.destroy.bind(failedTask);
        let failedReleases = 0;
        failedTask.destroy = () => { failedReleases++; return destroyFailed(); };
        first.reject(new Error('N73 broken first page'));
        out.badFirst = { noDoc: await entry.pdf.load === null, err: entry.pdf.err, shown: !entry.note.hidden && entry.note.textContent };
        out.badFirst.released = failedReleases === 1 && entry.pdf.task === null;
        C.removeNode(bad.id);
        out.badFirst.releasedOnce = failedReleases === 1;
      } finally { proto.getPage = getPage; }
      // Delay page 2 on another real document. Its visible-page update is fire-and-forget.
      const later = C.pdfFromPath(file, null, { pos: { page: 2, y: 0 }, h: 320 }), laterEntry = C.live[later.id];
      const laterDoc: PdfJsDocument = await laterEntry.pdf.load, readPage = laterDoc.getPage.bind(laterDoc), second = Promise.withResolvers<PdfJsPage>();
      let readingSecond = false;
      laterDoc.getPage = i => { if (i !== 2) return readPage(i); readingSecond = true; return second.promise; };
      if (!await until(() => readingSecond)) throw new Error('visible PDF never requested page 2');
      second.reject(new Error('N73 broken later page'));
      const turn = () => new Promise<void>(r => setTimeout(r, 0));
      await turn(); out.badLater = { err: laterEntry.pdf.err, shown: !laterEntry.note.hidden && laterEntry.note.textContent };
      laterDoc.getPage = readPage; C.removeNode(later.id);

      const draw = C.pdfFromPath(file, null, { h: 320 }), entry = C.live[draw.id], pdf: PdfLive = entry.pdf;
      await pdf.load;
      const pg = pdf.pages[0], page = pg.page!, render = page.render.bind(page);
      const jobs: { task: PdfJsRenderTask; reject: (error: Error) => void; cancelled: boolean }[] = [];
      page.render = () => {
        const gate = Promise.withResolvers<void>();
        const job = { task: { promise: gate.promise, cancel: () => { job.cancelled = true; } }, reject: gate.reject, cancelled: false };
        jobs.push(job); return job.task;
      };
      if (!await until(() => jobs.length === 1)) throw new Error('PDF never requested its bitmap');
      draw.w -= 160; C.nodeResized(draw);
      if (!await until(() => jobs.length === 2)) throw new Error('resized PDF never requested its replacement bitmap');
      jobs[0].reject(new Error('N73 obsolete bitmap')); await turn();
      out.oldRender = jobs[0].cancelled && pg.task === jobs[1].task && !pdf.err && entry.note.hidden;
      jobs[1].reject(new Error('N73 broken bitmap')); await turn();
      out.badRender = { clear: pg.task === null, err: pdf.err, shown: !entry.note.hidden && entry.note.textContent };
      if (pg.task === null) {
        C.pdfGo(draw, 0, 0, true);
        if (!await until(() => jobs.length === 3)) throw new Error('failed PDF bitmap never retried at the same scale');
        jobs[2].reject(Object.assign(new Error('N73 cancelled bitmap'), { name: 'RenderingCancelledException' })); await turn();
        out.cancelled = pg.task === null && entry.note.textContent === out.badRender.shown && pdf.err === out.badRender.err;
      }
      page.render = render;
      C.pdfGo(draw, 0, 0, true); out.redrawn = !pg.task && !!await until(() => pg.canvas?.width);

      // Close after Quote has read the real selection but before getTextContent settles.
      await pg.textReady;
      const spanToQuote = [...pg.text!.querySelectorAll('span')].find(sp => sp.textContent!.includes('quote target'))!;
      const sel = document.createRange(); sel.selectNodeContents(spanToQuote);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(sel);
      const content = Promise.withResolvers<Awaited<ReturnType<PdfJsPage['getTextContent']>>>();
      let extracting = false;
      page.getTextContent = () => { extracting = true; return content.promise; };
      const quote = C.pdfQuote(draw).then((r?: RefNode) => r?.id || null, (e: Error) => e.message);
      if (!await until(() => extracting)) throw new Error('Quote never requested its page text');
      C.removeNode(draw.id); content.reject(new Error('N73 closed quote'));
      out.closedQuote = { result: await quote, refs: Object.values<BoardNode>(S.nodes).filter(m => m.kind === 'ref' && m.src?.node === draw.id).length,
        edges: S.edges.filter((e: Edge) => e.from === draw.id).length, err: pdf.err };
      // a dropped PDF is a card on its bytes in the blob store
      const dt = new DataTransfer(); dt.items.add(new File([await (await fetch('/api/raw?path=' + encodeURIComponent(file))).blob()], 'dropped.pdf', { type: 'application/pdf' }));
      const vp = document.querySelector('#viewport')!.getBoundingClientRect();
      document.querySelector('#viewport')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: vp.left + 300, clientY: vp.top + 300, bubbles: true, cancelable: true }));
      const dropped = await until(() => Object.values<BoardNode>(S.nodes).find(m => m.kind === 'pdf' && m.name === 'dropped') as PdfNode | undefined);
      await until(() => C.live[dropped!.id]?.pdf?.doc);
      out.dropped = dropped && { blob: dropped.blob, path: dropped.path, pages: dropped.pages, url: C.pdfUrl(dropped) };
      out.made = [n.id, q?.id, peek?.id, dropped?.id].filter(Boolean);
      // a card that goes takes its document with it
      const P = L(); C.removeNode(n.id); out.closed = !C.live[n.id] && P.doc === null && P.pages.length === 0;
      return out;
    }, file);
    check('N73: /api/raw serves a PDF on the host whole and one range (206, Content-Range), as an attachment under a sandbox CSP, and refuses a file that is not a PDF (400) and a range past the end (416); the blob store takes PDF bytes and serves them as an attachment',
      raw.status === 200 && raw.type === 'application/pdf' && /attachment/.test(raw.disp || '') && /sandbox/.test(raw.csp || '') && raw.len === bytes.length && raw.part === 206 && raw.range === `bytes 0-4/${bytes.length}` && raw.head === '%PDF-' && raw.txt === 400 && raw.past === 416
      && blob.status === 200 && blob.type === 'application/pdf' && blob.served === 'application/pdf' && /attachment/.test(blob.disp || ''), JSON.stringify({ raw, blob }));
    check('N73: a PDF on the host opens as a pdf card: two pages, the one in view drawn with a text layer and its link, "p. 1 / 2" on the badge; pdfText reads pages with markers; agents read it (read_pdf; read_node from the reading page, by then page 2) and open another (open_pdf)',
      st.open.pages === 2 && st.open.drawn && st.open.text && st.open.link && st.open.badge === 'p. 1 / 2' && st.open.ident && /--- n68 paper p\. 1 ---[\s\S]*quote target[\s\S]*--- n68 paper p\. 2 ---[\s\S]*Second page text/.test(st.text)
      && /p\. 2 ---[\s\S]*Beta section/.test(st.read) && !/Alpha/.test(st.read) && /p\. 2 ---[\s\S]*Beta section/.test(st.readNode) && st.opened?.kind === 'pdf' && st.opened.path === file && st.opened.other, JSON.stringify(st.open) + st.text.slice(0, 300));
    check('N73: closing a PDF while page 1 loads destroys its loading task once and ignores the cancelled load and teardown rejection',
      st.closedLoading && st.destroys === 1 && !pageErrors.some(e => e.includes('N73 destroyed transport')), JSON.stringify({ closed: st.closedLoading, destroys: st.destroys, pageErrors }));
    check('N73: a live first-page failure is shown on the PDF card', st.badFirst.noDoc && st.badFirst.err === 'Cannot open the PDF: N73 broken first page' && st.badFirst.shown === st.badFirst.err, JSON.stringify(st.badFirst));
    check('N73: failed first-page loading releases the document while its error card remains open, not twice on close',
      st.badFirst.released && st.badFirst.releasedOnce, JSON.stringify(st.badFirst));
    check('N73: a delayed getPage failure on a visible later page is shown on the PDF card without an unhandled rejection',
      st.badLater.err === 'Cannot open the PDF: N73 broken later page' && st.badLater.shown === st.badLater.err && !pageErrors.some(e => e.includes('N73 broken later page')), JSON.stringify({ ...st.badLater, pageErrors }));
    check('N73: a superseded bitmap rejection is silent and cannot clear the replacement task', st.oldRender);
    check('N73: a live bitmap failure is shown, clears its task, and allows drawing again at the same scale',
      st.badRender.clear && st.badRender.err === 'Cannot open the PDF: N73 broken bitmap' && st.badRender.shown === st.badRender.err && st.redrawn, JSON.stringify({ ...st.badRender, redrawn: st.redrawn }));
    check('N73: a cancelled current bitmap clears its task without reporting the cancellation', st.cancelled);
    check('N73: closing a PDF during quote extraction is silent and leaves no dangling quote or edge',
      st.closedQuote.result === null && !st.closedQuote.refs && !st.closedQuote.edges && st.closedQuote.err === st.badRender.err, JSON.stringify(st.closedQuote));
    check('N73: the selection quotes as a ref card holding the page and the text around it (TextQuoteSelector), linked to the PDF; the quote is found again (asked on page 2, found on page 1, lit up), a text that is not there is not',
      st.sel === 'quote target' && st.selOf === 'quote target' && st.quote?.text === 'quote target' && st.quote.src.page === 1 && /The $/.test(st.quote.src.prefix) && /^ sits/.test(st.quote.src.suffix) && st.quote.label === 'n68 paper › p. 1' && st.quote.edge
      && st.find === true && st.hit && st.miss === false, JSON.stringify({ sel: st.sel, quote: st.quote, find: st.find, hit: st.hit, miss: st.miss }));
    check('N73: a link to page 2 opens a peek, an image card of that place in the blob store with ⤴ back; the reading position is saved in the card; on the pages j and q are the pdf keymap\'s, g and G go to the first and last page',
      st.peek?.page === 2 && st.peek.blob && st.peek.edge && st.peek.btn && st.pos?.page === 2 && st.pos.badge === 'p. 2 / 2' && st.keys.interior === 'pdf' && st.keys.j === 'pdf.down' && st.keys.q === 'pdf.quote' && st.keys.g === 1 && st.keys.G === 2,
      JSON.stringify({ peek: st.peek, pos: st.pos, keys: st.keys }));
    check('N73: a PDF dropped on the canvas is a pdf card on its sha256 in the blob store, and it opens; a removed card lets go of its document',
      /^[0-9a-f]{64}$/.test(st.dropped?.blob || '') && !st.dropped.path && st.dropped.pages === 2 && st.dropped.url === '/blob/' + st.dropped.blob && st.closed, JSON.stringify({ dropped: st.dropped, closed: st.closed }));
    await D.evaluate((ids: string[]) => { for (const id of ids) if (window.__canvas.S.nodes[id]) window.__canvas.removeNode(id); window.__canvas.pickClear(); }, st.made);
    await settled(D);
  } finally { await D?.close(); }
});
