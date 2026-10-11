//! `wb-hub`: owns the PTY sessions of one host and serves them on `hub.sock`.
//!
//! `unsafe` is denied everywhere except `pty/spawn.rs`, which allows it for the
//! `pre_exec` closure.
#![deny(unsafe_code)]

mod config;
mod conn;
mod env;
mod outq;
mod procfs;
mod pty;
mod registry;

use std::fs::{DirBuilder, OpenOptions, Permissions};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use rustix::fs::{FlockOperation, Mode, flock};
use tokio::net::UnixListener;
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::oneshot;
use tokio::task::JoinSet;
use tracing::level_filters::LevelFilter;
use tracing::{error, info, warn};

use crate::config::Config;
use crate::env::Identity;
use crate::registry::Registry;

/// How long a shutdown waits for the PTY children to exit.
const SHUTDOWN_WAIT: Duration = Duration::from_secs(5);

/// What every task of the hub shares.
pub struct Ctx {
    pub cfg: Config,
    pub ident: Identity,
    /// The umask the hub was started with, restored in its children.
    pub child_umask: Mode,
    pub registry: Registry,
    pub started_at: u64,
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Locks `m`, also when a panicking thread poisoned it: every critical section leaves
/// its data consistent before it can panic.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let [flag, path] = args.as_slice() else {
        eprintln!("usage: wb-hub --config PATH");
        return ExitCode::from(2);
    };
    if flag != "--config" {
        eprintln!("usage: wb-hub --config PATH");
        return ExitCode::from(2);
    }
    let level = std::env::var("RUST_LOG")
        .ok()
        .and_then(|l| l.parse::<LevelFilter>().ok())
        .unwrap_or(LevelFilter::INFO);
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_max_level(level)
        .init();
    match run(PathBuf::from(path)).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            error!("{e:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run(config: PathBuf) -> anyhow::Result<()> {
    let cfg = config::load(&config)?;
    let ident = Identity::from_env()?;
    let child_umask = rustix::process::umask(Mode::from_raw_mode(0o077));

    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&cfg.state_dir)
        .with_context(|| format!("creating {}", cfg.state_dir.display()))?;
    let lock_path = cfg.state_dir.join("hub.lock");
    let lock_file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .open(&lock_path)
        .with_context(|| format!("opening {}", lock_path.display()))?;
    flock(&lock_file, FlockOperation::NonBlockingLockExclusive)
        .with_context(|| format!("another wb-hub holds {}", lock_path.display()))?;

    match std::fs::remove_file(&cfg.socket) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            return Err(e).with_context(|| format!("removing {}", cfg.socket.display()));
        }
        _ => {}
    }
    let listener = UnixListener::bind(&cfg.socket)
        .with_context(|| format!("binding {}", cfg.socket.display()))?;
    std::fs::set_permissions(&cfg.socket, Permissions::from_mode(0o600))?;

    let mut term = signal(SignalKind::terminate())?;
    let mut int = signal(SignalKind::interrupt())?;
    let mut hup = signal(SignalKind::hangup())?;
    let ctx = Arc::new(Ctx {
        cfg,
        ident,
        child_umask,
        registry: Registry::default(),
        started_at: now_ms(),
    });
    info!(socket = %ctx.cfg.socket.display(), pid = std::process::id(), "listening");
    let mut next_conn = 0;
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    next_conn += 1;
                    tokio::spawn(conn::serve(ctx.clone(), stream, next_conn));
                }
                Err(e) => {
                    warn!("accept: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            },
            _ = term.recv() => break,
            _ = int.recv() => break,
            _ = hup.recv() => info!("ignoring SIGHUP"),
        }
    }
    drop(listener);
    shutdown(&ctx).await;
    let _ = std::fs::remove_file(&ctx.cfg.socket);
    drop(lock_file);
    Ok(())
}

/// Hangs up every PTY session and waits up to [`SHUTDOWN_WAIT`] for the children.
async fn shutdown(ctx: &Ctx) {
    info!("stopping");
    let mut waits = JoinSet::new();
    for tx in ctx.registry.stop() {
        let (done, exited) = oneshot::channel();
        if tx.send(pty::Cmd::Shutdown { done }).await.is_ok() {
            waits.spawn(exited);
        }
    }
    let all = async { while waits.join_next().await.is_some() {} };
    if tokio::time::timeout(SHUTDOWN_WAIT, all).await.is_err() {
        warn!(
            "{} sessions still running after {SHUTDOWN_WAIT:?}",
            waits.len()
        );
    }
}
