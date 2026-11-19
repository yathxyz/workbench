//! Explicitly managed local git worktrees. No shell, force, fetch or branch deletion.

use std::env;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::process::{Output, Stdio};
use std::time::Duration;

use rustix::process::Signal;
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::process::Command;
use wb_proto::hub::{ErrorCode, ManagedWorktree, WorktreeRequest};
use wb_proto::limits::{GIT_ADD_TIMEOUT, GIT_TIMEOUT};

use super::agent::signal_group;

type Error = (ErrorCode, String);
const PIPE_BYTES: usize = 8192;
const ERROR_CHARS: usize = 512;

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

struct KillGroup(Option<u32>);

impl Drop for KillGroup {
    fn drop(&mut self) {
        if let Some(id) = self.0 {
            signal_group(id, Signal::KILL);
        }
    }
}

async fn run(git: &Path, cwd: &Path, args: &[&str], limit: Duration) -> Result<Output, Error> {
    let mut cmd = Command::new(git);
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
        .process_group(0)
        .kill_on_drop(true);
    for key in ["HOME", "XDG_CONFIG_HOME"] {
        if let Some(value) = env::var_os(key) {
            cmd.env(key, value);
        }
    }
    let mut child = cmd.spawn().map_err(internal)?;
    let mut group = KillGroup(child.id());
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let output = tokio::time::timeout(limit, async {
        // Don't reap the group leader until the pipes close: a filter can inherit a
        // pipe, outlive git and hang the request. Its group ID stays ours to kill.
        let (stdout, stderr) = tokio::try_join!(prefix(stdout), first_error(stderr))?;
        let status = child.wait().await?;
        Ok(Output {
            status,
            stdout,
            stderr,
        })
    })
    .await
    .map_err(|_| (ErrorCode::Timeout, format!("git {} timed out", args[0])))?
    .map_err(internal)?;
    group.0 = None;
    Ok(output)
}

