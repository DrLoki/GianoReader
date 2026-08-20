/**
 * Bug Condition Exploration Tests — Online-Offline Parity
 *
 * These tests verify that the three parity bugs have been fixed:
 * 1. Paragraph ID: client now uses SHA-256 hashes matching the Rust backend
 * 2. HTML sanitization: client now strips disallowed tags matching the Rust backend
 * 3. Source language: offline translation now respects the sourceLang parameter
 *
 * BEFORE FIX: These tests FAILED (confirming the bugs existed).
 * AFTER FIX: These tests PASS (confirming the expected behavior is satisfied).
 *
 * Validates: Requirements 2.1, 2.5, 2.6
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { generateParagraphId, stripDisallowedTags } from '../local-db';

// ─── Test 1: Paragraph ID Parity ────────────────────────────────────────────
// The Rust backend generates paragraph IDs as SHA-256(bookId + chapterIndex + paragraphIndex)
// truncated to 16 hex chars. The fixed client now uses generateParagraphId which does the same.

/**
 * Computes the expected paragraph ID as the Rust backend does:
 * SHA-256(bookId + chapterIndex + paragraphIndex) → first 8 bytes → 16 hex chars.
 */
async function expectedParagraphId(bookId: string, chapterIndex: number, paragraphIndex: number): Promise<string> {
  const input = `${bookId}${chapterIndex}${paragraphIndex}`;
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray.slice(0, 8))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Checks if a string contains any HTML tag NOT in the allowed set */
function containsDisallowedTags(html: string): boolean {
  const allowedTagPattern = /^<\/?(em|strong|a|span)(\s[^>]*)?>$/i;
  const allTags = html.match(/<\/?[a-zA-Z][^>]*>/g) || [];
  return allTags.some(tag => !allowedTagPattern.test(tag));
}

