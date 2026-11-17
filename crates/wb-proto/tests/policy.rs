use serde_json::{Value, json};
use wb_proto::limits::*;
use wb_proto::policy::*;

fn policy(rules: Value) -> Policy {
    serde_json::from_value(json!({"rules": rules})).unwrap()
}

fn options() -> Vec<Value> {
    vec![
        json!({"optionId": "always", "name": "Always", "kind": "allow_always"}),
        json!({"optionId": "yes", "name": "Allow", "kind": "allow_once"}),
        json!({"optionId": "no", "name": "Reject", "kind": "reject_once"}),
    ]
}

fn call(kind: &str, paths: &[&str], command: &str) -> Value {
    let mut call = json!({
        "toolCallId": "call-1", "title": "A tool request", "kind": kind,
        "locations": paths.iter().map(|path| json!({"path": path})).collect::<Vec<_>>(),
    });
    if kind == "execute" {
        call["rawInput"] = json!({"command": command});
    }
    call
}

fn compiled(rules: Value) -> CompiledPolicy {
    CompiledPolicy::new(&policy(rules), "/work/project").unwrap()
}

#[test]
fn default_empty_policy_asks() {
    assert!(Policy::default().rules.is_empty());
    let empty = CompiledPolicy::new(&Policy::default(), "/work").unwrap();
    assert_eq!(empty.decide(&call("read", &["file"], ""), &options()), None);
}

#[test]
fn policies_reject_unknown_fields_and_actions() {
    for wire in [
        json!({"rules": [], "typo": true}),
        json!({"rules": [{"action": "allow", "root": "/work"}]}),
        json!({"rules": [{"action": "allow", "command": {"notMatch": ["x"]}}]}),
        json!({"rules": [{"action": "approve"}]}),
        json!({"rules": [{"action": "ALLOW"}]}),
    ] {
        assert!(
            serde_json::from_value::<Policy>(wire.clone()).is_err(),
            "{wire}"
        );
    }
    for field in ["kinds", "roots", "programs", "command"] {
        let mut rule = json!({"action": "allow"});
        rule[field] = Value::Null;
        assert!(serde_json::from_value::<Policy>(json!({"rules":[rule]})).is_err());
    }
    assert!(
        serde_json::from_value::<PolicyMatch>(json!({
            "rule": 0, "action": "allow", "extra": true
        }))
        .is_err()
    );
}

#[test]
fn policy_validation_bounds_and_regex_syntax() {
    let allow = json!({"action": "allow"});
    assert!(
        policy(json!(vec![allow.clone(); POLICY_RULES_MAX]))
            .validate()
            .is_ok()
    );
    assert!(
        policy(json!(vec![allow; POLICY_RULES_MAX + 1]))
            .validate()
            .is_err()
    );
    for field in ["roots", "kinds", "programs"] {
        let value = if field == "roots" { "/work" } else { "read" };
        let mut rule = json!({"action": "allow"});
        rule[field] = json!(vec![value; POLICY_SELECTORS_MAX]);
        assert!(policy(json!([rule.clone()])).validate().is_ok());
        rule[field] = json!(vec![value; POLICY_SELECTORS_MAX + 1]);
        assert!(policy(json!([rule])).validate().is_err());
    }
    for root in ["", "relative", "$cwd/sub", "/work\0/file"] {
        assert!(
            policy(json!([{"action":"allow", "roots":[root]}]))
                .validate()
                .is_err()
        );
    }
    for kind in [
        "".to_owned(),
        "a".repeat(POLICY_KIND_MAX + 1),
        "read\0".into(),
        "é".repeat(33),
    ] {
        assert!(
            policy(json!([{"action":"allow", "kinds":[kind]}]))
                .validate()
                .is_err()
        );
    }
    assert!(
        policy(json!([{"action":"allow", "kinds":["é".repeat(32)]}]))
            .validate()
            .is_ok()
    );
    for pattern in ["[".to_owned(), "a".repeat(POLICY_PATTERN_MAX + 1)] {
        let invalid = policy(json!([{"action":"allow", "command":{"matches":[pattern]}}]));
        assert!(invalid.validate().is_err());
        assert!(CompiledPolicy::new(&invalid, "/work").is_err());
    }
    assert!(
        policy(json!([{
            "action":"allow", "command":{"matches":["a".repeat(POLICY_PATTERN_MAX)]}
        }]))
        .validate()
        .is_ok()
    );
    let at_limit = policy(json!([
        {"action":"allow", "command":{"matches":vec!["x"; 64]}},
        {"action":"reject", "command":{"notMatches":vec!["y"; 64]}}
    ]));
    assert!(at_limit.validate().is_ok());
    let over_limit = policy(json!([
        {"action":"allow", "command":{"matches":vec!["x"; 64]}},
        {"action":"reject", "command":{"notMatches":vec!["y"; 65]}}
    ]));
    assert!(over_limit.validate().is_err());
    for cwd in ["", "relative", "/work\0"] {
        assert!(CompiledPolicy::new(&Policy::default(), cwd).is_err());
    }
}

