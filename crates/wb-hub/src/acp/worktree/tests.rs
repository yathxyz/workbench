use std::fs;
use std::os::unix::fs::symlink;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use super::*;

#[path = "../../../tests/common/script.rs"]
mod executable;

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
            .env("PATH", env::var_os("PATH").unwrap())
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

const SID: &str = "fixture-session";

fn test_git(program: &Path) -> Git<'_> {
    static REAPER: std::sync::LazyLock<Sender<Child>> =
        std::sync::LazyLock::new(|| crate::child::start_reaper().unwrap());
    Git {
        program,
        reaper: &REAPER,
    }
}

async fn remove(program: &Path, record: &ManagedWorktree, sid: &str) -> Result<bool, Error> {
    super::remove(test_git(program), record, sid).await
}

async fn create(
    git: &Path,
    cwd: &Path,
    request: &WorktreeRequest,
) -> Result<ManagedWorktree, Error> {
    create_at(git, cwd, None, request).await
}

async fn create_at(
    git: &Path,
    cwd: &Path,
    root: Option<&Path>,
    request: &WorktreeRequest,
) -> Result<ManagedWorktree, Error> {
    let (_tx, rx) = oneshot::channel();
    super::create(test_git(git), cwd, root, request, SID, rx)
        .await
        .map_err(|failure| match failure {
            CreateFailure::Clean(err) => err,
            CreateFailure::PossibleLeftover(err) => panic!("unexpected leftover: {err:?}"),
        })
}

fn script(path: &Path, body: &str) {
    executable::write(&program("sh"), path, body);
}

#[tokio::test]
async fn branch_conflict_after_large_worktree_records_is_not_lost() {
    let f = Fixture::new();
    let repo = f.repo();
    let a = f.temp.join("a\nlocked");
    let a = a.to_str().unwrap();
    f.git(&repo, &["worktree", "add", "--detach", "--", a]);
    f.git(
        &repo,
        &[
            "worktree",
            "lock",
            "--reason",
            &"x".repeat(PIPE_BYTES * 2),
            "--",
            a,
        ],
    );
    let z = f.temp.join("z");
    f.git(
        &repo,
        &["worktree", "add", "-b", "busy", "--", z.to_str().unwrap()],
    );
    let err = create(&f.git, &repo, &request("busy", None))
        .await
        .unwrap_err();
    assert_eq!(
        err,
        (
            ErrorCode::Conflict,
            "branch busy is already checked out in another worktree".into()
        )
    );
}

#[tokio::test]
async fn existing_registration_at_missing_destination_is_never_unlocked_or_removed() {
    let f = Fixture::new();
    let repo = f.repo();
    let target = f.temp.join("main repo-wt/reuse");
    let path = target.to_str().unwrap();
    f.git(&repo, &["worktree", "add", "-b", "older", "--", path]);
    f.git(
        &repo,
        &["worktree", "lock", "--reason", "keep me", "--", path],
    );
    fs::remove_dir_all(&target).unwrap();
    let before = f.git(&repo, &["worktree", "list", "--porcelain"]);
    let err = create(&f.git, &repo, &request("reuse", None))
        .await
        .unwrap_err();
    assert_eq!(
        err,
        (
            ErrorCode::Conflict,
            format!("worktree path is already registered: {path}")
        )
    );
    assert!(!target.exists());
    assert_eq!(f.git(&repo, &["worktree", "list", "--porcelain"]), before);
    assert!(f.git(&repo, &["branch", "--list", "reuse"]).is_empty());
}

#[tokio::test]
async fn refuses_submodule_and_trailing_dot() {
    let f = Fixture::new();
    let repo = f.repo();
    let superproject = f.temp.join("superproject");
    f.git(&f.temp, &["init", superproject.to_str().unwrap()]);
    f.git(
        &superproject,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "--",
            repo.to_str().unwrap(),
            "child",
        ],
    );
    let cwd = superproject.join("child/nested");
    fs::create_dir(&cwd).unwrap();
    assert_eq!(
        create(&f.git, &cwd, &request("side", None))
            .await
            .unwrap_err(),
        (ErrorCode::BadRequest, "cwd is inside a submodule".into())
    );
    assert!(!superproject.join("child-wt").exists());
    assert_eq!(
        create(&f.git, &repo, &request("trailing.", None))
            .await
            .unwrap_err()
            .0,
        ErrorCode::BadRequest
    );
    assert!(!f.temp.join("main repo-wt/trailing.").exists());
}

