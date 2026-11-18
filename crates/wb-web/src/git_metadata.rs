//! Best-effort local Git facts; no Git process, includes, or ref traversal.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rustix::fs::{Mode, OFlags};
use serde::Serialize;

pub const TTL: Duration = Duration::from_secs(3);
const READ_MAX: u64 = 8 << 10;
const CACHE_MAX: usize = 256;
const TEXT_MAX: usize = 2048;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub repo_root: Option<String>,
    pub repo: Option<String>,
    pub worktree: Option<String>,
    pub branch: Option<String>,
    pub project_root: Option<String>,
}

#[derive(Default)]
pub struct Cache(Mutex<HashMap<String, (Instant, Metadata)>>);

impl Cache {
    #[cfg(test)]
    pub fn get(&self, cwd: &str) -> Metadata {
        self.with(cwd, Clone::clone)
    }

    pub fn with<R>(&self, cwd: &str, f: impl FnOnce(&Metadata) -> R) -> R {
        // Bound keys as well as values. Invalid paths never enter the cache.
        if cwd.is_empty() || cwd.len() > TEXT_MAX || !Path::new(cwd).is_absolute() {
            return f(&Metadata::default());
        }
        let mut cache = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, value)) = cache.get(cwd)
            && at.elapsed() < TTL
        {
            return f(value);
        }
        let value = derive(Path::new(cwd)).unwrap_or_default();
        cache.retain(|_, (at, _)| at.elapsed() < TTL);
        if cache.len() >= CACHE_MAX
            && let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(k, _)| k.clone())
        {
            cache.remove(&oldest);
        }
        let result = f(&value);
        cache.insert(cwd.to_owned(), (Instant::now(), value));
        result
    }
}

struct Watched {
    cwd: String,
    metadata: Option<Metadata>,
    seen: bool,
}

/// One process-wide refresh, independent of how many pages/API streams are open.
pub async fn refresh(app: crate::AppState) {
    let mut watched = HashMap::new();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            () = app.stopped() => return,
            _ = tick.tick() => refresh_sessions(&app, &mut watched),
        }
    }
}

fn refresh_sessions(app: &crate::AppState, watched: &mut HashMap<String, Watched>) {
    for entry in watched.values_mut() {
        entry.seen = false;
    }
    {
        // Only copy newly seen paths under the hub lock; disk I/O happens below.
        let sessions = app.hub.sessions.lock().unwrap_or_else(|e| e.into_inner());
        for session in sessions.values().filter(|s| s.host == app.cfg.host) {
            if let Some(entry) = watched.get_mut(&session.sid) {
                entry.seen = true;
                if entry.cwd != session.cwd {
                    entry.cwd.clone_from(&session.cwd);
                    entry.metadata = None;
                }
            } else {
                watched.insert(
                    session.sid.clone(),
                    Watched {
                        cwd: session.cwd.clone(),
                        metadata: None,
                        seen: true,
                    },
                );
            }
        }
    }
    watched.retain(|_, entry| entry.seen);
    for (sid, entry) in watched {
        let changed = app
            .git_metadata
            .with(&entry.cwd, |metadata| match &mut entry.metadata {
                Some(previous) if previous != metadata => {
                    previous.clone_from(metadata);
                    true
                }
                None => {
                    entry.metadata = Some(metadata.clone());
                    false
                }
                _ => false,
            });
        if changed {
            let session = {
                let sessions = app.hub.sessions.lock().unwrap_or_else(|e| e.into_inner());
                sessions
                    .get(sid)
                    .filter(|s| s.host == app.cfg.host && s.cwd == entry.cwd)
                    .cloned()
            };
            if let Some(session) = session {
                let _ = app.feed.send(crate::FeedMsg::Session(Box::new(session)));
            }
        }
    }
}

/// Nonblocking open plus post-open file-type check avoids FIFO/device reads.
fn read(path: &Path) -> io::Result<String> {
    if !fs::metadata(path)?.is_file() {
        return Err(io::Error::other("not a regular file"));
    }
    let flags = OFlags::RDONLY | OFlags::NONBLOCK | OFlags::CLOEXEC | OFlags::NOCTTY;
    let file = File::from(rustix::fs::open(path, flags, Mode::empty())?);
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("not a regular file"));
    }
    let mut bytes = Vec::new();
    file.take(READ_MAX + 1).read_to_end(&mut bytes)?;
    if bytes.len() > READ_MAX as usize {
        return Err(io::Error::other("Git metadata too large"));
    }
    String::from_utf8(bytes).map_err(io::Error::other)
}

