import { describe, it, expect } from 'vitest';
import { qrCodeDataUrl } from './qr-code.js';

describe('qrCodeDataUrl', () => {
  it('returns an image data URL for a LAN address', () => {
    const url = qrCodeDataUrl('http://192.168.1.20:8888');
    expect(url.startsWith('data:image/')).toBe(true);
    expect(url.length).toBeGreaterThan(200);
  });

  it('gives different codes for different addresses', () => {
    expect(qrCodeDataUrl('http://192.168.1.20:8888')).not.toBe(qrCodeDataUrl('http://192.168.1.21:8888'));
  });

  it('is deterministic', () => {
    expect(qrCodeDataUrl('http://10.0.0.5:9000')).toBe(qrCodeDataUrl('http://10.0.0.5:9000'));
  });
});
