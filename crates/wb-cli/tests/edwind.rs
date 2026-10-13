//! `wb` against a real edwind (spec §13.1 and the E1 interface note).

mod common;

use serde_json::json;

use common::{Edwind, wait_child};

#[test]
fn append_with_create_then_read_round_trips() {
    let ed = Edwind::start();
    let id = ed.work_file("a.txt");
    let run = ed.wb(
        &["buf", "write", &id, "--append", "--create"],
        Some("hello\n"),
    );
    assert_eq!(run.code, 0, "{run:?}\n{}", ed.log());
    assert!(run.stdout.is_empty());
    let run = ed.wb(&["buf", "write", &id, "--append"], Some("world\n"));
    assert_eq!(run.code, 0, "{run:?}");
    let run = ed.wb(&["buf", "read", &id], None);
    assert_eq!(run.code, 0, "{run:?}");
    assert_eq!(run.stdout, "hello\nworld\n");
    assert!(run.stderr.is_empty());
}

#[test]
fn append_reads_a_file_argument() {
    let ed = Edwind::start();
    let id = ed.work_file("b.txt");
    let src = ed.root.join("input.txt");
    std::fs::write(&src, "from a file\r\nsecond\r\n").unwrap();
    let run = ed.wb(
        &[
            "buf",
            "write",
            &id,
            "--append",
            src.to_str().unwrap(),
            "--create",
        ],
        None,
    );
    assert_eq!(run.code, 0, "{run:?}");
    // CRLF input lands as LF in the buffer (R7.8).
    assert_eq!(
        ed.wb(&["buf", "read", &id], None).stdout,
        "from a file\nsecond\n"
    );
}

#[test]
fn missing_buffer_without_create_is_exit_3() {
    let ed = Edwind::start();
    let id = ed.work_file("nope.txt");
    let run = ed.wb(&["buf", "write", &id, "--append"], Some("x\n"));
    assert_eq!(run.code, 3, "{run:?}");
    assert!(run.stderr.contains("no_buffer"), "{}", run.stderr);
    let run = ed.wb(&["buf", "read", &id], None);
    assert_eq!(run.code, 3, "{run:?}");
    let run = ed.wb(&["buf", "read", &id, "--json"], None);
    assert_eq!(run.code, 3, "{run:?}");
    assert_eq!(run.json()["error"]["code"], "no_buffer");
    let run = ed.wb(&["buf", "save", &id], None);
    assert_eq!(run.code, 3, "{run:?}");
}

#[test]
fn read_opens_a_file_from_disk() {
    let ed = Edwind::start();
    let path = ed.work.join("disk.txt");
    std::fs::write(&path, "on disk\n").unwrap();
    let run = ed.wb(&["buf", "read", path.to_str().unwrap()], None);
    assert_eq!(run.code, 0, "{run:?}");
    assert_eq!(run.stdout, "on disk\n");
}

#[test]
fn replace_sends_one_minimal_op() {
    let ed = Edwind::start();
    let id = ed.work_file("r.txt");
    let run = ed.wb(
        &["buf", "write", &id, "--replace", "--create"],
        Some("hello\nworld\nbye\n"),
    );
    assert_eq!(run.code, 0, "{run:?}");
    let before = ed.wb(&["buf", "read", &id, "--ver"], None);
    assert_eq!(before.code, 0);
    let ver: u64 = before
        .stderr
        .trim()
        .parse()
        .expect("--ver prints a number on stderr");

    let run = ed.wb(
        &["buf", "write", &id, "--replace", "--json"],
        Some("hello\nthere\nbye\n"),
    );
    assert_eq!(run.code, 0, "{run:?}");
    let out = run.json();
    assert_eq!(out["buf"], id);
    assert_eq!(out["ops"], 1);
    assert_eq!(out["ver"], ver + 1);
    assert_eq!(
        ed.wb(&["buf", "read", &id], None).stdout,
        "hello\nthere\nbye\n"
    );

    // The history shows exactly one batch with one word-sized op.
    let mut c = ed.client();
    let (text, live, edits) = c.open(&id, Some(ver));
    assert!(text.is_none(), "since inside history gives no snap");
    assert_eq!(live, ver + 1);
    assert_eq!(edits.len(), 1, "{edits:?}");
    assert_eq!(edits[0]["ver"], ver + 1);
    assert_eq!(edits[0]["ops"], json!([[6, "world", "there"]]));

    // Replacing with the same text sends nothing.
    let run = ed.wb(
        &["buf", "write", &id, "--replace", "--json"],
        Some("hello\nthere\nbye\n"),
    );
    assert_eq!(run.code, 0);
    assert_eq!(run.json()["ops"], 0);
    assert_eq!(run.json()["ver"], ver + 1);
}

