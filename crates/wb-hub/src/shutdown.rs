//! The SIGTERM sequence (DESIGN §3.4.5, 10-hub §8). Accepting has stopped before this
//! runs.
//!
//! 1. Every actor refuses every later request with `err{internal, "hub stopping"}`. A
//!    PTY actor snapshots its live screen and SIGHUPs its session; an ACP actor closes
//!    its agent's stdin, sends SIGTERM to the agent's group after 5 s and SIGKILL 1 s
//!    later.
//! 2. Up to [`HANGUP_WAIT`] for the children to exit; each exit is recorded as
//!    `exit{reason:"hub_restart", code, signal}`.
//! 3. SIGKILL to the PTY sessions still alive, and up to [`KILL_WAIT`] for every record.
//!
//! systemd (`KillMode=mixed`) kills whatever is left after the hub exits, and the next
//! start completes any record this did not finish.

use std::time::Duration;

use rustix::process::Signal;
use tokio::sync::oneshot;
use tokio::task::JoinSet;
use tracing::{info, warn};

use crate::registry::Tx;
use crate::{Ctx, acp, procfs, pty};

/// How long the children have to exit after the hangup.
const HANGUP_WAIT: Duration = Duration::from_secs(5);
/// How long the sessions have to record the exits after the SIGKILL; it covers an
/// agent's SIGKILL 6 s into the stop.
const KILL_WAIT: Duration = Duration::from_secs(3);

pub async fn run(ctx: &Ctx) {
    info!("stopping");
    let mut waits = JoinSet::new();
    for tx in ctx.registry.stop() {
        let (done, finished) = oneshot::channel();
        let sent = match tx {
            Tx::Pty(tx) => tx.send(pty::Cmd::Shutdown { done }).await.is_ok(),
            Tx::Acp(tx) => tx.send(acp::Cmd::Shutdown { done }).await.is_ok(),
        };
        if sent {
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