#[test]
fn relative_paths_and_parent_components_are_lexical() {
    let p = compiled(json!([{"action":"allow", "roots":["$cwd"]}]));
    for path in [
        ".",
        "src/file",
        "./src/../file",
        "/work/project/a/../file",
        "../project/file",
    ] {
        assert_eq!(
            p.decide(&call("read", &[path], ""), &options())
                .unwrap()
                .option_id,
            "yes",
            "{path}"
        );
    }
    for path in [
        "..",
        "../../etc/passwd",
        "/work/project/../../etc/passwd",
        "/work/project-other/file",
    ] {
        assert_eq!(
            p.decide(&call("read", &[path], ""), &options()),
            None,
            "{path}"
        );
    }
    assert_eq!(
        p.decide(&call("read", &["src/a", "/etc/passwd"], ""), &options()),
        None
    );
    let root =
        CompiledPolicy::new(&policy(json!([{"action":"allow", "roots":["/"]}])), "/work").unwrap();
    assert!(
        root.decide(&call("read", &["/../../etc/passwd"], ""), &options())
            .is_some()
    );
}

#[test]
fn root_normalization_and_containment_use_components() {
    let p = compiled(json!([{"action":"allow", "roots":["/tmp/../work/project/.", "/nix/store"]}]));
    assert!(
        p.decide(
            &call("edit", &["src/a", "/nix/store/pkg/file"], ""),
            &options()
        )
        .is_some()
    );
    assert_eq!(
        p.decide(&call("edit", &["/nix/store-other/pkg"], ""), &options()),
        None
    );
    assert_eq!(
        p.decide(&call("edit", &["/nix/store/../../etc"], ""), &options()),
        None
    );
    let empty_roots = compiled(json!([{"action":"allow", "roots":[]}]));
    assert_eq!(
        empty_roots.decide(&call("read", &["file"], ""), &options()),
        None
    );
}

#[test]
fn nonexistent_paths_and_symlink_names_are_not_resolved() {
    // No file is created or looked up. Even a conventional symlink path remains
    // lexical: /proc/self is not canonicalized to a process-specific directory.
    let p = compiled(
        json!([{"action":"allow", "roots":["/proc/self", "/definitely-nonexistent-root"]}]),
    );
    for path in ["/proc/self/fd/0", "/definitely-nonexistent-root/file"] {
        assert!(p.decide(&call("read", &[path], ""), &options()).is_some());
    }
    let p = compiled(json!([{"action":"allow", "roots":["$cwd"]}]));
    assert!(
        p.decide(&call("read", &["imaginary-symlink/target"], ""), &options())
            .is_some()
    );
    assert_eq!(
        p.decide(
            &call("read", &["imaginary-symlink/../../outside"], ""),
            &options()
        ),
        None
    );
}

#[test]
fn command_patterns_are_conjunctive_and_execute_only() {
    let p = compiled(json!([{
        "action":"allow", "kinds":["read", "edit", "execute"], "roots":["$cwd", "/tmp", "/nix/store"],
        "command":{"matches":["^cargo ", "test"], "notMatches":["--release", "sudo"]}
    }]));
    assert!(
        p.decide(&call("execute", &["."], "cargo test"), &options())
            .is_some()
    );
    for command in [
        "cargo build",
        "echo test",
        "cargo test --release",
        "sudo cargo test",
    ] {
        assert_eq!(
            p.decide(&call("execute", &["."], command), &options()),
            None,
            "{command}"
        );
    }
    let mut read = call("read", &["src/main.rs"], "sudo");
    read.as_object_mut().unwrap().remove("rawInput");
    assert!(p.decide(&read, &options()).is_some());
    // No kinds restriction is required to use execute-only conditions.
    let p = compiled(json!([{"action":"allow", "command":{"matches":["^safe$"]}}]));
    assert!(
        p.decide(&call("read", &["file"], "unsafe"), &options())
            .is_some()
    );
    assert_eq!(
        p.decide(&call("execute", &["file"], "unsafe"), &options()),
        None
    );
}

