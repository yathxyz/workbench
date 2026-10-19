// The board's data model, shared by the page (app.ts) and the browser suites (tests/): types only.
// Ambient (no import or export at the top level): every name here is global to web/ and tests/. app.ts's classes
// (PtyBackend, AcpBackend, TextDoc, Rpc ...) live inside its wrapper function, so the shapes other code relies on are
// written here as interfaces those classes can `implements`. Names avoid lib.dom's globals (Node, Text, Range ...).

// ---- JSON and small helpers

/* Any value JSON can carry (artifact db documents, ACP payloads, tool results). */
type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
/* A JSON object. */
type JsonObject = { [k: string]: JsonValue };
/* A card rectangle as desks and perspective snapshots store it: [x, y, w, h]. */
type BoardRect = [number, number, number, number];
/* The camera: world offset and zoom (S.cam, S.views[name], G.cam). */
interface Cam { x: number; y: number; z: number }
/* A point in world or screen space. */
interface BoardPoint { x: number; y: number }
/* A width and height (prePack, fit). */
interface BoardSize { w: number; h: number }

// ---- the persisted board: S (app.ts line 29)

/* Every node kind on the board (the `kind` tag of BoardNode). */
type NodeKind = 'term' | 'repl' | 'buffer' | 'ref' | 'agent' | 'acp' | 'frame' | 'artifact' | 'web' | 'sketch' | 'image' | 'pdf' | 'op' | 'ghost';

/* The persisted board, S: what /api/board and localStorage hold (v 5; a reset writes {"v":0}). Keys starting with _ are never saved. */
interface Board {
  v: number;
  nodes: Record<string, BoardNode>;
  edges: Edge[];
  strokes: Stroke[];
  shapes: Shape[];
  views: Record<string, Cam>;          // saved camera bookmarks by name
  cam: Cam;
  fs: FakeFsDir;                       // the demo shell's file system (seedFs)
  fresh?: boolean;                     // a board just seeded, not yet touched
  // desks (v17)
  desks?: Desk[];
  sticky?: string[];                   // ids shown on every desk
  // view keys: stripped on save (VIEW_KEYS), kept per window in BoardViewState
  ws?: string | null;                  // the folder the workspace view is in
  focusTabs?: string[];
  persp?: PerspName;
  manual?: PerspSnapshot;              // the manual layout, saved while a derived perspective shows
  // UI state
  treeW?: number;
  tree?: boolean;                      // the outline sidebar is open
  treeClosed?: Record<string, boolean>;
  paneW?: number;
  side?: boolean;                      // the side pane is open
  sideTab?: 'chat' | 'term';
  docks?: Record<string, boolean>;
  theme?: BoardTheme;
  view?: ViewName;
  edPage?: string;                     // the page the editor view shows
  recentCmds?: string[];
  rgBookmarks?: Record<string, string>; // navigator bookmarks: letter -> key
  noOverlap?: boolean;
  leader?: LeaderName;
  modeToastShown?: boolean;
  reviews?: ReviewLine[];              // the demo build's review log
  // legacy
  chat?: LegacyAgentNode;              // the old side-pane agent (id 'chat'); migrateV9 deletes it
  dockTerm?: TermNode;                 // the dock terminal (id 'dock'); never in nodes
}

/* The colour scheme setting. */
type BoardTheme = 'light' | 'dark' | 'auto';
/* The main views (VIEWS, line 4256). */
type ViewName = 'canvas' | 'ranger' | 'graph' | 'editor' | 'outline' | 'tasks' | 'review';
/* A leader key name (LEADERS, line 7721). */
type LeaderName = 'C-SPC' | 'C-M-SPC' | 'F1';
/* A perspective: the manual layout or one derived from the host (PERSP). */
type PerspName = 'manual' | 'process' | 'fs' | 'tag' | 'tmux' | 'proc' | 'unit' | 'journal' | 'link';

/* Fields every node has, whatever its kind. */
interface BoardNodeBase {
  id: string;
  kind: NodeKind;
  name: string;
  x: number; y: number; w: number; h: number;
  in?: string | null;                  // the folder (frame) holding it
  order?: number;                      // position among its folder's items
  tags?: string[];
  hostUrl?: string;                    // the host it runs on ('' or absent: the serving daemon)
  prePack?: BoardSize;                 // its size before a pack folder resized it
  preTile?: { w: number; h: number; dx?: number; dy?: number };
  tile?: TileSlot | null;
  tfact?: number;                      // its share of a tile split
  spawnFrom?: string;                  // the node it was spawned from
  agg?: string;                        // the aggregator folder that holds its spawns
  snap?: string;                       // a page's cached first lines
  _spawn?: unknown;                    // transient spawn hints; never saved
  _pk?: BoardPoint & BoardSize;        // transient pack bookkeeping; never saved
}
/* Where a card sits in a tile folder's split. */
interface TileSlot { axis: 'x' | 'y' | null; avail: number; first?: boolean }