#[test]
fn replace_handles_surrogate_pairs() {
    let ed = Edwind::start();
    let id = ed.work_file("emoji.txt");
    ed.wb(
        &["buf", "write", &id, "--replace", "--create"],
        Some("a😀b\n"),
    );
    let before = ed.wb(&["buf", "read", &id, "--ver"], None);
    let ver: u64 = before.stderr.trim().parse().unwrap();
    let run = ed.wb(&["buf", "write", &id, "--replace"], Some("a😀c\n"));
    assert_eq!(run.code, 0, "{run:?}");
    assert_eq!(ed.wb(&["buf", "read", &id], None).stdout, "a😀c\n");
    let mut c = ed.client();
    let (_, _, edits) = c.open(&id, Some(ver));
    assert_eq!(edits[0]["ops"], json!([[3, "b", "c"]]));
}

#[test]
fn lines_ver_and_json_shapes() {
    let ed = Edwind::start();
    let id = ed.work_file("l.txt");
    ed.wb(
        &["buf", "write", &id, "--append", "--create"],
        Some("one\ntwo\nthree\nfour\n"),
    );
    let run = ed.wb(&["buf", "read", &id, "--lines", "2:3"], None);
    assert_eq!(run.code, 0, "{run:?}");
    assert_eq!(run.stdout, "two\nthree\n");
    assert_eq!(run.stderr, "");

    let run = ed.wb(&["buf", "read", &id, "--lines", "4:", "--ver"], None);
    assert_eq!(run.stdout, "four\n");
    let ver: u64 = run.stderr.trim().parse().expect("--ver on stderr");
    assert!(ver >= 1);

    let run = ed.wb(&["buf", "read", &id, "--lines", "1:2", "--json"], None);
    assert_eq!(run.code, 0, "{run:?}");
    let obj = run.json();
    assert_eq!(obj["buf"], id);
    assert_eq!(obj["ver"], ver);
    assert_eq!(obj["text"], "one\ntwo\n");
    assert_eq!(obj["lines"], json!([1, 2]));
    assert!(obj["meta"].is_object(), "{obj}");
    assert_eq!(obj["meta"]["file"], id);

    let run = ed.wb(&["buf", "read", &id, "--json"], None);
    let obj = run.json();
    assert_eq!(obj["text"], "one\ntwo\nthree\nfour\n");
    assert!(obj.get("lines").is_none());
}

#[test]
fn ls_lists_the_buffer() {
    let ed = Edwind::start();
    let id = ed.work_file("ls.txt");
    ed.wb(&["buf", "write", &id, "--append", "--create"], Some("x\n"));
    let run = ed.wb(&["buf", "ls"], None);
    assert_eq!(run.code, 0, "{run:?}");
    let line = run
        .stdout
        .lines()
        .find(|l| l.starts_with(&id))
        .unwrap_or_else(|| panic!("{id} not listed:\n{}", run.stdout));
    let cols: Vec<&str> = line.split('\t').collect();
    assert_eq!(cols.len(), 5, "{line:?}");
    assert_eq!(cols[3], "modified");

    let run = ed.wb(&["buf", "ls", "--json"], None);
    assert_eq!(run.code, 0, "{run:?}");
    let obj = run.json();
    let buffers = obj["buffers"].as_array().expect("buffers array");
    let b = buffers
        .iter()
        .find(|b| b["id"] == id)
        .unwrap_or_else(|| panic!("{id} not in {buffers:?}"));
    assert_eq!(b["modified"], true);
    assert!(b["ver"].is_number());
    assert!(b["writers"].is_array());
}

#[test]
fn eval_prints_output_then_value() {
    let ed = Edwind::start();
    let run = ed.wb(&["eval", "(+ 1 2)"], None);
    assert_eq!(run.code, 0, "{run:?}\n{}", ed.log());
    assert_eq!(run.stdout, "3\n");

    let run = ed.wb(&["eval", "(begin (display \"hi\") (newline) 'done)"], None);
    assert_eq!(run.code, 0, "{run:?}");
    assert_eq!(run.stdout, "hi\ndone\n");

    let run = ed.wb(&["eval", "(+ 1 2)", "--json"], None);
    assert_eq!(run.code, 0, "{run:?}");
    let obj = run.json();
    assert_eq!(obj["value"], "3");
    assert!(obj.get("error").is_none());

    let src = ed.root.join("f.scm");
    std::fs::write(&src, "(* 6 7)\n").unwrap();
    let run = ed.wb(&["eval", "-f", src.to_str().unwrap()], None);
    assert_eq!(run.code, 0, "{run:?}");
    assert_eq!(run.stdout, "42\n");
}

