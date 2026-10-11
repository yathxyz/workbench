//! Every limit of the hub, `web.sock` and browser protocols, with its overflow action.

use std::time::Duration;

const KIB: usize = 1 << 10;
const MIB: usize = 1 << 20;

/// Longest line on `hub.sock` and `web.sock`, newline excluded. A longer line closes
/// the connection.
pub const MAX_LINE: usize = 16 * MIB;
/// Largest `d` of one `pty.input`. Larger is `bad_request`; the web splits larger
/// browser input.
pub const PTY_INPUT_FRAME: usize = MIB;
/// Unwritten input per PTY session. A message that would exceed it is dropped with
/// `input_overflow`.
pub const PTY_INPUT_QUEUE: usize = 8 * MIB;
/// Output ring per PTY session. The oldest bytes fall out, and a resume then falls
/// back to the snapshot.
pub const PTY_RING: usize = MIB;
/// Queued events per hub connection. Exceeding it closes the connection; an event is
/// admitted whatever its size when the queue is empty.
pub const CONN_QUEUE: usize = 4 * MIB;
/// ACP replay budget. The oldest events are dropped (`truncated: true`).
pub const ACP_REPLAY_MAX: usize = 4 * MIB;
/// Largest prompt. Larger is `bad_request`.
pub const PROMPT_MAX: usize = 8 * MIB;
/// Scrollback lines kept by the VT state.
pub const VT_SCROLLBACK: usize = 1000;
/// Largest snapshot. The scrollback budget is halved until it fits.
pub const SNAPSHOT_MAX: usize = 4 * MIB;
/// Longest held-back unterminated escape tail. A longer tail is flushed as is.
pub const ESC_HOLDBACK_MAX: usize = 4 * KIB;
/// Most lines one `pty.capture` returns. Larger requests are clamped.
pub const CAPTURE_MAX: usize = 1000;
/// Snapshot interval while the screen is dirty.
pub const SNAPSHOT_EVERY: Duration = Duration::from_secs(30);
/// Foreground process poll interval.
pub const FG_POLL: Duration = Duration::from_secs(2);
/// Time a client has to answer the server hello before it is closed.
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
/// Agent silence during setup (paused while a request is pending) that ends the
/// setup with `setup_error{timeout}`.
pub const SETUP_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// Requests in flight per connection. The reader stops until one completes.
pub const REQS_IN_FLIGHT: usize = 8;
/// `wb` command timeout when the request names none. Expiry is `timeout`.
pub const CMD_TIMEOUT_DEFAULT: Duration = Duration::from_secs(60);
/// Upper clamp for a requested `wb` command timeout.
pub const CMD_TIMEOUT_MAX: Duration = Duration::from_secs(300);
/// Largest browser message on `/pty`. Larger closes the socket with 1009.
pub const WS_MAX_PTY: usize = 2 * MIB;
/// Largest browser message on `/acp`. Larger closes the socket with 1009.
pub const WS_MAX_ACP: usize = 9 * MIB;
/// Largest browser message on `/rpc`. Larger closes the socket with 1009.
pub const WS_MAX_RPC: usize = 32 * MIB;
/// Time from upgrade to `open` on a card socket. Later closes with 1008.
pub const CARD_OPEN_DEADLINE: Duration = Duration::from_secs(30);
/// WebSocket ping interval.
pub const WS_PING: Duration = Duration::from_secs(25);
/// WebSocket silence after which the socket is closed.
pub const WS_DEAD: Duration = Duration::from_secs(60);
