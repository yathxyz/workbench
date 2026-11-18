//! Independent PR 58 review cases, with fail-closed expectations.
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use wb_proto::limits::*;
use wb_proto::policy::*;

fn options() -> Vec<Value> {
    vec![
        json!({"optionId":"always", "name":"Always", "kind":"allow_always"}),
        json!({"optionId":"yes", "name":"Allow", "kind":"allow_once"}),
        json!({"optionId":"no", "name":"Reject", "kind":"reject_once"}),
    ]
}

fn policy(rules: Value) -> Policy {
    serde_json::from_value(json!({"rules":rules})).unwrap()
}

fn compiled(rules: Value) -> CompiledPolicy {
    let policy = policy(rules);
    policy.validate().unwrap();
    CompiledPolicy::new(&policy, "/work/project", true).unwrap()
}

fn execute(input: Value, locations: bool) -> Value {
    json!({"toolCallId":"c", "title":"t", "kind":"execute",
        "locations":if locations {json!([{"path":"/work/project"}])} else {json!([])},
        "rawInput":input})
}

fn action(policy: &CompiledPolicy, input: Value) -> Option<Action> {
    policy
        .decide(&execute(input, false), &options())
        .map(|d| d.action)
}

fn design_example() -> CompiledPolicy {
    compiled(json!([{"action":"allow", "kinds":["read","edit","execute"],
        "roots":["$cwd","/nix/store","/tmp"],
        "programs":["cargo","nix","git","ls","cat","grep","rg","sed","head","tail","wc","node"],
        "command":{"notMatches":["sudo","git\\s+(push|tag|remote|config|reset|clean|checkout|switch|branch|rebase|merge|stash|worktree)","gh ","systemctl","ssh","scp","curl","wget","nc","kill","pkill","secrets","sops","~/","\\$HOME"]}}]))
}

#[test]
fn agent_path_expansion_is_not_a_plain_working_directory() {
    let p = compiled(json!([{"action":"allow", "kinds":["execute"],
        "roots":["$cwd"], "programs":["cat","cd"]}]));
    for input in [
        json!({"command":"cat .ssh/id_rsa", "cwd":"~"}),
        json!({"command":"cat id_rsa", "cwd":"~/.ssh"}),
        json!({"command":"cat passwd", "cwd":"@/etc"}),
        json!({"command":"cat id_rsa", "cwd":"@~/.ssh"}),
        json!({"command":"cat passwd", "cwd":":/etc"}),
        json!({"command":"cat secret", "cwd":":../"}),
        json!({"command":"cat passwd", "cwd":"file:///etc"}),
        json!({"command":"cd @/etc && cat passwd"}),
        json!({"command":"cd @/etc; cat passwd"}),
        json!({"command":"cd @~ && cat .ssh/id_rsa"}),
        json!({"command":"cat passwd", "cwd":"/etc"}),
        json!({"command":"cd /etc && cat passwd"}),
        json!({"command":"cd ~ && cat .ssh/id_rsa"}),
    ] {
        assert_eq!(action(&p, input.clone()), None, "{input}");
    }
    // Syntax refusal is independent of containment, even when '/' is permitted.
    let p = compiled(json!([{"action":"allow", "roots":["/"]}]));
    for cwd in [
        "~",
        "@sub",
        ":sub",
        "file:sub",
        "HTTP://host/x",
        "a+1.2-3:sub",
        "c:\\tmp",
        "sub\t",
        "sub\n",
        "sub\r",
        "sub\u{7f}",
        "sub\0",
        "café",
        "sub\u{a0}dir",
    ] {
        assert_eq!(
            action(&p, json!({"command":"cat x", "cwd":cwd})),
            None,
            "{cwd:?}"
        );
    }
    for cwd in [
        ".",
        "sub",
        "./file:sub",
        "sub/a:b",
        "/tmp/plain dir",
        "1:sub",
        "-a:sub",
    ] {
        assert_eq!(
            action(&p, json!({"command":"cat x", "cwd":cwd})),
            Some(Action::Allow),
            "{cwd}"
        );
    }
    for command in ["cd @sub && cat x", "cd '@sub'; cat x", "cd café && cat x"] {
        assert_eq!(action(&p, json!({"command":command})), None, "{command}");
    }
    assert_eq!(
        action(&p, json!({"command":"cat @sub"})),
        Some(Action::Allow)
    );
}

