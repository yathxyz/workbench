//! Explicitly managed local git worktrees. Only a killed, unpublished add can force-remove.

use std::env;
use std::ffi::OsStr;
use std::fs::Metadata;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::Sender;
use std::time::Duration;

use rustix::fs::OFlags;
use rustix::process::{Pid, Signal, kill_process_group};
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::oneshot;
use wb_proto::hub::{ErrorCode, ManagedWorktree, WorktreeRequest};
use wb_proto::limits::{GIT_TIMEOUT, GIT_WORKTREE_TIMEOUT};

use crate::child::{is_echild, reap};

type Error = (ErrorCode, String);

/// Failure of an unpublished creation. The creator's error is independent of
/// whether a concurrent kill needs to report an incomplete cleanup.
#[derive(Debug, PartialEq)]
pub(super) enum CreateFailure {
    Clean(Error),
    PossibleLeftover(Error),
}

const PIPE_BYTES: usize = 8192;
const ERROR_CHARS: usize = 512;
const MARKER: &str = "workbench-session";
pub(super) const CANCELLED: &str = "worktree creation cancelled";

fn cancelled() -> Error {
    (ErrorCode::Conflict, CANCELLED.into())
}

#[derive(Debug)]
struct Output<T> {
    status: ExitStatus,
    stdout: T,
    stderr: Vec<u8>,
}

fn internal(e: io::Error) -> Error {
    (ErrorCode::Internal, e.to_string())
}

// Keep a bounded prefix but drain both pipes to EOF so git doesn't block on a full pipe.
async fn prefix(mut pipe: impl AsyncRead + Unpin) -> io::Result<Vec<u8>> {
    let mut result = Vec::new();
    let mut buf = [0; 4096];
    loop {
        let count = pipe.read(&mut buf).await?;
        if count == 0 {
            return Ok(result);
        }
        result.extend_from_slice(&buf[..count.min(PIPE_BYTES - result.len())]);
    }
}

// Progress (even more than PIPE_BYTES of it) can precede the first error. Keep
// just one fallback line and one candidate; never buffer a whole unbounded line.
async fn first_error(pipe: impl AsyncRead + Unpin) -> io::Result<Vec<u8>> {
    let mut pipe = BufReader::new(pipe);
    let mut first = Vec::new();
    let mut line = Vec::new();
    loop {
        let bytes = pipe.fill_buf().await?;
        let eof = bytes.is_empty();
        let newline = bytes.iter().position(|b| *b == b'\n');
        let n = newline.unwrap_or(bytes.len());
        line.extend_from_slice(&bytes[..n.min(PIPE_BYTES / 2 - line.len())]);
        pipe.consume(n + usize::from(newline.is_some()));
        if eof || newline.is_some() {
            if line.starts_with(b"fatal:") || line.starts_with(b"error:") {
                tokio::io::copy(&mut pipe, &mut tokio::io::sink()).await?;
                return Ok(line);
            }
            if first.is_empty() {
                std::mem::swap(&mut line, &mut first);
            }
            line.clear();
        }
        if eof {
            return Ok(first);
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct Git<'a> {
    pub program: &'a Path,
    pub reaper: &'a Sender<Child>,
}

struct GitChild<'a> {
    child: Option<Child>,
    reaper: &'a Sender<Child>,
}

impl GitChild<'_> {
    async fn wait(&mut self) -> io::Result<ExitStatus> {
        // Subscribe before probing so an exit between the probe and recv isn't lost.
        let mut sigchld = signal(SignalKind::child())?;
        loop {
            let status = self.child.as_mut().unwrap().try_wait();
            if matches!(status, Ok(Some(_))) || status.as_ref().is_err_and(is_echild) {
                // A std Child has no drop-time waiter. Neither Drop nor the reaper
                // may use the released number after a successful wait or ECHILD.
                self.child.take();
            }
            if let Some(status) = status? {
                return Ok(status);
            }
            sigchld
                .recv()
                .await
                .ok_or_else(|| io::Error::other("SIGCHLD stream closed"))?;
        }
    }
}

