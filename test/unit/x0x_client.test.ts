import { describe, it, expect } from 'vitest';
import { X0xClient } from '../../src/x0x/client.js';

describe('x0x client address', () => {
  it('uses X0X_API when set, and the default port when it is unset or blank', () => {
    expect(new X0xClient('http://127.0.0.1:4000', undefined, undefined).baseUrl).toBe('http://127.0.0.1:4000');
    expect(new X0xClient(undefined, undefined, undefined).baseUrl).toBe('http://127.0.0.1:12700');
    // A launcher may pass a blank optional field rather than leave it out; "" is not an address.
    expect(new X0xClient('', '', '').baseUrl).toBe('http://127.0.0.1:12700');
  });
});
