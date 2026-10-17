// The terminal encoder and decoder of desktop Edwin (edwin/native/js/term.js, DT1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/* native/js/term.js is still JavaScript: the shape the suite uses. */
interface TermEvent { type: string; key?: string; text?: string; focused?: boolean; kind?: string; value?: unknown; action?: string; x?: number; y?: number; dy?: number }
interface Decoder { feed(text: string): TermEvent[]; pending(): boolean; flush(): TermEvent[] }
interface Face { fg: string; bg: string; weight: number; italic?: boolean }
interface Model { cols: number; rows: number; faces: Face[]; lines: { x: number; w: number; text: string; f: number }[][]; cursor: { x: number; y: number; shape: string } | null }
interface Encoder { draw(m: Model): string; invalidate(): void; enter(): string; leave(): string; clipboard(text: string): string }
interface Term {
  decoder(): Decoder; encoder(opts?: { color?: string; defaultColors?: boolean }): Encoder;
  colorMode(env: Record<string, string>): string; to256(rgb: number[]): number; to16(rgb: number[]): number; b64(s: string): string;
}
const T = createRequire(import.meta.url)('../native/js/term.js') as Term;
const keys = (evs: TermEvent[]) => evs.filter(e => e.type === 'key').map(e => e.key);

test('plain bytes decode to Edwin key names', () => {
  const d = T.decoder();
  assert.deepEqual(keys(d.feed('a \r\t\x7f\x01\x1a\x00\x1f\x08é')), ['a', 'SPC', 'RET', 'TAB', 'DEL', 'C-a', 'C-z', 'C-@', 'C-_', 'C-h', 'é']);
  assert.deepEqual(keys(d.feed('😀')), ['😀']);
});

test('a lone ESC waits for the timeout; ESC and a key is Meta', () => {
  const d = T.decoder();
  assert.deepEqual(d.feed('\x1b'), []);
  assert.equal(d.pending(), true);
  assert.deepEqual(keys(d.flush()), ['ESC']);
  assert.equal(d.pending(), false);
  assert.deepEqual(keys(d.feed('\x1bx\x1b\x06\x1b\x7f')), ['M-x', 'C-M-f', 'M-DEL']);
});

test('CSI and SS3 keys, with modifiers', () => {
  const d = T.decoder();
  assert.deepEqual(keys(d.feed('\x1b[A\x1bOB\x1b[1;5C\x1b[1;3D\x1b[3~\x1b[5;2~\x1b[15~\x1bOP\x1b[Z\x1b[H\x1b[4~')),
    ['<up>', '<down>', 'C-<right>', 'M-<left>', '<deletechar>', 'S-<prior>', '<f5>', '<f1>', 'S-TAB', '<home>', '<end>']);
});

test('an escape sequence split across reads is kept until it completes', () => {
  const d = T.decoder();
  assert.deepEqual(d.feed('\x1b[1;'), []);
  assert.equal(d.pending(), true);
  assert.deepEqual(keys(d.feed('5A')), ['C-<up>']);
});

test('the kitty keyboard protocol: ESC, Ctrl and Alt keys are unambiguous', () => {
  const d = T.decoder();
  assert.deepEqual(keys(d.feed('\x1b[27u\x1b[105;5u\x1b[97;3u\x1b[13;5u\x1b[57441;2u\x1b[65;6u\x1b[97;7u')), ['ESC', 'C-i', 'M-a', 'C-RET', 'C-a', 'C-M-a']);
  assert.deepEqual(d.feed('\x1b[?1u\x1b[?62;22c'), [{ type: 'reply', kind: 'kitty', value: 1 }, { type: 'reply', kind: 'da1', value: '62;22' }]);
});

test('SGR mouse: press, drag, release and the wheel', () => {
  const d = T.decoder();
  assert.deepEqual(d.feed('\x1b[<0;10;5M\x1b[<32;11;5M\x1b[<0;11;5m\x1b[<65;3;4M\x1b[<64;3;4M').map(e => [e.action, e.x, e.y, e.dy]),
    [['down', 9, 4, undefined], ['drag', 10, 4, undefined], ['up', 10, 4, undefined], ['wheel', 2, 3, 1], ['wheel', 2, 3, -1]]);
});

test('bracketed paste arrives as one event, across reads, with CRs made newlines', () => {
  const d = T.decoder();
  assert.deepEqual(d.feed('\x1b[200~line one\r\n\x1b[A'), []);
  assert.equal(d.pending(), false);
  assert.deepEqual(d.feed('two\x1b[20'), []);
  assert.deepEqual(d.feed('1~x'), [{ type: 'paste', text: 'line one\n\x1b[Atwo' }, { type: 'key', key: 'x' }]);
});

