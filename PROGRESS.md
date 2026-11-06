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

### Phase 4 — Collective ✅ (gate passes with a stand-in Lean checker) / real Lean READY FOR HUMAN TESTING
Built:
- `src/collective/collective.ts`:
  - Proposals must have a definition of done.
  - Pledges, votes, tallies. Vote weight is `sqrt(min(pledged, delivered verified hours)) + 0.5·reputation`, per operator. Empty pledges and fresh keys carry ~0 weight.
  - The queue takes the top-k cleared, unfinished problems and splits compute in proportion to votes (deficit round robin).
- `src/collective/constitution.ts` — automated checks at start and on every checkpoint, recorded as signed `constitution_check` records:
  - Life-sciences safety: anything that could help create a pathogen or toxin is blocked. Every life-sciences proposal waits for a human review.
  - Also checked: no harm (malware, targeting individuals), privacy, checkable progress (a verifier must exist), open licence. An optional model reviewer can be plugged in.
  - A failure at start is terminal and never broadcast. A failure at a checkpoint pauses the problem until a pre-trusted human reviews it. The flagged result is rejected, so its chunk is redone.
- `src/work/launch.ts` — the launch problem: 8 core Lean 4 theorems, `lean` verifier, CC-BY-4.0.
- MCP: `proposals_submit`, `votes_cast`, `compute_pledge`, `queue_get`.

Gate 4 (`test/gates/phase4.test.ts`): four honest operators deliver verified warm-up work, pledge, and vote for the Lean launch problem. 60 Sybil keys pledge 5,000 h each and vote for another problem. Lean tops the queue with >60% of compute, gets more compute, and reaches ≥6 verified checkpoints. A pathogen-enhancement proposal is blocked and never broadcast; a benign life-sciences proposal waits for human review; a tainted checkpoint pauses the problem until a human clears it. **PASS.**

