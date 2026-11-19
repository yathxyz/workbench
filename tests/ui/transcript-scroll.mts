import type { Page } from 'playwright-core';
import { check } from './shared.mts';

// A real input gesture must change the first actually visible row before an append can test follow.
// One wheel step leaves EOF in the window; a page-sized wheel also exercises Edwin moving point itself.
export async function checkTranscriptScroll(page: Page, prompt: (s: string) => void, chunk: (id: string, s: string) => void) {
  const reader = page.locator('#mesh-detail .ag-reader'), view = reader.locator('.text'), input = reader.locator('.ed-input');
  const composer = page.locator('#mesh-detail .ag-in textarea'), savedDraft = await composer.inputValue(), draft = savedDraft || 'N81 unsent scroll draft';
  const phone = { width: 390, height: 844 }, original = page.viewportSize()!;
  const cdp = await page.context().newCDPSession(page);
  const picture = () => view.evaluate(async el => {
    await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const box = el.getBoundingClientRect(), lines = [...el.querySelectorAll<HTMLElement>('.ln')].filter(l => {
      const b = l.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.bottom > Math.max(0, box.top)
        && b.top < Math.min(innerHeight, box.bottom) && b.right > Math.max(0, box.left) && b.left < Math.min(innerWidth, box.right);
    });
    const { buf, frame } = window.__canvas.live.$agents.backend.transcript as { buf: EdwinBuffer; frame: EdwinFrame };
    return { first: lines[0]?.textContent?.trim(), firstOffset: Number(lines[0]?.dataset.o), last: lines.at(-1)?.textContent?.trim(),
      rows: lines.map(l => l.textContent?.trim()), lh: lines[0]?.getBoundingClientRect().height, atTail: buf.rope.length - frame.point() <= 1,
      point: frame.point(), end: buf.rope.length, composer: document.activeElement === document.querySelector('#mesh-detail .ag-in textarea') };
  });
  const keys = async (...keys: string[]) => { await input.focus(); for (const k of keys) await page.keyboard.press(k); };
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x?: number, y?: number) => cdp.send('Input.dispatchTouchEvent',
    { type, touchPoints: x == null || y == null ? [] : [{ x, y }] });
  const follow = async (mobile: boolean) => {
    if (mobile) {
      const button = page.getByRole('button', { name: 'Follow tail', exact: true });
      await button.click({ trial: true }); const b = (await button.boundingBox())!;
      await touch('touchStart', b.x + b.width / 2, b.y + b.height / 2); await touch('touchEnd');
    } else await keys('Control+c', 'f');
  };
  const send = async (id: string, label: string, n: number) => {
    const end = `${label} end`;
    chunk(id, '\n' + Array.from({ length: n }, (_, i) => label + ' ' + i).concat(end).join('\n'));
    await page.waitForFunction(s => window.__canvas.live.$agents.backend.transcript.buf.text.includes(s), end);
    return end;
  };
  try {
    if (!savedDraft) await composer.fill(draft);
    prompt('N81 viewport gestures');
    for (const kind of ['wheel-step', 'wheel-page', 'touch'] as const) {
      const mobile = kind === 'touch';
      if (mobile) {
        await page.setViewportSize(phone);
        await page.evaluate(() => { if (document.body.classList.contains('side-open')) window.__canvas.toggleDockTerm(); });
      }
      const gesture = async (lines: number, lh: number) => {
        const b = (await view.boundingBox())!, x = b.x + b.width / 2, y = b.y + b.height / 2;
        if (!await view.evaluate((v, { x, y }) => v.contains(document.elementFromPoint(x, y)), { x, y })) throw new Error('N81 scroll point is not in the Edwin viewport');
        if (!mobile) { await page.mouse.move(x, y); await page.mouse.wheel(0, lines * lh); }
        else {
          const delta = -lines * lh, from = y - delta / 2;
          await touch('touchStart', x, from);
          for (let i = 1; i <= 4; i++) await touch('touchMove', x, from + i * delta / 4);
          await touch('touchEnd');
        }
      };
      const seed = await send(kind, kind + ' seed', 192);
      await follow(mobile);
      await keys('z', 'z'); // center EOF: a small scroll can move the viewport without moving point
      await composer.focus();
      const initial = await picture();
      check(`N81: ${kind} starts visibly following at EOF`, initial.atTail && initial.rows.includes(seed) && initial.composer, initial);
      await gesture(kind === 'wheel-page' ? -initial.rows.length * 2 : -3, initial.lh!);
      const away = await picture(), moved = !!away.first && away.firstOffset < initial.firstOffset;
      check(`N81: ${kind} really scrolls up inside the transcript`, moved, { initial, away });
      if (!mobile) check(`N81: ${kind} ${kind === 'wheel-step' ? 'leaves point at EOF' : 'moves point into history'}`,
        kind === 'wheel-step' ? away.point === initial.point : !away.atTail, { initial, away });
      const incoming = await send(kind, kind + ' paused', 64), kept = await picture();
      check(`N81: ${kind} holds the visible text and composer across a streamed chunk`, moved && kept.first === away.first
        && !kept.rows.includes(incoming) && kept.composer && await composer.inputValue() === draft, { away, kept });
      if (kind === 'wheel-page') {
        // Return all the way to the tail by scrolling, not by invoking Follow.
        await gesture(500, kept.lh!);
      } else await follow(mobile);
      const end = await send(kind, kind + ' live', 64), resumed = await picture();
      console.log(`N81 ${kind}: first row ${initial.first} → ${away.first} → ${kept.first}; point at EOF after gesture: ${away.atTail}; latest row visible after resume: ${resumed.rows.includes(end)}`);
      check(`N81: ${kind} ${kind === 'wheel-page' ? 'scrolling back to EOF' : 'Follow'} resumes visible streaming`, resumed.atTail && resumed.rows.includes(end)
        && (!mobile || resumed.composer) && await composer.inputValue() === draft, resumed);
    }
  } finally {
    await cdp.detach(); await page.setViewportSize(original);
    if (!savedDraft) await composer.fill(savedDraft);
  }
}
