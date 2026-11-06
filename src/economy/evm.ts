import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8 } from '../util/bytes.js';

/**
 * Just enough Ethereum to take USDC deposits and confirm payouts without a
 * wallet library or a hot key on the server: read receipts over JSON-RPC, and
 * recover who signed a MetaMask personal_sign message.
 */
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => { const h = s.replace(/^0x/, ''); return new Uint8Array(h.match(/../g)?.map((x) => parseInt(x, 16)) ?? []); };

/** ERC-20 Transfer(address,address,uint256) topic. */
export const TRANSFER_TOPIC = '0x' + hex(keccak_256(utf8('Transfer(address,address,uint256)')));

export const addressFromPublicKey = (pub: Uint8Array) => {
  const full = pub.length === 65 ? pub : secp256k1.Point.fromBytes(pub).toBytes(false);
  return '0x' + hex(keccak_256(full.slice(1))).slice(24);
};
export const normalize = (a: string) => a.toLowerCase();
export const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

/** EIP-191 personal_sign hash, as MetaMask signs it. */
export function personalHash(message: string) {
  const m = utf8(message);
  return keccak_256(new Uint8Array([...utf8(`\x19Ethereum Signed Message:\n${m.length}`), ...m]));
}

/** The address that signed `message` with MetaMask's personal_sign (65-byte r||s||v hex). */
export function recoverSigner(message: string, signatureHex: string): string {
  const sig = unhex(signatureHex);
  if (sig.length !== 65) throw new Error('signature must be 65 bytes');
  const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  const recovered = new Uint8Array([v, ...sig.slice(0, 64)]); // noble's "recovered" format: recovery byte first
  return addressFromPublicKey(secp256k1.recoverPublicKey(recovered, personalHash(message), { prehash: false }));
}

/** Sign like MetaMask (tests and tools only). */
export function personalSign(message: string, secretKey: Uint8Array) {
  const s = secp256k1.sign(personalHash(message), secretKey, { prehash: false, format: 'recovered' });
  return '0x' + hex(new Uint8Array([...s.slice(1), s[0] + 27]));
}

export async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}

export interface Receipt { status: string; blockNumber: string; from: string; to: string; logs: { address: string; topics: string[]; data: string }[] }

/** ERC-20 transfers of `token` inside a transaction receipt. Amounts in the token's smallest unit. */
export function transfers(receipt: Receipt, token: string) {
  return receipt.logs.filter((l) => normalize(l.address) === normalize(token) && l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3)
    .map((l) => ({ from: '0x' + l.topics[1].slice(26), to: '0x' + l.topics[2].slice(26), amount: BigInt(l.data) }));
}

/** A confirmed, successful receipt, or null while it isn't. */
export async function confirmedReceipt(rpcUrl: string, tx: string, minConfirmations: number): Promise<Receipt | null> {
  const r = await rpc<Receipt | null>(rpcUrl, 'eth_getTransactionReceipt', [tx]);
  if (!r) return null;
  if (r.status !== '0x1') throw new Error('that transaction failed on-chain');
  const head = BigInt(await rpc<string>(rpcUrl, 'eth_blockNumber', []));
  return head - BigInt(r.blockNumber) + 1n >= BigInt(minConfirmations) ? r : null;
}
