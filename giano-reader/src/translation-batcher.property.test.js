import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { batchSegments } from './translation-batcher.js';

// --- Generators ---

/**
 * Generates an array of text segments with varying lengths.
 * Segments range from short (1 char) to long (up to 5000 chars to test oversized segments).
 */
function arbitrarySegments() {
  return fc.array(
    fc.string({ minLength: 1, maxLength: 5000 }),
    { minLength: 1, maxLength: 50 }
  );
}

/**
 * Generates segments that are guaranteed to be within the 4500 char limit individually.
 */
function arbitrarySmallSegments() {
  return fc.array(
    fc.string({ minLength: 1, maxLength: 500 }),
    { minLength: 1, maxLength: 50 }
  );
}

// --- Property 9: Translation batch constraints ---
// Feature: pdf-semantic-reflow, Property 9: Translation batch constraints
// **Validates: Requirements 8.2**
describe('Property 9: Translation batch constraints', () => {
  it('each batch contains at most 12 segments', () => {
    fc.assert(
      fc.property(arbitrarySegments(), (segments) => {
        const batches = batchSegments(segments);

        for (const batch of batches) {
          expect(batch.length).toBeLessThanOrEqual(12);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('total character count of segments in each batch does not exceed 4500', () => {
    fc.assert(
      fc.property(arbitrarySmallSegments(), (segments) => {
        const batches = batchSegments(segments);

        for (const batch of batches) {
          const totalChars = batch.reduce((sum, seg) => sum + seg.length, 0);
          expect(totalChars).toBeLessThanOrEqual(4500);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('every input segment appears in exactly one batch', () => {
    fc.assert(
      fc.property(arbitrarySegments(), (segments) => {
        const batches = batchSegments(segments);

        // Flatten all batches and compare to original
        const allSegments = batches.flat();
        expect(allSegments.length).toBe(segments.length);

        // Each segment appears exactly once (by identity in order)
        for (let i = 0; i < segments.length; i++) {
          expect(allSegments[i]).toBe(segments[i]);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('original ordering is preserved across batches', () => {
    fc.assert(
      fc.property(arbitrarySegments(), (segments) => {
        const batches = batchSegments(segments);

        // Flatten batches and verify order matches input
        const flattened = batches.flat();
        expect(flattened).toEqual(segments);
      }),
      { numRuns: 100 }
    );
  });

  it('empty input produces empty output', () => {
    const batches = batchSegments([]);
    expect(batches).toEqual([]);
  });

  it('oversized segments (> 4500 chars) are placed alone in their own batch', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 4501, maxLength: 6000 }),
        fc.array(fc.string({ minLength: 1, maxLength: 100 }), { minLength: 0, maxLength: 10 }),
        (oversizedSegment, otherSegments) => {
          // Place the oversized segment somewhere in the array
          const segments = [...otherSegments, oversizedSegment];
          const batches = batchSegments(segments);

          // Find the batch containing the oversized segment
          const batchWithOversized = batches.find((batch) =>
            batch.includes(oversizedSegment)
          );

          expect(batchWithOversized).toBeDefined();
          // The oversized segment should be alone in its batch
          expect(batchWithOversized.length).toBe(1);
          expect(batchWithOversized[0]).toBe(oversizedSegment);
        }
      ),
      { numRuns: 100 }
    );
  });
});