fn kill_helper(child: &Child) {
    let _ = kill_process_group(Pid::from_child(child), Signal::KILL);
}

impl Drop for GitChild<'_> {
    fn drop(&mut self) {
        if let Some(child) = self.child.take() {
            kill_helper(&child);
            reap(child, self.reaper);
        }
    }
}

enum RunError {
    Io(io::Error),
    Interrupted(Error),
}

impl RunError {
    fn into_error(self) -> Error {
        match self {
            Self::Io(e) => internal(e),
            Self::Interrupted(error) => error,
        }
    }
}

async fn run_with<T>(
    git: Git<'_>,
    cwd: &Path,
    args: &[&str],
    limit: Duration,
    cancel: Option<&mut oneshot::Receiver<()>>,
    read_stdout: impl AsyncFnOnce(ChildStdout) -> io::Result<T>,
) -> Result<Output<T>, RunError> {
    let mut cmd = Command::new(git.program);
    cmd.current_dir(cwd)
        .args(["--no-lazy-fetch", "-c", "core.hooksPath=/dev/null"])
        // Newer git can register hooks in config, independently of hooksPath.
        // These are the events fired by checkout, ref updates and index writes.
        .args([
            "-c",
            "hook.post-checkout.enabled=false",
            "-c",
            "hook.reference-transaction.enabled=false",
            "-c",
            "hook.post-index-change.enabled=false",
            // The fsmonitor hook can also be an absolute command outside hooksPath.
            "-c",
            "core.fsmonitor=false",
        ])
        .args(args)
        .env_clear()
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    for key in ["HOME", "XDG_CONFIG_HOME", "PATH"] {
        if let Some(value) = env::var_os(key) {
            cmd.env(key, value);
        }
    }
    let mut helper = GitChild {
        child: Some(cmd.spawn().map_err(RunError::Io)?),
        reaper: git.reaper,
    };
    let child = helper.child.as_mut().unwrap();
    let stdout =
        ChildStdout::from_std(child.stdout.take().expect("piped stdout")).map_err(RunError::Io)?;
    let stderr =
        ChildStderr::from_std(child.stderr.take().expect("piped stderr")).map_err(RunError::Io)?;
    let collect = async {
        // Don't reap the group leader until the pipes close: a filter can inherit a
        // pipe, outlive git and hang the request. Its group ID stays ours to kill.
        let (stdout, stderr) = tokio::try_join!(read_stdout(stdout), first_error(stderr))?;
        io::Result::Ok(Output {
            status: helper.wait().await?,
            stdout,
            stderr,
        })
    };
    let result = tokio::select! {
        // If git already completed, let the actor roll it back normally.
        biased;
        out = collect => out.map_err(RunError::Io),
        _ = async {
            match cancel {
                Some(rx) => { let _ = rx.await; }
                None => std::future::pending().await,
            }
        } => Err(RunError::Interrupted(cancelled())),
        _ = tokio::time::sleep(limit) => {
            let command = match args {
                [.., "worktree", op, "--", _] | ["worktree", op, ..] => format!("worktree {op}"),
                _ => args[0].to_string(),
            };
            Err(RunError::Interrupted((ErrorCode::Timeout, format!("git {command} timed out"))))
        }
    };
    if let Some(child) = &helper.child {
        // Reap the killed command before starting any cleanup of its registration.
        kill_helper(child);
        let _ = helper.wait().await;
    }
    result
}

async fn run(
    git: Git<'_>,
    cwd: &Path,
    args: &[&str],
    limit: Duration,
) -> Result<Output<Vec<u8>>, Error> {
    run_with(git, cwd, args, limit, None, prefix)
        .await
        .map_err(RunError::into_error)
}

fn failure<T>(output: &Output<T>, code: ErrorCode) -> Error {
    let mut message: String = String::from_utf8_lossy(&output.stderr)
        .chars()
        .filter(|c| !c.is_control())
        .take(ERROR_CHARS)
        .collect();
    if message.is_empty() {
        message = format!("git {}", output.status);
    }
    (code, message)
}

