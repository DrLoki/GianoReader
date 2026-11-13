import { describe, it, expect } from 'vitest';
import { sha256Bytes } from './sha256';

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');

/** Reference digest from Web Crypto (available in the test environment). */
async function reference(data: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource)));
}

describe('sha256Bytes', () => {
  it('matches the standard test vectors', () => {
    expect(hex(sha256Bytes(new Uint8Array()))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(hex(sha256Bytes(new TextEncoder().encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches Web Crypto for every length around the block boundaries', async () => {
    for (let length = 0; length <= 200; length++) {
      const data = new Uint8Array(length).map((_, i) => (i * 31 + length) & 0xff);
      expect(hex(sha256Bytes(data))).toBe(await reference(data));
    }
  });

  it('matches Web Crypto for non-ASCII text', async () => {
    const data = new TextEncoder().encode('local-book-1712ж日本語7');
    expect(hex(sha256Bytes(data))).toBe(await reference(data));
  });
});
