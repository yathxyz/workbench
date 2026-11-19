import type * as TailPw from 'playwright-core';
import { check, section, until, watchErrors } from '../../shared.mts';
import { ctx, ORIGIN } from '../../daemon.mts';
import { acpIdle } from '../../acp.mts';
import type { N78Fixture } from './fixtures.mts';

export default async function run({ sid, ids, edwin, composer, reader, log }: N78Fixture) {
  await section('N78 fallback journal', async () => {
    const P = await ctx.newPage(); watchErrors(P);
    let allowEdwin!: () => void, edit: TailPw.WebSocketRoute | undefined, online = true;
    const gate = new Promise<void>(r => { allowEdwin = r; });
    try {
      await P.route('**/edwin/manifest.json', async route => { await gate; await route.continue(); });
      await P.routeWebSocket(/\/edit$/, ws => {
        if (!online) { ws.close({ code: 1011 }); return; }
        edit = ws; ws.connectToServer();
      });
      await P.goto(ORIGIN + '/'); await P.waitForFunction(() => window.__canvas?.BOOTED);
      await P.waitForFunction(sid => !!window.__canvas.SESS[sid], sid);
      await P.evaluate(sid => window.__canvas.meshOpen(sid), sid);
      const initial = !!await acpIdle(P, '$agents') && (await P.locator(log).textContent())?.includes('echo: n78 original conversation');
      await P.fill(composer, 'n78 DOM journal'); await P.press(composer, 'Enter');
      const reply = await until(async () => (await P.locator(log).textContent())?.includes('echo: n78 DOM journal'));
      check('N78: without ready Edwin the DOM journal still replays and displays a new prompt and reply', initial && reply && !await P.locator(reader).count());
      if (!edwin) return;
      allowEdwin();
      await P.waitForFunction(() => window.__canvas.FR.ready && window.__canvas.FR.online);
      const focused = await P.locator(composer).evaluate(e => e === document.activeElement);
      await P.locator(composer).press('Escape');
      const kept = await P.locator(log).count() === 1 && !await P.locator(reader).count();
      await P.evaluate(({ sid, other }) => { window.__canvas.meshOpen(other); window.__canvas.meshOpen(sid); }, { sid, other: ids['n78-readonly'] });
      const mounted = await P.locator(reader + '.edwin-frame').elementHandle();
      check('N78: readiness does not replace the focused DOM viewer, but the next mount uses Edwin', focused && kept && !!mounted && !await P.locator(log).count());

      online = false; edit!.close({ code: 1011 });
      if (!await acpIdle(P, '$agents')) throw new Error('N78 remounted ACP viewer did not finish replay');
      await P.waitForFunction(() => !window.__canvas.FR.online);
      await P.fill(composer, 'n78 local reader offline'); await P.press(composer, 'Enter');
      await P.waitForFunction(() => window.__canvas.live.$agents?.backend.transcript?.buf.text.includes('echo: n78 local reader offline'));
      check('N78: the same local reader continues receiving ACP text after losing edwind',
        await mounted?.evaluate(e => e === document.querySelector('#mesh-detail .ag-reader')) && !await P.locator(log).count());
    } finally { allowEdwin(); await P.close(); }
  });
}
