//! Replay of a journal for `acp.open{since}` (DESIGN §3.4.4, H-8): coalesced,
//! truncated to a byte cap, with the announcing events of pending requests added back,
//! as one stream in ascending seq order.

use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, BufRead, BufReader};
use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::Value;
use wb_proto::journal::{EventBody, JournalEvent};

/// The `sessionUpdate` variants whose text runs are coalesced.
const CHUNKS: [&str; 3] = [
    "agent_message_chunk",
    "agent_thought_chunk",
    "user_message_chunk",
];

/// The events to send after the `ok` of `acp.open`, then `acp.replayed`.
#[derive(Debug, PartialEq)]
pub struct Replay {
    /// Pinned and kept events in strictly ascending seq order.
    pub events: Vec<JournalEvent>,
    /// The first seq covered by the first kept event, or `since + 1` if nothing was
    /// trimmed.
    pub from: u64,
    /// Events were trimmed to fit `cap`.
    pub truncated: bool,
}

/// Reads the journal at `path` up to seq `head` and builds the replay of the events
/// after `since`. `pending` holds the seqs of the currently pending requests' announcing
/// events; `cap` is the byte budget (`ACP_REPLAY_MAX`). Blocking: run it in
/// `spawn_blocking`.
///
/// A `since` above `head` counts as 0; the caller reports that as `reset`. Lines after
/// `head` are never read, so a line being appended meanwhile does not matter.
pub fn scan(path: &Path, since: u64, head: u64, pending: &[u64], cap: usize) -> Result<Replay> {
    let since = if since > head { 0 } else { since };
    let mut replay = Builder::new(since, cap);
    if since < head {
        let file = File::open(path).with_context(|| format!("cannot open {}", path.display()))?;
        let mut reader = BufReader::new(file);
        let mut line = Vec::new();
        let mut at = 0usize;
        loop {
            line.clear();
            let n = reader
                .read_until(b'\n', &mut line)
                .with_context(|| format!("cannot read {}", path.display()))?;
            if line.last() != Some(&b'\n') {
                break;
            }
            let bad = || {
                format!(
                    "{}: the line at byte {at} is not a journal event",
                    path.display()
                )
            };
            let text = &line[..n - 1];
            let seq = serde_json::from_slice::<Seq>(text).with_context(bad)?.seq;
            if seq > head {
                break;
            }
            if seq > since {
                let ev: JournalEvent = serde_json::from_slice(text).with_context(bad)?;
                if pending.contains(&seq) {
                    replay.pin(ev);
                } else {
                    replay.push(ev);
                }
            }
            if seq == head {
                break;
            }
            at += n;
        }
    }
    Ok(replay.finish())
}

/// The seq of a line, read without building the rest of the event.
#[derive(Deserialize)]
struct Seq {
    seq: u64,
}

/// An event bound for the replay. For a coalesced run, `ev` carries the run's last seq
/// and ts, `first` is its first seq and `text` the length of the merged text.
struct Item {
    ev: JournalEvent,
    first: u64,
    text: usize,
}

impl Item {
    fn new(ev: JournalEvent) -> Item {
        let text = chunk_text(&ev.body).map_or(0, str::len);
        Item {
            first: ev.seq,
            ev,
            text,
        }
    }

    /// Merges `ev` into this run if both are text chunks of the same variant, message
    /// and session, and the merged text stays within `cap`, so no merged event outgrows
    /// the replay.
    fn absorb(&mut self, ev: &JournalEvent, cap: usize) -> bool {
        let (Some(add), Some(_)) = (chunk_text(&ev.body), chunk_text(&self.ev.body)) else {
            return false;
        };
        let (
            EventBody::Update {
                update: a,
                session_id: sa,
            },
            EventBody::Update {
                update: b,
                session_id: sb,
            },
        ) = (&mut self.ev.body, &ev.body)
        else {
            return false;
        };
        if sa != sb
            || a.get("sessionUpdate") != b.get("sessionUpdate")
            || message_id(a) != message_id(b)
            || self.text + add.len() > cap
        {
            return false;
        }
        if let Some(Value::String(t)) = a.get_mut("content").and_then(|c| c.get_mut("text")) {
            t.push_str(add);
        }
        self.text += add.len();
        self.ev.seq = ev.seq;
        self.ev.ts = ev.ts;
        true
    }
}

