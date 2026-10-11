//! wb-web: the browser front of Workbench (design §5). It serves the SPA and `/api`,
//! and relays terminal sockets to wb-hub, all behind the auth floor.
#![forbid(unsafe_code)]

mod artifacts;
mod auth;
mod board;
mod config;
mod fsapi;
mod host;
mod http;
mod hub;
mod info;
mod notes;
mod relay_acp;
mod relay_pty;
mod routes;
mod rpc;
mod sample;
mod static_files;
mod util;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::net::TcpListener;
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::{Mutex, broadcast, watch};
use wb_proto::hub::Summary;

use crate::auth::Floor;
use crate::config::Config;
use crate::hub::{HubHandle, HubStatus};
use crate::static_files::Assets;

/// What any module may publish to every `/rpc` client (W-1).
#[derive(Clone, Debug)]
pub enum FeedMsg {
    Hub(HubStatus),
    /// A session's Summary changed.
    Session(Box<Summary>),
    /// The hub forgot incarnation `epoch` of `sid`.
    Gone {
        sid: String,
        epoch: u64,
    },
    Board {
        etag: String,
    },
}

pub struct App {
    pub cfg: Config,
    pub floor: Floor,
    pub assets: Assets,
    pub hub: HubHandle,
    pub feed: broadcast::Sender<FeedMsg>,
    /// Serialises board writes.
    pub board_lock: Mutex<()>,
    shutdown: watch::Receiver<bool>,
}

pub type AppState = Arc<App>;

impl App {
    /// Resolves once shutdown has begun.
    pub async fn stopped(&self) {
        let mut shutdown = self.shutdown.clone();
        let _ = shutdown.wait_for(|stopping| *stopping).await;
    }
}

const FEED_CAPACITY: usize = 1024;
/// Time from SIGTERM until the process exits whatever is left.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
const USAGE: &str = "usage: wb-web --config PATH";

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let config = match args.as_slice() {
        [flag, path] if flag == "--config" => PathBuf::from(path),
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    let level = std::env::var("RUST_LOG")
        .ok()
        .and_then(|l| l.parse().ok())
        .unwrap_or(tracing::Level::INFO);
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .without_time()
        .with_target(false)
        .with_max_level(level)
        .init();
    match run(&config).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("wb-web: {e:#}");
            ExitCode::FAILURE
        }
    }
}

/// Nothing listens until every startup step has passed.
async fn run(config: &Path) -> Result<()> {
    let (cfg, floor) = config::load(config)?;
    let assets = Assets::load(&cfg.web_root)?;
    let listener = TcpListener::bind(cfg.listen)
        .await
        .with_context(|| format!("cannot listen on {}", cfg.listen))?;
    let mut term = signal(SignalKind::terminate())?;
    let mut int = signal(SignalKind::interrupt())?;
    let (feed, _) = broadcast::channel(FEED_CAPACITY);
    let hub = hub::spawn_control(cfg.hub_socket.clone(), feed.clone());
    let (stop, shutdown) = watch::channel(false);
    let app = Arc::new(App {
        cfg,
        floor,
        assets,
        hub,
        feed,
        board_lock: Mutex::new(()),
        shutdown,
    });
    tokio::spawn(async move {
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
        tracing::info!("shutting down");
        let _ = stop.send(true);
    });
    tracing::info!("listening on {}", listener.local_addr()?);
    let service = routes::app(app.clone()).into_make_service_with_connect_info::<SocketAddr>();
    let graceful = app.clone();
    let server = axum::serve(listener, service)
        .with_graceful_shutdown(async move { graceful.stopped().await });
    tokio::select! {
        served = server.into_future() => served.context("server failed")?,
        () = async {
            app.stopped().await;
            tokio::time::sleep(SHUTDOWN_GRACE).await;
        } => tracing::warn!("connections still open after the shutdown grace"),
    }
    Ok(())
}
