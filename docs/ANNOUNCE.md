# Announcing progress: the call to lend a computer

When lent computers make progress that a machine has checked, the announcer writes a short post saying so, with
a link for people to lend their own computer. It runs on the owner's computer. It says no more than the network
knows: **a machine checked it, and no person has reviewed it yet.** It never says "solved" or "proved".

Code: `src/announce/announce.ts` (what to say, the tiers, the outbox) and `src/announce/sinks.ts` (where it goes).
Gate: `test/gates/announce.test.ts`.

## What it reads

Only checkpoints this computer re-checked itself (`Problems.state`). Before a checkpoint counts, the computer
re-runs the problem's machine check on the answer, and the answer must have been confirmed by a different identity
running a different model family from the one that gave it. A wrong answer, an unchecked answer, or one checked by
the same identity or the same model family says nothing. Warm-up checks (`exact`, `sum_squares_mod`) say nothing
either: they are practice, not news.

## What it says

| Event | Post |
|---|---|
| First checked step on a problem | `"TITLE" has a step checked by machine on Constellate (2 of 5 done). No person has reviewed it yet.` |
| A possible find (a witness check passed on an open search) | `Possible find on "TITLE": an answer sent to Constellate passed its machine check. No person has reviewed it yet.` |
| Every step of a problem checked | `All 5 steps of "TITLE" are checked by machine on Constellate. No person has reviewed them yet.` |
| The weekly digest (Monday to Sunday, UTC) | `Last week on Constellate, 7 steps on 3 problems were checked by machine. No person has reviewed them yet.` |

Every post ends with `Lend a computer: LINK`. The link defaults to this repository and can be changed with
`constellate announce set cta URL` (https only).

Posts fit in 280 characters, X's limit and the tightest of the three. A long title is shortened at a word with "…".
The feed entry keeps the whole title, the problem and checkpoint record ids, and how the step was checked.

## Two tiers

| Tier | What | When it goes |
|---|---|---|
| **Needs you** | Possible finds on open searches. Problems from a public catalogue (they carry a `source`), where a person should check the claim against the source first. Problems proposed by an identity this computer doesn't vouch for. Anything saying a whole problem is done. | Only after `constellate announce approve ID`. |
| **Auto** | The first checked step on a problem this computer or the starter library proposed, and the weekly digest. The digest leaves out possible finds and catalogue problems. | Without approval only when the owner turns automatic posting on (`constellate announce set auto on`). It is off by default. |

Progress from before announcing started (the first time `constellate announce` ran) never goes on its own. The
owner approves it or skips it.

## Safeguards

- **Approval binds to the exact words.** Approving records a hash of the post and the feed entry. If they change
  afterwards (an edited outbox file, say), the item says "the words changed after approval: approve it again" and
  nothing is sent. Approved words stay frozen: later progress doesn't rewrite them.
- **Titles are text anyone could have written.** A title with an `@` (it would mention an account), a link or a web
  address, or anything the strict privacy check flags is **blocked**, not cleaned up, and can't be approved. The
  owner can always write a post by hand.
- **The privacy check runs again at send.** If a name was added to the deny list (`CONSTELLATE_DENY_TERMS`) after
  approval, the post is held.
- **Never twice.** Each destination is marked sent the moment its post goes, and the outbox is saved after every
  post, so a restart doesn't repeat one.

## "Archived on Autonomi"

A post adds `Archived on Autonomi: ADDRESS` only when this computer's own signed `storage_spend` receipt says it
uploaded the bundle holding the checkpoint to Autonomi (`Keeper.archivedAt`). Another computer's receipt, or a
bundle kept on this computer only, doesn't count. The address is printed as text, with no gateway link, because
nothing here has chosen a gateway. The feed entry adds the receipt's record id. Paid storage is off until the owner
turns it on (docs/MAINNET.md), so by default posts don't carry this line. If the line doesn't fit, the post drops it
and the feed entry keeps it.

## Where posts go

Nothing leaves this computer until `constellate announce send --yes`. Each destination is off until the owner sets
it up.

| Destination | Set up | What happens |
|---|---|---|
| **Feed** (on by default) | `constellate announce set feed on\|off` | An Atom file at `~/.constellate/announce/feed.xml`, for a website or feed reader. No network. |
| **Bluesky** | `constellate announce set bluesky HANDLE [SERVER]`, then `constellate keys set bluesky` with an app password (Bluesky: Settings > Privacy and security > App passwords) | Logs in (`com.atproto.server.createSession`) and posts (`com.atproto.repo.createRecord`, `app.bsky.feed.post`, with link facets so the link is clickable). |
| **Mastodon** | `constellate announce set mastodon https://INSTANCE`, then `constellate keys set mastodon` with an access token that has the `write:statuses` scope | `POST /api/v1/statuses`, public, in English, with an idempotency key. |
| **X** | Nothing to set up | No account access at all. `constellate announce` shows a compose link (`x.com/intent/tweet?text=…`) for each post cleared to go. The person reads it in X's own composer and sends it by hand. |

The app password and token are kept in the encrypted vault on this computer and sent only to their own service.
`set bluesky off` and `set mastodon off` remove an account.

## Commands

```
constellate announce                 # find what's new; list each item, its tier and what it waits for
constellate announce approve ID      # approve these exact words
constellate announce skip ID         # drop one
constellate announce send            # what would go, and where (dry run)
constellate announce send --yes      # send it
constellate announce set auto on     # auto-tier items go without approval at the next send --yes
```

Nothing runs on a schedule by itself. To post on a schedule, the owner adds a job that runs
`constellate announce && constellate announce send --yes`.

## Sources

Read 2026-11-11.

- Bluesky: the atproto lexicons (bluesky-social/atproto, `lexicons/`, commit ec49bcb):
  - `com.atproto.server.createSession` takes `identifier` and `password` and returns `accessJwt` and `did`.
  - `com.atproto.repo.createRecord` takes `repo`, `collection` and `record`, which must contain `$type`.
  - `app.bsky.feed.post` needs `text` (at most 300 graphemes) and `createdAt`.
  - Facet byte offsets count UTF-8 bytes.
- Mastodon: docs.joinmastodon.org/methods/statuses.
  - `POST /api/v1/statuses` takes `status`, `visibility` and `language`, with a Bearer token.
  - Idempotency keys are stored for up to an hour.
  - The default limit is 500 characters, and links count as 23.
- X: docs.x.com/x-for-websites/post-button/overview. Web Intents need no app, stored credentials or app
  permissions.

## Honest about what isn't done

- **No account is set up.** Going live needs the owner's own Bluesky and Mastodon accounts and credentials, and a
  decision about which account posts (issue #28). Nothing in this repository creates an account or posts.
- **How X counts a link wasn't confirmed.** Posts are fitted with every link at full length, which can only
  overcount.
- **Bluesky has no idempotency key.** The outbox is saved after every post, so a restart never repeats one. If
  Bluesky accepts a post but the reply is lost, the next `send --yes` could post it again.
- **Only in the terminal for now.** An announcements panel in the app (approve, skip, the X link) is issue #29.
- **The gate uses stand-ins** for the Bluesky and Mastodon servers. No real post has been made.
