import { describe, it, expect } from 'vitest';
import { scrub, hashInputs } from '../../src/privacy/scrub.js';

const blocked = (s: string, level: 'standard' | 'strict' = 'standard') => !scrub({ s }, { level }).ok;

describe('privacy scrubber', () => {
  it.each([
    ['AKIAABCDEFGHIJKLMNOP'],
    ['ghp_' + 'a'.repeat(36)],
    ['sk-ant-api03-' + 'x'.repeat(40)],
    ['sk-proj-' + 'Z'.repeat(40)],
    ['-----BEGIN RSA PRIVATE KEY-----'],
    ['password=hunter22'],
    ['postgres://admin:s3cret@db.example.com/x'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwx'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'],
    ['mail me at jane.doe@example.org'],
    ['call +44 20 7946 0958'],
    ['card 4111 1111 1111 1111'],
    ['ssn 123-45-6789'],
    ['server at 8.8.8.8'],
  ])('blocks %s', (s) => expect(blocked(s)).toBe(true));

  it.each([
    ['cargo build failed: E0277 trait bound not satisfied on tokio 1.38'],
    ['sha256 ' + 'a'.repeat(64)],
    ['version 2.1.0 on 2026-10-30'],
    ['listening on 127.0.0.1:12700'],
  ])('allows %s', (s) => expect(blocked(s)).toBe(false));

  it('strict mode catches home paths, private IPs and opaque tokens', () => {
    expect(blocked('/Users/alex/project', 'strict')).toBe(true);
    expect(blocked('10.1.2.3', 'strict')).toBe(true);
    expect(blocked('Zx8Qp2Lm9Rt4Vw7Ny1Kb5Hc3Jd6Gf0Ss', 'strict')).toBe(true);
    expect(blocked('/Users/alex/project')).toBe(false);
  });
  it('blocks operator deny terms and scans keys too', () => {
    expect(scrub({ a: 'working for AcmeCorp' }, { denyTerms: ['acmecorp'] }).ok).toBe(false);
    expect(scrub({ ['jane@example.org']: 1 }).ok).toBe(false);
  });
  it('hashes inputs deterministically', () => {
    expect(hashInputs('a', 'b')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInputs('a', 'b')).not.toBe(hashInputs('ab'));
  });
});
