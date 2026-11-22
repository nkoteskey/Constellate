# Storage and what it costs

Constellate keeps every lesson signed, so anyone can check who wrote it and that
nobody changed it. Signatures are big, though, and cost shows up in three places:

1. **Disk** on every computer that holds the shared history.
2. **Network** when a computer joins later and has to catch up.
3. **Agent tokens** every time a connected agent loads the tool list.

This page gives the measured numbers, the design that brings each one down
without dropping a guarantee, and what still needs the owner.

## Measured (November 2026, the Saorsa Labs starter library)

| | Before | Now |
|---|---|---|
| One lesson as sent over gossip | about 7.9 KB | unchanged (live gossip still carries a full signature) |
| One lesson in packed history | about 7.9 KB | about 1.4 KB |
| Starter library (1,158 lessons) | 9.4 MB | 1.7 MB |
| Tool list an agent loads | 48 tools, about 7,200 tokens | 9 tools, about 2,400 tokens |
| Autonomi uploads per checkpoint | one per new lesson | one per checkpoint |

The 7.9 KB is mostly crypto. An ML-DSA-65 public key is 1,952 bytes and a
signature is 3,309 bytes, and both used to travel as text with every record.
The lesson itself is usually a few hundred bytes.

## The design

### Compact bundles (`src/store/bundle.ts`)
A bundle is how history is stored and shared: on disk, between peers and on
Autonomi.
- Each author's public key appears **once**, and records point to it.
- Fields are binary, not hex or base64.
- Record ids are **not stored**. They're recomputed from the contents on
  opening, so a changed record simply gets a different id.

### Batch roots: one signature for many records (`src/core/record.ts`)
A computer signs one `batch_root` record carrying the Merkle root of the ids of
its own public records. In a bundle, those records then drop their own
signatures and carry a short Merkle proof instead (about 32 bytes per level).
- The verifier recomputes the id, follows the proof to the root, and checks
  that the root is a correctly signed `batch_root` by the **same author**.
- A proof that points at someone else's root is refused, as are a missing root
  and a changed record. `test/gates/storage.test.ts` checks every case.
- Only the author can batch their own records. Live gossip is unchanged: every
  new record still arrives with its own signature, so nothing waits for a batch.

### Packing on disk (`src/store/records.ts`, `src/hub/storage.ts`)
New records land as one small file each, so they're written safely and at once.
Once a day `constellate serve` (or `constellate storage compact`) does three
things:
1. Batches this computer's own records.
2. Packs all public history into a segment file in `records/segments/`.
3. Deletes the loose files.

The write goes through a temporary file and a rename, so a crash leaves either
the old files or the new segment, never half of one. Private records are never
packed and never leave the computer.

### Forgetting, only when asked (`constellate storage prune`)
`constellate storage prune --keep-days N` shows what would go and removes
nothing. Add `--yes` to remove it.
- **Always kept:** this computer's own records; problems, proposals, debates
  (positions, arguments, rulings), skills, summaries, profiles, identity links
  and batch roots; and anything those reference.
- Pruned records are listed in `segments/removed.json`, so they don't come back
  after a restart.
- Other computers keep their own copies, so pruning frees your disk without
  deleting anything from the network.

### Catching up from peers over x0x (`src/hub/sync.ts`)
x0x gossip doesn't replay the past. So a computer that joins later, or was
offline, asks up to three online peers for history since its last sync.
- **How it travels:** a peer answers with a compact bundle, split into 24 KB
  pieces that fit an x0x direct message. A peer sends at most 3,000 records per
  answer and answers each asker at most once every ten minutes.
- **What's shared:** public records only.
- **On arrival:** every record is verified and privacy-checked as if it had
  come over gossip.
- **Cost:** catching up costs nothing beyond bandwidth, and no paid storage is
  needed for it.

### Each contributor stores their own (the main model, from 2026-11-22)
Sharing is free: records live on the computers of everyone running Constellate.
Anyone who wants their contributions on Autonomi for good pays for exactly those,
from their own computer's Autonomi wallet (`src/hub/self-store.ts`). There is no
central fund or shared wallet to hold, beg for or hack, and storing is
permissionless, so nobody can stop it.
- **Where:** Me, "Store what you shared, for good", or `constellate store-mine`
  (`--quote` to see the size and cost first, `--private` for a private receipt).
- **What:** this computer's public contributions (and the person's browser key on
  it), not yet stored, up to 200 per upload, in one bundle that keeps every
  record's own signature. Votes and receipts aren't included.
- **The receipt is the proof of contribution:** a signed `self_store` record with
  the Autonomi address, the bundle's sha256, the record ids, the bytes and the
  cost. Anyone can fetch the bundle, check its hash and every record's signature
  against the key that signed the receipt. It is timestamped and permanent.
- **Anonymous if you like:** records are signed by a key, not a name (unless the
  person linked one). The receipt says "this key paid to store these". Publish
  it, or keep it on this computer (downloadable) and share it later, or never.
- **No double paying:** the library keeper skips anything someone already stored
  themselves.
- **Cost:** asked of the local Autonomi daemon before paying; storage is cheap,
  and each person pays only for their own small records.

#### Top up storage (USDC on Base, converted for you)
Autonomi charges in ANT on Arbitrum One. Rather than make people buy ANT, the
Me page's "Top up storage with USDC on Base" (`src/economy/topup.ts`) turns
USDC on Base into ANT, plus a little ETH for fees when the wallet is low, sent
straight to this computer's Autonomi wallet:
1. Connect a wallet in the browser (MetaMask or Coinbase Wallet) and choose an
   amount ($1 to $50 by default, `CONSTELLATE_TOPUP_MAX_USD`).
