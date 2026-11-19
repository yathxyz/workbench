# Hub profile: Linux x86-64, release build

## Reproduce

From the repo root, `nix develop`, then `cargo build --release -p wb-hub --bin wb-hub`. Each row below is a separate command: `python3 crates/wb-hub/bench/bench.py NAME`. `all` runs all six. To compare binaries use `all --hub /path/to/before --hub /path/to/after --repeat 5`; order alternates AB/BA. Set `PYTHONDONTWRITEBYTECODE=1` for a clean worktree. No installation, new dependency, or access to the production socket/state directory. Every run creates and removes a temporary home, state, config, socket and processes. Generated fixtures, four Tokio workers, warn logging. These are warm filesystem-cache workloads, not cold-storage speed tests.

| NAME | Work per private hub, validation and timing boundaries |
|---|---|
| `stream` | 8 real ACP subprocesses, each with a nested 27-model offering, 1,024 chunks in bursts of 8, 8 interspersed permission requests. One attached client each, two concurrent board watchers. Monotonic time immediately before agent pipe write → decoded viewer event; client answer send → agent stdin read (not the return trip). Check every seq, chunk, selected answer and final watcher state. |
| `large` | One attached agent, 32 turns with two 768 KiB tool results each. Same pipe-write → decoded-client clock; verify all 48 MiB of returned text. |
| `replay` | Restored 8,569,083-byte, 1,284-event journal. 20 fresh attaches at zero and 20 at head minus eight; request send → first decoded event and → replayed marker. Assert every sequence, `from`, truncation, and the exact expected suffix under 4 MiB. |
| `fleet` | 256 restored, detached sessions; 8 with 63,661-byte options, the rest small. Measure first complete list and RSS before that list. 128 durable task changes while issuing 16 lists and 16 watches. Time to decoded snapshots and to the board's update, check task/head and all SIDs. |
| `restore` | 8 ended sessions, 12,512 records, 86,118,102 bytes total, dominated by one tool-heavy history. Process launch → first socket hello; check all folded heads and summaries. |
| `pty` | Bash on a real PTY, 24 input-triggered bursts of 4,096 lines (260 KiB each). Input send → decoded final sentinel, verify every byte including line endings. Includes VT parsing, ring, socket and client, not browser rendering. |

JSONL includes nearest-rank p50/p95/p99, extrema, sample counts, throughput, and startup counters separately from each workload's measured window. CPU and runnable delay are sums from the hub's live threads in `/proc/PID/task/*/schedstat`; runnable delay measures scheduler pressure, **not** mutex wait. `/proc/PID/io` gives logical `rchar/wchar` and storage-accounted `read_bytes/write_bytes`, not bytes on the socket. Agents stay alive until the samples are taken; their CPU and memory are excluded. `VmHWM` is the process high water mark, not a sum of per-session heaps. `--memusage /path/to/glibc/lib/libmemusage.so` counts hub malloc/calloc/realloc calls and glibc's accounted bytes from startup through shutdown, in a separate run. `--trace` counts pwrite64/fdatasync/fsync/futex via `strace -f -c` including children, startup and shutdown. Futex calls include runtime parks/wakes: they do not isolate registry lock contention. No frame times for a daemon. No instruction counts (`perf` unavailable).

## Service attribution (read-only observations)

The prior invocation's systemd accounting is **for the service group**: 5h43m6.652s CPU over 1d19h16m22.737s, peak memory 16.7 GiB, 8.4 GiB read and 133.1 GiB written. There is no historical per-PID breakdown or matching journal byte/sync counter. Neither agent work nor filesystem writeback can be subtracted retrospectively. In particular, 133.1 GiB is not a sum of JSONL line lengths, and a group peak cannot be divided using current RSS.

For a separate, live invocation (PID 2016859), the hub had 8.00 s of user+system CPU versus 419.10 s for its group (~1.9%). Its PSS was 872,569 KiB; group `memory.current` was 4,723,294,208 bytes (~18.9% by this comparison; the latter includes cache and other processes). The group had 26 processes. Live hub threads accounted for 36,089,856 write bytes; `/proc/PID/io` including waited-for children reported 57,266,176, versus 273,719,296 in group `io.stat` for md127. These are different accounting scopes, not an exact percentage. Do not add the md volume and its two mirrored NVMe partitions. The hub had 27 open journal files totaling 1,509,143,526 bytes, largest 244,044,548: **current file lengths**, not lifetime writes. No benchmark ran against the service. The earlier peak and the precise share of the 133.1 GiB remain unattributable without time-series process/group accounting.