describe('Bug Condition: Paragraph ID Parity (Property 1)', () => {
  it('generateParagraphId produces IDs matching SHA-256 format — confirms fix', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate random bookId, chapterIndex, paragraphIndex
        fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.length > 0),
        fc.nat({ max: 100 }),
        fc.nat({ max: 500 }),
        async (bookId, chapterIndex, paragraphIndex) => {
          // Compute the expected SHA-256 based ID (what Rust backend produces)
          const expected = await expectedParagraphId(bookId, chapterIndex, paragraphIndex);

          // Call the actual fixed implementation
          const clientId = await generateParagraphId(bookId, chapterIndex, paragraphIndex);

          // The property: client ID SHOULD match the SHA-256 ID (expected behavior)
          // AFTER FIX: this passes because generateParagraphId uses SHA-256
          expect(clientId).toBe(expected);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('generateParagraphId produces 16-char lowercase hex for all inputs — confirms fix', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.length > 0),
        fc.nat({ max: 100 }),
        fc.nat({ max: 500 }),
        async (bookId, chapterIndex, paragraphIndex) => {
          const clientId = await generateParagraphId(bookId, chapterIndex, paragraphIndex);

          // The ID must be exactly 16 lowercase hex characters
          expect(clientId).toMatch(/^[0-9a-f]{16}$/);
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ─── Test 2: HTML Sanitization Parity ───────────────────────────────────────
// The Rust backend strips ALL tags except <em>, <strong>, <a>, <span>.
// The fixed client now uses stripDisallowedTags which does the same.

describe('Bug Condition: HTML Sanitization Parity (Property 1)', () => {
  it('stripDisallowedTags removes disallowed tags — confirms fix', () => {
    fc.assert(
      fc.property(
        // Generate HTML strings that contain disallowed tags
        fc.constantFrom(
          '<div><em>hello</em> world</div>',
          '<p>text with <img src="x"> image</p>',
          '<table><tr><td>cell</td></tr></table>',
          '<div><span>allowed</span><br><strong>also allowed</strong></div>',
          '<section><em>emphasis</em> in section</section>',
          '<blockquote><strong>bold quote</strong></blockquote>',
          '<h2>Heading with <img alt="pic"> inside</h2>',
          '<figure><img src="cover.jpg"><figcaption>Caption</figcaption></figure>',
        ),
        (htmlInput) => {
          const result = stripDisallowedTags(htmlInput);

          // Expected behavior: the result should NOT contain disallowed tags
          // (only em, strong, a, span are allowed — everything else should be stripped)
          // AFTER FIX: this passes because stripDisallowedTags removes disallowed tags
          expect(containsDisallowedTags(result)).toBe(false);
        }
      ),
      { numRuns: 20 }
    );
  });

  it('stripDisallowedTags strips randomly generated disallowed tags — confirms fix', () => {
    // Generate random wrapper tags that should be stripped
    const disallowedTag = fc.constantFrom('div', 'p', 'section', 'article', 'header', 'footer', 'nav', 'aside');
    const textContent = fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0 && !s.includes('<') && !s.includes('>'));

    fc.assert(
      fc.property(
        disallowedTag,
        textContent,
        (tag, text) => {
          const htmlInput = `<${tag}>${text}</${tag}>`;
          const result = stripDisallowedTags(htmlInput);

          // Expected behavior: disallowed tags should be stripped, text preserved
          // AFTER FIX: this passes because stripDisallowedTags removes these tags
          expect(containsDisallowedTags(result)).toBe(false);
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ─── Test 3: Source Language Ignored in Offline Translation ──────────────────
// The Rust backend respects the sourceLang parameter (sends sl={sourceLang}).
// The client's translateChunkOffline hardcodes sl=auto regardless of sourceLang.
// This test proves the bug by intercepting the fetch URL.

describe('Bug Condition: Source Language Passthrough (Property 1)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    // Mock offline mode
    localStorage.setItem('giano-offline-mode', 'true');
    // Ensure no cloudflare worker subdomain is set (use default googleapis URL)
    localStorage.removeItem('giano-local-preferences');
    localStorage.removeItem('giano-reader-settings');

    // Mock navigator.onLine to be true (so the function doesn't throw OFFLINE_NO_INTERNET)
    Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });

    // Intercept fetch to capture the URL
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [[['translated text', 'original text']]],
    });
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('offline translation ignores sourceLang and always uses sl=auto — confirms bug', async () => {
    const { postTranslate } = await import('../translate');

    await fc.assert(
      fc.asyncProperty(
        // Generate non-empty source language codes that are NOT "auto"
        fc.constantFrom('it', 'en', 'fr', 'de', 'es', 'pt', 'ru', 'zh', 'ja', 'ar'),
        fc.constantFrom('en', 'it', 'fr', 'de', 'es'),
        async (sourceLang, targetLang) => {
          fetchSpy.mockClear();

          await postTranslate(['Hello world'], sourceLang, targetLang);

          // Verify fetch was called
          expect(fetchSpy).toHaveBeenCalled();
          const calledUrl = fetchSpy.mock.calls[0][0] as string;

          // Expected behavior: URL should contain sl={sourceLang}
          // On UNFIXED code, this will FAIL because URL always contains sl=auto
          expect(calledUrl).toContain(`sl=${sourceLang}`);
          expect(calledUrl).not.toContain('sl=auto');
        }
      ),
      { numRuns: 20 }
    );
  });

  it('postTranslate in offline mode does not pass sourceLang to postTranslateOffline — confirms bug', async () => {
    const { postTranslate } = await import('../translate');

    // Specific concrete case: sourceLang="it", targetLang="en"
    fetchSpy.mockClear();
    await postTranslate(['Ciao mondo'], 'it', 'en');

    expect(fetchSpy).toHaveBeenCalled();
    const calledUrl = fetchSpy.mock.calls[0][0] as string;

    // Expected behavior: should use sl=it
    // On UNFIXED code: uses sl=auto — this WILL FAIL (confirms bug)
    expect(calledUrl).toContain('sl=it');
    expect(calledUrl).not.toContain('sl=auto');
  });
});
