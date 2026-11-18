use super::*;
use std::os::unix::fs::PermissionsExt;
use tempfile::TempDir;

fn write(path: &Path, value: impl AsRef<[u8]>) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, value).unwrap();
}

fn checkout() -> (TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("checkout");
    write(&root.join(".git/HEAD"), "ref: refs/heads/main\n");
    write(
        &root.join(".git/config"),
        "[remote \"origin\"]\nurl = https://host/owner/name.git\n",
    );
    fs::create_dir_all(root.join("src/deep")).unwrap();
    (tmp, root)
}

#[test]
fn plain_checkout_and_url_forms() {
    let (_tmp, root) = checkout();
    // A directory marker is the common dir itself; do not consult commondir.
    write(&root.join(".git/commondir"), [0xff]);
    for url in [
        "https://host/owner/name.git",
        "ssh://git@host/owner/name.git",
        "git@host:owner/name.git",
    ] {
        write(
            &root.join(".git/config"),
            format!("[remote \"origin\"]\nurl = {url}\n"),
        );
        let m = derive(&root.join("src/deep")).unwrap();
        assert_eq!(m.repo_root.as_deref(), root.to_str());
        assert_eq!(m.project_root.as_deref(), root.to_str());
        assert_eq!(m.repo.as_deref(), Some("owner/name"));
        assert_eq!(m.branch.as_deref(), Some("main"));
        assert_eq!(m.worktree, None);
    }
}

#[test]
fn linked_worktrees_outside_and_inside_claude() {
    let (tmp, root) = checkout();
    for (i, worktree) in [
        tmp.path().join("outside/topic"),
        root.join(".claude/worktrees/topic"),
    ]
    .into_iter()
    .enumerate()
    {
        let gitdir = root.join(format!(".git/worktrees/w{i}"));
        write(&gitdir.join("HEAD"), "ref: refs/heads/topic\n");
        write(&gitdir.join("commondir"), "../..\n");
        fs::create_dir_all(worktree.join("src")).unwrap();
        // Relative markers are resolved against the worktree, not cwd.
        let marker = if i == 0 {
            "../../checkout/.git/worktrees/w0"
        } else {
            "../../../.git/worktrees/w1"
        };
        write(&worktree.join(".git"), format!("gitdir: {marker}\n"));
        let m = derive(&worktree.join("src/..")).unwrap();
        assert_eq!(m.repo_root.as_deref(), root.to_str());
        assert_eq!(m.project_root.as_deref(), worktree.to_str());
        assert_eq!(m.repo.as_deref(), Some("owner/name"));
        assert_eq!(m.worktree.as_deref(), Some("topic"));
        assert_eq!(m.branch.as_deref(), Some("topic"));
    }
}

#[test]
fn detached_no_origin_missing_config_and_malformed_head() {
    let (_tmp, root) = checkout();
    fs::remove_file(root.join(".git/config")).unwrap();
    write(&root.join(".git/HEAD"), "ABCDEF0123456789\n");
    let m = derive(&root).unwrap();
    assert_eq!(m.repo.as_deref(), Some("checkout"));
    assert_eq!(m.branch.as_deref(), Some("ABCDEF0"));
    write(
        &root.join(".git/config"),
        "[remote \"other\"]\nurl = https://host/wrong/repo\n[include]\npath = /no/read\n",
    );
    write(&root.join(".git/HEAD"), "not a ref or hash\n");
    let m = derive(&root).unwrap();
    assert_eq!(m.repo.as_deref(), Some("checkout"));
    assert_eq!(m.branch, None);
}

#[test]
fn worktree_of_bare_repository() {
    let tmp = tempfile::tempdir().unwrap();
    let bare = tmp.path().join("bare.git");
    let gitdir = bare.join("worktrees/topic");
    let worktree = tmp.path().join("topic");
    write(&bare.join("config"), "[core]\nbare = true\n");
    write(&gitdir.join("HEAD"), "ref: refs/heads/topic\n");
    write(&gitdir.join("commondir"), "../..\n");
    write(
        &worktree.join(".git"),
        format!("gitdir: {}\n", gitdir.display()),
    );
    let m = derive(&worktree).unwrap();
    assert_eq!(m.repo_root.as_deref(), bare.to_str());
    assert_eq!(m.repo.as_deref(), Some("bare.git"));
    assert_eq!(m.worktree.as_deref(), Some("topic"));
}