## Baseline before changing hub code

Baseline `d8e1ac5cfd`, three private runs per workload. Median of per-run percentiles in ms, not pooled; brackets are min–max across runs. Machine load changed considerably even within a run. The controlled comparison below repeats the baseline interleaved with the final binary.

| Workload | p50 / p95 / p99 (ms) | Throughput | Hub CPU ms [range] | Peak KiB | M alloc calls / MB allocated |
|---|---|---:|---:|---:|---:|
| stream | chunks 2.16 / 7.27 / 11.94; answers 1.88 / 8.19 / 12.90 | 8,759 chunks/s | 899 [883–909] | 11,068 | 7.640 / 803 |
| large | 18.26 / 29.59 / 36.37 | 39.7 MiB/s | 447 [442–452] | 15,828 | .355 / 463 |
| replay | first full 22.97 / 33.13 / 36.91; first recent 5.88 / 8.40 / 8.63 | 101 / 4.74 MiB/s full/recent | 665 [419–696] | 17,908 | .517 / 501 |
| fleet | lists 6.16 / 14.41 / 14.41; watch 6.23 / 20.67 / 20.67; updates 1.23 / 14.54 / 23.00 | 338 changes/s | 168 [165–229] | 32,368 | 1.260 / 248 |
| restore | ready 152 [97–200], one launch/run | 542 MiB/s | 151 [97–165] (startup) | 84,192 at ready | .227 / 353 |
| pty | 5.33 / 10.75 / 16.05 | 38.0 MiB/s | 164 [113–188] | 15,992 | .118 / 279 |

Baseline fleet startup → usable list median 211 ms [141–406], detached RSS 18,576 KiB for 256 sessions including the runtime. Full replay complete 42.78 / 58.00 / 60.52 ms, recent 6.12 / 8.59 / 8.83 ms. All workloads had zero storage-accounted reads from the warm cache. Baseline median logical read/write MB: stream 2.36/2.05, large 52.80/52.81, replay 342.76/.022, fleet <.001/.009 (plus 5.71 MB read at startup), restore 86.13/<.001 at startup, PTY 6.49/.025. Median storage write MB: 2.10, 52.94, 0, .13, 0, 0 respectively. Baseline runnable delay ms: 1,617 / 661 / 496 / 33 / .31 (startup) / .49 respectively.

## Rank before implementation

| Rank | Evidence, expected gain | Cost and correctness risk |
|---:|---|---|
| 1 | Startup kept every parsed event until validating the whole file: 84–87 MiB RSS after restoring 86 MB. Fold as each line validates; keep materialized facts, not historical tool outputs. | Low. A corrupt complete line must still quarantine the session; don't normalize/append until validation succeeds. |
| 2 | 7.64M allocations and 899 ms hub CPU for 8,192 chunks, despite only 216 attached info messages in the first run. Rebuilding two owned snapshots with rich configs to discover a head-only change costs CPU on the delivery path. | Moderate. Deadlines, immediate materialized changes, quiet startup, watcher and viewer eviction semantics must hold. |
| 3 | 343 MB read to replay 20 full and 20 recent cursors; an eight-record catch-up scans 8.57 MB. Seek near the cursor. | Low. Small per-journal offset index; only advance on success and rebuild at open. Must respect epoch resets and cutoff. Does not accelerate `since:0`. |
| 4 | 1.26M allocations and 248 MB allocation traffic in a 256-session list/watch run; each snapshot is 615,799 bytes. Serialize shared summaries without an intermediate JSON tree. | Low. Do not serialize a list under the lock; a watch snapshot and registration must remain gap-free. Does not fix the size of the reply. |
| 5 | 463 MB allocation traffic to deliver 48 MiB of large tool text, including a deep `EventBody` clone per append even when the caller owns the body. Move it instead. | Low. No change to the encoded journal or whether a failed write becomes visible. |
| 6 | PTY moves ~6.4 MB per run; 279 MB allocation traffic includes the VT screen/scrollback and JSON framing, but its burst median was ~5 ms. | Lower priority; profile VT/encoding separately before changing escape holdback or ring behavior. |

