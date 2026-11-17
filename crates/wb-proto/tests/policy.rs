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
    json!({
        "toolCallId": "call-1", "title": "A tool request", "kind": kind,
        "locations": paths.iter().map(|path| json!({"path": path})).collect::<Vec<_>>(),
        "rawInput": {"command": command}
    })
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
    for field in ["kinds", "roots", "command"] {
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
    for field in ["roots", "kinds"] {
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
fn command_absolute_paths_are_checked_at_text_boundaries() {
    let p = compiled(json!([{"action":"allow", "roots":["$cwd", "/tmp"]}]));
    for command in [
        "cat /work/project/file",
        "cat '/work/project/file'",
        "cat \"/tmp/file\"",
        "cat /tmp/a;/work/project/bin",
        "cat --file=/tmp/file",
        "echo /tmp/./a",
        "cat '/work/project/a b'",
        "sh -c 'cat /tmp/a /work/project/b'",
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
        "echo [/etc/passwd]",
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
        "cat /tmp/a'other'",
        "cat '/tmp/a'other",
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