/* A shell card: a PTY on a daemon (or tmux session), or the demo's FakeShell. */
interface TermNode extends BoardNodeBase {
  kind: 'term';
  backend: 'pty' | 'fake';
  cmd?: string; cwd?: string; env?: Record<string, string>; shell?: string; spawnNote?: string;
  tmux?: string;                       // the tmux target it was adopted from
  tmuxSess?: string; tmuxAdopted?: boolean; tmuxHost?: string; tmuxState?: string;
  fg?: string;                         // the foreground command
  cwdLive?: string;                    // the cwd the PTY last reported
  emacs?: string;                      // a file an emacs card opened
  inputLog?: string;
  _replay?: string;
}
/* A REPL card: the demo's JS REPL, or a command REPL. */
interface ReplNode extends BoardNodeBase {
  kind: 'repl';
  lang: 'js' | 'cmd';
  history?: string[]; replayFrom?: string; backend?: 'pty' | 'fake'; cmd?: string;
  inputLog?: string; _replay?: string;
  tmux?: string; cwdLive?: string;
}
/* A page (kind 'buffer'): its file in edwind (buf), edited in Edwin frames; a page not yet migrated, or on a board without edwind, keeps its Markdown in text. */
interface PageNode extends BoardNodeBase {
  kind: 'buffer';
  text?: string;
  anchors?: PageAnchor[];
  buf?: string;                        // its edwind buffer id, e.g. notes/x.md
  artifactOf?: string;                 // the artifact card it is the source of
}
/* A named position in a page. */
interface PageAnchor { id: string; label?: string | null; pos: number; quote?: string; prefix?: string }
/* A reference card: an excerpt pinned from another node. */
interface RefNode extends BoardNodeBase {
  kind: 'ref';
  text: string;
  src: { node: string; aid?: string; line?: number; lines?: number; page?: number; prefix?: string; suffix?: string };   // page, prefix, suffix: a quote from a PDF (W3C TextQuoteSelector)
  srcLabel: string;
}
/* The legacy in-page agent card (kind 'agent'). */
interface LegacyAgentNode extends BoardNodeBase {
  kind: 'agent';
  log: LegacyAgentLogItem[];
  turns: { role: string; content: unknown }[];
  tier: 'quick' | 'default' | 'complex';
}
/* One line of a legacy agent card's transcript. */
interface LegacyAgentLogItem { t: 'user' | 'assistant' | 'note' | 'tool'; text?: string; live?: boolean; name?: string; args?: string; res?: string }   // args, res: JSON, cut short
/* An ACP agent card: a session of an agent the hub runs. */
interface AcpNode extends BoardNodeBase {
  kind: 'acp';
  agent: string;
  cwd: string;
}
/* A folder (kind 'frame'): holds items through their `in`; derived folders come from a perspective. */
interface FrameNode extends BoardNodeBase {
  kind: 'frame';
  mode: FrameMode;
  shape: 'folder' | 'box' | 'round';
  packed?: boolean; prevMode?: FrameMode; openW?: number; openH?: number;
  fit?: BoardSize; packScale?: number; mfact?: number; aspect?: string | number;
  owner?: string;                      // the node a process or proc folder belongs to
  host?: FolderHost;                   // a host folder's host
  derived?: FrameDerived;
  tag?: string;                        // tag folders
  fsHost?: string; fsPath?: string; fsListed?: boolean;      // fs folders
  procHost?: string; procPid?: number;                      // proc folders
  unitName?: string; unitState?: string; unitHost?: string; // unit folders
  tmuxSess?: string; tmuxHost?: string; tmuxState?: string; // tmux folders
  mount?: boolean | string; linkTitle?: string;
  suspended?: boolean; buried?: boolean | number;
}
/* How a folder lays out its items ('ribbon' is migrated to 'tile'). */
type FrameMode = 'free' | 'pack' | 'tile' | 'stack';
/* Which perspective made a derived folder. */
type FrameDerived = 'process' | 'fs' | 'tag' | 'tmux' | 'proc' | 'unit' | 'journal' | 'link';
/* The host a host folder stands for (a copy of a Host). */
interface FolderHost { name: string; url?: string; token?: string }
/* An artifact card: a sandboxed HTML page with capabilities and a small database. */
interface ArtifactNode extends BoardNodeBase {
  kind: 'artifact';
  html?: string; head?: string;
  versions?: ArtifactVersion[];
  url?: string;
  files?: Record<string, string>;
  capabilities: Record<string, object>;
  grants: Record<string, 'granted' | 'denied'>;
  db: { docs: Record<string, unknown> };
  file?: string; fileMtime?: number;   // an artifact opened from a file
  block?: { page: string; id: string }; // a block torn out of a page
  meta?: unknown;
  _poll?: number | null; _dbT?: number; _dbErr?: number;
}
/* One published version of an artifact. */
interface ArtifactVersion { sha: string; at: string; html: string }
/* A web card: an iframe on a URL. */
interface WebNode extends BoardNodeBase { kind: 'web'; url: string }
/* A sketch card: ink only, its strokes carry its id as owner. */
interface SketchNode extends BoardNodeBase { kind: 'sketch' }
/* An image card: a blob on the daemon, or a data URL in the demo. */
interface ImageNode extends BoardNodeBase {
  kind: 'image';
  blob?: string;                       // sha256 of the stored image
  src?: string; mime?: string; iw?: number; ih?: number;
  at?: { node: string; page: number; y: number };   // a peek: the PDF card, page (from 1) and point (PDF units from the top) it shows
}
/* A PDF card (F-A40): a file on the serving host (`path`), or bytes in the blob store (`blob`; `src`, a data: URL, in the demo). */
interface PdfNode extends BoardNodeBase {
  kind: 'pdf';
  path?: string; blob?: string; src?: string;
  pos?: { page: number; y: number };   // the reading position, shared like a bookmark: page from 1, fraction of it scrolled past
  pages?: number;                      // the page count, once known
}
/* What a media card does (F-A41): images from text, an image from an image and text (a provider of the server's), or
 * text from an image or from text (`sample`). */
type OpKind = 'imagine' | 'edit' | 'describe' | 'expand';
/* A media card: a prompt and settings; its inputs come along the pipe edges into it, its output stays in the card. */
interface OpNode extends BoardNodeBase {
  kind: 'op';
  op: OpKind;
  prompt: string;
  provider?: string; model?: string; size?: string; n?: number;
  out?: OpOut;
}
/* A media card's last run: the signature of what it ran on, and its images or text, or the error. */
interface OpOut { sig: string; at: number; images?: OpImage[]; pick?: number; text?: string; err?: string }
interface OpImage { blob?: string; src?: string; mime?: string }
/* A ghost: a perspective's stand-in for something not on the board (a file, a session, a process, a unit). */
interface GhostNode extends BoardNodeBase {
  kind: 'ghost';
  ghost: true;
  order: number;
  alias?: string;                      // the real node it mirrors
  meta?: string;
  path?: string; dir?: boolean; link?: string | null; host?: string; // host: a host url, not a FolderHost
  mount?: boolean | string; nlink?: number; ino?: number; dev?: number; hardlink?: string; // hardlink: the ghost of the same inode's first name
  journalDay?: string; noteId?: string; linkTitle?: string;
  tmuxTarget?: string; procPid?: number; cmd?: string; unitName?: string; unitState?: string;
}
/* Any node on the board: a union tagged on `kind`. */
type BoardNode = TermNode | ReplNode | PageNode | RefNode | LegacyAgentNode | AcpNode | FrameNode | ArtifactNode | WebNode | SketchNode | ImageNode | PdfNode | OpNode | GhostNode;
/* The node type for one kind, e.g. NodeOfKind<'frame'> is FrameNode. */
type NodeOfKind<K extends NodeKind> = Extract<BoardNode, { kind: K }>;
/* What addNode takes: a kind and any of that kind's fields (the rest get defaults). */
type BoardNodeInit = { [K in NodeKind]: Partial<NodeOfKind<K>> & { kind: K } }[NodeKind];