fn checked<T>(output: Output<T>, code: ErrorCode) -> Result<T, Error> {
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(failure(&output, code))
    }
}

fn absolute_path(bytes: &[u8]) -> Result<&str, Error> {
    std::str::from_utf8(bytes)
        .ok()
        .filter(|s| Path::new(s).is_absolute())
        .ok_or_else(|| (ErrorCode::BadRequest, "invalid git worktree path".into()))
}

#[derive(Default)]
struct Worktrees {
    main: Vec<u8>,
    main_bare: bool,
    branch_busy: bool,
    // None if not registered; otherwise this path's lock state.
    locked: Option<bool>,
}

// A busy branch may be in the last of arbitrarily many records. Stream them
// all, retaining only the first root, the current field and the requested facts.
async fn scan(
    pipe: impl AsyncRead + Unpin,
    branch: Option<&str>,
    target: Option<&Path>,
) -> io::Result<Worktrees> {
    let mut pipe = BufReader::new(pipe);
    let mut list = Worktrees::default();
    let mut main = true;
    let mut matching_path = false;
    let mut field = Vec::new();
    let mut truncated = false;
    loop {
        let bytes = pipe.fill_buf().await?;
        if bytes.is_empty() {
            if !field.is_empty() {
                return Err(io::Error::other("incomplete git worktree list"));
            }
            return Ok(list);
        }
        let end = bytes.iter().position(|b| *b == 0);
        let count = end.unwrap_or(bytes.len());
        let keep = count.min(PIPE_BYTES - field.len());
        truncated |= keep < count;
        field.extend_from_slice(&bytes[..keep]);
        pipe.consume(count + usize::from(end.is_some()));
        if end.is_none() {
            continue;
        }
        if field.is_empty() {
            main = false;
            matching_path = false;
        } else if let Some(path) = field.strip_prefix(b"worktree ") {
            if main && list.main.is_empty() && !truncated {
                list.main.extend_from_slice(path);
            }
            matching_path = !truncated && target.is_some_and(|p| path == p.as_os_str().as_bytes());
            if matching_path {
                list.locked = Some(false);
            }
        } else if matching_path && (field == b"locked" || field.starts_with(b"locked ")) {
            list.locked = Some(true);
        } else if main && field == b"bare" {
            list.main_bare = true;
        } else if let Some(name) = field.strip_prefix(b"branch refs/heads/") {
            list.branch_busy |= !truncated && branch.is_some_and(|b| name == b.as_bytes());
        }
        field.clear();
        truncated = false;
    }
}

async fn worktrees(
    git: Git<'_>,
    cwd: &Path,
    branch: Option<&str>,
    target: Option<&Path>,
) -> Result<Worktrees, Error> {
    let out = run_with(
        git,
        cwd,
        &["worktree", "list", "--porcelain", "-z"],
        GIT_TIMEOUT,
        None,
        async move |pipe| scan(pipe, branch, target).await,
    )
    .await
    .map_err(RunError::into_error)?;
    let list = checked(out, ErrorCode::Internal)?;
    if list.main.is_empty() {
        return Err((
            ErrorCode::Internal,
            "missing main git worktree record".into(),
        ));
    }
    Ok(list)
}

