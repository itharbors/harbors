# Agent Guard performance report

- Recorded: 2026-07-30T08:34:32.605Z
- Hardware: Apple M3 Pro (12 logical CPUs), 36 GiB RAM
- OS/runtime: Darwin 25.5.0 arm64, Node v22.18.0
- Duration: 900 seconds; equal thirds harness baseline, guard idle, and fixture traffic
- Scope: smoke harness + 5-second netstat snapshots + detached recovery watchdog; fixture Agent and traffic-sink CPU/RSS excluded

| Budget | Result | Measurement |
| --- | --- | --- |
| Idle incremental CPU ≤ 0.5% | PASS | 0.15% |
| Stress incremental CPU ≤ 2% | PASS | 0.14% |
| Incremental background + watchdog RSS ≤ 50 MiB | PASS | 10.3 MiB |
| Projected metrics ≤ 20 MiB/day | PASS | 0.34 MiB/day |
| Fixture traffic observed by netstat snapshots | PASS | 890470400 bytes |

Additional evidence: harness baseline CPU 0.61%; guard idle CPU 0.67%; guard stress CPU 0.66%; calibrated netstat CPU 0.09%; event-loop p99 21.84 ms; slowest netstat poll 117.00 ms; local fixture received 902168576 bytes; netstat emitted 120 counters in 1 collector epoch(s), attributing 890470400 outbound and 0 inbound bytes. The 100,000-observation unit benchmark is a boundedness check, not a substitute for this real macOS measurement.