/* A link between two nodes. Perspective edges (persp: true) are rebuilt, never saved. */
interface Edge { id: string; from: string; to: string; type: EdgeType; persp?: boolean }
/* What an edge means. */
type EdgeType = 'spawn' | 'pipe' | 'ref' | 'symlink' | 'hardlink';
/* An ink stroke: perfect-freehand points [x, y, pressure]. */
interface Stroke { id: string; color: string; size: number; sim: boolean; owner: string | null; aid?: string; pts: [number, number, number][]; _d?: string }
/* The drawn shapes (v19). */
type ShapeType = 'rect' | 'diamond' | 'ellipse' | 'arrow' | 'text';
/* A drawn shape: a box (rect, diamond, ellipse, text) or an arrow, which has its ends and the cards they are bound to. */
type Shape = BoxShape | ArrowShape;
interface ShapeBase {
  id: string; color: string; seed: number;
  text?: string; in?: string | null;
  x1?: number; y1?: number; x2?: number; y2?: number;
  a?: ShapeBinding | null; b?: ShapeBinding | null;
}
interface BoxShape extends ShapeBase { type: Exclude<ShapeType, 'arrow'>; x: number; y: number; w: number; h: number }
/* An arrow drawn by hand keeps the box it was started with; one made by a tool or the seed has only its ends. */
interface ArrowShape extends ShapeBase { type: 'arrow'; x?: number; y?: number; w?: number; h?: number }
/* An arrow end bound to a card, at an offset from its corner. */
interface ShapeBinding { id: string; dx: number; dy: number }

// ---- desks and per-window view state (DESK line 162, WIN line 167, RING/OVL lines 180-181)

/* A desk: a numbered layout of members with their rectangles (null: on the desk, where it is). */
interface Desk {
  slot: number; name: string;
  members: Record<string, BoardRect | null>;
  layout?: 'tile' | 'columns';
  smart?: 'attn';                      // a smart desk filled by the Attention query
  query?: string;                      // a query desk: its members are the cards this query matches
  saved?: { members: Record<string, BoardRect | null>; layout?: 'tile' | 'columns' };
}
/* A saved arrangement: each node's folder, rectangle and order, plus derived folders (S.manual, desk snapshots). */
interface PerspSnapshot {
  in: Record<string, string | null>;
  pos: Record<string, BoardRect>;
  order: Record<string, number>;
  frames?: Record<string, FrameNode>;
}
/* A place the ring and overlay remember: 'view:X', 'tab:ID', 'persp:X' or 'desk:N'. */
type PlaceKey = string;
/* The view keys one window keeps in localStorage wb-view-<host>. */
interface BoardViewState {
  ws: string | null; focusTabs: string[]; persp: PerspName;
  desk: number | string | null; prevDesk: number | string | null;
  scratch: Desk[]; deskCams: Record<string, Cam>; ring: PlaceKey[]; overlay: PlaceKey[];
}
/* A window's own desk, in sessionStorage wb-desk-<host>. */
interface BoardWinState { desk: number | string | null; prevDesk: number | string | null }
/* Messages between windows of one board on the desk BroadcastChannel. */
type DeskWinMsg = { win: string; since: number } & (
  | { t: 'desk'; desk: number | string | null }
  | { t: 'scratch'; list: Desk[] }
  | { t: 'swap'; to: string; from: number | string | null; desk: number | string | null }
  | { t: 'send'; to: string; slot: number; items: Record<string, BoardRect | null> }
  | { t: 'hello'; desk: number | string | null }
  | { t: 'here'; desk: number | string | null }
  | { t: 'bye' }
);

// ---- the demo file system (seedFs line 634, FakeShell line 662)

/* A demo FS directory. */
interface FakeFsDir { t: 'd'; c: Record<string, FakeFsEntry>; mount?: boolean | string; ino?: number }
/* A demo FS file. */
interface FakeFsFile { t: 'f'; d: string; ino?: number; mount?: never }
/* A demo FS symlink. */
interface FakeFsLink { t: 'l'; d: string; ino?: number; mount?: never }
/* Any demo FS entry. */
type FakeFsEntry = FakeFsDir | FakeFsFile | FakeFsLink;

// ---- live: the runtime side of each card (const live, line 30; mountNode line 2139, mountFrame line 1527)