/// The text of a text chunk update, `None` for any other event.
fn chunk_text(body: &EventBody) -> Option<&str> {
    let EventBody::Update { update, .. } = body else {
        return None;
    };
    let variant = update.get("sessionUpdate")?.as_str()?;
    let content = update.get("content")?;
    if !CHUNKS.contains(&variant) || content.get("type")?.as_str()? != "text" {
        return None;
    }
    content.get("text")?.as_str()
}

/// A chunk's `messageId`; null counts as absent.
fn message_id(update: &Value) -> Option<&Value> {
    update.get("messageId").filter(|v| !v.is_null())
}

/// Builds the replay as the lines stream past: coalesces, keeps the newest events
/// within the budget and holds the pinned events apart (10 §7.9, with H-8's order).
struct Builder {
    since: u64,
    cap: usize,
    /// The run still open for coalescing.
    run: Option<Item>,
    /// Closed items with their encoded size, oldest first.
    kept: VecDeque<(Item, usize)>,
    kept_bytes: usize,
    pinned: Vec<JournalEvent>,
    pinned_bytes: usize,
    truncated: bool,
}

impl Builder {
    fn new(since: u64, cap: usize) -> Builder {
        Builder {
            since,
            cap,
            run: None,
            kept: VecDeque::new(),
            kept_bytes: 0,
            pinned: Vec::new(),
            pinned_bytes: 0,
            truncated: false,
        }
    }

    fn push(&mut self, ev: JournalEvent) {
        // An unknown event has no payload to send (M3-P).
        if ev.body == EventBody::Unknown {
            return;
        }
        if let Some(run) = &mut self.run
            && run.absorb(&ev, self.cap)
        {
            return;
        }
        self.close_run();
        self.run = Some(Item::new(ev));
    }

    /// A pending request's announcing event: always sent, at its own seq position, and
    /// its bytes come off the budget of the rest.
    fn pin(&mut self, ev: JournalEvent) {
        self.close_run();
        self.pinned_bytes += encoded_len(&ev);
        self.pinned.push(ev);
        self.trim();
    }

    fn close_run(&mut self) {
        if let Some(item) = self.run.take() {
            let bytes = encoded_len(&item.ev);
            self.kept_bytes += bytes;
            self.kept.push_back((item, bytes));
            self.trim();
        }
    }

    /// Drops the oldest kept items while they exceed the budget; the newest stays.
    fn trim(&mut self) {
        let budget = self.cap.saturating_sub(self.pinned_bytes);
        while self.kept.len() > 1 && self.kept_bytes > budget {
            if let Some((_, bytes)) = self.kept.pop_front() {
                self.kept_bytes -= bytes;
                self.truncated = true;
            }
        }
    }

    fn finish(mut self) -> Replay {
        self.close_run();
        let from = match self.kept.front() {
            Some((item, _)) if self.truncated => item.first,
            _ => self.since + 1,
        };
        let mut events = Vec::with_capacity(self.kept.len() + self.pinned.len());
        let mut pinned = self.pinned.into_iter().peekable();
        for (item, _) in self.kept {
            while let Some(p) = pinned.next_if(|p| p.seq < item.ev.seq) {
                events.push(p);
            }
            events.push(item.ev);
        }
        events.extend(pinned);
        Replay {
            events,
            from,
            truncated: self.truncated,
        }
    }
}