#[test]
fn round_one_quote_cwd_and_builtin_cases_hold_for_both_request_shapes() {
    let design = design_example();
    for locations in [false, true] {
        let decide = |p: &CompiledPolicy, input| {
            p.decide(&execute(input, locations), &options())
                .map(|d| d.action)
        };
        assert_eq!(
            decide(&design, json!({"command":"git status"})),
            Some(Action::Allow)
        );
        for command in [
            "git push origin master",
            "git 'push' origin master",
            "git pu''sh origin master",
            "'git' push --force origin master",
            "git \"reset\" --hard",
            "git \"\"config core.pager x",
            "cat se''crets.txt",
            "git p\\ush",
            "git\tpush",
            "git \\\npush",
        ] {
            assert_eq!(
                decide(&design, json!({"command":command})),
                None,
                "{command}"
            );
        }
        let p = compiled(
            json!([{"action":"allow", "kinds":["execute"], "roots":["$cwd"],
            "programs":["cargo","nix","git","ls","cat","rg"]}]),
        );
        for input in [
            json!({"command":"cat id_rsa", "cwd":"/home/u/.ssh"}),
            json!({"command":"cat id_rsa", "cwd":"/home/u/.ssh", "pty":true,"async":true}),
            json!({"command":"cat x", "env":{"LD_PRELOAD":"/tmp/x.so"}}),
        ] {
            assert_eq!(decide(&p, input.clone()), None, "{input}");
        }
        assert_eq!(
            decide(&p, json!({"command":"cat x", "cwd":"sub"})),
            Some(Action::Allow)
        );
        let p = compiled(json!([{"action":"allow", "roots":["$cwd"]}]));
        for command in [
            "cd\ncat .ssh/id_rsa",
            "chdir\ncat .ssh/id_rsa",
            "chdir && true > .profile",
            "chdir sub",
            "'chdir'",
            "ch\\dir",
            "true; chdir",
            "true | chdir",
        ] {
            assert_eq!(decide(&p, json!({"command":command})), None, "{command}");
        }
    }
}

#[test]
fn redirects_cannot_hide_command_word_adjacency_from_patterns() {
    let design = design_example();
    for command in [
        "git push origin master",
        "git >/tmp/o push origin master",
        "git </tmp/i push origin master",
        "git >o reset --hard",
        "git >o pu''sh origin master",
    ] {
        assert_eq!(
            action(&design, json!({"command":command})),
            None,
            "{command}"
        );
    }
    let deny = compiled(json!([
        {"action":"reject", "kinds":["execute"], "command":{"matches":["rm\\s+-rf"]}},
        {"action":"allow", "kinds":["execute"], "roots":["$cwd"]}]));
    for locations in [false, true] {
        for command in [
            "rm -rf sub",
            "rm '-rf' sub",
            "r''m -rf sub",
            "rm >x -rf sub",
            "rm <x '-rf' sub",
        ] {
            assert_eq!(
                deny.decide(&execute(json!({"command":command}), locations), &options())
                    .unwrap()
                    .action,
                Action::Reject,
                "{command}"
            );
        }
        assert_eq!(
            deny.decide(
                &execute(json!({"command":"rm -r sub"}), locations),
                &options()
            )
            .unwrap()
            .action,
            Action::Allow
        );
    }
}

#[test]
fn an_assignment_after_a_leading_redirect_asks() {
    let p = compiled(json!([{"action":"allow", "kinds":["execute"],
        "roots":["$cwd"], "programs":["cat"]}]));
    for command in [
        "_=1 <b B=sub/x cat b",
        "<b B=sub/x cat b",
        "_=1 <b >o B=sub/x cat b",
        "A=x <b B='sub/x' cat b",
        "A=x >o B=x C=y cat b",
        "A=x <b 'B=sub/x' cat b",
    ] {
        assert_eq!(action(&p, json!({"command":command})), None, "{command}");
    }
    for command in [
        "_=1 B=sub/x <b cat b",
        "<b cat b",
        "_=1 <b cat B=sub/x",
        "cat <b B=sub/x",
        "cat B=sub/x >o",
    ] {
        assert_eq!(
            action(&p, json!({"command":command})),
            Some(Action::Allow),
            "{command}"
        );
    }
}