#[tokio::test]
async fn checkout_uses_filters_on_path_and_reports_missing_required_filter() {
    let f = Fixture::new();
    let repo = f.repo();
    fs::write(repo.join(".gitattributes"), "tracked filter=fixture\n").unwrap();
    f.git(&repo, &["add", ".gitattributes"]);
    f.git(&repo, &["commit", "-m", "attributes"]);
    f.git(&repo, &["config", "filter.fixture.clean", "cat"]);
    f.git(&repo, &["config", "filter.fixture.smudge", "tr a-z A-Z"]);
    f.git(&repo, &["config", "filter.fixture.required", "true"]);
    let record = create(&f.git, &repo, &request("available", None))
        .await
        .unwrap();
    assert_eq!(
        fs::read(Path::new(&record.path).join("tracked")).unwrap(),
        b"CLEAN\n"
    );
    f.git(
        &repo,
        &[
            "config",
            "filter.fixture.smudge",
            "wb-no-such-required-filter",
        ],
    );
    let (code, message) = create(&f.git, &repo, &request("missing", None))
        .await
        .unwrap_err();
    assert_eq!(code, ErrorCode::Internal);
    assert_eq!(
        message,
        "error: cannot run wb-no-such-required-filter: No such file or directory"
    );
}

#[tokio::test]
async fn ignored_secrets_and_nested_repository_are_deleted_but_untracked_files_refuse() {
    let f = Fixture::new();
    let repo = f.repo();
    fs::write(repo.join(".gitignore"), "/.env\n/private/\n").unwrap();
    f.git(&repo, &["add", ".gitignore"]);
    f.git(&repo, &["commit", "-m", "ignore local files"]);
    let record = create(&f.git, &repo, &request("ignored", None))
        .await
        .unwrap();
    let wt = Path::new(&record.path);
    fs::write(wt.join(".env"), b"local configuration").unwrap();
    let nested = wt.join("private");
    f.git(wt, &["init", "private"]);
    fs::write(nested.join("unpublished"), b"only copy").unwrap();
    f.git(&nested, &["add", "unpublished"]);
    f.git(&nested, &["commit", "-m", "never pushed"]);
    let head = f.git(&nested, &["rev-parse", "HEAD"]);
    fs::write(wt.join("untracked"), b"keep").unwrap();
    assert_eq!(
        remove(&f.git, &record, SID).await.unwrap_err().0,
        ErrorCode::Conflict
    );
    assert_eq!(fs::read(wt.join(".env")).unwrap(), b"local configuration");
    assert_eq!(f.git(&nested, &["rev-parse", "HEAD"]), head);
    assert_eq!(fs::read(wt.join("untracked")).unwrap(), b"keep");
    fs::remove_file(wt.join("untracked")).unwrap();
    assert!(remove(&f.git, &record, SID).await.unwrap());
    assert!(!wt.exists() && !nested.join(".git").exists());
}

#[tokio::test]
async fn stale_records_leave_no_worktree_and_replacements_alone() {
    let f = Fixture::new();
    let repo = f.repo();
    let req = request("reused", None);
    let original = create(&f.git, &repo, &req).await.unwrap();
    let wt = Path::new(&original.path);
    f.git(&repo, &["worktree", "remove", "--", &original.path]);
    assert!(!remove(&f.git, &original, SID).await.unwrap());

    // Even a parent repo with a matching marker does not own this path.
    f.git(wt.parent().unwrap(), &["init"]);
    fs::write(wt.parent().unwrap().join(".git").join(MARKER), SID).unwrap();
    fs::create_dir(wt).unwrap();
    assert!(!remove(&f.git, &original, SID).await.unwrap());
    for invalid in ["arbitrary file\n", "gitdir: missing-admin-dir\n"] {
        fs::write(wt.join(".git"), invalid).unwrap();
        assert!(!remove(&f.git, &original, SID).await.unwrap());
    }
    fs::remove_file(wt.join(".git")).unwrap();
    fs::remove_dir(wt).unwrap();

    let (_tx, rx) = oneshot::channel();
    let other = super::create(test_git(&f.git), &repo, None, &req, "other", rx)
        .await
        .unwrap();
    assert!(!remove(&f.git, &original, SID).await.unwrap());
    assert!(wt.join("tracked").is_file());
    assert!(remove(&f.git, &other, "other").await.unwrap());
    f.git(&repo, &["worktree", "add", "--", &original.path, "reused"]);
    assert!(!remove(&f.git, &original, SID).await.unwrap());
    assert!(wt.join("tracked").is_file());
}

