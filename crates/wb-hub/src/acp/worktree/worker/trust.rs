//! Eligibility for Git running as the owner. Never ask Git to discover the
//! source: discovery itself can follow gitfiles, commondir and config includes.

use std::fs as disk;
use std::path::Component;

use super::*;

pub(super) fn isolated_command(git: Git<'_>, dir: &Path) -> Command {
    // command() disables on-disk hooks, the reference-transaction hook event
    // and fsmonitor. Reject *all* local hook.<friendly-name>.{event,command}
    // registrations below; hooksPath alone does not disable those commands.
    let mut cmd = command(git, dir);
    cmd.args([
        "--no-replace-objects",
        "-c",
        "safe.directory=",
        "-c",
        "safe.bareRepository=explicit",
    ])
    .env("GIT_CONFIG_GLOBAL", "/dev/null")
    .env("GIT_CONFIG_NOSYSTEM", "1")
    .env("GIT_ATTR_NOSYSTEM", "1")
    .env("GIT_ATTR_GLOBAL", "/dev/null")
    .env("GIT_ALLOW_PROTOCOL", "");
    cmd
}

pub(super) fn owner_command(git: Git<'_>, root: &Path) -> Command {
    let mut cmd = isolated_command(git, root);
    cmd.env("GIT_DIR", root.join(".git"))
        .env("GIT_WORK_TREE", root);
    cmd
}

fn metadata_tree(gitdir: &Path, uid: u32) -> Result<(), Error> {
    // Check each directory *before* walking into it. A non-writable trusted
    // parent pins its entries against replacement by the worker. Linux stores
    // a POSIX access ACL's effective group-class mask in the group mode bits:
    // a named user cannot be granted write without S_IWGRP being set, either.
    let mut dirs = vec![disk::read_dir(gitdir).map_err(internal)?];
    while let Some(dir) = dirs.last_mut() {
        let Some(entry) = dir.next() else {
            dirs.pop();
            continue;
        };
        let entry = entry.map_err(internal)?;
        let meta = entry.metadata().map_err(internal)?; // lstat, including for symlinks
        if meta.uid() != uid || meta.mode() & 0o022 != 0 || !(meta.is_dir() || meta.is_file()) {
            return Err(bad(
                "Git metadata must be owner-controlled directories and regular files",
            ));
        }
        if meta.is_dir() {
            dirs.push(disk::read_dir(entry.path()).map_err(internal)?);
        }
    }
    // No path component below .git can now be a symlink. These otherwise
    // ordinary files/directories can redirect Git to another repository or
    // object store, change the commit graph, or register an external checkout.
    for path in [
        "commondir",
        "gitdir",
        "config.worktree",
        "worktrees",
        "modules",
        "info/grafts",
        "objects/info/alternates",
        "objects/info/http-alternates",
    ] {
        if optional(disk::symlink_metadata(gitdir.join(path)))?.is_some() {
            return Err(bad(
                "source must have standalone, self-contained Git metadata",
            ));
        }
    }
    Ok(())
}

fn discover(worker_root: &Path, cwd: &Path) -> Result<PathBuf, Error> {
    if !cwd.is_absolute() || cwd.starts_with(worker_root) {
        return Err(bad(
            "source must be an owner repository outside the worker root",
        ));
    }
    let uid = rustix::process::geteuid().as_raw();
    let mut root = None;
    let mut dir = PathBuf::new();
    let mut private = false;
    for component in cwd.components() {
        match component {
            Component::RootDir | Component::Normal(_) => dir.push(component.as_os_str()),
            _ => return Err(bad("source path must not contain parent traversal")),
        }
        let meta = disk::symlink_metadata(&dir).map_err(internal)?;
        let trusted_owner = meta.uid() == uid || meta.uid() == 0;
        // Nix maps only the builder UID into its test namespace: the synthetic
        // sandbox root appears owned by the overflow UID. All fixture paths
        // below it, including the checkout's ancestors, use the normal checks.
        #[cfg(test)]
        let trusted_owner = trusted_owner
            || (dir == Path::new("/")
                && meta.uid() == 65534
                && env::var_os("NIX_BUILD_TOP").is_some());
        if !meta.is_dir() || !trusted_owner {
            return Err(bad("source path has a symlink or untrusted ancestor"));
        }
        if meta.mode() & 0o022 != 0 {
            // In a sticky temp directory other users cannot replace an existing
            // child owned by root or the hub. Never look up a repo in it.
            if meta.mode() & 0o1000 != 0 && root.is_none() {
                continue;
            }
            return Err(bad("source path has a writable ancestor"));
        }
        private |= meta.mode() & 0o011 == 0;
        let gitdir = dir.join(".git");
        let Some(marker) = optional(disk::symlink_metadata(&gitdir))? else {
            continue;
        };
        if !private || root.is_some() || meta.uid() != uid {
            return Err(bad("source must be a private, non-nested owner checkout"));
        }
        if !marker.is_dir() || marker.uid() != uid || marker.mode() & 0o022 != 0 {
            return Err(bad(
                ".git must be an owner-controlled directory, not a link or gitfile",
            ));
        }
        root = Some(dir.clone());
    }
    let root = root.ok_or_else(|| bad("source is not a private owner checkout"))?;
    let gitdir = root.join(".git");
    if dir.starts_with(&gitdir) {
        return Err(bad("source is inside the Git metadata directory"));
    }
    // The private ancestor also makes newly created refs/locks inaccessible to
    // the worker regardless of umask or inherited default ACL. Reject unsafe
    // pre-existing files even under it (e.g. a writable hard-linked object).
    metadata_tree(&gitdir, uid)?;
    Ok(root)
}

