import type { Hub } from '../hub/hub.js';
import type { ReceiptBody } from './economy.js';

/**
 * The storage fund (docs/STORAGE.md): the network, not the people sharing, pays to keep the library
 * permanent. Anyone can give to it, generally or for one topic (a sponsorship, which also widens what the
 * library keeps for that topic). The fund's holder (whoever runs the ledger it lives on) withdraws only to
 * pay for storage, and every donation, withdrawal and upload is a signed receipt anyone can check.
 */
export const FUND = 'fund:storage';
const DAY = 86_400_000;
const TOPIC = /^[a-z0-9][a-z0-9 _.+-]{0,47}$/;

export interface FundView {
  holds_money_here: boolean; balance: number | null;
  given: number; donors: number; withdrawn: number;
  topics: { topic: string; amount: number; sponsors: number }[];
  spends: { at: string; bytes: number; records: number; atto_ant: string; archive: string; address: string }[];
  last_week: { uploads: number; bytes: number; atto_ant: string };
  recent: { at: string; type: string; amount: number; topic: string | null; note: string | null }[];
}

export class StorageFund {
  constructor(private readonly hub: Hub) {}

  private receipts(type: ReceiptBody['type']) {
    return this.hub.node.store.ofKind('receipt').filter((s) => (s.rec.body as unknown as ReceiptBody).type === type);
  }

  /** Topics someone paid to keep: the library keeps everything public in them, not only what was confirmed. */
  sponsoredTopics(): Set<string> {
    return new Set(this.receipts('fund_donation').map((s) => (s.rec.body as { topic?: string }).topic).filter((t): t is string => !!t));
  }

  /** Give from this computer's balance, to the fund in general or to keep one topic. */
  async donate(amount: number, topic?: string) {
    const economy = this.hub.economy;
    if (!economy?.rail.release) throw new Error('the storage fund is paid from this computer\'s Constellate balance: open the app (or run `constellate serve`)');
    amount = Math.floor(amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('give an amount above zero');
    const t = topic?.trim().toLowerCase() || undefined;
    if (t && !TOPIC.test(t)) throw new Error('a topic is a short tag, like "rust" or "x0x"');
    if (economy.balance() < amount) throw new Error('not enough balance for that');
    return economy.pay(FUND, amount, 'fund_donation', [], t ? { topic: t } : {});
  }

  /** The holder takes money out to buy storage. Says why, publicly. */
  async withdraw(amount: number, note: string) {
    const economy = this.hub.economy;
    if (!economy?.rail.release) throw new Error('no ledger attached');
    if (!note.trim()) throw new Error('say what the money is for, e.g. "ANT for Autonomi uploads"');
    amount = Math.floor(amount);
    const ref = `fund_withdrawal:${Date.now()}:${amount}`;
    if (!economy.rail.release(FUND, economy.me, amount, ref)) throw new Error('already withdrawn');
    const { record } = await this.hub.node.submit({ kind: 'receipt', context: { task: 'payment: fund_withdrawal', domain: ['payments', 'storage'], environment: economy.rail.network }, body: { type: 'fund_withdrawal', payer: FUND, payee: economy.me, amount, tx: ref, rail: economy.rail.name, network: economy.rail.network, note: note.trim().slice(0, 200) }, refs: [] }, { publish: true });
    return record;
  }

  view(now = Date.now()): FundView {
    const gifts = this.receipts('fund_donation').map((s) => ({ s, b: s.rec.body as unknown as ReceiptBody & { topic?: string } }));
    const outs = this.receipts('fund_withdrawal').map((s) => s.rec.body as unknown as ReceiptBody & { note?: string });
    const spends = this.receipts('storage_spend').map((s) => ({ at: s.rec.created, ...(s.rec.body as unknown as { bytes: number; records: number; atto_ant: string; archive: string; address: string }) }));
    const byTopic = new Map<string, { amount: number; sponsors: Set<string> }>();
    for (const { b } of gifts) if (b.topic) { const t = byTopic.get(b.topic) ?? { amount: 0, sponsors: new Set() }; t.amount += b.amount; t.sponsors.add(b.payer); byTopic.set(b.topic, t); }
    const week = spends.filter((x) => Date.parse(x.at) > now - 7 * DAY);
    const rail = this.hub.economy?.rail;
    return {
      holds_money_here: !!rail?.release, balance: rail?.release ? rail.balance(FUND) : null,
      given: gifts.reduce((n, g) => n + g.b.amount, 0), donors: new Set(gifts.map((g) => g.b.payer)).size,
      withdrawn: outs.reduce((n, o) => n + o.amount, 0),
      topics: [...byTopic].map(([topic, t]) => ({ topic, amount: t.amount, sponsors: t.sponsors.size })).sort((a, b) => b.amount - a.amount),
      spends: spends.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20),
      last_week: { uploads: week.length, bytes: week.reduce((n, x) => n + x.bytes, 0), atto_ant: week.reduce((n, x) => n + BigInt(x.atto_ant || '0'), 0n).toString() },
      recent: [
        ...gifts.map(({ s, b }) => ({ at: s.rec.created, type: 'gift', amount: b.amount, topic: b.topic ?? null, note: null })),
        ...this.receipts('fund_withdrawal').map((s) => { const b = s.rec.body as unknown as { amount: number; note?: string }; return { at: s.rec.created, type: 'withdrawal', amount: b.amount, topic: null, note: b.note ?? null }; }),
      ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12),
    };
  }
}
