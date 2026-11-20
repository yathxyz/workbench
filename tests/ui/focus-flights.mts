import type { Page } from 'playwright-core';
import { check, until } from './shared.mts';

const quote = { text: 'focus flight quote' };

async function quoteFlight(p: Page, id: string, warm: boolean) {
  const prepared = await p.evaluate(async ({ id, warm, quote }) => {
    const C = window.__canvas, n = C.S.nodes[id], L = C.live[id], P = L.pdf!;
    async function wait<T>(stage: string, promise: Promise<T>): Promise<T> {
      let timer: number;
      try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => reject(new Error(`PDF quote flight: ${stage} timed out`)), 5000);
        })]);
      } finally { clearTimeout(timer!); }
    }
    await wait('loading fixture', P.load as Promise<PdfJsDocument | null>);
    if (warm) await wait('warming lookup', C.pdfText(n));
    const cached = P.texts.every((s: string | null) => s !== null);
    const oldHeight = P.scroll.scrollHeight, oldTop = P.pages[1].el.offsetTop - P.pages[0].el.offsetTop;
    if (warm) L.ro!.disconnect(); // Preserve the ordering under test: quote lookup before the resize observer.
    C.jumpRef({ ...quote, src: { node: id, page: 1 } });
    C.focusOpen(n);
    return { cached, clamps: oldHeight - P.scroll.clientHeight < oldTop };
  }, { id, warm, quote });
  try {
    const found = await until(() => p.evaluate(id => {
      const C = window.__canvas;
      return C.FOCUS.cur === id && C.pdfWhere(C.S.nodes[id]).page === 2 && document.activeElement === C.live[id].pdf!.scroll;
    }, id), 5000);
    check(`N50: a ${warm ? 'warm' : 'cold'} quote flight into PDF focus finds the new page and focuses the reader`,
      found && prepared.cached === warm && (!warm || prepared.clamps), JSON.stringify({ found: !!found, ...prepared }));
  } finally {
    if (warm) await p.evaluate(id => { const L = window.__canvas.live[id]; L.ro!.observe(L.body!); }, id);
  }
}

async function rootSelection(p: Page, shell: string) {
  await p.evaluate(async shell => {
    const C = window.__canvas;
    await new Promise<void>(done => C.jumpNode(C.S.nodes[shell], 1, done));
    C.live[shell].term!.focus();
  }, shell);
  const key = await p.evaluate(() => {
    const C = window.__canvas, before = C.keyInterior();
    C.goAddr('board:/', false);
    return { before, after: C.keyInterior(), selected: C.activeId };
  });
  check('N50: root navigation releases the deselected terminal keyboard', key.before === 'term' && !key.after && !key.selected, JSON.stringify(key));

  const tree = await p.evaluate(() => {
    const C = window.__canvas;
    const n = C.addNode({ kind: 'buffer', name: 'n50-outline', text: '# One\n## Two', x: 150, y: 100, w: 360, h: 280, in: null });
    try {
      C.activate(n.id); C.renderTree(); C.activate(n.id);
      const highlighted = () => document.querySelectorAll(`#tp-list .tp-row.on[data-id="${n.id}"]`).length;
      const before = highlighted(); C.goAddr('board:/', false);
      return { before, after: highlighted() };
    } finally { C.removeNode(n.id); }
  });
  check('N50: root navigation clears the page row and all its heading highlights', tree.before === 3 && tree.after === 0, JSON.stringify(tree));
}