fn permitted_setting(entry: &[u8]) -> bool {
    let Some(sep) = entry.iter().position(|&b| b == b'\n') else {
        return false;
    };
    let (key, rest) = entry.split_at(sep);
    match key {
        b"core.bare" => rest[1..].eq_ignore_ascii_case(b"false"),
        b"core.repositoryformatversion"
        | b"core.filemode"
        | b"core.logallrefupdates"
        | b"extensions.objectformat"
        | b"user.name"
        | b"user.email" => true,
        _ => {
            // Ordinary clone/tracking metadata is inert: there is no fetch or
            // push, protocol access and lazy fetch are disabled. No helpers,
            // includes, hooks, external paths or unknown extensions/settings.
            (key.starts_with(b"remote.") && (key.ends_with(b".url") || key.ends_with(b".fetch")))
                || (key.starts_with(b"branch.")
                    && (key.ends_with(b".remote") || key.ends_with(b".merge")))
        }
    }
}

pub(super) async fn checkout_root(
    git: Git<'_>,
    worker: &AgentWorker,
    cwd: &Path,
) -> Result<PathBuf, Error> {
    let cwd = cwd.to_owned();
    let worker_root = worker.root.clone();
    let root = tokio::task::spawn_blocking(move || discover(&worker_root, &cwd))
        .await
        .map_err(|e| internal(e.into()))??;
    let config = root.join(".git/config");
    // The file has already passed the ownership/mode/type checks. Let Git
    // decode its *actual* syntax with includes disabled, outside any source
    // repo. Only subsequently let a repository-aware Git command start there.
    let config = config
        .to_str()
        .ok_or_else(|| bad("owner checkout is not UTF-8"))?;
    let out = execute(
        git,
        isolated_command(git, Path::new("/")),
        &[
            "config",
            "--no-includes",
            "--null",
            "--list",
            "--file",
            config,
        ],
        GIT_WORKTREE_TIMEOUT,
        None,
        prefix,
    )
    .await
    .map_err(RunError::into_error)?;
    let settings = checked(out, ErrorCode::BadRequest)?;
    if settings.len() == PIPE_BYTES
        || !settings
            .strip_suffix(b"\0")
            .is_some_and(|s| s.split(|&b| b == 0).all(permitted_setting))
    {
        return Err(bad(
            "owner repository has unsupported or excessive local Git configuration",
        ));
    }
    Ok(root)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};

    use super::*;

    fn private_dir() -> tempfile::TempDir {
        tempfile::Builder::new()
            .permissions(disk::Permissions::from_mode(0o700))
            .tempdir()
            .unwrap()
    }

    fn mkdir(path: &Path) {
        disk::DirBuilder::new()
            .mode(0o755)
            .recursive(true)
            .create(path)
            .unwrap();
    }

    fn mode(path: &Path, mode: u32) {
        disk::set_permissions(path, disk::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn checks_ancestors_and_all_metadata_before_git_discovery() {
        let tmp = private_dir();
        let worker = tmp.path().join("worker");
        let parent = tmp.path().join("owner");
        let repo = parent.join("repo");
        let gitdir = repo.join(".git");
        let sub = repo.join("src");
        mkdir(&sub);
        for dir in ["refs/heads", "objects/ab", "objects/info"] {
            mkdir(&gitdir.join(dir));
        }
        assert_eq!(discover(&worker, &sub).unwrap(), repo);
        for dir in [&parent, &repo, &sub, &gitdir, &gitdir.join("objects/ab")] {
            mode(dir, 0o775);
            assert!(discover(&worker, &sub).is_err(), "{dir:?}");
            mode(dir, 0o755);
        }
        for file in ["config", "objects/ab/cdef", "refs/heads/main"] {
            let path = gitdir.join(file);
            disk::write(&path, "").unwrap();
            mode(&path, 0o666);
            assert!(discover(&worker, &sub).is_err(), "{path:?}");
            disk::remove_file(&path).unwrap();
            symlink("/nonexistent", &path).unwrap();
            assert!(discover(&worker, &sub).is_err(), "{path:?}");
            disk::remove_file(path).unwrap();
        }
        for marker in ["commondir", "worktrees", "objects/info/alternates"] {
            let path = gitdir.join(marker);
            disk::write(&path, "/elsewhere").unwrap();
            mode(&path, 0o644);
            assert!(discover(&worker, &sub).is_err(), "{path:?}");
            disk::remove_file(path).unwrap();
        }
        assert!(discover(&parent, &sub).is_err());
        assert!(discover(&worker, &gitdir).is_err());
        symlink(&repo, parent.join("alias")).unwrap();
        assert!(discover(&worker, &parent.join("alias/")).is_err());
        assert!(discover(&worker, &sub.join("../src")).is_err());
        let linked = parent.join("linked");
        mkdir(&linked);
        disk::write(
            linked.join(".git"),
            format!("gitdir: {}\n", gitdir.display()),
        )
        .unwrap();
        assert!(discover(&worker, &linked).is_err());
        assert_eq!(discover(&worker, &sub).unwrap(), repo);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_writes_granted_to_a_named_acl_user() {
        use rustix::fs::{XattrFlags, setxattr};
        use rustix::io::Errno;

        let tmp = private_dir();
        let repo = tmp.path().join("repo");
        let gitdir = repo.join(".git");
        mkdir(&gitdir);
        let worker = tmp.path().join("worker");
        assert_eq!(discover(&worker, &repo).unwrap(), repo);

        // Linux POSIX ACL xattr v2: tag, permissions, ID (little endian).
        // The owning group and other have no write, but a named UID does.
        let mut acl = 2u32.to_le_bytes().to_vec();
        let other_uid = rustix::process::geteuid().as_raw() ^ 1;
        for (tag, perms, id) in [
            (1u16, 7u16, u32::MAX),
            (2, 7, other_uid),
            (4, 5, u32::MAX),
            (16, 7, u32::MAX),
            (32, 5, u32::MAX),
        ] {
            acl.extend(tag.to_le_bytes());
            acl.extend(perms.to_le_bytes());
            acl.extend(id.to_le_bytes());
        }
        match setxattr(
            &gitdir,
            "system.posix_acl_access",
            &acl,
            XattrFlags::empty(),
        ) {
            Err(Errno::OPNOTSUPP) => return, // no POSIX ACLs on this filesystem
            result => result.unwrap(),
        }
        assert!(discover(&worker, &repo).is_err());
    }

    #[tokio::test]
    async fn ordinary_clone_settings_work_but_includes_helpers_and_hook_commands_do_not() {
        let tmp = private_dir();
        let root = tmp.path().join("repo");
        let worker = AgentWorker {
            root: tmp.path().join("worker"),
            socket: tmp.path().join("sock"),
        };
        let reaper = crate::child::start_reaper().unwrap();
        let git = Git {
            program: Path::new("git"),
            reaper: &reaper,
        };
        mkdir(&root);
        for args in [
            &["init", "--template=", "-b", "main"][..],
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "seed",
            ],
            &["remote", "add", "origin", "https://example.invalid/repo"],
            &["config", "branch.main.remote", "origin"],
            &["config", "branch.main.merge", "refs/heads/main"],
        ] {
            let out = isolated_command(git, &root).args(args).output().unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        let config = root.join(".git/config");
        let clean = disk::read_to_string(&config).unwrap();
        let hooks = root.join(".git/hooks");
        mkdir(&hooks);
        let hook = hooks.join("reference-transaction");
        // Use an existing executable, not a shell script needing /bin/sh.
        let reject = env::split_paths(&env::var_os("PATH").unwrap())
            .map(|p| p.join("false"))
            .find(|p| p.is_file())
            .unwrap();
        disk::copy(reject, &hook).unwrap();
        mode(&hook, 0o755);
        assert_eq!(checkout_root(git, &worker, &root).await.unwrap(), root);
        query(git, &root, &["update-ref", "refs/heads/published", "HEAD"])
            .await
            .expect("on-disk reference-transaction hook must not fire");

        // If the checker even *reads* the include, Git will diagnose invalid
        // syntax instead of the checker rejecting the registration itself.
        disk::write(root.join(".git/poison"), "[broken\n").unwrap();
        for setting in [
            "[hook \"reject-update\"]\n event = reference-transaction\n command = false\n",
            "[core]\n fsmonitor = false-command\n",
            "[include]\n path = poison\n",
            "[includeIf \"gitdir:/**\"]\n path = poison\n",
            "[extensions]\n worktreeConfig = true\n",
        ] {
            disk::write(&config, format!("{clean}{setting}")).unwrap();
            let err = checkout_root(git, &worker, &root).await.unwrap_err();
            assert!(err.1.contains("unsupported"), "{setting}: {err:?}");
        }
        // Never interpret a bounded, truncated prefix as the whole config.
        let long = "x".repeat(PIPE_BYTES);
        disk::write(&config, format!("{clean}[user]\n name = {long}\n")).unwrap();
        assert!(checkout_root(git, &worker, &root).await.is_err());
    }
}