#[test]
fn command_words_and_redirections_are_checked_as_complete_paths() {
    let p = compiled(json!([{"action":"allow", "roots":["$cwd", "/tmp"]}]));
    for command in [
        "cat /work/project/file",
        "cat '/work/project/file'",
        "cat \"/tmp/file\"",
        "cat /tmp/a;/work/project/bin",
        "cat --file=/tmp/file",
        "echo /tmp/./a",
        "cat '/work/project/a b'",
        "cat '/work/'project/file",
        "cat /work/project/file''",
    ] {
        assert!(
            p.decide(&call("execute", &["."], command), &options())
                .is_some(),
            "{command}"
        );
    }
    for command in [
        "cat /etc/passwd",
        "cat '/etc/passwd'",
        "cat \"/etc/passwd\"",
        "cat /tmp/../etc/passwd",
        "cat /work/project-other/file",
        "cat /tmp/a|cat /etc/passwd",
        "cat /tmp/a>/etc/passwd",
        "cat /tmp/a&&cat /etc/passwd",
        "cat --file=/etc/passwd",
        "PATH=/tmp:/etc cmd",
        "echo /etc/passwd[ab]",
        "echo {/etc/passwd,/tmp/a}",
        "echo /tmp/a,/etc/passwd",
        r#"echo {"path":"/etc/passwd"}"#,
        "echo `cat /etc/passwd`",
        "sh -c 'cat /tmp/a /etc/passwd'",
        "cat '/work/project/../outside'",
        "cat '/work/project space/file'",
        "cat '/work/project'other",
        "cat '/work/project/file",
        "cat \"/tmp/file",
        "cat /tmp/a\\ /etc/passwd",
    ] {
        assert_eq!(
            p.decide(&call("execute", &["."], command), &options()),
            None,
            "{command}"
        );
    }
}

#[test]
fn first_match_ask_and_missing_once_never_fall_through() {
    let p = compiled(json!([
        {"action":"ask", "kinds":["read"]}, {"action":"reject"}, {"action":"allow"}
    ]));
    assert_eq!(p.decide(&call("read", &["file"], ""), &options()), None);
    let rejected = p.decide(&call("edit", &["file"], ""), &options()).unwrap();
    assert_eq!(
        rejected,
        Decision {
            rule: 1,
            action: Action::Reject,
            option_id: "no".into()
        }
    );
    let p = compiled(json!([{"action":"allow"}, {"action":"reject"}]));
    let no_once = vec![
        json!({"optionId":"always", "name":"Always", "kind":"allow_always"}),
        json!({"optionId":"no", "name":"Reject", "kind":"reject_once"}),
    ];
    assert_eq!(p.decide(&call("read", &["file"], ""), &no_once), None);
    let p = compiled(json!([{"action":"reject"}, {"action":"allow"}]));
    assert_eq!(
        p.decide(&call("read", &["file"], ""), &options()[..2]),
        None
    );
}

#[test]
fn malformed_tool_descriptions_always_ask() {
    let p = compiled(json!([{"action":"allow"}]));
    let valid = call("execute", &["file"], "echo safe");
    for field in ["toolCallId", "title", "kind", "locations", "rawInput"] {
        let mut malformed = valid.clone();
        malformed.as_object_mut().unwrap().remove(field);
        assert_eq!(p.decide(&malformed, &options()), None, "missing {field}");
    }
    for (field, value) in [
        ("toolCallId", json!("")),
        ("title", json!(null)),
        ("kind", json!(42)),
        ("locations", json!([])),
        ("locations", json!([{}])),
        ("locations", json!([{"path":""}])),
        ("locations", json!([{"path":null}])),
        ("locations", json!([{"path":"a\0b"}])),
        ("locations", json!([{"path":"safe"}, {"path":2}])),
        ("locations", json!({"path":"safe"})),
        ("rawInput", json!({"command":42})),
        ("rawInput", json!({"command":""})),
        ("rawInput", json!({"cmd":"echo safe"})),
    ] {
        let mut malformed = valid.clone();
        malformed[field] = value;
        assert_eq!(p.decide(&malformed, &options()), None, "{malformed}");
    }
    let mut misleading = valid;
    misleading["rawInput"] = json!({"command": {"command":"echo safe"}});
    misleading["title"] = json!("echo safe");
    misleading["command"] = json!("echo safe");
    assert_eq!(p.decide(&misleading, &options()), None);
}

#[test]
fn malformed_options_never_automatically_resolve() {
    let p = compiled(json!([{"action":"allow"}]));
    for malformed in [
        vec![],
        vec![json!({"kind":"allow_once"})],
        vec![json!({"optionId":"", "name":"Allow", "kind":"allow_once"})],
        vec![json!({"optionId":"yes", "kind":"allow_once"})],
        vec![json!({"optionId":"yes", "name":"Allow", "kind":"allow_forever"})],
        vec![
            json!({"optionId":"yes", "name":"Allow", "kind":"allow_once"}),
            json!({"optionId":"yes", "name":"Reject", "kind":"reject_once"}),
        ],
        vec![
            json!({"optionId":"yes", "name":"Allow", "kind":"allow_once"}),
            json!(null),
        ],
    ] {
        assert_eq!(
            p.decide(&call("read", &["file"], ""), &malformed),
            None,
            "{malformed:?}"
        );
    }
}

#[test]
fn ambiguous_command_text_asks_even_without_root_conditions() {
    let p = compiled(json!([{"action":"allow"}]));
    for command in [
        "echo 'unfinished",
        "echo \"unfinished",
        "echo `cat /tmp/a`",
        "cat /tmp/a\\ b",
    ] {
        assert_eq!(
            p.decide(&call("execute", &["."], command), &options()),
            None,
            "{command}"
        );
    }
}

