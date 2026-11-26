//! Worker EOF is just an ACP transport event. PID 1 names its systemd cgroup
//! before forking; its unprivileged descendants cannot move out or write cgroupfs.

use std::fs::{self, File};
use std::io;
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::Interest;
use tokio::io::unix::AsyncFd;
use tracing::warn;

use crate::store::write_atomic;

#[derive(Deserialize, Serialize)]
struct Receipt {
    group: String,
    inode: u64,
}

const SLICE: &str = "/sys/fs/cgroup/workbench.slice";

fn worker_name(name: &str) -> bool {
    name.strip_prefix("workbench-worker@")
        .and_then(|n| n.strip_suffix(".service"))
        .is_some_and(|n| !n.is_empty() && !n.contains('/'))
}

fn events_path(group: &str) -> io::Result<PathBuf> {
    let name = group
        .strip_prefix("/workbench.slice/")
        .filter(|n| worker_name(n))
        .ok_or_else(|| io::Error::other("not a Workbench worker service cgroup"))?;
    Ok(Path::new(SLICE).join(name).join("cgroup.events"))
}

fn populated(file: &File) -> io::Result<bool> {
    let mut buf = [0; 256];
    let n = match file.read_at(&mut buf, 0) {
        // kernfs deactivated the pinned file: rmdir requires an empty cgroup.
        Err(e) if e.raw_os_error() == Some(libc::ENODEV) => return Ok(false),
        other => other?,
    };
    for line in buf[..n].split(|b| *b == b'\n') {
        match line {
            b"populated 1" => return Ok(true),
            b"populated 0" => return Ok(false),
            _ => {}
        }
    }
    Err(io::Error::other("missing populated field in cgroup.events"))
}

/// Pre-receipt launchers didn't associate sids with their units. Don't guess:
/// migrate a legacy session only once all other worker instances have drained.
fn require_legacy_drain(current: &Path) -> io::Result<()> {
    for entry in fs::read_dir(SLICE)? {
        let entry = entry?;
        if !entry.file_name().to_str().is_some_and(worker_name) {
            continue;
        }
        let events = entry.path().join("cgroup.events");
        if events == current {
            continue; // Our pre-grant PID 1; it hasn't forked.
        }
        match File::open(events) {
            Ok(file) if populated(&file)? => {
                return Err(io::Error::other(
                    "drain worker units before reviving a session without a lifetime receipt",
                ));
            }
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    Ok(())
}

pub(super) struct Unit {
    events: AsyncFd<File>,
}

impl Unit {
    /// Serialize admission through the session actor and the hub instance lock.
    /// Persist before granting *any* launch: a lost hub or handshake cannot leave
    /// an unrecorded adapter. A recovered actor checks exactly the same witness.
    pub async fn reserve(dir: &Path, sid: &str, group: String, revive: bool) -> io::Result<Self> {
        let dir = dir.to_owned();
        let name = format!("{sid}.worker-unit");
        let events = tokio::task::spawn_blocking(move || {
            let current = events_path(&group)?;
            let events = File::open(&current)?;
            if !populated(&events)? {
                return Err(io::Error::other("worker supervisor cgroup is empty"));
            }
            match fs::read(dir.join(&name)) {
                Ok(bytes) => {
                    let old: Receipt = serde_json::from_slice(&bytes)?;
                    match File::open(events_path(&old.group)?) {
                        Ok(file) if file.metadata()?.ino() == old.inode && populated(&file)? => {
                            return Err(io::Error::other("previous worker unit still populated"));
                        }
                        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                        _ => {}
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    if revive {
                        require_legacy_drain(&current)?;
                    }
                }
                Err(e) => return Err(e),
            }
            let identity = Receipt {
                group,
                inode: events.metadata()?.ino(),
            };
            write_atomic(&dir, &name, &serde_json::to_vec(&identity)?)?;
            Ok(events)
        })
        .await
        .map_err(io::Error::other)??;
        Ok(Self {
            events: AsyncFd::with_interest(events, Interest::PRIORITY)?,
        })
    }

    pub async fn wait(unit: Option<&Self>) {
        let Some(unit) = unit else {
            return std::future::pending().await;
        };
        loop {
            // cgroup.events signals POLLPRI on a change or removal. We read
            // populated=1 during admission, before the launcher could fork.
            let result = match unit.events.ready(Interest::PRIORITY).await {
                Ok(mut ready) => {
                    ready.clear_ready();
                    populated(unit.events.get_ref())
                }
                Err(e) => Err(e),
            };
            match result {
                Ok(false) => return,
                Ok(true) => {}
                Err(e) => {
                    warn!("cannot prove worker teardown: {e}");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    }
}