Storage was a constraint, not a target for speculative batching: stream produced 2,039,592 journal bytes for 8,464 events; large produced 52,801,904 bytes for 192 events. Separate whole-process traces counted 8,488/32/88 `pwrite64`/`fdatasync`/`fsync` for stream, 195/35/9 for large, 128/384/512 for fleet, 0/1/2 for replay, 0/8/16 for restore, 0/0/6 for PTY. Chunks are **not synced individually**. Fleet also pays for metadata and shutdown. Reducing required appends, durability points, retention or replay fidelity would change the contract.

The stream wrote 5.41 journal bytes per raw chunk-text byte (376,832 raw bytes; envelopes, benchmark timestamps, permissions and other events also count). Large tools wrote 1.05 journal bytes per raw tool-output byte (50,331,648 raw bytes). A byte comparison based on tool text alone therefore misses most of the journal traffic on a small-update workload. Neither ratio estimates the live service's workload mix.

## Changes in commit order

`e15ff5665c` is the harness, on the unmodified daemon. Below, comparisons use five alternating pairs per workload, plus one separate allocator pass per binary where noted. Wall times include real clients, filesystem and scheduler; the scheduler changed speed even while gathering the original baseline.

1. `77cff5a8b4` — fold into private restore state during validation. Nothing publishes until validation succeeds. Tool-history startup HWM 84,248 → 7,564 KiB, CPU 80.8 → 58.9 ms and ready 81.4 → 59.6 ms (ranges 78.7–137.8 and 52.7–95.4).
2. `7effca6413` — seek using a sparse, in-memory sequence-to-file-offset index. One `u64` per 128 committed events plus vector capacity; no on-disk index, new fsyncs or cache of replay packets. Recent first-event p50 2.952 [2.675–3.814] → .484 [.413–.767] ms; logical reads 342,763,321 → 188,793,321 bytes for the mixed 40 attaches. Full first-event p50 9.19 → 10.16 ms, overlapping ranges. This comparison includes the fleet serializer but has no lists or watchers in the measured window.
3. `cd343ca9e7` — immutable shared summaries for list/watch. Capture sorted handles under lock for list; keep watch encoding/enqueue/registration under one lock. No full `serde_json::Value` tree. Fleet CPU 172 [157–197] → 92 [89–94] ms; list p50 6.28 → 4.05 ms; watch p50 6.51 → 4.16 ms. 1,258,056 → 488,222 allocations; 245 → 143 MB. Change-delivery p95 9.14 → 10.19 ms with overlapping ranges (4.83–32.62 and 3.01–118.89); lower CPU does not guarantee better scheduling tails. The replay index was present but there were no attaches.
4. `1ab4dee00b` — distinguish a stream update that only advances the head from a materialized change. Deliver the event immediately; publish the latest head on the existing deadline. Viewer drops still republish immediately, as do state changes; an identical materialized value still defers. Stream CPU 902 [859–919] → 262 [235–314] ms; 7.55M → .76M allocation calls, 794 → 99 MB. Chunk p50 .890 → .429 ms, answer p50 .794 → .736 ms (overlap). Throughput 9,590 → 9,712 chunks/s: this workload deliberately paces the agents.
5. `472e43ea12` — move owned bodies into journal records instead of cloning every JSON subtree. The append still commits to disk before publishing. Large-output allocations 440.7 → 390.1 MB (50.6 MB eliminated for 48 MiB raw output), CPU 416 [411–447] → 381 [359–401] ms. Delivery p50 17.01 → 17.57 ms (overlapping ranges); p95 30.13 → 23.67 ms. Disk bytes unchanged.

## Final interleaved comparison: original vs all five changes

Same harness and release compiler (rustc 1.98.1), private instances, five AB/BA pairs for each workload. B = original, F = final. Wall-clock samples per binary: 40,960 chunks, 320 permission answers, 320 large outputs, 100 full and 100 recent attaches, 80 lists, 80 watches, 640 changes, five restores, 120 PTY bursts. For event metrics the table gives the median of five per-run percentiles; the last columns show the full range of per-run medians. For restore, percentiles are across the five process starts themselves. At 16 or 20 samples/run a p99 is the slowest sample, not a precise estimate of a population tail.