fn optional(path: &Path) -> io::Result<Option<String>> {
    match read(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn text(path: &Path) -> io::Result<String> {
    bounded(
        path.to_str()
            .ok_or_else(|| io::Error::other("non-UTF8 path"))?,
    )
}

fn bounded(value: &str) -> io::Result<String> {
    if value.len() > TEXT_MAX {
        return Err(io::Error::other("Git value too large"));
    }
    Ok(value.to_owned())
}

fn resolve(base: &Path, value: &str) -> io::Result<PathBuf> {
    let value = value.trim();
    if value.is_empty() || value.contains('\0') {
        return Err(io::Error::other("empty Git path"));
    }
    fs::canonicalize(base.join(value))
}

fn derive(cwd: &Path) -> io::Result<Metadata> {
    let cwd = fs::canonicalize(cwd)?;
    if !cwd.is_dir() {
        return Err(io::Error::other("cwd is not a directory"));
    }
    for project in cwd.ancestors() {
        let marker = project.join(".git");
        let meta = match fs::metadata(&marker) {
            Ok(meta) => meta,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                // A dangling marker is an error, not permission to use a parent repo.
                if fs::symlink_metadata(&marker).is_ok() {
                    return Err(e);
                }
                continue;
            }
            Err(e) => return Err(e),
        };
        let gitdir = if meta.is_dir() {
            fs::canonicalize(&marker)?
        } else {
            let marker = read(&marker)?;
            resolve(
                project,
                marker
                    .trim()
                    .strip_prefix("gitdir:")
                    .ok_or_else(|| io::Error::other("invalid gitdir"))?,
            )?
        };
        let common = if meta.is_dir() {
            gitdir.clone()
        } else {
            match optional(&gitdir.join("commondir"))? {
                Some(common) => resolve(&gitdir, &common)?,
                None => gitdir.clone(),
            }
        };
        let root = if meta.is_dir() {
            project
        } else if common.file_name().is_some_and(|n| n == ".git") {
            common
                .parent()
                .ok_or_else(|| io::Error::other("missing repo root"))?
        } else {
            &common
        };
        let config = optional(&common.join("config"))?;
        let repo = config
            .as_deref()
            .and_then(origin)
            .and_then(repo_name)
            .map_or_else(
                || {
                    text(
                        root.file_name()
                            .map(Path::new)
                            .ok_or_else(|| io::Error::other("missing repo name"))?,
                    )
                },
                bounded,
            )?;
        let head = read(&gitdir.join("HEAD"))?;
        let head = head.trim();
        let branch = if let Some(branch) = head
            .strip_prefix("ref: refs/heads/")
            .filter(|s| !s.is_empty() && !s.chars().any(char::is_whitespace))
        {
            Some(bounded(branch)?)
        } else if head.len() >= 7 && head.bytes().all(|b| b.is_ascii_hexdigit()) {
            Some(head[..7].to_owned())
        } else {
            None
        };
        return Ok(Metadata {
            repo_root: Some(text(root)?),
            repo: Some(repo),
            worktree: if root != project {
                Some(text(
                    project
                        .file_name()
                        .map(Path::new)
                        .ok_or_else(|| io::Error::other("missing worktree name"))?,
                )?)
            } else {
                None
            },
            branch,
            project_root: Some(text(project)?),
        });
    }
    Ok(Metadata::default())
}

/// Only the literal origin section; never follow include directives.
fn origin(config: &str) -> Option<&str> {
    let mut in_origin = false;
    let mut url = None;
    for line in config.lines().map(str::trim) {
        if line.starts_with('[') {
            in_origin = line == "[remote \"origin\"]";
        } else if in_origin
            && let Some((key, value)) = line.split_once('=')
            && key.trim().eq_ignore_ascii_case("url")
        {
            url = Some(value.trim().trim_matches('"'));
        }
    }
    url
}

fn repo_name(url: &str) -> Option<&str> {
    let path = if let Some(url) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("ssh://"))
    {
        let (host, path) = url.split_once('/')?;
        if host.is_empty() {
            return None;
        }
        path
    } else {
        let (host, path) = url.strip_prefix("git@")?.split_once(':')?;
        if host.is_empty() {
            return None;
        }
        path
    };
    let path = path
        .trim_end_matches('/')
        .strip_suffix(".git")
        .unwrap_or(path.trim_end_matches('/'));
    let (prefix, name) = path.rsplit_once('/')?;
    let owner = prefix.rsplit('/').next()?;
    if owner.is_empty() || name.is_empty() || path.chars().any(char::is_whitespace) {
        return None;
    }
    Some(&path[path.len() - owner.len() - name.len() - 1..])
}

#[cfg(test)]
mod tests;