#[tokio::test]
async fn lookup_errors_do_not_invalidate_ownership() {
    let f = Fixture::new();
    let repo = f.repo();
    let record = create(&f.git, &repo, &request("owner", None))
        .await
        .unwrap();
    assert_eq!(
        remove(&f.temp.join("no-git"), &record, SID)
            .await
            .unwrap_err()
            .0,
        ErrorCode::Internal
    );
    let marker = marker_path(Path::new(&record.path)).await.unwrap().unwrap();
    assert_eq!(fs::read(&marker).unwrap(), SID.as_bytes());
    fs::remove_file(&marker).unwrap();
    rustix::fs::mkfifoat(rustix::fs::CWD, &marker, rustix::fs::Mode::RUSR).unwrap();
    assert_eq!(
        remove(&f.git, &record, SID).await.unwrap_err().0,
        ErrorCode::Internal
    );
    assert!(Path::new(&record.path).join("tracked").is_file());
}

async fn wait_for(what: &str, ready: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(30), async {
        while !ready() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
}

// Pause only once the subprocess is ready. Tokio's paused clock otherwise
// auto-advances while the runtime is idle waiting on real git or its pipes.
async fn expire_when_ready<F: Future, R: Future>(command: F, ready: R) -> (F::Output, R::Output) {
    tokio::pin!(command);
    let observed = tokio::select! {
        _ = &mut command => panic!("git finished before the fixture was ready"),
        observed = ready => observed,
    };
    tokio::time::pause();
    tokio::time::advance(GIT_WORKTREE_TIMEOUT).await;
    tokio::time::resume();
    // Real time is running again before any rollback command starts.
    (command.await, observed)
}

// Run every normal git command unchanged; intercept precisely the add. The
// real git has registered and populated the worktree before the fake sleeps.
fn slow_add(f: &Fixture, wt: &Path, body: &str) -> PathBuf {
    let fake = f.temp.join("slow-add");
    script(
        &fake,
        &format!(
            "set -eu\ngit='{}'\nwt='{}'\ncase \" $* \" in\n*' worktree add -- '*)\n{body}\n: > ready\nexec '{}' 60;;\nesac\nexec \"$git\" \"$@\"",
            f.git.display(),
            wt.display(),
            program("sleep").display()
        ),
    );
    fake
}

#[tokio::test]
async fn timed_out_add_unlocks_and_force_removes_only_the_reserved_checkout() {
    let f = Fixture::new();
    let repo = f.repo();
    let root = f.temp.join("central");
    let parent = root.join(repo.strip_prefix("/").unwrap());
    let wt = parent.join("timed");
    let fake = slow_add(
        &f,
        &wt,
        "\"$git\" \"$@\"\n\"$git\" worktree lock -- \"$wt\"\n: > \"$wt/untracked\"",
    );
    let req = request("timed", None);
    let ready = repo.join("ready");
    let (result, ()) = expire_when_ready(
        create_at(&fake, &repo, Some(&root), &req),
        wait_for("registered, locked checkout", || ready.is_file()),
    )
    .await;
    assert_eq!(
        result.unwrap_err(),
        (ErrorCode::Timeout, "git worktree add timed out".into())
    );
    assert!(!wt.exists());
    assert!(parent.is_dir());
    assert!(
        !f.git(&repo, &["worktree", "list", "--porcelain"])
            .contains("refs/heads/timed")
    );
    assert!(
        f.git(&repo, &["show-ref", "--verify", "refs/heads/timed"])
            .contains("refs/heads/timed")
    );
    create_at(&f.git, &repo, Some(&root), &req).await.unwrap();
}

#[tokio::test]
async fn cancel_unregistered_unlocked_and_replaced_add() {
    for (branch, body) in [
        ("unregistered", ":"),
        ("unlocked", "\"$git\" \"$@\"\n: > \"$wt/untracked\""),
        (
            "replaced",
            "\"$git\" \"$@\"\nmv \"$wt\" \"$wt.old\"\nmkdir \"$wt\"\n: > \"$wt/keep\"",
        ),
    ] {
        let f = Fixture::new();
        let repo = f.repo();
        let wt = f.temp.join("main repo-wt").join(branch);
        let fake = slow_add(&f, &wt, body);
        let req = request(branch, None);
        let (tx, rx) = oneshot::channel();
        let creation = super::create(test_git(&fake), &repo, None, &req, SID, rx);
        let ready = repo.join("ready");
        let interrupt = async {
            wait_for("interrupted add fixture", || ready.is_file()).await;
            tx.send(()).unwrap();
        };
        let (result, ()) = tokio::join!(creation, interrupt);
        let err = result.unwrap_err();
        if branch == "replaced" {
            let CreateFailure::PossibleLeftover((code, message)) = err else {
                panic!("replacement must report a leftover: {err:?}");
            };
            assert_eq!(code, ErrorCode::Conflict);
            assert!(
                message.starts_with(&format!(
                    "{CANCELLED}; worktree path left at {}:",
                    wt.display()
                )),
                "{message}"
            );
            assert!(wt.join("keep").exists());
            assert!(wt.with_extension("old").join("tracked").is_file());
        } else {
            assert_eq!(err, CreateFailure::Clean(cancelled()));
            assert!(!wt.exists());
            assert!(
                !f.git(&repo, &["worktree", "list", "--porcelain"])
                    .contains(&format!("refs/heads/{branch}"))
            );
        }
    }
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

#[test]
fn destination_rejects_unexpected_main_checkout_components() {
    for main in ["relative", "/./repo", "/repo/.", "/nested/../repo", "/a\0b"] {
        for root in [None, Some(Path::new("/central"))] {
            assert_eq!(
                worktree_parent(main, root).unwrap_err().0,
                ErrorCode::BadRequest,
                "{main:?}"
            );
        }
    }
}

#[tokio::test]
async fn configured_root_mirrors_main_checkout_from_main_linked_and_subdirectory() {
    let f = Fixture::new();
    let repo = f.repo();
    let root = repo.join(".git-backup"); // A shared string prefix is not a .git component.
    let linked = f.temp.join("linked");
    f.git(
        &repo,
        &[
            "worktree",
            "add",
            "--detach",
            "--",
            linked.to_str().unwrap(),
        ],
    );
    let subdir = repo.join("src");
    fs::create_dir(&subdir).unwrap();
    let parent = root.join(repo.strip_prefix("/").unwrap());
    for cwd in [&repo, &linked, &subdir] {
        let record = create_at(&f.git, cwd, Some(&root), &request("feat/x", None))
            .await
            .unwrap();
        assert_eq!(Path::new(&record.main_root), repo);
        let path = Path::new(&record.path);
        assert_eq!(path, parent.join("feat-x"));
        assert_eq!(f.git(path, &["symbolic-ref", "--short", "HEAD"]), "feat/x");
        assert!(remove(&f.git, &record, SID).await.unwrap());
        assert!(!path.exists());
        assert!(parent.is_dir());
    }
}

#[tokio::test]
async fn refuses_a_destination_in_the_common_git_dir_before_creating_parents() {
    for separate in [false, true] {
        let f = Fixture::new();
        let repo = f.repo();
        let common = if separate {
            let metadata = f.temp.join("metadata");
            f.git(
                &repo,
                &["init", "--separate-git-dir", metadata.to_str().unwrap()],
            );
            metadata
        } else {
            repo.join(".git")
        };
        let root = common.join("worktrees");
        let error = create_at(&f.git, &repo, Some(&root), &request("topic", None))
            .await
            .unwrap_err();
        assert_eq!(error.0, ErrorCode::BadRequest, "{error:?}");
        assert!(
            !root.exists(),
            "created a directory under {}",
            common.display()
        );
        assert!(f.git(&repo, &["branch", "--list", "topic"]).is_empty());
    }
}

#[tokio::test]
async fn destination_parent_reports_dangling_path_or_unexpected_git_failure() {
    let f = Fixture::new();
    let repo = f.repo();
    let link = f.temp.join("dangling");
    symlink("missing", &link).unwrap();
    let error = create_at(
        &f.git,
        &repo,
        Some(&link.join("child")),
        &request("topic", None),
    )
    .await
    .unwrap_err();
    assert_eq!(error.0, ErrorCode::BadRequest);
    assert!(error.1.contains(link.to_str().unwrap()), "{error:?}");

    let git = f.temp.join("broken-git");
    script(&git, "echo 'common directory unavailable' >&2; exit 1");
    let error = check_destination_parent(test_git(&git), &repo, &f.temp)
        .await
        .unwrap_err();
    assert_eq!(
        error,
        (ErrorCode::Internal, "common directory unavailable".into())
    );
}

#[tokio::test]
async fn linked_checkout_refuses_a_mirrored_parent_symlinked_into_the_common_git_dir() {
    let f = Fixture::new();
    let repo = f.repo();
    let linked = f.temp.join("linked");
    f.git(
        &repo,
        &[
            "worktree",
            "add",
            "--detach",
            "--",
            linked.to_str().unwrap(),
        ],
    );

    // The configured root is outside the checkout; only the mirrored path enters refs.
    let root = f.temp.join("mirror");
    let mirror = root.join(repo.strip_prefix("/").unwrap());
    let alias = mirror.parent().unwrap();
    fs::create_dir_all(alias.parent().unwrap()).unwrap();
    let refs = repo.join(".git/refs");
    symlink(&refs, alias).unwrap();
    let error = create_at(&f.git, &linked, Some(&root), &request("topic", None))
        .await
        .unwrap_err();
    assert_eq!(error.0, ErrorCode::BadRequest, "{error:?}");
    assert!(!refs.join(repo.file_name().unwrap()).exists());
    assert!(f.git(&repo, &["branch", "--list", "topic"]).is_empty());
}

#[tokio::test]
async fn configured_root_separates_same_named_repositories() {
    let f = Fixture::new();
    let repo = f.repo();
    let other = f.temp.join(".worktrees/main repo");
    fs::create_dir(other.parent().unwrap()).unwrap();
    f.git(
        &f.temp,
        &[
            "clone",
            "--",
            repo.to_str().unwrap(),
            other.to_str().unwrap(),
        ],
    );
    let root = f.temp.join("central");
    for main in [&repo, &other] {
        let record = create_at(&f.git, main, Some(&root), &request("same", None))
            .await
            .unwrap();
        let expected = root.join(main.strip_prefix("/").unwrap()).join("same");
        assert_eq!(Path::new(&record.path), expected);
        assert!(expected.join("tracked").is_file());
    }
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
    assert_eq!(
        msg,
        "branch main is already checked out in another worktree"
    );
    assert!(!f.temp.join("main repo-wt/main").exists());
}

#[tokio::test]
async fn reserves_path_without_touching_any_existing_entry() {
    let f = Fixture::new();
    let repo = f.repo();
    let root = f.temp.join("central");
    let parent = root.join(repo.strip_prefix("/").unwrap());
    fs::create_dir_all(&parent).unwrap();
    fs::create_dir(parent.join("empty")).unwrap();
    fs::write(parent.join("file"), b"keep").unwrap();
    symlink("missing", parent.join("dangling")).unwrap();
    for name in ["empty", "file", "dangling"] {
        let err = create_at(&f.git, &repo, Some(&root), &request(name, None))
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
    let (one, two) = tokio::join!(
        create_at(&f.git, &repo, Some(&root), &a),
        create_at(&f.git, &repo, Some(&root), &b)
    );
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
        let (code, msg) = remove(&f.git, &record, SID).await.unwrap_err();
        assert_eq!(code, ErrorCode::Conflict);
        assert!(msg.starts_with("fatal:"), "{msg}");
        assert_eq!(fs::read(wt.join(dirty)).unwrap(), b"keep");
        if dirty == "tracked" {
            fs::write(wt.join(dirty), b"clean\n").unwrap();
        } else {
            fs::remove_file(wt.join(dirty)).unwrap();
        }
    }
    assert!(remove(&f.git, &record, SID).await.unwrap());
    assert!(!wt.exists());
    assert_eq!(
        f.git(&repo, &["rev-parse", "refs/heads/keep-branch"]),
        f.git(&repo, &["rev-parse", "HEAD"])
    );
}

// The exited git can still be a zombie: run() waits for EOF before reaping it.
fn exited(pid: u32) -> bool {
    match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat.rsplit_once(')').unwrap().1.starts_with(" Z "),
        Err(e) if e.kind() == io::ErrorKind::NotFound => true,
        Err(e) => panic!("inspect pid {pid}: {e}"),
    }
}

#[tokio::test]
async fn git_echild_leaves_the_old_group_alone() {
    let child = Command::new("true").process_group(0).spawn().unwrap();
    let pid = Pid::from_child(&child);
    // A live member makes a stray signal to the released leader's group observable.
    let mut member = tokio::process::Command::new("cat")
        .process_group(pid.as_raw_nonzero().get())
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    let stdin = member.stdin.take().unwrap();
    rustix::process::waitpid(Some(pid), rustix::process::WaitOptions::empty()).unwrap();
    let (reaper, _rx) = std::sync::mpsc::channel();
    let mut helper = GitChild {
        child: Some(child),
        reaper: &reaper,
    };
    assert!(is_echild(&helper.wait().await.unwrap_err()));
    assert!(
        helper.child.is_none(),
        "released child retained for a second wait"
    );
    drop(helper);
    drop(stdin);
    assert!(member.wait().await.unwrap().success());
}

#[tokio::test]
async fn git_deadline_includes_descendants_holding_the_pipes() {
    let f = Fixture::new();
    let fake = f.temp.join("sleeping-git");
    // The helper inherits both pipes. Its natural lifetime is longer than the
    // fixture waits, but finite in case group termination regresses.
    script(
        &fake,
        &format!(
            "'{}' 90 &\nprintf '%s %s\\n' \"$$\" \"$!\" > pids\n: > started\nexit 0",
            program("sleep").display()
        ),
    );
    let command = run(
        test_git(&fake),
        &f.temp,
        &[
            "-c",
            "status.showUntrackedFiles=all",
            "worktree",
            "remove",
            "--",
            "target",
        ],
        GIT_WORKTREE_TIMEOUT,
    );
    let started = f.temp.join("started");
    let (result, child) = expire_when_ready(command, async {
        wait_for("git helper holding the pipes", || started.is_file()).await;
        let pids = fs::read_to_string(f.temp.join("pids")).unwrap();
        let (leader, child) = pids.trim().split_once(' ').unwrap();
        let (leader, child) = (leader.parse().unwrap(), child.parse().unwrap());
        wait_for("git leader to exit", || exited(leader)).await;
        assert!(!exited(child), "git helper no longer holds the pipes");
        child
    })
    .await;
    let (code, msg) = result.unwrap_err();
    assert_eq!(code, ErrorCode::Timeout);
    assert_eq!(msg, "git worktree remove timed out");
    wait_for("timeout to kill the helper", || exited(child)).await;
}

#[tokio::test]
async fn output_and_error_lines_are_bounded_and_strip_controls() {
    let f = Fixture::new();
    let fake = f.temp.join("noisy-git");
    script(
        &fake,
        "printf 'Preparing worktree\\nfatal: \\033\\r\\tx' >&2\ni=0\nwhile [ \"$i\" -lt 3000 ]; do printf '12345678'; printf '12345678' >&2; i=$((i+1)); done\nexit 1",
    );
    let output = run(test_git(&fake), &f.temp, &["noisy"], GIT_TIMEOUT)
        .await
        .unwrap();
    assert_eq!(
        (output.stdout.len(), output.stderr.len()),
        (PIPE_BYTES, PIPE_BYTES / 2)
    );
    let (_, msg) = failure(&output, ErrorCode::Conflict);
    assert!(msg.starts_with("fatal: x"));
    assert!(!msg.chars().any(char::is_control));
    assert_eq!(msg.len(), ERROR_CHARS);
}
