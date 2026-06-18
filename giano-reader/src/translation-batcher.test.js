import { describe, it, expect } from 'vitest';
import { batchSegments } from './translation-batcher.js';

describe('batchSegments', () => {
  it('returns empty array for empty input', () => {
    expect(batchSegments([])).toEqual([]);
  });

  it('returns empty array for non-array input', () => {
    expect(batchSegments(null)).toEqual([]);
    expect(batchSegments(undefined)).toEqual([]);
  });

  it('batches a single short segment into one batch', () => {
    const result = batchSegments(['hello']);
    expect(result).toEqual([['hello']]);
  });

  it('respects max 12 segments per batch', () => {
    const segments = Array.from({ length: 15 }, (_, i) => `seg${i}`);
    const result = batchSegments(segments);
    expect(result[0]).toHaveLength(12);
    expect(result[1]).toHaveLength(3);
  });

  it('respects max 4500 chars per batch', () => {
    // Each segment is 1000 chars, so max 4 per batch
    const segments = Array.from({ length: 6 }, () => 'a'.repeat(1000));
    const result = batchSegments(segments);
    // First batch: 4 segments (4000 chars), second batch: 2 segments (2000 chars)
    expect(result[0]).toHaveLength(4);
    expect(result[1]).toHaveLength(2);
  });

  it('places oversized segment alone in its own batch', () => {
    const segments = ['short', 'a'.repeat(5000), 'also short'];
    const result = batchSegments(segments);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(['short']);
    expect(result[1]).toEqual(['a'.repeat(5000)]);
    expect(result[2]).toEqual(['also short']);
  });

  it('preserves original ordering', () => {
    const segments = ['first', 'second', 'third', 'fourth', 'fifth'];
    const result = batchSegments(segments);
    const flattened = result.flat();
    expect(flattened).toEqual(segments);
  });

  it('every segment appears in exactly one batch', () => {
    const segments = Array.from({ length: 30 }, (_, i) => `segment_${i}_${'x'.repeat(200)}`);
    const result = batchSegments(segments);
    const flattened = result.flat();
    expect(flattened).toEqual(segments);
    expect(flattened).toHaveLength(30);
  });

  it('handles segments that exactly fill the char limit', () => {
    // 3 segments of 1500 chars each = exactly 4500
    const segments = Array.from({ length: 3 }, () => 'b'.repeat(1500));
    const result = batchSegments(segments);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(3);
  });

  it('splits when adding one more segment would exceed char limit', () => {
    // 3 segments of 1500 chars + 1 segment of 1 char = 4501 chars
    const segments = [
      'b'.repeat(1500),
      'b'.repeat(1500),
      'b'.repeat(1500),
      'c',
    ];
    const result = batchSegments(segments);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(3);
    expect(result[1]).toEqual(['c']);
  });
});
