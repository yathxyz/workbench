//! `ls`, `stat`, `cat` and `mv` (design §3.5.5, 20-web §5.3). Paths are relative to
//! `/api`.
//!
//! These act with the logged-in user's full authority; the floor is the boundary. A path
//! is `~`, `~/…` (from `$HOME`) or absolute, and its `.` and `..` are resolved lexically.
//! `ls`, `stat` and `cat` then follow symlinks as far as the path exists.
//!
//! `mv` never moves anything into, onto or above `~/.ssh`, `~/.config/systemd` or
//! `~/.local/share/systemd` (W-6, SEC-7). The web unit's read-only mounts are the real
//! boundary; this refusal is the second layer, and it answers 400 instead of `EROFS`.

use std::ffi::OsString;
use std::fs::{self, DirEntry, File};
use std::io::{self, Read};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

use axum::extract::rejection::QueryRejection;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use rustix::fs::{CWD, Mode, OFlags, RenameFlags};
use rustix::io::Errno;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::http::{ApiError, Body};

/// `cat` reads this many bytes unless the request says otherwise.
const CAT_DEFAULT: u64 = 64_000;
const CAT_MAX: u64 = 8 << 20;
/// A NUL within this many leading bytes makes `cat` call the file binary.
const BINARY_PROBE: usize = 4000;
/// `ls` lists at most this many entries, after sorting.
const LS_MAX: usize = 2000;
/// Relative to `$HOME`: the directories `mv` never touches.
const PROTECTED: [&str; 3] = [".ssh", ".config/systemd", ".local/share/systemd"];
const REFUSED: &str =
    "refused: the destination is in or above ~/.ssh or a systemd user-unit directory";
const NOT_REGULAR: &str = "not a regular file";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/ls", get(ls))
        .route("/stat", get(stat))
        .route("/cat", get(cat))
        .route("/mv", post(mv))
}

#[derive(Deserialize)]
struct FsQuery {
    path: Option<String>,
    limit: Option<i64>,
}

#[derive(Deserialize)]
struct MvRequest {
    src: String,
    dst: String,
}

/// The JSON answer, or the message of a 400.
type FsResult = Result<Value, String>;

async fn ls(
    State(app): State<AppState>,
    query: Result<Query<FsQuery>, QueryRejection>,
) -> Response {
    let Ok(Query(q)) = query else {
        return bad_query();
    };
    let raw = q
        .path
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "~".into());
    let host = app.cfg.host.clone();
    run(move |home| list(&expand(&raw, home)?, &host)).await
}

async fn stat(query: Result<Query<FsQuery>, QueryRejection>) -> Response {
    let Ok(Query(q)) = query else {
        return bad_query();
    };
    let raw = q.path.unwrap_or_default();
    run(move |home| Ok(stat_path(&expand(&raw, home)?))).await
}

async fn cat(query: Result<Query<FsQuery>, QueryRejection>) -> Response {
    let Ok(Query(q)) = query else {
        return bad_query();
    };
    let raw = q.path.unwrap_or_default();
    let limit = q
        .limit
        .map_or(CAT_DEFAULT, |l| l.clamp(1, CAT_MAX as i64) as u64);
    run(move |home| read_file(&expand(&raw, home)?, limit)).await
}

async fn mv(Body(body): Body) -> Response {
    let req: MvRequest = match serde_json::from_slice(&body) {
        Ok(req) => req,
        Err(e) => {
            return ApiError::new(StatusCode::BAD_REQUEST, format!("invalid request: {e}"))
                .into_response();
        }
    };
    run(move |home| {
        let home = home.ok_or("HOME is not set")?;
        move_path(
            &expand(&req.src, Some(home))?,
            &expand(&req.dst, Some(home))?,
            home,
        )
    })
    .await
}

fn bad_query() -> Response {
    ApiError::new(StatusCode::BAD_REQUEST, "bad query").into_response()
}

/// Runs `work` with `$HOME` on the blocking pool: 200 with its value or 400 with its
/// message.
async fn run(work: impl FnOnce(Option<&Path>) -> FsResult + Send + 'static) -> Response {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|h| h.is_absolute())
        .map(|h| normalize(&h));
    match tokio::task::spawn_blocking(move || work(home.as_deref())).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(message)) => ApiError::new(StatusCode::BAD_REQUEST, message).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "filesystem request failed");
            ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
        }
    }
}