#[test]
fn unmatched_rules_can_fall_through_but_matched_rules_cannot() {
    let p = compiled(json!([
        {"action":"allow", "kinds":["execute"], "command":{"matches":["^safe$"]}},
        {"action":"reject", "kinds":["execute"]}
    ]));
    let decision = p
        .decide(&call("execute", &["."], "unsafe"), &options())
        .unwrap();
    assert_eq!(decision.rule, 1);
    assert_eq!(decision.action, Action::Reject);
    assert_eq!(p.decide(&call("unknown", &["."], ""), &options()), None);
}

#[test]
fn review_commands_with_outside_or_unresolved_paths_ask() {
    let p = CompiledPolicy::new(
        &policy(json!([{"action":"allow", "roots":["$cwd", "/nix/store", "/tmp"]}])),
        "/home/u/proj",
    )
    .unwrap();
    let commands = [
        r#"cat '/tmp/'"../etc/passwd""#,
        "mkdir -p /tmp/p=q; cat /tmp/p=q/../../etc/passwd",
        "mkdir -p /tmp/p:q; cat /tmp/p:q/../../etc/passwd",
        "mkdir -p /tmp/p,q; cat /tmp/p,q/../../etc/passwd",
        "cat ../../../etc/passwd",
        "printf changed > ../../../etc/policy-review-marker",
        "cd ..; cat private.txt",
        r#"cat "$PWD/../../../etc/passwd""#,
        "cat ~root/.profile",
        r#"cat "$(printf '%s' ../../../etc/passwd)""#,
    ];
    let allowed: Vec<_> = commands
        .into_iter()
        .filter(|command| {
            p.decide(&call("execute", &["."], command), &options())
                .is_some()
        })
        .collect();
    assert!(allowed.is_empty(), "unintended allows: {allowed:?}");
}

#[test]
fn literal_shell_subset_keeps_cooperative_commands_usable() {
    let p = compiled(json!([{"action":"allow", "roots":["$cwd", "/nix/store", "/tmp"]}]));
    for command in [
        "cargo test -p x",
        "cd crates/a && cargo fmt",
        "git -C sub status",
        "ls ./src",
        "nix build .#checks.x86_64-linux.fmt --no-link",
        "FOO=bar make",
        "cat a/b.txt > /tmp/out.txt",
        "grep -n \"a b\" src/x.rs | head -5",
        "ls src/*.rs",
        "cat < ./src/x.rs >> /tmp/out.txt",
        "cd crates/a && cat ../../README",
        "cd crates/a && cd ../b && ls ./src",
        "false || ls ./src; true\ncat ./README",
        "cat './src/'\"../README\"",
        "ls ./src/*.rs",
        r#"cat 'src/a\b'"#,
    ] {
        assert!(
            p.decide(&call("execute", &["."], command), &options())
                .is_some(),
            "{command}"
        );
    }
}

#[test]
fn cwd_changes_account_for_failures_short_circuiting_and_pipeline_scope() {
    let p = compiled(json!([{"action":"allow", "roots":["$cwd", "/tmp"]}]));
    for command in [
        "cd crates/a; cat ../../README",
        "cd crates/a || cat ../../README",
        "cd crates/a && cd sub; cat ../../../README",
        "cd crates/a || cd crates/b; cat ../../README",
        "cd /etc && cat passwd",
        "cd /tmp; cat ../etc/passwd",
        "cd crates/a | cat ./src",
        "echo ignored | cd crates/a",
        "cd",
        "cd -",
        "cd -- crates/a",
        "cd -P crates/a",
        "cd crates/*",
        "CDPATH=/tmp cd crates/a",
        "pushd crates/a",
        "popd",
        "command cd ..",
        "builtin cd ..",
    ] {
        assert_eq!(
            p.decide(&call("execute", &["."], command), &options()),
            None,
            "{command}"
        );
    }
    // A rule cannot ignore bare operands while the shell's initial cwd is outside.
    let p = compiled(json!([{"action":"allow", "roots":["/tmp"]}]));
    assert_eq!(
        p.decide(&call("execute", &["/tmp/a"], "cat README"), &options()),
        None
    );
}