| Latency (ms) | B p50 / p95 / p99 | F p50 / p95 / p99 | B p50 range | F p50 range |
|---|---:|---:|---:|---:|
| agent_chunk_to_client | 1.65 / 6.04 / 9.6 | 0.94 / 3.65 / 5.82 | 1.56–2.35 | 0.65–1.2 |
| answer_to_agent | 1.68 / 4.27 / 8.09 | 1.12 / 2.4 / 3.03 | 1.42–2.15 | 1.03–1.29 |
| agent_output_to_client | 14.74 / 30.68 / 36.84 | 16.09 / 24.92 / 33.59 | 13.92–17.47 | 12.75–19.94 |
| full_first_replay | 22.77 / 27.17 / 28.8 | 23.57 / 30.25 / 36.06 | 20.04–25.18 | 19.52–25.43 |
| near_head_first_replay | 6.38 / 9.01 / 10.22 | 2.04 / 3.01 / 3.02 | 6.05–7.3 | 0.92–2.85 |
| full_complete | 43.99 / 54.24 / 59.59 | 43.05 / 53.91 / 66.39 | 38.33–47.52 | 35.96–44.91 |
| near_head_complete | 6.53 / 9.16 / 10.47 | 2.18 / 3.15 / 3.16 | 6.16–7.45 | 1.08–2.98 |
| list | 9.57 / 13.32 / 13.32 | 6.17 / 9.19 / 9.19 | 9.37–10.36 | 5.93–6.64 |
| watch | 9.86 / 14.19 / 14.19 | 6.13 / 9.53 / 9.53 | 9.47–10.31 | 6.01–6.66 |
| change_delivery | 2.22 / 7.79 / 10.67 | 2.13 / 6.96 / 8.79 | 2.12–3.09 | 1.88–2.5 |
| launch → hello | 204.04 / 268.04 / 268.04 | 130.62 / 140.87 / 140.87 | 183.43–268.04 | 116.51–140.87 |
| burst | 65.57 / 109.45 / 120.04 | 51.66 / 109.66 / 112.87 | 24.59–87.17 | 33.61–78.57 |

| Workload | B hub CPU ms [range] | F hub CPU ms [range] | B peak KiB | F peak KiB | B throughput [range] | F throughput [range] |
|---|---:|---:|---:|---:|---:|---:|
| stream | 869.8 [845.9–892.5] | 226.4 [214.7–236.7] | 11444 | 11068 | 9284.5 [8998–9486.8] | 9454.2 [9392.5–9517.6] |
| large | 438.1 [424.8–460.5] | 390.7 [350.2–421] | 15520 | 13300 | 43.9 [41.6–47.9] | 46.6 [36.9–55.7] |
| replay | 622.8 [610.7–720] | 614.9 [501.9–632.2] | 18376 | 18616 | 88.4 [75.9–101.3] | 91.4 [84.5–96.8] |
| fleet | 209.9 [206.3–225.3] | 94.1 [87.3–101.2] | 33628 | 30212 | 323.9 [302.1–337.9] | 454.6 [390.6–476.7] |
| restore | 167.1 [162.6–186.8] | 107.9 [106.6–112.7] | 84428 | 7632 | 402.5 [306.4–447.7] | 628.7 [583–704.9] |
| pty | 285.8 [250.2–299.9] | 268.8 [245–292.9] | 17596 | 17260 | 3.9 [2.9–6.7] | 4.1 [3.2–5.3] |

Throughput: chunks/s for stream, changes/s for fleet, MiB/s otherwise. Replay throughput above is full-cursor only; recent replay 4.33 [4.10–5.05] → 14.05 [12.19–29.77] MiB/s. Restore CPU/HWM are sampled at socket ready. Before any attach or snapshot in the mixed fleet, RSS was 19,488 [19,084–19,776] → 19,428 [19,364–19,584] KiB: **no demonstrated detached steady-state saving**. Time to the first complete fleet list 306 [182–350] → 242 [191–339] ms; overlap. Stream still delivered 216 info/432 watch updates and wrote 2,039,592 journal bytes (medians); large still delivered 96 info updates and wrote 52,801,904 bytes.

| Workload | B alloc k calls / MB | F alloc k calls / MB | B logical R/W/storage W (MB) | F logical R/W/storage W (MB) | B runnable delay ms | F runnable delay ms | F trace pwrite/data-sync/fsync/futex |
|---|---:|---:|---:|---:|---:|---:|---:|
| stream | 7640 / 803.1 | 630.9 / 82.4 | 2.359/2.05/2.097 | 2.359/2.049/2.097 | 1224.5 | 748 | 8488/32/88/2883 |
| large | 354.8 / 462.6 | 144.1 / 390 | 52.804/52.808/52.937 | 52.804/52.808/52.937 | 579.5 | 514.5 | 195/35/9/1098 |
| replay | 516.8 / 501.3 | 500.5 / 500.9 | 342.763/0.014/0 | 188.793/0.013/0 | 595.3 | 554.4 | 0/1/2/8385 |
| fleet | 1260 / 247.8 | 410.6 / 131.1 | 0/0.009/0.131 | 0/0.009/0.131 | 407.2 | 384.2 | 128/384/512/10910 |
| restore | 226.6 / 353.2 | 226 / 350.8 | 86.129/0/0 | 86.129/0/0 | 47.2 | 39.8 | 0/8/16/204 |
| pty | 124.5 / 280.9 | 123.8 / 280.7 | 6.488/0.021/0.004 | 6.488/0.021/0.004 | 1703.9 | 1398.2 | 0/0/8/3371 |