/* What a card's runtime holds: its DOM, its terminal or editor, its backend, timers and caches. Keyed by node id, plus 'dock', 'chat' and 'plans'. */
interface LiveEntry {
  // DOM
  el: HTMLElement;
  hdr?: HTMLElement | null;            // null for the dock and the chat pane
  body?: HTMLElement;
  lod?: HTMLElement;                   // the zoomed-out stand-in
  ink?: SVGSVGElement; inkLines?: SVGElement;
  backlinks?: HTMLElement & { _sig?: string };
  revive?: HTMLButtonElement;
  logEl?: HTMLElement;
  ta?: HTMLTextAreaElement;
  notice?: HTMLElement;
  urlInput?: HTMLInputElement;
  note?: HTMLElement;
  img?: HTMLImageElement;
  pdf?: PdfLive;                       // a PDF card's document and pages
  op?: OpLive;                         // a media card's controls
  // runtime objects
  term?: XtermTerminal;
  fit?: XtermFitAddon;
  ro?: ResizeObserver;
  backend?: CardBackend;
  frame?: HTMLIFrameElement | EdwinFrame | null; // an iframe on artifact and web cards, an Edwin frame on pages
  // artifact bridge
  port?: MessagePort | null;
  hello?: boolean;
  blockCode?: string;
  // Edwin pages
  host?: HTMLElement;                  // the element the Edwin frame mounts in
  snap?: HTMLElement;                  // the snapshot shown before the replica opens
  off?: HTMLElement;
  chips?: HTMLElement;
  buf?: EdwinBuffer | null;
  open?: Promise<EdwinBuffer | null> | null;
  overlayQueued?: boolean;
  // agent cards
  busy?: boolean;
  ctl?: AbortController | null;
  // timers
  fitNow?: () => void;
  fitT?: number; busyT?: number; helloT?: number;
  // caches
  _doc?: { ver: number; doc: BoardTextDoc };
  _blocks?: { ver: number; blocks: unknown[] };
}
/* A PDF card's runtime: the document, a box per page, and the scroller that holds them. */
interface PdfLive {
  doc: PdfJsDocument | null;
  load: Promise<PdfJsDocument | null> | null;
  task?: PdfJsLoadingTask | null;      // pdf.js's loading task: destroying it lets go of the document and its worker
  err: string;
  scroll: HTMLElement;                 // the card body's scroller (.pdf-pages), which takes the keyboard
  pages: PdfPageLive[];
  w: number;                           // the page width in CSS px the boxes were laid out for
  texts: (string | null)[];            // each page's text, once read
  posT?: number;                       // the reading position's save timer
}
interface PdfPageLive {
  i: number;                           // from 0
  page: PdfJsPage | null;
  el: HTMLElement;
  pw: number; ph: number;              // the page's size in PDF units
  canvas: HTMLCanvasElement | null; r: number;   // the drawn bitmap and its pixels per PDF unit
  task: PdfJsRenderTask | null; taskR?: number;  // the bitmap being drawn and its pixels per PDF unit
  textReady?: Promise<void>;           // the text layer, once its spans are in
  text: HTMLElement | null; links: boolean; used: number;
}
/* A media card's controls. */
interface OpLive { prompt: HTMLTextAreaElement; out: HTMLElement; ins: HTMLElement; run: HTMLButtonElement; busy: boolean }
// pdf.js (vendor/pdfjs/pdf.min.mjs, loaded on demand): the part of its API the pdf card uses.
interface PdfJsLib {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(src: { url?: string; data?: Uint8Array; enableXfa?: boolean; stopAtErrors?: boolean; cMapUrl?: string; cMapPacked?: boolean }): PdfJsLoadingTask;
  TextLayer: new (o: { textContentSource: unknown; container: HTMLElement; viewport: PdfJsViewport }) => { render(): Promise<void>; cancel(): void };
  version: string;
}
interface PdfJsLoadingTask { promise: Promise<PdfJsDocument>; destroy(): Promise<void> }
interface PdfJsDocument {
  numPages: number;
  getPage(n: number): Promise<PdfJsPage>;
  getDestination(name: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
  getMetadata(): Promise<{ info?: { Title?: string } }>;
}
interface PdfJsPage {
  getViewport(o: { scale: number }): PdfJsViewport;
  render(o: { canvasContext: CanvasRenderingContext2D; viewport: PdfJsViewport }): PdfJsRenderTask;
  getTextContent(): Promise<{ items: { str?: string; hasEOL?: boolean }[] }>;
  streamTextContent(): unknown;
  getAnnotations(): Promise<{ subtype: string; rect: number[]; dest?: unknown; url?: string }[]>;
}
interface PdfJsViewport { width: number; height: number; scale: number; convertToViewportPoint(x: number, y: number): number[] }
interface PdfJsRenderTask { promise: Promise<void>; cancel(): void }
/* xterm's Terminal, from the vendored bundle. */
type XtermTerminal = InstanceType<Vendor['Terminal']>;
/* xterm's FitAddon, from the vendored bundle. */
type XtermFitAddon = InstanceType<Vendor['FitAddon']>;
/* A page's text state (pageState): a TextDoc over the replica text, or over the node's text on a read-only page. */
type PageViewState = { doc: BoardTextDoc };
/* A line-indexed view of a string (class TextDoc, line 6191). */
interface BoardTextDoc {
  text: string; length: number;
  readonly starts: number[]; readonly lines: number;
  line(k: number): BoardTextLine;
  lineAt(pos: number): BoardTextLine;
  sliceString(a: number, b?: number): string;
  toString(): string;
}
/* One line of a BoardTextDoc. */
interface BoardTextLine { from: number; to: number; text: string; number: number }

// ---- backends (PtyBackend line 791, AcpBackend line 925, FakeShell line 662, JsRepl line 747, Offline line 1497)

/* What a card's backend offers; code calls the optional members after checking for them. The classes `implements` it. */
interface CardBackend {
  input(d: string): void;
  resize?(cols: number, rows: number): void;
  kill?(): void;
  dispose?(): void;
  refresh?(): void;
  end?(session?: boolean): void;
  wake?(): void;
  reconnect?(): void;
  goneElsewhere?(epoch: number): void;
  maybeSeen?(): void;
  readonly dead?: boolean;
  readonly parked?: boolean;
  exitReason?: PtyExitReason | null;
  detachOnly?: boolean;                // remove the card but leave its tmux session running
  ws?: WebSocket | null;
  waitHub?: boolean;
  host?: Host | null;
  epoch?: number | null;
  cwd?: string;                        // FakeShell's working directory
  // AcpBackend
  sum?: SessionSummary | null;
  session?: AcpSessionInfo | null;
  text?(max?: number): string;
  restart?(): void;
  revive?(): void;
  promptable?(): boolean;
  stateText?(): string;
  cancel?(): void;
  setMode?(modeId: string): void;
}
/* Something WAKE (line 314) pokes when the hub or network comes back: a backend or a socket. */
interface Wakeable { wake(): void; waitHub?: boolean }
/* The reconnect state a socket wrapper (PtyBackend, AcpBackend, Reap line 1302, Rpc line 4960) keeps. */
interface ReconnectState { ws: WebSocket | null; tries: number; timer: number | null | undefined; waitHub?: boolean }

// ---- hosts and connection state

/* A host from hosts.json: another canvasd the board reaches (HOSTS line 5063). */
interface Host { name: string; url: string; token?: string; sample?: boolean }
/* A host's connection state (HOSTCONN, line 8107). */
interface HostConn { rpc?: unknown; down?: boolean; since?: number; home?: string }
/* The network state (NET, line 313). */
interface NetState {
  state: 'up' | 'down' | 'offline' | 'signed_out' | 'forbidden';
  hub: Extract<HubMsg, { t: 'hub' }> | null; tries: number; probing: Promise<void> | null; since: number; timer: number | null | undefined;
}
/* The hub's status as /rpc reports it. */
type HubStatus = 'up' | 'down' | 'incompatible';
/* The save state (SAVE, line 211). */
interface SaveState {
  busy: boolean; again: boolean; paused: null | 'auth' | 'conflict';
  pending: boolean; err: number; theirs: string | null; lastJson: string | null;   // err: failed PUTs in a row; theirs: the other side's ETag
  recheck: string | null; retryT: number | null | undefined; leaving: boolean; dbQueue: Set<ArtifactNode>;   // recheck: an ETag to look at once the PUT ends
}
/* Why a boot fetch failed (bootFetch). */
interface BootError { kind: 'net' | 'signed_out' | 'forbidden' | 'http' | 'not_json' | 'format'; status?: number; v?: number | string }
/* What /api/info says about the serving daemon (INFO, line 4956). */
interface DaemonInfo {
  host: string; home: string;
  edit?: boolean; editUp?: boolean; sample?: boolean; models?: unknown; notes?: string; notesExists?: boolean;
  media?: MediaProviderInfo[];         // the image providers media cards can use (F-A41)
  state?: string; dist?: string; tmux?: string | null; artifactOrigin?: string;
  agents?: { name: string; label: string }[];
  shells?: string[]; defaultShell?: string;
  hub?: { status: HubStatus; version?: string; build?: string; proto?: number; startedAt?: number; stale?: boolean };
}

/* An image provider as /api/info lists it, without its key. */
interface MediaProviderInfo { name: string; api: 'openai' | 'huggingface'; models: string[]; ops: OpKind[] }

// ---- sessions: what the hub knows (SESS line 366)

/* A session's state, from the hub's summary. */
type SessionState = 'idle' | 'running' | 'waiting_permission' | 'waiting_input' | 'done' | 'error' | 'exited' | 'detached';
/* How a PTY ended. */
type PtyExitReason = 'exited' | 'killed' | 'hub_restart' | 'spawn_failed';
/* The hub's facts about one session, PTY or ACP (SESS[sid]). */
interface SessionSummary {
  sid: string; kind: 'pty' | 'acp'; host: string;
  createdAt: number; updatedAt: number; alive: boolean; viewers: number; cwd: string | null;
  fault: { code: string; message: string } | null;
  state: SessionState;
  pty?: {
    argv: string[]; pid?: number;
    fg?: { comm: string; pgid: number; leader: boolean };
    exit?: { code: number | null; signal: string | null; reason: PtyExitReason; at: number };
  };
  acp?: {
    agent: string; agentSessionId: string | null; revivable: boolean;
    activity: 'none' | 'setup' | 'turn';
    pending: { req: number | string; kind: string; title: string; ts: number }[];
    last: { seq: number; ts: number; outcome: string | null; error: { code?: string; message: string } | null } | null;
    headSeq: number; seenSeq: number; title: string | null; modeId: string | null;
  };
}
/* What an ACP agent told the hub about itself and the session (info.session). */
interface AcpSessionInfo {
  protocolVersion?: number | null; agentInfo?: JsonValue | null; agentCapabilities?: JsonValue | null;
  promptCapabilities?: JsonValue | null; authMethods?: JsonValue[] | null;
  modes?: { currentModeId?: string; availableModes?: { id: string; name: string; description?: string }[] } | null;
  availableCommands?: JsonValue[] | null; plan?: JsonValue | null; usage?: JsonValue | null;
}
/* A session summary with the agent's own details (the info in /acp hello and info). */
type AcpInfo = SessionSummary & { session?: AcpSessionInfo | null };
/* One event of an ACP session's journal. */
type JournalEvent = { seq: number; ts: number } & (
  | { e: 'spawn'; pid: number; via: string }
  | { e: 'session'; via: string; sessionId: string; modes?: JsonValue; configOptions?: JsonValue }
  | { e: 'setup_error'; code: string; message: string; rpc?: JsonValue }
  | { e: 'authenticate'; methodId: string }
  | { e: 'prompt'; prompt: JsonValue[] }
  | { e: 'update'; update: JsonObject; sessionId?: string }
  | { e: 'turn_end'; stopReason: string }
  | { e: 'turn_error'; code: string; message: string; rpc?: JsonValue }
  | { e: 'permission'; toolCall: JsonObject; options: JsonObject[] }
  | { e: 'permission_resolved'; req: number | string; outcome: JsonValue; by: string }
  | { e: 'elicitation'; request: JsonObject }
  | { e: 'elicitation_resolved'; req: number | string; response: JsonValue; by: string }
  | { e: 'elicitation_complete'; elicitationId: string }
  | { e: 'mode'; modeId: string }
  | { e: 'notice'; level: string; text: string }
  | { e: 'exit'; code: number | null; signal: string | null; reason: string }
);

// ---- wire messages: /pty

/* Browser to daemon on /pty. */
type PtyClientMsg =
  | { t: 'open'; id: string; cmd?: string; parent?: string | null; cwd?: string; tmux?: string; cols: number; rows: number; env?: Record<string, string>; spawn?: boolean; shell?: string; resume?: { stream: number; out: number } }
  | { t: 'in'; d: string }
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'kill'; session?: boolean };   // no session: forget the card, keep nothing
/* Daemon to browser on /pty. */
type PtyServerMsg =
  | { t: 'hello'; new: boolean; resumed: boolean; stream?: number; out?: number; epoch: number; cwd?: string; replay?: string; tmux?: string; adopted?: boolean; attached?: boolean }
  | { t: 'out'; d: string; out?: number }
  | { t: 'fg'; comm: string; cwd?: string }
  | { t: 'exit'; code: number | null; signal: string | null; reason: PtyExitReason }
  | { t: 'gone'; epoch: number }
  | { t: 'error'; error: string; code?: string };