#[test]
fn unreadable_invalid_oversized_and_special_files_fail_closed() {
    let (_tmp, root) = checkout();
    let nested = root.join("src/deep/.git");
    // Invalid nearest marker never falls back to the valid ancestor checkout.
    write(&nested, "not a gitdir\n");
    assert!(derive(&root.join("src/deep")).is_err());
    fs::remove_file(&nested).unwrap();
    std::os::unix::fs::symlink("/nonexistent/git-metadata-target", &nested).unwrap();
    assert!(derive(&root.join("src/deep")).is_err());
    fs::remove_file(&nested).unwrap();
    write(&nested, "gitdir: ../../.git\n");
    fs::set_permissions(&nested, fs::Permissions::from_mode(0o0)).unwrap();
    // Privileged test runners may still read mode-000 files.
    if fs::read(&nested).is_err() {
        assert!(derive(&root.join("src/deep")).is_err());
    }
    fs::set_permissions(&nested, fs::Permissions::from_mode(0o600)).unwrap();
    fs::remove_file(&nested).unwrap();
    write(&nested, [0xff]);
    assert!(derive(&root.join("src/deep")).is_err());
    fs::remove_file(&nested).unwrap();
    write(&root.join(".git/config"), vec![b'x'; READ_MAX as usize + 1]);
    assert!(derive(&root).is_err());
    fs::remove_file(root.join(".git/config")).unwrap();
    rustix::fs::mkfifoat(rustix::fs::CWD, &nested, Mode::RUSR | Mode::WUSR).unwrap();
    assert!(derive(&root.join("src/deep")).is_err());
}

#[test]
fn requests_only_read_completed_facts_and_refresh_preserves_stale_values() {
    let (_tmp, root) = checkout();
    let cache = Cache::default();
    let cwd = root.to_str().unwrap();
    assert_eq!(cache.get(cwd), Metadata::default());
    assert!(cache.start(cwd));
    assert_eq!(cache.get(cwd), Metadata::default());
    assert!(!cache.start(cwd));
    assert!(cache.finish(cwd, derive(&root).unwrap()));
    assert_eq!(cache.get(cwd).branch.as_deref(), Some("main"));
    assert!(!cache.start(cwd));
    write(&root.join(".git/HEAD"), "ref: refs/heads/next\n");
    // Expired facts remain readable; requests never derive even after the TTL.
    cache.0.lock().unwrap().get_mut(cwd).unwrap().at = Instant::now() - TTL;
    assert_eq!(cache.get(cwd).branch.as_deref(), Some("main"));
    assert!(cache.start(cwd));
    assert!(!cache.start(cwd));
    assert_eq!(cache.get(cwd).branch.as_deref(), Some("main"));
    assert!(cache.finish(cwd, derive(&root).unwrap()));
    assert_eq!(cache.get(cwd).branch.as_deref(), Some("next"));
    cache.0.lock().unwrap().get_mut(cwd).unwrap().at = Instant::now() - TTL;
    assert!(cache.start(cwd));
    assert!(!cache.finish(cwd, derive(&root).unwrap()));
    cache.0.lock().unwrap().get_mut(cwd).unwrap().at = Instant::now() - TTL;
    assert!(cache.start(cwd));
    assert!(cache.finish(cwd, Metadata::default()));
    assert_eq!(cache.get(cwd), Metadata::default());
}

#[test]
fn cache_bounds_in_flight_work_and_never_evicts_a_pending_cwd() {
    let cache = Cache::default();
    for i in 0..CACHE_MAX {
        assert!(cache.start(&format!("/pending/{i}")));
    }
    // A hanging cwd stays single-flight even after its TTL and under capacity pressure.
    cache.0.lock().unwrap().get_mut("/pending/0").unwrap().at = Instant::now() - TTL;
    assert!(!cache.start("/pending/0"));
    assert!(!cache.start("/overflow"));
    assert_eq!(cache.get("/pending/0"), Metadata::default());
    assert!(!cache.finish("/pending/1", Metadata::default()));
    assert!(!cache.start("/pending/1")); // Failures are cached for the TTL too.
    assert!(cache.start("/overflow")); // Only the completed entry can be evicted.
    assert!(!cache.start("/pending/0"));
    assert_eq!(cache.0.lock().unwrap().len(), CACHE_MAX);
}
