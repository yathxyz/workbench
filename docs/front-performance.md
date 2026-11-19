# Frontend performance: proxied PTYs, board and Agents

Baseline: `d8e1ac5cfd`. Three production changes; no protocol, persisted data, key binding, dependency or transcript changes. Measurements are from a shared Linux x86-64 machine, not budgets for CI.

## Reproduce

From the checkout, run any one of these. They use the UI flake check's Chromium, Playwright and service binaries, not a developer's running board. Linux user/network namespaces and `ip` are required. The harness starts/stops Caddy, wb-web, wb-hub and edwind on private loopback with temporary state. Keep stdout for JSONL measurements; diagnostics go to stderr.

```sh
bash tests/run-front-bench.sh front-relay-bench.py
bash tests/run-front-bench.sh front-agents-bench.mts
bash tests/run-front-bench.sh front-page-bench.mts phone load
bash tests/run-front-bench.sh front-page-bench.mts phone input
bash tests/run-front-bench.sh front-page-bench.mts phone navigator
bash tests/run-front-bench.sh front-page-bench.mts desktop pages
```

Substitute `desktop` for `phone`; Agents defaults to both. `WB_BENCH_ROOT` selects packaged page assets; `front-relay-bench.py --help` describes alternating web binaries. `WB_BENCH_REPEATS` changes cold/controlled page pairs. `WB_BENCH_TRACE=/tmp/board.zip` and `WB_BENCH_PROFILE=/tmp/board` enable a Playwright trace with screenshots and phase-specific Chromium CPU profiles respectively for the page benchmark. Do not compare traced runs with untraced runs. Harness commits: `9b16ca183b` (workloads), `815f94fcc0` (persisted seed and navigator), `1d52d05245` (relay process counters), `e7922130ef` (six complete pages on one PTY).

## Decision order

| Rank | Baseline evidence | Expected benefit, cost and risk | Decision |
|---|---|---|---|
| 1 | 33/33 traced ~40 ms proxy ACK gaps immediately followed (<100 µs) by more server data. Six viewers waited 44 ms for a burst. | Remove an ACK wait per burst with one TCP socket option; may send more small packets. | Set `TCP_NODELAY` on accepted frontend TCP streams (`ae90efe534`); no flush, framing or Unix transport changes. |
| 2 | 288 unchanged Agents rows: 5,136 redundant attribute writes and 288 text replacements every return. `meshFill` was a top live-update profile frame. | Avoid DOM/style work across all rows at small implementation cost; must still clear stale text/classes/visibility. | Compare with actual DOM before writing (`441d70afc4`); no shadow state, memoization or invalidation protocol. |
| 3 | On a 180-reference board, 623/2,638 phone navigator CPU samples in its natural-sort comparator. | Construct the locale-sensitive numeric comparator once per sort instead of setting it up for every comparison; preserve equal-name ties and directories-first ordering. | Local `Intl.Collator`, nothing retained between sorts (`4ae11d404d`). |
| 4 | Cold phone profile: 101 samples at one xterm `_measure` callsite alone; 134 in `renderRanger`. Three fonts account for 2.85 MB before the board is usable. | Deferring terminal mount or font delivery could improve first paint, but attachment/fit/focus and glyph metrics are visible behavior. | Not changed. Test a lazy mount against reconnect, keyboard focus and retained output before proposing it; don't remove glyphs to improve transfer counts. |
| 5 | Another 447 navigator samples in `scrollIntoView`; busy terminal and canvas frame tails remain. Larger relay bursts allocate ~32 times per forwarded frame in a separate diagnostic. | Incremental selection updates might avoid list layout; risk stale previews, marks and scroll. Relay allocation changes must preserve offsets, segmentation and backpressure. | Measure these separately before changing them. No new sorted-row, geometry or fan-out caches. |

## Real PTY through Caddy

A real raw-mode shell echoes 400 keys then emits 192 bursts of 65,520 bytes with ANSI, escaped JSON characters and UTF-8. One writer; one or six independent WebSockets on the **same** PTY. Each sample ends only after checking every receiver's *bytes and offset*. Four alternating baseline/candidate release pairs; no tracing in these runs. Throughput counts delivery to all viewers, not source bytes/s. CPU is summed wb-web scheduler time, not proxy, shell, hub or driver time. `µs/frame` divides process CPU by actual forwarded output frames.

| Viewers, operation | Complete latency p50 / p95 / p99, ms (before → after) | Delivered MiB/s | wb-web CPU ms | µs/frame | Peak RSS KiB |
|---|---|---:|---:|---:|---:|
| 1 key | 0.10 / 0.14 / 0.24 → 0.10 / 0.13 / 0.17 | 0.01 → 0.01 | 13.8 → 14.7 | 34 → 37 | 19,316 → 19,274 |
| 6 key | 0.194 / 0.238 / 0.305 → 0.203 / 0.247 / 0.269 | 0.03 → 0.03 | 61.3 → 66.7 | 26 → 28 | 21,144 → 21,266 |
| 1 burst | 42.82 / 43.58 / 43.88 → 2.00 / 2.43 / 2.65 | 1.89 → 31.08 | 104.7 → 95.0 | 47 → 39 | 19,684 → 19,398 |
| 6 burst | 44.12 / 45.55 / 46.06 → 3.80 / 4.76 / 5.85 | 9.99 → 96.94 | 546.6 → 579.4 | 42 → 39 | 22,826 → 22,036 |