// ---- wire messages: /acp

/* Browser to hub on /acp (each may carry a request id). */
type AcpClientMsg = { rid?: number } & (
  | { t: 'open'; id: string; since: number; epoch?: number; agent?: string; cwd?: string }
  | { t: 'prompt'; blocks: JsonObject[] }
  | { t: 'cancel' }
  | { t: 'permission'; req: number | string; epoch: number; outcome: JsonValue }
  | { t: 'elicitation'; req: number | string; epoch: number; response: JsonValue }
  | { t: 'set_mode'; modeId: string }
  | { t: 'seen'; seq: number }
  | { t: 'revive' }
  | { t: 'authenticate'; methodId: string }
  | { t: 'kill'; forget: boolean }
);
/* Hub to browser on /acp. */
type AcpServerMsg =
  | { t: 'hello'; status: 'new' | 'attached'; info: AcpInfo; head: number; from: number; reset: boolean }
  | { t: 'ev'; ev: JournalEvent }
  | { t: 'replayed'; head: number; truncated: boolean }
  | { t: 'info'; info: AcpInfo }
  | { t: 'error'; error: string; code: string; rid?: number }
  | { t: 'gone'; epoch: number };

// ---- wire messages: /rpc (class Rpc line 4960, RPC line 5022, RPC_EVENTS line 377)

