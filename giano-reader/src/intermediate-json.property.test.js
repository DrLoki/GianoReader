import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parseIntermediateJson, prettyPrint, BLOCK_TYPES } from './intermediate-json.js';

// --- Generators ---

const VALID_BLOCK_TYPE_VALUES = Object.values(BLOCK_TYPES);
const VALID_EMPHASIS_VALUES = ['bold', 'italic', 'underline'];

/**
 * Generates a valid style object.
 */
function arbitraryStyle() {
  return fc.record({
    heading_level: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 6 })),
    emphasis: fc.subarray(VALID_EMPHASIS_VALUES),
  });
}

/**
 * Generates a valid non-image block for a given page number and block index.
 */
function arbitraryNonImageBlock(pageNum, blockIndex) {
  const nonImageTypes = VALID_BLOCK_TYPE_VALUES.filter((t) => t !== 'image');
  return fc.record({
    type: fc.constantFrom(...nonImageTypes),
    text: fc.string({ minLength: 0, maxLength: 200 }),
    segment_id: fc.constant(`p${pageNum}_b${blockIndex}`),
    style: arbitraryStyle(),
  });
}

/**
 * Generates a valid image block for a given page number and block index.
 */
function arbitraryImageBlock(pageNum, blockIndex) {
  return fc.record({
    type: fc.constant('image'),
    text: fc.constant(''),
    segment_id: fc.constant(`p${pageNum}_b${blockIndex}`),
    image_path: fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789/_-.'.split('')),
      { minLength: 1, maxLength: 50 }
    ).map((s) => `images/${s}.png`),
    dimensions: fc.record({
      width: fc.integer({ min: 1, max: 4000 }),
      height: fc.integer({ min: 1, max: 4000 }),
    }),
    style: arbitraryStyle(),
  });
}

/**
 * Generates a valid block (image or non-image) for a given page number and block index.
 */
function arbitraryBlock(pageNum, blockIndex) {
  return fc.oneof(
    { weight: 7, arbitrary: arbitraryNonImageBlock(pageNum, blockIndex) },
    { weight: 1, arbitrary: arbitraryImageBlock(pageNum, blockIndex) }
  );
}

/**
 * Generates a valid metadata object.
 */
function arbitraryMetadata() {
  return fc.record({
    title: fc.string({ minLength: 0, maxLength: 100 }),
    total_pages: fc.integer({ min: 1, max: 10000 }),
    language: fc.oneof(
      fc.constant('und'),
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 2, maxLength: 2 })
    ),
  });
}

/**
 * Generates a valid Intermediate_JSON object.
 * Produces objects with schema_version "1.{minor}", positive page_number,
 * valid metadata, and an array of valid blocks with correct segment_id format.
 */
function arbitraryIntermediateJson() {
  return fc.integer({ min: 1, max: 500 }).chain((pageNum) =>
    fc.integer({ min: 0, max: 10 }).chain((blockCount) => {
      const blockArbs = Array.from({ length: blockCount }, (_, i) => arbitraryBlock(pageNum, i));
      const blocksArb = blockCount === 0 ? fc.constant([]) : fc.tuple(...blockArbs);
      return fc.record({
        schema_version: fc.integer({ min: 0, max: 99 }).map((minor) => `1.${minor}`),
        page_number: fc.constant(pageNum),
        metadata: arbitraryMetadata(),
        blocks: blocksArb.map((b) => (Array.isArray(b) ? b : [])),
      });
    })
  );
}

// --- Property 4: Intermediate_JSON serialization round-trip ---
// Feature: pdf-semantic-reflow, Property 4: Intermediate_JSON serialization round-trip
// **Validates: Requirements 3.5, 11.1, 11.3**
describe('Property 4: Intermediate_JSON serialization round-trip', () => {
  it('prettyPrint then parseIntermediateJson produces deep-equal object', () => {
    fc.assert(
      fc.property(arbitraryIntermediateJson(), (obj) => {
        const serialized = prettyPrint(obj);
        const result = parseIntermediateJson(serialized);

        // Parsing must succeed
        expect(result.ok).toBe(true);

        // Parsed data must be deep-equal to the original
        expect(result.data).toEqual(obj);
      }),
      { numRuns: 100 }
    );
  });

  it('prettyPrint output is valid JSON with 2-space indentation', () => {
    fc.assert(
      fc.property(arbitraryIntermediateJson(), (obj) => {
        const serialized = prettyPrint(obj);

        // Must be valid JSON
        const reparsed = JSON.parse(serialized);
        expect(reparsed).toEqual(obj);

        // Must use 2-space indentation (same as JSON.stringify with 2 spaces)
        expect(serialized).toBe(JSON.stringify(obj, null, 2));
      }),
      { numRuns: 100 }
    );
  });

  it('round-trip preserves array ordering of blocks', () => {
    fc.assert(
      fc.property(arbitraryIntermediateJson(), (obj) => {
        const serialized = prettyPrint(obj);
        const result = parseIntermediateJson(serialized);

        expect(result.ok).toBe(true);
        expect(result.data.blocks.length).toBe(obj.blocks.length);

        for (let i = 0; i < obj.blocks.length; i++) {
          expect(result.data.blocks[i].segment_id).toBe(obj.blocks[i].segment_id);
          expect(result.data.blocks[i].type).toBe(obj.blocks[i].type);
          expect(result.data.blocks[i].text).toBe(obj.blocks[i].text);
        }
      }),
      { numRuns: 100 }
    );
  });
});
