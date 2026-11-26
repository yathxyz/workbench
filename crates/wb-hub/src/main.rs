//! `wb-hub`: owns the PTY and ACP sessions of one host and serves them on `hub.sock`.
//!
//! `unsafe` is confined to startup signal setup and `pre_exec` in `pty/spawn.rs`.
#![deny(unsafe_code)]

mod acp;
mod child;
mod config;
mod conn;
mod env;
mod escalation;
mod outq;
mod procfs;
mod pty;
mod registry;
mod shutdown;
mod snapshot;
mod store;

use std::collections::BTreeMap;
use std::fs::{DirBuilder, File, OpenOptions, Permissions};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
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
    escalations: Arc<escalation::Escalations>,
    reaper: std::sync::mpsc::Sender<std::process::Child>,
    pub started_at: u64,
    /// `stateDir/pty`.
    pub pty_dir: PathBuf,
    /// `stateDir/acp`.
    pub acp_dir: PathBuf,
    /// Test builds only: `pty.input` of exactly this text panics the session actor.
    #[cfg(debug_assertions)]
    pub test_panic_input: Option<String>,
}

#[cfg(test)]
impl Ctx {
    fn for_test(dir: &Path) -> Self {
        Self::for_test_run(dir).0
    }

    /// The context and the separate instance-lock owner kept by `run`.
    fn for_test_run(dir: &Path) -> (Self, File) {
        let lock_file = lock_instance(dir).unwrap();
        let pty_dir = dir.join("pty");
        let acp_dir = dir.join("acp");
        std::fs::create_dir(&pty_dir).unwrap();
        std::fs::create_dir(&acp_dir).unwrap();
        let ctx = Self {
            cfg: serde_json::from_value(serde_json::json!({
                "stateDir": dir, "host": "host", "shells": [], "defaultShell": "", "child": {}
            }))
            .unwrap(),
            ident: Identity {
                home: dir.to_str().unwrap().into(),
                user: "user".into(),
                logname: "user".into(),
            },
            child_umask: Mode::empty(),
            registry: Registry::open(dir, &lock_file).unwrap(),
            escalations: Arc::default(),
            reaper: child::start_reaper().unwrap(),
            started_at: 1,
            pty_dir,
            acp_dir,
            #[cfg(debug_assertions)]
            test_panic_input: None,
        };
        (ctx, lock_file)
    }
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

fn main() -> ExitCode {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let usage = "usage: wb-hub --config PATH [fetch-worker SID]";
    let (path, fetch_sid) = match args.as_slice() {
        [flag, path] if flag == "--config" => (Path::new(path), None),
        [flag, path, command, sid] if flag == "--config" && command == "fetch-worker" => {
            (Path::new(path), Some(sid))
        }
        _ => {
            eprintln!("{usage}");
            return ExitCode::from(2);
        }
    };
    let level = std::env::var("RUST_LOG")
        .ok()
        .and_then(|l| l.parse::<LevelFilter>().ok())
        .unwrap_or(LevelFilter::INFO);
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_max_level(level)
        .init();
    match pty::spawn::reset_sigchld()
        .context("resetting SIGCHLD disposition and mask")
        .and_then(|()| match fetch_sid {
            Some(sid) => acp::fetch_worker(path, sid.to_str().context("invalid session id")?),
            None => run(path.to_owned()),
        }) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            error!("{e:#}");
            ExitCode::FAILURE
        }
    }
}

fn lock_instance(dir: &Path) -> anyhow::Result<File> {
    let lock_path = dir.join("hub.lock");
    let lock_file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .open(&lock_path)
        .with_context(|| format!("opening {}", lock_path.display()))?;
    flock(&lock_file, FlockOperation::NonBlockingLockExclusive)
        .with_context(|| format!("another wb-hub holds {}", lock_path.display()))?;
    Ok(lock_file)
}

#[tokio::main]
async fn run(config: PathBuf) -> anyhow::Result<()> {
    let cfg = config::load(&config)?;
    let ident = Identity::from_env()?;
    let child_umask = rustix::process::umask(Mode::from_raw_mode(0o077));

    let create_dir = |dir: &Path| {
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .with_context(|| format!("creating {}", dir.display()))
    };
    create_dir(&cfg.state_dir)?;
    let lock_file = lock_instance(&cfg.state_dir)?;
    let registry = Registry::open(&cfg.state_dir, &lock_file)
        .context("loading session epoch high-water mark")?;
    let pty_dir = cfg.state_dir.join("pty");
    let acp_dir = cfg.state_dir.join("acp");
    for dir in [&pty_dir, &acp_dir] {
        create_dir(dir)?;
        store::remove_tmp(dir).with_context(|| format!("cleaning {}", dir.display()))?;
    }
    let ctx = Arc::new(Ctx {
        cfg,
        ident,
        child_umask,
        registry,
        escalations: Arc::default(),
        reaper: child::start_reaper().context("starting child reaper")?,
        started_at: now_ms(),
        pty_dir,
        acp_dir,
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

/// Starts a dead actor for every PTY and ACP record in the state directory. A record
/// that fails to load is quarantined and its session shows the fault.
async fn load_sessions(ctx: &Arc<Ctx>) -> anyhow::Result<()> {
    // Restore healthy sessions as we read them; defer fault registration until
    // the seed is durable. A pending PTY fault still owns its sid ahead of ACP.
    let mut pty_faults = BTreeMap::new();
    let mut high = 0;
    let sids =
        store::sids(&ctx.pty_dir).with_context(|| format!("listing {}", ctx.pty_dir.display()))?;
    for sid in sids {
        let rec = match store::load_or_quarantine(ctx.pty_dir.clone(), sid.clone()).await {
            Ok(Some(rec)) => rec,
            Ok(None) => continue,
            Err(fault) => {
                pty_faults.insert(sid, fault);
                continue;
            }
        };
        let created_at = rec.created_at;
        high = high.max(created_at);
        let rx = ctx.registry.restore(&sid, created_at);
        pty::start(ctx.clone(), sid, created_at, rx, Start::Loaded(rec));
    }
    let mut acp_faults = Vec::new();
    let sids =
        store::sids(&ctx.acp_dir).with_context(|| format!("listing {}", ctx.acp_dir.display()))?;
    for sid in sids {
        let shadowed = ctx.registry.kind(&sid).is_some() || pty_faults.contains_key(&sid);
        if shadowed {
            warn!(%sid, "an ACP record has the sid of a PTY session; not loading it");
        }
        if let Err(fault) = acp::restore(ctx, sid, shadowed, &mut high).await {
            acp_faults.push(fault);
        }
    }

    ctx.registry.seed_recovered(high).await?;
    for (sid, fault) in pty_faults {
        let (created_at, rx) = ctx.registry.register_faulted(&sid).await?;
        pty::start(ctx.clone(), sid, created_at, rx, Start::Faulted(fault));
    }
    for fault in acp_faults {
        acp::load_faulted(ctx, fault).await?;
    }
    info!(sessions = ctx.registry.published_count(), "loaded");
    Ok(())
}
