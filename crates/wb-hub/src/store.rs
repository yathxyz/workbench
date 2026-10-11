//! The files of the PTY sessions in `stateDir/pty`: `<sid>.json` (the [`Record`]) and
//! `<sid>.snap` (the last VT snapshot).
//!
//! Each session has one [`Store`] whose task runs the session's file operations in
//! order, each in `spawn_blocking`, so a slow disk never stalls the actor and two writes
//! never overlap. A write still queued when a newer one arrives is replaced by it.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tracing::warn;
use wb_proto::hub::{Exit, ExitReason};

use crate::conn::valid_sid;
use crate::now_ms;

/// `pty/<sid>.json`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub sid: String,
    /// The name of the shell the session last ran; a respawn without `shell` reuses it.
    pub shell: String,
    pub argv: Vec<String>,
    pub cwd: String,
    /// The client-supplied entries only.
    pub env: BTreeMap<String, String>,
    pub created_at: u64,
    pub cols: u16,
    pub rows: u16,
    pub exit: Option<Exit>,
}

/// The file operations of one session, run in order by its task.
pub struct Store {
    tx: mpsc::UnboundedSender<Op>,
}

enum Op {
    /// Write the snapshot, when there is one, then the record.
    Write {
        json: Vec<u8>,
        snap: Option<Vec<u8>>,
    },
    /// Fires once every earlier operation is done.
    Flush(oneshot::Sender<()>),
    LoadSnap(oneshot::Sender<Option<Vec<u8>>>),
    Delete(oneshot::Sender<()>),
}

impl Store {
    /// The store of `sid` in `dir` and its task, which ends once the store is dropped and
    /// every queued operation is done.
    pub fn start(dir: PathBuf, sid: String) -> (Store, JoinHandle<()>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Store { tx }, tokio::spawn(run(dir, sid, rx)))
    }

    /// Queues a write of `record` and, when given, the snapshot.
    pub fn write(&self, record: &Record, snap: Option<Vec<u8>>) {
        let json = serde_json::to_vec(record).expect("a record serializes");
        let _ = self.tx.send(Op::Write { json, snap });
    }

    /// Waits until every queued operation is done.
    pub async fn flush(&self) {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Op::Flush(tx)).is_ok() {
            let _ = rx.await;
        }
    }

    /// The snapshot as of every queued write; `None` if there is none or it cannot be
    /// read.
    pub async fn load_snap(&self) -> Option<Vec<u8>> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Op::LoadSnap(tx)).ok()?;
        rx.await.ok().flatten()
    }

    /// Deletes both files after every queued write.
    pub async fn delete(&self) {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Op::Delete(tx)).is_ok() {
            let _ = rx.await;
        }
    }
}

async fn run(dir: PathBuf, sid: String, mut rx: mpsc::UnboundedReceiver<Op>) {
    let mut next = rx.recv().await;
    while let Some(op) = next.take() {
        match op {
            Op::Write { mut json, mut snap } => {
                loop {
                    match rx.try_recv() {
                        Ok(Op::Write { json: j, snap: s }) => {
                            json = j;
                            snap = s.or(snap);
                        }
                        Ok(other) => {
                            next = Some(other);
                            break;
                        }
                        Err(_) => break,
                    }
                }
                let (d, s) = (dir.clone(), sid.clone());
                let wrote = blocking(move || {
                    if let Some(snap) = snap {
                        write_atomic(&d, &format!("{s}.snap"), &snap)?;
                    }
                    write_atomic(&d, &format!("{s}.json"), &json)
                })
                .await;
                if let Err(e) = wrote {
                    warn!(%sid, "writing the session files: {e}");
                }
            }
            Op::Flush(done) => {
                let _ = done.send(());
            }
            Op::LoadSnap(reply) => {
                let path = dir.join(format!("{sid}.snap"));
                let snap = match blocking(move || fs::read(path)).await {
                    Ok(snap) => Some(snap),
                    Err(e) if e.kind() == io::ErrorKind::NotFound => None,
                    Err(e) => {
                        warn!(%sid, "reading the snapshot: {e}");
                        None
                    }
                };
                let _ = reply.send(snap);
            }
            Op::Delete(done) => {
                let (d, s) = (dir.clone(), sid.clone());
                if let Err(e) = blocking(move || delete(&d, &s)).await {
                    warn!(%sid, "deleting the session files: {e}");
                }
                let _ = done.send(());
            }
        }
        if next.is_none() {
            next = rx.recv().await;
        }
    }
}

