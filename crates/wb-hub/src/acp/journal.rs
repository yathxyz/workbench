//! The per-session ACP journal `acp/<sid>.jsonl`: one `JournalEvent` per line,
//! appended fail-closed (DESIGN §3.4.4, H-9). A question's seq is durable before
//! it can reach a client as an answerable request id.
//!
//! Each line is written with one `pwrite(2)` at the tracked end of the last complete
//! line, never with `O_APPEND`. A failed append must roll back to this boundary.

use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader};
use std::os::unix::fs::{FileExt, OpenOptionsExt};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Context, Result, bail};
use rustix::io::Errno;
use tokio::task::JoinHandle;
use tracing::{error, warn};
use wb_proto::hub::ExitReason;
use wb_proto::journal::{EventBody, JournalEvent};
use wb_proto::line;

use super::facts::Facts;

/// The message of the `turn_error`/`setup_error` that startup normalisation writes.
const HUB_RESTART: &str = "interrupted by a hub restart";

/// One byte offset per 128 committed lines, rebuilt by the validation pass at open.
const CHECKPOINT_STRIDE: u64 = 128;

/// Last indexed sequence at or before `since` (zero before the first checkpoint).
pub(super) fn checkpoint_seq(since: u64) -> u64 {
    since - since % CHECKPOINT_STRIDE
}

fn checkpoint(offsets: &mut Vec<u64>, seq: u64, end: u64) {
    if seq.is_multiple_of(CHECKPOINT_STRIDE) {
        offsets.push(end);
    }
}

#[cfg(test)]
type Pause = (
    tokio::sync::oneshot::Sender<()>,
    tokio::sync::oneshot::Receiver<()>,
);

enum SyncOp {
    Prefix,
    Question(#[cfg(test)] Option<Pause>),
    Shrink,
}

/// Shared by the session supervisor and every file handle for this incarnation.
/// Reloading an actor must not discard an error observed by a background sync.
#[derive(Default)]
pub(super) struct SyncGate {
    serial: Mutex<()>,
    failed: OnceLock<Errno>,
}

struct SyncFile {
    file: File,
    gate: Arc<SyncGate>,
}

impl SyncFile {
    fn healthy(&self) -> io::Result<()> {
        self.gate.failed.get().map_or(Ok(()), |e| Err((*e).into()))
    }

    fn latch_write_eio(&self, error: &io::Error) {
        if error.raw_os_error() == Some(Errno::IO.raw_os_error()) {
            let _ = self.gate.failed.set(Errno::IO);
        }
    }

    fn sync(&self, op: SyncOp, #[cfg(test)] inject_eio: bool) -> io::Result<()> {
        let _guard = crate::lock(&self.gate.serial);
        if !matches!(op, SyncOp::Shrink) {
            self.healthy()?;
        }
        let fdatasync = || rustix::io::retry_on_intr(|| rustix::fs::fdatasync(&self.file));
        #[cfg(test)]
        let fdatasync = || {
            if inject_eio {
                return Err(Errno::IO);
            }
            fdatasync()?;
            if let SyncOp::Question(Some((entered, release))) = op {
                entered.send(()).unwrap();
                release.blocking_recv().unwrap();
            }
            Ok(())
        };
        fdatasync()
            .inspect_err(|errno| {
                let _ = self.gate.failed.set(*errno);
            })
            .map_err(Into::into)
    }
}

/// The append handle of one session's journal.
pub struct Journal {
    disk: Arc<SyncFile>,
    /// Byte length of the journal up to its last complete line.
    end: u64,
    /// Seq of the last line written; 0 for an empty journal.
    head: u64,
    offsets: Vec<u64>,
    /// Neither a failed truncate nor a failed sync of the shrink completes rollback.
    truncate_before_write: bool,
    /// The append of this seq fails once after writing half its line (fault injection).
    #[cfg(any(test, debug_assertions))]
    pub(super) fail_at: Option<u64>,
    #[cfg(test)]
    pub(super) fail_sync: bool,
    #[cfg(test)]
    pub(super) fail_background_sync: bool,
    #[cfg(test)]
    pub(super) pause_question: Option<Pause>,
    #[cfg(test)]
    pub(super) fail_truncate: bool,
    #[cfg(test)]
    fail_shrink_sync: bool,
}

/// An append that did not commit. Its seq was not published.
#[derive(Debug)]
pub struct WriteFault {
    pub error: io::Error,
}

impl Journal {
    pub(super) fn healthy(&self) -> io::Result<()> {
        self.disk.healthy()
    }