async function interruptedQuote(p: Page, id: string, shell: string, action: 'card' | 'fit' | 'workspace') {
  const result = await p.evaluate(async ({ id, shell, quote, action }) => {
    const C = window.__canvas, n = C.S.nodes[id], P: PdfLive = C.live[id].pdf;
    async function wait<T>(stage: string, promise: Promise<T>, ms = 2000): Promise<T> {
      let timer: number;
      try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => reject(new Error(`PDF quote lookup (${action}): ${stage} timed out`)), ms);
        })]);
      } finally { clearTimeout(timer!); }
    }
    await wait('loading fixture', P.load!, 5000);
    const page = await wait('opening page 2', P.doc!.getPage(2)), read = page.getTextContent;
    const text = await wait('reading page 2 text', read.call(page));
    P.texts[1] = null; // Make the real lookup wait until after navigation.
    const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<typeof text>(), done = Promise.withResolvers<void>();
    page.getTextContent = () => { entered.resolve(); return resume.promise; };
    let scrolled = false, focused = false;
    const saveFocus = P.scroll.focus, scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
    try {
      if (action === 'workspace') C.wsEnter(C.wsTop()[0], true);
      C.pdfGo(n, 0, 0, true);
      C.jumpRef({ ...quote, src: { node: id, page: 1 } }, done.resolve);
      await wait('entering lookup', entered.promise, 2000);
      const scroll = P.scroll;
      Object.defineProperty(scroll, 'scrollTop', { configurable: true, get: () => scrollTop.get!.call(scroll), set: top => { if (top > 0) scrolled = true; scrollTop.set!.call(scroll, top); } });
      scroll.focus = function (options) { focused = true; saveFocus.call(this, options); };
      if (action === 'fit') C.CMDS.find((c: PaletteItem) => c.l === 'Fit everything').run();
      else if (action === 'workspace') C.wsLeave();
      else C.goAddr(C.addrOf(C.S.nodes[shell]), false);
      const navigated = action === 'card' ? C.activeId === shell : action === 'workspace' ? C.WS.cur === null : C.LOD.busy();
      resume.resolve(text);
      await wait('settling the interrupted jump', done.promise, 2000);
      await wait('draining the released lookup', new Promise<void>(resolve => requestAnimationFrame(() => resolve())), 2000);
      return { scrolled, focused, navigated };
    } finally { resume.resolve(text); page.getTextContent = read; delete (P.scroll as Partial<HTMLElement>).scrollTop; P.scroll.focus = saveFocus; }
  }, { id, shell, quote, action });
  check(`N50: leaving via ${action} during PDF text lookup cancels the quote scroll and focus`, result.navigated && !result.scrolled && !result.focused, JSON.stringify(result));
}

