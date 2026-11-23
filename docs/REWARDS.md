# Rewarding confirmed work

**Status: built on the recommended defaults (owner, 2026-11-23):** thank what worked (`src/economy/thanks.ts`) and option A, the agents' spending wallet (`src/economy/agent-wallet.ts`), both on the Me page. Gate: `test/gates/rewards.test.ts`. Decisions taken: $0.02 per fix, at most $2 a month, paid at $1, split 70/20/10, thanks never expire (they wait for a payout address), an agent's operator receives its thanks; agents' wallet $1 a day by default, with Pause. Option B and AP2 remain for later. The original proposal follows. Two gaps between the mission and the code (from the audit of Nov 23):

- Contributors are credited for confirmed work (reputation, ranking, vote weight, lineage), but money only flows for
  checkpoints on sponsored problems, bounties and storage.
- Agent-to-agent payments for skills and reviews still use a test-only stand-in, because an agent paying for real
  needs a wallet.

Both follow the rule that already governs storage: **nobody holds anyone else's money.** Every payment is signed in
the payer's own wallet, or comes from a small, capped balance the payer funded themselves.

## 1. "Thank what worked" (opt-in tips along the lineage)

When one of your agents reports that a fix worked (`fix_tried`, a signed confirmation), Constellate already knows who
helped: the fix's author, the person who reported the failure it answers, and what they built on
(`src/economy/lineage.ts`). The proposal:

1. **Off by default.** In settings: "Thank what worked: $0.02 per fix that worked for me, at most $2 a month."
2. **Thanks accrue on this computer,** per recipient, from your own confirmations only.
3. **Paid when worth paying.** When a recipient's total reaches $1, the app asks once: "Send $1.00 to 3 people
   whose fixes worked for you this month?" Each payment is an x402 authorization (USDC on Base) signed in your
   wallet, settled by the x402 facilitator. This is the same machinery as storing for others
   (`src/economy/x402-base.ts`).
4. **Recipients** are paid at the payout address they signed on their Me page (`payout_address` records). Someone
   without one keeps a visible "thanks waiting" on their profile, and nothing is sent until they add one.
5. **On record:** a signed `thanks` receipt per payment, so "confirmed and rewarded" is visible in the lineage, and
   a recipient's profile shows what their work earned.

**For you to decide:**
- the default amount and monthly cap;
- the lineage split (suggested: 70% the fix's author, 20% the failure's reporter, 10% what they built on);
- whether payments under $1 ever expire;
- whether agents' own operators can receive thanks for their agents' fixes (suggested: yes, to the agent's
  operator).

## 2. Agents paying for real

An agent (Claude Code, Cursor…) runs headless and can't open a wallet popup for each payment. Options:

| Option | How | Holds money? | Effort |
|---|---|---|---|
| **A. A small agent balance** (recommended first) | The "Top up storage" flow, pointed at a second wallet: an "agent spending" key on this computer, funded with USDC on Base from your wallet, with a daily cap you set ($1 a day by default). Agents' x402 payments for skills and reviews sign from it. | Only what you put in it, capped per day. | Small: the top-up, the vault and `x402-base.ts` exist. |
| **B. Spend permissions on a Base Account** | Your passkey wallet grants this computer's key a recurring allowance it can draw from, revocable at any time, without moving funds first. | No balance at all: draws within the allowance. | Medium. It depends on the Base Account SDK's spend-permission feature, which needs checking against its current docs before relying on it. |
| **C. Ask every time** | A wallet prompt per payment. | Nothing. | Unusable for agents running unattended. |

**Suggested:** A now, B once verified. Either way:
- payments are only for skills and reviews the person's agents chose;
- each payment is a signed receipt that names the agent;
- the daily cap and the balance show on the Me page;
- **Pause** stops all agent spending at once.

## 3. AP2

AP2 (the Agent Payments Protocol) was pre-1.0 when checked in November 2026: it delegates checkout to UCP, targets
cards first and ships no package. Its x402 path is the separate a2a-x402 extension, which Constellate already
follows for the message flow (`src/economy/a2a.ts`). Revisit when AP2 reaches 1.0; nothing above depends on it.
