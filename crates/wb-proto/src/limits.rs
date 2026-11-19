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
/// Most ordered configuration entries in an ACP spawn. Larger is `bad_request`.
pub const ACP_CONFIG_MAX: usize = 16;
/// Most options in an agent's full configuration offering. Larger is malformed.
pub const ACP_CONFIG_OPTIONS_MAX: usize = 64;
/// Largest serialized agent configuration offering. Larger is malformed.
pub const ACP_CONFIG_OPTIONS_BYTES: usize = 64 * KIB;
/// Largest serialized permission policy; excess is `bad_request`.
pub const POLICY_MAX: usize = 256 * KIB;
/// Most ordered rules in a session permission policy; excess is `bad_request`.
pub const POLICY_RULES_MAX: usize = 64;
/// Most command regular expressions across one policy; excess is `bad_request`.
pub const POLICY_PATTERNS_MAX: usize = 128;
/// Most UTF-8 bytes in one command regular expression.
pub const POLICY_PATTERN_MAX: usize = 4096;
/// Largest compiled command regular expression; excess is `bad_request`.
pub const POLICY_REGEX_SIZE_MAX: usize = 64 * KIB;
/// Most UTF-8 bytes in one permission root.
pub const POLICY_ROOT_MAX: usize = 4096;
/// Most roots, tool kinds or programs in one permission rule.
pub const POLICY_SELECTORS_MAX: usize = 64;
/// Most UTF-8 bytes in one tool kind.
pub const POLICY_KIND_MAX: usize = 64;
/// Most UTF-8 bytes in one permitted program name or path.
pub const POLICY_PROGRAM_MAX: usize = 256;
/// Largest command eligible for automatic policy evaluation; excess asks.
pub const POLICY_COMMAND_MAX: usize = 64 * KIB;
/// Largest raw command evaluated by regex conditions; excess asks at that rule.
pub const POLICY_REGEX_COMMAND_MAX: usize = 8 * KIB;
/// Deadline checked before every regex evaluation; expiration asks at that rule.
pub const POLICY_DECISION_TIMEOUT: Duration = Duration::from_millis(100);
/// Most shell words, including redirection targets; excess asks.
pub const POLICY_COMMAND_WORDS_MAX: usize = 1024;
/// Most path candidate resolutions, including reported locations; excess asks.
pub const POLICY_PATHS_MAX: usize = 2048;
/// Aggregate candidate bytes plus relative-path cwd bytes to normalize; excess asks.
pub const POLICY_PATH_BYTES_MAX: usize = 256 * KIB;
/// Most delimiter fragments considered, including duplicates; excess asks.
pub const POLICY_FRAGMENTS_MAX: usize = 2048;
/// Aggregate delimiter-fragment bytes charged before set insertion; excess asks.
pub const POLICY_FRAGMENT_BYTES_MAX: usize = 256 * KIB;
/// Most path/root comparisons across all rules for one request; excess asks.
pub const POLICY_PATH_CHECKS_MAX: usize = 64 * KIB;
/// Most possible shell working directories after conditional or failed cd; excess asks.
pub const POLICY_CWDS_MAX: usize = 32;
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
