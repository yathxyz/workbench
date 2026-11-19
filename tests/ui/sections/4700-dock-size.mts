import { check, section, sleep, until } from '../shared.mts';
import { dpage, termText, typeIn } from '../daemon.mts';

// The docked terminal is never the active card: it sizes its PTY while it holds the keyboard, so widening the pane reaches the shell
await section('dock size', async () => {
  const P = await dpage(); await P.bringToFront();
  try {
    // boot mounts the dock without spawning (BOOTED is still false then); open the pane and start its shell
    await P.evaluate(() => { const C = window.__canvas; if (!(document.body.classList.contains('side-open') && C.S.sideTab === 'term')) C.toggleDockTerm(); });
    await until(() => P.evaluate(() => { const b = window.__canvas.live.dock?.backend; return !!(b?.helloSeen || b?.dead); }));
    if (await P.evaluate(() => !!window.__canvas.live.dock.backend.dead)) await typeIn(P, 'dock', '\r');
    await until(() => P.evaluate(() => { const b = window.__canvas.live.dock.backend; return !b.dead && b.helloSeen; }));
    await P.click('#side-term-body');
    const cols0 = await P.evaluate(() => window.__canvas.live.dock.term.cols);
    await P.evaluate(() => document.documentElement.style.setProperty('--pane-w', '900px'));
    await until(() => P.evaluate((c: number) => window.__canvas.live.dock.term.cols > c, cols0)); await sleep(300);
    const sz = await P.evaluate(() => { const t = window.__canvas.live.dock.term; return { cols: t.cols, rows: t.rows, focused: document.activeElement === t.textarea }; });
    await typeIn(P, 'dock', 'stty size\r');
    const seen = await until(() => termText(P, 'dock').then(x => x.includes(`${sz.rows} ${sz.cols}`)));
    check('the docked terminal holding the keyboard sizes its PTY when the pane widens', sz.focused && sz.cols > cols0 && !!seen, JSON.stringify({ cols0, sz, tail: (await termText(P, 'dock')).trim().split('\n').slice(-3) }));
  } finally { await P.close(); }
});
