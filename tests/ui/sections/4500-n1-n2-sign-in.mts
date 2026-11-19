import { check, section, sleep, until } from '../shared.mts';
import { dpage, puts } from '../daemon.mts';
import { caddyMode, hasCaddyModes, skipCaddy } from '../caddy.mts';

if (!hasCaddyModes) for (const n of ['N1', 'N2']) skipCaddy(n);
else {
  const LS_KEY = 'canvas-proto-board-v5';
  for (const [n, mode, kind] of [['N1', 'loginpage', 'not_json'], ['N2', 'expired', 'signed_out']]) await section(n, async () => {
    caddyMode(mode); const t0 = Date.now();
    const P = await dpage(false);
    try {
      await until(() => P.evaluate(() => !document.querySelector<HTMLElement>('#boot-msg')!.hidden), 8000); await sleep(800);
      const st = await P.evaluate((k: string) => ({ shown: !document.querySelector<HTMLElement>('#boot-msg')!.hidden, kind: document.querySelector<HTMLElement>('#boot-msg')!.dataset.kind, s: !!window.__canvas.S, ls: localStorage.getItem(k) }), LS_KEY);
      check(`${n}: booting against the ${mode} mode shows the boot screen, keeps S null, writes no localStorage board and sends no PUT`, st.shown && st.kind === kind && !st.s && st.ls === null && !puts(t0).length, JSON.stringify(st));
    } finally { await P.close(); caddyMode('live'); }
  });
}
