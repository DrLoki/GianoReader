import { describe, it, expect } from 'vitest';
import {
  updateProgressBar,
  formatLogLine,
  formatCost,
  filterVisionModels,
  buildLibraryEntry,
  shouldShowConvertButton,
} from './conversion-utils.js';

describe('conversion-utils', () => {
  describe('updateProgressBar', () => {
    it('returns correct width, stageText, and countText', () => {
      const result = updateProgressBar('Rendering pages...', 3, 10);
      expect(result).toEqual({
        width: 30,
        stageText: 'Rendering pages...',
        countText: '3/10',
      });
    });

    it('rounds width to nearest integer', () => {
      const result = updateProgressBar('Extracting text...', 1, 3);
      expect(result.width).toBe(33);
    });

    it('returns 100% when current equals total', () => {
      const result = updateProgressBar('Done', 5, 5);
      expect(result.width).toBe(100);
    });

    it('returns 0% when current is 0', () => {
      const result = updateProgressBar('Starting', 0, 10);
      expect(result.width).toBe(0);
    });
  });

  describe('formatLogLine', () => {
    it('formats error lines with [ERROR] prefix', () => {
      expect(formatLogLine('error', 'API key invalid')).toBe('[ERROR] API key invalid');
    });

    it('formats warn lines with [WARN] prefix', () => {
      expect(formatLogLine('warn', 'Page 3 failed')).toBe('[WARN] Page 3 failed');
    });
  });

  describe('formatCost', () => {
    it('formats cost with up to 4 decimal places', () => {
      expect(formatCost(0.0123)).toBe('$0.0123');
    });

    it('removes trailing zeros', () => {
      expect(formatCost(1.5)).toBe('$1.5');
    });

    it('caps at 4 decimal places', () => {
      expect(formatCost(0.00001)).toBe('$0');
    });

    it('formats zero correctly', () => {
      expect(formatCost(0)).toBe('$0');
    });

    it('formats whole numbers without decimals', () => {
      expect(formatCost(2)).toBe('$2');
    });

    it('formats values with exactly 4 significant decimals', () => {
      expect(formatCost(0.1234)).toBe('$0.1234');
    });
  });

  describe('filterVisionModels', () => {
    it('returns only models with supports_vision === true', () => {
      const models = [
        { id: 'a', name: 'A', description: '', supports_vision: true },
        { id: 'b', name: 'B', description: '', supports_vision: false },
        { id: 'c', name: 'C', description: '', supports_vision: true },
      ];
      const result = filterVisionModels(models);
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(['a', 'c']);
    });

    it('returns empty array when no models support vision', () => {
      const models = [
        { id: 'x', name: 'X', description: '', supports_vision: false },
      ];
      expect(filterVisionModels(models)).toEqual([]);
    });

    it('returns empty array for empty input', () => {
      expect(filterVisionModels([])).toEqual([]);
    });
  });

  describe('buildLibraryEntry', () => {
    it('uses metadata title and author when available', () => {
      const result = buildLibraryEntry(
        { epub_path: '/out/book.epub', title: 'My Book', author: 'Author' },
        'input.pdf'
      );
      expect(result.title).toBe('My Book');
      expect(result.author).toBe('Author');
      expect(result.path).toBe('/out/book.epub');
      expect(result.status).toBe('to-read');
      expect(result.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('falls back to filename without extension for title', () => {
      const result = buildLibraryEntry(
        { epub_path: '/out/book.epub' },
        'my-document.pdf'
      );
      expect(result.title).toBe('my-document');
    });

    it('falls back to empty string for author', () => {
      const result = buildLibraryEntry(
        { epub_path: '/out/book.epub' },
        'file.pdf'
      );
      expect(result.author).toBe('');
    });

    it('handles empty title as falsy and falls back', () => {
      const result = buildLibraryEntry(
        { epub_path: '/out/book.epub', title: '', author: '' },
        'report.pdf'
      );
      expect(result.title).toBe('report');
      expect(result.author).toBe('');
    });
  });

  describe('shouldShowConvertButton', () => {
    it('returns true when both apiKey and modelId are non-empty strings', () => {
      expect(shouldShowConvertButton('sk-key', 'model-id')).toBe(true);
    });

    it('returns false when apiKey is empty', () => {
      expect(shouldShowConvertButton('', 'model-id')).toBe(false);
    });

    it('returns false when modelId is empty', () => {
      expect(shouldShowConvertButton('sk-key', '')).toBe(false);
    });

    it('returns false when both are empty', () => {
      expect(shouldShowConvertButton('', '')).toBe(false);
    });

    it('returns false for non-string values', () => {
      expect(shouldShowConvertButton(null, 'model')).toBe(false);
      expect(shouldShowConvertButton('key', undefined)).toBe(false);
      expect(shouldShowConvertButton(123, 'model')).toBe(false);
    });
  });
});
