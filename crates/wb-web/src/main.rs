//! wb-web: the browser front of Workbench (design §5). It serves the SPA and `/api`,
//! and relays terminal sockets to wb-hub, all behind the auth floor. On `web.sock` it
//! runs the `wb` CLI's board tools in the leader page.
#![forbid(unsafe_code)]

mod artifacts;
mod auth;
mod blobs;
mod board;
mod config;
mod edit_client;
mod fsapi;
mod host;
mod http;
mod hub;
mod info;
mod notes;
mod relay_acp;
mod relay_edit;
mod relay_pty;
mod routes;
mod rpc;
mod sample;
mod static_files;
mod util;
mod websock;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::{Mutex, broadcast, watch};
use wb_proto::hub::Summary;

use crate::auth::Floor;
use crate::config::Config;
use crate::edit_client::EditHandle;
use crate::hub::{HubHandle, HubStatus};
use crate::rpc::Pages;
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
    /// The notes index changed (edwind spec R11.7).
    Notes {
        generation: u64,
    },
}

pub struct App {
    pub cfg: Config,
    pub floor: Floor,
    pub assets: Assets,
    pub hub: HubHandle,
    /// The edwind connection; `None` when `editSocket` is not configured (R15.5).
    pub edit: Option<EditHandle>,
    pub feed: broadcast::Sender<FeedMsg>,
    /// Serialises board writes.
    pub board_lock: Mutex<()>,
    /// The `/rpc` clients, for `wb` commands (W-4).
    pub pages: Pages,
    shutdown: watch::Receiver<bool>,
    /// Upgraded sockets still running. axum stops tracking a connection once it is
    /// upgraded, so shutdown waits on this count for their close frames.
    sockets: watch::Sender<usize>,
}

pub type AppState = Arc<App>;

impl App {
    /// Resolves once shutdown has begun.
    pub async fn stopped(&self) {
        let mut shutdown = self.shutdown.clone();
        let _ = shutdown.wait_for(|stopping| *stopping).await;
    }

    /// edwind's `status`, cached briefly; `None` when edwind is not configured, down
    /// or silent.
    pub async fn edit_status(&self) -> Option<Value> {
        match &self.edit {
            Some(edit) => edit.status_value().await,
            None => None,
        }
    }

    /// Counts a socket as running until the returned guard drops.
    pub fn socket(&self) -> Socket {
        self.sockets.send_modify(|n| *n += 1);
        Socket(self.sockets.clone())
    }
}

/// A running WebSocket, which shutdown waits for.
pub struct Socket(watch::Sender<usize>);

impl Drop for Socket {
    fn drop(&mut self) {
        self.0.send_modify(|n| *n -= 1);
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
    let web_sock = websock::bind(&cfg.socket)?;
    let mut term = signal(SignalKind::terminate())?;
    let mut int = signal(SignalKind::interrupt())?;
    let (feed, _) = broadcast::channel(FEED_CAPACITY);
    let hub = hub::spawn_control(cfg.hub_socket.clone(), feed.clone());
    let edit = cfg
        .edit_socket
        .clone()
        .map(|path| edit_client::spawn(path, &cfg.host, feed.clone()));
    let (stop, shutdown) = watch::channel(false);
    let app = Arc::new(App {
        cfg,
        floor,
        assets,
        hub,
        edit,
        feed,
        board_lock: Mutex::new(()),
        pages: Pages::default(),
        shutdown,
        sockets: watch::channel(0).0,
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
    let wb = tokio::spawn(websock::serve(app.clone(), web_sock));
    let service = routes::app(app.clone()).into_make_service_with_connect_info::<SocketAddr>();
    let graceful = app.clone();
    let server = axum::serve(listener, service)
        .with_graceful_shutdown(async move { graceful.stopped().await });
    let mut sockets = app.sockets.subscribe();
    let served = async {
        server.into_future().await?;
        let _ = sockets.wait_for(|n| *n == 0).await;
        Ok::<_, std::io::Error>(())
    };
    let outcome = tokio::select! {
        served = served => served.context("server failed"),
        () = async {
            app.stopped().await;
            tokio::time::sleep(SHUTDOWN_GRACE).await;
        } => {
            tracing::warn!("connections still open after the shutdown grace");
            Ok(())
        }
    };
    wb.abort();
    let _ = std::fs::remove_file(&app.cfg.socket);
    outcome
}