    /// Opens the journal at `path`, creating it with mode 0600 if missing, visiting
    /// validated events in file order. Bytes after the last `\n` are a torn tail: they are
    /// truncated away and logged. Any complete line that is not a journal event, or
    /// whose seq is not the previous one plus 1 (starting at 1), is an error, so the
    /// caller quarantines the session (DESIGN §3.4.4).
    pub(super) fn open(
        path: &Path,
        gate: Arc<SyncGate>,
        mut visit: impl FnMut(JournalEvent),
    ) -> Result<Journal> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("cannot open {}", path.display()))?;
        let dir = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let len = file.metadata()?.len();
        let mut reader = BufReader::new(&file);
        let mut head = 0;
        let mut end = 0u64;
        let mut offsets = Vec::new();
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
                break;
            }
            let ev: JournalEvent = serde_json::from_slice(&line[..n - 1]).with_context(|| {
                format!(
                    "{}: the line at byte {end} is not a journal event",
                    path.display()
                )
            })?;
            let due = head + 1;
            if ev.seq != due {
                bail!(
                    "{}: the line at byte {end} has seq {} where {due} is due",
                    path.display(),
                    ev.seq
                );
            }
            end += n as u64;
            head = ev.seq;
            checkpoint(&mut offsets, head, end);
            visit(ev);
        }
        let disk = Arc::new(SyncFile { file, gate });
        if end != len {
            disk.file
                .set_len(end)
                .inspect_err(|e| disk.latch_write_eio(e))
                .context("truncating torn journal tail")?;
        }
        disk.sync(
            SyncOp::Prefix,
            #[cfg(test)]
            false,
        )
        .context("syncing recovered journal")?;
        File::open(dir)?
            .sync_all()
            .context("syncing journal directory")?;
        Ok(Journal {
            disk,
            end,
            head,
            offsets,
            truncate_before_write: false,
            #[cfg(any(test, debug_assertions))]
            fail_at: fail_at_from_env(),
            #[cfg(test)]
            fail_sync: false,
            #[cfg(test)]
            fail_background_sync: false,
            #[cfg(test)]
            pause_question: None,
            #[cfg(test)]
            fail_truncate: false,
            #[cfg(test)]
            fail_shrink_sync: false,
        })
    }

    /// One pwrite per event. A human-answerable question also requires a successful
    /// fdatasync before its seq can advance the head or reach a viewer.
    pub fn append(&mut self, body: EventBody, ts: u64) -> Result<JournalEvent, WriteFault> {
        let ev = JournalEvent {
            seq: self.head + 1,
            ts,
            body,
        };
        if self.truncate_before_write {
            self.shrink().map_err(|error| WriteFault { error })?;
        }
        // Never make ordinary updates wait for a background fdatasync.
        self.disk.healthy().map_err(|error| WriteFault { error })?;
        let bytes = line::encode(&ev);
        if let Err(error) = self.write(&bytes) {
            self.disk.latch_write_eio(&error);
            return Err(self.rollback(error));
        }
        if is_question(&ev.body)
            && let Err(error) = self.sync_question()
        {
            return Err(self.rollback(error));
        }
        self.end += bytes.len() as u64;
        self.head = ev.seq;
        checkpoint(&mut self.offsets, self.head, self.end);
        Ok(ev)
    }

    fn rollback(&mut self, error: io::Error) -> WriteFault {
        self.truncate_before_write = true;
        if let Err(e) = self.shrink() {
            error!(error = %e, end = self.end, "cannot durably roll back failed journal append");
        }
        WriteFault { error }
    }

    fn shrink(&mut self) -> io::Result<()> {
        #[cfg(test)]
        if self.fail_truncate {
            return Err(io::Error::other("injected truncate failure"));
        }
        self.disk
            .file
            .set_len(self.end)
            .inspect_err(|e| self.disk.latch_write_eio(e))?;
        // Even on a poisoned fd we must commit removal of a never-offered
        // question. This sync cannot certify the preceding data.
        self.disk.sync(
            SyncOp::Shrink,
            #[cfg(test)]
            self.fail_shrink_sync,
        )?;
        self.truncate_before_write = false;
        Ok(())
    }

    fn sync_question(&mut self) -> io::Result<()> {
        self.disk.sync(
            SyncOp::Question(
                #[cfg(test)]
                self.pause_question.take(),
            ),
            #[cfg(test)]
            self.fail_sync,
        )
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
        for body in lines {
            let ev = self.append(body, ts)?;
            facts.apply(&ev);
            written.push(ev);
        }
        Ok(written)
    }

    /// Off-thread sync, sharing the question barrier's writeback-error state.
    pub fn sync(&self) -> JoinHandle<io::Result<()>> {
        let disk = self.disk.clone();
        #[cfg(test)]
        let fail = self.fail_background_sync;
        tokio::task::spawn_blocking(move || {
            disk.sync(
                SyncOp::Prefix,
                #[cfg(test)]
                fail,
            )
        })
    }

    /// Complete a pending rollback and sync the journal on orderly shutdown.
    pub fn close(mut self) -> JoinHandle<io::Result<()>> {
        tokio::task::spawn_blocking(move || {
            if self.truncate_before_write {
                self.shrink()?;
            }
            self.disk.sync(
                SyncOp::Prefix,
                #[cfg(test)]
                self.fail_background_sync,
            )
        })
    }

    /// The head seq: the seq of the last event written, 0 for an empty journal.
    pub fn len(&self) -> u64 {
        self.head
    }

    /// An offset hint after `checkpoint_seq(since)`, or zero if not indexed.
    pub fn replay_offset(&self, since: u64) -> u64 {
        let block = checkpoint_seq(since) / CHECKPOINT_STRIDE;
        block
            .checked_sub(1)
            .and_then(|i| usize::try_from(i).ok())
            .and_then(|i| self.offsets.get(i).copied())
            .unwrap_or(0)
    }

    /// One `pwrite(2)` of `bytes` at the end of the last complete line; a short write
    /// is an error.
    fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        #[cfg(any(test, debug_assertions))]
        if self.fail_at == Some(self.head + 1) {
            self.fail_at = None;
            self.disk
                .file
                .write_at(&bytes[..bytes.len() / 2], self.end)?;
            return Err(io::Error::other("injected journal write fault"));
        }
        let n = self.disk.file.write_at(bytes, self.end)?;
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

