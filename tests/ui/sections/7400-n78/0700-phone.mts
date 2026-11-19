import { check, section } from '../../shared.mts';
import { dpage } from '../../daemon.mts';
import type { N78Fixture } from './fixtures.mts';

export default async function run({ sid, ids, edwin, reader }: N78Fixture) {
  await section('N78 phone', async () => {
    // Start from the saved board, not the tab used for the cross-tab board edits above.
    const P = await dpage();
    try {
      await P.setViewportSize({ width: 390, height: 844 });
      await P.waitForFunction(sid => !!window.__canvas.SESS[sid], sid);
      if (edwin) await P.waitForFunction(() => window.__canvas.FR.ready && window.__canvas.FR.online);
      await P.evaluate(other => {
        const C = window.__canvas;
        if (document.body.classList.contains('side-open')) C.toggleDockTerm();
        C.meshOpen(other);
      }, ids['n78-readonly']);
      const back = P.locator('#mesh-detail .mesh-back');
      await back.click();
      const listPhone = await P.evaluate(() => { const v = document.querySelector('#v-agents')!, l = document.querySelector('#mesh-list')!; return !v.classList.contains('detail-open') && l.getBoundingClientRect().width <= innerWidth && l.getBoundingClientRect().width > 0; });
      await P.locator(`#mesh-list .mesh-row[data-id="${sid}"]`).click();
      if (edwin) await P.locator(reader + '.edwin-frame').waitFor();
      const detailPhone = await P.evaluate((reader: string) => {
        const v = document.querySelector('#v-agents')!, d = document.querySelector('#mesh-detail')!, f = document.querySelector(reader), box = d.getBoundingClientRect();
        return v.classList.contains('detail-open') && box.width <= innerWidth && box.width > 0 && d.scrollWidth <= d.clientWidth
          && document.documentElement.scrollWidth <= innerWidth && (!f || (f as HTMLElement).offsetWidth === (f.parentElement as HTMLElement).clientWidth);
      }, reader);
      await back.click();
      check('N78: below 700 px the list and selected detail fit the screen, and Sessions returns to the list',
        listPhone && detailPhone && await P.locator(`#mesh-list .mesh-row[data-id="${ids['n78-readonly']}"]`).isVisible(), { listPhone, detailPhone });
    } finally { await P.close(); }
  });
}
