// What the page's scripts find on window besides the DOM: the vendored bundle (tools/vendor-entry.js, global V),
// the flags and sources a host page sets before app.js, and the debug surface the browser suites drive.
// Types only: nothing here reaches the browser.

type Vendor = typeof import('../tools/vendor-entry.js');

interface Window {
  V: Vendor;
  CANVAS_HOSTED?: boolean;
  CLAUDE_BRIDGE_SRC?: string;
  claude?: { use(name: string): Promise<unknown> }; // the artifact runtime: web/bridge.ts in a hosted page, claude.ai's around the board
  __canvas: Record<string, any>; // any: the suites' debug surface; each entry is typed where app.ts defines it
  __perf?: Record<string, any>; // any: the perf suite's counters, read only by tests/perf.mts
  SpeechRecognition?: { new (): SpeechRecognitionLike };
  webkitSpeechRecognition?: { new (): SpeechRecognitionLike };
}

/* The Web Speech API's recognizer, which lib.dom does not declare. */
interface SpeechRecognitionLike extends EventTarget {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: any) => void) | null; // any: SpeechRecognitionEvent is not in lib.dom
  onerror: ((e: Event & { error: string }) => void) | null; onend: (() => void) | null;
  onaudiostart: (() => void) | null;
}

/* The page clears timers it may never have set: lib.dom's clearTimeout takes undefined but not null, which the browser accepts too. */
declare function clearTimeout(id: number | null | undefined): void;
declare function clearInterval(id: number | null | undefined): void;

// ---- web/keys.ts (WBKeys): the board's key contexts. Names are Edwin key notation: C-k, M-<left>, RET, <f1>.

/* A keymap row: key, command (">map" names a prefix keymap), label, and the group that folds rows in which-key. */
type WBKeyRow = [key: string, cmd: string, label: string, group?: string];
/* The fields of a keydown keyName() reads; a KeyboardEvent is one. */
interface WBKeyNameEvent {
  key: string; code?: string; isComposing?: boolean;
  ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; shiftKey?: boolean;
}
type WBKeyTransientName = 'palette' | 'dialog' | 'hints' | 'overview' | 'ring' | 'arrange';
type WBKeyInteriorName = 'term' | 'page' | 'text' | 'edwin' | 'control' | 'frame' | 'pdf';
type WBKeyPlace = 'board' | 'workspace' | 'tab';
/* The views whose keys are a function of the page (VIEW_FN). */
type WBKeyViewFnName = 'ranger' | 'tasks' | 'review';
/* Where the keyboard is: an overlay, the card that has it, the view and the place. */
interface WBKeyContext {
  transient: WBKeyTransientName | null;
  interior: WBKeyInteriorName | null;
  view: string;
  place: WBKeyPlace;
}
/* A card (or field) that has the keyboard: the keys it needs; leaves: every key it gives up must be bound globally. */
interface WBKeyInterior { needs: (key: string) => boolean; leaves?: boolean; label: string; map?: string }
/* An overlay's layer: its keymap, the keys its input needs, the command for any other single character, and
 * whether it swallows the rest. */
interface WBKeyTransient { map: string; needs?: (key: string) => boolean; rest?: string; swallow?: boolean }
interface WBKeyViewFn { fn: WBKeyViewFnName; claims: string[] }
/* One layer of the walk stack() builds. */
interface WBKeyLayer {
  kind: 'transient' | 'interior' | 'view' | 'place' | 'global';
  name: string;
  map?: string | null;
  needs?: (key: string) => boolean;
  rest?: string;
  swallow?: boolean;
  fn?: WBKeyViewFnName;
  claims?: Set<string>;
}
/* A step of resolve(): a command, the view's function to try, pass (the focused element gets the key) or swallow. */
type WBKeyStep =
  | { layer: WBKeyLayer; cmd: string; entry?: WBKeyRow; fn?: never; pass?: never; swallow?: never }
  | { layer: WBKeyLayer; fn: WBKeyViewFnName; cmd?: never; entry?: never; pass?: never; swallow?: never }
  | { layer: WBKeyLayer; pass: true; cmd?: never; entry?: never; fn?: never; swallow?: never }
  | { layer: WBKeyLayer; swallow: true; cmd?: never; entry?: never; fn?: never; pass?: never };
/* A row of which-key and the help: one per group (keys is then the group's name, and key is absent). */
interface WBKeyHelpRow { keys: string; key?: string; label: string; cmd: string }
interface WBKeyCheckResult { errors: string[]; warnings: string[]; stacks: number; lookups: number }
/* What keys.ts's factory returns (window.WBKeys in the page, module.exports under Node). */
interface WBKeysAPI {
  keyName(e: WBKeyNameEvent | null | undefined): string | null;
  label(k: string): string;
  LEADERS: Record<string, string>;
  BROWSER: string[];
  MAPS: Record<string, WBKeyRow[]>;
  INTERIORS: Record<WBKeyInteriorName, WBKeyInterior>;
  TRANSIENTS: Record<WBKeyTransientName, WBKeyTransient>;
  VIEW_FN: Record<string, WBKeyViewFn>;
  TEXT_LEAVES: Set<string>;
  reindex(): void;
  stack(ctx: WBKeyContext): WBKeyLayer[];
  resolve(ctx: WBKeyContext, key: string): WBKeyStep[];
  leaderResolve(key: string, prefix?: string | null): { cmd: string; entry: WBKeyRow } | null;
  bound(map: string, key: string): WBKeyRow | null;
  whereIs(cmd: string, leader?: string): string;
  rows(map: string): WBKeyHelpRow[];
  commands(): Set<string>;
  universe(): string[];
  contexts(): WBKeyContext[];
  check(opts?: { commands?: Set<string> }): WBKeyCheckResult;
}
declare var WBKeys: WBKeysAPI;