fn failure(output: &Output, code: ErrorCode) -> Error {
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

fn checked(output: Output, code: ErrorCode) -> Result<Vec<u8>, Error> {
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

async fn main_checkout(git: &Path, cwd: &Path) -> Result<String, Error> {
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
    let list = run(
        git,
        cwd,
        &["worktree", "list", "--porcelain", "-z"],
        GIT_TIMEOUT,
    )
    .await?;
    let bytes = checked(list, ErrorCode::BadRequest)?;
    // The first record is the main worktree. -z avoids Git's path quoting and
    // preserves spaces and newlines in paths; later records need not fit in our cap.
    let end = bytes
        .windows(2)
        .position(|pair| pair == b"\0\0")
        .ok_or_else(|| {
            (
                ErrorCode::BadRequest,
                "no complete main worktree record".into(),
            )
        })?;
    let mut fields = bytes[..end].split(|b| *b == 0);
    let root = fields
        .next()
        .and_then(|s| s.strip_prefix(b"worktree "))
        .ok_or_else(|| (ErrorCode::BadRequest, "invalid main worktree record".into()))?;
    if fields.any(|s| s == b"bare") {
        return Err((ErrorCode::BadRequest, "repository is bare".into()));
    }
    let root = absolute_path(root)?;
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

async fn add(git: &Path, cwd: &Path, path: &str, request: &WorktreeRequest) -> Result<(), Error> {
    let branch = &request.branch;
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
    let added = run(
        git,
        cwd,
        &["worktree", "add", "--", path, branch],
        GIT_ADD_TIMEOUT,
    )
    .await?;
    checked(added, ErrorCode::Conflict)?;
    Ok(())
}

pub(super) async fn create(
    git: &Path,
    cwd: &Path,
    request: &WorktreeRequest,
) -> Result<ManagedWorktree, Error> {
    if !request.valid() {
        return Err((
            ErrorCode::BadRequest,
            "invalid worktree branch or base".into(),
        ));
    }
    let main_root = main_checkout(git, cwd).await?;
    let parent = format!("{main_root}-wt");
    let path = format!("{parent}/{}", request.branch.replace('/', "-"));
    fs::create_dir_all(&parent).await.map_err(internal)?;
    // A check followed by `git worktree add` is racy: git accepts existing empty
    // directories. Atomically reserve this name, including against dangling links.
    fs::create_dir(&path).await.map_err(|e| {
        if e.kind() == io::ErrorKind::AlreadyExists {
            (
                ErrorCode::Conflict,
                format!("worktree path already exists: {path}"),
            )
        } else {
            internal(e)
        }
    })?;
    let reservation = fs::File::open(&path).await.map_err(internal)?;
    let ours = reservation.metadata().await.map_err(internal)?;
    if let Err((code, message)) = add(git, cwd, &path, request).await {
        // Git may already have removed its junk. Never recursively delete a
        // partial/dirty checkout or clean up another request's replacement directory.
        match fs::symlink_metadata(&path).await {
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Ok(m) if (m.dev(), m.ino()) == (ours.dev(), ours.ino()) => {
                if let Err(e) = fs::remove_dir(&path).await
                    && e.kind() != io::ErrorKind::NotFound
                {
                    return Err((
                        code,
                        format!("{message}; worktree path left at {path}: {e}"),
                    ));
                }
            }
            Ok(_) => (),
            Err(e) => return Err((code, format!("{message}; could not inspect {path}: {e}"))),
        }
        return Err((code, message));
    }
    Ok(ManagedWorktree {
        path,
        branch: request.branch.clone(),
        main_root,
    })
}

pub(super) async fn remove(git: &Path, record: &ManagedWorktree) -> Result<(), Error> {
    // worktree remove's internal `git status --porcelain` otherwise honors a
    // status.showUntrackedFiles=no setting and deletes non-ignored untracked files.
    let removed = run(
        git,
        Path::new(&record.main_root),
        &[
            "-c",
            "status.showUntrackedFiles=all",
            "worktree",
            "remove",
            "--",
            &record.path,
        ],
        GIT_TIMEOUT,
    )
    .await?;
    checked(removed, ErrorCode::Conflict)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs::{self, Permissions};
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;

    fn program(name: &str) -> PathBuf {
        env::split_paths(&env::var_os("PATH").unwrap())
            .filter(|dir| dir.is_absolute())
            .map(|dir| dir.join(name))
            .find(|path| path.is_file())
            .unwrap_or_else(|| panic!("{name} missing from test PATH"))
    }

    struct Fixture {
        temp: PathBuf,
        git: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let parent = env::temp_dir().canonicalize().unwrap();
            // Even the not-in-a-checkout case must never discover this checkout.
            assert!(!parent.ancestors().any(|dir| dir.join(".git").exists()
                || (dir.join("HEAD").exists() && dir.join("objects").is_dir())));
            loop {
                let n = NEXT.fetch_add(1, Ordering::Relaxed);
                let temp = parent.join(format!("wb-worktree-{}-{n}", std::process::id()));
                match fs::create_dir(&temp) {
                    Ok(()) => {
                        return Self {
                            temp,
                            git: program("git"),
                        };
                    }
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(e) => panic!("create fixture: {e}"),
                }
            }
        }

        fn git(&self, cwd: &Path, args: &[&str]) -> String {
            assert!(cwd.starts_with(&self.temp));
            let out = std::process::Command::new(&self.git)
                .current_dir(cwd)
                .env_clear()
                .env("HOME", &self.temp)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .args([
                    "-c",
                    "core.hooksPath=/dev/null",
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                ])
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8(out.stdout)
                .unwrap()
                .trim_end_matches('\n')
                .to_owned()
        }

        fn repo(&self) -> PathBuf {
            let repo = self.temp.join("main repo");
            fs::create_dir(&repo).unwrap();
            self.git(&repo, &["init", "-b", "main"]);
            fs::write(repo.join("tracked"), "clean\n").unwrap();
            self.git(&repo, &["add", "tracked"]);
            self.git(&repo, &["commit", "-m", "first"]);
            repo
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.temp).unwrap();
        }
    }

    fn request(branch: &str, base: Option<&str>) -> WorktreeRequest {
        WorktreeRequest {
            branch: branch.into(),
            base: base.map(str::to_owned),
        }
    }

    fn script(path: &Path, body: &str) {
        fs::write(path, format!("#!{}\n{body}\n", program("sh").display())).unwrap();
        fs::set_permissions(path, Permissions::from_mode(0o700)).unwrap();
    }

    #[tokio::test]
    async fn new_branches_use_checkout_head_named_base_or_id_without_tracking() {
        let f = Fixture::new();
        let repo = f.repo();
        let first = f.git(&repo, &["rev-parse", "HEAD"]);
        f.git(&repo, &["tag", "release"]);
        f.git(&repo, &["remote", "add", "origin", "./unused"]);
        f.git(&repo, &["update-ref", "refs/remotes/origin/main", &first]);
        f.git(&repo, &["config", "branch.autoSetupMerge", "always"]);
        f.git(&repo, &["commit", "--allow-empty", "-m", "second"]);
        let head = f.git(&repo, &["rev-parse", "HEAD"]);
        let nested = repo.join("one/two");
        fs::create_dir_all(&nested).unwrap();
        for (branch, base, expected) in [
            ("topic/default", None, &head),
            ("from-tag", Some("release"), &first),
            ("from-id", Some(first.as_str()), &first),
            ("from-remote", Some("origin/main"), &first),
        ] {
            let record = create(&f.git, &nested, &request(branch, base))
                .await
                .unwrap();
            let wt = Path::new(&record.path);
            assert_eq!(
                wt,
                f.temp.join("main repo-wt").join(branch.replace('/', "-"))
            );
            assert_eq!(Path::new(&record.main_root), repo);
            assert_eq!(record.branch, branch);
            assert_eq!(&f.git(wt, &["rev-parse", "HEAD"]), expected);
            assert_eq!(
                f.git(wt, &["symbolic-ref", "HEAD"]),
                format!("refs/heads/{branch}")
            );
            assert!(
                f.git(
                    wt,
                    &[
                        "for-each-ref",
                        "--format=%(upstream)",
                        &format!("refs/heads/{branch}")
                    ]
                )
                .is_empty()
            );
        }
    }

    #[tokio::test]
    async fn linked_subdirectory_uses_linked_head_but_main_checkout_sibling() {
        let f = Fixture::new();
        let repo = f.repo();
        let old = f.git(&repo, &["rev-parse", "HEAD"]);
        let linked = f.temp.join("linked");
        f.git(
            &repo,
            &[
                "worktree",
                "add",
                "--detach",
                "--",
                linked.to_str().unwrap(),
                &old,
            ],
        );
        f.git(&repo, &["commit", "--allow-empty", "-m", "second"]);
        let cwd = linked.join("dir");
        fs::create_dir(&cwd).unwrap();
        let record = create(&f.git, &cwd, &request("linked-head", None))
            .await
            .unwrap();
        assert_eq!(Path::new(&record.main_root), repo);
        assert_eq!(
            Path::new(&record.path),
            f.temp.join("main repo-wt/linked-head")
        );
        assert_eq!(f.git(Path::new(&record.path), &["rev-parse", "HEAD"]), old);
    }

    #[tokio::test]
    async fn existing_local_branch_is_attached_not_reset_or_detached_at_same_named_tag() {
        let f = Fixture::new();
        let repo = f.repo();
        let first = f.git(&repo, &["rev-parse", "HEAD"]);
        let branch = &first[..8]; // Also resolves as an abbreviated commit name.
        f.git(&repo, &["tag", branch]);
        f.git(&repo, &["commit", "--allow-empty", "-m", "second"]);
        let second = f.git(&repo, &["rev-parse", "HEAD"]);
        f.git(&repo, &["branch", branch]);
        let record = create(&f.git, &repo, &request(branch, Some("missing-base")))
            .await
            .unwrap();
        let wt = Path::new(&record.path);
        assert_eq!(f.git(wt, &["rev-parse", "HEAD"]), second);
        assert_eq!(
            f.git(wt, &["symbolic-ref", "HEAD"]),
            format!("refs/heads/{branch}")
        );

        let (code, msg) = create(&f.git, &repo, &request("main", None))
            .await
            .unwrap_err();
        assert_eq!(code, ErrorCode::Conflict);
        assert!(msg.starts_with("fatal:"), "{msg}");
        assert!(!f.temp.join("main repo-wt/main").exists());
    }

    #[tokio::test]
    async fn reserves_path_without_touching_any_existing_entry() {
        let f = Fixture::new();
        let repo = f.repo();
        let parent = f.temp.join("main repo-wt");
        fs::create_dir(&parent).unwrap();
        fs::create_dir(parent.join("empty")).unwrap();
        fs::write(parent.join("file"), b"keep").unwrap();
        symlink("missing", parent.join("dangling")).unwrap();
        for name in ["empty", "file", "dangling"] {
            let err = create(&f.git, &repo, &request(name, None))
                .await
                .unwrap_err();
            assert_eq!(err.0, ErrorCode::Conflict);
            assert!(f.git(&repo, &["branch", "--list", name]).is_empty());
        }
        assert_eq!(fs::read_dir(parent.join("empty")).unwrap().count(), 0);
        assert_eq!(fs::read(parent.join("file")).unwrap(), b"keep");
        assert_eq!(
            fs::read_link(parent.join("dangling")).unwrap(),
            Path::new("missing")
        );

        let a = request("a/b", None);
        let b = request("a-b", None);
        let (one, two) = tokio::join!(create(&f.git, &repo, &a), create(&f.git, &repo, &b));
        match (one, two) {
            (Ok(rec), Err(err)) | (Err(err), Ok(rec)) => {
                assert_eq!(err.0, ErrorCode::Conflict);
                assert_eq!(
                    f.git(Path::new(&rec.path), &["symbolic-ref", "--short", "HEAD"]),
                    rec.branch
                );
            }
            results => panic!("exactly one request must claim the path: {results:?}"),
        }
    }

    #[tokio::test]
    async fn refuses_non_checkout_bare_and_missing_base() {
        let f = Fixture::new();
        let repo = f.repo();
        let bare = f.temp.join("bare");
        fs::create_dir(&bare).unwrap();
        f.git(&bare, &["init", "--bare"]);
        for cwd in [&f.temp, &bare, &repo.join(".git")] {
            assert_eq!(
                create(&f.git, cwd, &request("no", None))
                    .await
                    .unwrap_err()
                    .0,
                ErrorCode::BadRequest
            );
        }
        assert_eq!(
            create(&f.git, &repo, &request("no", Some("nowhere")))
                .await
                .unwrap_err()
                .0,
            ErrorCode::BadRequest
        );
        assert!(!f.temp.join("main repo-wt/no").exists());
        assert!(f.git(&repo, &["branch", "--list", "no"]).is_empty());
    }

    #[tokio::test]
    async fn invalid_names_are_refused_before_git_runs() {
        let f = Fixture::new();
        let missing = f.temp.join("there-is-no-git");
        for name in [
            "",
            "-x",
            "--upload-pack=x",
            "..",
            "a/../b",
            ".x",
            "a/.x",
            "x.lock",
            "a.lock/b",
            "HEAD",
            "a b",
            "a@{1}",
            "a\nb",
            "a\0b",
            "/a",
            "a/",
            "a//b",
            "a~1",
            "a^",
            "a:b",
            &"a".repeat(256),
        ] {
            for req in [request(name, None), request("valid", Some(name))] {
                assert_eq!(
                    create(&missing, &f.temp, &req).await.unwrap_err().0,
                    ErrorCode::BadRequest,
                    "{name:?}"
                );
            }
        }
    }

    #[tokio::test]
    async fn hooks_are_disabled_and_only_clean_worktrees_can_be_removed() {
        let f = Fixture::new();
        let repo = f.repo();
        let hooks = f.temp.join("hooks");
        fs::create_dir(&hooks).unwrap();
        f.git(
            &repo,
            &["config", "core.hooksPath", hooks.to_str().unwrap()],
        );
        f.git(
            &repo,
            &["config", "hook.fixture.command", ": > hook-ran; exit 1"],
        );
        f.git(&repo, &["config", "hook.fixture.event", "post-checkout"]);
        f.git(&repo, &["config", "status.showUntrackedFiles", "no"]);
        script(&hooks.join("post-checkout"), ": > hook-ran\nexit 1");
        let fsmonitor = hooks.join("fsmonitor");
        script(&fsmonitor, ": > fsmonitor-ran\nexit 1");
        f.git(
            &repo,
            &["config", "core.fsmonitor", fsmonitor.to_str().unwrap()],
        );
        let record = create(&f.git, &repo, &request("keep-branch", None))
            .await
            .unwrap();
        let wt = Path::new(&record.path);
        assert!(!wt.join("hook-ran").exists());
        assert!(!wt.join("fsmonitor-ran").exists());
        for dirty in ["tracked", "untracked"] {
            fs::write(wt.join(dirty), b"keep").unwrap();
            let (code, msg) = remove(&f.git, &record).await.unwrap_err();
            assert_eq!(code, ErrorCode::Conflict);
            assert!(msg.starts_with("fatal:"), "{msg}");
            assert_eq!(fs::read(wt.join(dirty)).unwrap(), b"keep");
            if dirty == "tracked" {
                fs::write(wt.join(dirty), b"clean\n").unwrap();
            } else {
                fs::remove_file(wt.join(dirty)).unwrap();
            }
        }
        remove(&f.git, &record).await.unwrap();
        assert!(!wt.exists());
        assert_eq!(
            f.git(&repo, &["rev-parse", "refs/heads/keep-branch"]),
            f.git(&repo, &["rev-parse", "HEAD"])
        );
    }

    #[tokio::test]
    async fn git_deadline_includes_descendants_holding_the_pipes() {
        let f = Fixture::new();
        let fake = f.temp.join("sleeping-git");
        // The group leader exits before its helper. Killing just the direct child
        // would leave the pipe open and let the helper create its marker.
        script(
            &fake,
            &format!(
                "( '{}' 2 && : > survived ) &\n: > started\nexit 0",
                program("sleep").display()
            ),
        );
        let (code, _) = run(&fake, &f.temp, &["sleep"], Duration::from_millis(500))
            .await
            .unwrap_err();
        assert_eq!(code, ErrorCode::Timeout);
        assert!(f.temp.join("started").is_file());
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(!f.temp.join("survived").exists());
    }

    #[tokio::test]
    async fn output_and_error_lines_are_bounded_and_strip_controls() {
        let f = Fixture::new();
        let fake = f.temp.join("noisy-git");
        script(
            &fake,
            "printf 'Preparing worktree\\nfatal: \\033\\r\\tx' >&2\ni=0\nwhile [ \"$i\" -lt 3000 ]; do printf '12345678'; printf '12345678' >&2; i=$((i+1)); done\nexit 1",
        );
        let output = run(&fake, &f.temp, &["noisy"], GIT_TIMEOUT).await.unwrap();
        assert_eq!(
            (output.stdout.len(), output.stderr.len()),
            (PIPE_BYTES, PIPE_BYTES / 2)
        );
        let (_, msg) = failure(&output, ErrorCode::Conflict);
        assert!(msg.starts_with("fatal: x"));
        assert!(!msg.chars().any(char::is_control));
        assert_eq!(msg.len(), ERROR_CHARS);
    }
}
