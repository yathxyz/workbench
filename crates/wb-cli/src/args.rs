//! The argv grammar of `wb` (spec §13.1, DESIGN §3.7.4). Usage errors exit 2.

use std::path::PathBuf;

use serde_json::{Map, Value};

/// The usage text printed on a grammar error.
pub const USAGE: &str = "usage: wb buf ls [--json]
       wb buf read NAME [--lines A:B] [--ver] [--json]
       wb buf write NAME --append|--replace [FILE|-] [--create] [--json]
       wb buf write NAME --patch FILE|- [--base VER] [--create] [--json]
       wb buf save NAME [--json]
       wb buf revert NAME [--json]
       wb eval FORM | -f FILE [--json]
       wb edit FILE [+LINE] [--wait] [--json]
       wb repl [--json]
       wb tools [--socket PATH]
       wb TOOL [--json INPUT] [KEY=VALUE]... [KEY:=JSON]... [--timeout SECS] [--socket PATH]
       wb desk ls | go N | send N [PATH]... [--keep] [--follow] [--timeout SECS] [--socket PATH]
";

/// Board tools that `wb` does not run (W-14): hosts, units and tmux.
pub const DROPPED_TOOLS: &[&str] = &[
    "list_hosts",
    "host_folder",
    "host_status",
    "unit_control",
    "list_tmux",
    "adopt_tmux",
];

/// Command words, which are never tool names.
const COMMANDS: &[&str] = &["buf", "eval", "edit", "repl", "tools", "desk"];

/// True when `name` matches `^[a-z][a-z0-9_]*$`.
pub fn is_tool_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// A grammar error: the message, or empty when the usage text alone says enough.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Usage(pub String);

fn usage(msg: impl Into<String>) -> Usage {
    Usage(msg.into())
}

/// A parsed command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Args {
    pub cmd: Command,
    /// `--json`: one JSON object per result on stdout.
    pub json: bool,
}

/// Where the text of a write or a patch comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Input {
    Stdin,
    File(PathBuf),
}

impl Input {
    fn parse(arg: &str) -> Input {
        if arg == "-" {
            Input::Stdin
        } else {
            Input::File(PathBuf::from(arg))
        }
    }
}

/// How `wb buf write` changes the buffer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteHow {
    Append(Input),
    Replace(Input),
    Patch { input: Input, base: Option<u64> },
}

/// `--lines A:B`, 1-based and inclusive; `to` absent means to the end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineRange {
    pub from: usize,
    pub to: Option<usize>,
}

impl LineRange {
    /// Parses `A:B`, `A:`, `:B` or `A`.
    fn parse(arg: &str) -> Result<LineRange, Usage> {
        let bad = || usage(format!("bad --lines {arg:?}: expected A:B (1-based)"));
        let (a, b) = match arg.split_once(':') {
            Some((a, b)) => (a, Some(b)),
            None => (arg, None),
        };
        let from = if a.is_empty() {
            1
        } else {
            a.parse::<usize>().map_err(|_| bad())?
        };
        let to = match b {
            None => Some(from),
            Some("") => None,
            Some(b) => Some(b.parse::<usize>().map_err(|_| bad())?),
        };
        if from == 0 || to == Some(0) || to.is_some_and(|to| to < from) {
            return Err(bad());
        }
        Ok(LineRange { from, to })
    }
}

/// The form `wb eval` sends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvalSource {
    Form(String),
    File(PathBuf),
}

/// One `wb` command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    BufLs,
    BufRead {
        name: String,
        lines: Option<LineRange>,
        ver: bool,
    },
    BufWrite {
        name: String,
        how: WriteHow,
        create: bool,
    },
    BufSave {
        name: String,
    },
    BufRevert {
        name: String,
    },
    Eval {
        source: EvalSource,
    },
    Edit {
        file: String,
        line: Option<u64>,
        wait: bool,
    },
    Repl,
    /// `wb tools`: the tool list of the leader page.
    Tools {
        socket: Option<PathBuf>,
    },
    /// `wb TOOL ...`: one board tool in the leader page.
    Tool(ToolCall),
}

/// Where `--json` takes the tool input from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JsonInput {
    Object(Map<String, Value>),
    Stdin,
}

/// One board tool call over `web.sock`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCall {
    pub tool: String,
    /// `--json INPUT`; absent means `{}`.
    pub json: Option<JsonInput>,
    /// `KEY=VALUE` (a string) and `KEY:=JSON` (any value), in argv order.
    pub fields: Vec<(String, Value)>,
    /// `--timeout SECS`; absent lets wb-web use its default.
    pub timeout: Option<u64>,
    pub socket: Option<PathBuf>,
}