/// The length of `ev` as compact JSON.
fn encoded_len(ev: &JournalEvent) -> usize {
    struct Count(usize);
    impl io::Write for Count {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.0 += b.len();
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count(0);
    serde_json::to_writer(&mut count, ev).expect("journal events serialize to JSON");
    count.0
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use serde_json::json;
    use wb_proto::journal::NoticeLevel;
    use wb_proto::line;

    use super::*;

    const BIG: usize = 1 << 20;

    fn fresh_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wb-replay-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir(&dir).unwrap();
        dir
    }

    fn events(bodies: Vec<EventBody>) -> Vec<JournalEvent> {
        bodies
            .into_iter()
            .enumerate()
            .map(|(i, body)| JournalEvent {
                seq: i as u64 + 1,
                ts: 1000 + i as u64,
                body,
            })
            .collect()
    }

    /// Writes `evs` as a journal and returns its path.
    fn journal(name: &str, evs: &[JournalEvent]) -> PathBuf {
        let path = fresh_dir(name).join("s.jsonl");
        let bytes: Vec<u8> = evs.iter().flat_map(line::encode).collect();
        fs::write(&path, bytes).unwrap();
        path
    }

    fn update(v: Value) -> EventBody {
        EventBody::Update {
            update: v,
            session_id: None,
        }
    }

    fn chunk(variant: &str, id: Option<&str>, text: &str) -> EventBody {
        let mut u = json!({"sessionUpdate": variant, "content": {"type": "text", "text": text}});
        if let Some(id) = id {
            u["messageId"] = json!(id);
        }
        update(u)
    }

    fn msg(id: Option<&str>, text: &str) -> EventBody {
        chunk("agent_message_chunk", id, text)
    }

    fn notice(text: &str) -> EventBody {
        EventBody::Notice {
            level: NoticeLevel::Info,
            text: text.into(),
        }
    }

    fn seqs(r: &Replay) -> Vec<u64> {
        r.events.iter().map(|e| e.seq).collect()
    }

    fn text(ev: &JournalEvent) -> &str {
        chunk_text(&ev.body).unwrap()
    }

    #[test]
    fn a_run_of_one_message_is_coalesced() {
        let evs = events(vec![
            EventBody::Prompt {
                prompt: vec![json!({"type": "text", "text": "go"})],
            },
            msg(Some("m1"), "a"),
            msg(Some("m1"), "b"),
            msg(Some("m1"), "c"),
            EventBody::TurnEnd {
                stop_reason: "end_turn".into(),
            },
        ]);
        let path = journal("coalesce", &evs);
        let r = scan(&path, 0, 5, &[], BIG).unwrap();
        assert_eq!(seqs(&r), [1, 4, 5]);
        assert_eq!(r.events[1].ts, 1003, "the run's last ts");
        assert_eq!(r.events[1].body, msg(Some("m1"), "abc"));
        assert_eq!((r.from, r.truncated), (1, false));
    }

    #[test]
    fn a_different_id_variant_session_or_content_breaks_the_run() {
        let image = update(
            json!({"sessionUpdate": "agent_message_chunk", "messageId": "m2",
            "content": {"type": "image", "data": "", "mimeType": "image/png"}}),
        );
        let other_session = EventBody::Update {
            update: json!({"sessionUpdate": "agent_message_chunk", "messageId": "m3",
                "content": {"type": "text", "text": "z"}}),
            session_id: Some("other".into()),
        };
        let evs = events(vec![
            msg(Some("m1"), "a"),                          // 1
            msg(Some("m2"), "b"),                          // 2
            image,                                         // 3
            msg(Some("m2"), "c"),                          // 4
            chunk("agent_thought_chunk", Some("m2"), "d"), // 5
            chunk("user_message_chunk", Some("m2"), "e"),  // 6
            msg(Some("m3"), "f"),                          // 7
            other_session,                                 // 8
            msg(None, "g"),                                // 9
            update(
                json!({"sessionUpdate": "agent_message_chunk", "messageId": null,
                "content": {"type": "text", "text": "h"}}),
            ), // 10
        ]);
        let path = journal("breaks", &evs);
        let r = scan(&path, 0, 10, &[], BIG).unwrap();
        assert_eq!(seqs(&r), [1, 2, 3, 4, 5, 6, 7, 8, 10]);
        assert_eq!(text(&r.events[8]), "gh", "absent and null ids are the same");
    }

    #[test]
    fn truncation_keeps_the_newest_within_the_cap() {
        let evs = events((0..10).map(|i| notice(&format!("n{i}"))).collect());
        let path = journal("trunc", &evs);
        let cap: usize = evs[7..].iter().map(encoded_len).sum();
        let r = scan(&path, 0, 10, &[], cap).unwrap();
        assert_eq!(seqs(&r), [8, 9, 10]);
        assert_eq!((r.from, r.truncated), (8, true));

        let r = scan(&path, 0, 10, &[], cap - 1).unwrap();
        assert_eq!(seqs(&r), [9, 10]);
        assert_eq!(r.from, 9);

        let r = scan(&path, 4, 10, &[], BIG).unwrap();
        assert_eq!(seqs(&r), [5, 6, 7, 8, 9, 10]);
        assert_eq!((r.from, r.truncated), (5, false));
    }

    #[test]
    fn the_newest_event_is_kept_even_over_the_cap() {
        let evs = events(vec![notice("a"), notice(&"x".repeat(5000))]);
        let path = journal("newest", &evs);
        let r = scan(&path, 0, 2, &[], 100).unwrap();
        assert_eq!(seqs(&r), [2]);
        assert_eq!((r.from, r.truncated), (2, true));
    }

    #[test]
    fn from_is_the_first_seq_of_a_coalesced_first_kept_event() {
        let evs = events(vec![
            notice("a"),
            notice("b"),
            notice("c"),
            msg(Some("m"), "x"),
            msg(Some("m"), "y"),
            msg(Some("m"), "z"),
            notice("d"),
        ]);
        let path = journal("from-run", &evs);
        let merged = JournalEvent {
            seq: 6,
            ts: 1005,
            body: msg(Some("m"), "xyz"),
        };
        let cap = encoded_len(&merged) + encoded_len(&evs[6]);
        let r = scan(&path, 0, 7, &[], cap).unwrap();
        assert_eq!(r.events, [merged, evs[6].clone()]);
        assert_eq!((r.from, r.truncated), (4, true));
    }

    #[test]
    fn a_pinned_event_below_from_comes_back_in_ascending_order() {
        let mut bodies: Vec<EventBody> = (1..=20).map(|i| notice(&format!("n{i:02}"))).collect();
        bodies[4] = EventBody::Permission {
            tool_call: json!({"toolCallId": "t5", "title": "Run ls"}),
            options: vec![json!({"optionId": "ok", "kind": "allow_once"})],
        };
        bodies[14] = EventBody::Elicitation {
            request: json!({"mode": "form", "message": "Colour?"}),
        };
        let evs = events(bodies);
        let path = journal("pinned", &evs);
        let pinned_bytes = encoded_len(&evs[4]) + encoded_len(&evs[14]);
        let rest: usize = evs[11..]
            .iter()
            .filter(|e| e.seq != 15)
            .map(encoded_len)
            .sum();
        let r = scan(&path, 0, 20, &[5, 15], pinned_bytes + rest).unwrap();
        assert_eq!(seqs(&r), [5, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
        assert_eq!((r.from, r.truncated), (12, true));
        assert_eq!(r.events[0], evs[4]);
        assert_eq!(r.events[4], evs[14]);
    }

    #[test]
    fn a_pinned_event_breaks_a_run_and_keeps_its_position() {
        let evs = events(vec![
            msg(Some("m"), "a"),
            EventBody::Permission {
                tool_call: json!({"toolCallId": "t"}),
                options: vec![],
            },
            msg(Some("m"), "b"),
        ]);
        let path = journal("pin-run", &evs);
        let r = scan(&path, 0, 3, &[2], BIG).unwrap();
        assert_eq!(seqs(&r), [1, 2, 3]);
        assert_eq!((text(&r.events[0]), text(&r.events[2])), ("a", "b"));
    }

    #[test]
    fn pinned_events_the_client_holds_are_not_sent() {
        let evs = events((1..=10).map(|i| notice(&i.to_string())).collect());
        let path = journal("pin-since", &evs);
        let r = scan(&path, 6, 10, &[5], BIG).unwrap();
        assert_eq!(seqs(&r), [7, 8, 9, 10]);
        assert_eq!(r.from, 7);
    }

    #[test]
    fn since_above_head_replays_from_the_start() {
        let evs = events(vec![notice("a"), notice("b"), notice("c")]);
        let path = journal("reset", &evs);
        let r = scan(&path, 50, 3, &[], BIG).unwrap();
        assert_eq!(r.events, evs);
        assert_eq!((r.from, r.truncated), (1, false));
    }

    #[test]
    fn nothing_after_since_reads_nothing() {
        let missing = fresh_dir("none").join("missing.jsonl");
        let r = scan(&missing, 7, 7, &[3], BIG).unwrap();
        assert_eq!(
            r,
            Replay {
                events: vec![],
                from: 8,
                truncated: false
            }
        );
        assert!(scan(&missing, 0, 7, &[], BIG).is_err());
    }

    #[test]
    fn a_stop_at_head_ignores_later_and_partial_lines() {
        let evs = events((1..=4).map(|i| notice(&i.to_string())).collect());
        let path = journal("stop", &evs);
        let mut bytes = fs::read(&path).unwrap();
        bytes.extend_from_slice(br#"{"seq":5,"ts":1,"e":"not"#);
        fs::write(&path, &bytes).unwrap();
        assert_eq!(seqs(&scan(&path, 0, 3, &[], BIG).unwrap()), [1, 2, 3]);
        assert_eq!(seqs(&scan(&path, 0, 4, &[], BIG).unwrap()), [1, 2, 3, 4]);

        bytes.extend_from_slice(b"garbage\n");
        fs::write(&path, &bytes).unwrap();
        assert_eq!(seqs(&scan(&path, 0, 4, &[], BIG).unwrap()), [1, 2, 3, 4]);
    }

    #[test]
    fn a_bad_line_before_head_is_an_error() {
        let evs = events(vec![notice("a")]);
        let path = journal("bad", &evs);
        let mut bytes = b"garbage\n".to_vec();
        bytes.extend(fs::read(&path).unwrap());
        fs::write(&path, &bytes).unwrap();
        assert!(scan(&path, 0, 1, &[], BIG).is_err());
    }

    #[test]
    fn unknown_events_are_not_sent() {
        let evs = events(vec![msg(Some("m"), "a"), notice("x"), msg(Some("m"), "b")]);
        let path = journal("unknown", &[]);
        let mut bytes = line::encode(&evs[0]);
        bytes.extend_from_slice(b"{\"seq\":2,\"ts\":1001,\"e\":\"from_the_future\",\"x\":1}\n");
        bytes.extend(line::encode(&evs[2]));
        fs::write(&path, &bytes).unwrap();

        let r = scan(&path, 0, 3, &[], BIG).unwrap();
        assert_eq!(seqs(&r), [3]);
        assert_eq!(text(&r.events[0]), "ab");
    }

    #[test]
    fn a_run_stops_growing_at_the_cap() {
        let block = "x".repeat(1000);
        let evs = events((0..6).map(|_| msg(Some("m"), &block)).collect());
        let path = journal("run-cap", &evs);
        let r = scan(&path, 0, 6, &[], 2500).unwrap();
        assert_eq!(seqs(&r), [6]);
        assert_eq!(text(&r.events[0]).len(), 2000);
        assert_eq!((r.from, r.truncated), (5, true));
    }
}
