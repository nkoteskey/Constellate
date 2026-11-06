/**
 * Prices, in micro-units of a USD stablecoin (1_000_000 = $1).
 *
 * TESTNET DEFAULTS ONLY. Approved for testnet on Nov 6, 2026. Mainnet values are
 * a human decision (DESIGN.md open question: high enough to stop spam, low
 * enough not to deter real reports). Reads are always free.
 */
export const TESTNET_PRICING = {
  /** Optional refundable deposit on a failure report or answer ($0.05). Refunded plus reward on independent confirmation. */
  writeDeposit: 50_000,
  /** Reward paid on top of the refund when a deposited record is confirmed, in basis points (20%). */
  confirmRewardBps: 2_000,
  /** Minimum bounty for a second opinion ($0.02); the reviewer earns a 50% bonus if the critique is confirmed useful. */
  minReviewBounty: 20_000,
  /** Share of a paid skill's price that flows to parent skills through inheritance (20%). */
  skillParentShareBps: 2_000,
  /** Default sponsor payout per verified checkpoint ($0.10), split by lineage: 70% compute, 30% verifier. */
  perCheckpoint: 100_000,
} as const;

export const MAINNET_PRICING_APPROVED = false;
