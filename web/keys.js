/* keys.js: the board's key contexts (docs/DESIGN.md §6.4).
 *
 * Every key the board handles is a binding in one of the keymaps below, written in Edwin's key notation
 * (C- M- S- s-, RET TAB SPC ESC DEL <left> <f1>), so the same names work in Edwin frames later (K4).
 * A key walks the active layers from the top and stops at the first one that answers:
 *
 *   leader · transient (an overlay, hints, arrange) · interior (the card that has the keyboard) · view · place · global
 *
 * An interior lists the keys it needs; for those the walk ends there and the card gets the key. Only the leader
 * crosses every layer. A keymap binds a key once (K1): behaviour that depends on state is one command that branches.
 * No DOM here: the page maps command names to functions (KC in app.js), and tests/keys.test.mjs runs check() over
 * every context stack with the same resolve() the page uses.
 */
(function (root, factory) {
  const K = factory();
  if (typeof module === 'object' && module.exports) module.exports = K; else root.WBKeys = K;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- key names (Edwin's keyName, plus s- for Cmd/Super and C-S- for shifted Ctrl letters)
  const SPECIAL = { Enter: 'RET', Backspace: 'DEL', Tab: 'TAB', Escape: 'ESC', ArrowUp: '<up>', ArrowDown: '<down>', ArrowLeft: '<left>', ArrowRight: '<right>',
    Delete: '<deletechar>', Home: '<home>', End: '<end>', PageUp: '<prior>', PageDown: '<next>', Insert: '<insert>' };
  const CODEMAP = { Comma: [',', '<'], Period: ['.', '>'], Slash: ['/', '?'], Semicolon: [';', ':'], Quote: ["'", '"'], BracketLeft: ['[', '{'],
    BracketRight: [']', '}'], Backslash: ['\\', '|'], Minus: ['-', '_'], Equal: ['=', '+'], Backquote: ['`', '~'] };
  const SHIFT_DIGIT = ')!@#$%^&*(';
  const MODS = /^(Shift|Control|Alt|Meta|CapsLock|AltGraph|OS|Hyper|Super|Fn|Dead|Unidentified|Process)$/;
  function keyName(e) {
    if (!e || !e.key || MODS.test(e.key) || e.isComposing) return null;
    const C = !!e.ctrlKey, M = !!e.altKey, s = !!e.metaKey, S = !!e.shiftKey, code = e.code || '';
    let base, shiftShown = false;
    if (code === 'Space' || e.key === ' ') { base = 'SPC'; shiftShown = S; }
    else if (SPECIAL[e.key]) { base = SPECIAL[e.key]; shiftShown = S; }
    else if (/^F\d{1,2}$/.test(e.key)) { base = '<f' + e.key.slice(1) + '>'; shiftShown = S; }
    else if (C || M || s) {
      // a Latin letter as typed (Dvorak stays Dvorak); otherwise the key's position (non-Latin layouts, macOS Option)
      const letter = /^[a-zA-Z]$/.test(e.key) ? e.key.toLowerCase() : /^Key[A-Z]$/.test(code) ? code[3].toLowerCase() : null;
      if (letter) { if (S && !C && !s) base = letter.toUpperCase(); else { base = letter; shiftShown = S; } }
      else if (/^Digit\d$/.test(code)) base = S ? SHIFT_DIGIT[+code[5]] : code[5];
      else if (CODEMAP[code]) base = CODEMAP[code][S ? 1 : 0];
      else if ([...e.key].length === 1) base = e.key;
      else return null;
    } else if ([...e.key].length === 1) base = e.key;
    else return null;
    return (C ? 'C-' : '') + (M ? 'M-' : '') + (s ? 's-' : '') + (shiftShown ? 'S-' : '') + base;
  }
  // a key name as the palette and the help show it: C-S-p → Ctrl-Shift-P, M-% → Alt-Shift-5
  const LABEL = { RET: 'Enter', TAB: 'Tab', SPC: 'Space', ESC: 'Esc', DEL: 'Backspace', '<deletechar>': 'Delete', '<left>': '←', '<right>': '→', '<up>': '↑', '<down>': '↓',
    '<prior>': 'PageUp', '<next>': 'PageDown', '<home>': 'Home', '<end>': 'End' };
  function label(k) {
    if (!k) return '';
    if (k.includes(' ')) return k.split(' ').map(label).join(' ');
    let out = '', rest = k;
    const mods = { 'C-': 'Ctrl-', 'M-': 'Alt-', 's-': 'Cmd-', 'S-': 'Shift-' };
    for (;;) { const m = rest.match(/^(C-|M-|s-|S-)(.+)$/); if (!m || m[2] === '-') break; out += mods[m[1]]; rest = m[2]; }
    const d = SHIFT_DIGIT.indexOf(rest);
    if (out && d >= 0 && rest.length === 1) return out + 'Shift-' + d;
    if (LABEL[rest]) return out + LABEL[rest];
    if (/^<f\d+>$/.test(rest)) return out + 'F' + rest.slice(2, -1);
    return out + (out && /^[a-z]$/.test(rest) ? rest.toUpperCase() : rest);
  }

  // ---- the leader: the one key every layer leaves to the board. Pressed twice it goes to the card.
  const LEADERS = { 'C-SPC': 'Ctrl-Space', 'C-M-SPC': 'Ctrl-Alt-Space', '<f1>': 'F1' };
  // keys a browser keeps for itself in a normal tab (they never reach the page, or close it)
  const BROWSER = ['C-w', 'C-t', 'C-n', 'C-S-w', 'C-S-t', 'C-S-n', 'C-TAB', 'C-S-TAB', 'C-<prior>', 'C-<next>', 'C-q', 's-w', 's-t', 's-n', 's-q'];

  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const VIEWS = ['canvas', 'ranger', 'graph', 'editor', 'outline', 'tasks', 'review'];

  // ---- keymaps: [key, command, label, group]. group folds several rows into one in which-key and the help.
  const MAPS = {
    global: [
      ['C-k', 'palette.open', 'find anything (palette)'], ['s-k', 'palette.open', 'find anything (palette)'],
      ['C-S-p', 'palette.commands', 'commands'], ['s-S-p', 'palette.commands', 'commands'], [':', 'palette.commands', 'commands'],
      ['C-`', 'dock.toggle', 'docked terminal'], ['C-j', 'dock.toggle', 'docked terminal'], ['s-j', 'dock.toggle', 'docked terminal'],
      ['C-M-[', 'pane.wider', 'side pane wider'], ['C-M-]', 'pane.narrower', 'side pane narrower'],
      ['M-b', 'tree.toggle', 'folder tree'], ['M-v', 'dictate', 'dictate into the page'],
      ...VIEWS.map((v, i) => ['M-' + (i + 1), 'view.' + v, 'view: ' + v, 'Alt-1…7']),
      ...range(0, 9).map(i => ['M-' + SHIFT_DIGIT[i], 'desk.' + i, 'desk n (0 is the Board)', 'Alt-Shift-0…9']),
      ['ESC', 'esc', 'step out: tool, selection, tab, workspace, tag filter'], ['?', 'help', 'keys and gestures'],
    ],
    canvas: [
      ['h', 'card.left', 'select the neighbour card', 'h j k l'], ['j', 'card.down', 'select the neighbour card', 'h j k l'],
      ['k', 'card.up', 'select the neighbour card', 'h j k l'], ['l', 'card.right', 'select the neighbour card', 'h j k l'],
      ['H', 'card.swapLeft', 'swap with the neighbour', 'H J K L'], ['J', 'card.swapDown', 'swap with the neighbour', 'H J K L'],
      ['K', 'card.swapUp', 'swap with the neighbour', 'H J K L'], ['L', 'card.swapRight', 'swap with the neighbour', 'H J K L'],
      ['f', 'hints', 'hints: type a label to pick a card or a button'], ['.', 'card.actions', 'actions of the selected card'],
      ['m', 'arrange', 'arrange: move and resize the selected card'],
      ['RET', 'card.enter', 'type into the card, enter a folder'], ['S-RET', 'card.tab', 'open the card as a focus tab'],
      ['TAB', 'fold.toggle', 'fold the folder into a package / unfold'], ['S-TAB', 'fold.cycle', 'fold the others / unfold all'],
      ['<left>', 'pan.left', 'pan', 'arrows'], ['<right>', 'pan.right', 'pan', 'arrows'], ['<up>', 'pan.up', 'pan', 'arrows'], ['<down>', 'pan.down', 'pan', 'arrows'],
      ['-', 'zoom.out', 'zoom out'], ['=', 'zoom.in', 'zoom in'], ['+', 'zoom.in', 'zoom in'], ['z', 'zoom.card', 'the selected card at 100 %'], ['!', 'fit', 'fit everything'],
      ['M-<left>', 'camera.back', 'previous view'], ['M-<right>', 'camera.forward', 'next view'],
      ['c', 'compact', 'compact (the selection, or everything)'], ['C', 'optimise.board', 'optimise the board'], ['#', 'tag', 'tag the card'],
      ['DEL', 'selection.remove', 'remove the selection'], ['<deletechar>', 'selection.remove', 'remove the selection'],
      ['C-z', 'undo.layout', 'undo a layout change or a removal'], ['s-z', 'undo.layout', 'undo a layout change or a removal'],
      ['SPC', 'pan.hold', 'hold and drag to pan'],
      ['v', 'tool.select', 'tool: select', 'v r d o a s p t e'], ['r', 'tool.rect', 'tool: rectangle', 'v r d o a s p t e'], ['d', 'tool.diamond', 'tool: diamond', 'v r d o a s p t e'],
      ['o', 'tool.ellipse', 'tool: ellipse', 'v r d o a s p t e'], ['a', 'tool.arrow', 'tool: arrow', 'v r d o a s p t e'], ['s', 'tool.area', 'tool: select an area', 'v r d o a s p t e'],
      ['p', 'tool.pen', 'tool: pen', 'v r d o a s p t e'], ['t', 'tool.text', 'tool: text', 'v r d o a s p t e'], ['e', 'tool.erase', 'tool: eraser', 'v r d o a s p t e'],
    ],
    graph: [
      ['h', 'graph.left', 'select the neighbour node', 'h j k l'], ['j', 'graph.down', 'select the neighbour node', 'h j k l'],
      ['k', 'graph.up', 'select the neighbour node', 'h j k l'], ['l', 'graph.right', 'select the neighbour node', 'h j k l'],
      ['RET', 'graph.open', 'open the node'], ['.', 'graph.actions', 'actions of the node'], ['f', 'hints', 'hints: pick a button'],
    ],
    leader: [
      ['TAB', 'fold.toggle', 'fold / unfold (package)'], ['S-TAB', 'fold.cycle', 'fold the others / unfold all'],
      ...range(0, 9).map(i => [String(i), 'desk.' + i, 'desk n (0 is the Board)', '0…9']), ['`', 'desk.prev', 'previous desk'],
      ['m', '>leader-m', 'send the selection to desk n (x: the scratch overlay)'], ['M', '>leader-M', 'send it and go there'], ['d', '>leader-d', 'desk: new rename pin off also which delete promote sticky layout revert'],
      ['g', 'overview', 'overview of every desk'], ['w', 'ring', 'recent places: desks, tabs, views'], ['x', 'overlay', 'scratch overlay: show / hide'],
      ['!', 'attn.next', 'next item that needs a look (any desk)'],
      ['u', 'up', 'up (close focus, leave ws)'], ['RET', 'card.enter', 'enter folder, type into node'],
      ['f', 'card.tab', 'focus tab'], ['q', 'tab.close', 'close tab'], ['n', 'tab.next', 'next tab'], ['p', 'tab.prev', 'previous tab'],
      ['h', 'card.left', 'select neighbour', 'h j k l'], ['j', 'card.down', 'select neighbour', 'h j k l'], ['k', 'card.up', 'select neighbour', 'h j k l'], ['l', 'card.right', 'select neighbour', 'h j k l'],
      ['H', 'card.swapLeft', 'swap neighbour', 'H J K L'], ['J', 'card.swapDown', 'swap neighbour', 'H J K L'], ['K', 'card.swapUp', 'swap neighbour', 'H J K L'], ['L', 'card.swapRight', 'swap neighbour', 'H J K L'],
      ['e', 'folder.free', 'folder: free'], ['b', 'folder.pack', 'folder: pack'], ['t', 'folder.tile', 'folder: tile'], ['s', 'folder.stack', 'folder: stack'],
      ['E', 'folder.free*', 'same, nested folders too', 'E B T S'], ['B', 'folder.pack*', 'same, nested folders too', 'E B T S'],
      ['T', 'folder.tile*', 'same, nested folders too', 'E B T S'], ['S', 'folder.stack*', 'same, nested folders too', 'E B T S'],
      ['v', '>leader-v', 'perspective: m p f t x c u j l'], ['a', 'address', 'go to address'], ['o', 'optimise.board', 'optimise board'],
      ['O', 'optimise.folder', 'optimise folder'], ['c', 'compact', 'compact'], ['F', 'fullscreen', 'fullscreen'], ['z', 'fit', 'fit all'],
      ['#', 'tag', 'tag node'], [';', 'hints', 'hints: pick a card from anywhere'], ['/', 'palette.open', 'palette'], ['?', 'help', 'help'],
      ['ESC', 'leave', 'leave the card (on the board: cancel)'], ['C-g', 'cancel', 'cancel'],
    ],
    // desks (DESIGN §10.8): m and M take a desk number; d is the desk's own map, and d a takes a number too
    'leader-m': [...range(0, 9).map(i => [String(i), 'desk.send.' + i, 'desk n (0 takes it off this desk)', '0…9']), ['x', 'overlay.send', 'the scratch overlay (again: out of it)']],
    'leader-M': range(0, 9).map(i => [String(i), 'desk.follow.' + i, 'desk n (0: off this desk, to the Board)', '0…9']),
    'leader-da': range(1, 9).map(i => [String(i), 'desk.also.' + i, 'desk n (it stays here too)', '1…9']),
    'leader-d': [['n', 'desk.new', 'new desk with the selection'], ['r', 'desk.rename', 'rename this desk'], ['p', 'desk.pin', 'pin / unpin: in the board or this device only'],
      ['x', 'desk.off', 'take the selection off this desk'], ['a', '>leader-da', 'also on desk n (keep it here)'], ['i', 'desk.which', 'which desks hold the selected item'],
      ['k', 'desk.delete', 'delete this desk (the cards stay)'], ['b', 'desk.promote', 'promote: the Board takes their place here'],
      ['s', 'desk.sticky', 'sticky: the selected cards on every desk'], ['t', 'desk.layout', 'layout: free, tile, columns'], ['o', 'desk.open', 'open the folder as a desk'],
      ['u', 'desk.revert', 'revert to its saved state (pinned)'], ['w', 'desk.keep', 'make this its saved state (pinned)']],
    'leader-v': [['m', 'persp.manual', 'manual'], ['p', 'persp.process', 'process'], ['f', 'persp.fs', 'filesystem'], ['t', 'persp.tag', 'tags'], ['x', 'persp.tmux', 'tmux'],
      ['c', 'persp.proc', 'processes'], ['u', 'persp.unit', 'units'], ['j', 'persp.journal', 'journal'], ['l', 'persp.link', 'links']],
    // transients: the palette and the dialogs keep every key for their own inputs, except Esc
    palette: [['ESC', 'overlay.close', 'close']],
    dialog: [['ESC', 'overlay.close', 'close']],
    hints: [['ESC', 'hints.cancel', 'cancel'], ['DEL', 'hints.back', 'delete a letter']],
    // desks D2: the overview (letters search, so moving is on the arrows) and the recent-places ring
    overview: [['<left>', 'overview.left', 'move', 'arrows'], ['<right>', 'overview.right', 'move', 'arrows'], ['<up>', 'overview.up', 'move', 'arrows'], ['<down>', 'overview.down', 'move', 'arrows'],
      ['RET', 'overview.go', 'go there'], ['ESC', 'overview.close', 'stay'], ['DEL', 'overview.back', 'delete a letter'],
      ...range(0, 9).map(i => [String(i), 'overview.' + i, 'go to desk n', '0…9'])],
    ring: [['w', 'ring.next', 'next', 'w Tab ↓ →'], ['TAB', 'ring.next', 'next', 'w Tab ↓ →'], ['<down>', 'ring.next', 'next', 'w Tab ↓ →'], ['<right>', 'ring.next', 'next', 'w Tab ↓ →'],
      ['W', 'ring.prev', 'back', 'W S-Tab ↑ ←'], ['S-TAB', 'ring.prev', 'back', 'W S-Tab ↑ ←'], ['<up>', 'ring.prev', 'back', 'W S-Tab ↑ ←'], ['<left>', 'ring.prev', 'back', 'W S-Tab ↑ ←'],
      ['RET', 'ring.go', 'go'], ['SPC', 'ring.go', 'go'], ['ESC', 'ring.close', 'stay'], ...range(1, 9).map(i => [String(i), 'ring.' + i, 'go to entry n', '1…9'])],
    arrange: [
      ['h', 'arrange.left', 'move', 'h j k l'], ['j', 'arrange.down', 'move', 'h j k l'], ['k', 'arrange.up', 'move', 'h j k l'], ['l', 'arrange.right', 'move', 'h j k l'],
      ['H', 'arrange.narrower', 'resize', 'H J K L'], ['J', 'arrange.taller', 'resize', 'H J K L'], ['K', 'arrange.shorter', 'resize', 'H J K L'], ['L', 'arrange.wider', 'resize', 'H J K L'],
      ['RET', 'arrange.done', 'done'], ['m', 'arrange.done', 'done'], ['ESC', 'arrange.cancel', 'put it back'],
    ],
    // places: keys that hold only on the Board, in a workspace or in a focus tab
    board: [], workspace: [], tab: [],
  };

  // ---- interiors: the card (or field) that has the keyboard, and the keys it needs
  const ALL = () => true;
  // what a page or a text field leaves to the board: the palette, the dock, the tree, dictation, the views, the desks
  const TEXT_LEAVES = new Set(['C-k', 's-k', 'C-S-p', 's-S-p', 'C-j', 's-j', 'C-`', 'C-M-[', 'C-M-]', 'M-b', 'M-v',
    ...range(1, 7).map(i => 'M-' + i), ...range(0, 9).map(i => 'M-' + SHIFT_DIGIT[i])]);
  const INTERIORS = {
    // a terminal needs every key (readline, Emacs, vim, tmux, agents' TUIs); Ctrl-` still closes the dock from inside it
    // (leaves: every key it gives up must do something on the board, or the card lost it for nothing)
    term: { needs: k => k !== 'C-`', leaves: true, label: 'terminal' },
    page: { needs: k => !TEXT_LEAVES.has(k), leaves: true, label: 'page' },
    text: { needs: k => !TEXT_LEAVES.has(k), leaves: true, label: 'text field' },
    // an Edwin frame owns every key but the leader (edwind spec R9.7)
    edwin: { needs: ALL, label: 'Edwin frame' },
    // a focused button or link (after Tab) keeps Enter and Space, which press it; the board keeps the rest
    control: { needs: k => k === 'RET' || k === 'SPC', label: 'button' },
    // a frame (web card, artifact) receives keys itself; the board never sees them (artifacts forward the leader)
    frame: { needs: ALL, label: 'web or artifact frame' },
  };
  const TRANSIENTS = {
    palette: { map: 'palette', needs: ALL },
    dialog: { map: 'dialog', needs: ALL },
    hints: { map: 'hints', rest: 'hints.letter', swallow: true },
    overview: { map: 'overview', rest: 'overview.letter', swallow: true },
    ring: { map: 'ring', swallow: true },
    arrange: { map: 'arrange', swallow: true },
  };
  // views whose keys are a function (sequences such as gg, dd, m x): they claim these unmodified keys and decline the rest
  const VIEW_FN = {
    ranger: { fn: 'ranger', claims: ['SPC', '+', '/', '1', '2', '3', '4', '5', '?', '<down>', '<left>', '<right>', '<up>', 'DEL', '<end>', 'RET', 'ESC', 'G', '<home>',
      '<next>', '<prior>', 'S', 'e', 'f', 'h', 'j', 'k', 'l', 'n', 'o', 'r', 'v', 'd', 'D', 'g', 'p', 'y', '[', ']', 'm', "'"] },
    tasks: { fn: 'tasks', claims: ['<down>', '<up>', 'RET', 'T', 'd', 'j', 'k', 'r', 't'] },
    review: { fn: 'review', claims: ['SPC', 'RET', '1', '2', '3', '4', 'u', 's', 'b', '?', 'o', 'r'] },
  };

  const index = new Map();   // map name -> Map(key -> entry)
  function reindex() { index.clear(); for (const [name, rows] of Object.entries(MAPS)) { const m = new Map(); for (const r of rows) if (!m.has(r[0])) m.set(r[0], r); index.set(name, m); } }
  reindex();
  const bound = (map, key) => index.get(map)?.get(key) || null;

  // The layers a key walks for a context {transient, interior, view, place}. A transient replaces the interior: its
  // input has the keyboard.
  function stack(ctx) {
    const out = [];
    if (ctx.transient) { const t = TRANSIENTS[ctx.transient]; out.push({ kind: 'transient', name: ctx.transient, map: t.map, needs: t.needs, rest: t.rest, swallow: t.swallow }); }
    else if (ctx.interior) { const i = INTERIORS[ctx.interior]; out.push({ kind: 'interior', name: ctx.interior, map: null, needs: i.needs }); }
    if (ctx.view && VIEW_FN[ctx.view]) out.push({ kind: 'view', name: ctx.view, fn: VIEW_FN[ctx.view].fn, claims: new Set(VIEW_FN[ctx.view].claims) });
    if (ctx.view && MAPS[ctx.view]) out.push({ kind: 'view', name: ctx.view, map: ctx.view });
    if (ctx.place && MAPS[ctx.place]) out.push({ kind: 'place', name: ctx.place, map: ctx.place });
    out.push({ kind: 'global', name: 'global', map: 'global' });
    return out;
  }
  // The steps the page takes for KEY in CTX, in order. Each is {cmd}, {fn} (try the view's function, go on if it
  // declines), {pass} (the focused element gets the key) or {swallow} (nobody does). The leader is not resolved here.
  function resolve(ctx, key) {
    const steps = [];
    for (const l of stack(ctx)) {
      if (l.fn) { if (!/^(C-|M-|s-)/.test(key)) steps.push({ layer: l, fn: l.fn }); continue; }
      const b = l.map && bound(l.map, key);
      if (b) { steps.push({ layer: l, cmd: b[1], entry: b }); return steps; }
      if (l.rest && [...key].length === 1) { steps.push({ layer: l, cmd: l.rest }); return steps; }
      if (l.needs && l.needs(key)) { steps.push({ layer: l, pass: true }); return steps; }
      if (l.swallow) { steps.push({ layer: l, swallow: true }); return steps; }
    }
    return steps;
  }
  // The leader's own keymap (or a prefix inside it).
  function leaderResolve(key, prefix) { const b = bound(prefix || 'leader', key); return b ? { cmd: b[1], entry: b } : null; }

  // Where a command is bound, for the palette's labels: the global and canvas maps first, then the leader and its prefixes.
  function whereIs(cmd, leader = 'C-SPC') {
    for (const m of ['global', 'canvas', 'graph']) for (const r of MAPS[m]) if (r[1] === cmd) return label(r[0]);
    const walk = (map, path, depth) => {
      for (const r of MAPS[map] || []) if (r[1] === cmd) return path + ' ' + label(r[0]);
      if (depth < 2) for (const r of MAPS[map] || []) if (r[1][0] === '>') { const w = walk(r[1].slice(1), path + ' ' + label(r[0]), depth + 1); if (w) return w; }
      return '';
    };
    return walk('leader', LEADERS[leader], 0);
  }
  // Rows for which-key and the help: one row per group.
  function rows(map) {
    const out = [], seen = new Set();
    for (const r of MAPS[map] || []) {
      if (r[3]) { if (seen.has(r[3])) continue; seen.add(r[3]); out.push({ keys: r[3], label: r[2], cmd: r[1] }); }
      else out.push({ keys: label(r[0]), key: r[0], label: r[2], cmd: r[1] });
    }
    return out;
  }
  function commands() { const s = new Set(); for (const rows of Object.values(MAPS)) for (const r of rows) if (!r[1].startsWith('>')) s.add(r[1]); for (const t of Object.values(TRANSIENTS)) if (t.rest) s.add(t.rest); return s; }

  // ---- the checker: every context stack, every key
  function universe() {
    const base = [];
    for (let c = 33; c < 127; c++) base.push(String.fromCharCode(c));
    base.push('SPC', 'RET', 'TAB', 'ESC', 'DEL', '<left>', '<right>', '<up>', '<down>', '<deletechar>', '<home>', '<end>', '<prior>', '<next>', ...range(1, 12).map(i => '<f' + i + '>'));
    const keys = new Set(base);
    const lower = base.filter(k => !/^[A-Z]$/.test(k));
    for (const p of ['C-', 'M-', 's-', 'C-M-', 'C-S-', 's-S-']) for (const k of lower) {
      if (p.includes('S-') && k.length === 1 && !/[a-z]/.test(k)) continue;
      keys.add(p + k);
    }
    for (const k of ['RET', 'TAB', 'SPC', '<left>', '<right>', '<up>', '<down>']) { keys.add('S-' + k); keys.add('M-' + k); keys.add('C-' + k); }
    for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') keys.add('M-' + c);
    return [...keys];
  }
  function contexts() {
    const out = [];
    const views = [...new Set([...VIEWS])];
    for (const transient of [null, ...Object.keys(TRANSIENTS)])
      for (const interior of transient ? [null] : [null, ...Object.keys(INTERIORS)])
        for (const view of views) for (const place of ['board', 'workspace', 'tab']) out.push({ transient, interior, view, place });
    return out;
  }
  function check(opts = {}) {
    reindex();   // a caller (desks, a test) may have added rows since load
    const errors = [], warnings = [];
    // K1: one binding per key per keymap
    for (const [name, rows] of Object.entries(MAPS)) {
      const seen = new Map();
      for (const r of rows) { if (seen.has(r[0])) errors.push(`K1 ${name}: ${r[0]} is bound twice (${seen.get(r[0])}, ${r[1]})`); seen.set(r[0], r[1]); }
    }
    // the leader is reserved: no keymap binds any of the leader choices
    for (const [name, rows] of Object.entries(MAPS)) for (const r of rows) if (LEADERS[r[0]]) errors.push(`leader ${name}: ${r[0]} is a leader choice and cannot be bound`);
    // prefixes point at keymaps
    for (const [name, rows] of Object.entries(MAPS)) for (const r of rows) if (r[1].startsWith('>') && !MAPS[r[1].slice(1)]) errors.push(`prefix ${name}: ${r[0]} names no keymap ${r[1]}`);
    // keys a browser keeps are never bound
    for (const [name, rows] of Object.entries(MAPS)) for (const r of rows) if (BROWSER.includes(r[0])) errors.push(`browser ${name}: ${r[0]} is kept by the browser`);
    // K3: one way out of every interior
    if (bound('leader', 'ESC')?.[1] !== 'leave') errors.push('K3: leader ESC must be bound to leave');
    // K2: a key an interior needs never reaches an outer layer; and every stack resolves every key to one thing
    const keys = universe();
    for (const [name, i] of Object.entries(INTERIORS)) if (i.leaves) for (const key of keys)
      if (!i.needs(key) && !bound('global', key)) errors.push(`K2 ${name}: leaves ${key} to the board, which binds nothing there`);
    let stacks = 0, lookups = 0;
    for (const ctx of contexts()) {
      stacks++;
      for (const key of keys) {
        lookups++;
        const steps = resolve(ctx, key), last = steps[steps.length - 1];
        const cmds = steps.filter(s => s.cmd);
        if (cmds.length > 1) errors.push(`K1 ${JSON.stringify(ctx)} ${key}: two commands`);
        if (ctx.interior && INTERIORS[ctx.interior].needs(key) && !(last && last.pass && last.layer.kind === 'interior'))
          errors.push(`K2 ${ctx.interior}: needs ${key} but ${last ? (last.cmd || 'a function') + ' in ' + last.layer.name : 'nothing'} takes it`);
      }
    }
    // shadowing that is legal but worth a look: a view binding a key the global map also binds
    for (const v of VIEWS) for (const r of MAPS[v] || []) if (bound('global', r[0])) warnings.push(`shadow ${v}: ${r[0]} (${r[1]}) hides global ${bound('global', r[0])[1]}`);
    if (opts.commands) for (const c of commands()) if (!opts.commands.has(c)) errors.push(`command ${c} is bound but not defined`);
    return { errors, warnings, stacks, lookups };
  }

  return { keyName, label, LEADERS, BROWSER, MAPS, INTERIORS, TRANSIENTS, VIEW_FN, TEXT_LEAVES, reindex, stack, resolve, leaderResolve, bound, whereIs, rows, commands, universe, contexts, check };
});