impl ToolCall {
    /// The input object: INPUT with the fields merged over it, a later field over an
    /// earlier one. `stdin` is the text read for `--json -`; `None` checks the fields
    /// alone. Refuses `create_node` with `kind` = `agent` (W-14).
    pub fn input(&self, stdin: Option<&str>) -> Result<Map<String, Value>, Usage> {
        let mut input = match (&self.json, stdin) {
            (Some(JsonInput::Object(obj)), _) => obj.clone(),
            (Some(JsonInput::Stdin), Some(text)) => object(text, "INPUT from stdin")?,
            (Some(JsonInput::Stdin), None) | (None, _) => Map::new(),
        };
        for (key, value) in &self.fields {
            input.insert(key.clone(), value.clone());
        }
        let agent = input
            .get("kind")
            .and_then(Value::as_str)
            .is_some_and(|k| k.trim().eq_ignore_ascii_case("agent"));
        if self.tool == "create_node" && agent {
            return Err(usage(
                "create_node with kind=agent is not available from wb",
            ));
        }
        Ok(input)
    }
}

/// Parses `text` as a JSON object.
fn object(text: &str, what: &str) -> Result<Map<String, Value>, Usage> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(obj)) => Ok(obj),
        Ok(_) => Err(usage(format!("{what} must be a JSON object"))),
        Err(e) => Err(usage(format!("bad JSON in {what}: {e}"))),
    }
}

/// Parses `KEY=VALUE` or `KEY:=JSON`.
fn field(arg: &str) -> Result<(String, Value), Usage> {
    let bad = || usage(format!("expected KEY=VALUE or KEY:=JSON, got {arg:?}"));
    let (key, text) = arg.split_once('=').ok_or_else(bad)?;
    let (key, value) = match key.strip_suffix(':') {
        Some(key) => {
            let value = serde_json::from_str(text)
                .map_err(|e| usage(format!("bad JSON in {key}:= ({e})")))?;
            (key, value)
        }
        None => (key, Value::String(text.to_owned())),
    };
    if key.is_empty() {
        return Err(bad());
    }
    Ok((key.to_owned(), value))
}

/// `--url` and `--token` are usage errors (§3.7.4): `wb` finds wb-web by its socket.
fn refuse_url_token(tokens: &[String]) -> Result<(), Usage> {
    for tok in tokens.iter().take_while(|t| *t != "--") {
        for name in ["--url", "--token"] {
            if tok == name || tok.strip_prefix(name).is_some_and(|v| v.starts_with('=')) {
                return Err(usage(format!(
                    "{name} is not an option of wb: it reaches wb-web by --socket or $WB_SOCKET"
                )));
            }
        }
    }
    Ok(())
}

/// Options that take a value (`--name VALUE` or `--name=VALUE`).
const VALUED: &[&str] = &["--lines", "--base", "--patch", "-f"];
/// The valued options of `wb TOOL`.
const TOOL_VALUED: &[&str] = &["--json", "--timeout", "--socket"];

/// Tokens split into positionals and options.
struct Split {
    pos: Vec<String>,
    opts: Vec<(String, Option<String>)>,
}

impl Split {
    fn new(tokens: &[String], valued: &[&str]) -> Result<Split, Usage> {
        let mut pos = Vec::new();
        let mut opts = Vec::new();
        let mut iter = tokens.iter();
        while let Some(tok) = iter.next() {
            if tok == "--" {
                pos.extend(iter.cloned());
                break;
            }
            let is_opt = (tok.starts_with("--") && tok.len() > 2) || tok == "-f";
            if !is_opt {
                pos.push(tok.clone());
                continue;
            }
            let (name, inline) = match tok.split_once('=') {
                Some((n, v)) => (n.to_owned(), Some(v.to_owned())),
                None => (tok.clone(), None),
            };
            let value = if valued.contains(&name.as_str()) {
                match inline {
                    Some(v) => Some(v),
                    None => Some(
                        iter.next()
                            .cloned()
                            .ok_or_else(|| usage(format!("{name} needs a value")))?,
                    ),
                }
            } else if inline.is_some() {
                return Err(usage(format!("{name} takes no value")));
            } else {
                None
            };
            opts.push((name, value));
        }
        Ok(Split { pos, opts })
    }

