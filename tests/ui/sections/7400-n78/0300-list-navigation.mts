import { check } from '../../shared.mts';
import type { N78Fixture } from './fixtures.mts';

export default async function run({
  D, sid, before, row, nodes, composer, liveIdle, open, remoteCard,
}: N78Fixture) {
  // All neighbour expectations come from the actual ordered rows, not the ages of unrelated sessions.
  await D.bringToFront(); await open(sid);
  await D.locator('#mesh-list').focus();
  const { near, after } = await row(sid).evaluate(e => {
    const rows = [...e.parentElement!.querySelectorAll<HTMLElement>('.mesh-row')], i = rows.indexOf(e as HTMLElement);
    return { near: (rows[i + 1] ?? rows[i - 1])?.dataset.id, after: i + 1 < rows.length };
  });
  await D.keyboard.press(after ? 'ArrowDown' : 'ArrowUp'); const arrow = await D.evaluate(() => window.__canvas.MESH.open);
  await D.keyboard.press(after ? 'ArrowUp' : 'ArrowDown'); const back = await D.evaluate(() => window.__canvas.MESH.open);
  await D.keyboard.press(after ? 'j' : 'k'); const vim = await D.evaluate(() => window.__canvas.MESH.open);
  await D.keyboard.press(after ? 'k' : 'j'); const returned = await D.evaluate(() => window.__canvas.MESH.open);
  await liveIdle();
  await D.keyboard.press('Enter');
  const entered = await D.evaluate(composer => document.activeElement?.matches(composer), composer);
  await D.keyboard.press('Escape');
  const escaped = await D.evaluate(() => !document.querySelector('#v-agents')!.classList.contains('detail-open'));
  check('N78: Up/Down and j/k navigate ordered rows; Enter focuses the live composer and Escape returns to the list',
    !!near && arrow === near && back === sid && vim === near && returned === sid && entered && escaped, { near, arrow, back, vim, returned, entered, escaped });
  await open(sid); await liveIdle();
  await D.fill(composer, 'n78 unsent draft');
  const draftControl = await D.locator(composer).elementHandle(), draftViewer = await D.locator('#mesh-detail .mesh-live').elementHandle();
  const draftAdded = await remoteCard(true);
  const draftKept = await draftControl!.evaluate(e => e === document.querySelector('#mesh-detail .ag-in textarea') && (e as HTMLTextAreaElement).value === 'n78 unsent draft');
  const draftRemoved = await remoteCard(false);
  const viewerKept = await draftViewer!.evaluate(e => e === document.querySelector('#mesh-detail .mesh-live'));
  check('N78: another page adding and removing the card refreshes Show/Add actions without remounting the viewer or losing an unsent draft',
    !!draftAdded && !!draftRemoved && draftKept && viewerKept && await D.inputValue(composer) === 'n78 unsent draft' && await nodes() === before,
    JSON.stringify({ draftAdded, draftRemoved, draftKept, viewerKept }));
}
