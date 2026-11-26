//! Exchange only bytes with the worker. Its paths are opaque identifiers here:
//! never pass one to Git, including as a `file:` remote or `safe.directory`.

use std::io::SeekFrom;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncSeekExt};
use tokio::net::UnixStream;
use tokio::time::timeout;

use super::*;
use crate::config::AgentWorker;
use crate::conn::valid_sid;

const MAX_BUNDLE: u64 = 2 << 30;
const MAX_REPLY: usize = 4096;

fn bad(message: &str) -> Error {
    (ErrorCode::BadRequest, message.into())
}

fn conflict(message: &str) -> Error {
    (ErrorCode::Conflict, message.into())
}

fn timed_out() -> Error {
    (
        ErrorCode::Timeout,
        "worker checkout operation timed out".into(),
    )
}

fn valid_record(worker: &AgentWorker, record: &ManagedWorktree, sid: &str) -> bool {
    let path = Path::new(&record.path);
    valid_sid(sid)
        && path.parent() == Some(worker.root.as_path())
        && path
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|name| {
                name.strip_prefix(sid)
                    .and_then(|s| s.strip_prefix('-'))
                    .is_some_and(|s| {
                        (s == "0" || !s.starts_with('0'))
                            && s.bytes().all(|b| b.is_ascii_digit())
                            && s.parse::<u64>().is_ok()
                    })
            })
        && WorktreeRequest::valid_name(&record.branch)
        && !record.branch.ends_with('.')
}

async fn owner_dir(worker: &AgentWorker, cwd: &Path) -> Result<PathBuf, Error> {
    if !cwd.is_absolute() || cwd.starts_with(&worker.root) {
        return Err(bad(
            "source must be an owner repository outside the worker root",
        ));
    }
    let cwd = fs::canonicalize(cwd).await.map_err(internal)?;
    if cwd.starts_with(&worker.root)
        || fs::metadata(&cwd).await.map_err(internal)?.uid() != rustix::process::geteuid().as_raw()
    {
        return Err(bad("source directory is not owned by the hub user"));
    }
    Ok(cwd)
}

// Do not inherit `safe.directory=*` or a URL rewrite. Only Git builtins in
// the owner's repository operate on imported data. No remotes of any kind.
async fn owner_git(
    git: Git<'_>,
    cwd: &Path,
    args: &[&str],
    stdin: Stdio,
    code: ErrorCode,
) -> Result<Vec<u8>, Error> {
    let mut cmd = command(git, cwd);
    cmd.args([
        "--no-replace-objects",
        "-c",
        "safe.directory=",
        "-c",
        "safe.bareRepository=explicit",
    ])
    .env("GIT_CONFIG_GLOBAL", "/dev/null")
    .env("GIT_CONFIG_NOSYSTEM", "1")
    .env("GIT_ALLOW_PROTOCOL", "")
    .stdin(stdin);
    let output = execute(git, cmd, args, GIT_WORKTREE_TIMEOUT, None, prefix)
        .await
        .map_err(RunError::into_error)?;
    checked(output, code)
}

async fn query(git: Git<'_>, cwd: &Path, args: &[&str]) -> Result<Vec<u8>, Error> {
    owner_git(git, cwd, args, Stdio::null(), ErrorCode::BadRequest).await
}

async fn checkout_root(git: Git<'_>, worker: &AgentWorker, cwd: &Path) -> Result<PathBuf, Error> {
    let cwd = owner_dir(worker, cwd).await?;
    let out = query(
        git,
        &cwd,
        &["rev-parse", "--is-inside-work-tree", "--show-toplevel"],
    )
    .await?;
    let top = out
        .strip_prefix(b"true\n")
        .and_then(|s| s.strip_suffix(b"\n"))
        .ok_or_else(|| bad("source is not a working checkout"))?;
    let top = owner_dir(worker, Path::new(absolute_path(top)?)).await?;
    if !cwd.starts_with(&top) {
        return Err(bad("source is outside its checkout"));
    }
    Ok(top)
}