#[test]
fn unsupported_shell_constructs_ask_in_generated_contexts() {
    let p = compiled(json!([{"action":"allow", "roots":["/"]}]));
    // Cartesian generation needs no property-test dependency or external shell.
    for construct in [
        "$PWD", "${PWD}", "$(pwd)", "$((1+1))", "`pwd`", "{a,b}", "(pwd)", "é", "\t", "\r",
        "\u{7f}",
    ] {
        for (prefix, suffix) in [
            ("echo ", ""),
            ("echo '", "'"),
            ("echo \"", "\""),
            ("", " cat ./a"),
            ("cat x", "y"),
        ] {
            let command = format!("{prefix}{construct}{suffix}");
            assert_eq!(
                p.decide(&call("execute", &["."], &command), &options()),
                None,
                "{command:?}"
            );
        }
    }
    for command in [
        r"cat a\ b",
        r#"cat "a\b""#,
        "cat ~root/.profile",
        "cat '~root/.profile'",
        "FOO=~root make",
        "cat <<EOF\ntext\nEOF",
        "cat <<<word",
        "cat <(pwd)",
        "cat >(pwd)",
        "eval 'cat ./a'",
        "exec cat ./a",
        "source ./script",
        ". ./script",
        "(cat ./a)",
        "{ cat ./a; }",
        "if true; then cat ./a; fi",
        "for x in a; do cat ./a; done",
        "sh -c 'cat ./a'",
        "/bin/bash ./script",
        "cat ./a &",
        "cat ./a # ignored",
        "cat ./a 2>/tmp/out",
        "cat ./a >&2",
        "cat ./a <>/tmp/out",
        "cat 'unfinished",
        "cat \"unfinished",
        "cat 'a\nb'",
        "cat &&",
        "cat |",
        "cat >",
        "cat ; ; ls",
    ] {
        assert_eq!(
            p.decide(&call("execute", &["."], command), &options()),
            None,
            "{command:?}"
        );
    }
}

#[test]
fn command_evidence_uses_raw_input_and_never_title_or_a_non_execute_kind() {
    let p = compiled(json!([{"action":"allow", "roots":["$cwd"]}]));
    let mut execute = call("execute", &["."], "cat ./README");
    execute["title"] = json!("cat /etc/passwd");
    assert!(p.decide(&execute, &options()).is_some());
    execute["rawInput"]["command"] = json!("cat ../../../etc/passwd");
    execute["title"] = json!("cat ./README");
    assert_eq!(p.decide(&execute, &options()), None);
    for kind in ["read", "edit", "fetch", "future-kind"] {
        for command in [json!("cat ./README"), json!(""), json!(null), json!(42)] {
            let mut tool = call(kind, &["README"], "");
            tool["rawInput"] = json!({"command": command});
            assert_eq!(p.decide(&tool, &options()), None, "{tool}");
        }
        assert!(p.decide(&call(kind, &["README"], ""), &options()).is_some());
    }
}

#[test]
fn command_and_path_work_bounds_ask_without_losing_boundary_cases() {
    let p = compiled(json!([{"action":"allow", "roots":["$cwd", "/tmp"]}]));
    let command = format!("echo {}", "a".repeat(POLICY_COMMAND_MAX - 5));
    assert!(
        p.decide(&call("execute", &["."], &command), &options())
            .is_some()
    );
    assert_eq!(
        p.decide(&call("execute", &["."], &(command + "a")), &options()),
        None
    );
    let command = vec!["x"; POLICY_COMMAND_WORDS_MAX].join(" ");
    assert!(
        p.decide(&call("execute", &["."], &command), &options())
            .is_some()
    );
    assert_eq!(
        p.decide(&call("execute", &["."], &(command + " x")), &options()),
        None
    );
    let paths = vec!["/tmp/a"; POLICY_PATHS_MAX - 1];
    assert!(
        p.decide(&call("execute", &paths, "cat /tmp/x"), &options())
            .is_some()
    );
    assert_eq!(
        p.decide(&call("execute", &paths, "cat /tmp/x /tmp/y"), &options()),
        None
    );
    let mut paths = vec!["/tmp/a"; POLICY_PATHS_MAX];
    assert!(p.decide(&call("read", &paths, ""), &options()).is_some());
    paths.push("/tmp/a");
    assert_eq!(p.decide(&call("read", &paths, ""), &options()), None);
    let huge = format!("/tmp/{}", "x".repeat(POLICY_PATH_BYTES_MAX));
    assert_eq!(p.decide(&call("read", &[&huge], ""), &options()), None);
    assert!(
        p.decide(
            &call("execute", &["."], "cd a; cd b; cd c; cd d; cd e"),
            &options()
        )
        .is_some()
    );
    assert_eq!(
        p.decide(
            &call("execute", &["."], "cd a; cd b; cd c; cd d; cd e; cd f"),
            &options()
        ),
        None
    );
}

#[test]
fn aggregate_root_comparisons_are_bounded_and_duplicate_paths_are_checked_once() {
    let mut roots: Vec<String> = (0..62).map(|i| format!("/unused/{i}")).collect();
    roots.extend(["$cwd".into(), "/tmp".into()]);
    let mut rules = vec![json!({"action":"allow", "roots":roots}); POLICY_RULES_MAX - 1];
    rules.push(json!({"action":"allow"}));
    let p = compiled(json!(rules));
    let repeated = format!("cat {} /zzz", vec!["/tmp/x"; 1000].join(" "));
    assert!(
        p.decide(&call("execute", &["."], &repeated), &options())
            .is_some()
    );
    let varied = format!(
        "cat {} /zzz",
        (0..1000)
            .map(|i| format!("/tmp/x{i}"))
            .collect::<Vec<_>>()
            .join(" ")
    );
    assert_eq!(
        p.decide(&call("execute", &["."], &varied), &options()),
        None
    );
    let reported = format!("cat {}/etc/passwd", "/tmp/x ".repeat(2_000_000));
    assert_eq!(
        p.decide(&call("execute", &["."], &reported), &options()),
        None
    );
}

