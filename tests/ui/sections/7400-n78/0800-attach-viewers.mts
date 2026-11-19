import { check, sleep, until } from '../../shared.mts';
import { H, dpage, ptyOf, sessions, termText } from '../../daemon.mts';
import type { N78Fixture, N78Resources } from './fixtures.mts';

export default async function run({
  D, owner, sid, ids, externalPty, before, report, row, nodes, attachSid, attachText, attachOpens,
  forgot, isAlive, open, syncBoard, hasTerminal,
}: N78Fixture, resources: N78Resources) {
  const liveText = () => termText(D, '$agents');
  const terminalFocused = () => D.evaluate(() => !!document.activeElement?.closest('#mesh-detail .xterm'));
  const attachButton = () => D.getByRole('button', { name: 'Open terminal', exact: true });

  await D.bringToFront();
  await D.evaluate(() => { if (document.body.classList.contains('side-open')) window.__canvas.toggleDockTerm(); });
  await D.setViewportSize({ width: 390, height: 844 });
  if (await D.locator('#mesh-detail .mesh-back').isVisible()) await D.locator('#mesh-detail .mesh-back').click();
  const phoneRow = row(ids['n78-claude-tmux']);
  await phoneRow.scrollIntoViewIfNeeded();
  const phoneRect = (await phoneRow.locator('.mesh-main').boundingBox())!, touch = await D.context().newCDPSession(D);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: phoneRect.x + 10, y: phoneRect.y + phoneRect.height / 2 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await touch.detach();
  await D.locator('#mesh-detail .xterm').waitFor(); const phoneSid = await attachSid();
  const tapped = await until(() => isAlive(phoneSid), 15000);
  const phoneFocused = await terminalFocused();
  await D.locator('#mesh-detail .mesh-back').click();
  check('N78: a phone tap opens and focuses the Claude terminal and Sessions back kills and forgets the viewer',
    !!tapped && phoneFocused && !!await forgot(phoneSid) && await phoneRow.isVisible() && !await hasTerminal(), JSON.stringify({ phoneSid, tapped, phoneFocused }));
  await D.setViewportSize({ width: 1500, height: 950 });

  await row(ids['n78-hubpty']).click();
  const ptyReady = await until(() => ptyOf(D, externalPty).some(w => w.hello && !w.closed));
  await D.locator('#mesh-detail .xterm-helper-textarea').focus();
  await D.keyboard.type("printf 'n78-hub-pty-%s\\n' output"); await D.keyboard.press('Enter');
  const ptyOutput = await until(async () => (await liveText()).includes('n78-hub-pty-output'), 10000);
  await row(ids['n78-readonly']).click();
  const ptySurvived = await isAlive(externalPty);
  check('N78: an externally owned hub PTY is interactive without adding a card or spawning; deselecting does not kill it',
    !!ptyReady && !!ptyOutput && ptySurvived && ptyOf(D, externalPty).every(w => w.open?.spawn === false)
    && !attachOpens().some(w => w.open?.attach === ids['n78-hubpty']) && await nodes() === before,
    JSON.stringify({ ptyReady, ptyOutput, ptySurvived, opens: ptyOf(D, externalPty).map(w => w.open) }));
  // Track the fixture's output on the wire because moving the highlight disposes its xterm.
  let output = '', typedIntoTerminal = false;
  const trackAttach = (ws: import('playwright-core').WebSocket) => {
    if (!ws.url().endsWith('/pty')) return;
    let tracked = false;
    ws.on('framesent', f => {
      const m = JSON.parse(f.payload as string) as PtyClientMsg;
      if (m.t === 'open') tracked = m.attach === ids['n78-claude-tmux'];
      if (tracked && m.t === 'in') typedIntoTerminal = true;
    });
    ws.on('framereceived', f => {
      const m = JSON.parse(f.payload as string) as PtyServerMsg;
      if (!tracked) return;
      if (m.t === 'hello') output += m.replay || '';
      if (m.t === 'out') output += m.d;
    });
  };
  D.on('websocket', trackAttach);
  const clickRow = row(ids['n78-claude-tmux']);
  await clickRow.click();
  const clickSid = await attachSid(), clickAddress = H.host + ':tmux:7:/tmp/n78-tmux/default';
  const catReady = await until(() => output.includes(clickAddress), 15000);
  const beforeJ = output, clickFocusedTerminal = await terminalFocused();
  const nextRow = await clickRow.evaluate(e => {
    const rows = [...e.parentElement!.querySelectorAll<HTMLElement>('.mesh-row')];
    return rows[rows.indexOf(e as HTMLElement) + 1]?.dataset.id;
  });
  await D.keyboard.press('j');
  const selectedAfterJ = await D.locator('#mesh-list .mesh-row.on').getAttribute('data-id');
  const clickClosed = await until(() => ptyOf(D, clickSid).some(w => w.closed));
  D.off('websocket', trackAttach);
  check('N78: a Claude row click opens the terminal without focusing it; j highlights the next row without typing into cat',
    !!catReady && !clickFocusedTerminal && !!nextRow && selectedAfterJ === nextRow && !!clickClosed && !typedIntoTerminal && output === beforeJ,
    JSON.stringify({ catReady, clickFocusedTerminal, nextRow, selectedAfterJ, clickClosed, typedIntoTerminal, beforeJ, output }));

  await row(ids['n78-claude']).click();
  const endingSid = await attachSid(), beforeEnd = await until(() => isAlive(endingSid), 15000);
  const observedTitle = await D.locator('#mesh-detail h3').elementHandle();
  const endedReport = await report('near', 'n78-claude', {}, 'end');
  const endedAction = await until(async () => !await hasTerminal() && /observed session has ended/i.test(await D.locator('#mesh-detail .mesh-hint').innerText())
    && await D.locator('#mesh-detail .mesh-info').isVisible(), 10000);
  const endedViewer = await forgot(endingSid);
  const revivedReport = await report('near', 'n78-claude');
  const revivedSid = await until(async () => (await attachText()).includes(H.host + ':claude:deadbeef') && await attachSid(), 15000);
  const observedDetailStable = await observedTitle!.evaluate(e => e === document.querySelector('#mesh-detail h3'));
  check('N78: ending the selected observed session kills its viewer and explains why; reviving reopens a fresh viewer without rebuilding detail',
    !!beforeEnd && endedReport === 204 && !!endedAction && !!endedViewer && revivedReport === 204 && !!revivedSid && revivedSid !== endingSid && observedDetailStable,
    JSON.stringify({ beforeEnd, endedReport, endedAction, endedViewer, revivedReport, revivedSid, observedDetailStable }));

  const attach = async (address: string, input: string, P = D) => {
    const sid = await attachSid(P);
    const printed = await until(async () => (await attachText(P)).includes(address), 15000);
    await P.locator('#mesh-detail .mesh-live .xterm-screen').click();
    await P.keyboard.type(input); await P.keyboard.press('Enter');
    const echoed = await until(async () => (await attachText(P)).split(input).length >= 3, 10000);
    const hidden = await P.evaluate((sid: string) => !window.__canvas.attnItems().some((i: RgEntry) => i.key === 'orphan:' + sid) && !document.querySelector(`#mesh-list .mesh-row[data-id="${sid}"]`), sid);
    return { printed, echoed, hidden, text: await attachText(P), sid, opens: ptyOf(P, sid).map(w => w.open) };
  };
  const claude = await attach(H.host + ':claude:deadbeef', 'n78-cat-claude');
  check('N78: clicking a Claude-address row opens an interactive terminal without a button, browser cmd, canvas card or orphan entry',
    !!claude.printed && !!claude.echoed && claude.hidden && !await attachButton().count()
    && claude.opens.some(o => o?.spawn && o.attach === ids['n78-claude'] && !('cmd' in o)) && await nodes() === before, JSON.stringify(claude));
  await owner.evaluate((id: string) => window.__canvas.meshOpen(id), ids['n78-claude']);
  await owner.locator(`#mesh-list .mesh-row[data-id="${ids['n78-claude']}"]`).click();
  const other = await attach(H.host + ':claude:deadbeef', 'n78-cat-other-page', owner);
  const both = await isAlive(claude.sid) && await isAlive(other.sid);
  check('N78: two pages opening the same observed row get distinct live, sid-safe attach PTYs',
    !!other.printed && !!other.echoed && other.hidden && both && claude.sid !== other.sid
    && [claude.sid, other.sid].every(s => s.length <= 64 && /^[A-Za-z0-9_-]+$/.test(s) && s.startsWith('attach_' + ids['n78-claude'] + '_')),
    JSON.stringify({ claude: claude.sid, other: other.sid, both }));
  await row(ids['n78-readonly']).click();
  const deselected = await until(async () => !(await sessions()).some(s => s.sid === claude.sid) && !await D.locator('#mesh-detail .xterm').count(), 15000);
  const still = await D.evaluate((id: string) => { const o = window.__canvas.OBS[id]; return !!o && o.endedAt === null; }, ids['n78-claude']);
  await owner.locator('#mesh-detail .mesh-live .xterm-helper-textarea').focus(); await owner.keyboard.type('n78-still-other-page'); await owner.keyboard.press('Enter');
  const otherSurvived = await until(async () => await isAlive(other.sid) && (await attachText(owner)).split('n78-still-other-page').length >= 3, 10000);
  check('N78: deselecting terminates only that page\'s attach PTY, leaving the other page\'s viewer interactive and the observed and hub sessions live',
    !!deselected && still && !!otherSurvived && await isAlive(sid), JSON.stringify({ deselected, still, otherSurvived }));
  await owner.evaluate(() => window.__canvas.setView('canvas'));
  const otherLeft = await until(async () => !(await sessions()).some(s => s.sid === other.sid), 15000);
  check('N78: leaving the second page terminates only its separate attach PTY', !!otherLeft && still, JSON.stringify({ otherLeft, sid: other.sid }));
  await syncBoard(owner, D);   // View changes are shared-board writes; do not race the two pages' saves.
  await open(ids['n78-claude-tmux']);
  await D.locator('#mesh-list').focus(); await D.keyboard.press('Enter');
  const enterFocused = await terminalFocused();
  const enteredClaude = await attach(H.host + ':tmux:7:/tmp/n78-tmux/default', 'n78-cat-enter');
  check('N78: Enter on a highlighted Claude Code row with a tmux address opens and focuses its terminal without a button',
    enterFocused && !!enteredClaude.printed && !!enteredClaude.echoed && !await attachButton().count(), JSON.stringify({ enterFocused, enteredClaude }));
  await row(ids['n78-tmux']).click();
  const manual = await attachButton().isEnabled() && !await hasTerminal() && !attachOpens().some(w => w.open?.attach === ids['n78-tmux']);
  await attachButton().click();
  const tmux = await attach('farbox:tmux:12:/tmp/n78-tmux/default', 'n78-cat-tmux');
  await D.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await D.keyboard.press('Alt+Digit1');
  const left = await until(async () => !(await sessions()).some(s => s.sid === tmux.sid) && !await D.locator('#mesh-detail .xterm').count(), 15000);
  check('N78: non-Claude tmux needs Open terminal; leaving Agents terminates its temporary PTY and the previous viewer is forgotten',
    manual && !!tmux.printed && !!tmux.echoed && tmux.hidden && !!left && !!await forgot(enteredClaude.sid)
    && await isAlive(sid) && await nodes() === before, JSON.stringify({ manual, tmux, left }));
  await syncBoard(D, owner);
  const unloadPage = resources.unloadPage = await dpage(); await unloadPage.evaluate((id: string) => window.__canvas.meshOpen(id), ids['n78-claude']);
  await unloadPage.locator(`#mesh-list .mesh-row[data-id="${ids['n78-claude']}"]`).click();
  const unloadingSid = await attachSid(unloadPage);
  const unloading = await until(() => isAlive(unloadingSid), 15000);
  await syncBoard(unloadPage, D);
  await unloadPage.close(); resources.unloadPage = undefined;
  const unloaded = await until(async () => !(await sessions()).some(s => s.sid === unloadingSid), 15000);
  check('N78: page unload terminates and forgets the attach viewer, leaving its observed session live',
    !!unloading && !!unloaded && unloadingSid !== claude.sid && unloadingSid !== other.sid && await D.evaluate((id: string) => window.__canvas.OBS[id]?.endedAt === null, ids['n78-claude']), JSON.stringify({ unloading, unloaded, unloadingSid }));

  await open(ids['n78-fail']); await row(ids['n78-fail']).click();
  const retry = D.getByRole('button', { name: 'Retry', exact: true });
  await retry.waitFor();
  const failedSid = await attachSid(), failure = await D.locator('#mesh-detail .mesh-hint').innerText();
  await D.locator('#mesh-detail .xterm-helper-textarea').focus(); await D.keyboard.press('Enter');
  await sleep(500);
  const shellOffer = /press Enter/i.test(await attachText()), failedOpens = attachOpens().filter(w => w.open?.attach === ids['n78-fail']);
  const stayedFailed = failedOpens.length === 1 && failedOpens[0].open?.id === failedSid && await attachSid() === failedSid && await retry.isVisible();
  await retry.click(); await retry.waitFor();
  const retriedSid = await attachSid();
  check('N78: a failed attach stays failed without starting a shell on Enter or retrying by itself; Retry opens a fresh attach sid',
    /exited with code 23/.test(failure) && !shellOffer && stayedFailed && retriedSid !== failedSid && !!await forgot(failedSid)
    && attachOpens().some(w => w.open?.id === retriedSid && w.open.attach === ids['n78-fail']), JSON.stringify({ failure, failedSid, retriedSid, shellOffer, stayedFailed, failedOpens: failedOpens.map(w => w.open) }));
  await row(ids['n78-readonly']).click();

  // Delay hello only at the app's message handler. The browser and relay still use the real socket.
  const pendingSid = await D.evaluate((id: string): string => {
    document.querySelector<HTMLElement>(`#mesh-list .mesh-row[data-id="${id}"]`)!.click();
    const b = window.__canvas.live.$agentsAttach.backend;
    const onmessage = b.ws.onmessage!;
    b.ws.onmessage = function (this: WebSocket, e: MessageEvent<string>) {
      if ((JSON.parse(e.data) as PtyServerMsg).t !== 'hello') onmessage.call(this, e);
    };
    return b.n.id;
  }, ids['n78-claude']);
  const received = await until(() => ptyOf(D, pendingSid).some(w => w.hello), 15000);
  const pending = await D.evaluate(() => !window.__canvas.live.$agentsAttach.backend.helloSeen);
  const running = await isAlive(pendingSid);
  await row(ids['n78-readonly']).click();
  check('N78: deselecting while the attach hello is pending kills and forgets the PTY',
    !!received && pending && running && !!await forgot(pendingSid) && !await hasTerminal(),
    JSON.stringify({ pendingSid, received, pending, running }));

  // Switch between two attaches in the mount task, before xterm's initial viewport sync.
  const lastId = ids['n78-claude-tmux'];
  const [firstSid, lastSid] = await D.evaluate((ids: string[]) => ids.map(id => {
    document.querySelector<HTMLElement>(`#mesh-list .mesh-row[data-id="${id}"]`)!.click();
    return window.__canvas.live.$agentsAttach?.backend.n.id || '';
  }), [ids['n78-claude'], lastId]);
  const onlyLastViewer = await until(async () => {
    const viewers = (await sessions()).filter(s => s.kind === 'pty' && s.sid.startsWith('attach_'));
    return viewers.length === 1 && viewers[0].sid === lastSid && viewers[0].alive;
  }, 15000);
  check('N78: two rapid Claude row clicks leave exactly one attach viewer, for the last row',
    !!firstSid && firstSid !== lastSid && !!onlyLastViewer && lastSid.startsWith('attach_' + lastId + '_') && await attachSid() === lastSid,
    JSON.stringify({ firstSid, lastSid, lastId, onlyLastViewer }));
  await row(ids['n78-readonly']).click(); await forgot(lastSid);
}
