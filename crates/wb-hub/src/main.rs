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
mod shutdown;
mod store;

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
use tracing::level_filters::LevelFilter;
use tracing::{error, info, warn};

use crate::config::Config;
use crate::env::Identity;
use crate::pty::Start;
use crate::registry::Registry;

/// What every task of the hub shares.
pub struct Ctx {
    pub cfg: Config,
    pub ident: Identity,
    /// The umask the hub was started with, restored in its children.
    pub child_umask: Mode,
    pub registry: Registry,
    pub started_at: u64,
    /// `stateDir/pty`.
    pub pty_dir: PathBuf,
    /// Test builds only: `pty.input` of exactly this text panics the session actor.
    #[cfg(debug_assertions)]
    pub test_panic_input: Option<String>,
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

    let pty_dir = cfg.state_dir.join("pty");
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&pty_dir)
        .with_context(|| format!("creating {}", pty_dir.display()))?;
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
    store::remove_tmp(&pty_dir).with_context(|| format!("cleaning {}", pty_dir.display()))?;
    let ctx = Arc::new(Ctx {
        cfg,
        ident,
        child_umask,
        registry: Registry::default(),
        started_at: now_ms(),
        pty_dir,
        #[cfg(debug_assertions)]
        test_panic_input: std::env::var("WB_HUB_TEST_PANIC_INPUT").ok(),
    });
    load_sessions(&ctx).await?;

    let socket = &ctx.cfg.socket;
    match std::fs::remove_file(socket) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            return Err(e).with_context(|| format!("removing {}", socket.display()));
        }
        _ => {}
    }
    let listener =
        UnixListener::bind(socket).with_context(|| format!("binding {}", socket.display()))?;
    std::fs::set_permissions(socket, Permissions::from_mode(0o600))?;

    let mut term = signal(SignalKind::terminate())?;
    let mut int = signal(SignalKind::interrupt())?;
    let mut hup = signal(SignalKind::hangup())?;
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
    shutdown::run(&ctx).await;
    let _ = std::fs::remove_file(&ctx.cfg.socket);
    drop(lock_file);
    Ok(())
}

/// Starts a dead actor for every PTY record in the state directory. A record that fails
/// to load is quarantined and its session shows the fault.
async fn load_sessions(ctx: &Arc<Ctx>) -> anyhow::Result<()> {
    let sids =
        store::sids(&ctx.pty_dir).with_context(|| format!("listing {}", ctx.pty_dir.display()))?;
    for sid in sids {
        let (created_at, from) =
            match store::load_or_quarantine(ctx.pty_dir.clone(), sid.clone()).await {
                Ok(Some(rec)) => (Some(rec.created_at), Start::Loaded(rec)),
                Ok(None) => continue,
                Err(fault) => (None, Start::Faulted(fault)),
            };
        let (created_at, rx) = ctx.registry.load(&sid, created_at);
        pty::start(ctx.clone(), sid, created_at, rx, from);
    }
    info!(sessions = ctx.registry.list().len(), "loaded");
    Ok(())
}
