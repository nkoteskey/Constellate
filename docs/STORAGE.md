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
| Tool list an agent loads | 44 tools, about 6,000 tokens | 5 tools, about 1,300 tokens |
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

### Autonomi, as the permanent copy (`src/hub/livestate.ts`)
With Autonomi turned on, a checkpoint uploads **one bundle** of what this
computer published since the last checkpoint, then updates one manifest and one
pointer. That used to be one paid upload per record.
- **Pointer writes:** they're paid too, so they're grouped behind a single
  index pointer and flushed at most every ten minutes.
- **Spending cap:** every upload is priced first and refused past the daily cap
  (`CONSTELLATE_AUTONOMI_DAILY_CAP_ATTO`).
- **Older archives:** manifests that list one record per upload still read.

### Lean agent tools (`src/mcp/mode.ts`)
By default, connected agents see the five tools they actually use:
- `failures_search`
- `answers_lookup`
- `failures_report`
- `answers_submit`
- `skills_find`

Searches return three results unless the agent asks for more. Set
`CONSTELLATE_MCP_TOOLS=full` for the full set, for people building on
Constellate itself.

## Checking it on your computer

```sh
constellate storage status                 # records, disk, bytes per lesson, archive, agent tool mode
constellate storage compact                # pack now instead of waiting for the daily run
constellate storage prune --keep-days 90   # dry run; add --yes to apply
constellate autonomi quote 250000          # what a 250 KB checkpoint would cost (asking is free)
```

The app shows the same numbers under **Help for free → More options → Storage
on this computer** (only to the computer it runs on).

## What still needs the owner

1. **Who pays for Autonomi.** A checkpoint is cheap, but someone's wallet pays
   for it. The options:
   - (a) the hub operator pays for everything;
   - (b) each computer pays for its own records;
   - (c) a shared pool funded by donations.
   Until that's decided, Autonomi stays off (docs/MAINNET.md), and peers and
   local disks hold the history.
2. **A real price.** Run `constellate autonomi quote` against a funded `antd`
   on mainnet to get today's price per MB. Then set the daily cap from it.
3. **Advice from Saorsa Labs.** They built Autonomi and x0x, and may prefer a
   different chunk size, pointer pattern or catch-up path.

## Next steps

- Share batch roots over gossip as soon as they're signed, so peers can repack
  their copies of other authors' records too. (Today only bundles carry them.)
- Ask a peer for one realm or one problem instead of everything since a date.
- Try Autonomi checkpoints on a funded testnet wallet.
