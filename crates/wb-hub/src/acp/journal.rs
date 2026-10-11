//! The per-session ACP journal `acp/<sid>.jsonl`: one `JournalEvent` per line,
//! appended fail-closed (DESIGN §3.4.4, H-9). Memory never runs ahead of disk, so a
//! seq is never issued twice.
//!
//! Each line is written with one `pwrite(2)` at the tracked end of the last complete
//! line, never with `O_APPEND`. Bytes a failed write leaves behind (when even the
//! truncation fails) are a prefix of a line, so they hold no `\n`: the next append
//! overwrites them, and whatever is left past the last line is a torn tail that the
//! next `open` truncates.

use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader};
use std::os::unix::fs::{FileExt, OpenOptionsExt};
use std::path::Path;

use anyhow::{Context, Result, bail};
use tokio::task::JoinHandle;
use tracing::{error, warn};
use wb_proto::hub::ExitReason;
use wb_proto::journal::{EventBody, JournalEvent};
use wb_proto::line;

use super::facts::Facts;

/// The message of the `turn_error`/`setup_error` that startup normalisation writes.
const HUB_RESTART: &str = "interrupted by a hub restart";

/// The append handle of one session's journal.
pub struct Journal {
    file: File,
    /// Byte length of the journal up to its last complete line.
    end: u64,
    /// Seq of the last line written; 0 for an empty journal.
    head: u64,
    /// The append of this seq fails once after writing half its line (fault injection).
    #[cfg(any(test, debug_assertions))]
    fail_at: Option<u64>,
}

/// An append that did not complete. The journal was truncated back to its last
/// complete line, so nothing of the event is on disk and its seq was not used.
#[derive(Debug)]
pub struct WriteFault {
    pub error: io::Error,
}

impl Journal {
    /// Opens the journal at `path`, creating it with mode 0600 if missing, and returns
    /// its events in file order. Bytes after the last `\n` are a torn tail: they are
    /// truncated away and logged. Any complete line that is not a journal event, or
    /// whose seq is not the previous one plus 1 (starting at 1), is an error, so the
    /// caller quarantines the session (DESIGN §3.4.4).
    pub fn open(path: &Path) -> Result<(Journal, Vec<JournalEvent>)> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("cannot open {}", path.display()))?;
        let mut reader = BufReader::new(&file);
        let mut events: Vec<JournalEvent> = Vec::new();
        let mut end = 0u64;
        let mut line = Vec::new();
        loop {
            line.clear();
            let n = reader
                .read_until(b'\n', &mut line)
                .with_context(|| format!("cannot read {}", path.display()))?;
            if n == 0 {
                break;
            }
            if line.last() != Some(&b'\n') {
                warn!(path = %path.display(), bytes = n, "truncating a torn journal tail");
                file.set_len(end)
                    .with_context(|| format!("cannot truncate {}", path.display()))?;
                break;
            }
            let ev: JournalEvent = serde_json::from_slice(&line[..n - 1]).with_context(|| {
                format!(
                    "{}: the line at byte {end} is not a journal event",
                    path.display()
                )
            })?;
            let due = events.len() as u64 + 1;
            if ev.seq != due {
                bail!(
                    "{}: the line at byte {end} has seq {} where {due} is due",
                    path.display(),
                    ev.seq
                );
            }
            end += n as u64;
            events.push(ev);
        }
        let journal = Journal {
            file,
            end,
            head: events.len() as u64,
            #[cfg(any(test, debug_assertions))]
            fail_at: fail_at_from_env(),
        };
        Ok((journal, events))
    }

    /// Writes `body` as the next event with one `write(2)`. Only a complete write
    /// advances the head; on any failure the file is truncated back and the fault
    /// returned.
    pub fn append(&mut self, body: &EventBody, ts: u64) -> Result<JournalEvent, WriteFault> {
        let ev = JournalEvent {
            seq: self.head + 1,
            ts,
            body: body.clone(),
        };
        let bytes = line::encode(&ev);
        if let Err(error) = self.write(&bytes) {
            if let Err(e) = self.file.set_len(self.end) {
                error!(error = %e, end = self.end, "cannot truncate the journal after a failed append");
            }
            return Err(WriteFault { error });
        }
        self.end += bytes.len() as u64;
        self.head = ev.seq;
        Ok(ev)
    }

    /// Startup normalisation (DESIGN §3.4.4, 10 §3 step 5). When `facts`, the fold of
    /// this journal, has a `spawn` with no later `exit`, appends the death invariant with
    /// code `interrupted`, then `exit{code:null, signal:null, reason:"hub_restart"}`,
    /// folding each line into `facts` once it is on disk. Returns the appended events;
    /// when there are any, the caller then awaits `sync()`.
    ///
    /// On a fault the lines before it stay written and folded, and calling this again
    /// appends the rest.
    pub fn normalise(
        &mut self,
        facts: &mut Facts,
        ts: u64,
    ) -> Result<Vec<JournalEvent>, WriteFault> {
        debug_assert_eq!(
            facts.head_seq, self.head,
            "facts are the fold of this journal"
        );
        if !facts.running {
            return Ok(Vec::new());
        }
        let mut lines = facts.death_lines(true, HUB_RESTART);
        lines.push(EventBody::Exit {
            code: None,
            signal: None,
            reason: ExitReason::HubRestart,
        });
        let mut written = Vec::with_capacity(lines.len());
        for body in &lines {
            let ev = self.append(body, ts)?;
            facts.apply(&ev);
            written.push(ev);
        }
        Ok(written)
    }

    /// `fdatasync`s the journal on a cloned fd in `spawn_blocking`, so the caller
    /// never blocks on the disk.
    pub fn sync(&self) -> JoinHandle<io::Result<()>> {
        let file = self.file.try_clone();
        tokio::task::spawn_blocking(move || file?.sync_data())
    }

    /// The head seq: the seq of the last event written, 0 for an empty journal.
    pub fn len(&self) -> u64 {
        self.head
    }

    /// One `pwrite(2)` of `bytes` at the end of the last complete line; a short write
    /// is an error.
    fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        #[cfg(any(test, debug_assertions))]
        if self.fail_at == Some(self.head + 1) {
            self.fail_at = None;
            self.file.write_at(&bytes[..bytes.len() / 2], self.end)?;
            return Err(io::Error::other("injected journal write fault"));
        }
        let n = self.file.write_at(bytes, self.end)?;
        if n == bytes.len() {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::WriteZero,
                format!("short write: {n} of {} bytes", bytes.len()),
            ))
        }
    }
}