/* Hub to browser on /rpc: hub state, the session feed, board and notes changes, commands, and model-sampling streams. */
type HubMsg =
  | { t: 'hub'; status: HubStatus; version?: string; startedAt?: number; stale?: boolean; build?: string }
  | { t: 'sessions'; sessions: SessionSummary[] }
  | { t: 'session'; session: SessionSummary }
  | { t: 'gone'; sid: string; epoch: number }
  | { t: 'board'; etag: string }
  | { t: 'notes'; gen: number }
  | { t: 'cmd'; id: string; tool: string; input: AgentToolInput }
  | { t: 'text'; id: string; text: string }
  | { t: 'tool'; id: string; callId: string; name: string; input: AgentToolInput }
  | { t: 'done'; id: string; text: string; truncated?: boolean; modelTierApplied?: string; modelApplied?: string }
  | { t: 'error'; id: string; code: string; message: string; text?: string }
  | { t: 'ok'; id: string; value: unknown };
/* Browser to hub on /rpc. */
type HubClientMsg =
  | { t: 'active'; ago: number }
  | { t: 'cmd_result'; id: string; result?: unknown; error?: string }
  | { t: 'sample'; id: string; input: unknown; modelTier?: string; model?: string; effort?: string; images?: { media_type: string; data: string }[]; tools?: AgentToolSpec[] }
  | { t: 'tool_result'; id: string; callId: string; result: unknown }
  | { t: 'tool_error'; id: string; callId: string; message: string }
  | { t: 'cancel'; id: string }
  | { t: 'limits'; id: string };
/* A finished model sample. */
interface SampleResult { text: string; truncated?: boolean; modelTierApplied?: string; modelApplied?: string }
/* Options for a model sample: streaming callbacks and a cancel signal. */
interface SampleOpts { onText?: (text: string) => void; onTool?: (call: { callId: string; name: string; input: AgentToolInput }) => unknown; signal?: AbortSignal; [k: string]: unknown }

// ---- the artifact bridge: a MessagePort per artifact card

/* Host to artifact page. */
type ArtHostMsg =
  | { t: 'hello'; contract: string; served: string[]; keys: { leader?: string } | null }
  | { t: 'keys'; keys: { leader?: string } | null }   // the leader key changed
  | { t: 'ok'; id: string; value: unknown }
  | { t: 'err'; id: string; error: { code: string; message: string; [extra: string]: unknown } }
  | { t: 'ev'; id: string; event: string; data: unknown }
  | { t: 'pinch'; on: boolean };   // the board pinches with a finger in this frame: the page scrolls nothing meanwhile
/* A finger in an artifact frame, in the frame's own CSS pixels. */
interface ArtTouch { id: number; x: number; y: number }
/* Artifact page to host (web/bridge.ts sends these; ids are the bridge's strings). */
type ArtPageMsg =
  | { t: 'call'; id: string; cap: string; method: string; args: unknown }   // args: one object, its shape per capability
  | { t: 'cancel'; id: string }
  | { t: 'key'; key: 'leader' }
  | { t: 'touch'; phase: 'start' | 'move' | 'end'; touches: ArtTouch[] }   // every finger down in the frame, after this event
  | { t: 'tool_result'; id: string; callId: string; result: string }
  | { t: 'tool_error'; id: string; callId: string; message: string };
/* The window message an artifact iframe sends to open its port. */
interface ArtHelloMsg { claude: 'hello' }
/* What PUT /api/artifact answers. */
interface ArtPublishResult { version: number | string; meta: { versions: ArtifactVersion[] }; url: string }

// ---- agent tools, the palette and bars