All storage-accounted reads were zero in this warm-cache comparison. Storage bytes are dirty-byte accounting, not a device write-amplification estimate. No direct lock-residence measurements; the fleet update delivery distribution includes queueing during list/watch. Whole-run baseline futex counts in table order: 3,771, 1,093, 11,919, 10,866, 275, 5,917. Small differences in PTY syscall/frame counts depend on how reads split and how long the process lives (snapshot timers). No throughput claim from an instrumented run.

**Regressions and noise.** Large-tool p50 moved 14.74 → 16.09 ms despite lower CPU and better p95; both medians lie within the other binary's range. Full replay first-event p99 rose 28.80 [25.01–37.69] → 36.06 [29.17–47.99] ms; completion p99 59.59 [54.40–70.60] → 66.39 [53.15–70.65] ms, and peak RSS rose 240 KiB. No full-attach improvement claimed. PTY burst p95 was flat to slightly worse (109.45 → 109.66 ms). Both binaries ran far slower than the initial PTY baseline with much more scheduler delay; ranges overlap and no PTY-output optimization landed. CPU, allocation traffic, replay reads and restore memory are stronger evidence than unpaired wall-clock comparisons.

## Decisions that need an owner

- **Issue 68 is a wire-size limit, not just an allocation bug.** The 256-session list encodes to 615,799 bytes, of which 509,288 bytes are the eight measured option arrays. At those widths, 262 all-rich summaries cross `MAX_LINE` (16 MiB); cycling the smaller mixed fleet crosses at 6,971. Direct serialization does not change this. A versioned compact board summary with options fetched on card open would remove ~83% of this particular list. Alternatively page the watch snapshot with a generation/barrier and deliver changes after the last page. Neither is compatible with an unchanged one-line `watch` reply.
- **Full replay and retention.** A cold cursor still reads the prefix; it can't simply start 4 MiB from EOF. The budget applies to serialized, coalesced events, not file bytes, and pending announcements must be preserved. The fixture returns 4,184,107 event bytes for each full attach. Evaluate segmentation/index metadata covering those invariants separately; don't compact or skip events on the strength of a small-cursor benchmark. Reducing write volume materially for 48 MiB of tool results would require less/different persisted content or compression. No journal format or durability change here.
- **Detached memory.** Restoring without retaining historical payloads helps startup and allocator high water. It does not evict live agents, PTY buffers, ACP facts, per-session actors or the materialized options a list is required to return. The actor still owns its last published `Summary` alongside the registry's copy; measure sharing that immutable snapshot in an all-rich detached fleet before adding eviction. For session-group peaks, collect time-aligned hub PSS, child PSS, group `memory.stat`, journal growth and process- versus group-level I/O. No inference from fixture RSS to the old 16.7 GiB peak.
- **Fast PTY.** Keep the 1 MiB byte ring, 1,000-line VT scrollback and escape/UTF-8 holdback unchanged. Measure parser allocation stacks on a representative terminal recording before changing terminal semantics or frame boundaries.

## Verification

`export BASH=$(command -v bash); cargo test --offline -p wb-hub -- --test-threads=4`: 326 passed (179 unit, 101 ACP, 3 config limit, 37 PTY, 6 worktree); `peer_probe` is an ignored subprocess helper. Includes `replay_crosses_checkpoints_after_a_write_fault_and_reload` and `stream_heads_wait_but_materialized_changes_and_viewer_drops_do_not`. All six end-to-end workload validators passed with both release binaries in every final comparison.

`nix build --no-link .#checks.x86_64-linux.<name>`, one check at a time after the hub tests: `package`, `clippy`, `fmt`, `web-keys`, `typecheck`, `edit-address`, `conformance`, `security`, `ui`, `adapters`, `vm`, `module`. All twelve passed; none skipped or blocked.