test('focus events and the background colour reply', () => {
  const d = T.decoder();
  assert.deepEqual(d.feed('\x1b[I\x1b[O\x1b]11;rgb:ffff/ffff/f0f0\x1b\\\x1b]11;rgb:00/00/00\x07'), [
    { type: 'focus', focused: true }, { type: 'focus', focused: false },
    { type: 'reply', kind: 'background', value: '#fffff0' }, { type: 'reply', kind: 'background', value: '#000000' }]);
});

test('colour depth from the environment, and the 256 and 16 colour mappings', () => {
  assert.equal(T.colorMode({ COLORTERM: 'truecolor', TERM: 'xterm' }), 'truecolor');
  assert.equal(T.colorMode({ TERM: 'xterm-256color' }), '256');
  assert.equal(T.colorMode({ TERM: 'linux' }), '16');
  assert.equal(T.to256([255, 0, 0]), 196);
  assert.equal(T.to256([128, 128, 128]), 244);
  assert.equal(T.to256([0, 0, 0]), 16);
  assert.equal(T.to16([250, 250, 250]), 15);
  assert.equal(T.b64('é!'), 'w6kh');
});

type Run = [x: number, text: string, f: number];
const model = (rows: Run[][], cursor: Model['cursor']): Model => ({
  cols: 10, rows: rows.length, faces: [{ fg: '#000000', bg: '#ffffff', weight: 400 }, { fg: '#ff0000', bg: '#ffffff', weight: 700, italic: true }],
  lines: rows.map(r => r.map(([x, text, f]) => ({ x, w: text.length, text, f }))), cursor,
});

test('the encoder draws only the rows that changed, then the cursor with its shape', () => {
  const e = T.encoder({ color: 'truecolor' });
  const a = e.draw(model([[[0, 'hello', 0], [5, '     ', 1]], [[0, '          ', 0]]], { x: 2, y: 0, shape: 'box' }));
  assert.match(a, /^\x1b\[\?2026h/);
  assert.ok(a.includes('\x1b[1;1H\x1b[0;38;2;0;0;0;48;2;255;255;255mhello\x1b[0;1;3;38;2;255;0;0;48;2;255;255;255m     '));
  assert.ok(a.includes('\x1b[2 q') && a.endsWith('\x1b[1;3H\x1b[?25h\x1b[?2026l'));
  const b = e.draw(model([[[0, 'hello', 0], [5, '     ', 1]], [[0, 'x         ', 0]]], { x: 0, y: 1, shape: 'bar' }));
  assert.ok(!b.includes('\x1b[1;1H') && b.includes('\x1b[2;1H'), 'row 1 unchanged');
  assert.ok(b.includes('\x1b[6 q'));
  e.invalidate();
  assert.ok(e.draw(model([[[0, 'hello', 0], [5, '     ', 1]], [[0, 'x         ', 0]]], null)).includes('\x1b[1;1H'));
});

test('the encoder places text after wide characters explicitly, and masks control characters', () => {
  const e = T.encoder({ color: '256' });
  const out = e.draw(model([[[0, '日本', 0], [4, 'ab\x07', 0]]], null));
  assert.ok(out.includes('日本\x1b[1;5H'));
  assert.ok(out.includes('ab?'));
  assert.ok(out.includes('38;5;16;48;5;231'));
});

test('defaultColors draws the default face in the terminal\'s own colours', () => {
  const e = T.encoder({ color: 'truecolor', defaultColors: true });
  const out = e.draw(model([[[0, 'a', 0], [1, 'b', 1]]], null));
  assert.ok(out.includes('\x1b[0;39;49ma\x1b[0;1;3;38;2;255;0;0;49mb'));
});

test('enter and leave set and undo the terminal modes', () => {
  const e = T.encoder();
  const on = e.enter(), off = e.leave();
  for (const m of ['?1049', '?1000', '?1002', '?1006', '?2004', '?1004']) { assert.ok(on.includes('\x1b[' + m + 'h'), m); assert.ok(off.includes('\x1b[' + m + 'l'), m); }
  assert.ok(on.includes('\x1b[>1u') && off.includes('\x1b[<u'));
  assert.ok(off.includes('\x1b[0 q'));
  assert.equal(e.clipboard('hi'), '\x1b]52;c;aGk=\x1b\\');
});