    /// Takes `--json` out and reports it.
    fn json(&mut self) -> bool {
        let before = self.opts.len();
        self.opts.retain(|(n, _)| n != "--json");
        self.opts.len() != before
    }

    /// Rejects options outside `allowed` and duplicates.
    fn check(&self, allowed: &[&str]) -> Result<(), Usage> {
        for (i, (name, _)) in self.opts.iter().enumerate() {
            if !allowed.contains(&name.as_str()) {
                return Err(usage(format!("unknown option {name}")));
            }
            if self.opts[..i].iter().any(|(n, _)| n == name) {
                return Err(usage(format!("{name} given twice")));
            }
        }
        Ok(())
    }

    fn has(&self, name: &str) -> bool {
        self.opts.iter().any(|(n, _)| n == name)
    }

    fn value(&self, name: &str) -> Option<&str> {
        self.opts
            .iter()
            .find(|(n, _)| n == name)
            .and_then(|(_, v)| v.as_deref())
    }

    /// Exactly `n` positionals, else a usage error.
    fn exactly(&self, n: usize, what: &str) -> Result<(), Usage> {
        if self.pos.len() == n {
            Ok(())
        } else {
            Err(usage(format!("expected {what}")))
        }
    }
}

fn parse_u64(name: &str, value: &str) -> Result<u64, Usage> {
    value.parse().map_err(|_| {
        usage(format!(
            "{name} needs a non-negative integer, got {value:?}"
        ))
    })
}

/// Parses the arguments after the program name.
pub fn parse(argv: &[String]) -> Result<Args, Usage> {
    let (head, rest) = argv.split_first().ok_or_else(|| usage(""))?;
    match head.as_str() {
        "buf" => parse_buf(rest),
        "eval" => {
            let mut s = Split::new(rest, VALUED)?;
            let json = s.json();
            s.check(&["-f"])?;
            let source = match (s.value("-f"), s.pos.as_slice()) {
                (Some(file), []) => EvalSource::File(PathBuf::from(file)),
                (None, [form]) => EvalSource::Form(form.clone()),
                _ => return Err(usage("eval takes one FORM or -f FILE")),
            };
            Ok(Args {
                cmd: Command::Eval { source },
                json,
            })
        }
        "edit" => {
            let mut s = Split::new(rest, VALUED)?;
            let json = s.json();
            s.check(&["--wait"])?;
            let mut file = None;
            let mut line = None;
            for p in &s.pos {
                if let Some(n) = p.strip_prefix('+')
                    && line.is_none()
                    && file.is_some()
                {
                    line = Some(parse_u64("+LINE", n)?);
                } else if file.is_none() {
                    file = Some(p.clone());
                } else {
                    return Err(usage("edit takes one FILE and an optional +LINE"));
                }
            }
            let file = file.ok_or_else(|| usage("edit needs a FILE"))?;
            Ok(Args {
                cmd: Command::Edit {
                    file,
                    line,
                    wait: s.has("--wait"),
                },
                json,
            })
        }
        "repl" => {
            let mut s = Split::new(rest, VALUED)?;
            let json = s.json();
            s.check(&[])?;
            s.exactly(0, "no arguments after repl")?;
            Ok(Args {
                cmd: Command::Repl,
                json,
            })
        }
        "tools" => {
            refuse_url_token(rest)?;
            let s = Split::new(rest, &["--socket"])?;
            s.check(&["--socket"])?;
            s.exactly(0, "no arguments after tools")?;
            Ok(Args {
                cmd: Command::Tools {
                    socket: socket(&s)?,
                },
                json: false,
            })
        }
        "desk" => parse_desk(rest),
        "-h" | "--help" | "help" => Err(usage("")),
        other if is_tool_name(other) && !COMMANDS.contains(&other) => parse_tool(other, rest),
        other => Err(usage(format!("unknown command {other:?}"))),
    }
}

/// `--socket PATH`, which must not be empty.
fn socket(s: &Split) -> Result<Option<PathBuf>, Usage> {
    match s.value("--socket") {
        Some("") => Err(usage("--socket needs a path")),
        v => Ok(v.map(PathBuf::from)),
    }
}

