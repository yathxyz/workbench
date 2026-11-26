//! The pack under inspection is the scratch repository's *only* object source.
//! The owner can see it only after the destination ref transaction has prepared.
//! A stale old OID therefore never installs a pack. An I/O failure committing
//! an already prepared update can leave a validated pack for Git GC: after
//! publication, another writer may have referenced it, so never unlink it.

use std::fs as disk;
use std::os::unix::fs::PermissionsExt;
use std::time::SystemTime;

use tokio::net::unix::pipe;

use super::*;

fn scratch_command(git: Git<'_>, repo: &Path) -> Command {
    let mut cmd = trust::isolated_command(git, repo);
    cmd.env("GIT_DIR", repo);
    cmd
}

async fn scratch_git(git: Git<'_>, repo: &Path, args: &[&str]) -> Result<Vec<u8>, Error> {
    let out = execute(
        git,
        scratch_command(git, repo),
        args,
        GIT_WORKTREE_TIMEOUT,
        None,
        prefix,
    )
    .await
    .map_err(RunError::into_error)?;
    checked(out, ErrorCode::BadRequest)
}

const SCRATCH_PREFIX: &str = ".workbench-import-";
const SCRATCH_SUFFIX_LEN: usize = 8;

fn new_scratch(packs: &Path) -> Result<tempfile::TempDir, Error> {
    disk::create_dir_all(packs).map_err(internal)?;
    let now = SystemTime::now();
    for entry in disk::read_dir(packs).map_err(internal)? {
        let Some(entry) = if_present(entry)? else {
            continue;
        };
        let name = entry.file_name();
        let Some(suffix) = name.as_bytes().strip_prefix(SCRATCH_PREFIX.as_bytes()) else {
            continue;
        };
        if suffix.len() != SCRATCH_SUFFIX_LEN || !suffix.iter().all(u8::is_ascii_alphanumeric) {
            continue;
        }
        let Some(meta) = if_present(entry.metadata())? else {
            continue;
        };
        // fetch() bounds the whole import, not just each of its Git commands.
        if meta.is_dir()
            && now
                .duration_since(meta.modified().map_err(internal)?)
                .is_ok_and(|age| age > GIT_WORKTREE_TIMEOUT)
        {
            if_present(disk::remove_dir_all(entry.path()))?;
        }
    }
    tempfile::Builder::new()
        .prefix(SCRATCH_PREFIX)
        .rand_bytes(SCRATCH_SUFFIX_LEN)
        .permissions(disk::Permissions::from_mode(0o700))
        .tempdir_in(packs)
        .map_err(internal)
}

pub(super) async fn import(
    git: Git<'_>,
    root: &Path,
    full: &str,
    old: &str,
    tip: &str,
    body: &mut tokio::io::Take<impl AsyncRead + Unpin>,
) -> Result<(), Error> {
    let dir = query(
        git,
        root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "objects/pack",
        ],
    )
    .await?;
    let packs = Path::new(absolute_path(dir.strip_suffix(b"\n").unwrap_or_default())?);
    let pack_dir = packs.to_owned();
    // Same filesystem for publication by hard link, but not in the owner's ODB.
    let tmp = tokio::task::spawn_blocking(move || new_scratch(&pack_dir))
        .await
        .map_err(|e| internal(e.into()))??;
    let repo = tmp.path();
    let format = if tip.len() == 40 {
        "--object-format=sha1"
    } else {
        "--object-format=sha256"
    };
    scratch_git(git, repo, &["init", "--bare", "--template=", format]).await?;

    let (mut sink, source) = pipe::pipe().map_err(internal)?;
    let mut cmd = scratch_command(git, repo);
    cmd.stdin(source.into_blocking_fd().map_err(internal)?);
    let index = execute(
        git,
        cmd,
        &["index-pack", "--strict", "--no-rev-index", "--stdin"],
        GIT_WORKTREE_TIMEOUT,
        None,
        prefix,
    );
    let expected = body.limit();
    let (out, n) = tokio::join!(index, async move { tokio::io::copy(body, &mut sink).await });
    let out = checked(out.map_err(RunError::into_error)?, ErrorCode::BadRequest)?;
    if n.map_err(internal)? != expected {
        return Err(bad("truncated worker export"));
    }
    let hash = object_id(
        out.strip_prefix(b"pack\t")
            .and_then(|s| s.strip_suffix(b"\n"))
            .unwrap_or_default(),
    )?;
    if scratch_git(git, repo, &["cat-file", "-t", tip]).await? != b"commit\n" {
        return Err(bad("worker branch does not point to a commit"));
    }
    scratch_git(git, repo, &["merge-base", "--is-ancestor", old, tip])
        .await
        .map_err(|(_, e)| conflict(&format!("worker branch is not a fast-forward: {e}")))?;
    let pack = Pack {
        objects: repo.join("objects"),
        dest: packs,
        hash,
    };
    publish(git, root, full, old, tip, &pack).await
}

