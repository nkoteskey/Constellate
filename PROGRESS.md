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

### Phase 0 addendum
- The local MCP server (`src/mcp/`, `constellate mcp`) landed with Phase 1 because its tools are Phase 1's services. Phase 0 tools: `hub_status`, `hub_previews`, `hub_publish`, `hub_discard`.

### Phase 1 — Shared memory ✅ (deterministic half) / ⏳ behavioural half READY FOR HUMAN TESTING
Built:
- `src/services/ledger.ts` — failure ledger (`failures_search`, `failures_report`) and verified answer cache (`answers_lookup`, `answers_submit`). Answers must carry proof (test, benchmark, proof, reproduction, citation) and can link the failures they fix.
- `src/services/search.ts` — BM25 ranking plus an environment-match boost ("broke on version 2.1" outranks "doesn't work"). Results are compact and ranked; reads are free and local.
- `src/hub/livestate.ts` — permanence: records and a per-agent manifest go to the archive, a Pointer named after the agent resolves to the latest manifest, and the manifest address is mirrored into the agent's x0x KV store. Late joiners catch up from pointers and re-verify everything.
- `src/mcp/` — the hub as one MCP server; each tool description is ≤3 sentences, says when to use it and what it costs. `constellate setup` prints one-line snippets for Claude Code, Claude Desktop, Cursor, OpenClaw.

Gate 1 (`test/gates/phase1.test.ts`): cross-machine find (failure plus the answer that fixed it), storefront rules, small fast lookups at 2,000 records, late-joiner catch-up, preview privacy, and privacy blocks explained to the agent. **PASS.**
- **READY FOR HUMAN TESTING:** `ANTHROPIC_API_KEY=… npx tsx evals/gate1.ts 3` checks whether Claude calls `failures_search`/`answers_lookup` first on ordinary coding tasks, with no system prompt about the hub. Threshold 75%. There is no API key in this session, so it hasn't been run.

Notes:
- Signing plus verifying costs about 10 ms per record (pure-JS ML-DSA-65). That's fine for interactive use. Bulk ingest will want a native verifier or batch verification later.

### Phase 2 — Trust ✅
Built (`src/services/reputation.ts`, trust tools in `src/mcp/services.ts`):
- `confirmation` and `contradiction` records. MCP: `records_confirm`, `records_contradict`, `records_explain` (every claim is clickable: who, evidence, who confirmed), `reputation_get`.
- Reputation is per operator and per domain, computed EigenTrust-style from confirmations and seeded only from pre-trusted operators (the local operator plus configured trusted contacts, which maps onto x0x contact trust levels). A Sybil clique that only confirms itself gets no inflow from the seed set, so it stays near zero.
- Confirmations, not votes: each operator counts once per record, however many agent keys it runs. Agreeing with trusted confirmers earns weight, so confirming is useful work.
- Unproven identities start at 0.01 and together can add at most 0.2 to any record.
- Contradictions stay visible and only subtract when the environments match. Environment matching is version-aware: "serde 0.9" vs "serde 1.0" counts as different conditions.
- Decay: weight halves every 180 days since the last confirmation; re-confirming restores it.

Gate 2 (`test/gates/phase2.test.ts`): a real answer with 9 honest confirmations outranks a planted fake with 100 duplicates and 150 Sybil confirmations, by more than 5× in weight. Also passing: per-domain reputation, many-agents-one-operator, contradiction conditions, decay. **PASS.**

Open: the pre-trusted set should be filled from x0x `GET /contacts` (trust level `trusted`) on a live daemon. Wiring is a one-liner once field names are confirmed (needs a human).

### Phase 3 — Work engine ✅ (gate passes with mock models) / real models READY FOR HUMAN TESTING
Built:
- `src/work/problems.ts` — a problem is a signed record holding goal, realm, definition of done (a named machine verifier) and checkable chunks. Problem state is rebuilt purely from signed records: task results, rejections and checkpoints. Any node, including one that restarted or just joined, computes the same progress.
- `src/work/worker.ts` — the Swarm loop. Each worker verifies others' results first, using a different model family than the producer, a different operator, and a machine check. It then claims work that fits its model size. Every node re-runs the machine check before believing a checkpoint.
- `src/work/board.ts` — the Board as an x0x task list (`X0xBoard`, one list per topic, claims are advisory as in x0x) or in memory.
- `src/work/verifiers.ts` — `exact`, `sum_squares_mod` (gate toy), and `lean` (runs the local `lean`, rejects `sorry`/`admit`).
- `src/contributor/` — device detection, model picker (MLX on Apple Silicon, Ollama elsewhere, sized by memory), power policy (polite by default: plugged in and idle, with plain status lines like "Paused: plug in to keep contributing."), spending caps, and a device-only encrypted key vault. Runners: any OpenAI-compatible endpoint (Ollama, mlx_lm.server, OpenRouter, OpenAI, Gemini compat), Claude via the Anthropic SDK, and a mock.
- `constellate contribute` and `constellate serve` (basic read-only problem viewer); MCP `problems_list`, `problems_status`.

Gate 3 (`test/gates/phase3.test.ts`): six-chunk problem across llama, qwen and claude families. A wrong answer is rejected by a different family. Work pauses at ≥3 checkpoints. Session 2 restarts one worker from disk, drops another, and adds a newcomer that catches up from archive pointers, sees identical progress, and finishes. No checkpointed chunk is redone, every checkpoint is cross-family, and the large-only chunk went to the large model. **PASS.**

- **READY FOR HUMAN TESTING:** `constellate contribute` on an Apple Silicon Mac with `mlx_lm.server` (or Ollama), and `--claude` with an API key. Battery/AC reading via `pmset` has not been exercised (no Mac here).
- Key vault: the device key is a 0600 file. On macOS it should move to the Keychain before launch.
