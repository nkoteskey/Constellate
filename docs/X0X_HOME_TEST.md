# x0x home test: a draft for the x0x team to revise

**Status: draft, not posted.** A shape for an easy-to-join test where people at home measure how x0x behaves on
real connections, so changes can be judged by numbers. It is meant for @dirvine (x0x's lead) and the Saorsa Labs
team to revise before it goes up as a problem in the Technology and infrastructure realm. Once posted, revisions go
through Revise and "Ask it differently" (docs/VERSIONS.md).

Read from x0x v0.49.1, saorsa-gossip 0.5.96 and ant-quic 0.29.0 (the versions x0x pins), on 2026-11-22. File
references are to those repositories.

## The goal

Make x0x measurably better on ordinary home connections and devices, in four areas:

1. **Healthy connections:** peers found and kept, direct rather than relayed, little churn.
2. **Fast, efficient propagation:** messages reach everyone quickly, with few duplicates.
3. **Efficient on each device:** low CPU, memory and battery at idle and under load.
4. **Bandwidth:** few bytes per delivered message, and little idle traffic.

## What x0x does today, in brief

- **Connections:** QUIC over UDP (ant-quic, port 5483). NAT traversal uses QUIC extension frames (no STUN, ICE or
  TURN), with UPnP and mDNS on by default and a MASQUE relay as fallback. Overlay: HyParView with an active view of 8
  (up to 12) and a passive view of 64. Up to 32 connections, 3 per IP, a QUIC ping every 15 s.
- **Liveness:** SWIM probes every second, a 3 s suspect timeout, presence beacons every 30 s, and an adaptive offline
  timeout between 3 and 10 minutes.
- **Propagation:** PlumTree over HyParView. Full messages go to eager peers (home "leaf" nodes cap eager peers at 2);
  others get IHAVE digests every 100 ms; anti-entropy runs every 30 s. Duplicates are dropped by message id before
  signature checks.
- **Device:** a Tokio runtime; pubsub workers scale from 1 to 32. Several timers run even when idle (1 s, 100 ms,
  15 s, 30 s). There is no battery mode.
- **Bandwidth:** each message carries about 5.5 KB of ML-DSA signature and key plus a 256 B header; no compression.
  An egress budget (soft 64 KiB/s, hard 128 KiB/s) only meters by default.
- **One observation worth testing first:** an x0x design note (`docs/design/504-leaf-egress-budget.md`) records an
  idle Windows leaf with about 25 peers whose counters implied about 716 KiB/s of eager send attempts. Wire use wasn't
  measured. A home test would measure it.
- **Some x0x docs are behind the code:** the identity heartbeat is 600 s in code (`src/lib.rs`) but 30 s or 300 s in
  two docs, and the application SWIM ping runs every 60 s, not 15 s.

## What a home computer would measure

Only computed numbers and categories leave the computer. Raw output of `/status`, `/network/status`,
`/diagnostics/connectivity` and `/peers` contains IP addresses and peer ids, so it is read locally and never
uploaded. That is Constellate's rule for every record.

| Area | Measure | From (x0xd today) |
|---|---|---|
| Connections | Peer count and the share of links marked degraded, each minute | `/health`, `/peers` |
| Connections | Direct vs relayed share, hole-punch success rate, NAT type (as a category) | `/network/status` |
| Connections | Reconnections and replaced connections per hour | `/diagnostics/transport` |
| Propagation | Time for a probe message to reach the cohort (echo round trips, so clocks don't matter) | a test topic |
| Propagation | Delivered per published, and duplicates per eager frame | `/diagnostics/gossip` |
| Device | Signature-check time per minute; dispatch delays over 100 ms | `/diagnostics/gossip` |
| Device | Memory and CPU at idle and under load | the operating system |
| Bandwidth | Idle up and down, split into gossip, direct and relay | `/status` (bandwidth) |
| Bandwidth | Bytes per second by message kind (eager, IHAVE, IWANT, anti-entropy) | `/diagnostics/gossip` |
| Bandwidth | Wire overhead: UDP bytes minus application bytes | `/diagnostics/connectivity`, `/status` |

## How joining would work

- **One switch in the desktop app:** "Help test x0x". It runs a session of about 15 minutes: 5 idle, 5 on a shared
  test topic, 5 idle again.
- **It shows exactly what it will send** before sending: a short list of numbers and categories.
- **Cohorts:** people who join in the same hour form a cohort, so propagation is measured across real homes at once.

## The steps

1. **Census (no changes).** A baseline map: NAT types, direct vs relayed, idle bandwidth, propagation time, device
   load, across many homes. This alone would show where x0x struggles.
2. **Experiments on settings that exist today,** each against a baseline cohort running at the same time (the
   equal-compute rule, docs/RESULTS.md). For example: `leaf_max_eager_degree` 2 vs 3; `presence_beacon_interval_secs`
   30 vs 60; `byte_policy` `observe_only` vs `shed_normal`; `relay_fanout_budget_msgs_per_sec`. All are `[gossip]` or
   top-level keys in x0xd's config.
3. **Experiments that need x0x changes** (for the x0x team to decide):
   - an aggregate-only metrics endpoint with no addresses or ids;
   - hop count and age on delivered messages, so propagation can be measured inside x0x;
   - a battery or energy reading;
   - config keys for `max_connections` and the SWIM and PlumTree timers, which are fixed today.

## How a result would be checked

A measurement isn't a witness: it is a distribution from many computers. A result would need enough computers in
both arms, a baseline run at the same time, and the numbers published with their spread. Constellate doesn't have a
`measurement` check yet; it would be built for this test. Results would carry the usual labels (docs/RESULTS.md).

## Questions for the x0x team

- Are these the right four areas? What's missing (for example, partition recovery or DM delivery)?
- Which experiments matter most to you, and which settings would you not want people changing?
- Would you add the aggregate-only metrics endpoint, so the test needs no local redaction?
- Which version should the test pin, and how should it follow new releases?
- Is there an existing soak or measurement script in x0x (for example `tests/e2e_full_measurement.sh`) the test should
  reuse?
