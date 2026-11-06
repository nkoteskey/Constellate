# Constellate — progress log

Daily log of what was built, what passed, what failed, decisions, and what needs a human.
Design source: *x0x Agent Hub — Design Sketch* (Oct 30, 2026). Constellate is the working name for the hub.

## Ground rules followed
- Each phase starts with its gate test, written first under `test/gates/`.
- Gates that need real hardware, real networks, real money or human judgement are marked **READY FOR HUMAN TESTING** instead of blocking.
- Stop points (none crossed): real money or mainnet, going public, unresolved privacy or constitution failure.

## 2026-11-06

### Environment constraints (affect every phase)
- x0x itself could not be compiled in this cloud session (building third-party code was blocked) and GitHub release binaries are not reachable. All x0x integration is coded against x0x's documented REST API and source (`saorsa-labs/x0x` @ v0.48.1) and tested against `src/x0x/fake.ts`, a test double of that API surface.
- Byte-level compatibility taken from x0x source and mirrored exactly:
  - AgentId/UserId = SHA-256(`"AUTONOMI_PEER_ID_V2:"` ‖ ML-DSA-65 pk) (ant-quic `derive_peer_id_from_public_key`).
  - External-sign DST `[0xF0] ‖ "x0x.external-agent-sign.v1" ‖ len(ctx):u32 BE ‖ ctx ‖ payload` (x0x `src/api/agent_signing.rs`).
  - Agent certificate message `"x0x-agent-cert-v1" ‖ user_pk ‖ agent_pk ‖ issued_at:u64 LE` (+ v2 `not_after`) (x0x `src/identity.rs`).
- **NEEDS HUMAN:** run `X0X_LIVE=1 npm run gates` on two machines with real `x0xd` to confirm (a) noble ML-DSA-65 signatures verify against aws-lc-rs signatures from `/agent/sign` (both FIPS 204, empty ctx — expected to match), (b) the exact JSON field names of `/stores` and `/task-lists` responses.

### Phase 0 — Foundations ✅ (gate passes on the x0x test double)
Built:
- `src/core/record.ts` — the one signed envelope (`kind,id,author,agent_id,operator?,created,context,body,evidence,refs,signature`). Deterministic CBOR (RFC 8949) on the wire; `id` = SHA-256 of the canonical core; signature over `id` with context `constellate.record.v1`.
- `src/core/identity.ts` — x0x-compatible identities; `LocalSigner` (key created silently, 0600) and `DaemonSigner` (signs via `POST /agent/sign`, so records carry the machine's real x0x agent id).
- `src/core/operator.ts` — operator identity on x0x's Agent → User certificate; many agents, one operator.
- `src/privacy/scrub.ts` — on-device scrubber: secrets, PII, operator deny-terms, strict mode (home paths, private IPs, opaque tokens). Blocks, never trims. Raw inputs only leave as hashes.
- `src/hub/node.ts` — scrub → sign → private preview → publish; incoming gossip verified before storage.
- `src/x0x/client.ts`, `src/transport/bus.ts` — x0x REST client and gossip bus (`constellate/v1/records`).
- `src/store/records.ts`, `src/store/archive.ts` — verified local record store; Archive interface with a local stand-in for Autonomi.

Gate 0 (`test/gates/phase0.test.ts`): two daemons, records signed via each daemon, preview holds data local, publish round-trips, forged/tampered records rejected, and a scan of every byte on the mesh finds none of the planted private data. **PASS.**

Decisions:
- MCP tool names use `_` not `.` (`failures_search`, not `failures.search`): several MCP clients and the Claude API reject dots in tool names.
- Preview mode is on by default (design: "operators see exactly what will be broadcast"). `CONSTELLATE_PREVIEW=off` opts out.
