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

fn design_policies() -> impl Iterator<Item = Policy> {
    serde_json::from_str::<Vec<Policy>>(include_str!("fixtures/design-policies.json"))
        .expect("DESIGN policy fixture must deserialize")
        .into_iter()
}

fn design_example() -> CompiledPolicy {
    let policy = design_policies().next().expect("DESIGN policy example");
    policy.validate().unwrap();
    CompiledPolicy::new(&policy, "/work/project", true).unwrap()
}

#[test]
fn documented_policy_examples_validate() {
    for policy in design_policies() {
        policy.validate().unwrap();
    }
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
        "./local://x",
        "sub/local://",
        "/work/project/local://notes",
        "./file:sub",
        "sub/a:b",
        "1:sub",
        "-a:sub",
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
    for cwd in [".", "sub", "/tmp/plain dir"] {
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
fn hoisted_cd_expanders_ask_after_quote_removal_with_or_without_roots() {
    for rule in [
        json!({"action":"allow", "kinds":["execute"], "roots":["$cwd"], "programs":["cat","cd"]}),
        json!({"action":"allow", "roots":["$cwd"]}),
        json!({"action":"allow"}),
    ] {
        let p = compiled(json!([rule]));
        for command in [
            "cd file:///work/project/%2e%2e/%2e%2e/etc && cat passwd",
            "cd file:///work/project/%2e%2e/%2e%2e/etc; cat passwd",
            "cd FiLe:///work/project/.%2E/.%2E/etc && cat passwd",
            "cd 'file:///work/project/%2e%2e/%2e%2e/home/u/.ssh' && cat id_rsa",
            "cd fi\"\"le:///work/project/%2e%2e/%2e%2e/etc && cat passwd",
            "cd :./ && cat ../secret",
            "cd ':./' && cat ../secret",
            "cd :./sub && cat ../../secret",
            "cd sub/plain:dir && cat x",
            "cd 'sub/plain:dir'; cat x",
        ] {
            assert_eq!(action(&p, json!({"command":command})), None, "{command}");
        }
        assert_eq!(
            action(&p, json!({"command":"cd sub && cat x"})),
            Some(Action::Allow)
        );
    }
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
        "git >o >>p <q reset --hard",
        ">o git reset --hard",
        ">o git <q >>p reset --hard",
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
            ">x rm >y -rf sub",
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
fn only_agents_known_to_reset_cwd_receive_execute_decisions() {
    for action_name in ["allow", "reject"] {
        let rules = policy(json!([{"action":action_name, "roots":["$cwd"]}]));
        let persistent = CompiledPolicy::new(&rules, "/work/project", false).unwrap();
        let resetting = CompiledPolicy::new(&rules, "/work/project", true).unwrap();
        let expected = if action_name == "allow" {
            Action::Allow
        } else {
            Action::Reject
        };
        for command in [
            "make",
            "cat sub/x",
            "rm -rf build",
            "cd sub && make",
            "cd sub; make",
            "cd sub || make",
            "cd sub",
            "cd sub && cd ..",
            "cd sub && cd /work/project",
            "make && cd sub",
            "make || cd sub",
            "make; cd sub",
            "true\ncd sub",
            "cd sub/deep/..",
            "cd ./sub",
            "cd /work/project/sub",
            "cd . && make",
            "cd ./ && make",
            "cd sub/.. && make",
            "cd /work/project && make",
            "cd //work/project && make",
            "cd sub/../. ; make",
        ] {
            assert_eq!(
                action(&persistent, json!({"command":command})),
                None,
                "{command}"
            );
            assert_eq!(
                action(&resetting, json!({"command":command})),
                Some(expected),
                "{command}"
            );
        }
        for command in ["cd .. && make", "cd . && make"] {
            let input = json!({"command":command, "cwd":"/work/project/sub"});
            assert_eq!(action(&persistent, input.clone()), None);
            assert_eq!(action(&resetting, input), Some(expected));
        }
        for kind in ["read", "edit"] {
            let call = json!({"toolCallId":"c", "title":"t", "kind":kind,
                "locations":[{"path":"sub/x"}]});
            assert_eq!(
                persistent.decide(&call, &options()).unwrap().action,
                expected
            );
        }
    }
}

#[test]
fn serialized_policy_size_is_bounded_including_json_escaping() {
    let largest = policy(json!(vec![
        json!({"action":"allow", "roots":vec![format!("/{}", "r".repeat(4095));64]});
        64
    ]));
    assert!(largest.validate().is_err());
    assert!(CompiledPolicy::new(&largest, "/work/project", true).is_err());
    let mut boundary = policy(json!([
        {"action":"allow", "roots":vec![format!("/{}", "r".repeat(4000));64]},
        {"action":"allow", "roots":["/","/"]}
    ]));
    let mut spare = POLICY_MAX - serde_json::to_vec(&boundary).unwrap().len();
    for root in boundary.rules[1].roots.as_mut().unwrap() {
        let n = spare.min(POLICY_ROOT_MAX - root.len());
        root.push_str(&"r".repeat(n));
        spare -= n;
    }
    assert_eq!(spare, 0);
    assert_eq!(serde_json::to_vec(&boundary).unwrap().len(), POLICY_MAX);
    assert!(boundary.validate().is_ok());
    assert!(CompiledPolicy::new(&boundary, "/work/project", true).is_ok());
    boundary.rules[1]
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
fn canonical_words_precede_redirects_across_operators() {
    for (pattern, command) in [
        (r"^git push origin > /tmp/o$", "git >/tmp/o push origin"),
        (r"^git push > a >> b < c$", "git >a push >>b <c"),
        (r"^a b > x ; c d < y$", ">x a b; <y c d"),
        (r"^a > x \| b >> y && c$", "a>x|b>>y&&c"),
        (r"^A=1 git push > o$", "A=1 >o git push"),
        (r"^echo > x$", "echo '>' x"),
    ] {
        let p = compiled(json!([
            {"action":"reject", "command":{"matches":[pattern]}},
            {"action":"allow", "roots":["$cwd","/tmp"]}
        ]));
        assert_eq!(
            action(&p, json!({"command":command})),
            Some(Action::Reject),
            "{command}"
        );
    }
    let p = compiled(json!([
        {"action":"reject", "command":{"matches":["git"]}},
        {"action":"allow", "roots":["$cwd"]}
    ]));
    for command in [
        "git push 2>&1",
        "git push >&2",
        "git push &>o",
        "git push <&-",
        "git push >|o",
        "git push 2>o",
        "git push <<EOF",
        "git push <<<x",
        "git push <>o",
        "git push > >o",
        "cat < <x",
    ] {
        assert_eq!(action(&p, json!({"command":command})), None, "{command}");
    }
}

#[test]
fn ordinary_patterns_and_the_round_one_compile_attack_respect_the_limit() {
    for pattern in [
        r"\bgit\s+push\b",
        r"\w",
        r"\w+",
        r"[[:alpha:]]+",
        r"\p{L}+",
        r"(?-u)\w+\s+\w+",
        r"(?-u)\w{120}",
        r"(?-u:\w+\s+\w+)",
        r"[A-Za-z0-9_]+\s+[A-Za-z0-9_]+",
        r"a[a-z]{906}0",
    ] {
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
fn oversized_unicode_patterns_explain_the_ascii_alternatives() {
    for pattern in [
        r"\w+\s+\w+",
        r"\w{20}",
        r"\d{3,40}",
        r"\S{1,64}",
        r".{0,500}rm",
        r"[\w.-]{1,64}",
        r"\b\w+\b.*\b\w+\b",
        r"(\w+\s+){3}\w+",
    ] {
        let p = policy(json!([{"action":"allow", "command":{"matches":[pattern]}}]));
        let error = p.validate().unwrap_err();
        for hint in ["Unicode", "[A-Za-z0-9_]", r"[ \t]", "(?-u:"] {
            assert!(error.contains(hint), "{pattern}: {error}");
        }
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

#[test]
fn reviewer_128_pattern_policy_respects_the_decision_budget() {
    let p = cost_policy(&vec!["a[a-z]{906}0".to_owned(); 128]);
    p.validate().unwrap();
    let p = CompiledPolicy::new(&p, "/work/project", true).unwrap();
    for size in [8 * 1024, 64 * 1024] {
        let command = format!("echo {}", "a".repeat(size - 5));
        let call = execute(json!({"command":command}), false);
        let opts = options();
        let start = Instant::now();
        let decision = p.decide(&call, &opts);
        let elapsed = start.elapsed();
        assert!(elapsed < Duration::from_secs(1), "{size}: {elapsed:?}");
        if size > POLICY_REGEX_COMMAND_MAX {
            assert_eq!(decision, None);
        }
        println!("128 patterns, {size} bytes: {decision:?}, {elapsed:?}");
    }
}