#[test]
fn a_persistent_shell_cannot_auto_change_its_top_level_directory() {
    let rules =
        policy(json!([{"action":"allow", "roots":["$cwd"], "programs":["cd","cat","false"]}]));
    let persistent = CompiledPolicy::new(&rules, "/work/project", false).unwrap();
    let resetting = CompiledPolicy::new(&rules, "/work/project", true).unwrap();
    for command in [
        "cd sub",
        "cd sub && cat x",
        "cd sub && cd ..",
        "false || cd sub",
        "cat x && cd sub",
    ] {
        assert_eq!(
            action(&persistent, json!({"command":command})),
            None,
            "{command}"
        );
        assert_eq!(
            action(&resetting, json!({"command":command})),
            Some(Action::Allow),
            "{command}"
        );
    }
    for command in [
        "cd . && cat x",
        "cd sub/..; cat x",
        "cd /work/project",
        "cat sub/x",
    ] {
        assert_eq!(
            action(&persistent, json!({"command":command})),
            Some(Action::Allow),
            "{command}"
        );
    }
    // Subshells remain unsupported syntax; no new grammar is implied by this guard.
    assert_eq!(action(&persistent, json!({"command":"(cd sub)"})), None);
    let rules =
        policy(json!([{"action":"allow", "roots":["/a/c/d","/a/x"], "programs":["cd","cat"]}]));
    let p = CompiledPolicy::new(&rules, "/a/c", false).unwrap();
    assert_eq!(action(&p, json!({"command":"cd d"})), None);
    assert_eq!(action(&p, json!({"command":"cat ../x/f"})), None);
    // The review's exact roots also exclude the starting cwd, independently of cd.
    let p = CompiledPolicy::new(&rules, "/a/c", true).unwrap();
    assert_eq!(action(&p, json!({"command":"cd d"})), None);
}

#[test]
fn serialized_policy_size_is_bounded_including_json_escaping() {
    let largest = policy(json!(vec![
        json!({"action":"allow", "roots":vec![format!("/{}", "r".repeat(4095));64]});
        64
    ]));
    assert!(largest.validate().is_err());
    assert!(CompiledPolicy::new(&largest, "/work/project", true).is_err());
    let mut boundary =
        policy(json!([{"action":"allow", "roots":vec![format!("/{}", "r".repeat(4089));64]}]));
    let mut spare = POLICY_MAX - serde_json::to_vec(&boundary).unwrap().len();
    for root in boundary.rules[0].roots.as_mut().unwrap() {
        let n = spare.min(POLICY_ROOT_MAX - root.len());
        root.push_str(&"r".repeat(n));
        spare -= n;
    }
    assert_eq!(spare, 0);
    assert_eq!(serde_json::to_vec(&boundary).unwrap().len(), POLICY_MAX);
    assert!(boundary.validate().is_ok());
    assert!(CompiledPolicy::new(&boundary, "/work/project", true).is_ok());
    boundary.rules[0]
        .roots
        .as_mut()
        .unwrap()
        .iter_mut()
        .find(|r| r.len() < POLICY_ROOT_MAX)
        .unwrap()
        .push('r');
    assert_eq!(serde_json::to_vec(&boundary).unwrap().len(), POLICY_MAX + 1);
    assert!(boundary.validate().is_err());
    assert!(CompiledPolicy::new(&boundary, "/work/project", true).is_err());
    let escaped =
        policy(json!([{"action":"allow", "roots":vec![format!("/{}", "\\".repeat(3000));64]}]));
    assert!(escaped.validate().is_err());
    let utf8 =
        policy(json!([{"action":"allow", "roots":vec![format!("/{}", "é".repeat(2047));64]}]));
    assert!(utf8.validate().is_err());
}

