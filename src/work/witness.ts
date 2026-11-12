import type { Verifier } from './verifiers.js';

/**
 * Open problems where an answer is a witness: hard to find, quick for any computer to check. An agent can work on
 * one alone and honestly, because nothing counts until the machine check passes. Nobody's opinion is asked for.
 * The problems and their public sources are in src/seed/open-problems.ts (docs/OPEN_PROBLEMS.md).
 *
 * Lent computers don't try these with blind model calls (`witness`): agents and people take them through
 * work_step, typically by writing and running a search, then submit what they found.
 */
export interface WitnessVerifier extends Verifier { readonly witness: true }

/** Every integer in the output, in order (signs kept; commas and underscores in numbers allowed). */
export function integers(output: string): bigint[] {
  return [...output.replace(/(\d)[_,](?=\d{3}\b)/g, '$1').matchAll(/-?\d+/g)].map((m) => BigInt(m[0]));
}

const isqrt = (n: bigint): bigint => {
  if (n < 0n) throw new Error('negative');
  if (n < 2n) return n;
  // Newton's method from above, in integers only (works for any size).
  let x = 1n << (BigInt(n.toString(2).length) / 2n + 1n);
  for (;;) { const y = (x + n / x) >> 1n; if (y >= x) return x; x = y; }
};
export const isSquare = (n: bigint) => n >= 0n && isqrt(n) ** 2n === n;

export function modpow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n; b %= m; if (b < 0n) b += m;
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
}

const BASES = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n];
/** Miller–Rabin with the first 13 primes as bases: proven correct below 3.3 × 10^24, a strong probable-prime test above. */
export function isPrime(n: bigint): { prime: boolean; proven: boolean } {
  if (n < 2n) return { prime: false, proven: true };
  for (const p of BASES) { if (n === p) return { prime: true, proven: true }; if (n % p === 0n) return { prime: false, proven: true }; }
  let d = n - 1n, s = 0n;
  while (!(d & 1n)) { d >>= 1n; s++; }
  for (const a of BASES) {
    let x = modpow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    let composite = true;
    for (let r = 1n; r < s; r++) { x = (x * x) % n; if (x === n - 1n) { composite = false; break; } }
    if (composite) return { prime: false, proven: true };
  }
  return { prime: true, proven: n < 3_317_044_064_679_887_385_961_981n };
}

/** Fibonacci F(k) mod m by fast doubling. */
export function fibMod(k: bigint, m: bigint): bigint {
  const go = (n: bigint): [bigint, bigint] => {
    if (n === 0n) return [0n, 1n % m];
    const [a, b] = go(n >> 1n);
    const c = (a * ((2n * b - a + m) % m)) % m, d = (a * a + b * b) % m;
    return n & 1n ? [d, (c + d) % m] : [c, d];
  };
  return go(k)[0];
}

const ok = (detail: string) => ({ ok: true, detail });
const no = (detail: string) => ({ ok: false, detail });

/** x³ + y³ + z³ = n, for the n in the step's check. Output: three integers x y z (the last three in the text). */
export const threeCubesVerifier: WitnessVerifier = {
  name: 'three_cubes', machineOnly: true, witness: true,
  shape: 'check {"n": <integer>}; answer: three integers x y z with x³ + y³ + z³ = n',
  async check(spec, output) {
    const n = BigInt(String(spec.n));
    const v = integers(output).slice(-3);
    if (v.length < 3) return no('give three integers x y z');
    const [x, y, z] = v;
    const sum = x ** 3n + y ** 3n + z ** 3n;
    return sum === n ? ok(`(${x})³ + (${y})³ + (${z})³ = ${n}, recomputed`) : no(`(${x})³ + (${y})³ + (${z})³ = ${sum}, not ${n}`);
  },
};

/** A perfect cuboid: positive integer edges a b c with all three face diagonals and the space diagonal integers. */
export const perfectCuboidVerifier: WitnessVerifier = {
  name: 'perfect_cuboid', machineOnly: true, witness: true,
  shape: 'check {}; answer: three positive integers a b c whose face diagonals and space diagonal are all integers',
  async check(_spec, output) {
    const v = integers(output).slice(-3);
    if (v.length < 3 || v.some((x) => x <= 0n)) return no('give three positive integer edges a b c');
    const [a, b, c] = v;
    const sums = { 'a²+b²': a * a + b * b, 'b²+c²': b * b + c * c, 'a²+c²': a * a + c * c, 'a²+b²+c²': a * a + b * b + c * c };
    const bad = Object.entries(sums).filter(([, s]) => !isSquare(s)).map(([k]) => k);
    return bad.length ? no(`not a square: ${bad.join(', ')}`) : ok(`edges ${a}, ${b}, ${c}: every diagonal is an integer, recomputed`);
  },
};

/** A Wieferich prime above `above`: p prime and 2^(p−1) ≡ 1 (mod p²). Output: p (the last integer). */
export const wieferichVerifier: WitnessVerifier = {
  name: 'wieferich', machineOnly: true, witness: true,
  shape: 'check {"above": "<integer>"}; answer: a prime p above it with 2^(p−1) ≡ 1 (mod p²)',
  async check(spec, output) {
    const p = integers(output).at(-1);
    if (p === undefined) return no('give the prime p');
    const above = BigInt(String(spec.above ?? 0));
    if (p <= above) return no(`must be greater than ${above}: smaller ones are already searched`);
    const pr = isPrime(p);
    if (!pr.prime) return no(`${p} is not prime`);
    return modpow(2n, p - 1n, p * p) === 1n ? ok(`2^(p−1) ≡ 1 mod p² for p = ${p}${pr.proven ? '' : ' (p a strong probable prime: confirm primality with a proving tool)'}`) : no(`2^(p−1) is not 1 mod p² for p = ${p}`);
  },
};

/** A Wall–Sun–Sun prime above `above`: p prime, p ≠ 2, 5, and p² divides F(p − (p/5)). Output: p. */
export const wallSunSunVerifier: WitnessVerifier = {
  name: 'wall_sun_sun', machineOnly: true, witness: true,
  shape: 'check {"above": "<integer>"}; answer: a prime p above it with p² dividing F(p − (p/5))',
  async check(spec, output) {
    const p = integers(output).at(-1);
    if (p === undefined) return no('give the prime p');
    const above = BigInt(String(spec.above ?? 0));
    if (p <= above) return no(`must be greater than ${above}: smaller ones are already searched`);
    if (p === 2n || p === 5n) return no('p must not be 2 or 5');
    const pr = isPrime(p);
    if (!pr.prime) return no(`${p} is not prime`);
    const legendre = p % 5n === 1n || p % 5n === 4n ? 1n : -1n;
    return fibMod(p - legendre, p * p) === 0n ? ok(`p² divides F(p − (p/5)) for p = ${p}${pr.proven ? '' : ' (p a strong probable prime: confirm primality with a proving tool)'}`) : no(`p² does not divide F(p − (p/5)) for p = ${p}`);
  },
};

export const WITNESS_VERIFIERS = [threeCubesVerifier, perfectCuboidVerifier, wieferichVerifier, wallSunSunVerifier];