#[test]
fn regex_conditions_match_raw_command_not_joined_words() {
    let p = compiled(json!([{
        "action":"allow", "roots":["$cwd"], "command":{"matches":["^cat '"]}
    }]));
    assert!(
        p.decide(&call("execute", &["."], "cat './src/'file"), &options())
            .is_some()
    );
    assert_eq!(
        p.decide(&call("execute", &["."], "cat ./src/file"), &options()),
        None
    );
    let p = compiled(json!([{
        "action":"allow", "roots":["$cwd"], "command":{"notMatches":["'"]}
    }]));
    assert_eq!(
        p.decide(&call("execute", &["."], "cat './src/'file"), &options()),
        None
    );
}

#[test]
fn second_review_shell_semantics_bypasses_ask() {
    let mut allowed = Vec::new();
    for (cwd, command) in [
        ("/work/project", "trap 'cat /etc/passwd' EXIT"),
        ("/work/project", "X+=y eval 'cat /etc/passwd'"),
        ("/work/project", "cd missing && >out; cat ../secret"),
        ("/work/project", "cd missing && >out\ncat ../secret"),
        ("/work/project", "alias c='cd ..'\nc"),
        (
            "/work/project",
            "shopt -s expand_aliases\nalias c='cd ..'\nc",
        ),
        ("/home/u/proj", "export CDPATH=/tmp; cd x && cd ../../proj"),
        ("/work/project", "env sh -c 'cat /etc/passwd'"),
        ("/work/project", "nice sh -c 'cat /etc/passwd'"),
        ("/work/project", "timeout 1 sh -c 'cat /etc/passwd'"),
        ("/work/project", "nohup sh -c 'cat /etc/passwd'"),
        ("/work/project", "printf x | xargs sh -c 'cat /etc/passwd'"),
        ("/work/project", "busybox sh -c 'cat /etc/passwd'"),
        ("/work/project", "cat /tmp/.[.]/etc/passwd"),
        (
            "/work/project",
            "shopt -u globskipdots; cat /tmp/.[.]/etc/passwd",
        ),
        ("/work/project", "/bin/s[h] -c 'cat /etc/passwd'"),
    ] {
        let p = CompiledPolicy::new(
            &policy(json!([{"action":"allow", "roots":["$cwd", "/tmp", "/bin"]}])),
            cwd,
        )
        .unwrap();
        if p.decide(&call("execute", &["."], command), &options())
            .is_some()
        {
            allowed.push(command);
        }
    }
    assert!(allowed.is_empty(), "unintended allows: {allowed:?}");
}

#[test]
fn overlapping_delimiter_fragments_exhaust_work_before_set_insertion() {
    let p = compiled(json!([{"action":"allow", "roots":["$cwd"]}]));
    let command = "echo ".to_owned() + &"a".repeat(63_530) + &",x".repeat(1_000);
    assert_eq!(command.len(), POLICY_COMMAND_MAX - 1);
    assert_eq!(
        p.decide(&call("execute", &["."], &command), &options()),
        None
    );
}

#[test]
fn delimiter_fragments_do_not_replace_the_whole_path() {
    let p = CompiledPolicy::new(
        &policy(json!([{"action":"allow", "roots":["$cwd", "/tmp"]}])),
        "/home/u/proj",
    )
    .unwrap();
    for delimiter in ['=', ':', ','] {
        // Each delimiter piece is inside a root; only the whole word escapes.
        let command = format!("cat /tmp/p{delimiter}q/../../proj/secret");
        assert_eq!(
            p.decide(&call("execute", &["."], &command), &options()),
            None,
            "{command}"
        );
    }
}

