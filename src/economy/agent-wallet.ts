import { secp256k1 } from '@noble/curves/secp256k1.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { addressFromPublicKey, rpc } from './evm.js';
import { USDC_BASE } from './topup.js';
import { authorization, signAuthorization, type Authorization, type PaymentPayload, type Requirements } from './x402-base.js';
import { KeyVault } from '../contributor/keyvault.js';

/**
 * Agents paying for real (docs/REWARDS.md, option A): a small spending balance on this computer, so agents running
 * unattended can pay with x402 without a wallet prompt each time.
 *
 * - A key of its own, kept in this computer's encrypted key store (`agent-wallet`), holding only what the person
 *   sends it: USDC on Base, from their own wallet, in amounts they choose.
 * - A daily cap (default $1) and a Pause that stops all agent spending at once.
 * - Each payment is an x402 authorization (EIP-3009) for one exact amount to one payee, logged with what it was for.
 *
 * Nobody else holds the money, and the most a compromised computer can lose is what's in this small wallet.
 */
export interface AgentSettings { daily_cap_micro: number; paused: boolean }
export const AGENT_DEFAULTS: AgentSettings = { daily_cap_micro: 1_000_000, paused: false };
export interface Spend { at: string; amount_micro: number; pay_to: string; for: string; nonce: string }

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export class AgentWallet {
  private readonly dir: string;
  constructor(private readonly o: { home?: string; vault?: KeyVault; rpcUrl?: string; fetchBalance?: (address: string) => Promise<bigint> } = {}) {
    this.dir = o.home ?? process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate');
  }
  private vault() { return this.o.vault ?? new KeyVault(join(this.dir, 'keys.json')); }
  private file(n: string) { return join(this.dir, n); }

  /** This computer's agent key, created on first use. */
  private key(): Uint8Array {
    const v = this.vault();
    let k = v.get('agent-wallet');
    if (!k) { k = hex(secp256k1.utils.randomSecretKey()); v.set('agent-wallet', k); }
    return Uint8Array.from(Buffer.from(k, 'hex'));
  }
  address(): string { return addressFromPublicKey(secp256k1.getPublicKey(this.key(), false)); }

  settings(): AgentSettings { try { return { ...AGENT_DEFAULTS, ...JSON.parse(readFileSync(this.file('agent-wallet.json'), 'utf8')) }; } catch { return { ...AGENT_DEFAULTS }; } }
  set(patch: Partial<AgentSettings>): AgentSettings {
    const s = { ...this.settings(), ...patch };
    if (!Number.isInteger(s.daily_cap_micro) || s.daily_cap_micro < 0 || s.daily_cap_micro > 100_000_000) throw new Error('the daily cap is between $0 and $100');
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file('agent-wallet.json'), JSON.stringify({ daily_cap_micro: s.daily_cap_micro, paused: !!s.paused }));
    return s;
  }

  spends(): Spend[] {
    const f = this.file('agent-spend.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Spend) : [];
  }
  spentToday(now = new Date()): number { const day = now.toISOString().slice(0, 10); return this.spends().filter((s) => s.at.startsWith(day)).reduce((n, s) => n + s.amount_micro, 0); }

  /** USDC on Base in the agent wallet (read from Base). */
  async balance(): Promise<bigint> {
    const a = this.address();
    if (this.o.fetchBalance) return this.o.fetchBalance(a);
    const data = `0x70a08231${a.slice(2).toLowerCase().padStart(64, '0')}`;
    return BigInt(await rpc<string>(this.o.rpcUrl ?? process.env.CONSTELLATE_BASE_RPC ?? 'https://mainnet.base.org', 'eth_call', [{ to: USDC_BASE, data }, 'latest']));
  }

  /** Sign an x402 payment for an agent, within the cap and unless paused; logs what it was for. */
  pay(req: Requirements, what: string, now = new Date()): PaymentPayload {
    const auth = authorization(this.address(), req, Math.floor(now.getTime() / 1000));
    return { x402Version: 1, scheme: 'exact', network: 'base', payload: { signature: this.sign(auth, what, now), authorization: auth } };
  }

  /** Sign an authorization someone prepared for this wallet (e.g. the storage market's), under the same rules. */
  sign(auth: Authorization, what: string, now = new Date()): string {
    const s = this.settings();
    if (s.paused) throw new Error('agent spending is paused on this computer');
    if (auth.from.toLowerCase() !== this.address().toLowerCase()) throw new Error('that payment isn’t from the agent wallet');
    const amount = Number(auth.value);
    if (this.spentToday(now) + amount > s.daily_cap_micro) throw new Error(`that would pass today’s cap of $${(s.daily_cap_micro / 1e6).toFixed(2)} for agent spending`);
    const signature = signAuthorization(auth, this.key());
    mkdirSync(dirname(this.file('agent-spend.jsonl')), { recursive: true });
    appendFileSync(this.file('agent-spend.jsonl'), `${JSON.stringify({ at: now.toISOString(), amount_micro: amount, pay_to: auth.to, for: what.slice(0, 200), nonce: auth.nonce } satisfies Spend)}\n`);
    return signature;
  }
}
