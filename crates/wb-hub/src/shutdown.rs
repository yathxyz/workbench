//! The SIGTERM sequence for the PTY sessions (DESIGN §3.4.5, 10-hub §8). Accepting has
//! stopped before this runs.
//!
//! 1. Every actor snapshots its live screen, SIGHUPs its session and refuses every later
//!    request with `err{internal, "hub stopping"}`.
//! 2. Up to [`HANGUP_WAIT`] for the children to exit; each exit is recorded as
//!    `exit{reason:"hub_restart", code, signal}`.
//! 3. SIGKILL to the sessions still alive, and up to [`KILL_WAIT`] for their records.
//!
//! systemd (`KillMode=mixed`) kills whatever is left after the hub exits, and the next
//! start completes any record this did not finish.

use std::time::Duration;

use rustix::process::Signal;
use tokio::sync::oneshot;
use tokio::task::JoinSet;
use tracing::{info, warn};

use crate::pty::Cmd;
use crate::{Ctx, procfs};

/// How long the children have to exit after the hangup.
const HANGUP_WAIT: Duration = Duration::from_secs(5);
/// How long the sessions have to record the exits after the SIGKILL.
const KILL_WAIT: Duration = Duration::from_secs(2);

pub async fn run(ctx: &Ctx) {
    info!("stopping");
    let mut waits = JoinSet::new();
    for tx in ctx.registry.stop() {
        let (done, finished) = oneshot::channel();
        if tx.send(Cmd::Shutdown { done }).await.is_ok() {
            waits.spawn(finished);
        }
    }
    if all_done(&mut waits, HANGUP_WAIT).await {
        return;
    }
    let survivors = ctx.registry.live_pids();
    warn!(
        "{} sessions still running after {HANGUP_WAIT:?}; killing them",
        survivors.len()
    );
    for pid in survivors {
        procfs::signal_session(pid, Signal::KILL);
    }
    if !all_done(&mut waits, KILL_WAIT).await {
        warn!("{} sessions did not record their exit", waits.len());
    }
}

/// Whether every wait finished within `within`.
async fn all_done<T: 'static>(waits: &mut JoinSet<T>, within: Duration) -> bool {
    let all = async { while waits.join_next().await.is_some() {} };
    tokio::time::timeout(within, all).await.is_ok()
}
