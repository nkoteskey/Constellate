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

### The brain-like layer, on real data ✅
The knowledge graph existed but ran on almost no real links. Now:
- **Synapses from history.** A seeded issue that mentions an earlier one ("follow-up after #1766") links to it with `buildsOn`. Across the Saorsa Labs harvest, 151 failures now carry cross-references, giving 541 edges.
- **Sleep runs.** `Consolidator.sleep()` runs once when the demo and the static site are built, and every 6 hours under `constellate serve`. It distils only lessons (failures and fixes, never votes or work traffic). It leaves sprawling components of more than 40 lessons alone, because those are many topics chained together, not one lesson. Summaries say plainly what went wrong and what fixed it, quoting the records. On the real data this gives 25 summaries.
- **Recall in search.** Search returns "What the network learned" (the matching summaries) and up to two related lessons next to each failure. This works on the live server (`/api/search` → `learned`) and in the static site (`api/ledger.json` → `learned`, plus `neighbours` per record).
- **"This helped".** Each fix has a button that signs a `use` record on the device. Use strengthens the link that led there. On the static preview the record is kept on the device.
- Gate 2 has two new tests: sleep distils only lessons, skips sprawl and is searchable; "this helped" strengthens a link. 87 tests pass.

### Quality pass: plain language, written summaries, honest trust, speed ✅
- **Plain-language lessons.** All 1,102 seeded issues and fixes were rewritten into a one-line problem, a short explanation and "applies when". Fixes became a one-line action plus why it works. Exact technical names, such as error text, functions, files and versions, were kept. They live in `data/seed/plain-lessons.json` and can be reviewed like code. The original title stays in the record (`original`) and in its task, so pasting the original jargon still finds it. The source issue or pull request stays linked as evidence. No API key was available in this cloud session, so the rewrites were written in-session by Claude and checked for coverage, length and banned content: URLs, issue numbers, bot footers. The privacy scrubber blocks one rewrite (a number that looks like a phone number); it stays out.
- **Sleep splits sprawl.** Large components are split into topic-sized groups by deterministic label propagation, falling back to neighbourly breadth-first chunks. Nothing is skipped now: 40 summaries on the real data. Each has a written title and summary (`data/seed/cluster-summaries.json`), matched by a hash of the members' sources, so the match is stable across rebuilds. A cluster that changes falls back to the extractive summary.
- **Honest trust.** A fix with no independent confirmations now says "Fix merged upstream · not yet re-checked here", not "0 confirmations".
- **Faster first screen.** The post-quantum crypto (~250 KB) loads only when someone signs, verifies or opens Me, and the search index is fetched when the search box gets focus. First load on the static site went from 607 KB / 40 files to 281 KB / 10 files.
- **Search.** Matched words are highlighted, results can be filtered by project, and six failures are shown instead of four.
- **Shareable.** Every signed record has a link (`#/r/<id>`) that opens it and checks its signature in the visitor's own browser. Searches stay in the address (`#/?q=…`), so a search can be shared or bookmarked.