/// Runs `f` on the blocking pool; a panic in it is an error.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> io::Result<T> + Send + 'static,
) -> io::Result<T> {
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|e| Err(io::Error::other(e)))
}

/// Replaces `dir/name` with `data`: a temporary file, fsync, rename, fsync of `dir`.
pub fn write_atomic(dir: &Path, name: &str, data: &[u8]) -> io::Result<()> {
    let tmp = dir.join(format!("{name}.tmp"));
    let mut f = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)?;
    f.write_all(data)?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, dir.join(name))?;
    File::open(dir)?.sync_all()
}

fn delete(dir: &Path, sid: &str) -> io::Result<()> {
    for name in [format!("{sid}.json"), format!("{sid}.snap")] {
        match fs::remove_file(dir.join(name)) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    File::open(dir)?.sync_all()
}

/// Deletes the `*.tmp` files an interrupted write left behind.
pub fn remove_tmp(dir: &Path) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().is_some_and(|e| e == "tmp") {
            fs::remove_file(&path)?;
        }
    }
    Ok(())
}

/// The sids that have a `<sid>.json`. Quarantined files have a dot in their stem, so
/// they never match the sid pattern.
pub fn sids(dir: &Path) -> io::Result<Vec<String>> {
    let mut sids = Vec::new();
    for entry in fs::read_dir(dir)? {
        let name = entry?.file_name();
        if let Some(sid) = name.to_str().and_then(|n| n.strip_suffix(".json"))
            && valid_sid(sid)
        {
            sids.push(sid.to_owned());
        }
    }
    sids.sort();
    Ok(sids)
}

/// Loads the record of `sid` off the calling task, completing it as after a hub restart
/// when it has no `exit`. `Ok(None)`: there is no record. A record that fails to load,
/// by an error or a panic, is quarantined, and the error is the fault message.
pub async fn load_or_quarantine(dir: PathBuf, sid: String) -> Result<Option<Record>, String> {
    let (d, s) = (dir.clone(), sid.clone());
    let failure = match tokio::task::spawn_blocking(move || load(&d, &s)).await {
        Ok(Ok(rec)) => return Ok(rec),
        Ok(Err(e)) => format!("{e:#}"),
        Err(e) => format!("loading panicked: {e}"),
    };
    warn!(%sid, "quarantining the session: {failure}");
    let (d, s) = (dir, sid.clone());
    let moved = tokio::task::spawn_blocking(move || quarantine(&d, &s)).await;
    if let Ok(Err(e)) = moved {
        warn!(%sid, "quarantining the session: {e}");
    }
    Err(failure)
}

fn load(dir: &Path, sid: &str) -> anyhow::Result<Option<Record>> {
    let name = format!("{sid}.json");
    let text = match fs::read(dir.join(&name)) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).context(name),
    };
    let mut rec: Record = serde_json::from_slice(&text).context(name.clone())?;
    if rec.sid != sid {
        bail!("{name} holds sid {:?}", rec.sid);
    }
    if rec.exit.is_none() {
        let at = fs::metadata(dir.join(format!("{sid}.snap")))
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or_else(now_ms, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
        rec.exit = Some(Exit {
            code: None,
            signal: None,
            reason: ExitReason::HubRestart,
            at,
        });
        // Best effort: the next save writes the exit, or the next startup computes it again.
        let json = serde_json::to_vec(&rec)?;
        if let Err(e) = write_atomic(dir, &name, &json) {
            warn!(%sid, "writing the hub_restart exit: {e}");
        }
    }
    Ok(Some(rec))
}