#[test]
fn eval_condition_is_exit_1_with_report_on_stderr() {
    let ed = Edwind::start();
    let run = ed.wb(&["eval", "(error \"boom here\")"], None);
    assert_eq!(run.code, 1, "{run:?}");
    assert_eq!(run.stdout, "");
    assert!(run.stderr.contains("boom here"), "{}", run.stderr);

    let run = ed.wb(&["eval", "(error \"boom json\")", "--json"], None);
    assert_eq!(run.code, 1, "{run:?}");
    let obj = run.json();
    let err = &obj["error"];
    assert!(err["code"].is_string(), "{obj}");
    assert!(err["message"].as_str().unwrap().contains("boom json"));
    assert!(err["backtrace"].is_array());
}

#[test]
fn patch_applies_with_fuzz_and_rejects_cleanly() {
    let ed = Edwind::start();
    let id = ed.work_file("p.txt");
    ed.wb(
        &["buf", "write", &id, "--append", "--create"],
        Some("one\ntwo\nthree\nfour\nfive\n"),
    );
    // Wrong context on both sides: needs fuzz 1.
    let patch = "--- a/p.txt\n+++ b/p.txt\n@@ -1,3 +1,3 @@\n ONE\n-two\n+TWO\n THREE\n";
    let run = ed.wb(&["buf", "write", &id, "--patch", "-"], Some(patch));
    assert_eq!(run.code, 0, "{run:?}");
    assert_eq!(
        ed.wb(&["buf", "read", &id], None).stdout,
        "one\nTWO\nthree\nfour\nfive\n"
    );

    // One good hunk and one that cannot apply: nothing changes, exit 5.
    let bad = "@@ -1,1 +1,1 @@\n-one\n+ONE\n@@ -4,1 +4,1 @@\n-nothing like this\n+x\n";
    let run = ed.wb(&["buf", "write", &id, "--patch", "-"], Some(bad));
    assert_eq!(run.code, 5, "{run:?}");
    assert!(run.stderr.contains("@@ -4,1 +4,1 @@"), "{}", run.stderr);
    assert!(run.stderr.contains("-nothing like this"), "{}", run.stderr);
    assert_eq!(
        ed.wb(&["buf", "read", &id], None).stdout,
        "one\nTWO\nthree\nfour\nfive\n"
    );
    let run = ed.wb(&["buf", "write", &id, "--patch", "-", "--json"], Some(bad));
    assert_eq!(run.code, 5, "{run:?}");
    let obj = run.json();
    assert_eq!(obj["error"]["code"], "patch_rejected");
    assert_eq!(obj["error"]["rejects"].as_array().unwrap().len(), 1);

    // A patch file argument works too, and a malformed patch is exit 1.
    let file = ed.root.join("good.diff");
    std::fs::write(&file, "@@ -5,1 +5,1 @@\n-five\n+FIVE\n").unwrap();
    let run = ed.wb(
        &["buf", "write", &id, "--patch", file.to_str().unwrap()],
        None,
    );
    assert_eq!(run.code, 0, "{run:?}");
    assert!(
        ed.wb(&["buf", "read", &id], None)
            .stdout
            .ends_with("FIVE\n")
    );
    let run = ed.wb(
        &["buf", "write", &id, "--patch", "-"],
        Some("not a patch\n"),
    );
    assert_eq!(run.code, 1, "{run:?}");
}