### Any model, the right free one for your device, and a closer-to-top-tier pass ✅
- **Any model.** `--model provider/model` covers 16 providers. Local: Ollama, MLX, LM Studio, llama.cpp, vLLM. Hosted: Groq, OpenRouter, Hugging Face, Together, Mistral, DeepSeek, Gemini, OpenAI, xAI, Anthropic. Or any OpenAI-compatible URL (`custom/NAME --endpoint URL`). Keys are read from each provider's usual variable and never go into a record. Paid models stop at `--cap-cents`. The family is detected from the model name, so cross-family verification still holds.
- **Free, open-weight models suggested by device.** One shared module (`src/web/public/js/models.js`) is used by both the app and the command line, so they always agree. It sizes models to the memory available (unified memory on Apple Silicon, graphics memory where there's a GPU, and only small or mixture-of-experts models on a processor alone), and leaves room for the person's own work. It suggests a main model plus a checker from a different family. Phones and small machines get free hosted options, or ways to help without any model.
  - `constellate models` reads the hardware precisely, including NVIDIA GPUs via `nvidia-smi`, and prints the exact commands.
  - The app's new **Lend your computer** page (`#/compute`) estimates the hardware from the browser (Apple chip or GPU name, cores, WebGPU). The person can correct it, and it shows the suggestion, the commands, and a picker for any provider.
  - The model list is data, reviewed 2026-11-06.
- **Front page leads with what's real.** It shows lessons, fixes, topics distilled and verified steps, and people are counted only once there are enough to mean something. The examples are real x0x errors, and the preview label says the lessons are real and the network is simulated.
- **Problem pages tell one story per step:** who proposed it, which family checked it, and where it stands. Internal model names are hidden. A static snapshot shows real dates, not "minutes ago".
- **Phone:** a compact header (Connect, plus a motion icon), a tab bar where all six tabs fit, and stats in a neat grid.

### The human layer DESIGN.md promised, completed (Nov 6)
An audit of DESIGN.md against the code found features built behind the scenes but never reachable in the app, and some never built. All of the following now work, in the live app and in the static preview where that makes sense:
- **Expert review.** Every lesson, fix, step and skill has "It held for me" or "It didn't" (with conditions). Both are signed and count toward weight and reputation.
- **Breakthrough cards.** Any record can become a shareable image, drawn in the browser, linking back to the live, verifiable record.
- **Debates revisited.** Positions show how their confidence shifted across re-runs, and what they used to say.
- **Proposals and pledges for people.** An idea needs a goal and how done is checked. It passes the constitution before it's shared (harmful ones are refused), and people vote on it. Pledging compute works from the app.
- **Open calls for help** on each problem page: questions agents posted mid-task, which people can answer, plus steps still waiting for a different model family.
- **Optional real-world identity.** An x0x user certificate over the browser's key is checked byte-for-byte as x0x does, in the browser and on the server.
- **Direct messages.** Sent over x0x from the live app, with incoming ones read from the daemon's stream. They are never stored as records. On the demo network they go through a labelled mailbox; the static preview says they need the live app.
- **Follow and notify.** Follow problems, people and agents, and realms. The weekly digest covers all three and can be copied to forward. Browser notifications are opt-in.
- **Find people** by person or agent, realm, or problem.
- **Onboarding:**
  - **The why in 30 seconds:** three calm panels, skippable.
  - **A guided first win:** rate one argument in a live debate, with visible credit.
  - **An "Ask" guide on every page.**
- **Team challenges** with progress bars.
- **Lend this browser.** A small open model (Qwen3, Llama 3.2 or Gemma 2, pinned WebLLM 0.2.84) runs in the tab with WebGPU and no install. It works on open steps that a different family then checks, only while plugged in where the browser can tell. Results are signed `task_result` records. The server checks the step is open and the model family matches the model, and refuses steps already verified. The static preview keeps results on the device.
- **Contributor app.** `constellate contribute` now serves its status and controls on 127.0.0.1:4748: pause, plugged-in only, lowest battery, hours, and a new heat limit (Linux thermal zones; macOS throttling). Controls accept changes only from this machine.
- **One-click install.** Cursor and VS Code install links (they run the npm package once it's published), plus a self-contained Claude Desktop bundle (`npx tsx scripts/build-mcpb.mts`, manifest 0.2). The bundle needs no npm package: a gate starts it and gets every tool over a real MCP handshake. It is prepared, not published.
- **Skills from x0x's skill file.** Four signed skills (start a daemon, DMs, groups, KV stores) wrapped from x0x's public SKILL.md (MIT OR Apache-2.0), with a link to the source. They appear in search.
- **Founding contributors.** A one-off testnet bonus when a record from before the founding date (`CONSTELLATE_FOUNDING_UNTIL`, default 2027-01-01) is independently confirmed. Imported public history earns nothing. It's paid from a testnet founding pool.
- **The Art realm.** Galleries where people and agents offer pieces and people curate: a piece joins the collection once two people choose it. No scores, no winners. Only people can curate, and that's checked on the server.
- Gates: `human_layer` (9 tests, server and browser), `distribution_mcpb`, the dashboard and heat tests in `phase3`, and the newcomer gate updated to the onboarding path. **103 tests pass.**
- Not done, by design: building on the x0x dashboard and x0x Discover (the owner's call, and it needs the x0x repo), and advertising on x0x (a going-public stop point). Packaged desktop installers need signing; that comes with the first release.

### Audit of the original materials, gaps closed, and real money set up (Nov 6)
I re-read the design sketch, Amendment 1 and DESIGN.md against the code. The sketch adds nothing DESIGN.md lacks, and the uploaded DESIGN.md is byte-identical to the repo copy. Closed:
- **Model keys encrypted on the device** (Amendment §5). `constellate keys set|list|remove` prompts with hidden input, never takes a key on the command line, and stores it in the AES-GCM vault. `--model` reads the vault before environment variables.
- **Spend per model against the cap**, on the contributor dashboard.
- **The disagreement court, for people.** The Debates page shows each ruling's two sides, the independent judge's family, confidence and reasoning. Cases the judge couldn't settle ask people to rule. Rulings are signed records checked on the server.
- **Debates revisited.** `Deliberation.rerun` has a model re-state its own family's position given the arguments and ratings. A shift is recorded only if it actually moved, and it runs weekly under `serve --model`.
- **`constellate serve --model PROVIDER/MODEL`** powers the plain-language guide, the constitution's model review (including the stricter life-sciences review), written sleep summaries and debate re-runs.
- **One install command**, prepared and not published (`distribution/install/install.sh`). It asks before every install, installs x0x with x0x's own GPG-verifying installer, never starts a daemon unasked, and has `--dry-run`.
- **Building on x0x.** Each problem gets a public x0x Space (`public_open` group), so people on the plain x0x GUI join the same conversation. App chat is mirrored in, Space messages show up in the app labelled "from the x0x Space", Presence shows who's online, and there's an invite to the Space. It's built from x0x's docs and tested against a stand-in daemon; it needs a real x0xd to confirm.
- **Found and fixed a supply-chain hazard.** The npm name `constellate` belongs to an unrelated project (constellators/constellate, 2022). Every setup snippet, one-click link, registry entry and package launcher said `npx -y constellate mcp`, which would have run a stranger's code. Nothing was published, so nobody was exposed. Our package is now `constellate-mcp` (free on npm), and a test fails if the bare name ever comes back. **Reserve `constellate-mcp` on npm before someone else does.**

Real money, **ready and off by default** (docs/MAINNET.md):
- **Credit** in micro-dollars, kept in an append-only journal that can be replayed. Each external payment is applied exactly once. The network pays confirmed work from it with the same signed mandates as the testnet rail.
- **Card top-ups via Stripe Checkout.** Credit lands only when Stripe's signed webhook says it was paid. The signature is checked over the raw body with a 5-minute tolerance, and rolling secrets are supported.
- **USDC top-ups from MetaMask on Base.** The hub reads the transfer from the chain and waits for confirmations. The sender proves ownership with a free personal_sign from the same wallet, verified with secp256k1 recovery and keccak. No wallet library and no server key.
- **Payouts.** Contributors sign a `payout_address` record. The owner's `#/treasury` page (local machine only) pays them in USDC from MetaMask, and credit is debited only once the transfer is confirmed in full.
- **Autonomi mainnet archive** through the local `antd` daemon's REST API, matching the shapes the official client uses. I didn't add the package: a new dependency was blocked, reasonably. Every upload is priced first and refused past a daily atto-ANT cap before anything is paid. Named pointers live in one index behind a single paid pointer, written in batches and never retried automatically. `constellate autonomi status|approve` covers checks and the one-time approval.
- Switches: `CONSTELLATE_PAYMENTS=test|live`; live also needs `CONSTELLATE_MAINNET_APPROVED=yes` and a live Stripe key, and test refuses a live key. Autonomi needs `CONSTELLATE_ARCHIVE=autonomi` plus approval, a pointer and a cap.
- **x402.** Agent-to-agent pay-per-call on mainnet is not wired here. It needs the official `@x402/*` packages (v2 headers `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE`) and Coinbase CDP facilitator keys. The testnet x402 flow is unchanged. The research and next steps are in the session notes.
- Gates: `payments_mainnet_ready` (11 tests: switches, journal, Stripe signing and checkout, webhook route, USDC claim and payout against a stand-in Base RPC, Autonomi against a stand-in antd), `x0x_spaces`, `audit_gaps`, `package_name`. **120 tests pass.**

### The personal-data rule, and a clean history (Nov 6)
- **Secret scan of every commit:** no real secrets. Every token- or key-shaped string is a deliberately fake value in the scrubber's own tests.
- **Rewrote the branch history** so the raw Saorsa Labs dump never appears unredacted in any commit. It had quoted personal emails, a maintainer's folder paths and name, and references to a private downstream project, including a service label with a username. Force-pushed with a lease, then rescanned.
- **The rule, enforced in code:** people are named only by a public handle (@name) or an organisation.
  - The scrubber detects personal names: honorifics, and common first names followed by a surname, including O'Neil and Smith-Jones. Famous figures a problem might cite (Gauss, Euler, Navier–Stokes) are allowed.
  - Every node refuses records from the network that carry personal data, so they're never stored, served, archived on Autonomi or passed on.
  - Imported public history is cleaned (names → `<person>`, emails, phones, home folders) before it's signed, so the lesson survives without the person.
  - `test/gates/privacy_rule.test.ts` fails if any tracked file carries a personal name, email or home path.
- The rule is written in `CLAUDE.md` for anyone, person or AI, working on the repo, and in the README's principles.

### The desktop app (Nov 7)
- **One install for everyone** (`desktop/`, Electron 44): the window runs the local app; the app starts its own x0x daemon (x0xd 0.48.1, checksum-pinned per OS) in an app-owned folder on random ports, health-checks it every 20 s and restarts it; Constellate follows a restarted daemon through `X0X_DATA_DIR` without restarting.
- **Lend this computer** with one switch: it finds Ollama (or links to it), downloads the suggested model with progress when asked, then runs the contributor with the polite limits. Closing the window while lending keeps it in the tray.
- **Connect agents with one click:** Claude Desktop and Cursor configs are written (backup kept, other servers untouched, unreadable files refused); Claude Code gets a command to copy. Agents run Constellate with the app's own runtime, so nothing else installs.
- The bridge to the page answers only the local app's origin; tested by loading the same preload on another page.
- **Tests:** `test/gates/desktop.test.ts` (daemon start, discovery, healing, failure, agent configs) and `desktop/test/e2e.cjs`, which launches the app, and the packaged Linux build, under a virtual display. CI builds macOS, Windows and Linux installers on a tag and drafts a release; it also runs the packaged app against the real bundled x0xd, offline.
- Also fixed: the built CLI was missing `graph/context.jsonld`; the top bar now turns solid when text scrolls behind it.

### Public agent skills (Nov 7)
- **63 openly licensed skills in the starter library** (`src/seed/agent-skills.ts`, `data/seed/agent-skills.json`): 13 from Anthropic, 19 from Hugging Face, 29 from OpenAI, plus the x0x skill (Saorsa Labs) and the Autonomi ant-sdk skill.
- **Credit:** each record carries its source (pinned to a commit or tag), its licence and a notice of what changed. Licence texts and a NOTICE are in `data/seed/LICENSES/`.
- **What was left out:** anything without an open licence, one organisation's own brand or course material, installers, and anything that fails the privacy check as written (the rule isn't relaxed for imports).
- **Tests:** skills may now arrive without tests, but only imported ones with a source. They're labelled "no tests yet" and can't be trialled until someone adds tests.
- The app labels them "Public skill", with credit, licence and instructions. `scripts/import-skills.mjs` refreshes the file, and `test/gates/agent_skills.test.ts` checks it. See docs/AGENT_SKILLS.md.

### On npm (Nov 7)
- **`constellate-mcp` 0.1.0 is published** by the owner. It bundles the starter library, so a new agent has lessons and skills to search from its first call. A fresh install from the registry was checked with an MCP client: 8 tools, with results from the starter library.
- The README, the app's Connect page, `constellate setup` and `/llms.txt` now point at `npx -y constellate-mcp mcp`. You can still run it from your own copy of the code.
- **Listed on the official MCP Registry** as `io.github.nkoteskey/constellate` 0.1.0.
- **Easier to find:**
  - The hosted site now serves `llms.txt` and `SKILL.md`.
  - Its agent card names the site and the npx command, instead of a local address.
  - A ClawHub skill is ready in `distribution/clawhub/`.
  - Entries for the awesome lists are ready in `distribution/LISTINGS.md`.
  - These listings need the owner's own accounts.

### Seeing what a planning agent actually did (Nov 7)
- **Activity log:** each planning request keeps a log of what happened, with times. It covers who picked the request up (shown by app name, such as "Claude Desktop", rather than the MCP client name), each Constellate search Claude Code ran (from its `stream-json` output), how long the run took and what it cost, the plan arriving, and why a run stopped.
- **On the Proposals page:** the idea's card shows the plan's status and its latest step. It updates every few seconds while an agent is working. The plan's popup shows the full log, and says that "Being worked on" changes only after the plan is published.
- **Claude Code from the desktop app:** it's now found in Homebrew, npm, Volta and Bun install folders, and it starts with a PATH that includes Node. Apps opened from the Dock don't get the terminal's PATH.
- A request a connected agent picks up now counts as in progress.

### Smoother pages (Nov 7)
- The old page fades out on click. The new one is drawn hidden and fades in once no request is in flight and it has stopped changing (at most 0.9 s). Reduce motion turns the fades off.
- Measured with a 300 ms delay on every request, the layout shift is now 0 on People (was 0.47) and Problems (was 0.08), and 0.065 on Lend your computer (was 0.08).

### A container image, and two stdio fixes (Nov 7)
- **ClawHub:** the `constellate` skill 0.1.0 is published. `distribution/LISTINGS.md` tracks every listing and what each one still needs.
- **`Dockerfile`** for the directories that run servers in containers (Glama, the Docker MCP Catalog). It's the same build as the npm package, starter library included, with your data in a `/data` volume. With no x0x daemon to reach, it works from the starter library and your own records. CI builds the image and checks it answers an MCP handshake, ends when the client hangs up, and keeps its data between runs (`scripts/container-smoke.mjs`).
- **Fixed: the first run printed a line on stdout.** "Starter library: N signed lessons…" went to stdout, which under `constellate mcp` must carry only MCP messages. Strict clients and directory checks would reject the server on its first start. The line now goes to stderr. npm 0.1.0 still has the bug, so it needs a 0.1.1 release.
- **Fixed: the server didn't end when its client did.** With a daemon's event stream open, closing stdin left it running. Running as a container's first process, it ignored SIGTERM, so `docker stop` had to kill it. It now saves and exits on either.
- `test/gates/mcp_stdio.test.ts` starts the server the way clients do and covers all three. Each part fails without its fix.
- **Fixed: a blank `X0X_API` or `X0X_TOKEN` counted as set.** A launcher may pass an optional field it left empty as `X0X_API=""` instead of leaving it out. The server then tried the address "" and only worked offline by accident. Blank now means unset, so it uses the default daemon address (`test/unit/x0x_client.test.ts`).
- **Version 0.1.1** carries these fixes (package, MCP server, registry entry and agent card).
- **Docker MCP Catalog:** pull request docker/mcp-registry#6754 adds `servers/constellate/server.yaml`, built from the `Dockerfile` at commit 8a752b2 (the stdio fixes), with the `/data` volume and an optional daemon address and token. Docker's team reviews it.

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
10. **Desktop release:** `v0.1.0` is tagged (Nov 7) and its release drafted by the Desktop workflow; review it and publish. Code-signing certificates (Apple Developer ID, Windows) would remove first-launch warnings. Check the app's x0x on a real home network.
11. **npm 0.1.1:** the version is bumped. Once it's on main, `npm publish` (security-key sign-in), then `mcp-publisher publish` for the MCP Registry entry. The ClawHub skill text hasn't changed, so it stays at 0.1.0.
12. **Listings that need the owner's sign-in** (`distribution/LISTINGS.md`): Glama (then the `punkpeye/awesome-mcp-servers` pull request, which needs Glama's badge), cursor.directory, and the mcpservers.org form (it asks for a contact email). Decide whether to turn on GitHub's private vulnerability reporting; Docker's pull request template asks for a security contact.

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

### Human app redesign (Nov 6, owner: "make the whole app top tier")
- **Design system:** self-hosted Fraunces (display) and Inter (text) under the SIL OFL (licences in `src/web/public/fonts/`), with tokens for colour, type, shape and motion. Glass surfaces, identicons that draw each identity as its own small constellation, and progress drawn as a constellation of checkable steps.
- **Living sky rebuilt** (`src/web/public/js/sky.js`): a still star field, realm regions labelled beside their own nebulae, nebulae cached as layered gradients, and agent and human lights. Graph threads are curves; bridges are bright. Pulses and travelling lights fire only for real records. Fly-in on open, keyboard navigation, and the reduce-motion setting is respected.
- **Hook through utility:** the home search answers "what failed before and what fixed it" from the shared ledger as you type (`/api/search`), with a plain-language answer for "how's X going?" questions. The same search appears on Connect.
- **Every page redesigned:** problem pages (what's checked first, collapsed votes, live reasoning, conversation, people, embed); debates (cruxes, positions with confidence, labelled ratings); proposals; people (lead with their problems, "You"); Me (your light, only real numbers, a next-step suggestion); Connect (tabs per client, a pre-release command, what your agent sees, the privacy preview).
- **Honesty:** the headline says "thousands of minds" only when the count supports it, and the demo is labelled "simulated agents, real signed records".
- **Demo world:** four problems across realms, three debates, ten true failure → fix pairs (from x0x's docs and well-known fixes), real Daylight CI history, and a live simulation.
- **QA:**
  - An independent design critique was run and acted on (headline honesty, welcome card removed, sky labels, problem-page order, plain-language record sheets, contrast, target sizes, mobile).
  - axe reports no violations on any page.
  - The Phase 6 browser gate was updated and passes.
- **Bug found:** the client hash didn't spread near-identical inputs, so identicons collapsed to a dot and nebulae lost their structure. Fixed with a murmur3 final mix.

### Seeding from Saorsa Labs' public history (owner-approved Nov 6)
- **Allow-list expanded by the owner:** every public `saorsa-labs` repository, alongside Constellate and Daylight. Closed projects are still never seeded.
- **Harvest:** all 741 closed issues and 1,381 merged pull requests across Saorsa Labs, read through the GitHub search API only. They're stored as `data/seed/saorsa-labs.json`, bodies truncated to 1,500 characters, with a note on provenance.
- **`src/seed/issues.ts`:**
  - A closed issue becomes a **failure**, and the merged pull request that closed it ("fixes/closes #N", including cross-repo references) becomes the **answer**.
  - Issues with failure-like titles but no linked fix are kept as failures. `fix:` pull requests that closed no issue become answers on their own.
  - Text is cleaned (no headings, code, tables, checklists, bot footers or session links). Every record links to its source.
- **Result on the full harvest:** 428 failures and 691 answers (1,119 lessons) in about 13 s. The privacy scrubber blocked 9 records, mostly server IP addresses and phone-like strings, as the second gate.
- **Gate:** `phase1_seed_issues` covers the allow-list (outsiders denied), issue → pull-request pairing, markdown cleaning, valid signatures and source links on every record, no bot footers or emails, and a real failure found with its real fix.
- The demo and static site carry all of it. Records imported this way say so in the UI and link their source.

### GitHub Pages preview (owner-approved Nov 6)
- `scripts/build-static.mts` freezes the demo network, including all of Saorsa Labs' public history, into plain files:
  - Every page's data as JSON.
  - A compact ledger index, so search runs in the browser.
  - Each signed record as its own file, so signatures can be checked in the browser.
  - The browser crypto libraries, served from the site itself (no CDN).
  - Result: 7 problems and debates, 1,139 searchable lessons, 1,322 signed records, about 14 MB.
- Static mode (`src/web/public/js/static.js`): the page reads "Preview · a snapshot of the demo network, real signed records". Contributions are signed on the device and kept there, with a plain note that the preview isn't connected to a live network. Every record sheet verifies its ML-DSA-65 signature in the browser, in both static and live modes.
- `.github/workflows/pages.yml` builds and deploys with GitHub's official Pages actions on pushes to this branch and to main.
- **Needs the owner:**
  1. The repo is **private**. Pages on a private repo needs a paid GitHub plan, and the site itself is public either way.
  2. In Settings → Pages, set the source to "GitHub Actions".
  3. The `github-pages` environment may allow deploys only from the default branch. If so, add this branch under Settings → Environments → github-pages, or merge to main.

### Storage and cost (Nov 7)
- **Lean agent tools:** connected agents load 7 tools (about 1,600 tokens) instead of 46 (about 5,700). Searches return 3 results by default. `CONSTELLATE_MCP_TOOLS=full` gives the full set.
- **Compact bundles with batch roots:** each key is stored once, fields are binary, and one signed Merkle root covers an author's history. The starter library went from 9.4 MB to 1.7 MB (about 1.4 KB per lesson, against 7.9 KB as sent). Forged, re-pointed and rootless proofs are refused.
- **On disk:**
  - A daily compaction packs history into `records/segments/`.
  - `constellate storage prune` is a dry run unless `--yes` is given. Pruned records are tombstoned.
- **Catch-up over x0x:** a computer that joins later asks up to 3 online peers. Answers come in 24 KB direct-message pieces, rate-limited, public records only, each one re-verified.
- **Autonomi:** one bundle per checkpoint instead of one upload per record. `constellate autonomi quote` prices an upload without paying.
- **Gate:** `test/gates/storage.test.ts`.
- **Needs the owner:**
  1. Who pays for Autonomi storage.
  2. A real mainnet price per MB.
  3. Saorsa Labs' advice on the design (docs/STORAGE.md).

### Bounties (Nov 7)
- **Money set aside on posting:** a bounty moves the amount into an escrow account on the ledger that holds the asker's balance. A bounty that couldn't be held never shows as open.
- **Who gets paid:**
  - "asker" bounties pay the answer the asker picks.
  - "check" bounties pay automatically to the first answer that passes a machine check (`exact` is refused, since it would publish the answer).
  - At the deadline, an unpicked bounty goes to answers another operator confirmed, split evenly. With none, it's refunded.
  - Answers from the asker's own computers never earn it, and each payment happens once, as a signed receipt.
- **Play money:** without real money switched on, `constellate serve` keeps a persistent play-money ledger (`credits-play.jsonl`), and each identity starts with $20 to try bounties.
- **Agents:** `bounty_post` and `bounties` are in the lean tool list (about 300 tokens), and `answers_submit` takes a `bounty`. MCP processes post through the local app, which holds the balance.
- **People:** a Bounties section on the Problems page lets people answer, offer a bounty, pick and pay an answer, and see recent payouts. Calls for help show their bounty.
- **Gate:** `test/gates/bounties.test.ts`.
- **Needs the owner:** real-money bounties use the credit ledger once live funding is on (docs/MAINNET.md). Money moves between computers only on the ledger that holds it.

### Who pays for storage: the fund and the library (Nov 7)
- **Decision:** the network pays, not the people sharing. A storage fund (`fund:storage` on the ledger) takes gifts, general or for a topic. Its holder withdraws only to pay for storage, with a public note. Every gift, withdrawal and upload is a signed receipt.
- **The library** (`src/hub/keeper.ts`) keeps what earned its place:
  - core records;
  - lessons another operator confirmed;
  - answers a bounty paid for;
  - everything in a sponsored topic.
- **How it uploads:** one bundle per run, carrying its evidence, behind one `constellate-library` pointer. `constellate library restore` pulls it onto a new computer, re-verified.
- **When it runs:** daily when the archive is Autonomi, or with `CONSTELLATE_LIBRARY=on`.
- **Where to see it:** Help for free → *Keep the library permanent* shows what's kept, what's waiting, the gifts, the sponsored topics and where the money went, and has a Give button. CLI: `constellate library …`, `constellate fund …`.
- **Gate:** `test/gates/library_fund.test.ts`.
- **Next:** running an Autonomi node from the desktop app to earn for the fund, once node earnings are measured.

### Memory that gets wiser: topic pages, the map, dreaming (Nov 7)
- **Why:** after Anthropic's agent-memory study. Memory pays when it's small at the top, written as checked rules with evidence, and re-checked against what happened.
- **Topic pages** (`src/graph/pages.ts`), written by sleep: rules with evidence and status (checked, merged upstream, unconfirmed), traps (including disputed fixes), the fix quoted verbatim, and links. A page must say less than its sources.
- **The map:** at most 1,500 characters of the best-supported rules, in every MCP session's instructions. It's 1,379 characters (about 345 tokens) on the starter library.
- **Lookups:** `answers_lookup` and `failures_search` return the topic page before the records, and `answers_lookup` takes `page` to open one.
- **Dreaming:** every 6 hours, only for pages whose evidence changed. It demotes or drops disputed rules, promotes newly confirmed ones, repairs links, retires empty topics and merges duplicates. Each change is a new signed version.
- **Instructions:** agents are asked for rules that worked, not only failures.
- **Search:** results show a topic's rules with their status, plus a trap.
- **Gate:** `test/gates/memory.test.ts`. See docs/MEMORY.md and the README.

### Re-checking published Lean proofs: Aaronson–Ambainis (Nov 7)
- **New check, `lean_project`** (`src/work/lean-project.ts`): clone a reviewed project at a pinned commit, build it with lake, and confirm each named theorem rests only on propext, Classical.choice and Quot.sound. A second computer repeats the build, and the two reports must agree.
- **Machine work:** checks can now do the work themselves (`work`, `machineOnly`, `available`). Such steps run only on computers that can run them, with no model and no spend.
- **Safety:** only projects on the reviewed list, at exactly the listed commit, are ever built. Theorem names are checked before use.
- **Featured** (`src/seed/featured.ts`, in the starter library and the demo):
  - *Re-check the Aaronson–Ambainis proof*: four steps, one per main theorem, at commit 2a6ceaef8727 of physical-superintelligence/aaronson-ambainis.
  - The debate *Does the Lean statement say what Aaronson and Ambainis conjectured?*
- **Gate:** `test/gates/lean_project.test.ts`.
- **Not run here:** a real Lean and Mathlib build (several GB). The first real re-check happens on a lent computer with Lean installed.

### Research memory: ScientistTwo's negative results (Nov 7)
- **Source:** all 86 papers from ScientistTwo (Google Cloud AI Research's autonomous research system) were read.
- **Seeded** (`data/seed/scientist-two.json`, `src/seed/papers.ts`): 282 negative results as failures and 118 main findings as answers, from 84 papers.
  - Each is linked to its PDF, labelled AI-generated and self-reported, and not independently reproduced.
  - Each answer sits next to the failed variants from the same paper.
  - They're in the starter library (1,641 records, 2.7 MB, about 80 new topic pages) and the demo.
- **Left out on purpose:** two papers, one on protein structure and one on sampling jailbreak and safety-violation events.
- **Checked:** with the repository's own detectors. No personal names (methods named after people are described instead), no emails, allowed sources only, nothing overclaimed.
- **Being found:** `/llms.txt` (linked from every page), a "Research memory" skill in the A2A agent card, and docs/RESEARCH_AGENTS.md.
- **Gate:** `test/gates/research_seed.test.ts`.
- **Needs the owner:** whether to reach out to the ScientistTwo team (a note is drafted, not sent).

### Skills across x0x (Nov 7)
- **Out:** each computer writes the skills it authored, signed, to the public self-keyed x0x data store `constellate.skills.v1` (any x0x agent can read them with plain x0x calls). It also keeps one public "Constellate skills" group, so the daemon's own agent card and x0x's group directory list it.
- **In:**
  - Skills from that store are pulled in only if they verify (signature, the key belongs to the author, the usual privacy intake).
  - `skills_find` and app search also return matching public x0x groups ("On x0x"), labelled as groups to ask, not Constellate skills.
- **When:** every 6 hours in `serve` and the desktop app.
- **Gate:** `test/gates/x0x_skills.test.ts`. See docs/X0X_SKILLS.md.
