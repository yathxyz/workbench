//! `wb` without a server: the socket check and usage errors.

mod common;

use std::path::Path;

use common::run_wb;

#[test]
fn missing_socket_is_a_clear_exit_1() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("absent/edit.sock");
    let run = run_wb(&sock, &["buf", "ls"], None);
    assert_eq!(run.code, 1, "{run:?}");
    assert!(run.stdout.is_empty());
    assert!(
        run.stderr.contains(&sock.to_string_lossy().to_string()),
        "stderr should name the socket: {}",
        run.stderr
    );
    assert!(run.stderr.contains("edwind"), "{}", run.stderr);

    let run = run_wb(&sock, &["buf", "ls", "--json"], None);
    assert_eq!(run.code, 1);
    let err = run.json();
    assert_eq!(err["error"]["code"], "connect");
    assert!(
        err["error"]["message"]
            .as_str()
            .unwrap()
            .contains("edit.sock")
    );
}

#[test]
fn a_plain_file_is_not_a_socket() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("edit.sock");
    std::fs::write(&sock, "").unwrap();
    let run = run_wb(&sock, &["eval", "1"], None);
    assert_eq!(run.code, 1, "{run:?}");
    assert!(run.stderr.contains("edit.sock"));
}

#[test]
fn usage_errors_exit_2_before_connecting() {
    let sock = Path::new("/nonexistent/edit.sock");
    for args in [
        &[][..],
        &["buf"][..],
        &["buf", "read"][..],
        &["buf", "write", "x"][..],
        &["buf", "write", "x", "--append", "--replace"][..],
        &["buf", "read", "x", "--lines", "b:a"][..],
        &["eval"][..],
        &["edit"][..],
        &["frob"][..],
    ] {
        let run = run_wb(sock, args, None);
        assert_eq!(run.code, 2, "{args:?}: {run:?}");
        assert!(run.stderr.contains("usage: wb"), "{args:?}: {}", run.stderr);
        assert!(run.stdout.is_empty());
    }
}