#[test]
fn ordinary_patterns_and_the_round_one_compile_attack_respect_the_limit() {
    for pattern in [r"\bgit\s+push\b", r"\w+", r"[[:alpha:]]+", r"\p{L}+"] {
        let p = policy(json!([{"action":"allow", "command":{"matches":[pattern]}}]));
        assert!(p.validate().is_ok(), "{pattern}");
        assert!(
            CompiledPolicy::new(&p, "/work/project", true).is_ok(),
            "{pattern}"
        );
    }
    let patterns: Vec<_> = (0..128).map(|i| format!("\\w{{120}}x{i}")).collect();
    assert!(
        policy(json!([{"action":"allow", "command":{"notMatches":patterns}}]))
            .validate()
            .is_err()
    );
    for pattern in ["a[a-z]{3637}0", "[ab]*a[ab]{3635}c"] {
        assert!(
            policy(json!([{"action":"allow", "command":{"notMatches":[pattern]}}]))
                .validate()
                .is_err()
        );
    }
}

#[test]
fn oversized_regex_input_asks_at_the_reached_rule_without_fallthrough() {
    let short = format!("echo {}", "a".repeat(POLICY_REGEX_COMMAND_MAX - 5));
    let long = format!("{short}a");
    let p = compiled(json!([{"action":"allow", "command":{"matches":["^echo "]}}]));
    assert_eq!(action(&p, json!({"command":short})), Some(Action::Allow));
    for act in ["allow", "reject", "ask"] {
        for field in ["matches", "notMatches"] {
            let mut rule = json!({"action":act, "command":{}});
            rule["command"][field] = json!(["never"]);
            let p = compiled(json!([rule, {"action":"allow"}]));
            assert_eq!(action(&p, json!({"command":long})), None, "{act} {field}");
        }
    }
    for first in [
        json!({"action":"allow"}),
        json!({"action":"allow", "command":{}}),
        json!({"action":"reject", "kinds":["read"], "command":{"matches":["x"]}}),
        json!({"action":"reject", "programs":["git"], "command":{"matches":["x"]}}),
        json!({"action":"reject", "roots":["/elsewhere"], "command":{"matches":["x"]}}),
    ] {
        let p = compiled(json!([first, {"action":"allow"}]));
        assert_eq!(action(&p, json!({"command":long})), Some(Action::Allow));
    }
}

fn cost_policy(patterns: &[String]) -> Policy {
    policy(json!([{"action":"allow", "kinds":["execute"], "command":{"notMatches":patterns}}]))
}

fn cost_pattern(family: usize, n: usize) -> String {
    match family {
        0 => format!("[a-z]{{{n}}}0"),
        1 => format!("(?-u)\\w{{{n}}}!"),
        2 => format!("a[a-z]{{{n}}}0"),
        3 => format!("[ab]*a[ab]{{{n}}}c"),
        4 => format!("(a?){{{n}}}a{{{n}}}0"),
        5 => format!("(\\S+ ){{{n}}}0"),
        _ => unreachable!(),
    }
}

#[test]
fn reviewer_cost_families_ask_on_64_kib_without_running_patterns() {
    for (family, hay) in ["a", "a", "a", "ab", "a", "a "].into_iter().enumerate() {
        let (mut low, mut high) = (1, 100_000);
        while low + 1 < high {
            let mid = (low + high) / 2;
            if cost_policy(&[cost_pattern(family, mid)]).validate().is_ok() {
                low = mid;
            } else {
                high = mid;
            }
        }
        let pattern = cost_pattern(family, low);
        let p = cost_policy(&vec![pattern.clone(); 128]);
        p.validate().unwrap();
        let compiled = CompiledPolicy::new(&p, "/work/project", true).unwrap();
        let command = format!("echo {}", hay.repeat((64 * 1024 - 5) / hay.len()));
        let call = execute(json!({"command":command}), false);
        let opts = options();
        let start = Instant::now();
        assert_eq!(compiled.decide(&call, &opts), None);
        let elapsed = start.elapsed();
        assert!(elapsed < Duration::from_secs(1), "{pattern}: {elapsed:?}");
        println!("family={family} largest={low} pattern={pattern:?} 64KiB decide={elapsed:?}");
    }
}