Cells are medians of four run statistics. Six-viewer burst p95 ranges **45.29–54.05 → 4.63–6.49 ms**, one-viewer **43.38–50.75 → 2.42–2.45**. Six receivers: 12,579,840 source bytes per run; 94,777,755 → 94,811,727 median JSON bytes in 13,338 → 14,391 median output frames. PTY chunk sizes vary, not a wire format change. CPU per viewer rose 91.1 → 96.6 ms, ranges overlap; scheduler run-queue time rose 2.21 → 6.98 ms. RSS gain over idle was 661 → 544 KiB/viewer in the six-attachment case; this includes warm buffers, not the marginal cost of an idle page. Single-key CPU cost increased; the clear win is avoiding burst stalls, not making typing faster on loopback.

Linux `/proc/PID/io` doesn't count these socket calls. In a separate baseline trace, 32 extra bursts/2,400 extra frames added 2,402 `sendto` and 900 `recvfrom`. To count allocations, preload jemalloc on **wb-web only**, subtract lifetime `small.nrequests + large.nrequests` for 16 bursts from the same setup with 80 bursts, six viewers, 20 keys. Baseline: 212,794 requests / 6,894 additional frames = 30.9/frame. Candidate: 201,432 / 6,366 = 31.6/frame. These short diagnostics include startup variance and use a different allocator from the timed release. No allocator improvement or lock-wait reduction claimed.

## Agents: switching views and live updates

Three alternating pairs on desktop and 390×844 Chromium at 4× CPU throttling. 240 parent sessions plus 48 subagents, 12 repositories, eight waves of 24 real HTTP reports across the server and a page `/rpc` subscription. Wait for expected row text, selection and next frame. Timings include the existing application's update cadence. The separate DOM pass uses MutationObserver so row instrumentation isn't on the timed path.

| Median of three runs, before → after | Phone 4× | Desktop |
|---|---:|---:|
| First / return to Agents, ms | 181 / 124 → 201 / 115 | 53 / 39 → 51 / 49 |
| Report wave p50 / p95 / p99, ms | 499 / 600 / 600 → 500 / 517 / 517 | 500 / 583 / 583 → 500 / 733 / 733 |
| Live renderer task ms | 482 → 343 | 305 → 157 |
| Live style + layout ms | 104 → 66 | 65 → 28 |
| Live worst frame interval, ms | 50 → 17 | 33 → 17 |
| Live wall ms / reports per second | 4,099 / 47 → 3,952 / 49 | 4,117 / 47 → 4,266 / 45 |
| End-of-phase JS heap MB, no forced GC | 14.6 → 15.5 | 14.6 → 16.5 |

An unchanged warm open now does **0** instead of **5,136** attribute mutations and **0** instead of **288** text replacements. A wave now does zero attributes and exactly 24 replacements, previously 10,272 / 600 on phone and 5,136 / 312 on desktop. The phone received ~164 kB for 192 reports in either variant. Renderer task ranges: phone **431–1,434 → 334–482 ms**, desktop **169–349 → 139–210**. No general wall-time win: phone first open ranged 163–609 → 161–312 ms, desktop return 37–118 → 49–51. Report p99 is the maximum of eight waves, not a reliable population tail.

## Navigator keys

The harness opens 180 scrambled reference cards, verifies visible numeric name order, then drives 24 real `j` selections per run. Three interleaved pairs per device. Desktop task time fell **330 → 236 ms** (327–382 → 215–236), phone **1,831 → 1,279 ms** (1,796–1,854 → 1,276–1,292). Desktop key-to-frame p50/p95/p99: **14.7/25.3/32.4 → 14.7/15.7/29.1 ms**. Phone: **66.2/136.8/193.7 → 49.3/140.6/158.2 ms**. Phone p95 range widened from 134–143 to 81–156 ms; not a tail-latency win. Layout time was essentially unchanged (phone 294 → 280 ms).

## Memory per connected board

`desktop pages` measures the private **wb-web process**, not Chrome. After one priming visit, open independent full browser contexts against the same persisted board and PTY. Context one executes a shell command; require its resulting output in every context's terminal before reading `/proc/PID/smaps_rollup`. Three interleaved pairs. With one context attached RSS was 21,912 → 22,060 KiB; with six, 28,244 → 28,872 KiB. The within-run `(RSS₆ − RSS₁)/5` median was **1,260 → 1,331 KiB per extra page** (1,227–1,316 → 1,254–1,426); corresponding PSS increments were 1,251 → 1,320 KiB/page. This short warm workload did not show a per-page memory saving.

## Opening, typing, printing: combined stack

