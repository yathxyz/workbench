import { section, state } from '../shared.mts';
import { settled } from '../daemon.mts';
import { reportStubSkips } from '../acp.mts';

if (state.STUB) await section('acp cleanup', async () => { await state.AP.evaluate((id: string) => window.__canvas.removeNode(id), state.AID); await settled(state.AP); });
else reportStubSkips();
await state.AP?.close();