/// `wb TOOL [--json INPUT] [KEY=VALUE]... [KEY:=JSON]... [--timeout SECS] [--socket PATH]`.
/// Here `--json` names the input (spec §13.1); the output is always the result text.
fn parse_tool(tool: &str, rest: &[String]) -> Result<Args, Usage> {
    if DROPPED_TOOLS.contains(&tool) {
        return Err(usage(format!("{tool} is not available from wb")));
    }
    refuse_url_token(rest)?;
    let s = Split::new(rest, TOOL_VALUED)?;
    s.check(TOOL_VALUED)?;
    let json = match s.value("--json") {
        None => None,
        Some("-") => Some(JsonInput::Stdin),
        Some(text) => Some(JsonInput::Object(object(text, "INPUT")?)),
    };
    let fields = s.pos.iter().map(|p| field(p)).collect::<Result<_, _>>()?;
    let call = ToolCall {
        tool: tool.to_owned(),
        json,
        fields,
        timeout: timeout(&s)?,
        socket: socket(&s)?,
    };
    // Check what is known now; `--json -` is checked again once stdin is read.
    call.input(None)?;
    Ok(Args {
        cmd: Command::Tool(call),
        json: false,
    })
}

/// `--timeout SECS`, at least 1.
fn timeout(s: &Split) -> Result<Option<u64>, Usage> {
    match s.value("--timeout") {
        None => Ok(None),
        Some(v) => match parse_u64("--timeout", v)? {
            0 => Err(usage("--timeout needs 1 second or more")),
            secs => Ok(Some(secs)),
        },
    }
}

/// A desk number: one digit, 0 (the Board) to 9 (the attention desk).
fn desk_number(arg: &str) -> Result<Value, Usage> {
    match arg.parse::<u8>() {
        Ok(n) if n <= 9 && arg.len() == 1 => Ok(Value::from(n)),
        _ => Err(usage(format!("a desk is a digit 0-9, got {arg:?}"))),
    }
}

/// `wb desk ls`, `wb desk go N` and `wb desk send N [PATH]... [--keep] [--follow]`: the
/// board tools `list_desks`, `go_to_desk` and `send_to_desk` (DESIGN §10.8, D3), run as
/// `wb TOOL` runs them.
fn parse_desk(argv: &[String]) -> Result<Args, Usage> {
    let (sub, rest) = argv
        .split_first()
        .ok_or_else(|| usage("desk needs ls, go or send"))?;
    refuse_url_token(rest)?;
    let s = Split::new(rest, &["--timeout", "--socket"])?;
    let mut fields = Vec::new();
    let tool = match sub.as_str() {
        "ls" => {
            s.check(&["--timeout", "--socket"])?;
            s.exactly(0, "no arguments after desk ls")?;
            "list_desks"
        }
        "go" => {
            s.check(&["--timeout", "--socket"])?;
            s.exactly(1, "one desk number 0-9 after desk go")?;
            fields.push(("desk".to_owned(), desk_number(&s.pos[0])?));
            "go_to_desk"
        }
        "send" => {
            s.check(&["--keep", "--follow", "--timeout", "--socket"])?;
            let (n, paths) = s
                .pos
                .split_first()
                .ok_or_else(|| usage("desk send needs a desk number 0-9"))?;
            fields.push(("desk".to_owned(), desk_number(n)?));
            if !paths.is_empty() {
                let items = paths.iter().cloned().map(Value::String).collect();
                fields.push(("items".to_owned(), Value::Array(items)));
            }
            for flag in ["keep", "follow"] {
                if s.has(&format!("--{flag}")) {
                    fields.push((flag.to_owned(), Value::Bool(true)));
                }
            }
            "send_to_desk"
        }
        other => {
            return Err(usage(format!(
                "unknown desk command {other:?}: ls, go or send"
            )));
        }
    };
    Ok(Args {
        cmd: Command::Tool(ToolCall {
            tool: tool.to_owned(),
            json: None,
            fields,
            timeout: timeout(&s)?,
            socket: socket(&s)?,
        }),
        json: false,
    })
}

