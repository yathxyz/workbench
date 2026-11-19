import { check, section, state } from '../shared.mts';
import { dpage } from '../daemon.mts';
import '../acp.mts';   // create the shared agent working directory before the first ACP check

// ---- fix 1: acp cards (30 §10 N17-N26; DESIGN §9.5 N27-N29, N39, N41, N42) against the stub agent: wb-fake-acp under the
// agent key `stub`, scripted by prompt keyword (DESIGN §9.2). N26 needs no agent; the others skip when /api/info lists no
// `stub`. One card (AID) carries most checks in turn; each check leaves it idle.
await section('acp boot', async () => {
  const AP = state.AP = await dpage();
  const st = await AP.evaluate(() => ({ agents: (window.__canvas.INFO?.agents || []).map((a: { name: string }) => a.name), off: document.querySelector<HTMLButtonElement>('#add-acp')!.disabled }));
  state.STUB = st.agents.includes('stub'); state.STUCK = st.agents.includes('stuck'); state.RECONNECT = st.agents.includes('reconnect');
  check('fix 1: the Agent button is enabled exactly when the server lists agents', st.off === !st.agents.length, JSON.stringify(st));
});
