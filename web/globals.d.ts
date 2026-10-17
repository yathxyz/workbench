// What the page's scripts find on window besides the DOM: the vendored bundle (tools/vendor-entry.js, global V),
// the flags and sources a host page sets before app.js, and the debug surface the browser suites drive.
// Types only: nothing here reaches the browser.

type Vendor = typeof import('../tools/vendor-entry.js');

interface Window {
  V: Vendor;
  CANVAS_HOSTED?: boolean;
  CLAUDE_BRIDGE_SRC?: string;
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
  onerror: ((e: Event) => void) | null; onend: (() => void) | null;
}
