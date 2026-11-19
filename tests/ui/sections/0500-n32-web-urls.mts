import { check, section, state } from '../shared.mts';
import { settled } from '../daemon.mts';

const { A } = state;

// N32: web cards open only http(s); their frames never get allow-same-origin
await section('N32', async () => {
  const st = await A.evaluate(async () => {
    const C = window.__canvas, frameOf = (n: BoardNode) => C.live[n.id].frame;
    const bad = ['javascript:window.__n32=1', 'data:text/html,<script>parent.__n32=2</script>'].map(url => C.addNode({ kind: 'web', name: 'n32', url, x: 3000, y: 3000, w: 400, h: 300 }));
    const typed = C.newWeb('javascript:window.__n32=3'), ok = C.newWeb('http://127.0.0.1:9/');
    let tool; try { await C.AGENT_TOOLS.find((t: AgentTool) => t.name === 'open_web').run({ url: 'javascript:window.__n32=4' }); tool = 'ran'; } catch (e) { tool = 'refused'; }
    await new Promise(r => setTimeout(r, 300));
    const opened: string[] = [], open = window.open, tabs = (n: BoardNode) => [...C.live[n.id].el.querySelectorAll('button')].filter(b => b.textContent === '↗');
    window.open = u => { opened.push(String(u)); return null; };
    try { for (const n of [...bad, ok]) for (const b of tabs(n)) b.click(); } finally { window.open = open; }
    const r = { srcs: bad.map(n => frameOf(n).getAttribute('src')), notes: bad.map(n => C.live[n.id].note.textContent), typed: typed.url, typedSrc: frameOf(typed).getAttribute('src'), tool, ran: window.__n32 ?? null,
      okSrc: frameOf(ok).getAttribute('src'), sandbox: frameOf(ok).getAttribute('sandbox'), buttons: [...bad, ok].map(n => tabs(n).length), opened };
    for (const n of [...bad, typed, ok]) C.removeNode(n.id);
    return r;
  });
  check('N32: javascript: and data: web cards are refused; an http card\'s frame has no allow-same-origin', st.srcs.every((s: string | null) => s === null) && st.notes.every((t: string) => t.startsWith('Refused')) && st.typed === '' && st.typedSrc === null && st.tool === 'refused' && st.ran === null && st.okSrc === 'http://127.0.0.1:9/' && !/allow-same-origin/.test(st.sandbox), JSON.stringify(st));
  check('N32: ↗ opens a tab only for the http card', st.buttons.every((k: number) => k === 2) && st.opened.length === 2 && st.opened.every((u: string) => u === 'http://127.0.0.1:9/'), JSON.stringify({ buttons: st.buttons, opened: st.opened }));
  await settled(A);
});