/* A tool's input: JSON arguments by name. Each tool may annotate its own fields (run is a method, so that type-checks). */
type AgentToolInput = Record<string, unknown>;
/* A tool as the model sees it. */
interface AgentToolSpec { name: string; description: string; inputSchema: JsonObject }
/* A tool the board offers agents and the hub's cmd messages (AGENT_TOOLS, line 3612). */
interface AgentTool extends AgentToolSpec {
  run(input: AgentToolInput, ctx?: { signal?: AbortSignal }): unknown;
}
/* An item in the palette or a picker (CMDS, openPicker, palSearch). */
interface PaletteItem {
  k?: string;                          // its kind or group (a picker's plain choices have none)
  l: string;                           // its label
  s?: string;                          // a secondary line
  run: () => unknown;
  score?: number; keys?: string; when?: (() => unknown) | null; cmd?: boolean; keepOpen?: boolean;
  idx?: number[];                      // the label's characters fuzzy() matched
}
/* A bar across the top of the board (BARS, line 354): text and its buttons, each a handler or a URL. */
interface BoardBar { text: string; actions: [string, (() => unknown) | string][] }

// ---- tasks, notes, review

/* A task line in a board page: where it is in the page's text, and the planning lines and fields under it. */
interface PageTask {
  idx?: undefined; node: PageNode; line: number; kw: string; kwFrom: number; text: string; pos: number;
  st: PageViewState; fields: Record<string, string>; body: string[];
  priority?: string; scheduled?: string; deadline?: string; closed?: string; lastLine?: number; session?: string; dispatched?: string;
}
/* A task from the notes index (/api/tasks). */
interface IndexTask {
  idx: true; id: string; nodeId: string; kw: string; text: string; path: string; line: number; body: string[]; tags: string[];
  priority?: string; scheduled?: string; deadline?: string; session?: string; dispatched?: string; target?: string;
}
/* A task in the Tasks view: from a board page or from the notes index. */
type TaskRow = PageTask | IndexTask;
/* A row of /api/tasks. */
interface ApiTaskRow {
  id: string; node: string; kw: string; title: string; path: string; line: number; prompt?: string; tags?: string[];
  priority?: string; scheduled?: string; deadline?: string; session?: string; dispatched?: string; target?: string;
}
/* A row of the notes index (/api/nodes; NOTES line 8559). */
interface NoteRow {
  id: string; path: string; title: string; kind: string; // 'file' or 'heading', and others from the index
  level?: number; tags: string[]; body: string; line: number;
  board?: PageNode;                    // demo rows: the page they come from
}
/* One review in the log: when (ISO time), card id, grade (-2 bury, -1 suspend, 0 undo, 1-4 grades), how long, the
 * review mode, and what the reviewer noted, the scheduler's state before, and the ink of a handwritten answer. */
interface ReviewLine {
  t: string; card: string; g: number; ms?: number; mode?: string; dev?: string; note?: string;
  pre?: { d: number; s: number; r: number }; ink?: { strokes: number; points: number };
}

// ---- the navigator (RG line 3990) and addresses

/* An entry in the navigator (rgEntries): a board item, a file, a note, a session, a process, a unit or an attention item. */
interface RgEntry {
  key: string; name: string; kind: string; dir: boolean;
  n?: BoardNode; fsroot?: boolean; host?: Host | null;
  size?: number; mtime?: number; meta?: string;
  link?: string | null | RgLinkRef;    // a symlink's target, or what a link view's entry names
  ino?: number; dev?: number; nlink?: number; mount?: boolean | string;
  note?: NoteRow;
  proc?: ProcInfo;
  unit?: { name: string; u: SystemdUnit; h: Host | null };
  tmux?: { target: string; h: Host | null };
  reserved?: string;                   // an explanation shown in place of contents
  go?: () => unknown;                  // what Enter does, when not the default
  attn?: 'bad' | '';
  kids?: number;
}
/* A link view's entry (link:TITLE): the title, and the page or note it resolves to, if any. */
interface RgLinkRef { title: string; page?: PageNode; note?: NoteRow }
/* A parsed address 'kind:[@host]path' (parseAddr, line 8500). */
interface BoardAddr { kind: string; host: string | null; path: string }
/* A row of /api/ls. */
interface LsEntry { name: string; dir: boolean; size: number; mtime: number; link: string | null; mount?: boolean | string; nlink?: number; ino?: number; dev?: number; path?: string }

// ---- the host's own trees: tmux, proc, unit (v13-v14)

/* A tmux session on a host's socket (/api/tmux). */
interface TmuxSession {
  name: string; command?: string; path?: string; attached?: boolean;
  windows: { index: number; name: string; active: boolean; panes: { index: number; command: string; path: string; active: boolean }[] }[];
}
/* A host's tmux listing as TMUX.data caches it. */
interface TmuxData { at: number; socket: string | null; sessions: TmuxSession[]; loading?: boolean; err?: boolean }
/* A process from /api/proc (or the demo host). */
interface ProcInfo { pid: number; ppid: number; comm: string; state: string; cwd: string | null; cmd: string; start: number; rss: number; unit?: string | null; node?: string }
/* A host's processes as PROC.data caches them, indexed by pid and by parent. */
interface ProcData { at: number; list: ProcInfo[]; byPid: Record<number, ProcInfo>; kids: Record<number, ProcInfo[]>; loading?: boolean; err?: boolean }
/* A systemd unit from /api/units. */
interface SystemdUnit { unit: string; load: string; active: string; sub: string; description: string }
/* A host's units as UNITS.data caches them. */
interface UnitsData { at: number; units: SystemdUnit[]; error?: string | null; loading?: boolean }
/* The status line's counts (statusCounts). */
interface StatusCounts { hosts: number; down: number; failed: number; agents: number; waiting: number; due: number | null; tasks: number; dueToday: number }

// ---- clipboard

