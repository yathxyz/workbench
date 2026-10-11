//! `GET /api/ls`, `/api/stat`, `/api/cat` and `POST /api/mv` against the real binary
//! (design §3.5.5, 20-web §5.3).
//!
//! wb-web inherits this process's `$HOME`, which these tests cannot change, so they use
//! absolute paths under temporary directories. The `mv` refusal below is safe whatever
//! `$HOME` is: its destination's parent does not exist. The denylist through symlinks is
//! covered by the unit tests and, with a temporary `$HOME`, by `tests/test_daemon.py`.

mod common;

use std::fs;
use std::os::unix::fs::{MetadataExt, symlink};
use std::path::{Path, PathBuf};

use common::Web;
use rustix::fs::{CWD, FileType, Mode};
use serde_json::{Value, json};

const REFUSED: &str =
    "refused: the destination is in or above ~/.ssh or a systemd user-unit directory";

/// Percent-encodes a query value.
fn q(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'/' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn s(path: &Path) -> String {
    path.to_str().unwrap().to_owned()
}

/// A canonical temporary directory, so paths compare equal to the server's.
fn scratch() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let real = fs::canonicalize(tmp.path()).unwrap();
    (tmp, real)
}

async fn get(web: &Web, target: &str) -> (u16, Value) {
    let res = web.req("GET", target).send().await;
    assert_eq!(res.header("cache-control"), Some("no-store"), "{target}");
    (res.status, res.json())
}