async function quoteDuringRender(p: Page, id: string, other: string, action: 'layout' | 'clamp' | 'quote-scroll' | 'close' | 'switch' | 'manual' | 'manual-layout') {
  const size = p.viewportSize()!;
  if (action === 'layout') {
    await p.exposeFunction('n50ResizePdf', (width: number) => p.setViewportSize({ ...size, width }));
  }
  const evaluate = () => p.evaluate(async ({ id, other, quote, action, width }) => {
    const C = window.__canvas, n = C.S.nodes[id], P: PdfLive = C.live[id].pdf;
    async function wait<T>(stage: string, promise: Promise<T>, ms = 2000): Promise<T> {
      let timer: number;
      try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => reject(new Error(`PDF render (${action}): ${stage} timed out`)), ms);
        })]);
      } finally { clearTimeout(timer!); }
    }
    await wait('loading fixture', P.load!);
    await wait('warming lookup', C.pdfText(n));
    const pg = P.pages[1], page = pg.page!, stream = page.streamTextContent;
    if (pg.text) throw new Error(`PDF render (${action}): the fixture already drew page 2`);
    const content = await wait('reading fixture text', page.getTextContent());
    const renders = Array.from({ length: 4 }, () => ({
      started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(), cancelled: false,
    }));
    let count = 0, focused = false;
    const manual = action === 'manual' || action === 'manual-layout';
    const done = Promise.withResolvers<void>(), saveFocus = P.scroll.focus;
    page.streamTextContent = function () {
      const render = renders[count++];
      if (!render) return stream.call(this);
      // Use real PDF.js text items without leaving a mocked reader attached to the worker during teardown.
      render.started.resolve();
      return new ReadableStream({
        async pull(controller) {
          await render.release.promise;
          if (render.cancelled) return;
          if (action !== 'manual' && action !== 'quote-scroll' && action !== 'clamp') controller.enqueue(content);
          controller.close();
        },
        cancel() { render.cancelled = true; render.release.resolve(); },
      });
    };
    P.scroll.focus = function (options) { focused = true; saveFocus.call(this, options); if (manual) done.resolve(); };
    try {
      if (manual) {
        C.jumpNode(n);
        C.CMDS.find((c: PaletteItem) => c.l === 'PDF: find in the active PDF…').run();
        document.querySelector<HTMLInputElement>('#ask-in')!.value = quote.text;
        document.querySelector<HTMLFormElement>('#ask-form')!.requestSubmit();
      } else {
        C.jumpRef({ ...quote, src: { node: id, page: 1 } }, done.resolve);
      }
      await wait('entering page 2 render', renders[0].started.promise);
      const before = C.pdfWhere(n).page, initial = pg.el.querySelector('.textLayer')!;
      if (action === 'layout') {
        C.focusOpen(n);
        const clamped = C.pdfWhere(n).page, removed = !initial.isConnected;
        await wait('starting first replacement', renders[1].started.promise);
        const resize = Reflect.get(window, 'n50ResizePdf') as (width: number) => Promise<void>;
        await wait('narrowing the focused viewport', resize(width - 140));
        await wait('starting second replacement', renders[2].started.promise);
        await wait('widening the focused viewport', resize(width + 50));
        await wait('starting final replacement', renders[3].started.promise);
        const focusedEarly = focused;
        renders[3].release.resolve(); // The discarded streams themselves are never released.
        await wait('settling against final replacement', done.promise);
        const cancelled = renders.slice(0, 3).filter(r => r.cancelled).length;
        const landed = C.pdfWhere(n).page, hit = !!pg.el.querySelector('.textLayer .pdf-hit');
        return { ok: before === 2 && clamped === 1 && removed && !focusedEarly && cancelled === 3 && landed === 2 && hit && focused,
          before, clamped, removed, focusedEarly, cancelled, landed, hit, focused };
      }
      if (action === 'manual-layout' || action === 'clamp') {
        C.focusOpen(n);
        const clamped = C.pdfWhere(n).page, removed = !initial.isConnected;
        await wait('starting replacement layer', renders[1].started.promise);
        await wait('draining the cancelled render', new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
        const focusedEarly = focused;
        renders[1].release.resolve();
        await wait('finishing on the replacement layer', done.promise);
        await wait('settling replacement layer', pg.textReady!);
        const landed = C.pdfWhere(n).page, hit = !!pg.el.querySelector('.textLayer .pdf-hit');
        return { ok: before === 2 && clamped === 1 && removed && renders[0].cancelled && !focusedEarly &&
          landed === 2 && hit === manual && focused, before, clamped, removed, focusedEarly, landed, hit, focused };
      }
      if (action === 'manual' || action === 'quote-scroll') {
        P.scroll.scrollTop = 100;
        const chosen = P.scroll.scrollTop;
        renders[0].release.resolve();
        await wait(`finishing ${manual ? 'manual find' : 'quote jump'}`, done.promise);
        return { ok: before === 2 && chosen === 100 && P.scroll.scrollTop === chosen, before, chosen, landed: P.scroll.scrollTop };
      }
      if (action === 'close') C.removeNode(id);
      if (action === 'switch') C.focusOpen(C.S.nodes[other]);
      try {
        await wait('settling jump with its layer still blocked', done.promise, 1000);
      } catch (e) { return { ok: false, error: (e as Error).message }; }
      const cancelled = renders[0].cancelled;
      // A switched-away card may still finish its ordinary display render; it must not regain focus.
      renders[0].release.resolve();
      if (action !== 'close') await wait('finishing display render after the jump', pg.textReady!);
      const stillOnOther = action !== 'switch' || C.FOCUS.cur === other;
      return { ok: before === 2 && !focused && stillOnOther && (action !== 'close' || cancelled),
        before, focused, stillOnOther, cancelled };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      for (const render of renders) render.release.resolve();
      P.scroll.focus = saveFocus;
      page.streamTextContent = stream;
    }
  }, { id, other, quote, action, width: size.width });
  const result = await evaluate().finally(async () => { if (action === 'layout') await p.setViewportSize(size); });
  const name = {
    layout: 'a quote follows repeated layout replacements without waiting for discarded text layers',
    clamp: 'a quote with no spans restores the target page when the layout clamps it',
    'quote-scroll': 'a quote with no spans preserves a scroll made during rendering without a resize',
    close: 'closing a PDF settles its pending quote and cancels the discarded render',
    switch: 'switching PDFs settles the pending quote without waiting for the old render',
    manual: 'manual find without highlight spans leaves the user scroll in place',
    'manual-layout': 'manual find waits for replacement spans before reporting success',
  }[action];
  check(`N50: ${name}`, result.ok, JSON.stringify(result));
}