#[test]
fn assignment_prefixes_cannot_hide_commands_or_change_shell_resolution() {
    let p = compiled(json!([{"action":"allow", "roots":["/"]}]));
    for prefix in ["X+=y", "a[0]=b", "1X=y", "=y", "a-b=c"] {
        for suffix in ["eval 'cat /etc/passwd'", "cd x", ""] {
            let command = format!("{prefix} {suffix}");
            assert_eq!(
                p.decide(&call("execute", &["."], &command), &options()),
                None,
                "{command}"
            );
        }
    }
    for variable in [
        "CDPATH",
        "PATH",
        "IFS",
        "ENV",
        "BASH_ENV",
        "HOME",
        "PWD",
        "OLDPWD",
        "SHELLOPTS",
        "BASHOPTS",
        "GLOBIGNORE",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "LD_AUDIT",
    ] {
        let command = format!("{variable}=local cargo test");
        assert_eq!(
            p.decide(&call("execute", &["."], &command), &options()),
            None,
            "{command}"
        );
    }
    for command in [
        ">out",
        ">out; cat file",
        ">out\ncat file",
        "cat file && >out; cat file",
        "declare CDPATH=/tmp; cd x",
        "set -f; ls src/*.rs",
        "unset CDPATH; cd x",
        "read CDPATH; cd x",
        "printf -v CDPATH /tmp; cd x",
        "printf -vCDPATH /tmp; cd x",
        "printf '%n' CDPATH; cd x",
        "printf -- '%03n' CDPATH; cd x",
        "test -v 'BASH_VERSINFO[CDPATH=3]'; cd x",
        "test ! -v 'BASH_VERSINFO[CDPATH=3]'; cd x",
        "enable -n cd; cd x",
    ] {
        assert_eq!(
            p.decide(&call("execute", &["."], command), &options()),
            None,
            "{command}"
        );
    }
    for command in [
        "_X1=y A= B=c=d cargo test",
        "echo hello",
        "printf '%s' hello",
        "printf '%%n %03d %s' 1 hello",
        "printf -- '%s' hello",
        "true",
        "false",
        "test -f ./file",
        "pwd",
    ] {
        assert!(
            p.decide(&call("execute", &["."], command), &options())
                .is_some(),
            "{command}"
        );
    }
}

#[test]
fn glob_components_cannot_expand_to_parents_or_hide_the_command() {
    let p = compiled(json!([{"action":"allow", "roots":["/"]}]));
    for command in [
        "c?t file",
        "c* file",
        "'c[a]t' file",
        "[ -f file ]",
        "cat .*/file",
        "cat /tmp/[.]/etc/passwd",
        "cat /tmp/.[.]/etc/passwd",
        "cat /tmp/[a-z]/file",
        "cat --file=/tmp/..?/*",
        "cat file >/tmp/.[.]/out",
    ] {
        assert_eq!(
            p.decide(&call("execute", &["."], command), &options()),
            None,
            "{command}"
        );
    }
    for command in [
        "ls src/*.rs",
        "ls src/a?/*.rs",
        "ls src/a[bc].rs",
        "ls src/x*/../file",
    ] {
        assert!(
            p.decide(&call("execute", &["."], command), &options())
                .is_some(),
            "{command}"
        );
    }
}

#[test]
fn programs_select_every_simple_command_without_interpreting_its_arguments() {
    let p = compiled(json!([{
        "action":"allow", "roots":["$cwd", "/tmp"],
        "programs":["cargo", "cd", "git", "ls", "cat", "grep", "head", "make", "nix"]
    }]));
    for command in [
        "cargo test -p x",
        "cd crates/a && cargo fmt",
        "git -C sub status",
        "ls ./src",
        "nix build .#checks.x86_64-linux.fmt --no-link",
        "FOO=bar make",
        "cat a/b.txt > /tmp/out.txt",
        "grep -n \"a b\" src/x.rs | head -5",
        "ls src/*.rs",
        // Program-specific options remain the rule author's responsibility.
        "git -C.. status",
        "make -o/etc/x",
        "cat @file",
    ] {
        assert!(
            p.decide(&call("execute", &["."], command), &options())
                .is_some(),
            "{command}"
        );
    }
    for command in [
        "cargo test | tail -5",
        "cargo test && tail log",
        "tail log || cargo test",
        "cargo test; tail log",
        "CC=cc tail log",
        "/bin/cat file",
        "./cargo test",
        "find . -exec cat file",
        "python -c 'print 1'",
    ] {
        assert_eq!(
            p.decide(&call("execute", &["."], command), &options()),
            None,
            "{command}"
        );
    }
    let p = compiled(json!([{"action":"allow", "programs":[]}]));
    assert_eq!(
        p.decide(&call("execute", &["."], "cargo test"), &options()),
        None
    );
    assert!(p.decide(&call("read", &["."], ""), &options()).is_some());
    let p = compiled(json!([
        {"action":"allow", "programs":["cargo"]},
        {"action":"reject", "programs":["cat"]},
    ]));
    let decision = p
        .decide(&call("execute", &["."], "cat file"), &options())
        .unwrap();
    assert_eq!((decision.rule, decision.action), (1, Action::Reject));
}

