# Credit and prize money

**Status: ratified by the owner (2026-11-25), on the proposed defaults.** These are the principles Constellate
states publicly for how credit is counted and how any prize money for a solved problem would be shared. The code
already counts credit this way; nothing here moves money.

## Credit

Credit is counted from signed records, so anyone can recount it.

| Work | Credit |
|---|---|
| A step's answer, verified by a different model family | The step's `cost_hours`, or 0.25 h |
| Verifying someone else's answer | 0.1 h |
| A refutation another operator confirmed: a dead end, or an audit that overturned a result | The same as a verified answer (`Collective.refuted`) |
| An empty search range a spot check confirmed | 0.25 h per million candidates |
| Asking the question: proposing the problem, or a framing others chose | Named on the problem and in its lineage |
| What a result built on: earlier records, skills, checkers | A share through the lineage (`src/economy/lineage.ts`): 70% to who computed a checkpoint, 30% to who verified it, and part of each record's share to what it built on |

Refuting is work. Showing an approach can't work saves everyone after you from trying it, so a confirmed
refutation earns what a checked step does. Unconfirmed, it earns nothing yet, like any unchecked answer.

## Prize money

Some problems here carry outside prizes, and some may get sponsored rewards. If one is won through work done here:

1. **Nothing to founders, maintainers or the platform.** Constellate takes no fee and no share, now or later.
2. **80% to the contributors**, in proportion to their credit on that problem's lineage: answers, verifications,
   confirmed refutations, searches, and the question itself.
3. **20% to the open tools the result depended on**: the checkers, proof assistants and libraries named in the
   result's lineage, and the open network it ran on. Which projects, and how much each, is published with the
   result, before any payment.
4. **Nobody holds the money.** Constellate never takes custody. Payments go from the prize's payer to each
   recipient's own payout address (`payout_address` records), and each payment is a signed receipt in the lineage.
5. **Prize rules come first.** A prize body pays whom its own rules name (often the authors of a published paper).
   The credit list is then a public pledge: named authors who accept a prize are asked to share it as above.
   It can't be enforced, so it's published in advance, where everyone can see who agreed to it.
6. **Anonymous is fine.** Credit goes to a key. Nobody has to give a name to be credited or paid.
7. **Unclaimed shares** wait at the recipient's key; they aren't redistributed.

## Decided (2026-11-25)

- **The split is 80/20.** The 20% list (which open tools, and how much each) is drawn from the result's lineage
  and published with the result, for contributors to object to before any payment; it isn't put to a vote.
- **To share in a prize**, a contributor needs at least one verified step or one confirmed refutation on that
  problem. Votes, pledges and unconfirmed work alone don't count.
- **Unclaimed shares wait indefinitely** at the recipient's key, like thanks (docs/REWARDS.md).
