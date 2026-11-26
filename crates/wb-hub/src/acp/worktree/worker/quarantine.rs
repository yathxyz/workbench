//! The pack under inspection is the scratch repository's *only* object source.
//! The owner can see it only after the destination ref transaction has prepared.
//! A stale old OID therefore never installs a pack. An I/O failure committing
//! an already prepared update can leave a validated pack for Git GC: after
//! publication, another writer may have referenced it, so never unlink it.

use std::os::unix::fs::PermissionsExt;

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
    fs::create_dir_all(packs).await.map_err(internal)?;
    // Same filesystem for publication by hard link, but not in the owner's ODB.
    let tmp = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir_in(packs)
        .map_err(internal)?;
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