export async function focusFlights(p: Page, shell: string) {
  const paper = await p.context().newPage();
  let src: string;
  try {
    await paper.setContent('<p>First page</p><p style="break-before:page">The focus flight quote</p>');
    src = 'data:application/pdf;base64,' + (await paper.pdf()).toString('base64');
  } finally { await paper.close(); }
  await p.bringToFront();
  await rootSelection(p, shell);
  const add = (name: string) => p.evaluate(({ src, name }) => window.__canvas.addNode({ kind: 'pdf', name, src, in: null, x: 18000, y: 14000, w: 510, h: 320 }).id, { src, name });
  const close = (id: string) => p.evaluate(id => { const C = window.__canvas; C.focusClose(id); if (C.S.nodes[id]) C.removeNode(id); }, id);
  const cold = await add('n50-paper-cold');
  try { await quoteFlight(p, cold, false); } finally { await close(cold); }
  const other = await add('n50-paper-other');
  try {
    for (const action of ['layout', 'clamp', 'quote-scroll', 'close', 'switch', 'manual', 'manual-layout'] as const) {
      const rendering = await add(`n50-paper-${action}`);
      try { await quoteDuringRender(p, rendering, other, action); } finally { await close(rendering); }
    }
  } finally { await close(other); }
  const id = await add('n50-paper');
  try {
    await quoteFlight(p, id, true);

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
      await p.evaluate(({ target, id, shell }) => {
        const C = window.__canvas; C.goAddr(target); C.goAddr(C.addrOf(C.S.nodes[shell])); C.focusOpen(C.S.nodes[id]);
      }, { target, id, shell });
      await p.goBack();
      const landed = await until(() => p.evaluate(target => decodeURIComponent(location.hash.slice(1)) === target && !window.__canvas.LOD.busy(), target));
      const actual = await geometry();
      const address = await p.evaluate(() => { window.__canvas.hashSync(); return decodeURIComponent(location.hash.slice(1)); });
      check(`N50: browser Back from focus restores canvas geometry before navigating to ${target}`, landed && address === target && !actual.focus && actual.world === expected.world && actual.w === expected.w && actual.h === expected.h, JSON.stringify({ landed, address, expected, actual }));
    }
    for (const action of ['card', 'fit', 'workspace'] as const) await interruptedQuote(p, id, shell, action);

    const saved = { x: 400, y: -600, z: 0.35 }, point = '@1024,2048', name = 'n50-saved';
    const run = (q: string) => p.evaluate(q => window.__canvas.palSearch(q)[0].run(), q);
    const camera = async () => { await until(() => p.evaluate(() => !window.__canvas.LOD.busy())); return p.evaluate(() => ({ ...window.__canvas.S.cam })); };
    const focus = () => p.evaluate(id => { const C = window.__canvas; C.focusOpen(C.S.nodes[id]); (document.activeElement as HTMLElement)?.blur(); }, id);
    await p.evaluate(({ name, saved }) => { window.__canvas.S.views[name] = saved; }, { name, saved });
    try {
      await run(name); await camera(); await run(point); const at = await camera();
      for (const [command, dest] of [[name, saved], [point, at], ['Alt+ArrowLeft', saved], ['Alt+ArrowRight', at]] as const) {
        await focus();
        if (command.startsWith('Alt+')) await p.keyboard.press(command); else await run(command);
        const cam = await camera();
        check(`N50: ${command} leaves focus and lands at the canvas destination`,
          await p.evaluate(() => !window.__canvas.FOCUS.cur) && cam.x === dest.x && cam.y === dest.y && cam.z === dest.z, JSON.stringify({ cam, dest }));
      }
    } finally { await p.evaluate(name => { delete window.__canvas.S.views[name]; }, name); }
  } finally { await close(id); }
}
