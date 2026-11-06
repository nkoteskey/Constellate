import { sha256Hex } from '../core/canonical.js';
import { utf8 } from '../util/bytes.js';

/**
 * On-device privacy scrubber. Runs before signing; anything flagged is
 * BLOCKED, never trimmed, so an agent can never leak its user's data by
 * reporting a failure. Raw prompts/files/user text never go out: callers
 * pass them through `hashInputs` instead.
 */
export interface Finding { path: string; type: string; excerpt: string }
export interface ScrubResult { ok: boolean; findings: Finding[] }

export interface ScrubOptions {
  /** Extra literal terms that must never leave the machine (names, client names, hostnames...). */
  denyTerms?: string[];
  /** 'strict' also blocks private IPs, home paths and long high-entropy tokens. */
  level?: 'standard' | 'strict';
}

type Detector = { type: string; re: RegExp; check?: (m: string) => boolean };

const SECRET_DETECTORS: Detector[] = [
  { type: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { type: 'aws_access_key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: 'github_token', re: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { type: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { type: 'openai_key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/g },
  { type: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { type: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'stripe_key', re: /\b[rs]k_(live|test)_[0-9A-Za-z]{16,}\b/g },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { type: 'bearer_token', re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
  { type: 'credential_assignment', re: /\b(pass(word|wd)?|secret|api[_-]?key|token|auth)\s*[:=]\s*["']?[^\s"',;]{6,}/gi },
  { type: 'url_credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi },
  { type: 'x0x_api_token_path', re: /\bapi-token\b.{0,3}[0-9a-f]{32,}/gi },
];

const PII_DETECTORS: Detector[] = [
  { type: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: 'phone', re: /(?<![\w.])\+?\d[\d\s().-]{8,}\d(?![\w.])/g, check: (m) => { const d = m.replace(/\D/g, ''); return (m.startsWith('+') || /[\s().-]/.test(m)) && d.length >= 10 && d.length <= 15 && !/^\d{4}-\d{2}-\d{2}/.test(m); } },
  { type: 'credit_card', re: /\b(?:\d[ -]?){13,19}\b/g, check: (m) => luhn(m.replace(/\D/g, '')) },
  { type: 'us_ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: 'public_ip', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, check: (m) => isIp(m) && !isPrivateIp(m) },
];

const STRICT_DETECTORS: Detector[] = [
  { type: 'private_ip', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, check: (m) => isIp(m) && isPrivateIp(m) && !/^(127\.|0\.0\.0\.0)/.test(m) },
  { type: 'home_path', re: /(\/Users\/|\/home\/|[A-Z]:\\Users\\)(?!runner\b|user\b|ubuntu\b|root\b)[A-Za-z0-9._-]+/g },
  { type: 'high_entropy_token', re: /\b[A-Za-z0-9+/_-]{32,}={0,2}/g, check: (m) => !/^[0-9a-f]{64}$/.test(m) && !/^[0-9a-f]{40}$/.test(m) && entropy(m) > 4.2 },
];

function luhn(d: string): boolean {
  if (d.length < 13 || d.length > 19 || /^(\d)\1+$/.test(d)) return false;
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}
const isIp = (m: string) => m.split('.').every((o) => +o <= 255);
function isPrivateIp(m: string): boolean {
  const [a, b] = m.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}
function entropy(s: string): number {
  const f = new Map<string, number>();
  for (const c of s) f.set(c, (f.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}
function mask(s: string): string {
  return s.length <= 6 ? '***' : `${s.slice(0, 3)}…${s.slice(-2)} (${s.length} chars)`;
}

function* strings(v: unknown, path: string): Generator<[string, string]> {
  if (typeof v === 'string') yield [path, v];
  else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) yield* strings(v[i], `${path}[${i}]`);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    yield [`${path}.${k}#key`, k];
    yield* strings(x, path ? `${path}.${k}` : k);
  }
}

export function scrub(value: unknown, opts: ScrubOptions = {}): ScrubResult {
  const detectors = [...SECRET_DETECTORS, ...PII_DETECTORS, ...(opts.level === 'strict' ? STRICT_DETECTORS : [])];
  const findings: Finding[] = [];
  const deny = (opts.denyTerms ?? []).filter((t) => t.trim().length >= 3).map((t) => t.toLowerCase());
  for (const [path, s] of strings(value, '')) {
    for (const d of detectors) {
      d.re.lastIndex = 0;
      for (const m of s.matchAll(d.re)) {
        if (d.check && !d.check(m[0])) continue;
        findings.push({ path, type: d.type, excerpt: mask(m[0]) });
      }
    }
    const lower = s.toLowerCase();
    for (const t of deny) if (lower.includes(t)) findings.push({ path, type: 'deny_term', excerpt: mask(t) });
  }
  return { ok: findings.length === 0, findings };
}

/** Inputs are sent as hashes so others can reproduce without seeing private data. */
export function hashInputs(...inputs: string[]): string {
  return sha256Hex(utf8(inputs.join('\u0000')));
}

export class PrivacyBlockedError extends Error {
  constructor(readonly findings: Finding[]) {
    super(`blocked by privacy scrubber: ${findings.map((f) => `${f.type} at ${f.path}`).join('; ')}`);
  }
}