#[test]
fn program_paths_are_normalized_not_matched_by_basename() {
    let p = compiled(json!([{
        "action":"allow", "roots":["$cwd", "/bin"], "programs":["./tools/../bin/tool", "/bin/./cat", "cd"]
    }]));
    for command in [
        "./bin/tool file",
        "/work/project/bin/tool file",
        "/bin/../bin/cat file",
        "cd crates && ../bin/tool file",
        "FOO=bar ./bin/tool file",
    ] {
        assert!(
            p.decide(&call("execute", &["."], command), &options())
                .is_some(),
            "{command}"
        );
    }
    for command in [
        "tool file",
        "cat file",
        "./other/tool file",
        "cd crates; ../bin/tool file",
        "cd crates && ./bin/tool file",
    ] {
        assert_eq!(
            p.decide(&call("execute", &["."], command), &options()),
            None,
            "{command}"
        );
    }
}

#[test]
fn programs_validate_names_and_byte_bounds_before_compilation() {
    for programs in [
        json!(null),
        json!("cargo"),
        json!([1]),
        json!([""]),
        json!(["cargo test"]),
        json!(["a\tb"]),
        json!(["a\nb"]),
        json!(["a\u{a0}b"]),
        json!(["a\0b"]),
        json!(["x".repeat(POLICY_PROGRAM_MAX + 1)]),
        json!(vec!["cargo"; POLICY_SELECTORS_MAX + 1]),
    ] {
        let wire = json!({"rules":[{"action":"allow", "programs":programs}]});
        if let Ok(p) = serde_json::from_value::<Policy>(wire) {
            assert!(p.validate().is_err(), "{programs}");
            assert!(
                CompiledPolicy::new(&p, "/work/project").is_err(),
                "{programs}"
            );
        }
    }
    let p =
        policy(json!([{"action":"allow", "programs":["x", "é".repeat(POLICY_PROGRAM_MAX / 2)]}]));
    assert!(p.validate().is_ok());
    assert!(CompiledPolicy::new(&p, "/work/project").is_ok());
}

#[test]
fn third_review_printf_formats_ask_with_and_without_programs() {
    for programs in [
        None,
        Some(json!([
            "cargo", "git", "ls", "cat", "grep", "head", "echo", "printf", "cd"
        ])),
    ] {
        let mut rule = json!({"action":"allow", "kinds":["execute"], "roots":["$cwd", "/tmp"]});
        if let Some(programs) = programs {
            rule["programs"] = programs;
        }
        let p = CompiledPolicy::new(&policy(json!([rule])), "/var/tmp/project").unwrap();
        let mut allowed = Vec::new();
        for format in [
            "%'n", "%#n", "%-5n", "%.3n", "%*n", "%ln", "%(s)T", "%", "%5%", "%*3d", "%1*d",
            "%..d", "%1.2.3d", "%Q",
        ] {
            let command = format!("printf \"{format}\" CDPATH; cd x && cd ../../../../tmp");
            if p.decide(&call("execute", &["."], &command), &options())
                .is_some()
            {
                allowed.push(command);
            }
        }
        assert!(allowed.is_empty(), "unintended allows: {allowed:?}");
    }
}

#[test]
fn quoted_assignment_names_and_equals_never_hide_the_command() {
    for programs in [None, Some(json!(["cargo", "echo"]))] {
        let mut rule = json!({"action":"allow", "roots":["$cwd", "/tmp"]});
        if let Some(programs) = programs {
            rule["programs"] = programs;
        }
        let p = compiled(json!([rule]));
        let mut allowed = Vec::new();
        for command in [
            "'X=bin/cargo' echo",
            "\"X\"=1 echo",
            "X'='1 echo",
            "X''=1 echo",
            "X\"\"=1 echo",
            "X=1 'Y=bin/cargo' echo",
        ] {
            if p.decide(&call("execute", &["."], command), &options())
                .is_some()
            {
                allowed.push(command);
            }
        }
        assert!(allowed.is_empty(), "unintended allows: {allowed:?}");
        for command in [
            "X='a b' echo ok",
            "X=\"a\" cargo test",
            "X='a=b' echo ok",
            "X=\"\" Y='a b' echo ok",
        ] {
            assert!(
                p.decide(&call("execute", &["."], command), &options())
                    .is_some(),
                "{command}"
            );
        }
    }
}

#[test]
fn known_printf_format_grammar_keeps_literal_and_printing_conversions() {
    let p = compiled(json!([{"action":"allow", "roots":["$cwd"], "programs":["printf"]}]));
    for conversion in "diouxXeEfFgGaAcsbq".chars() {
        for specifier in [
            format!("%{conversion}"),
            format!("%-+#0'12.3{conversion}"),
            format!("% *.*{conversion}"),
            format!("%.0{conversion}"),
        ] {
            let command = format!("printf \"{specifier}\" 1 2 3");
            assert!(
                p.decide(&call("execute", &["."], &command), &options())
                    .is_some(),
                "{command}"
            );
        }
    }
    for command in [
        "printf '%%n %s' hello",
        "printf -- '%s' hello",
        "printf 'plain text'",
        "printf '%.s' hello",
    ] {
        assert!(
            p.decide(&call("execute", &["."], command), &options())
                .is_some(),
            "{command}"
        );
    }
}
