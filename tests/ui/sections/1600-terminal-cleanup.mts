import { section, state } from '../shared.mts';
import { settled } from '../daemon.mts';

const { T, tid, A } = state;

await section('cleanup', async () => { await T.evaluate(id => window.__canvas.removeNode(id), tid!); await settled(T); await T.close(); await A.close(); });
