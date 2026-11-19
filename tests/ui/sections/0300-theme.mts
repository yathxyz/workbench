import { check, section, sleep, state } from '../shared.mts';
import { settled } from '../daemon.mts';

const { A } = state;

// DELTA-1 §A.5 in both schemes: square corners, Modus backgrounds, the terminal theme, the mono face, no blur
await section('§A.5', async () => {
  const MODUS = { light: { bgDim: 'rgb(239, 233, 221)', bgMain: '#fbf7f0' }, dark: { bgDim: 'rgb(29, 34, 53)', bgMain: '#0d0e1c' } };
  const looks = () => A.evaluate(() => {
    const C = window.__canvas, cs = (sel: string, k: keyof CSSStyleDeclaration) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[k] : null; };
    const term = Object.values<LiveEntry>(C.live).find(L => L.term)?.term;
    const blurred = [];
    for (const e of document.querySelectorAll('*')) for (const ps of [null, '::before', '::after']) {
      const bs = getComputedStyle(e, ps).boxShadow; if (!bs || bs === 'none') continue;
      for (const sh of bs.split(/,(?![^(]*\))/)) { const n = sh.replace(/[a-z-]+\([^)]*\)|inset/g, '').trim().split(/\s+/).map(parseFloat); if ((n[2] || 0) > 0) blurred.push((e.id || e.className || e.tagName) + (ps || '') + ': ' + bs); }
    }
    return {
      radius: ['.node', '#add-shell', '#add-web', '#pal-in', '.frame.shape-round'].map(s => cs(s, 'borderTopLeftRadius')), body: cs('body', 'backgroundColor'),
      edgeLabels: document.querySelectorAll('#edges rect').length, pills: [...document.querySelectorAll('#edges rect')].filter(r => parseFloat(r.getAttribute('rx') || 0 as unknown as string) > 0).length,
      termBg: term?.options.theme.background?.toLowerCase(),
      fontCheck: document.fonts.check('13px "JetBrainsMono Nerd Font Mono"'),
      fontLoaded: [...document.fonts].some(f => f.family.replace(/"/g, '') === 'JetBrainsMono Nerd Font Mono' && f.status === 'loaded'),
      blurred: blurred.slice(0, 5),
    };
  });
  for (const [scheme, how] of [['light', 'auto'], ['dark', 'auto'], ['dark', 'dark'], ['light', 'light']] as ['light' | 'dark', 'light' | 'dark' | 'auto'][]) {
    await A.emulateMedia({ colorScheme: how === 'auto' ? scheme : scheme === 'dark' ? 'light' : 'dark' });   // the override must beat the system scheme
    await A.evaluate(t => window.__canvas.setTheme(t), how); await sleep(300);
    const l = await looks(), m = MODUS[scheme];
    check(`§A.5 ${scheme} (${how === 'auto' ? 'prefers-color-scheme' : 'data-theme'}): radius 0, square edge labels, Modus backgrounds, terminal bg-main, mono face loaded, no blurred shadow`,
      l.radius.every(r => r === '0px') && l.edgeLabels > 0 && !l.pills && l.body === m.bgDim && l.termBg === m.bgMain && l.fontCheck && l.fontLoaded && !l.blurred.length, JSON.stringify(l));
  }
  await A.evaluate(() => window.__canvas.setTheme('auto')); await A.emulateMedia({ colorScheme: 'light' }); await settled(A);
  // the graph view's glyphs are canvas paths, out of reach of computed styles
  const g = await A.evaluate(async () => {
    const C = window.__canvas, P = CanvasRenderingContext2D.prototype as CanvasRenderingContext2D & Record<string, Function>, keep: Record<string, Function> = { roundRect: P.roundRect, rect: P.rect }, n: Record<string, number> = { roundRect: 0, rect: 0 };
    for (const k in keep) P[k] = function (this: unknown, ...a: unknown[]) { n[k]++; return keep[k].apply(this, a); };
    try { C.setView('graph'); await new Promise(r => setTimeout(r, 800)); } finally { Object.assign(P, keep); C.setView('canvas'); }
    return n;
  });
  check('§A.5: the graph view draws square glyphs, never a rounded rectangle', g.rect > 0 && g.roundRect === 0, JSON.stringify(g));
});