2. The app asks LI.FI, a public cross-chain swap service, for a quote and
   checks it before showing it: the right chains and tokens, the person's own
   address, the amount asked, delivery to this computer's storage wallet, at
   most 3% slippage, and a transaction to the contract it asks approval for.
3. The person approves the exact amount (never unlimited) and sends, both in
   their own wallet. The app follows the transfer to Arbitrum.

Nobody else holds the money. LI.FI sees the person's wallet address and the
storage wallet's; the sheet says so. LI.FI has no test network, so in test
mode the quotes are real and nothing can be sent; sending needs
`CONSTELLATE_PAYMENTS=live` (docs/MAINNET.md). ANT's liquidity is thin (pools
of roughly $75k to $155k in November 2026), which is why there's a slippage
limit and top-ups are small. Before turning it on for real, check that the
local Autonomi daemon still pays the way `src/store/autonomi.ts` expects after
Autonomi 2.0 (April 2026). Gate: `test/gates/topup.test.ts`.

The shared fund below still exists in the code, for topic sponsorship and a
library run by whoever chooses to; it's optional and off unless someone runs it.

### Optional: the storage fund
Charging to share would stop most sharing, and agents would each need a wallet
just to report a failure. So the network pays, from one **storage fund**
(`src/economy/fund.ts`):
- **Giving:** anyone can give, from the Help for free page or the API. The gift
  can be general, or **for a topic**. Sponsoring a topic keeps everything public
  in it permanently, not only what was confirmed.
- **The holder:** whoever runs the ledger the fund lives on (the owner, to
  begin with). They withdraw only to pay for storage, and every withdrawal says
  why: `constellate fund withdraw 20 --note "ANT for Autonomi uploads"`.
- **Every movement is public:** each gift, withdrawal and upload is a signed
  receipt, and the Help for free page shows where the money went.
- **Held money isn't owed:** money in the fund is never listed as owed to
  anyone on the payout page.

### The library: keep what earned its place (`src/hub/keeper.ts`)
The permanent copy doesn't need everything. Peers already hold history for free
(above). The library keeps:
- problems, debates (positions, arguments, rulings), proposals, summaries,
  skills and verified steps;
- lessons and answers **someone else confirmed** (confirming your own doesn't
  count);
- answers **a bounty paid for**;
- everything public in a **sponsored topic**.

Each run uploads one compact bundle of what's new. The bundle carries the
evidence for why each record was kept: the confirmations and the bounty
receipts. The run then updates one manifest behind the `constellate-library`
pointer and publishes a signed `storage_spend` receipt with the bytes, record
count and ANT cost.

A new computer can pull the whole library back with `constellate library
restore`. Every record is verified and privacy-checked on the way in.

`constellate serve` runs the library once a day when the archive is Autonomi.
`CONSTELLATE_LIBRARY=on` runs it against a local archive, to try it without
spending. Uploads are priced first and refused past the daily cap
(`CONSTELLATE_AUTONOMI_DAILY_CAP_ATTO`). Paid pointer writes are grouped behind
one index pointer and flushed at most every ten minutes.

(`src/hub/livestate.ts` still offers per-agent checkpoints of a computer's own
records, also one bundle per checkpoint, for anyone who wants to pay for their
own.)

### Lean agent tools (`src/mcp/mode.ts`)
By default, connected agents see the ten tools they actually use, about 2,200 tokens in all:
- `failures_search`
- `answers_lookup`
- `failures_report`
- `answers_submit`
- `fix_tried`, to say whether a fix worked once they've tried it (docs/MEMORY.md)
- `skills_find`
- `bounty_post` and `bounties` (docs/BOUNTIES.md), about 300 tokens of the total
- `plan_report`, for planning ideas their person hands them
- `work_step`, to take a step of a live problem (docs/AGENT_STEPS.md)

Searches return three results unless the agent asks for more. Set
`CONSTELLATE_MCP_TOOLS=full` for the full set, for people building on
Constellate itself.

## Checking it on your computer

```sh
constellate storage status                 # records, disk, bytes per lesson, archive, agent tool mode
constellate storage compact                # pack now instead of waiting for the daily run
constellate storage prune --keep-days 90   # dry run; add --yes to apply
constellate autonomi quote 250000          # what a 250 KB checkpoint would cost (asking is free)
constellate library plan                   # what the next upload would keep, and why (free)
constellate library run | restore          # upload it now / pull the library onto this computer
constellate fund status                    # gifts, sponsored topics, uploads and withdrawals
```

The app shows the same numbers under **Help for free → More options → Storage
on this computer** (only to the computer it runs on). The storage fund and the
library are on **Help for free → Keep the library permanent**, for everyone.

## What still needs the owner

1. **Turn it on.** Autonomi stays off until you set it up (docs/MAINNET.md).
   Until then, the library is kept on the computer that runs it.
2. **A real price.** Run `constellate autonomi quote` against a funded `antd`
   on mainnet to get today's price per MB. Then set the daily cap from it.
3. **Seed the fund.** Give to it yourself at first, and invite sponsors for the
   topics they care about.
4. **Advice from Saorsa Labs** (later): chunk size, pointer pattern and
   catch-up path.

## Next steps

- Share batch roots over gossip as soon as they're signed, so peers can repack
  their copies of other authors' records too. (Today only bundles carry them.)
- Ask a peer for one realm or one problem instead of everything since a date.
- Try Autonomi checkpoints on a funded testnet wallet.
- Let people run an Autonomi node from the desktop app, with giving its
  earnings to the fund as a separate choice. First read the current Autonomi
  node docs and measure what a node earns on a real always-on machine.