struct Pack<'a> {
    objects: PathBuf,
    dest: &'a Path,
    hash: &'a str,
}

/// Publish both content-addressed files without clobbering another writer. The
/// index comes last. As with index-pack --keep, protect the pack from repack
/// until the ref is committed; never remove a pre-existing keep or pack.
fn install(pack: &Pack<'_>) -> io::Result<Option<tempfile::NamedTempFile>> {
    let name = format!("pack-{}", pack.hash);
    let keep = match tempfile::Builder::new()
        .prefix(&name)
        .suffix(".keep")
        .rand_bytes(0)
        .tempfile_in(pack.dest)
    {
        Ok(keep) => Some(keep),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => None,
        Err(e) => return Err(e),
    };
    let source = pack.objects.join("pack");
    for ext in ["pack", "idx"] {
        let file = format!("{name}.{ext}");
        match std::fs::hard_link(source.join(&file), pack.dest.join(file)) {
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
            result => result?,
        }
    }
    Ok(keep)
}

async fn publish(
    git: Git<'_>,
    root: &Path,
    full: &str,
    old: &str,
    tip: &str,
    pack: &Pack<'_>,
) -> Result<(), Error> {
    // `prepare` needs to read the new commit before its pack is installed. Give
    // only this Git child the scratch object directory, not the live repository.
    let (mut input, source) = pipe::pipe().map_err(internal)?;
    let mut cmd = owner_command(git, root);
    cmd.env("GIT_OBJECT_DIRECTORY", &pack.objects)
        .stdin(source.into_blocking_fd().map_err(internal)?);
    input
        .write_all(
            format!("start\noption no-deref\nupdate {full} {tip} {old}\nprepare\n").as_bytes(),
        )
        .await
        .map_err(internal)?;
    let out = execute(
        git,
        cmd,
        &["update-ref", "--stdin"],
        GIT_WORKTREE_TIMEOUT,
        None,
        async move |mut stdout| {
            let result = async {
                const READY: &[u8] = b"start: ok\nprepare: ok\n";
                let mut ack = [0; READY.len()];
                stdout.read_exact(&mut ack).await.map_err(internal)?;
                if ack.as_slice() != READY {
                    return Err(conflict("unexpected Git ref transaction response"));
                }
                // Checkout/symref status is not part of Git's old-OID CAS.
                // Recheck it under the prepared transaction, after validation.
                if branch_tip(git, root, full).await? != old {
                    return Err(conflict("owner branch changed during import"));
                }
                let keep = install(pack).map_err(internal)?;
                input.write_all(b"commit\n").await.map_err(internal)?;
                Ok(keep)
            }
            .await;
            // EOF after start without commit aborts and releases any ref locks.
            drop(input);
            tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await?;
            Ok(result)
        },
    )
    .await
    .map_err(RunError::into_error)?;
    // Prefer Git's diagnostic (including a failed CAS) to a truncated ack.
    let _keep = checked(out, ErrorCode::Conflict)??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_import_reaps_only_abandoned_quarantines_past_the_deadline() {
        let packs = tempfile::tempdir().unwrap();
        let interrupted = new_scratch(packs.path()).unwrap().keep();
        disk::write(interrupted.join("partial-pack"), b"partial").unwrap();
        let active = new_scratch(packs.path()).unwrap();
        let unrelated = packs.path().join(".workbench-import-backup");
        disk::create_dir(&unrelated).unwrap();
        let file = packs.path().join(".workbench-import-12345678");
        disk::write(&file, b"keep").unwrap();
        let old = SystemTime::now() - GIT_WORKTREE_TIMEOUT - Duration::from_secs(1);
        for path in [&interrupted, &unrelated, &file] {
            disk::File::open(path).unwrap().set_modified(old).unwrap();
        }

        let _next = new_scratch(packs.path()).unwrap();
        assert!(!interrupted.try_exists().unwrap());
        assert!(active.path().is_dir());
        assert!(unrelated.is_dir());
        assert_eq!(disk::read(file).unwrap(), b"keep");
    }
}