#[test]
fn patch_with_base_rebases_through_history() {
    let ed = Edwind::start();
    let id = ed.work_file("base.txt");
    ed.wb(
        &["buf", "write", &id, "--append", "--create"],
        Some("a\nb\nc\n"),
    );
    let run = ed.wb(&["buf", "read", &id, "--ver"], None);
    let base: u64 = run.stderr.trim().parse().unwrap();

    // Someone else edits after `base`: a line in front and one at the end.
    let mut other = ed.client();
    let (text, ver, _) = other.open(&id, None);
    assert_eq!(text.as_deref(), Some("a\nb\nc\n"));
    assert_eq!(ver, base);
    let v1 = other.edit(&id, ver, json!([[0, "", "zero\n"]]));
    let v2 = other.edit(&id, v1, json!([[11, "", "d\n"]]));
    assert_eq!(v2, base + 2);

    // A patch made against the text at `base` still applies.
    let patch = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";
    let run = ed.wb(
        &[
            "buf",
            "write",
            &id,
            "--patch",
            "-",
            "--base",
            &base.to_string(),
            "--json",
        ],
        Some(patch),
    );
    assert_eq!(run.code, 0, "{run:?}\n{}", ed.log());
    assert_eq!(run.json()["ver"], base + 3);
    assert_eq!(
        ed.wb(&["buf", "read", &id], None).stdout,
        "zero\na\nB\nc\nd\n"
    );
    // The other writer sees the rebased op: once live (it is attached) and once more in the replay
    // of its reopen with `since`.
    let (_, _, edits) = other.open(&id, Some(v2));
    assert!(!edits.is_empty());
    for e in &edits {
        assert_eq!(e["ops"], json!([[7, "b", "B"]]));
        assert_eq!(e["ver"], base + 3);
    }

    // A base newer than the buffer is refused.
    let run = ed.wb(
        &[
            "buf",
            "write",
            &id,
            "--patch",
            "-",
            "--base",
            &(base + 100).to_string(),
        ],
        Some(patch),
    );
    assert_eq!(run.code, 1, "{run:?}");
}

#[test]
fn save_and_revert() {
    let ed = Edwind::start();
    let path = ed.work.join("s.txt");
    let id = path.to_str().unwrap();
    ed.wb(
        &["buf", "write", id, "--append", "--create"],
        Some("data\n"),
    );
    let run = ed.wb(&["buf", "save", id, "--json"], None);
    assert_eq!(run.code, 0, "{run:?}\n{}", ed.log());
    let obj = run.json();
    assert_eq!(obj["buf"], id);
    assert_eq!(obj["saved"], true);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "data\n");

    ed.wb(&["buf", "write", id, "--append"], Some("more\n"));
    assert_eq!(ed.wb(&["buf", "read", id], None).stdout, "data\nmore\n");
    let run = ed.wb(&["buf", "revert", id], None);
    assert_eq!(run.code, 0, "{run:?}");
    assert_eq!(run.stdout, "");
    assert_eq!(ed.wb(&["buf", "read", id], None).stdout, "data\n");
}

#[test]
fn edit_without_wait_returns_at_once() {
    let ed = Edwind::start();
    let path = ed.work.join("quick.txt");
    std::fs::write(&path, "q\n").unwrap();
    let run = ed.wb(&["edit", path.to_str().unwrap(), "--json"], None);
    assert_eq!(run.code, 0, "{run:?}\n{}", ed.log());
    let obj = run.json();
    assert!(obj["exit"].is_null(), "{obj}");
    assert!(obj["buf"].is_string());
}

#[test]
fn edit_wait_exits_0_when_the_buffer_is_saved_and_finished() {
    let ed = Edwind::start();
    let path = ed.work.join("e.txt");
    std::fs::write(&path, "edit me\n").unwrap();
    let path = path.to_str().unwrap();
    let mut child = ed.spawn_wb(&["edit", path, "+1", "--wait"]);
    let mut c = ed.client();
    let buffer = ed.wait_buffer(&mut c, path);
    let id = buffer["id"].as_str().unwrap().to_owned();
    assert!(
        child.try_wait().unwrap().is_none(),
        "wb edit --wait returned before the buffer was finished"
    );
    let res = c.request(json!({"t": "call", "cmd": "server-edit-done", "args": [id], "ctx": {}}));
    assert_eq!(res["t"], "result", "{res}");
    assert_eq!(wait_child(&mut child), 0);
}

#[test]
fn edit_wait_exits_1_when_the_buffer_is_aborted() {
    let ed = Edwind::start();
    let path = ed.work.join("k.txt");
    std::fs::write(&path, "kill me\n").unwrap();
    let path = path.to_str().unwrap();
    let mut child = ed.spawn_wb(&["edit", path, "--wait"]);
    let mut c = ed.client();
    let buffer = ed.wait_buffer(&mut c, path);
    let id = buffer["id"].as_str().unwrap().to_owned();
    let res = c.request(json!({"t": "call", "cmd": "server-edit-abort", "args": [id], "ctx": {}}));
    assert_eq!(res["t"], "result", "{res}");
    assert_eq!(wait_child(&mut child), 1);
}

#[test]
fn repl_evaluates_each_form() {
    let ed = Edwind::start();
    let run = ed.wb(
        &["repl"],
        Some("(+ 1 2)\n(define (f x)\n  (* x 2))\n(f 21)\n"),
    );
    assert_eq!(run.code, 0, "{run:?}");
    assert!(run.stdout.starts_with("3\n"), "{}", run.stdout);
    assert!(run.stdout.ends_with("42\n"), "{}", run.stdout);
}