fn object_id(bytes: &[u8]) -> Result<&str, Error> {
    std::str::from_utf8(bytes)
        .ok()
        .filter(|s| {
            matches!(s.len(), 40 | 64)
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .ok_or_else(|| bad("invalid Git object ID"))
}

async fn line(reader: &mut (impl AsyncBufRead + Unpin), max: usize) -> Result<Vec<u8>, Error> {
    let mut buf = Vec::new();
    reader
        .take(max as u64 + 1)
        .read_until(b'\n', &mut buf)
        .await
        .map_err(internal)?;
    if buf.len() > max || buf.pop() != Some(b'\n') {
        return Err(bad("invalid or truncated worker header"));
    }
    Ok(buf)
}

/// A deliberately narrow, complete v3 bundle. No prerequisites, filters,
/// other refs or advertised capabilities. Never use `git fetch <file>`: a
/// malformed non-bundle there falls back to repository/remote discovery.
async fn bundle_tip(reader: &mut (impl AsyncBufRead + Unpin), full: &str) -> Result<String, Error> {
    if line(reader, 32).await? != b"# v3 git bundle" {
        return Err(bad("expected a version 3 worker bundle"));
    }
    let digits = match line(reader, 32).await?.as_slice() {
        b"@object-format=sha1" => 40,
        b"@object-format=sha256" => 64,
        _ => return Err(bad("unexpected worker bundle capability")),
    };
    let head = line(reader, 512).await?;
    if head.len() != digits + 1 + full.len()
        || head[digits] != b' '
        || &head[digits + 1..] != full.as_bytes()
        || !line(reader, 1).await?.is_empty()
    {
        return Err(bad("expected exactly the requested worker branch"));
    }
    Ok(object_id(&head[..digits])?.to_owned())
}

async fn connect(worker: &AgentWorker, header: Value) -> Result<BufReader<UnixStream>, Error> {
    let mut socket = UnixStream::connect(&worker.socket)
        .await
        .map_err(internal)?;
    let mut bytes = serde_json::to_vec(&header).map_err(|e| internal(e.into()))?;
    bytes.push(b'\n');
    socket.write_all(&bytes).await.map_err(internal)?;
    Ok(BufReader::new(socket))
}

#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum Reply {
    Created { ok: bool },
    Export { size: u64 },
    Removed { missing: bool },
    Error { error: String },
}

async fn reply(socket: &mut BufReader<UnixStream>) -> Result<Reply, Error> {
    let answer = serde_json::from_slice(&line(socket, MAX_REPLY).await?)
        .map_err(|_| bad("invalid worker checkout response"))?;
    if let Reply::Error { error } = answer {
        let message: String = error
            .chars()
            .filter(|c| !c.is_control())
            .take(ERROR_CHARS)
            .collect();
        return Err(conflict(&format!("worker: {message}")));
    }
    Ok(answer)
}

pub(in crate::acp) async fn create(
    git: Git<'_>,
    worker: &AgentWorker,
    cwd: &Path,
    request: &WorktreeRequest,
    sid: &str,
    created_at: u64,
    mut cancel: oneshot::Receiver<()>,
) -> Result<ManagedWorktree, CreateFailure> {
    if !valid_sid(sid) || !request.valid() || request.branch.ends_with('.') {
        return Err(CreateFailure::Clean(bad(
            "invalid worker session, branch or base",
        )));
    }
    let path = worker.root.join(format!("{sid}-{created_at}"));
    let path = path
        .to_str()
        .ok_or_else(|| CreateFailure::Clean(bad("worker root is not UTF-8")))?;
    let mut sent = false;
    let create = async {
        let root = checkout_root(git, worker, cwd).await?;
        let main_root = root
            .to_str()
            .ok_or_else(|| bad("owner checkout is not UTF-8"))?;
        if !query(
            git,
            &root,
            &["rev-parse", "--show-superproject-working-tree"],
        )
        .await?
        .is_empty()
        {
            return Err(bad("source checkout is a submodule"));
        }
        let base = format!("{}^{{commit}}", request.base.as_deref().unwrap_or("HEAD"));
        let out = query(
            git,
            &root,
            &["rev-parse", "--verify", "--end-of-options", &base],
        )
        .await?;
        let tip = object_id(out.strip_suffix(b"\n").unwrap_or_default())?;
        let branch = &request.branch;
        let full = format!("refs/heads/{branch}");
        owner_git(
            git,
            &root,
            &["branch", "--no-track", "--", branch, tip],
            Stdio::null(),
            ErrorCode::Conflict,
        )
        .await?;
        // Git writes/renames its bundle inside a 0700 owner-only directory;
        // even an externally set umask cannot expose it to the worker.
        let dir = tempfile::tempdir().map_err(internal)?;
        let bundle = dir.path().join("seed.bundle");
        let name = bundle
            .to_str()
            .ok_or_else(|| bad("temporary directory is not UTF-8"))?;
        query(
            git,
            &root,
            &["bundle", "create", "--quiet", "--version=3", name, &full],
        )
        .await?;
        let mut bundle = BufReader::new(fs::File::open(&bundle).await.map_err(internal)?);
        let size = bundle.get_ref().metadata().await.map_err(internal)?.len();
        if size > MAX_BUNDLE {
            return Err(bad("seed bundle exceeds transfer limit"));
        }
        if bundle_tip(&mut bundle, &full).await? != tip {
            return Err(conflict(
                "owner branch changed while seeding worker checkout",
            ));
        }
        bundle.seek(SeekFrom::Start(0)).await.map_err(internal)?;
        sent = true;
        let mut socket = connect(
            worker,
            json!({"op":"create", "cwd":path, "sid":sid,
            "branch":branch, "format":if tip.len() == 40 {"sha1"} else {"sha256"}, "size":size}),
        )
        .await?;
        tokio::io::copy(&mut bundle, socket.get_mut())
            .await
            .map_err(internal)?;
        if !matches!(reply(&mut socket).await?, Reply::Created { ok: true }) {
            return Err(bad("worker did not confirm checkout creation"));
        }
        Ok(ManagedWorktree {
            main_root: main_root.into(),
            path: path.into(),
            branch: branch.clone(),
        })
    };
    let result = tokio::select! {
        biased;
        _ = &mut cancel => Err(cancelled()),
        result = timeout(GIT_WORKTREE_TIMEOUT, create) => result.unwrap_or_else(|_| Err(timed_out())),
    };
    result.map_err(|(code, msg)| {
        if sent {
            CreateFailure::PossibleLeftover((
                code,
                format!("{msg}; inspect worker checkout {path}"),
            ))
        } else {
            CreateFailure::Clean((code, msg))
        }
    })
}

pub(in crate::acp) async fn fetch(
    git: Git<'_>,
    worker: &AgentWorker,
    record: &ManagedWorktree,
    sid: &str,
) -> Result<(), Error> {
    if !valid_record(worker, record, sid) {
        return Err(bad("invalid worker checkout record"));
    }
    timeout(GIT_WORKTREE_TIMEOUT, async {
        let root = checkout_root(git, worker, Path::new(&record.main_root)).await?;
        if root != Path::new(&record.main_root) {
            return Err(conflict(
                "owner checkout no longer exists at its recorded root",
            ));
        }
        let mut socket = connect(
            worker,
            json!({"op":"export", "sid":sid, "branch":record.branch, "cwd":record.path}),
        )
        .await?;
        let Reply::Export {
            size: size @ 1..=MAX_BUNDLE,
        } = reply(&mut socket).await?
        else {
            return Err(bad("invalid worker export size"));
        };
        let full = format!("refs/heads/{}", record.branch);
        let mut body = socket.take(size);
        let tip = bundle_tip(&mut body, &full).await?;
        let mut pack = fs::File::from_std(tempfile::tempfile().map_err(internal)?);
        tokio::io::copy(&mut body, &mut pack)
            .await
            .map_err(internal)?;
        if body.limit() != 0 {
            return Err(bad("truncated worker export"));
        }
        drop(body);
        pack.rewind().await.map_err(internal)?;
        owner_git(
            git,
            &root,
            &["index-pack", "--strict", "--stdin"],
            Stdio::from(pack.into_std().await),
            ErrorCode::BadRequest,
        )
        .await?;
        // Refuse checked-out, missing, or symbolic destinations. Check the
        // exact old OID both for ancestry and at publication, not just its name.
        let dst = query(
            git,
            &root,
            &[
                "for-each-ref",
                "--format=%(objectname)%09%(worktreepath)%09%(symref)%09%(refname)",
                "--",
                &full,
            ],
        )
        .await?;
        let fields = dst
            .strip_suffix(format!("\t\t\t{full}\n").as_bytes())
            .ok_or_else(|| conflict("owner branch is missing, symbolic or checked out"))?;
        let old = object_id(fields)?;
        if old.len() != tip.len() {
            return Err(bad("worker and owner object formats differ"));
        }
        if query(git, &root, &["cat-file", "-t", &tip]).await? != b"commit\n" {
            return Err(bad("worker branch does not point to a commit"));
        }
        owner_git(
            git,
            &root,
            &["merge-base", "--is-ancestor", old, &tip],
            Stdio::null(),
            ErrorCode::Conflict,
        )
        .await
        .map_err(|(_, message)| {
            conflict(&format!("worker branch is not a fast-forward: {message}"))
        })?;
        owner_git(
            git,
            &root,
            &["update-ref", "--no-deref", &full, &tip, old],
            Stdio::null(),
            ErrorCode::Conflict,
        )
        .await?;
        Ok(())
    })
    .await
    .map_err(|_| timed_out())?
}

pub(in crate::acp) async fn remove(
    _git: Git<'_>,
    worker: &AgentWorker,
    record: &ManagedWorktree,
    sid: &str,
) -> Result<bool, Error> {
    if !valid_record(worker, record, sid) {
        return Err(bad("invalid worker checkout record"));
    }
    timeout(GIT_WORKTREE_TIMEOUT, async {
        let mut socket = connect(
            worker,
            json!({"op":"remove", "sid":sid, "branch":record.branch, "cwd":record.path}),
        )
        .await?;
        match reply(&mut socket).await? {
            Reply::Removed { missing: true } => Ok(false),
            _ => Err(bad("unexpected worker removal response")),
        }
    })
    .await
    .map_err(|_| timed_out())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn accept_only_one_complete_unfiltered_branch() {
        let full = "refs/heads/work";
        for (format, digits) in [("sha1", 40), ("sha256", 64)] {
            let oid = "a".repeat(digits);
            let prefix = format!("# v3 git bundle\n@object-format={format}\n");
            let head = format!("{oid} {full}\n");
            let valid = format!("{prefix}{head}\nPACK");
            let mut reader = valid.as_bytes();
            assert_eq!(bundle_tip(&mut reader, full).await.unwrap(), oid);
            assert_eq!(reader, b"PACK");
            for invalid in [
                "file:///tmp/repo\n".to_owned(),
                format!("{prefix}@filter=blob:none\n{head}\n"),
                format!("{prefix}-{oid} prerequisite\n{head}\n"),
                format!("{prefix}{oid} refs/tags/work\n\n"),
                format!("{prefix}{oid} refs/heads/other\n\n"),
                format!("{prefix}{head}{oid} refs/heads/other\n\n"),
                format!("{prefix}Z{} {full}\n\n", &oid[1..]),
                format!("{prefix}{head}"),
            ] {
                assert!(bundle_tip(&mut invalid.as_bytes(), full).await.is_err());
            }
        }
    }

    #[test]
    fn record_must_name_this_session_under_the_configured_root() {
        let worker = AgentWorker {
            root: "/worker/work".into(),
            socket: "/sock".into(),
        };
        let mut record = ManagedWorktree {
            branch: "feature/example".into(),
            path: "/worker/work/a-b-18446744073709551615".into(),
            main_root: "/owner/repo".into(),
        };
        assert!(valid_record(&worker, &record, "a-b"));
        for path in [
            "/worker/work/a-b-018",
            "/worker/work/a-b-+18",
            "/worker/work/a-b-18446744073709551616",
            "/worker/work/a-b-x-18",
            "/worker/work2/a-b-18",
            "/worker/work/sibling/a-b-18",
        ] {
            record.path = path.into();
            assert!(!valid_record(&worker, &record, "a-b"));
        }
    }
}