/// `raw` as an absolute path without `.` or `..`; `~` and `~/…` start at `home`.
fn expand(raw: &str, home: Option<&Path>) -> Result<PathBuf, String> {
    let rest = if raw == "~" {
        Some("")
    } else {
        raw.strip_prefix("~/")
    };
    let path = match rest {
        Some(rest) => {
            let mut path = OsString::from(home.ok_or("HOME is not set")?);
            path.push("/");
            path.push(rest);
            PathBuf::from(path)
        }
        None if raw.starts_with('/') => PathBuf::from(raw),
        None => return Err("the path must be absolute or start with ~/".into()),
    };
    Ok(normalize(&path))
}

/// `path` (absolute) with `.`, `..` and repeated slashes removed, without reading the
/// filesystem.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for c in path.components() {
        match c {
            Component::Normal(name) => out.push(name),
            Component::ParentDir => {
                out.pop();
            }
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    out
}

/// `path` with its longest existing prefix canonicalised and the rest kept as it is.
fn resolve(path: &Path) -> PathBuf {
    for base in path.ancestors() {
        if let Ok(real) = fs::canonicalize(base) {
            return match path.strip_prefix(base) {
                Ok(rest) if !rest.as_os_str().is_empty() => real.join(rest),
                _ => real,
            };
        }
    }
    path.to_path_buf()
}

fn shown(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn os_error(e: Errno) -> String {
    io::Error::from(e).to_string()
}

/// `{path, host, entries}`: directories first, then by lowercased name.
fn list(path: &Path, host: &str) -> FsResult {
    let dir = resolve(path);
    let parent_dev = fs::metadata(&dir).ok().map(|m| m.dev());
    let mut found = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let is_dir = match entry.file_type() {
            Ok(t) if t.is_symlink() => entry.path().is_dir(),
            Ok(t) => t.is_dir(),
            Err(_) => false,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        found.push((!is_dir, name.to_lowercase(), name, entry));
    }
    found.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
    let entries: Vec<Value> = found
        .into_iter()
        .take(LS_MAX)
        .map(|(_, _, name, entry)| describe(&entry, name, parent_dev))
        .collect();
    Ok(json!({"path": shown(&dir), "host": host, "entries": entries}))
}

/// One `ls` entry, from a stat that follows symlinks.
fn describe(entry: &DirEntry, name: String, parent_dev: Option<u64>) -> Value {
    let path = entry.path();
    let Ok(meta) = fs::metadata(&path) else {
        return json!({"name": name, "dir": false, "size": 0, "mtime": 0});
    };
    let symlink = entry.file_type().is_ok_and(|t| t.is_symlink());
    let mut it = json!({
        "name": name,
        "dir": meta.is_dir(),
        "size": meta.len(),
        "mtime": meta.mtime(),
        "dev": meta.dev(),
        "ino": meta.ino(),
    });
    if !meta.is_dir() && !symlink && meta.nlink() > 1 {
        it["nlink"] = meta.nlink().into();
    }
    if meta.is_dir() && !symlink && parent_dev.is_some_and(|dev| dev != meta.dev()) {
        it["mount"] = true.into();
    }
    if symlink {
        let target = fs::read_link(&path).map_or_else(|_| String::new(), |t| shown(&t));
        it["link"] = target.into();
    }
    it
}

/// `{path, exists:true, dir, size, mtime}` with `mtime` in fractional seconds, or
/// `{path, exists:false}`.
fn stat_path(path: &Path) -> Value {
    let path = resolve(path);
    match fs::metadata(&path) {
        Ok(m) => json!({
            "path": shown(&path),
            "exists": true,
            "dir": m.is_dir(),
            "size": m.len(),
            "mtime": m.mtime() as f64 + m.mtime_nsec() as f64 / 1e9,
        }),
        Err(_) => json!({"path": shown(&path), "exists": false}),
    }
}

/// `{path, text, size}` from the first `limit` bytes of a regular file.
fn read_file(path: &Path, limit: u64) -> FsResult {
    let path = resolve(path);
    if !fs::metadata(&path).map_err(|e| e.to_string())?.is_file() {
        return Err(NOT_REGULAR.into());
    }
    // Non-blocking, so a FIFO swapped in after the check cannot hang the open.
    let flags = OFlags::RDONLY | OFlags::NONBLOCK | OFlags::CLOEXEC | OFlags::NOCTTY;
    let file = File::from(rustix::fs::open(&path, flags, Mode::empty()).map_err(os_error)?);
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(NOT_REGULAR.into());
    }
    let mut data = Vec::new();
    file.take(limit)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    let text = if data[..data.len().min(BINARY_PROBE)].contains(&0) {
        "(binary file)".to_owned()
    } else {
        String::from_utf8_lossy(&data).into_owned()
    };
    Ok(json!({"path": shown(&path), "text": text, "size": meta.len()}))
}