/* A card as a copy carries it (what ClipItems.cards holds): where it stood, its tags and the fields COPY_FIELDS keeps for its kind. */
interface ClipCardFields {
  id?: string; kind: NodeKind; name: string; x: number; y: number; w: number; h: number; tags?: string[];
  text?: string; url?: string; srcLabel?: string; blob?: string; src?: string | RefNode['src']; mime?: string; iw?: number; ih?: number;
  [field: string]: unknown;
}
/* A copied card: the fields it carries and its id on the board it came from. */
interface CopiedCard extends ClipCardFields { id: string }
/* What copyItems puts on the clipboard and pasteItems reads back (its cards as copies). */
interface ClipItems { v: 1; cards: CopiedCard[]; strokes: Stroke[]; shapes: Shape[]; edges: Edge[] }

// ---- Edwin, the page editor runtime (window.Ed, window.L; FR line 5764)

/* An Edwin buffer: text, point and mark, and its sync state. */
interface EdwinBuffer {
  id: string; name: string; text: string;
  pt: number; mark: number | null; markActive: boolean;
  shared: boolean; sver: number; ver: number; modified: boolean;
  meta: { anchors?: PageAnchor[]; [k: string]: unknown };
  inflight?: unknown; queue?: unknown[]; sync?: { gCount?: number };
}
/* An Edwin window inside a frame. */
interface EdwinWindow { buffer: EdwinBuffer; view: HTMLElement }
/* An Edwin frame mounted in a page card (contentWindow and src are never set: they tell it from an iframe). */
interface EdwinFrame {
  buffer: EdwinBuffer; focused: boolean; root: HTMLElement; wroot: unknown;
  destroy(): void; point(): number; setPoint(p: number): void; lineTop(pos: number): number | null;
  posFromPoint(x: number, y: number): number | null;
  focus(): void; blur(): void;
  contentWindow?: never; src?: never;
}
/* The Edwin runtime's API (window.Ed). */
interface EdwinApi {
  E: { frame: EdwinFrame | null; frames: EdwinFrame[]; buffers: EdwinBuffer[]; corfu: unknown; sel: EdwinWindow | null; pasteText: string | null };
  sync: {
    on(ev: string, fn: (...args: any[]) => void): void; // any: each event passes its own payload
    open(id: string, opts?: { create?: boolean }): Promise<EdwinBuffer>;
    call(req: { cmd: string; args: unknown[]; ctx: object }): Promise<any>; // any: each edwind command answers its own shape
    anchorAdd(buf: string, pos: number, label: string | null, aid: string): Promise<unknown>;
    save(b: EdwinBuffer): Promise<{ error?: string }>;
    exportPending(): unknown[];
    buffers: Map<string, EdwinBuffer>; state: string; cid: string; pendingUndo: unknown;
  };
  hooks: {
    openPage?: (name: string) => unknown;
    leaveFrame?: (f: EdwinFrame) => unknown;
    linkNames?: () => { name: string; ann: string }[];
    applied?: (b: EdwinBuffer, ops: unknown[], origin: string) => unknown;
    wireWindow?: (w: EdwinWindow) => void;
    renderOverlay?: () => void;
    beforeUserInit?: () => void;   // run by Ed.boot between the shipped Scheme files and the user's init.scm
  };
  Keymap: new (name?: string | null) => EdwinKeymap;
  message(text: string): void;
  makeFrame(host: HTMLElement, opts: { buffer: EdwinBuffer; kind: string; fontSize: number }): EdwinFrame;
  bootServed(opts: { sources: Record<string, string>; transport: () => WebSocket; device: string; cid?: string; pending?: unknown[] }): Promise<unknown>;
  setLeaderKey(name: string): void;
  onFrameEvent(fn: (...args: any[]) => void): void; // any: frame events carry per-event payloads
  withFrame<R>(f: EdwinFrame, fn: () => R): R;
  applyOps(b: EdwinBuffer, ops: unknown[], origin: string): void;
  leaves(root: unknown): EdwinWindow[];
  selectFrame(f: EdwinFrame): void;
  selectWindow(w: EdwinWindow): void;
  windowAt(x: number, y: number): EdwinWindow | null;
  feedKey(key: string): void;
  posFromPoint(x: number, y: number, w: EdwinWindow): number | null;
}
/* The page side of Edwin frames (FR, line 5764): runtime and socket state, which frame is which card, and per-card bookkeeping. */
interface EdwinFrState {
  on: boolean; ready: boolean; online: boolean; tried: boolean;
  state: string | null;                // the sync socket's state ('connecting', 'online' ...)
  Ed: EdwinApi | null; L: EdwinLisp | null;
  booting: Promise<EdwinApi> | null; failed: unknown;
  byFrame: WeakMap<EdwinFrame, string>; // frame -> node id
  lastSeen: Map<string, number>; offAt: Map<string, number>;
  pending: Map<string, Promise<unknown>>;
  claimed: Set<string>;
  anchorCache: Record<string, PageAnchor[]>;
  localAnchors: Record<string, { buf: string; pos: number; label?: string }>;
  perf: number[];
  waiters: ((v?: unknown) => void)[];
  downers: Set<() => void>;              // frUnlessDown's waits, ended when edwind is known down
  snapT: Map<string, ReturnType<typeof setTimeout>>; snapMine: Set<string>;
  moved: Map<string, { to: string; dir: boolean }>;
  hold: Map<string, { buf: string; p: Promise<unknown>; done: (v?: unknown) => void }>;
}
/* An Edwin keymap: key name -> a command designator (a symbol or a procedure) or a prefix keymap. */
interface EdwinKeymap { name: string | null; map: Map<string, unknown>; parent: EdwinKeymap | null }
/* Edwin's Scheme bridge (window.L). */
interface EdwinLisp {
  call(name: string, args?: unknown[]): any; // any: Scheme procedures return their own shapes
  get(name: string): unknown;
  set(name: string, v: unknown): unknown;
  intern(name: string): { name: string };
  Sym: new (...a: never[]) => { name: string };
  cmdName(x: unknown): string;
  CMD(name: string, spec: string, args: string, doc: string, fn: (args: unknown[]) => unknown): unknown;
}

/* The Edwin runtime puts these on window when its scripts load; the page reads them only after frBoot has loaded them. */
interface Window { Ed: EdwinApi; L: EdwinLisp }
