//! edwin in a pseudo-terminal: the Vim criteria (exit statuses, $EDITOR use), files as the disk has them,
//! the terminal's events, signals, the cold start beside the snapshot, and attaching to edwind.
//!
//! Each test runs the binary on a pty in its own directory, answers the terminal queries as a terminal
//! would (DA1, background colour), types keys and waits for the exit status.

use std::ffi::CString;
use std::os::fd::RawFd;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_edwin");

struct Pty {
    fd: RawFd,
    pid: libc::pid_t,
    out: Vec<u8>,
    status: Option<i32>,
}

fn cstr(s: &str) -> CString {
    CString::new(s).unwrap()
}

impl Pty {
    fn spawn(dir: &Path, args: &[&str], extra_env: &[(&str, &str)]) -> Pty {
        Pty::spawn_program(dir, BIN, args, extra_env)
    }
    fn spawn_program(dir: &Path, program: &str, args: &[&str], extra_env: &[(&str, &str)]) -> Pty {
        let mut env: Vec<(String, String)> = vec![
            ("HOME".into(), dir.display().to_string()),
            (
                "XDG_STATE_HOME".into(),
                dir.join("state").display().to_string(),
            ),
            (
                "XDG_CONFIG_HOME".into(),
                dir.join("config").display().to_string(),
            ),
            ("EDWIN_NO_ATTACH".into(), "1".into()),
            ("TERM".into(), "xterm-256color".into()),
            ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
        ];
        for (k, v) in extra_env {
            env.retain(|(a, _)| a != k);
            if !v.is_empty() {
                env.push((k.to_string(), v.to_string()));
            }
        }
        let envp: Vec<CString> = env.iter().map(|(k, v)| cstr(&format!("{k}={v}"))).collect();
        let mut envp_ptrs: Vec<*const libc::c_char> = envp.iter().map(|c| c.as_ptr()).collect();
        envp_ptrs.push(std::ptr::null());
        let argv: Vec<CString> = std::iter::once(program)
            .chain(args.iter().copied())
            .map(cstr)
            .collect();
        let mut argv_ptrs: Vec<*const libc::c_char> = argv.iter().map(|c| c.as_ptr()).collect();
        argv_ptrs.push(std::ptr::null());
        let bin = cstr(program);
        let cwd = cstr(&dir.display().to_string());
        let ws = libc::winsize {
            ws_row: 24,
            ws_col: 80,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let mut fd: RawFd = -1;
        // SAFETY: the child only calls chdir and execve (async-signal-safe) with data prepared before fork.
        let pid = unsafe { libc::forkpty(&mut fd, std::ptr::null_mut(), std::ptr::null(), &ws) };
        assert!(pid >= 0, "forkpty failed");
        if pid == 0 {
            unsafe {
                libc::chdir(cwd.as_ptr());
                libc::execve(bin.as_ptr(), argv_ptrs.as_ptr(), envp_ptrs.as_ptr());
                libc::_exit(127);
            }
        }
        Pty {
            fd,
            pid,
            out: Vec::new(),
            status: None,
        }
    }
    /// Read what the program wrote for MS milliseconds, answering its terminal queries.
    fn pump(&mut self, ms: u64) {
        let end = Instant::now() + Duration::from_millis(ms);
        loop {
            let left = end.saturating_duration_since(Instant::now());
            let mut p = libc::pollfd {
                fd: self.fd,
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: one valid pollfd.
            let n = unsafe { libc::poll(&mut p, 1, left.as_millis() as i32) };
            if n > 0 {
                let mut b = [0u8; 65536];
                // SAFETY: reading into a local buffer.
                let k =
                    unsafe { libc::read(self.fd, b.as_mut_ptr() as *mut libc::c_void, b.len()) };
                if k <= 0 {
                    self.reap(true);
                    return;
                }
                let chunk = &b[..k as usize];
                if contains(chunk, b"\x1b]11;?") {
                    self.send_raw(b"\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\");
                }
                if contains(chunk, b"\x1b[c") {
                    self.send_raw(b"\x1b[?62;22c");
                }
                self.out.extend_from_slice(chunk);
            }
            if Instant::now() >= end {
                return;
            }
        }
    }
    /// Wait for the first complete draw.
    fn ready(&mut self) -> &mut Self {
        let end = Instant::now() + Duration::from_secs(10);
        while !contains(&self.out, b"\x1b[?2026l") {
            assert!(
                Instant::now() < end,
                "no first draw; output: {:?}",
                String::from_utf8_lossy(&self.out)
            );
            self.pump(20);
        }
        self
    }
    fn send_raw(&self, s: &[u8]) {
        // SAFETY: writing a local buffer to our pty.
        unsafe { libc::write(self.fd, s.as_ptr() as *const libc::c_void, s.len()) };
    }
    /// Type S, then let the program take it in.
    fn keys(&mut self, s: &str) -> &mut Self {
        self.send_raw(s.as_bytes());
        self.pump(60);
        self
    }
    /// ESC on its own: a lone ESC is told from a sequence by the pause after it.
    fn esc(&mut self) -> &mut Self {
        self.send_raw(b"\x1b");
        self.pump(120);
        self
    }
    fn reap(&mut self, block: bool) {
        if self.status.is_some() {
            return;
        }
        let mut st = 0;
        // SAFETY: waiting for our own child.
        let r = unsafe { libc::waitpid(self.pid, &mut st, if block { 0 } else { libc::WNOHANG }) };
        if r == self.pid {
            self.status = Some(if libc::WIFEXITED(st) {
                libc::WEXITSTATUS(st)
            } else {
                128 + libc::WTERMSIG(st)
            });
        }
    }
    /// The exit status, waiting up to five seconds.
    fn exit(&mut self) -> i32 {
        let end = Instant::now() + Duration::from_secs(5);
        while self.status.is_none() {
            self.reap(false);
            if self.status.is_some() {
                break;
            }
            assert!(
                Instant::now() < end,
                "edwin did not exit; screen tail: {:?}",
                tail(&self.out)
            );
            self.pump(20);
        }
        self.status.unwrap()
    }
    fn signal(&self, sig: libc::c_int) {
        // SAFETY: signalling our own child.
        unsafe { libc::kill(self.pid, sig) };
    }
    fn resize(&self, cols: u16, rows: u16) {
        let ws = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: TIOCSWINSZ on our pty master.
        unsafe { libc::ioctl(self.fd, libc::TIOCSWINSZ, &ws) };
        self.signal(libc::SIGWINCH);
    }
    fn take(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.out)
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        if self.status.is_none() {
            self.signal(libc::SIGKILL);
            self.reap(true);
        }
        // SAFETY: closing our pty master.
        unsafe { libc::close(self.fd) };
    }
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}
fn tail(b: &[u8]) -> String {
    String::from_utf8_lossy(&b[b.len().saturating_sub(400)..]).into_owned()
}

/// A fresh directory for one test.
fn workdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("edwin-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}
fn read(p: impl AsRef<Path>) -> String {
    std::fs::read_to_string(p).unwrap()
}

#[test]
fn wq_saves_and_exits_zero() {
    let d = workdir("wq");
    std::fs::write(d.join("a.txt"), "hello\nworld\n").unwrap();
    let mut t = Pty::spawn(&d, &["a.txt"], &[]);
    t.ready().keys("Ofirst").esc().keys(":wq\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("a.txt")), "first\nhello\nworld\n");
}

#[test]
fn cq_exits_nonzero_and_saves_nothing() {
    let d = workdir("cq");
    std::fs::write(d.join("COMMIT_EDITMSG"), "msg\n").unwrap();
    let mut t = Pty::spawn(&d, &["COMMIT_EDITMSG"], &[]);
    t.ready().keys("dd:cq\r");
    assert_eq!(t.exit(), 1);
    assert_eq!(read(d.join("COMMIT_EDITMSG")), "msg\n");
    let mut t = Pty::spawn(&d, &["COMMIT_EDITMSG"], &[]);
    t.ready().keys(":cq 3\r");
    assert_eq!(t.exit(), 3);
}

#[test]
fn q_refuses_changes_until_bang() {
    let d = workdir("q");
    std::fs::write(d.join("b.txt"), "one\n").unwrap();
    let mut t = Pty::spawn(&d, &["b.txt"], &[]);
    t.ready().keys("x:q\r");
    t.pump(150);
    assert!(t.status.is_none(), ":q left with changes");
    assert!(contains(&t.out, b"E37"), "no E37 in {:?}", tail(&t.out));
    t.keys(":q!\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("b.txt")), "one\n");
}

#[test]
fn zz_and_c_x_c_c_save_then_leave() {
    let d = workdir("zz");
    std::fs::write(d.join("z.txt"), "z\n").unwrap();
    let mut t = Pty::spawn(&d, &["z.txt"], &[]);
    t.ready().keys("Atwo").esc().keys("ZZ");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("z.txt")), "ztwo\n");
    let mut t = Pty::spawn(&d, &["z.txt"], &[]);
    t.ready().keys("x\x18\x03");
    t.pump(100);
    t.keys("y");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("z.txt")).len(), 4);
}

#[test]
fn a_new_file_ends_in_a_newline() {
    let d = workdir("new");
    let mut t = Pty::spawn(&d, &["sub-new.txt"], &[]);
    t.ready();
    assert!(contains(&t.out, b"[New]"));
    t.keys("ihi").esc().keys(":wq\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("sub-new.txt")), "hi\n");
}

#[test]
fn files_keep_their_line_ends_mode_and_links() {
    use std::os::unix::fs::PermissionsExt;
    let d = workdir("shape");
    std::fs::write(d.join("dos.txt"), "\u{feff}one\r\ntwo\r\n").unwrap();
    std::fs::write(d.join("target.txt"), "t\n").unwrap();
    std::os::unix::fs::symlink("target.txt", d.join("link.txt")).unwrap();
    std::fs::set_permissions(d.join("target.txt"), std::fs::Permissions::from_mode(0o640)).unwrap();
    let mut t = Pty::spawn(&d, &["dos.txt"], &[]);
    t.ready()
        .keys("Ax")
        .esc()
        .keys(":w\r:e link.txt\r")
        .keys("Ay")
        .esc()
        .keys(":wq\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(
        std::fs::read(d.join("dos.txt")).unwrap(),
        "\u{feff}onex\r\ntwo\r\n".as_bytes()
    );
    assert!(
        std::fs::symlink_metadata(d.join("link.txt"))
            .unwrap()
            .file_type()
            .is_symlink(),
        "the link was replaced by a file"
    );
    assert_eq!(read(d.join("target.txt")), "ty\n");
    assert_eq!(
        std::fs::metadata(d.join("target.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o640
    );
}

#[test]
fn one_file_under_two_names_is_one_buffer() {
    let d = workdir("names");
    std::fs::write(d.join("real.txt"), "one\n").unwrap();
    std::os::unix::fs::symlink(d.join("real.txt"), d.join("alias.txt")).unwrap();
    let mut t = Pty::spawn(&d, &["real.txt"], &[]);
    t.ready();
    t.keys("Ax").esc();
    t.keys(":e ./alias.txt\r").keys("Ay").esc();
    t.keys(":e sub/../real.txt\r")
        .keys("Az")
        .esc()
        .keys(":wq\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("real.txt")), "onexyz\n");
    assert!(std::fs::symlink_metadata(d.join("alias.txt"))
        .unwrap()
        .file_type()
        .is_symlink());
}

#[test]
fn a_file_that_is_not_text_is_refused() {
    let d = workdir("binary");
    std::fs::write(d.join("x.bin"), [0xffu8, 0xfe, 0x00, 0x80]).unwrap();
    let mut t = Pty::spawn(&d, &["x.bin"], &[]);
    t.ready();
    assert!(contains(&t.out, b"not UTF-8 text"), "{:?}", tail(&t.out));
    t.keys(":q\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(
        std::fs::read(d.join("x.bin")).unwrap(),
        [0xffu8, 0xfe, 0x00, 0x80]
    );
}

#[test]
fn plus_line_starts_on_that_line() {
    let d = workdir("args");
    std::fs::write(d.join("l.txt"), "1\n2\n3\n").unwrap();
    let mut t = Pty::spawn(&d, &["+2", "l.txt"], &[]);
    t.ready().keys("dd:wq\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("l.txt")), "1\n3\n");
}

#[test]
fn a_dash_edits_standard_input() {
    let d = workdir("stdin");
    let mut t = Pty::spawn_program(
        &d,
        "/bin/sh",
        &["-c", &format!("printf 'piped text\\n' | {BIN} -")],
        &[],
    );
    t.ready().keys(":w out.txt\r:q\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("out.txt")), "piped text\n");
}

#[test]
fn help_version_and_bad_options_need_no_terminal() {
    let o = std::process::Command::new(BIN)
        .arg("--help")
        .output()
        .unwrap();
    assert!(o.status.success());
    assert!(String::from_utf8_lossy(&o.stdout).starts_with("Usage: edwin"));
    let o = std::process::Command::new(BIN)
        .arg("--version")
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&o.stdout).starts_with("edwin "));
    let o = std::process::Command::new(BIN)
        .arg("--frobnicate")
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&o.stderr).contains("unknown option --frobnicate"));
}

#[test]
fn sigterm_rescues_changes_and_exits_143() {
    let d = workdir("term");
    std::fs::write(d.join("r.txt"), "r\n").unwrap();
    let mut t = Pty::spawn(&d, &["r.txt"], &[]);
    t.ready().keys("Arescued").esc();
    t.signal(libc::SIGTERM);
    assert_eq!(t.exit(), 143);
    assert_eq!(read(d.join("r.txt")), "r\n");
    let rescue: Vec<_> = std::fs::read_dir(d.join("state/edwin/rescue"))
        .unwrap()
        .flatten()
        .collect();
    assert_eq!(rescue.len(), 1);
    assert_eq!(read(rescue[0].path()), "rrescued\n");
}

#[test]
fn terminal_events_clipboard_mouse_paste_resize_suspend() {
    let d = workdir("events");
    std::fs::write(d.join("m.txt"), "alpha beta\ngamma delta\n").unwrap();
    let mut t = Pty::spawn(&d, &["m.txt"], &[("COLORTERM", "truecolor")]);
    t.ready();
    assert!(
        contains(&t.out, b"\x1b[?1049h")
            && contains(&t.out, b"\x1b[?2004h")
            && contains(&t.out, b"\x1b[?1006h")
    );
    assert!(contains(&t.out, b"48;2;"), "truecolor backgrounds");
    t.take();
    t.keys("yy");
    assert!(
        contains(&t.out, b"\x1b]52;c;YWxwaGEgYmV0YQo="),
        "yy copies through OSC 52"
    );
    // Line numbers take the first cells: column 6 of row 2 is a few characters into "gamma delta".
    t.keys("\x1b[<0;9;2M\x1b[<0;9;2m");
    t.keys("\x1b[200~PASTE\x1b[201~");
    t.take();
    t.resize(100, 30);
    t.pump(200);
    assert!(
        contains(&t.out, b"\x1b[2J") && contains(&t.out, b"\x1b[30;1H"),
        "a resize draws the whole screen again"
    );
    t.take();
    t.keys("\x1a");
    t.pump(200);
    let out = t.take();
    let left = out
        .windows(8)
        .position(|w| w == b"\x1b[?1049l")
        .expect("C-z leaves the alternate screen");
    assert!(
        contains(&out[left..], b"\x1b[?1049h"),
        "and enters it again on resume"
    );
    t.keys(":wq\r");
    assert_eq!(t.exit(), 0);
    let text = read(d.join("m.txt"));
    assert!(
        text.starts_with("alpha beta\ng") && text.contains("PASTE") && text.ends_with("delta\n"),
        "{text:?}"
    );
}

#[test]
fn the_cold_start_works_as_the_snapshot_does() {
    let d = workdir("cold");
    std::fs::write(d.join("c.txt"), "cold\n").unwrap();
    let mut t = Pty::spawn(&d, &["c.txt"], &[("EDWIN_NO_SNAPSHOT", "1")]);
    t.ready().keys("Aer").esc().keys(":wq\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("c.txt")), "colder\n");
}

#[test]
fn the_user_init_runs_and_settings_persist() {
    let d = workdir("init");
    std::fs::create_dir_all(d.join("config/edwin")).unwrap();
    std::fs::write(
        d.join("config/edwin/init.scm"),
        "(define-key evil-normal-state-map \"Q\" 'evil-quit-all-with-error-code)\n",
    )
    .unwrap();
    std::fs::write(d.join("p.txt"), "a\nb\nc\nd\n").unwrap();
    let mut t = Pty::spawn(&d, &["p.txt"], &[]);
    t.ready().keys("jj:q\r");
    assert_eq!(t.exit(), 0);
    // save-place put point back on line 3; the init's Q leaves with status 1.
    let mut t = Pty::spawn(&d, &["p.txt"], &[]);
    t.ready().keys("dd:w\rQ");
    assert_eq!(t.exit(), 1);
    assert_eq!(read(d.join("p.txt")), "a\nb\nd\n");
}

/// Attaching to edwind needs Node and edwind's test harness (edwin/test/edit-client.mjs); skipped without node.
#[test]
fn attached_notes_go_through_edwind_and_other_files_stay_local() {
    if std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("skipped: no node");
        return;
    }
    use std::io::{BufRead, Write};
    let helper = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/edwind-up.mjs");
    let mut node = std::process::Command::new("node")
        .arg(&helper)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut lines = std::io::BufReader::new(node.stdout.take().unwrap()).lines();
    let info = lines.next().unwrap().unwrap();
    let field = |k: &str| {
        info.split(&format!("\"{k}\":\""))
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap()
            .to_string()
    };
    let (socket, notes) = (field("socket"), field("notes"));
    let d = workdir("attach");
    std::fs::write(d.join("local.txt"), "local\n").unwrap();
    // The note named through a link to the notes directory and a dot segment: still edwind's note.
    std::os::unix::fs::symlink(&notes, d.join("notes-link")).unwrap();
    let mut t = Pty::spawn(
        &d,
        &["--socket", &socket, "./notes-link/./a.md", "local.txt"],
        &[("EDWIN_NO_ATTACH", "")],
    );
    t.ready();
    t.pump(500);
    t.keys("Gotyped in the terminal").esc().keys(":w\r");
    t.pump(500);
    t.keys(":e local.txt\r").keys("Aedited").esc().keys(":wq\r");
    assert_eq!(t.exit(), 0);
    assert_eq!(read(d.join("local.txt")), "localedited\n");
    writeln!(node.stdin.as_mut().unwrap(), "done").unwrap();
    let after = lines.next().unwrap().unwrap();
    let _ = node.wait();
    assert_eq!(
        after,
        r##"{"server":"# Shared page\ntyped in the terminal\n","disk":"# Shared page\ntyped in the terminal\n"}"##
    );
}
