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

struct Entry {
    value: Option<Metadata>,
    at: Instant,
    pending: bool,
}

#[derive(Default)]
pub struct Cache(Mutex<HashMap<String, Entry>>);

impl Cache {
    #[cfg(test)]
    pub fn get(&self, cwd: &str) -> Metadata {
        self.with(cwd, Clone::clone)
    }

    /// Requests only read completed facts, including stale facts during a refresh.
    pub fn with<R>(&self, cwd: &str, f: impl FnOnce(&Metadata) -> R) -> R {
        let cache = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match cache.get(cwd).and_then(|entry| entry.value.as_ref()) {
            Some(value) => f(value),
            None => f(&Metadata::default()),
        }
    }

    /// Reserve one bounded slot before starting I/O. In-flight slots cannot be evicted.
    fn start(&self, cwd: &str) -> bool {
        if cwd.is_empty() || cwd.len() > TEXT_MAX || !Path::new(cwd).is_absolute() {
            return false;
        }
        let mut cache = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = cache.get_mut(cwd) {
            if entry.pending || entry.at.elapsed() < TTL {
                return false;
            }
            entry.pending = true;
            return true;
        }
        if cache.len() >= CACHE_MAX {
            let oldest = cache
                .iter()
                .filter(|(_, entry)| !entry.pending)
                .min_by_key(|(_, entry)| entry.at)
                .map(|(cwd, _)| cwd.clone());
            let Some(oldest) = oldest else {
                return false;
            };
            cache.remove(&oldest);
        }
        cache.insert(
            cwd.to_owned(),
            Entry {
                value: None,
                at: Instant::now(),
                pending: true,
            },
        );
        true
    }

    /// Publish the first facts too; an initial failure leaves the null summary unchanged.
    fn finish(&self, cwd: &str, value: Metadata) -> bool {
        let mut cache = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let entry = cache.get_mut(cwd).expect("in-flight cache slot is pinned");
        let changed = entry.value.as_ref().unwrap_or(&Metadata::default()) != &value;
        entry.value = Some(value);
        entry.at = Instant::now();
        entry.pending = false;
        changed
    }
}

/// One process-wide refresh, independent of how many pages/API streams are open.
pub async fn refresh(app: crate::AppState) {
    let mut jobs = tokio::task::JoinSet::new();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            () = app.stopped() => return,
            _ = tick.tick() => {
                let state = app.hub.state();
                for session in state.sessions.values().filter(|s| s.host == app.cfg.host) {
                    if app.git_metadata.start(&session.cwd) {
                        let cwd = session.cwd.clone();
                        jobs.spawn_blocking(move || {
                            let metadata = derive(Path::new(&cwd)).unwrap_or_default();
                            (cwd, metadata)
                        });
                    }
                }
            }
            Some(Ok((cwd, metadata))) = jobs.join_next(), if !jobs.is_empty() => {
                if app.git_metadata.finish(&cwd, metadata) {
                    let state = app.hub.state();
                    for session in state.sessions.values().filter(|s| s.host == app.cfg.host && s.cwd == cwd) {
                        let _ = app.feed.send(crate::FeedMsg::Session(Box::new(session.clone())));
                    }
                }
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
        let (user, location) = url.split_once('@')?;
        let (host, path) = location.split_once(':')?;
        if user.is_empty() || user.contains(['/', ':']) || host.is_empty() || host.contains('/') {
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