Three interleaved pairs per device (A/B, B/A, A/B). Each load run opens three independent browser contexts; in each, navigate cold, wait for service-worker control, reload. Require `workerStart` on the reload and not on cold navigation. Usable means the first animation frame observing the app's `BOOTED` state on a persisted board. It does not mean every background request has finished. The input scenarios use three real shell cards. Desktop is 1280×800; phone is 390×844 with Chromium 4× CPU throttling, not simulated network delay.

| Open board | Usable ms p50 / p95 / p99 (before → after) | Observed range ms | Renderer task ms | Reported transfer bytes | Sampled JS heap high MB | Long tasks |
|---|---|---|---:|---:|---:|---:|
| Desktop cold | 209 / 658 / 658 → 224 / 470 / 470 | 198–658 → 194–470 | 144 → 150 | 3,243,195 → 3,243,376 | 7.7 → 7.7 | 1 → 1 |
| Desktop controlled | 107 / 525 / 525 → 113 / 343 / 343 | 103–525 → 100–343 | 77 → 81 | 6,804 → 6,804 | 20.2 → 20.1 | 0 → 0 |
| Phone cold | 692 / 2,671 / 2,671 → 707 / 812 / 812 | 623–2,671 → 607–812 | 644 → 639 | 3,242,311 → 3,242,492 | 7.8 → 7.8 | 3 → 4 |
| Phone controlled | 362 / 1,445 / 1,445 → 328 / 389 / 389 | 312–1,445 → 298–389 | 335 → 299 | 6,805 → 6,805 | 12.8 → 12.9 | 1 → 1 |

Nine observations per device/cache/variant, nearest ranks: p95 and p99 are both the slowest sample. Remaining columns are medians. Cold medians increased slightly; ranges overlap. No cold-start speedup claimed. Resource Timing totals are completed *page subresources*, not packet counters or the worker's background install traffic. Resource Timing reported the following cold encoded/decoded JS bytes: `app.js` **269,665 / 890,419 → 269,846 / 890,913**, vendor **82,037 / 321,768** and keys **8,938 / 27,676** unchanged. Three fonts alone were 1,063,164 + 1,065,304 + 720,628 bytes. The changes aren't a payload optimization.

| Interactive workload | Key → frame ms p50 / p95 / p99 | Frame gaps ms p50 / p95 / p99 | Renderer task ms | Wall ms | Sampled JS heap high MB |
|---|---|---|---:|---:|---:|
| Desktop canvas pan | 27 / 29 / 32 → 26 / 30 / 35 | 17 / 17 / 33 → 17 / 17 / 17 | 457 → 467 | 1,012 → 1,011 | 19.0 → 19.3 |
| Desktop PTY echo | 48 / 49 / 49 → 48 / 49 / 50 | 17 / 17 / 17 → 17 / 17 / 17 | 134 → 143 | 1,494 → 1,502 | 15.3 → 15.4 |
| Desktop 3 printing PTYs | — | 50 / 83 / 83 → 17 / 67 / 67 | 198 → 154 | 278 → 212 | 42.1 → 43.3 |
| Phone canvas pan | 16 / 73 / 76 → 15 / 57 / 104 | 17 / 50 / 83 → 17 / 33 / 50 | 2,955 → 2,385 | 3,071 → 2,502 | 19.4 → 19.4 |
| Phone PTY echo | 48 / 49 / 53 → 47 / 48 / 49 | 17 / 17 / 17 → 17 / 17 / 17 | 447 → 492 | 1,508 → 1,502 | 15.4 → 15.5 |
| Phone 3 printing PTYs | — | 83 / 133 / 133 → 50 / 133 / 133 | 690 → 621 | 897 → 780 | 42.2 → 44.4 |

Each key phase: 30 actual keydowns per run; wait for a changed canvas transform or the expected echoed xterm cell, then the next animation frame. This is a paint *opportunity*, not physical presentation latency. Each flood: 50,000 lines on each of three shells, wait for all three terminal end markers. Observed aggregate rate: desktop 540k → 708k lines/s; phone 167k → 192k. Three-run wall ranges overlap: desktop flood 166–406 → 166–234 ms, phone 681–2,339 → 517–821 ms. Phone pan p95 frame gap ranged 33–133 → 33–100 ms and its key p99 worsened; no reliable pan or typing win. Phone median long tasks per pan / echo / flood: 4 / 0 / 1 → 1 / 0 / 0. Browser heap is sampled at animation frames, not peak process RSS or total allocations; V8 allocation counts and compositor/GPU scheduling were not measured.

A final combined-stack rerun of the Agents workload still produced 0 / 0 warm writes and 0 / 24 single-wave writes on both devices. Renderer task time was 408 ms (phone) / 161 ms (desktop); report p95 was 746 / 700 ms. A separate throttled terminal trace with screenshots completed; traced times are excluded above.

## Verification

The browser workloads exercised real terminal input, concurrent output, navigator order, live agent reports, and six attached pages. The relay workload verified delivery to every client before recording burst latency.

`nix build --no-link .#checks.x86_64-linux.<name>` passed for all twelve checks, run one at a time: `package`, `clippy`, `fmt`, `web-keys`, `typecheck`, `edit-address`, `conformance`, `security`, `ui`, `adapters`, `vm`, `module`.