/// Renames the files of `sid` to `<sid>.quarantine-<ms>.<ext>`: kept for inspection,
/// never loaded.
fn quarantine(dir: &Path, sid: &str) -> io::Result<()> {
    let ms = now_ms();
    for ext in ["json", "snap"] {
        let to = dir.join(format!("{sid}.quarantine-{ms}.{ext}"));
        match fs::rename(dir.join(format!("{sid}.{ext}")), to) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    File::open(dir)?.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wb-store-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir(&dir).unwrap();
        dir
    }

    fn record(sid: &str) -> Record {
        Record {
            sid: sid.into(),
            shell: "bash".into(),
            argv: vec!["/bin/bash".into(), "-i".into()],
            cwd: "/home/alice".into(),
            env: BTreeMap::new(),
            created_at: 7,
            cols: 80,
            rows: 24,
            exit: None,
        }
    }

    #[test]
    fn the_record_has_the_design_fields() {
        let v = serde_json::to_value(record("a")).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(|k| &k[..]).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "argv",
                "cols",
                "createdAt",
                "cwd",
                "env",
                "exit",
                "rows",
                "shell",
                "sid"
            ]
        );
        assert_eq!(v["exit"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn writes_run_in_order_and_a_queued_write_is_replaced() {
        let dir = fresh_dir("order");
        let (store, task) = Store::start(dir.clone(), "s".into());
        let mut rec = record("s");
        store.write(&rec, Some(b"snap-1".to_vec()));
        rec.cols = 100;
        store.write(&rec, None);
        assert_eq!(store.load_snap().await.as_deref(), Some(&b"snap-1"[..]));
        let json: Record = serde_json::from_slice(&fs::read(dir.join("s.json")).unwrap()).unwrap();
        assert_eq!(json.cols, 100);
        store.delete().await;
        assert!(!dir.join("s.json").exists() && !dir.join("s.snap").exists());
        assert_eq!(store.load_snap().await, None);
        drop(store);
        task.await.unwrap();
        let mut left: Vec<_> = fs::read_dir(&dir).unwrap().flatten().collect();
        assert!(left.is_empty(), "{:?}", left.pop().map(|e| e.path()));
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_live_record_loads_as_a_hub_restart_and_a_corrupt_one_is_quarantined() {
        let dir = fresh_dir("load");
        let rec = record("live");
        write_atomic(&dir, "live.json", &serde_json::to_vec(&rec).unwrap()).unwrap();
        write_atomic(&dir, "live.snap", b"screen").unwrap();
        write_atomic(&dir, "bad.json", b"{not json").unwrap();
        write_atomic(&dir, "bad.snap", b"screen").unwrap();
        fs::write(dir.join("x.json.tmp"), b"torn").unwrap();
        remove_tmp(&dir).unwrap();
        assert_eq!(sids(&dir).unwrap(), ["bad", "live"]);

        let loaded = load_or_quarantine(dir.clone(), "live".into())
            .await
            .unwrap()
            .unwrap();
        let exit = loaded.exit.clone().unwrap();
        assert_eq!(exit.reason, ExitReason::HubRestart);
        assert_eq!((exit.code, exit.signal), (None, None));
        assert!(exit.at > 0 && exit.at <= now_ms());
        let on_disk: Record =
            serde_json::from_slice(&fs::read(dir.join("live.json")).unwrap()).unwrap();
        assert_eq!(on_disk, loaded);

        let err = load_or_quarantine(dir.clone(), "bad".into())
            .await
            .unwrap_err();
        assert!(err.contains("bad.json"), "{err}");
        assert_eq!(sids(&dir).unwrap(), ["live"]);
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().into_string().unwrap())
            .filter(|n| n.starts_with("bad."))
            .collect();
        assert_eq!(names.len(), 2, "{names:?}");
        assert!(
            names.iter().all(|n| n.starts_with("bad.quarantine-")),
            "{names:?}"
        );

        assert_eq!(
            load_or_quarantine(dir.clone(), "none".into()).await,
            Ok(None)
        );
        let mut other = record("other");
        other.exit = Some(Exit {
            code: Some(0),
            signal: None,
            reason: ExitReason::Exited,
            at: 1,
        });
        write_atomic(&dir, "wrong.json", &serde_json::to_vec(&other).unwrap()).unwrap();
        assert!(
            load_or_quarantine(dir.clone(), "wrong".into())
                .await
                .is_err()
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_record_loads_when_its_hub_restart_exit_cannot_be_written() {
        let dir = fresh_dir("unwritable");
        let rec = record("live");
        write_atomic(&dir, "live.json", &serde_json::to_vec(&rec).unwrap()).unwrap();
        write_atomic(&dir, "live.snap", b"screen").unwrap();
        // The rewrite's temporary file cannot be created, as on a full or read-only disk.
        fs::create_dir(dir.join("live.json.tmp")).unwrap();

        let loaded = load_or_quarantine(dir.clone(), "live".into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.exit.unwrap().reason, ExitReason::HubRestart);
        assert_eq!(sids(&dir).unwrap(), ["live"]);
        assert_eq!(fs::read(dir.join("live.snap")).unwrap(), b"screen");
        fs::remove_dir_all(dir).unwrap();
    }
}