async fn main_checkout(git: Git<'_>, cwd: &Path) -> Result<String, Error> {
    let top = run(
        git,
        cwd,
        &["rev-parse", "--is-inside-work-tree", "--show-toplevel"],
        GIT_TIMEOUT,
    )
    .await?;
    let top = checked(top, ErrorCode::BadRequest)?;
    let root = top
        .strip_prefix(b"true\n")
        .and_then(|s| s.strip_suffix(b"\n"))
        .ok_or_else(|| {
            (
                ErrorCode::BadRequest,
                "cwd is not inside a git worktree".into(),
            )
        })?;
    let root = absolute_path(root)?;
    let superproject = run(
        git,
        cwd,
        &["rev-parse", "--show-superproject-working-tree"],
        GIT_TIMEOUT,
    )
    .await?;
    if !checked(superproject, ErrorCode::BadRequest)?.is_empty() {
        return Err((ErrorCode::BadRequest, "cwd is inside a submodule".into()));
    }
    // A linked checkout's private git dir has a commondir file. In a main
    // checkout use its actual top level, including for --separate-git-dir.
    let common_file = run(
        git,
        cwd,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "commondir",
        ],
        GIT_TIMEOUT,
    )
    .await?;
    let bytes = checked(common_file, ErrorCode::BadRequest)?;
    let file = bytes
        .strip_suffix(b"\n")
        .ok_or_else(|| (ErrorCode::BadRequest, "invalid git directory".into()))?;
    if !fs::try_exists(absolute_path(file)?)
        .await
        .map_err(internal)?
    {
        return Ok(root.to_owned());
    }
    let list = worktrees(git, cwd, None, None).await?;
    if list.main_bare {
        return Err((ErrorCode::BadRequest, "repository is bare".into()));
    }
    let root = absolute_path(&list.main)?;
    if fs::try_exists(Path::new(root).join(".git"))
        .await
        .map_err(internal)?
    {
        return Ok(root.to_owned());
    }
    // With a separate main git dir, porcelain may name the metadata directory.
    // Git can resolve its core.worktree, if set. Without a backlink do not guess.
    let resolved = run(
        git,
        Path::new(root),
        &["rev-parse", "--show-toplevel"],
        GIT_TIMEOUT,
    )
    .await?;
    let bytes = checked(resolved, ErrorCode::BadRequest)?;
    let top = absolute_path(bytes.strip_suffix(b"\n").unwrap_or_default())?;
    if !fs::try_exists(Path::new(top).join(".git"))
        .await
        .map_err(internal)?
    {
        return Err((
            ErrorCode::BadRequest,
            "git did not identify a main checkout".into(),
        ));
    }
    Ok(top.to_owned())
}

async fn prepare_branch(
    git: Git<'_>,
    cwd: &Path,
    request: &WorktreeRequest,
    target: &Path,
) -> Result<(), Error> {
    let branch = &request.branch;
    let list = worktrees(git, cwd, Some(branch), Some(target)).await?;
    if list.branch_busy {
        return Err((
            ErrorCode::Conflict,
            format!("branch {branch} is already checked out in another worktree"),
        ));
    }
    // A locked/prunable registration can outlive its checkout. Our interrupted
    // add must never unlock or force-remove an earlier user's registration.
    if list.locked.is_some() {
        return Err((
            ErrorCode::Conflict,
            format!("worktree path is already registered: {}", target.display()),
        ));
    }
    let local = format!("refs/heads/{branch}");
    let exists = run(
        git,
        cwd,
        &["show-ref", "--verify", "--quiet", "--", &local],
        GIT_TIMEOUT,
    )
    .await?;
    match exists.status.code() {
        Some(0) => (), // An existing local branch wins even when a base was supplied.
        Some(1) => {
            let base = format!("{}^{{commit}}", request.base.as_deref().unwrap_or("HEAD"));
            let resolved = run(
                git,
                cwd,
                &["rev-parse", "--verify", "--end-of-options", &base],
                GIT_TIMEOUT,
            )
            .await?;
            let bytes = checked(resolved, ErrorCode::BadRequest)?;
            let id = bytes
                .strip_suffix(b"\n")
                .and_then(|s| std::str::from_utf8(s).ok())
                .filter(|s| matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit()))
                .ok_or_else(|| (ErrorCode::Internal, "git did not return a commit ID".into()))?;
            let new = run(
                git,
                cwd,
                &["branch", "--no-track", "--", branch, id],
                GIT_TIMEOUT,
            )
            .await?;
            if !new.status.success() {
                // A trailing dot passes the wire grammar but git rejects it as a ref.
                let code = if branch.ends_with('.') {
                    ErrorCode::BadRequest
                } else {
                    ErrorCode::Conflict
                };
                return Err(failure(&new, code));
            }
        }
        _ => return Err(failure(&exists, ErrorCode::BadRequest)),
    }
    Ok(())
}