fn parse_buf(argv: &[String]) -> Result<Args, Usage> {
    let (sub, rest) = argv
        .split_first()
        .ok_or_else(|| usage("buf needs a subcommand"))?;
    let mut s = Split::new(rest, VALUED)?;
    let json = s.json();
    let cmd = match sub.as_str() {
        "ls" => {
            s.check(&[])?;
            s.exactly(0, "no arguments after ls")?;
            Command::BufLs
        }
        "read" => {
            s.check(&["--lines", "--ver"])?;
            s.exactly(1, "NAME")?;
            let lines = s.value("--lines").map(LineRange::parse).transpose()?;
            Command::BufRead {
                name: s.pos[0].clone(),
                lines,
                ver: s.has("--ver"),
            }
        }
        "write" => {
            s.check(&["--append", "--replace", "--patch", "--base", "--create"])?;
            let modes = ["--append", "--replace", "--patch"]
                .iter()
                .filter(|m| s.has(m))
                .count();
            if modes != 1 {
                return Err(usage(
                    "write needs exactly one of --append, --replace, --patch",
                ));
            }
            let base = s
                .value("--base")
                .map(|v| parse_u64("--base", v))
                .transpose()?;
            if base.is_some() && !s.has("--patch") {
                return Err(usage("--base only goes with --patch"));
            }
            let how = if let Some(file) = s.value("--patch") {
                s.exactly(1, "NAME")?;
                WriteHow::Patch {
                    input: Input::parse(file),
                    base,
                }
            } else {
                let input = match s.pos.as_slice() {
                    [_] => Input::Stdin,
                    [_, file] => Input::parse(file),
                    _ => return Err(usage("expected NAME [FILE|-]")),
                };
                if s.has("--append") {
                    WriteHow::Append(input)
                } else {
                    WriteHow::Replace(input)
                }
            };
            Command::BufWrite {
                name: s.pos[0].clone(),
                how,
                create: s.has("--create"),
            }
        }
        "save" | "revert" => {
            s.check(&[])?;
            s.exactly(1, "NAME")?;
            let name = s.pos[0].clone();
            if sub == "save" {
                Command::BufSave { name }
            } else {
                Command::BufRevert { name }
            }
        }
        other => return Err(usage(format!("unknown buf subcommand {other:?}"))),
    };
    Ok(Args { cmd, json })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(line: &str) -> Result<Args, Usage> {
        let argv: Vec<String> = line.split_whitespace().map(str::to_owned).collect();
        parse(&argv)
    }

    fn ok(line: &str) -> Args {
        p(line).unwrap_or_else(|e| panic!("{line}: {e:?}"))
    }

    #[test]
    fn buf_ls() {
        assert_eq!(
            ok("buf ls"),
            Args {
                cmd: Command::BufLs,
                json: false
            }
        );
        assert!(ok("buf ls --json").json);
        assert!(p("buf ls extra").is_err());
        assert!(p("buf ls --ver").is_err());
    }

    #[test]
    fn buf_read() {
        let a = ok("buf read notes/x.md --lines 3:5 --ver --json");
        assert!(a.json);
        assert_eq!(
            a.cmd,
            Command::BufRead {
                name: "notes/x.md".into(),
                lines: Some(LineRange {
                    from: 3,
                    to: Some(5)
                }),
                ver: true,
            }
        );
        let a = ok("buf read x --lines=7:");
        assert!(matches!(
            a.cmd,
            Command::BufRead {
                lines: Some(LineRange { from: 7, to: None }),
                ver: false,
                ..
            }
        ));
        assert!(matches!(
            ok("buf read x --lines :2").cmd,
            Command::BufRead {
                lines: Some(LineRange {
                    from: 1,
                    to: Some(2)
                }),
                ..
            }
        ));
        assert!(matches!(
            ok("buf read x --lines 4").cmd,
            Command::BufRead {
                lines: Some(LineRange {
                    from: 4,
                    to: Some(4)
                }),
                ..
            }
        ));
        assert!(p("buf read").is_err());
        assert!(p("buf read a b").is_err());
        assert!(p("buf read x --lines 0:3").is_err());
        assert!(p("buf read x --lines 5:3").is_err());
        assert!(p("buf read x --lines").is_err());
        assert!(p("buf read x --ver --ver").is_err());
    }

    #[test]
    fn buf_write() {
        assert_eq!(
            ok("buf write x --append").cmd,
            Command::BufWrite {
                name: "x".into(),
                how: WriteHow::Append(Input::Stdin),
                create: false
            }
        );
        assert_eq!(
            ok("buf write x --replace f.txt --create").cmd,
            Command::BufWrite {
                name: "x".into(),
                how: WriteHow::Replace(Input::File("f.txt".into())),
                create: true
            }
        );
        assert_eq!(
            ok("buf write x --append -").cmd,
            Command::BufWrite {
                name: "x".into(),
                how: WriteHow::Append(Input::Stdin),
                create: false
            }
        );
        assert_eq!(
            ok("buf write x --patch - --base 12").cmd,
            Command::BufWrite {
                name: "x".into(),
                how: WriteHow::Patch {
                    input: Input::Stdin,
                    base: Some(12)
                },
                create: false
            }
        );
        assert_eq!(
            ok("buf write x --patch=p.diff").cmd,
            Command::BufWrite {
                name: "x".into(),
                how: WriteHow::Patch {
                    input: Input::File("p.diff".into()),
                    base: None
                },
                create: false
            }
        );
        assert!(p("buf write x").is_err());
        assert!(p("buf write x --append --replace").is_err());
        assert!(p("buf write x --append --base 3").is_err());
        assert!(p("buf write x --patch").is_err());
        assert!(p("buf write x --patch p f").is_err());
        assert!(p("buf write x --append a b").is_err());
        assert!(p("buf write x --patch p --base x").is_err());
    }

    #[test]
    fn buf_save_revert() {
        assert_eq!(
            ok("buf save ~/a.md").cmd,
            Command::BufSave {
                name: "~/a.md".into()
            }
        );
        assert_eq!(
            ok("buf revert /etc/hosts --json").cmd,
            Command::BufRevert {
                name: "/etc/hosts".into()
            }
        );
        assert!(p("buf save").is_err());
        assert!(p("buf nope x").is_err());
        assert!(p("buf").is_err());
    }

    #[test]
    fn eval() {
        let argv = vec!["eval".to_owned(), "(+ 1 2)".to_owned()];
        assert_eq!(
            parse(&argv).unwrap().cmd,
            Command::Eval {
                source: EvalSource::Form("(+ 1 2)".into())
            }
        );
        assert_eq!(
            ok("eval -f x.scm --json").cmd,
            Command::Eval {
                source: EvalSource::File("x.scm".into())
            }
        );
        assert!(p("eval").is_err());
        assert!(p("eval -f").is_err());
        assert!(p("eval -f a (b)").is_err());
    }

    #[test]
    fn edit() {
        assert_eq!(
            ok("edit src/main.rs +12 --wait").cmd,
            Command::Edit {
                file: "src/main.rs".into(),
                line: Some(12),
                wait: true
            }
        );
        assert_eq!(
            ok("edit f").cmd,
            Command::Edit {
                file: "f".into(),
                line: None,
                wait: false
            }
        );
        assert!(p("edit").is_err());
        assert!(p("edit a b").is_err());
        assert!(p("edit a +x").is_err());
        assert!(p("edit a --lines 1:2").is_err());
    }

    #[test]
    fn repl_and_misc() {
        assert_eq!(ok("repl").cmd, Command::Repl);
        assert!(ok("repl --json").json);
        assert!(p("repl x").is_err());
        assert!(p("").is_err());
        // Not a command and not a tool name.
        assert!(p("Frob").is_err());
        assert!(p("frob-nicate").is_err());
        assert!(p("9lives").is_err());
        assert!(p("_x").is_err());
        assert!(p("--help").is_err());
        assert!(p("help").is_err());
    }

    fn pv(argv: &[&str]) -> Result<Args, Usage> {
        let argv: Vec<String> = argv.iter().map(|s| (*s).to_owned()).collect();
        parse(&argv)
    }

    fn call(argv: &[&str]) -> ToolCall {
        match pv(argv).unwrap_or_else(|e| panic!("{argv:?}: {e:?}")) {
            Args {
                cmd: Command::Tool(call),
                json: false,
            } => call,
            other => panic!("{argv:?}: not a tool call: {other:?}"),
        }
    }

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn usage_text(argv: &[&str]) -> String {
        pv(argv)
            .expect_err(&format!("{argv:?} should be a usage error"))
            .0
    }

    #[test]
    fn tool_names() {
        for ok in ["read_node", "x", "a1_b2", "frobnicate"] {
            assert!(is_tool_name(ok), "{ok}");
        }
        for bad in ["", "Read", "1x", "_x", "a-b", "a.b", "é"] {
            assert!(!is_tool_name(bad), "{bad}");
        }
        assert_eq!(call(&["frobnicate"]).tool, "frobnicate");
    }

    #[test]
    fn tools_command() {
        assert_eq!(
            pv(&["tools"]).unwrap(),
            Args {
                cmd: Command::Tools { socket: None },
                json: false
            }
        );
        assert_eq!(
            pv(&["tools", "--socket", "/x/web.sock"]).unwrap().cmd,
            Command::Tools {
                socket: Some("/x/web.sock".into())
            }
        );
        assert_eq!(
            pv(&["tools", "--socket=/y.sock"]).unwrap().cmd,
            Command::Tools {
                socket: Some("/y.sock".into())
            }
        );
        assert!(pv(&["tools", "extra"]).is_err());
        assert!(pv(&["tools", "--json"]).is_err());
        assert!(pv(&["tools", "--socket"]).is_err());
        assert!(pv(&["tools", "--socket", ""]).is_err());
        assert!(usage_text(&["tools", "--url", "http://x"]).contains("--url"));
    }

    #[test]
    fn tool_with_no_input_is_empty_object() {
        let c = call(&["list_nodes"]);
        assert_eq!(
            c,
            ToolCall {
                tool: "list_nodes".into(),
                json: None,
                fields: vec![],
                timeout: None,
                socket: None,
            }
        );
        assert_eq!(c.input(None).unwrap(), Map::new());
    }

    #[test]
    fn tool_json_input_and_options() {
        let c = call(&[
            "read_node",
            "--json",
            r#"{"path":"a/b"}"#,
            "--timeout",
            "5",
            "--socket",
            "/s.sock",
        ]);
        assert_eq!(
            c.json,
            Some(JsonInput::Object(obj(serde_json::json!({"path": "a/b"}))))
        );
        assert_eq!(c.timeout, Some(5));
        assert_eq!(c.socket, Some("/s.sock".into()));
        let c = call(&["read_node", r#"--json={"path":"x=y"}"#, "--timeout=300"]);
        assert_eq!(
            c.input(None).unwrap(),
            obj(serde_json::json!({"path": "x=y"}))
        );
        assert_eq!(c.timeout, Some(300));
        assert_eq!(
            call(&["read_node", "--json", "-"]).json,
            Some(JsonInput::Stdin)
        );
    }

    #[test]
    fn tool_fields_merge_over_input() {
        let c = call(&[
            "write_page",
            "--json",
            r#"{"path":"p","text":"old","n":1}"#,
            "text=new = text",
            "confirm:=true",
            "n:=[1,2]",
            "empty=",
            r#"obj:={"a":null}"#,
        ]);
        assert_eq!(
            c.input(None).unwrap(),
            obj(serde_json::json!({
                "path": "p",
                "text": "new = text",
                "n": [1, 2],
                "confirm": true,
                "empty": "",
                "obj": {"a": null},
            }))
        );
        // A later field wins; `KEY:=` with a string JSON value is a string.
        let c = call(&["t", "a=1", "a:=2", r#"b:="s""#]);
        assert_eq!(
            c.input(None).unwrap(),
            obj(serde_json::json!({"a": 2, "b": "s"}))
        );
        // Fields merge over INPUT read from stdin.
        let c = call(&["t", "--json", "-", "a=x"]);
        assert_eq!(
            c.input(Some(r#"{"a":"y","b":true}"#)).unwrap(),
            obj(serde_json::json!({"a": "x", "b": true}))
        );
        assert!(c.input(Some("[1]")).is_err());
        assert!(c.input(Some("{")).is_err());
        assert!(c.input(Some("")).is_err());
    }

    #[test]
    fn tool_double_dash_ends_options() {
        let c = call(&["t", "--", "--weird=1"]);
        assert_eq!(c.fields, vec![("--weird".to_owned(), Value::from("1"))]);
    }

    #[test]
    fn tool_usage_errors() {
        for argv in [
            &["t", "--json"][..],
            &["t", "--json", "[1,2]"][..],
            &["t", "--json", "\"string\""][..],
            &["t", "--json", "{bad"][..],
            &["t", "--json", "{}", "--json", "{}"][..],
            &["t", "positional"][..],
            &["t", "=v"][..],
            &["t", ":=1"][..],
            &["t", "k:=nope"][..],
            &["t", "--timeout", "0"][..],
            &["t", "--timeout", "-1"][..],
            &["t", "--timeout", "x"][..],
            &["t", "--socket", ""][..],
            &["t", "--wait"][..],
            &["t", "-f", "x"][..],
        ] {
            assert!(pv(argv).is_err(), "{argv:?} should be a usage error");
        }
    }

    #[test]
    fn url_and_token_are_usage_errors() {
        for argv in [
            &["read_node", "--url", "http://h"][..],
            &["read_node", "--url=http://h"][..],
            &["read_node", "--token", "t"][..],
            &["read_node", "--token=t"][..],
            &["tools", "--token", "t"][..],
        ] {
            let msg = usage_text(argv);
            assert!(
                msg.contains("--url") || msg.contains("--token"),
                "{argv:?}: {msg}"
            );
        }
        // After `--` the word is a field like any other.
        assert!(pv(&["read_node", "--", "--url=x"]).is_ok());
    }

    #[test]
    fn w14_tools_are_usage_errors() {
        for tool in DROPPED_TOOLS {
            assert_eq!(
                usage_text(&[tool]),
                format!("{tool} is not available from wb")
            );
            assert!(pv(&[tool, "--json", "{}"]).is_err());
        }
        for argv in [
            &["create_node", "--json", r#"{"kind":"agent","name":"a"}"#][..],
            &["create_node", "kind=agent", "name=a"][..],
            &["create_node", "--json", r#"{"kind":"page"}"#, "kind=agent"][..],
            &["create_node", "kind:=\"Agent\""][..],
            &["create_node", "--json", "-", "kind=agent"][..],
        ] {
            assert!(
                usage_text(argv).contains("kind=agent"),
                "{argv:?} should refuse kind=agent"
            );
        }
        assert!(pv(&["create_node", "kind=page", "name=a"]).is_ok());
        // A field over INPUT can also lift the refusal.
        assert!(pv(&["create_node", "--json", r#"{"kind":"agent"}"#, "kind=shell"]).is_ok());
        // kind=agent on another tool is that tool's business.
        assert!(pv(&["list_nodes", "kind=agent"]).is_ok());
        // From stdin it is refused once the text is read.
        let c = call(&["create_node", "--json", "-"]);
        assert!(c.input(Some(r#"{"kind":"agent"}"#)).is_err());
        assert!(c.input(Some(r#"{"kind":"repl"}"#)).is_ok());
    }

    #[test]
    fn desk_commands_are_the_desk_tools() {
        let c = call(&["desk", "ls"]);
        assert_eq!(
            (c.tool.as_str(), c.input(None).unwrap()),
            ("list_desks", Map::new())
        );
        let c = call(&["desk", "go", "3", "--socket", "/s.sock"]);
        assert_eq!(c.tool, "go_to_desk");
        assert_eq!(c.input(None).unwrap(), obj(serde_json::json!({"desk": 3})));
        assert_eq!(c.socket, Some("/s.sock".into()));
        let c = call(&[
            "desk",
            "send",
            "4",
            "notes/plan",
            "work/",
            "--follow",
            "--timeout=9",
        ]);
        assert_eq!(c.tool, "send_to_desk");
        assert_eq!(
            c.input(None).unwrap(),
            obj(serde_json::json!({"desk": 4, "items": ["notes/plan", "work/"], "follow": true}))
        );
        assert_eq!(c.timeout, Some(9));
        let c = call(&["desk", "send", "0", "--keep"]);
        assert_eq!(
            c.input(None).unwrap(),
            obj(serde_json::json!({"desk": 0, "keep": true}))
        );
        // `--` lets a path start with a dash
        assert_eq!(
            call(&["desk", "send", "2", "--", "--odd"]).fields[1].1,
            serde_json::json!(["--odd"])
        );
        for argv in [
            &["desk"][..],
            &["desk", "ls", "x"][..],
            &["desk", "go"][..],
            &["desk", "go", "10"][..],
            &["desk", "go", "-1"][..],
            &["desk", "go", "03"][..],
            &["desk", "go", "1", "2"][..],
            &["desk", "go", "1", "--keep"][..],
            &["desk", "send"][..],
            &["desk", "send", "x", "a"][..],
            &["desk", "send", "1", "--json", "{}"][..],
            &["desk", "send", "1", "--timeout", "0"][..],
            &["desk", "move", "1"][..],
            &["desk", "ls", "--url", "http://h"][..],
        ] {
            assert!(pv(argv).is_err(), "{argv:?} should be a usage error");
        }
    }

    #[test]
    fn usage_lists_the_tool_commands() {
        assert!(USAGE.contains("wb tools [--socket PATH]"));
        assert!(USAGE.contains("wb desk ls | go N | send N [PATH]..."));
        assert!(USAGE.contains(
            "wb TOOL [--json INPUT] [KEY=VALUE]... [KEY:=JSON]... [--timeout SECS] [--socket PATH]"
        ));
    }

    #[test]
    fn double_dash_ends_options() {
        assert_eq!(
            ok("buf read -- --weird").cmd,
            Command::BufRead {
                name: "--weird".into(),
                lines: None,
                ver: false
            }
        );
    }
}
