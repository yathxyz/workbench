import { check, skip, state, until } from '../shared.mts';
import { ACWD, acpView, stubSection } from '../acp.mts';

// N39 needs an agent that only SIGKILL ends: `stuck` = wb-fake-acp --scenario kill-stubborn, which ignores EOF and SIGTERM
// and never ends a prompt (the keyword stub has no such prompt). The name shares no fuzzy match with `stub` (acpNew).
await stubSection('N39', async () => {
  const { AP, STUCK } = state;
  if (!STUCK) return skip('N39', 'no `stuck` agent (wb-fake-acp --scenario kill-stubborn) in /api/info.agents');
  const id = await AP.evaluate((cwd: string) => window.__canvas.addNode({ kind: 'acp', name: 'n39', agent: 'stuck', cwd, x: 3000, y: 2600, w: 560, h: 400 }).id, ACWD);
  await until(async () => (await acpView(AP, id))?.promptable, 20000);
  await AP.evaluate((id: string) => window.__canvas.live[id].backend.input('n39\r'), id);   // a turn that never ends
  const turn = await until(async () => (await acpView(AP, id))!.activity === 'turn', 10000);
  await AP.evaluate((id: string) => {
    const L = window.__canvas.live[id], b = L.hdr.querySelector('.badge'), s = L.body.querySelector('.ag-state'); window.__n39 = [];
    new MutationObserver(() => window.__n39.push(b.textContent + ' | ' + (s.hidden ? '' : s.textContent))).observe(L.el, { childList: true, characterData: true, subtree: true, attributes: true });
  }, id);
  const e0 = (await acpView(AP, id))!.epoch;
  await AP.evaluate((id: string) => { const C = window.__canvas; C.jumpNode(C.S.nodes[id]); C.CMDS.find((c: PaletteItem) => c.l.startsWith('Agent: start a new session')).run(); }, id);
  const fresh = await until(async () => { const v = await acpView(AP, id); return v!.promptable && v!.epoch !== e0 ? v : null; }, 40000);
  const seen = await AP.evaluate(() => [...new Set(window.__n39)]);
  check('N39: Start new session on a card whose agent ignores SIGTERM shows ending…, then a fresh transcript, never ended elsewhere', !!turn && seen.some(t => /ending…/.test(t)) && !seen.some(t => /· ended |ended elsewhere/.test(t)) && !!fresh && fresh.asst === 0, JSON.stringify({ turn: !!turn, seen: seen.slice(0, 12), fresh: fresh && fresh.items }));
  await AP.evaluate((id: string) => window.__canvas.removeNode(id), id);
});
