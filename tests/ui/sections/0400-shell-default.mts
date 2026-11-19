import { check, section, state } from '../shared.mts';
import { settled } from '../daemon.mts';

const { A } = state;

// DELTA-1 §B.5: every new-terminal path starts the device's shell; here the agent tool's
await section('§B.5', async () => {
  const st = await A.evaluate(async () => {
    const C = window.__canvas, before = new Set(Object.keys(C.S.nodes));
    await C.AGENT_TOOLS.find((t: AgentTool) => t.name === 'create_node').run({ kind: 'shell', name: 'b5' });
    const made = Object.values<TermNode>(C.S.nodes).filter(n => !before.has(n.id)), r = { want: C.shellDefault(), got: made.map(n => n.shell) };
    made.forEach(n => C.removeNode(n.id));
    return r;
  });
  check('§B.5: a shell made by the create_node tool carries the default shell', !!st.want && st.got.length === 1 && st.got[0] === st.want, JSON.stringify(st));
  await settled(A);
});
