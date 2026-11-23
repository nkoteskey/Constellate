import { isAddress, normalize, rpc } from './evm.js';

/**
 * Top up storage (docs/STORAGE.md, "Top up storage"): turn the person's USDC on Base into ANT (and a little ETH for
 * gas) on Arbitrum One, delivered to this computer's own Autonomi wallet, in one approval and one transaction from
 * the person's own wallet. Nobody else holds the money: the person signs in their wallet, the route runs through a
 * public cross-chain swap service (LI.FI), and the result lands in the wallet the local Autonomi daemon pays from.
 *
 * Safety, checked here before anything reaches the person's wallet:
 * - the quote must deliver the expected token on the expected chain to this computer's storage wallet, from the
 *   person's own address, for the amount asked, within the slippage limit;
 * - the transaction must be on Base and go to the approval address the quote names;
 * - a top-up is capped (CONSTELLATE_TOPUP_MAX_USD, default $50) and the approval is for the exact amount, never
 *   unlimited;
 * - quotes are free and always shown; sending is possible only with real payments on (CONSTELLATE_PAYMENTS=live,
 *   docs/MAINNET.md). LI.FI has no test network, so test mode shows real quotes and sends nothing.
 *
 * The swap service sees the person's wallet address and the storage wallet's address; the app says so.
 */
export const BASE = 8453, ARBITRUM = 42161;
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const ANT_ARBITRUM = '0xa78d8321B20c4Ef90eCd72f2588AA985A4BDb684';
export const ETH_NATIVE = '0x0000000000000000000000000000000000000000';
const API = 'https://li.quest/v1';
export const SLIPPAGE = 0.03;
/** Below this much ETH (wei) on Arbitrum, a top-up also sends some for gas. */
export const GAS_LOW_WEI = 200_000_000_000_000n; // 0.0002 ETH
export const GAS_TOPUP_USD = 0.5;

export interface TxRequest { to: string; data: string; value: string; chainId: number; gasLimit?: string }
export interface Leg { what: 'ANT for storage' | 'ETH for gas'; from_usd: number; to_amount: string; to_amount_min: string; to_token: string; approval_address: string; tx: TxRequest; tool: string; seconds: number; fee_usd: number }
export interface TopUpQuote { storage_wallet: string; from: string; usd: number; legs: Leg[]; approve: { token: string; spender: string; amount: string }[]; can_send: boolean; note: string }

const maxUsd = () => Number(process.env.CONSTELLATE_TOPUP_MAX_USD ?? 50);
export const sendingAllowed = () => process.env.CONSTELLATE_PAYMENTS === 'live';

/** Why a LI.FI quote can't be shown to the person, or null when it does exactly what was asked. */
export function quoteProblem(q: any, want: { from: string; to: string; toToken: string; fromAmount: bigint }): string | null {
  const a = q?.action, e = q?.estimate, tx = q?.transactionRequest;
  if (!a || !e || !tx) return 'the swap service returned an incomplete quote';
  if (Number(a.fromChainId) !== BASE || Number(a.toChainId) !== ARBITRUM) return 'the quote is for the wrong chains';
  if (normalize(String(a.fromToken?.address)) !== normalize(USDC_BASE)) return 'the quote spends a token other than USDC';
  if (normalize(String(a.toToken?.address)) !== normalize(want.toToken)) return 'the quote delivers the wrong token';
  if (normalize(String(a.fromAddress)) !== normalize(want.from)) return 'the quote is for a different wallet';
  if (normalize(String(a.toAddress ?? a.fromAddress)) !== normalize(want.to)) return 'the quote delivers somewhere other than this computer’s storage wallet';
  if (BigInt(String(a.fromAmount)) !== want.fromAmount) return 'the quote spends a different amount';
  if (Number(a.slippage ?? 1) > SLIPPAGE + 1e-9) return 'the quote allows more slippage than the limit';
  if (Number(tx.chainId) !== BASE) return 'the transaction isn’t on Base';
  if (!isAddress(String(tx.to)) || !isAddress(String(e.approvalAddress))) return 'the quote names an invalid contract';
  if (normalize(String(tx.to)) !== normalize(String(e.approvalAddress))) return 'the transaction goes somewhere other than the contract it asks approval for';
  if (!(BigInt(String(e.toAmountMin)) > 0n)) return 'the quote delivers nothing';
  return null;
}

export class TopUp {
  constructor(private readonly o: { fetch?: typeof fetch; storageWallet: () => Promise<{ address: string | null; eth_wei: string | null; ant_atto: string | null }> }) {}

