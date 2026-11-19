import { check, section, until } from '../../shared.mts';
import { acpSent, toastOf } from '../../acp.mts';
import type { N78Fixture } from './fixtures.mts';

export default async function run({
  D, sid, before, edwin, nodes, composer, reader, liveView, remoteCard,
}: N78Fixture) {
  await section('N78 Edwin', async () => {
    const built = await D.evaluate(() => window.__canvas.FR.on);
    if (!built) return;
    const edit = D.locator('#mesh-detail .ag-edit');
    await edit.waitFor({ state: 'visible', timeout: 30000 });
    await D.fill(composer, 'n78 editor sends'); await edit.click();
    const editing = await until(async () => await D.locator('#mesh-detail .ag-editor-host.edwin-frame').isVisible() || (await toastOf(D)).startsWith('Prompt editor:'), 10000);
    if (!editing || !await D.locator('#mesh-detail .ag-editor-host.edwin-frame').isVisible()) throw new Error('N78 editor open: ' + await toastOf(D));
    const local = await D.evaluate(() => { const e = window.__canvas.live.$agents.backend.editor; return !!e && !e.buf.shared && /agent-prompt/.test(e.buf.name); });
    await D.keyboard.type(' edited');
    const editorFrame = await D.locator('#mesh-detail .ag-editor-host.edwin-frame').elementHandle(), editorComposer = await D.locator(composer).elementHandle();
    const editorAdded = await remoteCard(true);
    const editorKept = await editorFrame!.evaluate(e => e === document.querySelector('#mesh-detail .ag-editor-host.edwin-frame'));
    const editorText = await D.evaluate(() => window.__canvas.live.$agents.backend.editor?.buf.text);
    const editorRemoved = await remoteCard(false);
    const editorStill = await editorFrame!.evaluate(e => e === document.querySelector('#mesh-detail .ag-editor-host.edwin-frame'));
    const composerStill = await editorComposer!.evaluate(e => e === document.querySelector('#mesh-detail .ag-in textarea'));
    check('N78: card addition in another page preserves the open Edwin editor, edited draft and original composer while its actions refresh',
      !!editorAdded && !!editorRemoved && editorKept && editorStill && composerStill && editorText === 'n78 editor sends edited',
      JSON.stringify({ editorAdded, editorRemoved, editorKept, editorStill, composerStill, editorText }));
    await D.evaluate(() => window.__canvas.live.$agents.backend.editor.frame.focus());
    await D.keyboard.press('Control+c'); await D.keyboard.press('Control+c');
    const sent = await until(async () => {
      const v = await liveView();
      return v?.promptable && v.items.includes('asst:echo: n78 editor sends edited') && !await D.locator('#mesh-detail .ag-editor').count() ? v.items : null;
    }, 20000);
    await D.fill(composer, 'n78 editor restores');
    const prompts = acpSent(D, sid, 'prompt').length;
    if (edwin) await D.locator(reader + ' .ed-input').focus();
    await D.keyboard.press('Control+c'); await D.keyboard.press('Control+e'); await D.waitForSelector('#mesh-detail .ag-editor-host.edwin-frame');
    await D.keyboard.type(' edited'); await D.keyboard.press('Control+c'); await D.keyboard.press('Control+k');
    const restored = await until(async () => !await D.locator('#mesh-detail .ag-editor').count() && await D.inputValue(composer) === 'n78 editor restores edited', 10000);
    check('N78: a local unsaved Edwin prompt sends with C-c C-c; C-c C-k restores the current text without sending',
      local && !!sent && !!restored && acpSent(D, sid, 'prompt').length === prompts && await nodes() === before, JSON.stringify({ local, sent, restored, prompts, now: acpSent(D, sid, 'prompt').length }));
  });
}
