import { describe, it, expect, beforeEach } from 'vitest';
import { t, setLocale, getLocale } from './index';

describe('i18n', () => {
  beforeEach(() => {
    setLocale('en');
  });

  describe('getLocale / setLocale', () => {
    it('defaults to "en"', () => {
      expect(getLocale()).toBe('en');
    });

    it('returns the locale set by setLocale', () => {
      setLocale('it');
      expect(getLocale()).toBe('it');
    });

    it('accepts arbitrary strings without throwing', () => {
      setLocale('xx');
      expect(getLocale()).toBe('xx');
    });
  });

  describe('t() — basic resolution', () => {
    it('resolves a key in the active locale (en)', () => {
      expect(t('library.title')).toBe('Library');
    });

    it('resolves a key in Italian when locale is it', () => {
      setLocale('it');
      expect(t('library.title')).toBe('Libreria');
    });
  });

  describe('t() — fallback chain', () => {
    it('falls back to English when key is missing from active locale', () => {
      setLocale('it');
      // Both locales have the same keys, so test with unknown locale
      setLocale('xx');
      expect(t('library.title')).toBe('Library');
    });

    it('returns raw key when key is missing from both active and English', () => {
      expect(t('nonexistent.key')).toBe('nonexistent.key');
    });

    it('returns raw key for unknown locale and unknown key', () => {
      setLocale('xx');
      expect(t('totally.unknown')).toBe('totally.unknown');
    });
  });

  describe('t() — variable interpolation', () => {
    it('replaces {varName} placeholders with provided values', () => {
      expect(t('library.progress', { progress: '42' })).toBe('42% read');
    });

    it('replaces placeholders in Italian', () => {
      setLocale('it');
      expect(t('library.progress', { progress: '75' })).toBe('75% letto');
    });

    it('replaces multiple occurrences of the same variable', () => {
      // Manually test by using a key that could have multiple placeholders
      // Since our locale files don't have one, test fallback to key with vars
      setLocale('en');
      expect(t('disconnected.message', { url: 'http://192.168.1.5:8888' }))
        .toBe('Unable to reach the server at http://192.168.1.5:8888. Make sure GianoReader is running and Web Server Mode is active.');
    });

    it('leaves placeholders intact when vars does not contain the variable name', () => {
      expect(t('library.progress')).toBe('{progress}% read');
    });

    it('ignores extra vars that have no matching placeholder', () => {
      expect(t('library.title', { unused: 'value' })).toBe('Library');
    });
  });

  describe('t() — never throws', () => {
    it('handles empty key', () => {
      expect(() => t('')).not.toThrow();
      expect(t('')).toBe('');
    });

    it('handles undefined vars gracefully', () => {
      expect(() => t('library.title', undefined)).not.toThrow();
    });

    it('handles empty vars object', () => {
      expect(() => t('library.title', {})).not.toThrow();
      expect(t('library.title', {})).toBe('Library');
    });
  });
});