  private async get(path: string) {
    const r = await (this.o.fetch ?? fetch)(`${API}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`the swap service answered ${r.status}${(j as { message?: string }).message ? `: ${(j as { message: string }).message}` : ''}`);
    return j as any;
  }

  private async leg(what: Leg['what'], from: string, to: string, toToken: string, usd: number): Promise<Leg> {
    const fromAmount = BigInt(Math.round(usd * 1e6)); // USDC has 6 decimals
    const q = await this.get(`/quote?${new URLSearchParams({ fromChain: String(BASE), toChain: String(ARBITRUM), fromToken: USDC_BASE, toToken, fromAddress: from, toAddress: to, fromAmount: fromAmount.toString(), slippage: String(SLIPPAGE), integrator: 'constellate' })}`);
    const why = quoteProblem(q, { from, to, toToken, fromAmount });
    if (why) throw new Error(`not shown: ${why}`);
    const fees = [...(q.estimate.feeCosts ?? []), ...(q.estimate.gasCosts ?? [])].reduce((n: number, c: { amountUSD?: string }) => n + (Number(c.amountUSD) || 0), 0);
    return {
      what, from_usd: usd, to_amount: String(q.estimate.toAmount), to_amount_min: String(q.estimate.toAmountMin), to_token: toToken,
      approval_address: q.estimate.approvalAddress, tool: String(q.tool ?? q.toolDetails?.name ?? 'swap'), seconds: Number(q.estimate.executionDuration ?? 0), fee_usd: Math.round(fees * 100) / 100,
      tx: { to: q.transactionRequest.to, data: q.transactionRequest.data, value: String(q.transactionRequest.value ?? '0x0'), chainId: BASE, ...(q.transactionRequest.gasLimit ? { gasLimit: String(q.transactionRequest.gasLimit) } : {}) },
    };
  }

  /** Quotes for turning `usd` of the person's USDC on Base into ANT (and gas, if low) in this computer's storage wallet. */
  async quote(from: string, usd: number): Promise<TopUpQuote> {
    if (!isAddress(from)) throw new Error('connect a wallet first');
    if (!(usd >= 1) || usd > maxUsd()) throw new Error(`a top-up is between $1 and $${maxUsd()}`);
    const w = await this.o.storageWallet();
    if (!w.address || !isAddress(w.address)) throw new Error('this computer has no Autonomi wallet yet (docs/MAINNET.md, step 1)');
    const needGas = !w.eth_wei || BigInt(w.eth_wei) < GAS_LOW_WEI;
    const legs = [await this.leg('ANT for storage', from, w.address, ANT_ARBITRUM, needGas ? usd - GAS_TOPUP_USD : usd)];
    if (needGas) legs.push(await this.leg('ETH for gas', from, w.address, ETH_NATIVE, GAS_TOPUP_USD));
    // Exact-amount approvals, one per contract: never unlimited.
    const bySpender = new Map<string, bigint>();
    for (const l of legs) bySpender.set(normalize(l.approval_address), (bySpender.get(normalize(l.approval_address)) ?? 0n) + BigInt(Math.round(l.from_usd * 1e6)));
    return {
      storage_wallet: w.address, from, usd, legs,
      approve: [...bySpender].map(([spender, amount]) => ({ token: USDC_BASE, spender, amount: amount.toString() })),
      can_send: sendingAllowed(),
      note: sendingAllowed() ? 'Check the amounts, then approve in your wallet.' : 'Test mode: these are real quotes, and nothing is sent until real payments are turned on (docs/MAINNET.md).',
    };
  }

  /** Where a top-up transaction is: LI.FI's status for the cross-chain transfer. */
  async status(txHash: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error('not a transaction hash');
    const s = await this.get(`/status?${new URLSearchParams({ txHash, fromChain: String(BASE), toChain: String(ARBITRUM) })}`);
    return { status: String(s.status ?? 'NOT_FOUND'), substatus: s.substatus ?? null, received: s.receiving?.amount ?? null };
  }
}

/** The storage wallet's balances read straight from Arbitrum, when the Autonomi daemon can't say. */
export async function arbitrumBalances(rpcUrl: string, address: string) {
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}`;
  const [ant, eth] = await Promise.all([rpc<string>(rpcUrl, 'eth_call', [{ to: ANT_ARBITRUM, data }, 'latest']), rpc<string>(rpcUrl, 'eth_getBalance', [address, 'latest'])]);
  return { ant_atto: BigInt(ant).toString(), eth_wei: BigInt(eth).toString() };
}