/// `WB_HUB_TEST_FAIL_WRITE_AT=N`, in debug builds only (DESIGN §4; also compiled into
/// unit tests, which never set it): the first journal this process opens fails its
/// first attempt to append seq N, after writing half the line. Later journals,
/// including a reopen of the same file, are not affected, so a retry of the same seq
/// succeeds.
#[cfg(any(test, debug_assertions))]
fn fail_at_from_env() -> Option<u64> {
    use std::sync::atomic::{AtomicBool, Ordering};
    static TAKEN: AtomicBool = AtomicBool::new(false);
    let n = std::env::var("WB_HUB_TEST_FAIL_WRITE_AT")
        .ok()?
        .parse()
        .ok()?;
    (!TAKEN.swap(true, Ordering::Relaxed)).then_some(n)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use serde_json::json;
    use wb_proto::journal::{SessionVia, SetupErrorCode, SpawnVia};

    use super::*;

    fn fresh_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wb-journal-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir(&dir).unwrap();
        dir
    }

    fn spawn() -> EventBody {
        EventBody::Spawn {
            pid: 7,
            via: SpawnVia::New,
        }
    }

    fn session() -> EventBody {
        EventBody::Session {
            via: SessionVia::New,
            session_id: "s-1".into(),
            modes: None,
            config_options: None,
        }
    }

    fn prompt() -> EventBody {
        EventBody::Prompt {
            prompt: vec![json!({"type": "text", "text": "go"})],
        }
    }

    fn chunk(text: &str) -> EventBody {
        EventBody::Update {
            update: json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}),
            session_id: None,
        }
    }

    /// Appends `bodies` at ts = seq and returns the folded facts.
    fn write_all(j: &mut Journal, bodies: &[EventBody]) -> Facts {
        let mut facts = Facts::default();
        for b in bodies {
            let ev = j.append(b, j.len() + 1).unwrap();
            facts.apply(&ev);
        }
        facts
    }

    fn fold(events: &[JournalEvent]) -> Facts {
        let mut f = Facts::default();
        for ev in events {
            f.apply(ev);
        }
        f
    }

    #[test]
    fn append_and_reload_round_trip() {
        let path = fresh_dir("round").join("s.jsonl");
        let (mut j, events) = Journal::open(&path).unwrap();
        assert!(events.is_empty());
        assert_eq!(j.len(), 0);
        let notice = EventBody::Notice {
            level: wb_proto::journal::NoticeLevel::Info,
            text: "revived via session/resume".into(),
        };
        let bodies = [spawn(), session(), prompt(), chunk("héllo\n"), notice];
        let mut written = Vec::new();
        for (i, b) in bodies.iter().enumerate() {
            let ev = j.append(b, 100 + i as u64).unwrap();
            assert_eq!((ev.seq, ev.ts, &ev.body), (i as u64 + 1, 100 + i as u64, b));
            written.push(ev);
        }
        assert_eq!(j.len(), 5);
        drop(j);

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let expected: Vec<u8> = written.iter().flat_map(line::encode).collect();
        assert_eq!(fs::read(&path).unwrap(), expected);

        let (j, events) = Journal::open(&path).unwrap();
        assert_eq!(events, written);
        assert_eq!(j.len(), 5);
    }

    /// A `tracing` writer into a shared buffer.
    #[derive(Clone, Default)]
    struct Logs(Arc<Mutex<Vec<u8>>>);

    impl io::Write for Logs {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            crate::lock(&self.0).extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_torn_final_line_is_truncated_and_logged() {
        let path = fresh_dir("torn").join("s.jsonl");
        let (mut j, _) = Journal::open(&path).unwrap();
        write_all(&mut j, &[spawn(), session()]);
        drop(j);
        let good = fs::read(&path).unwrap();
        let mut torn = good.clone();
        torn.extend_from_slice(br#"{"seq":3,"ts":3,"e":"pro"#);
        fs::write(&path, &torn).unwrap();

        let logs = Logs::default();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer({
                let logs = logs.clone();
                move || logs.clone()
            })
            .finish();
        let (mut j, events) =
            tracing::subscriber::with_default(subscriber, || Journal::open(&path)).unwrap();
        let logged = String::from_utf8(crate::lock(&logs.0).clone()).unwrap();
        assert!(logged.contains("torn journal tail"), "{logged}");
        assert_eq!(events.len(), 2);
        assert_eq!(j.len(), 2);
        assert_eq!(fs::read(&path).unwrap(), good);

        let ev = j.append(&prompt(), 3).unwrap();
        assert_eq!(ev.seq, 3);
        let (_, events) = Journal::open(&path).unwrap();
        assert_eq!(events.last(), Some(&ev));
    }

    #[test]
    fn a_complete_bad_line_or_a_seq_gap_fails_the_load() {
        let dir = fresh_dir("bad");
        let ok1 = r#"{"seq":1,"ts":1,"e":"spawn","pid":7,"via":"new"}"#;
        let ok2 = r#"{"seq":2,"ts":2,"e":"notice","level":"info","text":"x"}"#;
        let ok3 = r#"{"seq":3,"ts":3,"e":"notice","level":"info","text":"y"}"#;
        let cases = [
            ("garbage-only", "garbage\n".to_owned()),
            ("garbage-middle", format!("{ok1}\nnot json\n{ok2}\n")),
            ("garbage-last", format!("{ok1}\n{{\"seq\":2}}\n")),
            ("empty-line", format!("{ok1}\n\n")),
            ("gap", format!("{ok1}\n{ok3}\n")),
            ("repeat", format!("{ok1}\n{ok2}\n{ok2}\n")),
            ("not-from-1", format!("{ok2}\n{ok3}\n")),
        ];
        for (name, content) in cases {
            let path = dir.join(format!("{name}.jsonl"));
            fs::write(&path, &content).unwrap();
            assert!(Journal::open(&path).is_err(), "{name} loaded");
            assert_eq!(
                fs::read_to_string(&path).unwrap(),
                content,
                "{name} was changed"
            );
        }
    }

    #[test]
    fn a_write_fault_truncates_and_reuses_no_seq() {
        let path = fresh_dir("fault").join("s.jsonl");
        let (mut j, _) = Journal::open(&path).unwrap();
        let mut live = write_all(&mut j, &[spawn(), session()]);
        let before = fs::read(&path).unwrap();

        j.fail_at = Some(3);
        let fault = j.append(&chunk(&"x".repeat(1000)), 3).unwrap_err();
        assert_eq!(fault.error.to_string(), "injected journal write fault");
        assert_eq!(
            fs::read(&path).unwrap(),
            before,
            "the half-written line was truncated away"
        );
        assert_eq!(j.len(), 2);

        let mut seqs = vec![1, 2];
        for b in [prompt(), chunk("after")] {
            let ev = j.append(&b, 9).unwrap();
            live.apply(&ev);
            seqs.push(ev.seq);
        }
        assert_eq!(seqs, [1, 2, 3, 4]);

        let (j, events) = Journal::open(&path).unwrap();
        assert_eq!(j.len(), 4);
        assert_eq!(events[2].body, prompt());
        assert_eq!(
            fold(&events),
            live,
            "the live facts are the fold of the disk"
        );
    }

    #[test]
    fn bytes_left_by_a_failed_truncation_heal() {
        let path = fresh_dir("heal").join("s.jsonl");
        let (mut j, _) = Journal::open(&path).unwrap();
        write_all(&mut j, &[spawn()]);
        let end = fs::metadata(&path).unwrap().len();
        let junk = br#"{"seq":2,"ts":2,"e":"update","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"#;
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .write_at(junk, end)
            .unwrap();

        let ev2 = j.append(&session(), 2).unwrap();
        assert!(
            fs::metadata(&path).unwrap().len() > j.end,
            "junk is left after the line"
        );
        drop(j);
        let (j, events) = Journal::open(&path).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1], ev2);
        assert_eq!(fs::metadata(&path).unwrap().len(), j.end);
    }

    /// The journal before normalisation: a turn with a pending permission and a pending
    /// elicitation.
    fn mid_turn() -> Vec<EventBody> {
        vec![
            spawn(),
            session(),
            prompt(),
            EventBody::Permission {
                tool_call: json!({"toolCallId": "t1", "title": "Run ls"}),
                options: vec![json!({"optionId": "ok", "name": "Allow", "kind": "allow_once"})],
            },
            EventBody::Elicitation {
                request: json!({"mode": "form", "message": "Colour?"}),
            },
        ]
    }

    const NORMALISED: &str = concat!(
        r#"{"seq":6,"ts":99,"e":"permission_resolved","req":4,"outcome":{"outcome":"cancelled"},"by":"hub"}"#,
        "\n",
        r#"{"seq":7,"ts":99,"e":"elicitation_resolved","req":5,"response":{"action":"cancel"},"by":"hub"}"#,
        "\n",
        r#"{"seq":8,"ts":99,"e":"turn_error","code":"interrupted","message":"interrupted by a hub restart"}"#,
        "\n",
        r#"{"seq":9,"ts":99,"e":"exit","code":null,"signal":null,"reason":"hub_restart"}"#,
        "\n",
    );

    /// Opens the journal at `path`, folds it and normalises it at ts 99.
    fn load(path: &Path) -> (Journal, Facts, Result<Vec<JournalEvent>, WriteFault>) {
        let (mut j, events) = Journal::open(path).unwrap();
        let mut facts = fold(&events);
        let res = j.normalise(&mut facts, 99);
        (j, facts, res)
    }

    #[test]
    fn normalisation_appends_exactly_the_death_invariant() {
        let path = fresh_dir("norm").join("s.jsonl");
        let (mut j, _) = Journal::open(&path).unwrap();
        write_all(&mut j, &mid_turn());
        drop(j);
        let before = fs::read(&path).unwrap();

        let (j, facts, res) = load(&path);
        let appended = res.unwrap();
        assert_eq!(
            appended.iter().map(|e| e.seq).collect::<Vec<_>>(),
            [6, 7, 8, 9]
        );
        let after = fs::read(&path).unwrap();
        assert_eq!(&after[..before.len()], &before[..]);
        assert_eq!(
            std::str::from_utf8(&after[before.len()..]).unwrap(),
            NORMALISED
        );

        assert_eq!(j.len(), 9);
        assert!(!facts.running && facts.pending.is_empty());
        assert_eq!(facts.activity, wb_proto::hub::Activity::None);
        let last = facts.last.clone().unwrap();
        assert_eq!(
            (last.seq, last.error.unwrap().code.as_str()),
            (8, "interrupted")
        );
        drop(j);

        let (_, again, res) = load(&path);
        assert!(
            res.unwrap().is_empty(),
            "a normalised journal is left alone"
        );
        assert_eq!(again, facts);
        assert_eq!(fs::read(&path).unwrap(), after);
    }

    #[test]
    fn normalisation_ends_a_setup() {
        let path = fresh_dir("norm-setup").join("s.jsonl");
        let (mut j, _) = Journal::open(&path).unwrap();
        write_all(&mut j, &[spawn()]);
        drop(j);
        let (_, facts, res) = load(&path);
        let bodies: Vec<EventBody> = res.unwrap().into_iter().map(|e| e.body).collect();
        assert_eq!(
            bodies,
            [
                EventBody::SetupError {
                    code: SetupErrorCode::Interrupted,
                    message: HUB_RESTART.into(),
                    rpc: None
                },
                EventBody::Exit {
                    code: None,
                    signal: None,
                    reason: ExitReason::HubRestart
                },
            ]
        );
        assert!(!facts.running);
    }

    #[test]
    fn normalisation_of_an_idle_live_agent_appends_only_the_exit() {
        let auth_wait = EventBody::SetupError {
            code: SetupErrorCode::AuthRequired,
            message: "log in".into(),
            rpc: None,
        };
        for (name, bodies) in [
            ("idle", vec![spawn(), session()]),
            ("auth", vec![spawn(), auth_wait]),
        ] {
            let path = fresh_dir(&format!("norm-{name}")).join("s.jsonl");
            let (mut j, _) = Journal::open(&path).unwrap();
            write_all(&mut j, &bodies);
            drop(j);
            let (_, _, res) = load(&path);
            let appended = res.unwrap();
            assert_eq!(appended.len(), 1, "{name}");
            assert!(matches!(
                appended[0].body,
                EventBody::Exit {
                    reason: ExitReason::HubRestart,
                    ..
                }
            ));
        }
    }

    #[test]
    fn normalisation_leaves_journals_without_a_live_spawn_alone() {
        let spawn_failed = EventBody::SetupError {
            code: SetupErrorCode::SpawnFailed,
            message: "no such file".into(),
            rpc: None,
        };
        let exited = EventBody::Exit {
            code: Some(0),
            signal: None,
            reason: ExitReason::Exited,
        };
        for (name, bodies) in [
            ("empty", vec![]),
            ("spawn-failed", vec![spawn_failed]),
            ("ended", vec![spawn(), session(), exited]),
        ] {
            let path = fresh_dir(&format!("alone-{name}")).join("s.jsonl");
            let (mut j, _) = Journal::open(&path).unwrap();
            write_all(&mut j, &bodies);
            drop(j);
            let before = fs::read(&path).unwrap();
            let (_, _, res) = load(&path);
            assert!(res.unwrap().is_empty(), "{name}");
            assert_eq!(fs::read(&path).unwrap(), before, "{name}");
        }
    }

    #[test]
    fn a_fault_during_normalisation_folds_what_was_written_and_a_retry_completes() {
        let path = fresh_dir("norm-fault").join("s.jsonl");
        let (mut j, _) = Journal::open(&path).unwrap();
        write_all(&mut j, &mid_turn());
        drop(j);
        let before = fs::read(&path).unwrap();

        let (mut j, events) = Journal::open(&path).unwrap();
        let mut facts = fold(&events);
        j.fail_at = Some(7);
        assert!(j.normalise(&mut facts, 99).is_err());
        assert_eq!(facts.head_seq, 6);
        assert_eq!(facts.pending.iter().map(|p| p.req).collect::<Vec<_>>(), [5]);
        assert!(facts.running);
        let (_, on_disk) = Journal::open(&path).unwrap();
        assert_eq!(fold(&on_disk), facts, "the facts are the fold of the disk");

        let retried = j.normalise(&mut facts, 99).unwrap();
        assert_eq!(retried.iter().map(|e| e.seq).collect::<Vec<_>>(), [7, 8, 9]);
        let after = fs::read(&path).unwrap();
        assert_eq!(
            std::str::from_utf8(&after[before.len()..]).unwrap(),
            NORMALISED
        );
        assert!(!facts.running);
    }

    #[tokio::test]
    async fn sync_reaches_the_disk_off_the_caller() {
        let path = fresh_dir("sync").join("s.jsonl");
        let (mut j, _) = Journal::open(&path).unwrap();
        write_all(&mut j, &[spawn()]);
        j.sync().await.unwrap().unwrap();
    }
}