/// Renames `src` (a symlink moves itself) to `dst`, or into `dst` when that is a
/// directory, never replacing anything.
fn move_path(src: &Path, dst: &Path, home: &Path) -> FsResult {
    let Some(name) = src.file_name() else {
        return Err("cannot move /".into());
    };
    let mut dst = dst.to_path_buf();
    if dst.is_dir() {
        dst.push(name);
    }
    let (Some(dir), Some(name)) = (dst.parent(), dst.file_name()) else {
        return Err("bad destination".into());
    };
    let protected = protected_dirs(home);
    if denied(&protected, &dst) {
        return Err(REFUSED.into());
    }
    // The rename goes through this descriptor, so it lands in the directory checked
    // here even if a path component is swapped for a symlink in the meantime.
    let dir = rustix::fs::open(
        dir,
        OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(os_error)?;
    if denied(&protected, &real_path(&dir)?.join(name)) {
        return Err(REFUSED.into());
    }
    match rustix::fs::renameat_with(CWD, src, &dir, name, RenameFlags::NOREPLACE) {
        Ok(()) => Ok(json!({"ok": true, "src": shown(src), "dst": shown(&dst)})),
        Err(Errno::EXIST) => Err("destination exists".into()),
        Err(e) => Err(os_error(e)),
    }
}

/// Where the kernel says an open directory is.
fn real_path(dir: &OwnedFd) -> Result<PathBuf, String> {
    fs::read_link(format!("/proc/self/fd/{}", dir.as_raw_fd())).map_err(|e| e.to_string())
}

/// Each protected directory as written under `home` and with its symlinks resolved.
fn protected_dirs(home: &Path) -> Vec<PathBuf> {
    PROTECTED
        .iter()
        .flat_map(|rel| {
            let dir = home.join(rel);
            [resolve(&dir), dir]
        })
        .collect()
}

/// Whether `path` is a protected directory, inside one, or above one. Above counts
/// because a move onto a missing `~/.config` installs whatever `systemd` it contains.
fn denied(protected: &[PathBuf], path: &Path) -> bool {
    protected
        .iter()
        .any(|dir| path.starts_with(dir) || dir.starts_with(path))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use super::*;

    #[test]
    fn expand_rows() {
        let home = Some(Path::new("/home/alice"));
        let rows: &[(&str, Result<&str, &str>)] = &[
            ("~", Ok("/home/alice")),
            ("~/", Ok("/home/alice")),
            ("~/notes/a.md", Ok("/home/alice/notes/a.md")),
            ("~//etc", Ok("/home/alice/etc")),
            ("~/x/../.ssh/k", Ok("/home/alice/.ssh/k")),
            ("~/../../..", Ok("/")),
            ("/etc/./ssh//x/", Ok("/etc/ssh/x")),
            ("/a/b/../../..", Ok("/")),
            ("/", Ok("/")),
            ("", Err("the path must be absolute or start with ~/")),
            ("notes", Err("the path must be absolute or start with ~/")),
            ("./x", Err("the path must be absolute or start with ~/")),
            ("~bob/x", Err("the path must be absolute or start with ~/")),
        ];
        for (raw, want) in rows {
            let got = expand(raw, home);
            assert_eq!(
                got.as_deref().map_err(String::as_str),
                want.map(Path::new),
                "{raw:?}"
            );
        }
        assert_eq!(expand("~/x", None).unwrap_err(), "HOME is not set");
        assert_eq!(expand("/x", None).unwrap(), Path::new("/x"));
    }

    #[test]
    fn denied_covers_in_on_and_above_but_not_beside() {
        let protected = protected_dirs(Path::new("/nonexistent-home/alice"));
        let rows = [
            ("/nonexistent-home/alice/.ssh", true),
            ("/nonexistent-home/alice/.ssh/authorized_keys", true),
            (
                "/nonexistent-home/alice/.config/systemd/user/x.service",
                true,
            ),
            ("/nonexistent-home/alice/.local/share/systemd", true),
            ("/nonexistent-home/alice/.config", true),
            ("/nonexistent-home/alice/.local", true),
            ("/nonexistent-home/alice/.local/share", true),
            ("/nonexistent-home/alice", true),
            ("/", true),
            ("/nonexistent-home/alice/.sshx", false),
            ("/nonexistent-home/alice/.config/systemdx", false),
            ("/nonexistent-home/alice/.config/nvim/init.lua", false),
            (
                "/nonexistent-home/alice/.local/share/applications/a.desktop",
                false,
            ),
            ("/nonexistent-home/alice/notes/.ssh", false),
            ("/nonexistent-home/bob/.ssh/authorized_keys", false),
        ];
        for (path, want) in rows {
            assert_eq!(denied(&protected, Path::new(path)), want, "{path}");
        }
    }

    #[test]
    fn resolve_follows_the_existing_prefix_and_keeps_the_rest() {
        let tmp = tempfile::tempdir().unwrap();
        let real = fs::canonicalize(tmp.path()).unwrap();
        fs::create_dir(real.join("d")).unwrap();
        symlink(real.join("d"), real.join("l")).unwrap();
        assert_eq!(resolve(&real.join("l")), real.join("d"));
        assert_eq!(resolve(&real.join("l/missing/x")), real.join("d/missing/x"));
        assert_eq!(resolve(Path::new("/")), Path::new("/"));
    }

    /// A home under a temporary directory with the protected directories present, except
    /// `~/.local/share/systemd`.
    struct Home {
        tmp: tempfile::TempDir,
    }

    impl Home {
        fn new() -> Home {
            let tmp = tempfile::tempdir().unwrap();
            for d in [
                "home/.ssh",
                "home/.config/systemd/user",
                "home/.local/share",
                "out",
            ] {
                fs::create_dir_all(tmp.path().join(d)).unwrap();
            }
            fs::write(tmp.path().join("evil"), "key").unwrap();
            Home { tmp }
        }

        fn path(&self, rel: &str) -> PathBuf {
            fs::canonicalize(self.tmp.path()).unwrap().join(rel)
        }

        fn home(&self) -> PathBuf {
            self.path("home")
        }

        fn mv(&self, src: &str, dst: &str) -> FsResult {
            let home = self.home();
            move_path(
                &expand(src, Some(&home))?,
                &expand(dst, Some(&home))?,
                &home,
            )
        }

        /// Every file under the home, relative to it.
        fn files(&self) -> Vec<String> {
            fn walk(dir: &Path, base: &Path, out: &mut Vec<String>) {
                for e in fs::read_dir(dir).unwrap() {
                    let p = e.unwrap().path();
                    if p.is_dir() && !p.is_symlink() {
                        walk(&p, base, out);
                    } else {
                        out.push(shown(p.strip_prefix(base).unwrap()));
                    }
                }
            }
            let mut out = Vec::new();
            walk(&self.home(), &self.home(), &mut out);
            out.sort();
            out
        }
    }

    #[test]
    fn mv_refuses_protected_destinations_directly_and_through_symlinks() {
        let h = Home::new();
        let evil = shown(&h.path("evil"));
        symlink(h.path("home/.ssh"), h.path("out/to-ssh")).unwrap();
        symlink(h.path("home/.config/systemd"), h.path("out/to-systemd")).unwrap();
        symlink(h.path("home/.local/share"), h.path("out/to-share")).unwrap();
        let cases = [
            "~/.ssh/authorized_keys".to_owned(),
            "~/.ssh".to_owned(),
            "~/.config/systemd/user/x.service".to_owned(),
            "~/.local/share/systemd/x".to_owned(),
            "~/notes/../.ssh/authorized_keys".to_owned(),
            shown(&h.path("home/.ssh/authorized_keys")),
            // Symlinked parents, and a destination that is a symlink to the directory.
            shown(&h.path("out/to-ssh/authorized_keys")),
            shown(&h.path("out/to-ssh")),
            shown(&h.path("out/to-systemd/user/x.service")),
            shown(&h.path("out/to-share/systemd")),
            // Above a protected directory: a new ~/.local would bring its own share/systemd.
            "~/.local".to_owned(),
        ];
        for dst in &cases {
            if dst == "~/.local" {
                fs::remove_dir_all(h.path("home/.local")).unwrap();
            }
            assert_eq!(h.mv(&evil, dst), Err(REFUSED.to_owned()), "{dst}");
        }
        assert!(h.path("evil").exists());
        assert_eq!(h.files(), Vec::<String>::new());
    }

    #[test]
    fn mv_refuses_a_directory_named_systemd_into_a_config_that_lacks_one() {
        let h = Home::new();
        fs::remove_dir_all(h.path("home/.config/systemd")).unwrap();
        fs::create_dir_all(h.path("out/systemd/user")).unwrap();
        let src = shown(&h.path("out/systemd"));
        assert_eq!(h.mv(&src, "~/.config"), Err(REFUSED.to_owned()));
        assert_eq!(h.mv(&src, "~/.config/"), Err(REFUSED.to_owned()));
        assert!(h.path("out/systemd/user").is_dir());
        assert!(!h.path("home/.config/systemd").exists());
    }

    #[test]
    fn mv_compares_against_the_real_home_when_home_is_a_symlink() {
        let h = Home::new();
        symlink(h.path("home"), h.path("home-link")).unwrap();
        let linked = h.path("home-link");
        let src = h.path("evil");
        let dst = h.path("home/.ssh/authorized_keys");
        assert_eq!(move_path(&src, &dst, &linked), Err(REFUSED.to_owned()));
        assert!(!dst.exists());
    }

    #[test]
    fn mv_renames_without_clobbering_and_moves_symlinks_themselves() {
        let h = Home::new();
        fs::write(h.path("home/a.txt"), "A").unwrap();
        fs::write(h.path("home/b.txt"), "B").unwrap();
        fs::create_dir(h.path("home/dir")).unwrap();

        let ok = h.mv("~/a.txt", "~/c.txt").unwrap();
        assert_eq!(
            ok,
            json!({"ok": true, "src": shown(&h.path("home/a.txt")), "dst": shown(&h.path("home/c.txt"))})
        );
        assert_eq!(fs::read_to_string(h.path("home/c.txt")).unwrap(), "A");

        assert_eq!(
            h.mv("~/c.txt", "~/b.txt"),
            Err("destination exists".to_owned())
        );
        assert_eq!(fs::read_to_string(h.path("home/b.txt")).unwrap(), "B");
        assert_eq!(fs::read_to_string(h.path("home/c.txt")).unwrap(), "A");

        let into = h.mv("~/c.txt", "~/dir").unwrap();
        assert_eq!(into["dst"], shown(&h.path("home/dir/c.txt")));
        assert!(h.path("home/dir/c.txt").is_file());

        symlink("b.txt", h.path("home/link")).unwrap();
        h.mv("~/link", "~/dir/link").unwrap();
        assert_eq!(
            fs::read_link(h.path("home/dir/link")).unwrap(),
            Path::new("b.txt")
        );
        assert!(h.path("home/b.txt").is_file());

        assert!(
            h.mv("~/missing", "~/x")
                .unwrap_err()
                .contains("No such file")
        );
        assert!(
            h.mv("~/b.txt", "~/missing/x")
                .unwrap_err()
                .contains("No such file")
        );
        assert_eq!(h.mv("/", "~/x"), Err("cannot move /".to_owned()));
    }

    #[test]
    fn mv_across_filesystems_is_400_with_the_os_message() {
        let h = Home::new();
        let Some(other) = other_device(&h.path("")) else {
            eprintln!("skipped: no writable directory on another filesystem");
            return;
        };
        fs::write(h.path("home/a.txt"), "A").unwrap();
        let dst = other.path().join("a.txt");
        let err = h.mv("~/a.txt", &shown(&dst)).unwrap_err();
        assert_eq!(err, io::Error::from(Errno::XDEV).to_string());
        assert!(h.path("home/a.txt").is_file());
        assert!(!dst.exists());
    }

    /// A fresh directory on a filesystem other than the one holding `here`.
    fn other_device(here: &Path) -> Option<tempfile::TempDir> {
        let dev = fs::metadata(here).ok()?.dev();
        let shm = Path::new("/dev/shm");
        (fs::metadata(shm).ok()?.dev() != dev)
            .then(|| tempfile::tempdir_in(shm).ok())
            .flatten()
    }

    #[test]
    fn cat_reads_regular_files_only_with_a_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let p = |rel: &str| fs::canonicalize(tmp.path()).unwrap().join(rel);
        fs::write(p("t.txt"), "héllo").unwrap();
        fs::write(p("bin"), b"ab\0cd").unwrap();

        let all = read_file(&p("t.txt"), CAT_DEFAULT).unwrap();
        assert_eq!(
            all,
            json!({"path": shown(&p("t.txt")), "text": "héllo", "size": 6})
        );
        // A limit that cuts the two-byte é leaves U+FFFD.
        assert_eq!(read_file(&p("t.txt"), 2).unwrap()["text"], "h\u{FFFD}");
        assert_eq!(
            read_file(&p("bin"), CAT_DEFAULT).unwrap()["text"],
            "(binary file)"
        );
        assert_eq!(read_file(&p(""), CAT_DEFAULT), Err(NOT_REGULAR.to_owned()));
        assert_eq!(
            read_file(Path::new("/dev/null"), CAT_DEFAULT),
            Err(NOT_REGULAR.to_owned())
        );
        assert!(
            read_file(&p("missing"), CAT_DEFAULT)
                .unwrap_err()
                .contains("No such file")
        );
    }
}
