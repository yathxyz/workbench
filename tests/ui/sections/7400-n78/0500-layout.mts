import { check, section, until } from '../../shared.mts';
import { H } from '../../daemon.mts';
import type { N78Fixture } from './fixtures.mts';

export default async function run({
  D, sid, cwd, edwin, meshApi, report, row, info, attachSid, attachText, forgot, switchButton,
  composer, reader, readerText, readerState, readUntil, liveIdle, isAlive, open, reload, hasTerminal,
}: N78Fixture) {
  await section('N78 layout', async () => {
    const viewport = D.viewportSize()!, prompt = 'Long observed prompt '.repeat(100).slice(0, 2000);
    await D.evaluate(() => { if (document.body.classList.contains('side-open')) window.__canvas.toggleDockTerm(); });   // measure Agents, not the dock's overlay
    const created = await meshApi('/sessions', 'POST', { sid: 'n78_layout_api', agent: 'stub', cwd });
    if (created.status !== 201) throw new Error('N78 layout ACP spawn: ' + created.status);
    await report('near', 'n78-layout', { wbSession: 'n78_layout_api' }, 'prompt', prompt);
    const id = await until(() => D.evaluate((prompt: string) => Object.values<ObservedSession>(window.__canvas.OBS).find(o => o.sessionId === 'n78-layout' && o.lastPrompt === prompt)?.id, prompt), 10000);
    if (!id) throw new Error('N78 layout session did not arrive');
    const layout = () => D.evaluate(() => {
      const rect = (s: string) => document.querySelector(s)!.getBoundingClientRect(), view = rect('#v-agents'), pane = rect('#mesh-detail'), live = rect('.mesh-live > .body'), input = rect('#mesh-detail .ag-in');
      const buttons = [...document.querySelectorAll<HTMLElement>('.mesh-head button')].filter(e => !e.hidden).map(e => {
        const r = e.getBoundingClientRect(); return { text: e.textContent, x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      });
      const overflow = [...document.querySelectorAll<HTMLElement>('#v-agents *')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > view.right + 1; }).map(e => e.id || e.className);
      return { buttons, overflow, width: view.width, inside: buttons.every(r => r.width > 0 && r.height > 0 && r.x >= pane.left && r.right <= pane.right && r.y >= pane.top && r.bottom <= pane.bottom && r.x >= view.left && r.right <= view.right && r.y >= 0 && r.bottom <= innerHeight),
        pane: pane.height, live: live.height, gap: pane.bottom - input.bottom, facts: !document.querySelector<HTMLElement>('.mesh-info')!.hidden };
    });
    const widths = () => D.evaluate(() => ({ list: document.querySelector('.mesh-side')!.getBoundingClientRect().width, pane: document.querySelector('#mesh-detail')!.getBoundingClientRect().width }));
    const drag = async (x: number) => { const r = (await D.locator('#mesh-grip').boundingBox())!; await D.mouse.move(r.x + r.width / 2, r.y + 100); await D.mouse.down(); await D.mouse.move(x, r.y + 100, { steps: 8 }); await D.mouse.up(); };
    for (const size of [{ width: 1280, height: 800 }, { width: 900, height: 700 }]) {
      await D.setViewportSize(size); await open(id); await liveIdle();
      const closed = await layout();
      await D.getByRole('button', { name: 'Details', exact: true }).click();
      const expanded = await layout(), promptShown = await D.locator('.mesh-info .mesh-kv').filter({ hasText: /^prompt/ }).locator('code').textContent();
      const facts = await D.locator('.mesh-info').evaluate(e => ({ height: e.getBoundingClientRect().height, scroll: getComputedStyle(e).overflowY }));
      check(`N78: ${size.width}×${size.height} compact header contains every action, gives the session half the pane and keeps a composer gap; disclosure reveals 2,000 characters without shifting actions`,
        !closed.facts && closed.inside && closed.live >= closed.pane / 2 && closed.gap >= 8 && expanded.facts && expanded.inside && expanded.live >= expanded.pane / 2
        && Math.abs(expanded.live - closed.live) <= 1 && promptShown === prompt && facts.height <= size.height * .35 && facts.scroll === 'auto' && JSON.stringify(closed.buttons) === JSON.stringify(expanded.buttons),
        JSON.stringify({ closed, expanded, facts, promptLength: promptShown?.length }));
      await open(sid); await liveIdle(); await open(id); await liveIdle();
      check('N78: disclosure stays open across selection during this page lifetime', (await layout()).facts);
      await D.getByRole('button', { name: 'Details', exact: true }).click();
      await drag(10); const min = await widths();
      await drag(size.width - 10); const max = await widths();
      check(`N78: ${size.width}px divider clamps list to 200px and pane to 360px`, Math.abs(min.list - 200) <= 1 && Math.abs(max.pane - 360) <= 1, JSON.stringify({ min, max }));
      await D.locator('#mesh-grip').dblclick();
      const reset = await widths(); await D.locator('#mesh-grip').focus(); await D.keyboard.press('ArrowRight'); const right = await widths(); await D.keyboard.press('ArrowLeft'); const left = await widths();
      check('N78: divider resets to default and keyboard arrows move 16px', Math.abs(reset.list - Math.max(260, Math.round(size.width * .34))) <= 1 && right.list === reset.list + 16 && left.list === reset.list, JSON.stringify({ reset, right, left }));
    }
    await D.evaluate(() => { const C = window.__canvas; C.CMDS.find((c: PaletteItem) => c.l === 'Side pane: reset width')!.run(); C.toggleDockTerm(); });
    await D.waitForSelector('#mesh-grip', { state: 'hidden' });
    const docked = await layout(), dockDetail = await D.locator('#mesh-detail').isVisible(), dockList = await D.locator('.mesh-side').isVisible();
    await D.getByRole('button', { name: '← Sessions', exact: true }).click();
    const dockBack = !await D.locator('#mesh-detail').isVisible() && await D.locator('.mesh-side').isVisible();
    const dockListFits = await D.locator('#v-agents').evaluate(e => [...e.querySelectorAll('*')].every(child => { const r = child.getBoundingClientRect(); return !r.width || !r.height || r.right <= e.getBoundingClientRect().right + 1; }));
    await row(id).click(); await liveIdle();
    await D.evaluate(() => window.__canvas.toggleDockTerm());
    await D.waitForSelector('#mesh-grip', { state: 'visible' });
    const undocked = await widths(), undockedLayout = await layout();
    check('N78: 900×700 with the default 400px dock shows one contained pane with Sessions back; closing the dock restores both columns',
      docked.width === 500 && docked.inside && docked.overflow.length === 0 && dockDetail && !dockList && dockBack && dockListFits
      && await D.locator('.mesh-side').isVisible() && await D.locator('#mesh-detail').isVisible() && !await D.locator('.mesh-back').isVisible()
      && undocked.list >= 200 && undocked.pane >= 360 && undockedLayout.inside && undockedLayout.overflow.length === 0,
      JSON.stringify({ docked, dockDetail, dockList, dockBack, dockListFits, undocked, undockedLayout }));
    const before = await widths(), savedBefore = await D.evaluate(() => window.__canvas.S.meshW), heldGrip = (await D.locator('#mesh-grip').boundingBox())!;
    await D.mouse.move(heldGrip.x + heldGrip.width / 2, heldGrip.y + 100); await D.mouse.down(); await D.mouse.move(before.list + 70, heldGrip.y + 100, { steps: 8 });
    const changed = await widths(), dragPrompt = 'During drag: ' + prompt.slice(13);
    const activity = await report('near', 'n78-layout', { wbSession: 'n78_layout_api' }, 'prompt', dragPrompt);
    const rendered = await until(async () => (await info()).prompt === dragPrompt, 10000);
    const duringUpdate = await widths(), savedDuring = await D.evaluate(() => window.__canvas.S.meshW);
    await D.setViewportSize({ width: 920, height: 700 });
    await D.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const duringResize = await widths();
    await D.mouse.up(); const savedAfter = await D.evaluate(() => window.__canvas.S.meshW);
    await D.setViewportSize({ width: 900, height: 700 });
    check('N78: mesh activity and view resize preserve an in-progress divider drag; release saves the dragged width',
      activity === 204 && rendered && changed.list > before.list + 60 && savedDuring === savedBefore && changed.list !== savedBefore
      && Math.abs(duringUpdate.list - changed.list) <= 1 && Math.abs(duringResize.list - changed.list) <= 1 && Math.abs(savedAfter! - changed.list) <= 1,
      JSON.stringify({ activity, rendered, before, changed, savedBefore, savedDuring, duringUpdate, duringResize, savedAfter }));
    await reload(); await open(id); await liveIdle(); const restored = await widths();
    check('N78: dragging changes list width and survives reload; disclosure resets closed', changed.list > before.list + 60 && restored.list === changed.list && !(await layout()).facts, JSON.stringify({ before, changed, restored }));
    const cdp = await D.context().newCDPSession(D), grip = (await D.locator('#mesh-grip').boundingBox())!, x = grip.x + grip.width / 2, y = grip.y + 100;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 40, y, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach();
    const touched = await widths();
    check('N78: touch narrows the list while preserving both pane minima', touched.list <= restored.list - 32 && touched.list >= 200 && touched.pane >= 360, JSON.stringify({ restored, touched }));
    for (const width of [600, 320]) {
      await D.setViewportSize({ width, height: 700 }); await open(id); await liveIdle();
      const detail = await D.locator('#mesh-detail').isVisible(), list = await D.locator('.mesh-side').isVisible(), fits = await layout();
      await D.getByRole('button', { name: '← Sessions', exact: true }).click();
      check(`N78: ${width}px has no divider, one pane at a time and contained actions`, !await D.locator('#mesh-grip').isVisible() && detail && !list && fits.inside && fits.overflow.length === 0 && !await D.locator('#mesh-detail').isVisible() && await D.locator('.mesh-side').isVisible(), JSON.stringify(fits));
    }
    await D.setViewportSize(viewport);
    await report('near', 'n78-layout', { attach: { kind: 'claude', id: 'cafefeed' } });
    await row(id).click(); await switchButton('Terminal').waitFor();
    const defaultTranscript = await D.locator(composer).isVisible() && !await hasTerminal();
    let savedReader: { text: string; first: string; top: string | null | undefined } | undefined;
    if (edwin) {
      const text = Array.from({ length: 90 }, (_, i) => 'two-source line ' + i).join('\n');
      const reply = await meshApi('/sessions/n78_layout_api/prompt', 'POST', { text });
      if (!reply.ok) throw new Error('N78 two-source ACP prompt: ' + reply.status + ' ' + await reply.text());
      await readUntil('  two-source line 89');
      await liveIdle();
      await D.locator(reader + ' .ed-input').focus();
      await D.keyboard.press('g'); await D.keyboard.press('g');
      const top = (await readerState()).first;
      await D.keyboard.press('4'); await D.keyboard.press('0'); await D.keyboard.press('j');
      await D.keyboard.press('z'); await D.keyboard.press('z');
      const first = (await readerState()).first;
      if (!first || first === top) throw new Error('N78 two-source reader did not scroll away from the top');
      savedReader = { text: (await readerText())!, first, top };
    }
    await D.fill(composer, 'n78 two-source draft');
    const dualComposer = await D.locator(composer).elementHandle();
    await D.locator('#mesh-list').focus(); await D.keyboard.press('t');
    const firstViewer = await attachSid();
    const attached = await until(async () => (await attachText()).includes(H.host + ':claude:cafefeed'), 15000);
    const tucked = await dualComposer!.evaluate(e => e.isConnected) && !await D.locator(composer).isVisible();
    const readerHidden = !await D.locator(reader).isVisible();
    await D.keyboard.press('t');
    const returnedByKey = await D.locator(composer).isVisible() && !!firstViewer && await forgot(firstViewer);
    await switchButton('Terminal').click(); const secondViewer = await attachSid();
    const attachedAgain = await until(() => isAlive(secondViewer), 15000);
    await switchButton('Transcript').click();
    const restoredDraft = await dualComposer!.evaluate(e => e === document.querySelector('#mesh-detail .ag-in textarea') && (e as HTMLTextAreaElement).value === 'n78 two-source draft');
    check('N78: a joined ACP/observed row defaults to Transcript; t from the list and the button switch both ways without remounting the composer or losing its draft',
      defaultTranscript && !!attached && tucked && !!returnedByKey && !!attachedAgain && secondViewer !== firstViewer
      && !!await forgot(secondViewer) && await D.locator(composer).isVisible() && restoredDraft && await isAlive('n78_layout_api'),
      JSON.stringify({ defaultTranscript, firstViewer, secondViewer, attached, tucked, returnedByKey, attachedAgain, restoredDraft }));
    if (savedReader) {
      const shown = await D.locator(reader).isVisible();
      const first = shown ? (await readerState()).first : undefined, text = await readerText();
      check('N78: switching to Terminal and back shows the reader with the same text and first visible line',
        readerHidden && shown && first === savedReader.first && text === savedReader.text,
        { readerHidden, shown, first, before: savedReader.first, top: savedReader.top, sameText: text === savedReader.text });
    }
    await report('near', 'n78-layout', {}, 'end');
    await meshApi('/sessions/n78_layout_api?forget=true', 'DELETE');
    await open(sid); await liveIdle(); await D.locator('#mesh-grip').dblclick();
  });
}
