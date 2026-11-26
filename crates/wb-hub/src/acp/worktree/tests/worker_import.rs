use tokio::net::UnixListener;

use super::*;
use crate::config::AgentWorker;

const FULL: &str = "refs/heads/work";

struct Exchange<'a> {
    f: &'a Fixture,
    owner: PathBuf,
    clone: PathBuf,
    record: ManagedWorktree,
    worker: AgentWorker,
}

impl<'a> Exchange<'a> {
    fn new(f: &'a Fixture) -> Self {
        let owner = f.repo();
        f.git(&owner, &["branch", "work"]);
        let worker = AgentWorker {
            root: f.temp.join("worker"),
            socket: f.temp.join("export.sock"),
        };
        fs::create_dir(&worker.root).unwrap();
        let clone = worker.root.join(format!("{SID}-1"));
        let record = ManagedWorktree {
            main_root: owner.to_str().unwrap().into(),
            path: clone.to_str().unwrap().into(),
            branch: "work".into(),
        };
        f.git(
            &f.temp,
            &[
                "clone",
                "--no-local",
                "-b",
                "work",
                &record.main_root,
                &record.path,
            ],
        );
        fs::write(clone.join("worker-file"), "from worker\n").unwrap();
        f.git(&clone, &["add", "worker-file"]);
        f.git(&clone, &["commit", "-m", "worker change"]);
        Self {
            f,
            owner,
            clone,
            record,
            worker,
        }
    }

    fn oid(&self, repo: &Path, name: &str) -> String {
        self.f.git(repo, &["rev-parse", "--verify", name])
    }

    fn objects(&self) -> String {
        self.f.git(
            &self.owner,
            &[
                "cat-file",
                "--batch-all-objects",
                "--batch-check=%(objectname)",
            ],
        )
    }

    fn bundle(&self, revisions: &[&str]) -> Vec<u8> {
        let path = self.f.temp.join("export.bundle");
        let mut args = vec![
            "bundle",
            "create",
            "--version=3",
            path.to_str().unwrap(),
            FULL,
        ];
        args.extend_from_slice(revisions);
        self.f.git(&self.clone, &args);
        fs::read(path).unwrap()
    }

    async fn import(&self, git: &Path, bundle: &[u8]) -> Result<(), Error> {
        let sock = UnixListener::bind(&self.worker.socket).unwrap();
        let serve = async {
            let (stream, _) = sock.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut request = String::new();
            stream.read_line(&mut request).await.unwrap();
            let request: serde_json::Value = serde_json::from_str(&request).unwrap();
            assert_eq!(request["op"], "export");
            assert_eq!(request["branch"], self.record.branch);
            stream
                .write_all(format!("{{\"size\":{}}}\n", bundle.len()).as_bytes())
                .await
                .unwrap();
            stream.write_all(bundle).await.unwrap();
        };
        let fetch = worker::fetch(test_git(git), &self.worker, &self.record, SID);
        tokio::pin!(fetch);
        tokio::select! {
            result = &mut fetch => result,
            () = serve => fetch.await,
        }
    }

    fn unchanged(&self, branch: &str, objects: &str) {
        assert_eq!(self.oid(&self.owner, FULL), branch);
        assert_eq!(self.objects(), objects);
        assert_eq!(
            fs::read_dir(self.owner.join(".git/objects/pack"))
                .unwrap()
                .count(),
            0
        );
    }
}

#[tokio::test]
async fn non_fast_forward_leaves_no_worker_objects_in_owner() {
    let f = Fixture::new();
    let x = Exchange::new(&f);
    f.git(&x.owner, &["commit", "--allow-empty", "-m", "owner change"]);
    f.git(&x.owner, &["branch", "-f", "work", "HEAD"]);
    let old = x.oid(&x.owner, FULL);
    let objects = x.objects();
    let err = x.import(&f.git, &x.bundle(&[])).await.unwrap_err();
    assert_eq!(err.0, ErrorCode::Conflict, "{err:?}");
    x.unchanged(&old, &objects);
}

#[tokio::test]
async fn advertised_owner_only_fast_forward_must_actually_be_in_pack() {
    let f = Fixture::new();
    let x = Exchange::new(&f);
    f.git(&x.owner, &["commit", "--allow-empty", "-m", "owner only"]);
    let old = x.oid(&x.owner, FULL);
    let objects = x.objects();
    let forged = x.oid(&x.owner, "HEAD"); // A valid FF in the owner, but not in the worker.
    let real = x.oid(&x.clone, FULL);
    let mut bundle = x.bundle(&[]);
    let start = bundle
        .windows(real.len())
        .position(|s| s == real.as_bytes())
        .unwrap();
    bundle[start..start + real.len()].copy_from_slice(forged.as_bytes());
    let err = x.import(&f.git, &bundle).await.unwrap_err();
    assert_eq!(err.0, ErrorCode::BadRequest, "{err:?}");
    x.unchanged(&old, &objects);
}

#[tokio::test]
async fn incomplete_history_cannot_borrow_parents_from_owner() {
    let f = Fixture::new();
    let x = Exchange::new(&f);
    let old = x.oid(&x.owner, FULL);
    let objects = x.objects();
    // Strip the prerequisite announcement but keep its incremental pack.
    let mut bundle = x.bundle(&[&format!("^{old}")]);
    let start = bundle.windows(2).position(|s| s == b"\n-").unwrap() + 1;
    let end = bundle[start..].iter().position(|&b| b == b'\n').unwrap() + start + 1;
    bundle.drain(start..end);
    let err = x.import(&f.git, &bundle).await.unwrap_err();
    assert_eq!(err.0, ErrorCode::BadRequest, "{err:?}");
    x.unchanged(&old, &objects);
}

#[tokio::test]
async fn prepared_transaction_checks_old_before_installing_pack() {
    let f = Fixture::new();
    let x = Exchange::new(&f);
    f.git(&x.owner, &["commit", "--allow-empty", "-m", "owner only"]);
    let winner = x.oid(&x.owner, "HEAD");
    let objects = x.objects();
    // Move the destination *after* the importer's successful ancestry check.
    let racing_git = f.temp.join("racing-git");
    script(
        &racing_git,
        &format!(
            "for arg do\n if [ \"$arg\" = update-ref ]; then\n  (unset GIT_OBJECT_DIRECTORY; '{}' update-ref {FULL} {winner}) || exit 1\n fi\ndone\nexec '{}' \"$@\"",
            f.git.display(),
            f.git.display(),
        ),
    );
    let err = x.import(&racing_git, &x.bundle(&[])).await.unwrap_err();
    assert_eq!(err.0, ErrorCode::Conflict, "{err:?}");
    x.unchanged(&winner, &objects);
}

#[tokio::test]
async fn valid_pack_publishes_complete_fast_forward_without_checkout() {
    let f = Fixture::new();
    let x = Exchange::new(&f);
    let main = x.oid(&x.owner, "HEAD");
    x.import(&f.git, &x.bundle(&[])).await.unwrap();
    assert_eq!(x.oid(&x.owner, FULL), x.oid(&x.clone, FULL));
    assert_eq!(
        f.git(&x.owner, &["show", "work:worker-file"]),
        "from worker"
    );
    assert_eq!(x.oid(&x.owner, "HEAD"), main);
    assert!(!x.owner.join("worker-file").exists());
}