fn is_question(body: &EventBody) -> bool {
    matches!(
        body,
        EventBody::Permission { .. } | EventBody::Elicitation { .. }
    )
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
            let ev = j.append(b.clone(), j.len() + 1).unwrap();
            facts.apply(&ev);
        }
        facts
    }

    fn open_events(path: &Path) -> Result<(Journal, Vec<JournalEvent>)> {
        let mut events = Vec::new();
        let journal = Journal::open(path, Arc::default(), |ev| events.push(ev))?;
        Ok((journal, events))
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
        let (mut j, events) = open_events(&path).unwrap();
        assert!(events.is_empty());
        assert_eq!(j.len(), 0);
        let notice = EventBody::Notice {
            level: wb_proto::journal::NoticeLevel::Info,
            text: "revived via session/resume".into(),
        };
        let bodies = [spawn(), session(), prompt(), chunk("héllo\n"), notice];
        let mut written = Vec::new();
        for (i, b) in bodies.iter().enumerate() {
            let ev = j.append(b.clone(), 100 + i as u64).unwrap();
            assert_eq!((ev.seq, ev.ts, &ev.body), (i as u64 + 1, 100 + i as u64, b));
            written.push(ev);
        }
        assert_eq!(j.len(), 5);
        drop(j);

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let expected: Vec<u8> = written.iter().flat_map(line::encode).collect();
        assert_eq!(fs::read(&path).unwrap(), expected);

        let (j, events) = open_events(&path).unwrap();
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

    /// Held by the tests that reach the torn-tail `warn!`. tracing caches a callsite's interest
    /// process-wide, so a first hit from a thread with no subscriber, racing the subscriber
    /// below, could leave that `warn!` disabled for it.
    static TORN_WARN: Mutex<()> = Mutex::new(());

    #[test]
    fn a_torn_final_line_is_truncated_and_logged() {
        let _torn = crate::lock(&TORN_WARN);
        let path = fresh_dir("torn").join("s.jsonl");
        let mut j = Journal::open(&path, Arc::default(), drop).unwrap();
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
            tracing::subscriber::with_default(subscriber, || open_events(&path)).unwrap();
        let logged = String::from_utf8(crate::lock(&logs.0).clone()).unwrap();
        assert!(logged.contains("torn journal tail"), "{logged}");
        assert_eq!(events.len(), 2);
        assert_eq!(j.len(), 2);
        assert_eq!(fs::read(&path).unwrap(), good);

        let ev = j.append(prompt(), 3).unwrap();
        assert_eq!(ev.seq, 3);
        let (_, events) = open_events(&path).unwrap();
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
            assert!(
                Journal::open(&path, Arc::default(), drop).is_err(),
                "{name} loaded"
            );
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
        let mut j = Journal::open(&path, Arc::default(), drop).unwrap();
        let mut live = write_all(&mut j, &[spawn(), session()]);
        let before = fs::read(&path).unwrap();

        j.fail_at = Some(3);
        let fault = j.append(chunk(&"x".repeat(1000)), 3).unwrap_err();
        assert_eq!(fault.error.to_string(), "injected journal write fault");
        assert_eq!(
            fs::read(&path).unwrap(),
            before,
            "the half-written line was truncated away"
        );
        assert_eq!(j.len(), 2);

        let mut seqs = vec![1, 2];
        for b in [prompt(), chunk("after")] {
            let ev = j.append(b, 9).unwrap();
            live.apply(&ev);
            seqs.push(ev.seq);
        }
        assert_eq!(seqs, [1, 2, 3, 4]);

        let (j, events) = open_events(&path).unwrap();
        assert_eq!(j.len(), 4);
        assert_eq!(events[2].body, prompt());
        assert_eq!(
            fold(&events),
            live,
            "the live facts are the fold of the disk"
        );
    }

    #[test]
    fn replay_crosses_checkpoints_after_a_write_fault_and_reload() {
        let path = fresh_dir("seek").join("s.jsonl");
        let mut j = Journal::open(&path, Arc::default(), drop).unwrap();
        for seq in 1..=2 * CHECKPOINT_STRIDE + 2 {
            if seq == CHECKPOINT_STRIDE {
                j.fail_at = Some(seq);
                assert!(j.append(chunk(&"x".repeat(5000)), seq).is_err());
            }
            j.append(prompt(), seq).unwrap();
        }
        let check = |j: &Journal| {
            for since in [0, CHECKPOINT_STRIDE - 1, CHECKPOINT_STRIDE, j.len() - 1] {
                let replay = super::super::replay::scan(
                    &path,
                    j.replay_offset(since),
                    since,
                    j.len(),
                    &[],
                    usize::MAX,
                )
                .unwrap();
                assert!(replay.events.iter().map(|e| e.seq).eq(since + 1..=j.len()));
            }
        };
        check(&j);
        drop(j);
        check(&Journal::open(&path, Arc::default(), drop).unwrap());
    }

    #[test]
    fn stale_replay_checkpoint_cannot_skip_requested_records() {
        use super::super::replay::scan;

        let path = fresh_dir("seek-shift").join("s.jsonl");
        let since = CHECKPOINT_STRIDE;
        let head = since + 2;
        let mut journal = Journal::open(&path, Arc::default(), drop).unwrap();
        for seq in 1..=head {
            journal.append(prompt(), seq).unwrap();
        }
        let boundary = journal.replay_offset(since) as usize;
        drop(journal);
        let compact = fs::read(&path).unwrap();
        let tail = &compact[boundary..];
        let next_len = tail.iter().position(|&b| b == b'\n').unwrap() + 1;
        let full = scan(&path, 0, since, head, &[], usize::MAX).unwrap();
        assert!(full.events.iter().map(|e| e.seq).eq(since + 1..=head));

        // Index a longer first record, then shorten it without changing any seq.
        // The stale offset lands inside record 129, on record 130, or at EOF.
        for shift in [1, next_len, tail.len()] {
            let mut padded = vec![b' '; shift];
            padded.extend_from_slice(&compact);
            fs::write(&path, padded).unwrap();
            let journal = Journal::open(&path, Arc::default(), drop).unwrap();
            let offset = journal.replay_offset(since);
            assert_eq!(offset as usize, boundary + shift);
            fs::write(&path, &compact).unwrap();
            assert_eq!(
                scan(&path, offset, since, head, &[], usize::MAX).unwrap(),
                full
            );
        }
    }

    #[test]
    fn missing_replay_checkpoint_scans_from_zero() {
        let path = fresh_dir("seek-missing").join("s.jsonl");
        let mut journal = Journal::open(&path, Arc::default(), drop).unwrap();
        let since = CHECKPOINT_STRIDE;
        for seq in 1..=since + 1 {
            journal.append(prompt(), seq).unwrap();
        }
        journal.offsets.clear();
        let offset = journal.replay_offset(since);
        assert_eq!(offset, 0);
        let replay =
            super::super::replay::scan(&path, offset, since, journal.len(), &[], usize::MAX)
                .unwrap();
        assert!(replay.events.iter().map(|e| e.seq).eq([since + 1]));
    }

    /// A checkpoint followed by one requested, complete record.
    fn journal_with_indexed_tail(name: &str) -> (PathBuf, u64) {
        let path = fresh_dir(name).join("s.jsonl");
        let mut journal = Journal::open(&path, Arc::default(), drop).unwrap();
        for seq in 1..=CHECKPOINT_STRIDE + 1 {
            journal.append(prompt(), seq).unwrap();
        }
        (path, journal.replay_offset(CHECKPOINT_STRIDE))
    }

    #[test]
    fn indexed_replay_rejects_junk_before_expected_json() {
        let (path, offset) = journal_with_indexed_tail("seek-junk");
        let mut bytes = fs::read(&path).unwrap();
        bytes.insert(offset as usize, b'!');
        fs::write(&path, bytes).unwrap();

        let since = CHECKPOINT_STRIDE;
        let scan = |at| super::super::replay::scan(&path, at, since, since + 1, &[], usize::MAX);
        let from_zero = scan(0).unwrap_err();
        let at_json = scan(offset + 1).unwrap_err();
        assert_eq!(at_json.to_string(), from_zero.to_string());
    }

    #[test]
    fn indexed_replay_ignores_expected_json_without_final_newline() {
        let (path, offset) = journal_with_indexed_tail("seek-no-newline");
        let file = OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(file.metadata().unwrap().len() - 1).unwrap();

        let since = CHECKPOINT_STRIDE;
        let replay =
            super::super::replay::scan(&path, offset, since, since + 1, &[], usize::MAX).unwrap();
        assert!(replay.events.is_empty());
    }

    #[test]
    fn bytes_left_by_a_failed_truncation_heal() {
        let _torn = crate::lock(&TORN_WARN);
        let path = fresh_dir("heal").join("s.jsonl");
        let mut j = Journal::open(&path, Arc::default(), drop).unwrap();
        write_all(&mut j, &[spawn()]);
        let end = fs::metadata(&path).unwrap().len();
        let junk = br#"{"seq":2,"ts":2,"e":"update","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"#;
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .write_at(junk, end)
            .unwrap();

        let ev2 = j.append(session(), 2).unwrap();
        assert!(
            fs::metadata(&path).unwrap().len() > j.end,
            "junk is left after the line"
        );
        drop(j);
        let (j, events) = open_events(&path).unwrap();
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
        let (mut j, events) = open_events(path).unwrap();
        let mut facts = fold(&events);
        let res = j.normalise(&mut facts, 99);
        (j, facts, res)
    }

    #[test]
    fn normalisation_appends_exactly_the_death_invariant() {
        let path = fresh_dir("norm").join("s.jsonl");
        let mut j = Journal::open(&path, Arc::default(), drop).unwrap();
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
        let mut j = Journal::open(&path, Arc::default(), drop).unwrap();
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
            let mut j = Journal::open(&path, Arc::default(), drop).unwrap();
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
            let mut j = Journal::open(&path, Arc::default(), drop).unwrap();
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
        let mut j = Journal::open(&path, Arc::default(), drop).unwrap();
        write_all(&mut j, &mid_turn());
        drop(j);
        let before = fs::read(&path).unwrap();

        let (mut j, events) = open_events(&path).unwrap();
        let mut facts = fold(&events);
        j.fail_at = Some(7);
        assert!(j.normalise(&mut facts, 99).is_err());
        assert_eq!(facts.head_seq, 6);
        assert_eq!(facts.pending.iter().map(|p| p.req).collect::<Vec<_>>(), [5]);
        assert!(facts.running);
        // Inspect the active writer without opening a second append handle.
        let on_disk = fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect::<Vec<_>>();
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

    #[test]
    fn failed_question_shrink_stays_pending_until_synced() {
        for fail_truncate in [false, true] {
            let path = fresh_dir(&format!("rollback-{fail_truncate}")).join("s.jsonl");
            let mut j = Journal::open(&path, Arc::default(), drop).unwrap();
            j.append(spawn(), 1).unwrap();
            let prefix = fs::read(&path).unwrap();
            j.fail_sync = true;
            j.fail_truncate = fail_truncate;
            j.fail_shrink_sync = !fail_truncate;
            let q = EventBody::Elicitation { request: json!({}) };
            assert!(j.append(q, 2).is_err());
            assert!(
                j.truncate_before_write,
                "missing rollback ({fail_truncate})"
            );
            j.fail_truncate = false;
            j.fail_shrink_sync = false;
            j.fail_sync = false;
            assert!(j.append(prompt(), 2).is_err(), "uncertain prefix accepted");
            assert!(!j.truncate_before_write);
            assert_eq!(fs::read(&path).unwrap(), prefix);
            drop(j);
            let (mut recovered, events) = open_events(&path).unwrap();
            assert_eq!(events.len(), 1, "replayed a never-offered question");
            assert_eq!(recovered.append(prompt(), 3).unwrap().seq, 2);
        }
    }

    #[tokio::test]
    async fn sync_reaches_the_disk_off_the_caller() {
        let path = fresh_dir("sync").join("s.jsonl");
        let mut j = Journal::open(&path, Arc::default(), drop).unwrap();
        write_all(&mut j, &[spawn()]);
        j.sync().await.unwrap().unwrap();
    }
}