async fn mv(web: &Web, src: &str, dst: &str) -> (u16, Value) {
    let res = web
        .req("POST", "/api/mv")
        .body(json!({"src": src, "dst": dst}).to_string())
        .send()
        .await;
    (res.status, res.json())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ls_lists_directories_first_with_links_hard_links_and_mounts() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    let (_tmp, root) = scratch();
    fs::create_dir(root.join("Zdir")).unwrap();
    fs::create_dir(root.join("adir")).unwrap();
    fs::write(root.join("B.txt"), "bee").unwrap();
    fs::write(root.join("a.txt"), "a").unwrap();
    symlink("a.txt", root.join("link")).unwrap();
    symlink("adir", root.join("dirlink")).unwrap();
    symlink("nope", root.join("dangle")).unwrap();
    fs::hard_link(root.join("B.txt"), root.join("hard")).unwrap();

    let (status, ls) = get(&web, &format!("/api/ls?path={}", q(&s(&root)))).await;
    assert_eq!(status, 200, "{ls}");
    assert_eq!(ls["path"], s(&root));
    assert_eq!(ls["host"], "testhost");
    let entries = ls["entries"].as_array().unwrap();
    let names: Vec<&str> = entries
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "adir", "dirlink", "Zdir", "a.txt", "B.txt", "dangle", "hard", "link"
        ]
    );
    let by = |name: &str| entries.iter().find(|e| e["name"] == name).unwrap().clone();

    let b = fs::metadata(root.join("B.txt")).unwrap();
    assert_eq!(
        by("B.txt"),
        json!({"name": "B.txt", "dir": false, "size": 3, "mtime": b.mtime(), "dev": b.dev(), "ino": b.ino(), "nlink": 2})
    );
    assert_eq!(by("hard")["ino"], b.ino());
    assert_eq!(by("hard")["nlink"], 2);
    let link = by("link");
    assert_eq!(link["link"], "a.txt");
    assert_eq!(link["size"], 1);
    assert!(link.get("nlink").is_none());
    let dirlink = by("dirlink");
    assert_eq!(
        (dirlink["dir"].clone(), dirlink["link"].clone()),
        (json!(true), json!("adir"))
    );
    assert!(dirlink.get("mount").is_none());
    assert!(by("adir").get("nlink").is_none() && by("adir").get("mount").is_none());
    assert_eq!(
        by("dangle"),
        json!({"name": "dangle", "dir": false, "size": 0, "mtime": 0})
    );

    // Missing `path` and an empty one both mean `~`.
    let (_, bare) = get(&web, "/api/ls").await;
    let (_, empty) = get(&web, "/api/ls?path=").await;
    assert_eq!(bare["path"], empty["path"]);
    if let Some(home) = std::env::var_os("HOME").and_then(|h| fs::canonicalize(h).ok()) {
        assert_eq!(bare["path"], s(&home));
    }

    let (status, root_ls) = get(&web, "/api/ls?path=/").await;
    assert_eq!(status, 200);
    let proc_entry = root_ls["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == "proc")
        .cloned();
    assert_eq!(proc_entry.map(|e| e["mount"].clone()), Some(json!(true)));

    for (target, needle) in [
        (
            format!("/api/ls?path={}", q(&s(&root.join("missing")))),
            "No such file",
        ),
        (
            format!("/api/ls?path={}", q(&s(&root.join("a.txt")))),
            "Not a directory",
        ),
        ("/api/ls?path=relative/dir".to_owned(), "must be absolute"),
    ] {
        let (status, body) = get(&web, &target).await;
        assert_eq!(status, 400, "{target}");
        assert!(
            body["error"].as_str().unwrap().contains(needle),
            "{target}: {body}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stat_reports_files_directories_and_absence() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    let (_tmp, root) = scratch();
    fs::write(root.join("f.txt"), "12345").unwrap();
    symlink("f.txt", root.join("l")).unwrap();
    let meta = fs::metadata(root.join("f.txt")).unwrap();

    let (status, st) = get(&web, &format!("/api/stat?path={}", q(&s(&root.join("l"))))).await;
    assert_eq!(status, 200);
    assert_eq!(st["path"], s(&root.join("f.txt")));
    assert_eq!(
        (st["exists"].clone(), st["dir"].clone(), st["size"].clone()),
        (json!(true), json!(false), json!(5))
    );
    let mtime = st["mtime"].as_f64().unwrap();
    let want = meta.mtime() as f64 + meta.mtime_nsec() as f64 / 1e9;
    assert!((mtime - want).abs() < 1e-3, "{mtime} vs {want}");

    let (_, st) = get(&web, &format!("/api/stat?path={}", q(&s(&root)))).await;
    assert_eq!(st["dir"], true);
    let missing = root.join("missing/x");
    let (status, st) = get(&web, &format!("/api/stat?path={}", q(&s(&missing)))).await;
    assert_eq!(status, 200);
    assert_eq!(st, json!({"path": s(&missing), "exists": false}));
    let (status, _) = get(&web, "/api/stat").await;
    assert_eq!(status, 400);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cat_reads_regular_files_up_to_the_clamped_limit() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    let (_tmp, root) = scratch();
    let text = root.join("t.txt");
    fs::write(&text, "line one\nλ two\n").unwrap();
    let big = root.join("big");
    fs::write(&big, vec![b'x'; 9 << 20]).unwrap();
    fs::write(root.join("bin"), b"\x7fELF\0\0\0").unwrap();
    rustix::fs::mknodat(CWD, root.join("fifo"), FileType::Fifo, Mode::from(0o600), 0).unwrap();

    let cat = |path: &Path, extra: &str| format!("/api/cat?path={}{extra}", q(&s(path)));
    let (status, body) = get(&web, &cat(&text, "")).await;
    assert_eq!(status, 200);
    assert_eq!(
        body,
        json!({"path": s(&text), "text": "line one\nλ two\n", "size": 16})
    );
    assert_eq!(get(&web, &cat(&text, "&limit=4")).await.1["text"], "line");
    assert_eq!(get(&web, &cat(&text, "&limit=0")).await.1["text"], "l");
    assert_eq!(get(&web, &cat(&text, "&limit=-7")).await.1["text"], "l");
    assert_eq!(
        get(&web, &cat(&root.join("bin"), "")).await.1["text"],
        "(binary file)"
    );

    let (_, body) = get(&web, &cat(&big, "")).await;
    assert_eq!(body["text"].as_str().unwrap().len(), 64_000);
    assert_eq!(body["size"], 9 << 20);
    let (_, body) = get(&web, &cat(&big, "&limit=100000000")).await;
    assert_eq!(body["text"].as_str().unwrap().len(), 8 << 20);

    for (target, needle) in [
        (cat(&root, ""), "not a regular file"),
        (cat(&root.join("fifo"), ""), "not a regular file"),
        (cat(Path::new("/dev/null"), ""), "not a regular file"),
        (cat(&root.join("missing"), ""), "No such file"),
        (cat(&text, "&limit=lots"), "bad query"),
        ("/api/cat?path=t.txt".to_owned(), "must be absolute"),
    ] {
        let (status, body) = get(&web, &target).await;
        assert_eq!(status, 400, "{target}");
        assert!(
            body["error"].as_str().unwrap().contains(needle),
            "{target}: {body}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mv_renames_without_clobbering() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    let (_tmp, root) = scratch();
    fs::write(root.join("a"), "A").unwrap();
    fs::write(root.join("b"), "B").unwrap();
    fs::create_dir(root.join("d")).unwrap();
    symlink("b", root.join("l")).unwrap();

    let (status, body) = mv(&web, &s(&root.join("a")), &s(&root.join("c"))).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body,
        json!({"ok": true, "src": s(&root.join("a")), "dst": s(&root.join("c"))})
    );
    assert_eq!(fs::read_to_string(root.join("c")).unwrap(), "A");

    let (status, body) = mv(&web, &s(&root.join("c")), &s(&root.join("b"))).await;
    assert_eq!(
        (status, body),
        (400, json!({"error": "destination exists"}))
    );
    assert_eq!(fs::read_to_string(root.join("b")).unwrap(), "B");
    assert_eq!(fs::read_to_string(root.join("c")).unwrap(), "A");

    let (status, body) = mv(&web, &s(&root.join("c")), &s(&root.join("d"))).await;
    assert_eq!(status, 200);
    assert_eq!(body["dst"], s(&root.join("d/c")));

    // The link itself moves; its target stays.
    let (status, _) = mv(&web, &s(&root.join("l")), &s(&root.join("d/l"))).await;
    assert_eq!(status, 200);
    assert_eq!(fs::read_link(root.join("d/l")).unwrap(), Path::new("b"));
    assert!(root.join("b").is_file());

    let (status, body) = mv(&web, &s(&root.join("missing")), &s(&root.join("x"))).await;
    assert_eq!(status, 400);
    assert!(
        body["error"].as_str().unwrap().contains("No such file"),
        "{body}"
    );

    for bad in [&b"{\"src\":\"/a\"}"[..], b"not json", b""] {
        let res = web.req("POST", "/api/mv").body(bad).send().await;
        assert_eq!(res.status, 400, "{:?}", String::from_utf8_lossy(bad));
        assert!(
            res.json()["error"]
                .as_str()
                .unwrap()
                .starts_with("invalid request")
        );
    }
    assert_eq!(web.req("GET", "/api/mv").send().await.status, 405);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mv_across_filesystems_is_400_with_the_os_message() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    let (_tmp, root) = scratch();
    let shm = Path::new("/dev/shm");
    let other_device =
        fs::metadata(shm).is_ok_and(|m| m.dev() != fs::metadata(&root).unwrap().dev());
    if !other_device {
        eprintln!(
            "skipped: /dev/shm is missing or on the same filesystem as {}",
            root.display()
        );
        return;
    }
    let other = tempfile::tempdir_in(shm).unwrap();
    fs::write(root.join("a"), "A").unwrap();
    let dst = other.path().join("a");
    let (status, body) = mv(&web, &s(&root.join("a")), &s(&dst)).await;
    let os = std::io::Error::from(rustix::io::Errno::XDEV).to_string();
    assert_eq!((status, body), (400, json!({"error": os})));
    assert!(root.join("a").is_file());
    assert!(!dst.exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mv_refuses_a_destination_under_home_ssh() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    if std::env::var_os("HOME").is_none() {
        eprintln!("skipped: HOME is not set");
        return;
    }
    let (_tmp, root) = scratch();
    fs::write(root.join("k"), "key").unwrap();
    // The parent does not exist, so even a missing refusal could not create anything.
    for dst in [
        "~/.ssh/wb-test-no-such-dir/authorized_keys",
        "~/.config/systemd/wb-test-no-such-dir/x.service",
        "~/wb-test-no-such-dir/../.local/share/systemd/wb-test-no-such-dir/x",
    ] {
        let (status, body) = mv(&web, &s(&root.join("k")), dst).await;
        assert_eq!((status, body), (400, json!({"error": REFUSED})), "{dst}");
    }
    assert!(root.join("k").is_file());
}