// Resolve this exact checkout's .git file rather than discovering a repository
// above it: the old path can have become an ordinary directory in another repo.
async fn marker_path(path: &Path) -> Result<Option<PathBuf>, Error> {
    if !optional(fs::symlink_metadata(path).await)?.is_some_and(|m| m.is_dir()) {
        return Ok(None);
    }
    let dot_git = path.join(".git");
    if !optional(fs::symlink_metadata(&dot_git).await)?.is_some_and(|m| m.is_file()) {
        return Ok(None);
    }
    let Some(mut bytes) = read_regular(&dot_git, PIPE_BYTES).await? else {
        return Ok(None);
    };
    if bytes.len() > PIPE_BYTES {
        return Ok(None);
    }
    // Git strips trailing CR/LF but not spaces. Relative backlinks are based
    // at the directory containing the gitfile, not at the process's cwd.
    while matches!(bytes.last(), Some(b'\r' | b'\n')) {
        bytes.pop();
    }
    let Some(dir) = bytes
        .strip_prefix(b"gitdir: ")
        .filter(|p| !p.is_empty() && !p.contains(&0))
    else {
        return Ok(None);
    };
    Ok(Some(path.join(OsStr::from_bytes(dir)).join(MARKER)))
}

async fn read_regular(path: &Path, limit: usize) -> Result<Option<Vec<u8>>, Error> {
    // Guard against replaced metadata, including a FIFO. A pre-open stat
    // alone would let a replacement race block a tokio filesystem worker.
    let flags = OFlags::NONBLOCK | OFlags::NOCTTY | OFlags::NOFOLLOW;
    let Some(file) = optional(
        fs::OpenOptions::new()
            .read(true)
            .custom_flags(flags.bits() as i32)
            .open(path)
            .await,
    )?
    else {
        return Ok(None);
    };
    if !file.metadata().await.map_err(internal)?.is_file() {
        return Err((
            ErrorCode::Internal,
            format!("{} is not a regular file", path.display()),
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(internal)?;
    Ok(Some(bytes))
}

async fn mark(path: &Path, sid: &str) -> Result<(), Error> {
    let marker = marker_path(path).await?.ok_or_else(|| {
        (
            ErrorCode::Internal,
            "git did not create a worktree backlink".into(),
        )
    })?;
    let mut file = fs::File::create_new(marker).await.map_err(internal)?;
    file.write_all(sid.as_bytes()).await.map_err(internal)?;
    file.flush().await.map_err(internal)
}

fn optional<T>(r: io::Result<T>) -> Result<Option<T>, Error> {
    match r {
        Ok(value) => Ok(Some(value)),
        Err(e)
            if matches!(
                e.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(None)
        }
        Err(e) => Err(internal(e)),
    }
}

async fn still_reserved(path: &str, ours: &Metadata) -> Result<bool, Error> {
    Ok(optional(fs::symlink_metadata(path).await)?
        .is_some_and(|m| (m.dev(), m.ino()) == (ours.dev(), ours.ino())))
}

enum Undo {
    Reservation,
    InterruptedAdd(PathBuf),
    UnmarkedCheckout,
}

async fn rollback(
    git: Git<'_>,
    cwd: &Path,
    path: &str,
    ours: &Metadata,
    undo: Undo,
) -> Result<(), Error> {
    let locked = if let Undo::InterruptedAdd(target) = &undo {
        worktrees(git, cwd, None, Some(target)).await?.locked
    } else {
        None
    };
    if !still_reserved(path, ours).await? {
        return if locked.is_some() || matches!(undo, Undo::UnmarkedCheckout) {
            Err((
                ErrorCode::Internal,
                "directory no longer matches the reservation; nothing removed".into(),
            ))
        } else {
            Ok(()) // Git cleaned up or the path was replaced. Don't touch it.
        };
    }
    if let Some(is_locked) = locked {
        if is_locked {
            let out = run(git, cwd, &["worktree", "unlock", "--", path], GIT_TIMEOUT).await?;
            checked(out, ErrorCode::Internal)?;
            if !still_reserved(path, ours).await? {
                return Err((
                    ErrorCode::Internal,
                    "directory changed after unlock; nothing removed".into(),
                ));
            }
        }
        // Only for an interrupted add, before any agent could have seen the
        // directory. Neither explicit removal nor ordinary rollback can force.
        let out = run(
            git,
            cwd,
            &["worktree", "remove", "--force", "--", path],
            GIT_WORKTREE_TIMEOUT,
        )
        .await?;
        checked(out, ErrorCode::Internal)?;
    } else if matches!(undo, Undo::UnmarkedCheckout) {
        remove_clean(git, cwd, path).await?;
    } else {
        optional(fs::remove_dir(path).await)?; // Never recurse through an unregistered path.
    }
    Ok(())
}

fn worktree_parent(main_root: &str, worktree_root: Option<&Path>) -> Result<PathBuf, Error> {
    let invalid = || {
        (
            ErrorCode::BadRequest,
            "invalid git main checkout path".into(),
        )
    };
    let relative = main_root.strip_prefix('/').ok_or_else(invalid)?;
    let mut parent = worktree_root.unwrap_or(Path::new("/")).to_owned();
    // Inspect each Unix component before Path::components can normalize away `.`.
    for name in relative.split_terminator('/') {
        if matches!(name, "" | "." | "..") || name.contains('\0') {
            return Err(invalid());
        }
        parent.push(name);
    }
    if worktree_root.is_none() {
        parent.as_mut_os_string().push("-wt");
    }
    Ok(parent)
}

async fn check_destination_parent(git: Git<'_>, cwd: &Path, parent: &Path) -> Result<(), Error> {
    let out = run(
        git,
        cwd,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        GIT_TIMEOUT,
    )
    .await?;
    let bytes = checked(out, ErrorCode::Internal)?;
    let common = absolute_path(bytes.strip_suffix(b"\n").unwrap_or_default())
        .map_err(|(_, message)| (ErrorCode::Internal, message))?;
    let common = fs::canonicalize(common).await.map_err(internal)?;

    // The parent may not exist yet. Its canonical path is the resolved existing
    // ancestor plus a missing suffix of normal components. Since `common` exists,
    // the suffix cannot enter it. A dangling symlink is not a missing component.
    let mut existing = parent;
    while let Err(e) = fs::symlink_metadata(existing).await {
        if e.kind() != io::ErrorKind::NotFound {
            return Err(internal(e));
        }
        existing = existing.parent().ok_or_else(|| internal(e))?;
    }
    let resolved = fs::canonicalize(existing).await.map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            (
                ErrorCode::BadRequest,
                format!("dangling worktree destination path: {}", existing.display()),
            )
        } else {
            internal(e)
        }
    })?;
    if resolved.starts_with(common) {
        return Err((
            ErrorCode::BadRequest,
            "worktree destination is inside the repository's git directory".into(),
        ));
    }
    Ok(())
}