- **READY FOR HUMAN TESTING:** the gate uses a stand-in `lean` verifier (Lean/elan can't be installed here). On a machine with `elan`, run the launch problem with real models and `CONSTELLATE_LEAN=lean`.
- Keyword safety rules are a floor. Before going public a human should review `BIO_HAZARD`/`HARM` and plug in a model reviewer (`new Constitution(hub, runner)`).

### Phase 5 — Economy ✅ (testnet only)
Built (`src/economy/`):
- `rail.ts`:
  - Every payment is authorised by an AP2-style mandate (payer, payee, amount, purpose, the record paid for, nonce, expiry), signed with the agent's ML-DSA-65 key.
  - `TestnetLedger` is the only rail. It has a faucet and refuses forged, replayed, expired or overdrawn payments.
- `x402.ts` — human payments over x402 v1. The server answers 402 with `accepts`; the client retries with `X-PAYMENT`; the server verifies, settles and returns `X-PAYMENT-RESPONSE`. Used for `POST /api/problems/:id/sponsor`.
- `lineage.ts` — attribution lineage:
  - A checkpoint pays 70% to compute and 30% to the independent verifier.
  - Records that build on upstream records or used skills pass 30% upstream, recursively.
- `economy.ts`:
  - Sponsors pay every verified checkpoint automatically and idempotently (`autoSettle`).
  - Every settlement is a signed `receipt` that references what it paid for.
  - Second opinions: the reviewer gets the bounty, plus a 50% bonus if the critique is confirmed useful.
  - Optional refundable deposits on writes. `EscrowAgent` refunds the deposit plus a 20% reward once an independent operator confirms the record.
- `skills.ts`:
  - The skill marketplace uses signed skill cards with instructions, test cases and a price.
  - A trial runs the skill on its own tests with *your* model, so nothing foreign runs on your machine, and is recorded as a `skill_run` (proof of past runs).
  - Using a skill pays the author per run. Skill inheritance sends 20% to parent skills.
- MCP: `skills_find`, `skills_get`, `skills_record_run`, `skills_publish`, `review_request`, `review_respond`, `earnings_get`.

Gate 5 (`test/gates/phase5.test.ts`): a human sponsors a problem over x402. Two workers solve it, one wrong answer included. Payouts land automatically per checkpoint and sum exactly to ledger movements. Every payout traces receipt → checkpoint → verified result → problem, and matches lineage. The rejected answer earns nothing, and settlement is idempotent. Also passing: skill trial is free while use pays author and parent, review fee and bonus, deposit refund and reward, forged/replayed/overdrawn payments refused. **PASS.**

- **NEEDS HUMAN (stop point, not crossed):** mainnet. Confirm the current AP2 spec and its x402 support, choose a network (e.g. Base), and swap `TestnetLedger` for a real facilitator. No real money was touched.
- Not built: code skills (need a real sandbox, e.g. WASM) and the "disagreement court" (a third agent judging clashes). The deliberation track in Phase 6 covers structured disagreement for humans.

### Phase 6 — Human experience ✅ (scripted newcomer) / real newcomers READY FOR HUMAN TESTING
Built:
- `src/web/public/` — one app with five views (Live sky, Problems list, Proposals and voting, Debates, Me), plain HTML/JS, no build step.
  - Living sky: realms as coloured regions, each problem a nebula sized by activity and brightened by progress, agents as blue lights and people as amber.
  - Every motion is real: a pulse only when a signed record lands (SSE `/api/events`). There's a Calm toggle, `prefers-reduced-motion` is honoured, and the plain list view is always available. Works at phone width with no horizontal scroll.
  - First screen: one line, three highlighted problems with hooks, and a short "why" card. No interest quiz: taps are counted on the device and the sky arranges itself around them.
  - Problem pages: per-checkpoint progress bar, definition of done, checkpoint timeline, live reasoning, people and agents labelled, constitution status. One "Help with this" button leads to check a result, vote, donate compute, or connect an agent.
  - Every claim is clickable to its signed record, trust and lineage.
- `src/web/public/identity.js` — no sign-up. An x0x-compatible ML-DSA-65 key is made in the browser on first contribution. The browser builds and signs records byte-compatibly with `src/core/record.ts`, and the hub verifies and gossips them. Backup/restore is on the Me page, with a prompt after earning credit.
- `src/collective/deliberation.ts` — the deliberation track:
  - Steelman first: arguments show only after a defender accepts the wording.
  - Positions come from different model families, with cruxes and shared cruxes, and are re-run over time with history kept.
  - People rate arguments 1–5. The output is a map, not a verdict.
- `src/web/guide.ts` — "ask in plain language" answers from facts, with an optional model, plus a forwardable weekly digest for followed problems.
- `src/web/app.ts` — sky/problem/debate/me APIs, browser record intake (kinds a person may sign; scrubbed; refs must exist), shareable breakthrough cards (`/api/card/:id.svg`), "my light" links.
- `constellate demo` — the app on a simulated network (mock models, real signed records). Screenshots are in `docs/screenshots/`.

Gate 6 (`test/gates/phase6.test.ts`, real Chromium): a scripted newcomer lands, dismisses the intro, opens a featured debate, and rates an argument. That produces a browser-signed record that verifies and reaches other machines over gossip, in under a second and three clicks. Also passing: voting from a problem page shows up on Me; claims are clickable to signed records; plain-language answers; phone width; bad and disallowed submissions refused. **PASS.**

- Bug found by the gate: CSS `display` overrode `hidden`, so an invisible modal blocked every click. Fixed with a global `[hidden]` rule.
- **READY FOR HUMAN TESTING (the real gate):** five first-time users with no instructions, timed to first contribution.
- Not built: in-app chat and DMs (meant to sit on x0x Spaces/DMs, which need a live daemon), teams and challenges, embeds beyond the SVG card, and the optional real-world identity link.

### Phase 7 — Private memory ✅
Built (`src/services/memory.ts`, MCP `memory_put/get/list/delete`):
- Values are encrypted on the device (XChaCha20-Poly1305) and stored as archive chunks. An encrypted index sits behind a Pointer whose name is derived from the memory key, so observers can't link it to the agent.
- Memory is never gossiped and never a public record. Tampering fails decryption.
- `memory.key` (0600) lives in `CONSTELLATE_HOME`. Copy it, alongside the identity key, to carry memory to another machine.

Gate 7 (`test/gates/phase7.test.ts`): notes written in session 1 through one MCP client are read in session 2 through another, with nothing in RAM or the record store. A third machine with only the copied key reads them; a different agent on the same archive reads nothing. The archive contains no plaintext, and tampering is detected. **PASS.**

## Summary of what needs a human
1. **Live x0x (blocks confidence in every phase):** run the gates against two real `x0xd` daemons. Confirm ML-DSA signature interop between `/agent/sign` and noble, `/stores` and `/task-lists` field names, contacts → pre-trusted operators, and Spaces/DMs for chat.
2. **Gate 1 behaviour:** `ANTHROPIC_API_KEY=… npx tsx evals/gate1.ts 3`.
3. **Real models and hardware:** `constellate contribute` on Apple Silicon (MLX), Ollama, and `--claude`; check `pmset` power reading; move the key-vault device key to the macOS Keychain.
4. **Real Lean:** run the launch problem with `elan`/`lean` installed.
5. **Autonomi:** swap `LocalArchive` for an Autonomi client (pay to store) and check pointer semantics.
6. **Payments (stop point, not crossed):** confirm AP2 and x402, pick a mainnet, wire a real facilitator.
7. **Safety:** review the constitution keyword rules and attach a model reviewer before going public (stop point, not crossed).
8. **Gate 6 for real:** five first-time users, unaided, timed to first contribution.
9. **Open questions from the sketch, with current defaults:** hub name (working name "Constellate"); MCP server runs locally per agent; deposit and pricing levels (test values only); scrubbing strictness (strict by default in `fromEnv`, preview on); humans can browse the ledger (public reads); reputation bootstraps without a paywall (pre-trusted seeds plus confirming work; deposits optional).

## Amendment 1 (Nov 6, 2026)
Folded into the existing phases; no completed phase was restarted. DESIGN.md (updated Nov 6) is now in the repo and the build was checked against it (see below).

| § | Item | Phase | Status | Where |
|---|---|---|---|---|
| 1 | Name, brand, logo | all / 6 | ✅ | User-facing text renamed. Three-point SVG logo (`src/web/public/logo.svg`, inline in the header); it glows at rest and pulses only on real checkpoints. Brand principles applied: fewer words on screen. Internal identifiers (`constellate.*`) were already correct; no renames deferred. |
| 2 | Knowledge graph | 1–2 | ✅ gate added | `src/graph/`. Versioned JSON-LD context; content-hash node IDs; edges from refs plus signed `link` records (`buildsOn`, `fixes`, `contradicts`, `confirms`, `inspiredBy`, `sameAs`). Link weights strengthen with use, confirmation and building-on, and decay (90-day half-life); weight affects ranking only, nothing is deleted. Every lookup returns its strongest neighbours. Contradicts links inhibit in context. `Consolidator.sleep()` summarises clusters into signed `summary` records, archived behind a pointer per cluster. Cross-realm bridges are detected and emitted (SSE, UI, `graph_bridges`). |
| 3 | Protocols and payments | 5 | ✅ | `src/economy/a2a.ts`: extends x0x's A2A Agent Card with services and skills (`/.well-known/agent-card.json`). **AP2 checked:** v0.2 is pre-1.0, checkout is delegated to UCP, card rails come first, and there's no package. Its x402 support is the separate a2a-x402 v0.1 extension. **Decision:** agent-to-agent payments use x402 directly over A2A (a2a-x402 v0.1 message flow), with our signed mandate as the payload. Humans pay with x402. Every payment is linked to lineage. Testnet only. |
| 4 | Supporting capabilities | 1, 3, 5 | ✅ | Skill cards, sandboxed trials and inheritance existed. New in `src/collab/collab.ts`: verifiable hand-offs (`handoff_create` / `handoff_check`), mid-task help through the Swarm with checkable answers (`help_request` / `help_accept`), a disagreement court (an independent third agent rules, keeps its reasoning, and pulls in humans when unsure), and the huddle view (`huddle_get`, plus a section on problem pages). |
| 5 | Models and clients | 3 | ✅ | `src/contributor/router.ts`: Anthropic, OpenAI, Gemini and OpenRouter keys come from the encrypted device vault. The router mixes local and cloud models (local first, then cheapest fitting, honours family exclusions) and reports spend per model against per-model and overall caps. Setup snippets for each client already existed. |
| 6 | Distribution | prepared | ✅ prepared, **not published** | `distribution/`: MCP Registry `server.json`, A2A card example, `SKILL.md`, `llms.txt`, npm (`private: true` blocks accidental publishing), PyPI, crates.io and Homebrew launchers, and OpenClaw / LangChain / CrewAI / AutoGen / Claude Agent SDK snippets. Human loops: breakthrough cards, a "my light" link, invite links, live embeds (`/embed.html?p=`), teams, weekly digest. Metrics instrumented (`/api/metrics`, `metrics_get`). No dark patterns. |
| 7 | Interface | 6 | ✅ | Sky threads are real graph links; bridges are bright threads and raise a notice. Five realms. Every life-sciences checkpoint gets the stricter review: broader refusals, and the result is held until a model or human review clears it, then accepted rather than redone. People discovery, problem chat (signed `message` records) and DMs over x0x `POST /direct/send` (needs a daemon; in-browser DMs are coming soon). |
| 8 | README | — | ✅ | Replaced with the provided README. Getting started is accurate: from-source works today; npm, hosted and one-click are marked coming soon. |
| 9 | Seeding the cold start | 1 | ✅ gate added | `src/seed/`. The allow-list is exactly `nkoteskey/constellate` and `nkoteskey/daylight`; default deny, and private repos are refused even if allow-listed. Records come from the public CI trail only (failing run, then the fixing commit from the next passing run, then linked issues), with source links as evidence. The scrubber is a second gate. Private read mode: `constellate snapshot pull` plus `constellate mcp --private`, using a separate closed identity that is refused in the MCP server and in the node. |

Gates added:
- `phase2_graph`: used links outrank unused, a planted dead end sinks, a bridge is detected and emitted, consolidation runs once.
- `phase1_seed`: both allow-listed repos seeded with source links; a non-listed repo yields zero records and is never fetched; a private-mode search makes zero sockets or fetches (captured); a closed identity's publish is refused.
- `amendment_collab`: §3, §4, §5, §7.
- `phase6`: the Amendment 1 UI checks.

**81 tests pass.**

Needs a human (Amendment 1):
1. Run `constellate seed` live. api.github.com isn't reachable from the build session; the gate uses recorded-shape fixtures.
2. Publishing anything in `distribution/` (stop point).
3. Mainnet for x402 / AP2 (stop point). Revisit AP2 when it reaches 1.0.
5. Wire x0x DMs into the browser app.

### Checked against DESIGN.md (Nov 6)
DESIGN.md is now in the repo as the source of truth. The design and Amendment 1 agree. Reading the whole build against it led to three fixes:
- Added `skills_trial` (the design's `skills.trial`). It returns a skill's instructions and tests to run with your own model.
- The first screen now leads with one live problem, with visible progress and "Help with this" ("introduce people through a problem").
- The Me view now shows your agents and hours pledged.

Differences kept deliberately:
- Tool names use `_` instead of `.` (client compatibility).
- Deposits are optional (Foundations: "never required"), even though the Economics table lists a deposit for every write.
- Reputation is per operator *and* per domain. Foundations ties reputation to the operator; the Trust section says "per agent". The operator wins so one person's many agents can't inflate it.
- Private memory reports its Autonomi storage cost (`storage_cost`) but doesn't charge it until a real Autonomi client is wired in.
- Follow covers problems only so far. Following people, agents and realms is not built.

Needs a decision:
1. Onboarding step 2 says "pick what you care about: choose interests", but the first-screen section says "no interest quiz". Built: no quiz; interests are learned from taps on the device.
2. Open question: can humans browse the ledger at launch, or is it agents-only? Built: public reads for everyone ("Browsing needs nothing").
3. Open question: x402 deposit and pricing levels. Built: test values only.

### Decisions approved Nov 6 (owner: "approve whatever unblocks progress and is safe")
| Decision | Resolution |
|---|---|
| Interests at onboarding | Both lines of DESIGN.md hold: no quiz (the sky learns from taps), plus an optional, skippable row of realm chips on the intro card. Choices stay on the device. |
| Can humans browse the ledger at launch? | Yes. Public reads for everyone ("Browsing needs nothing"). |
| x402 deposit and pricing | **Testnet defaults** in `src/economy/pricing.ts`: $0.05 refundable write deposit (optional), 20% confirmation reward, $0.02 minimum review bounty, 20% to parent skills, $0.10 per checkpoint. `MAINNET_PRICING_APPROVED = false`. |
| CI | `.github/workflows/ci.yml` runs typecheck and the full suite, including the Chromium gate, on every push. |
| Seeder against real GitHub | Done read-only. Daylight's public Actions history was read through the GitHub connector and recorded as `test/fixtures/daylight-ci.json`. Two real failure → fix pairs: run 96 failed at `cargo fmt` and was fixed by 35e3a48; run 82 failed at `cargo test` and was fixed by 61aad96. `phase1_seed_real` replays those responses through the real REST client and seeds them correctly, with nothing private (no emails, no commit bodies). **Bug found and fixed:** the client read a top-level `message`, but GitHub nests it under `commit.message`. |

Still stop points, deliberately not approved on the owner's behalf: publishing anything (going public) and mainnet money.
