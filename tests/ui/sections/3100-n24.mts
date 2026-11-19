import { check, sleep, state, until } from '../shared.mts';
import { pageText } from '../daemon.mts';
import { acpClick, acpEvs, acpIdle, acpSay, acpView, stubSection } from '../acp.mts';

await stubSection('N24', async () => {
  const { AP, AID } = state;
  const id = AID;
  await acpSay(AP, id, 'perm');
  await until(async () => { const v = await acpView(AP, id); return v!.perm === 1 && v!.st === 'waiting_permission'; }, 15000);
  const st = await AP.evaluate((id: string) => { const C = window.__canvas; C.statusRender(); const chip = [...document.querySelectorAll('#st-host .stc')].find(b => b.textContent!.startsWith('✦')); return { chip: chip?.textContent, bad: chip?.classList.contains('bad'), attn: C.attnItems().filter((i: RgEntry) => i.key === id).map((i: RgEntry) => i.name) }; }, id);
  check('N24: a card waiting for permission makes the ✦ chip read 1 waiting with class bad, and Attention says needs permission', /· 1 waiting$/.test(st.chip || '') && st.bad && st.attn.some((n: string) => /needs permission$/.test(n)), JSON.stringify(st));
  await acpClick(AP, id, '.ag-perm button[data-kind="allow_once"]'); await acpIdle(AP, id);
  const pg = await AP.evaluate(() => window.__canvas.addNode({ kind: 'buffer', name: 'n24', x: 3000, y: 2000, w: 420, h: 240, text: '# n24\n\n- TODO Say hello from n24\n- TODO Second n24 task\n' }).id);
  await sleep(500);
  const s1 = (await acpView(AP, id))!.seq;
  const r = await AP.evaluate(async () => { const C = window.__canvas, t = C.allTasks().find((t: TaskRow) => /Say hello from n24/.test(t.text)); try { return await C.dispatchTask(t); } catch (e) { return { error: e.message }; } });
  const prompt = await until(() => acpEvs(AP, id, 'prompt', s1).find(e => JSON.stringify(e.prompt).includes('Say hello from n24')), 10000);
  const addr = await AP.evaluate((id: string) => window.__canvas.addrOf(window.__canvas.S.nodes[id]), id), text1 = await pageText(AP, pg);
  check('N24: dispatchTask sends the task to the idle acp card and writes session:: with its address', !!addr && r.session === addr && !!prompt && text1.includes('session:: ' + addr), JSON.stringify({ r, addr, prompt: !!prompt, text1 }));
  await acpIdle(AP, id);
  await acpSay(AP, id, 'slow');
  await until(async () => (await acpView(AP, id))!.activity === 'turn', 10000);
  const r2 = await AP.evaluate(async (shell: string) => { const C = window.__canvas, t = C.allTasks().find((t: TaskRow) => /Second n24 task/.test(t.text)); try { return await C.dispatchTask(t, { shell }); } catch (e) { return { error: e.message }; } }, r.shell);
  const text2 = await pageText(AP, pg);
  check('N24: dispatch to a busy card fails with is busy and writes no session:: into the task', /is busy/.test(r2.error || '') && !/Second n24 task\n\s+session::/.test(text2), JSON.stringify({ r2, text2 }));
  await acpClick(AP, id, '.ag-row .stop'); await acpIdle(AP, id);   // N22 clicks Stop for real; here the n24 page may cover it
  await AP.evaluate((pg: string) => window.__canvas.removeNode(pg), pg);
});
