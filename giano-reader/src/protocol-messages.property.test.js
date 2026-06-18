import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  buildExtractionRequest,
  serializeMessage,
  validateMessage,
  isValidUuidV4,
  MAX_MESSAGE_SIZE,
} from './protocol-messages.js';

// --- Generators ---

/**
 * Generates a valid absolute file path string (Windows or Unix style).
 */
function arbitraryPdfPath() {
  return fc.oneof(
    // Windows-style paths
    fc.tuple(
      fc.constantFrom('C:', 'D:', 'E:'),
      fc.array(fc.stringMatching(/^[a-zA-Z0-9_\-. ]{1,30}$/), { minLength: 1, maxLength: 5 })
    ).map(([drive, parts]) => `${drive}\\${parts.join('\\')}\\document.pdf`),
    // Unix-style paths
    fc.array(fc.stringMatching(/^[a-zA-Z0-9_\-. ]{1,30}$/), { minLength: 1, maxLength: 5 })
      .map((parts) => `/${parts.join('/')}/document.pdf`)
  );
}

/**
 * Generates a valid 1-based page number.
 */
function arbitraryPageNumber() {
  return fc.integer({ min: 1, max: 10000 });
}

/**
 * Generates a valid cache directory path.
 */
function arbitraryCacheDir() {
  return fc.oneof(
    // Windows-style cache dir
    fc.tuple(
      fc.constantFrom('C:', 'D:'),
      fc.stringMatching(/^[a-f0-9]{8,64}$/)
    ).map(([drive, hash]) => `${drive}\\Users\\user\\AppData\\Local\\giano-reader\\cache\\${hash}`),
    // Unix-style cache dir
    fc.stringMatching(/^[a-f0-9]{8,64}$/)
      .map((hash) => `/home/user/.cache/giano-reader/${hash}`)
  );
}

/**
 * Generates extraction request parameters.
 */
function arbitraryExtractionParams() {
  return fc.record({
    pdfPath: arbitraryPdfPath(),
    page: arbitraryPageNumber(),
    cacheDir: arbitraryCacheDir(),
  });
}

// --- Property 10: Protocol message format validity ---
// Feature: pdf-semantic-reflow, Property 10: Protocol message format validity
// **Validates: Requirements 10.1, 10.2**
describe('Property 10: Protocol message format validity', () => {
  it('serialized message is valid JSON terminated by a single newline', () => {
    fc.assert(
      fc.property(arbitraryExtractionParams(), (params) => {
        const message = buildExtractionRequest(params);
        const serialized = serializeMessage(message);

        // Must end with exactly one newline
        expect(serialized.endsWith('\n')).toBe(true);
        expect(serialized.endsWith('\n\n')).toBe(false);

        // Stripping the newline must yield valid JSON
        const jsonPart = serialized.slice(0, -1);
        const parsed = JSON.parse(jsonPart);
        expect(parsed).toBeTypeOf('object');
        expect(parsed).not.toBeNull();
      }),
      { numRuns: 100 }
    );
  });

  it('message contains a valid UUID v4 request_id', () => {
    fc.assert(
      fc.property(arbitraryExtractionParams(), (params) => {
        const message = buildExtractionRequest(params);
        const serialized = serializeMessage(message);
        const jsonPart = serialized.slice(0, -1);
        const parsed = JSON.parse(jsonPart);

        // request_id must be a string
        expect(typeof parsed.request_id).toBe('string');

        // request_id must be a valid UUID v4
        expect(isValidUuidV4(parsed.request_id)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('serialized message does not exceed 1 MB', () => {
    fc.assert(
      fc.property(arbitraryExtractionParams(), (params) => {
        const message = buildExtractionRequest(params);
        const serialized = serializeMessage(message);

        const byteLength = new TextEncoder().encode(serialized).length;
        expect(byteLength).toBeLessThanOrEqual(MAX_MESSAGE_SIZE);
      }),
      { numRuns: 100 }
    );
  });

  it('message contains all required fields: cmd, request_id, pdf_path, page, cache_dir', () => {
    fc.assert(
      fc.property(arbitraryExtractionParams(), (params) => {
        const message = buildExtractionRequest(params);
        const serialized = serializeMessage(message);
        const jsonPart = serialized.slice(0, -1);
        const parsed = JSON.parse(jsonPart);

        // All required fields must be present
        expect(parsed).toHaveProperty('cmd');
        expect(parsed).toHaveProperty('request_id');
        expect(parsed).toHaveProperty('pdf_path');
        expect(parsed).toHaveProperty('page');
        expect(parsed).toHaveProperty('cache_dir');

        // Fields must have correct types
        expect(typeof parsed.cmd).toBe('string');
        expect(parsed.cmd.length).toBeGreaterThan(0);
        expect(typeof parsed.request_id).toBe('string');
        expect(typeof parsed.pdf_path).toBe('string');
        expect(parsed.pdf_path.length).toBeGreaterThan(0);
        expect(Number.isInteger(parsed.page)).toBe(true);
        expect(parsed.page).toBeGreaterThanOrEqual(1);
        expect(typeof parsed.cache_dir).toBe('string');
        expect(parsed.cache_dir.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 }
    );
  });

  it('validateMessage accepts all well-formed serialized extraction requests', () => {
    fc.assert(
      fc.property(arbitraryExtractionParams(), (params) => {
        const message = buildExtractionRequest(params);
        const serialized = serializeMessage(message);

        const result = validateMessage(serialized);
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
      }),
      { numRuns: 100 }
    );
  });
});