pub(super) async fn create(
    git: Git<'_>,
    cwd: &Path,
    worktree_root: Option<&Path>,
    request: &WorktreeRequest,
    sid: &str,
    mut cancel: oneshot::Receiver<()>,
) -> Result<ManagedWorktree, CreateFailure> {
    use CreateFailure::{Clean, PossibleLeftover};

    if !request.valid() {
        return Err(Clean((
            ErrorCode::BadRequest,
            "invalid worktree branch or base".into(),
        )));
    }
    let (main_root, mut destination) = tokio::select! {
        biased;
        _ = &mut cancel => return Err(Clean(cancelled())),
        result = async {
            let main_root = main_checkout(git, cwd).await?;
            let parent = worktree_parent(&main_root, worktree_root)?;
            check_destination_parent(git, cwd, &parent).await?;
            Ok((main_root, parent))
        } => result.map_err(Clean)?,
    };
    fs::create_dir_all(&destination)
        .await
        .map_err(|e| Clean(internal(e)))?;
    destination.push(request.branch.replace('/', "-"));
    let path = destination
        .into_os_string()
        .into_string()
        .map_err(|_| Clean((ErrorCode::BadRequest, "worktree path is not UTF-8".into())))?;
    // A check followed by `git worktree add` is racy: git accepts existing empty
    // directories. Atomically reserve this name, including against dangling links.
    fs::create_dir(&path).await.map_err(|e| {
        Clean(if e.kind() == io::ErrorKind::AlreadyExists {
            (
                ErrorCode::Conflict,
                format!("worktree path already exists: {path}"),
            )
        } else {
            internal(e)
        })
    })?;
    let reservation_error = |e: io::Error| {
        PossibleLeftover((
            ErrorCode::Internal,
            format!("could not inspect reserved worktree path {path}: {e}"),
        ))
    };
    let reservation = fs::OpenOptions::new()
        .read(true)
        .custom_flags((OFlags::DIRECTORY | OFlags::NOFOLLOW).bits() as i32)
        .open(&path)
        .await
        .map_err(reservation_error)?;
    let ours = reservation.metadata().await.map_err(reservation_error)?;
    let mut undo = Undo::Reservation;
    let setup = async {
        let target = fs::canonicalize(&path).await.map_err(internal)?;
        tokio::select! {
            biased;
            _ = &mut cancel => return Err(cancelled()),
            result = prepare_branch(git, cwd, request, &target) => result?,
        }
        if !still_reserved(&path, &ours).await? {
            return Err((
                ErrorCode::Conflict,
                format!("worktree reservation changed: {path}"),
            ));
        }
        let added = run_with(
            git,
            cwd,
            &["worktree", "add", "--", &path, &request.branch],
            GIT_WORKTREE_TIMEOUT,
            Some(&mut cancel),
            prefix,
        )
        .await
        .map_err(|e| {
            if matches!(e, RunError::Interrupted(_)) {
                undo = Undo::InterruptedAdd(target);
            }
            e.into_error()
        })?;
        checked(added, ErrorCode::Internal)?;
        undo = Undo::UnmarkedCheckout;
        if !still_reserved(&path, &ours).await? {
            return Err((
                ErrorCode::Internal,
                "worktree directory changed during add".into(),
            ));
        }
        mark(Path::new(&path), sid).await
    }
    .await;
    if let Err((code, message)) = setup {
        if let Err((_, detail)) = rollback(git, cwd, &path, &ours, undo).await {
            return Err(PossibleLeftover((
                code,
                format!("{message}; worktree path left at {path}: {detail}"),
            )));
        }
        return Err(Clean((code, message)));
    }
    Ok(ManagedWorktree {
        path,
        branch: request.branch.clone(),
        main_root,
    })
}

async fn remove_clean(git: Git<'_>, cwd: &Path, path: &str) -> Result<(), Error> {
    // worktree remove's internal `git status --porcelain` otherwise honors a
    // status.showUntrackedFiles=no setting and deletes non-ignored untracked files.
    let removed = run(
        git,
        cwd,
        &[
            "-c",
            "status.showUntrackedFiles=all",
            "worktree",
            "remove",
            "--",
            path,
        ],
        GIT_WORKTREE_TIMEOUT,
    )
    .await?;
    checked(removed, ErrorCode::Conflict)?;
    Ok(())
}

/// False means this record is stale; no removal was attempted. A git or I/O
/// failure is not evidence of a stale record and must not make the actor clear it.
pub(super) async fn remove(
    git: Git<'_>,
    record: &ManagedWorktree,
    sid: &str,
) -> Result<bool, Error> {
    let Some(marker) = marker_path(Path::new(&record.path)).await? else {
        return Ok(false);
    };
    if read_regular(&marker, sid.len()).await?.as_deref() != Some(sid.as_bytes()) {
        return Ok(false);
    }
    remove_clean(git, Path::new(&record.main_root), &record.path).await?;
    Ok(true)
}

#[cfg(test)]
mod tests;
