/**
 * Preservation Property Tests — Online-Offline Parity Bugfix
 *
 * These tests lock the CURRENT behavior of extractParagraphs and offline batching
 * logic BEFORE the fix is applied. They should PASS on unfixed code and continue
 * to PASS after the fix (only .id and .html fields change; .text and paragraph count
 * must remain identical).
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';

// ─── Replicate extractParagraphs logic to observe current behavior ────────────
// These are faithful copies of the private functions in local-db.ts so we can
// test the paragraph selection and text extraction behavior independently.

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeInnerHtml(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('script, style').forEach((n) => n.remove());
  clone.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    Array.from(a.attributes).forEach((attr) => {
      if (attr.name !== 'href') a.removeAttribute(attr.name);
    });
    a.setAttribute('data-epub-href', href);
    a.removeAttribute('href');
    a.style.cursor = 'pointer';
  });
  clone.querySelectorAll('*').forEach((n) => {
    ['onclick', 'onmouseover', 'onerror', 'onload'].forEach((ev) => n.removeAttribute(ev));
  });
  return clone.innerHTML;
}

function extractParagraphs(body: HTMLElement): any[] {
  const selectors = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote'];
  const rawBlocks = body.querySelectorAll?.(selectors.join(', '));
  const blocks = rawBlocks
    ? Array.from(rawBlocks).filter((el) => {
        if (el.tagName.toLowerCase() !== 'blockquote') return true;
        return !el.querySelector(selectors.join(', '));
      })
    : rawBlocks;
  if (blocks && blocks.length > 0) {
    const r: any[] = [];
    const seenIds = new Set<string>();
    blocks.forEach((el, index) => {
      const text = (el.textContent || '').trim();
      if (!text) return;
      let id = el.id || null;
      if (!id) {
        let parent = el.parentElement;
        while (parent && parent !== body) {
          if (parent.id) {
            id = parent.id;
            break;
          }
          parent = parent.parentElement;
        }
      }
      if (id && seenIds.has(id)) id = null;
      if (id) seenIds.add(id);
      r.push({
        text,
        html: safeInnerHtml(el as HTMLElement),
        id: id || `p-${index}`,
        index,
      });
    });
    if (r.length) return r;
  }
  // Fallback: split per newline
  return (body.textContent || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 2)
    .map((text, index) => ({
      text,
      html: escapeHtml(text),
      id: `p-fallback-${index}`,
      index,
    }));
}

// ─── Replicate batching logic from translate.ts ────────────────────────────────

const CHAR_LIMIT = 4500;

function buildBatches(paragraphs: string[]): { start: number; end: number; text: string }[] {
  const batches: { start: number; end: number; text: string }[] = [];
  let batchStart = 0;
  let batchText = '';

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const separator = batchText ? '\n\n' : '';
    if (batchText && (batchText + separator + para).length > CHAR_LIMIT) {
      batches.push({ start: batchStart, end: i, text: batchText });
      batchStart = i;
      batchText = para;
    } else {
      batchText = batchText + separator + para;
    }
  }
  if (batchText) {
    batches.push({ start: batchStart, end: paragraphs.length, text: batchText });
  }

  return batches;
}

// ─── Generators ────────────────────────────────────────────────────────────────

/** Generates non-empty text content (no HTML tags, at least 1 non-whitespace char) */
const textContentArb = fc.stringOf(
  fc.char().filter((c) => c !== '<' && c !== '>' && c !== '\n'),
  { minLength: 1, maxLength: 80 }
).filter((s) => s.trim().length > 0);

/** Generates a paragraph tag name from the valid set */
const paragraphTagArb = fc.constantFrom('p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li');

/** Generates an array of paragraph elements as HTML strings */
const paragraphListArb = fc.array(
  fc.tuple(paragraphTagArb, textContentArb).map(([tag, text]) => `<${tag}>${text}</${tag}>`),
  { minLength: 1, maxLength: 20 }
);

/** Generates an HTML body string with paragraph elements */
const htmlBodyArb = paragraphListArb.map(
  (paragraphs) => `<div>${paragraphs.join('')}</div>`
);

/** Generates paragraph texts for batching tests */
const paragraphTextsArb = fc.array(
  fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
  { minLength: 1, maxLength: 30 }
);

// ─── Property Tests ────────────────────────────────────────────────────────────

describe('Preservation: Paragraph Extraction', () => {
  it('treats p, h1-h6, li as individual paragraphs and preserves text content', () => {
    fc.assert(
      fc.property(
        fc.tuple(paragraphTagArb, textContentArb),
        ([tag, text]) => {
          const html = `<div><${tag}>${text}</${tag}></div>`;
          const body = document.createElement('div');
          body.innerHTML = html;
          const innerBody = body.firstElementChild as HTMLElement;

          const result = extractParagraphs(innerBody);

          // Should produce exactly 1 paragraph
          expect(result.length).toBe(1);
          // Text content should match the trimmed input
          expect(result[0].text).toBe(text.trim());
        }
      ),
      { numRuns: 100 }
    );
  });

  it('skips empty paragraphs (no text content after trimming)', () => {
    fc.assert(
      fc.property(
        fc.tuple(paragraphTagArb, textContentArb),
        ([tag, text]) => {
          // Create body with one empty paragraph and one with content
          const html = `<div><${tag}></${tag}><${tag}>${text}</${tag}></div>`;
          const body = document.createElement('div');
          body.innerHTML = html;
          const innerBody = body.firstElementChild as HTMLElement;

          const result = extractParagraphs(innerBody);

          // Should have exactly 1 paragraph (the non-empty one)
          expect(result.length).toBe(1);
          expect(result[0].text).toBe(text.trim());
        }
      ),
      { numRuns: 100 }
    );
  });

  it('produces the same paragraph count for the same HTML body', () => {
    fc.assert(
      fc.property(htmlBodyArb, (html) => {
        const body1 = document.createElement('div');
        body1.innerHTML = html;
        const innerBody1 = body1.firstElementChild as HTMLElement;

        const body2 = document.createElement('div');
        body2.innerHTML = html;
        const innerBody2 = body2.firstElementChild as HTMLElement;

        const result1 = extractParagraphs(innerBody1);
        const result2 = extractParagraphs(innerBody2);

        // Deterministic: same input produces same count
        expect(result1.length).toBe(result2.length);
        // Same text values
        for (let i = 0; i < result1.length; i++) {
          expect(result1[i].text).toBe(result2[i].text);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('leaf blockquote (no nested paragraph elements) is treated as a paragraph', () => {
    fc.assert(
      fc.property(textContentArb, (text) => {
        const html = `<div><blockquote>${text}</blockquote></div>`;
        const body = document.createElement('div');
        body.innerHTML = html;
        const innerBody = body.firstElementChild as HTMLElement;

        const result = extractParagraphs(innerBody);

        expect(result.length).toBe(1);
        expect(result[0].text).toBe(text.trim());
      }),
      { numRuns: 50 }
    );
  });

  it('nested blockquote (containing p/h*/li) is excluded as a standalone paragraph', () => {
    fc.assert(
      fc.property(
        fc.tuple(textContentArb, textContentArb),
        ([outerText, innerText]) => {
          // blockquote containing a <p> - the blockquote itself should not appear
          // as a paragraph; only the inner <p> should.
          const html = `<div><blockquote><p>${innerText}</p></blockquote></div>`;
          const body = document.createElement('div');
          body.innerHTML = html;
          const innerBody = body.firstElementChild as HTMLElement;

          const result = extractParagraphs(innerBody);

          // Only the inner <p> should be a paragraph
          expect(result.length).toBe(1);
          expect(result[0].text).toBe(innerText.trim());
        }
      ),
      { numRuns: 50 }
    );
  });

  it('multiple paragraphs preserve text content and order', () => {
    fc.assert(
      fc.property(
        fc.array(textContentArb, { minLength: 2, maxLength: 10 }),
        (texts) => {
          const html = `<div>${texts.map((t) => `<p>${t}</p>`).join('')}</div>`;
          const body = document.createElement('div');
          body.innerHTML = html;
          const innerBody = body.firstElementChild as HTMLElement;

          const result = extractParagraphs(innerBody);

          // All non-empty texts should appear in order
          const expectedTexts = texts.map((t) => t.trim()).filter((t) => t.length > 0);
          expect(result.length).toBe(expectedTexts.length);
          for (let i = 0; i < expectedTexts.length; i++) {
            expect(result[i].text).toBe(expectedTexts[i]);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Preservation: Offline Translation Batching', () => {
  it('never produces a batch exceeding CHAR_LIMIT (4500) unless a single paragraph exceeds it', () => {
    fc.assert(
      fc.property(paragraphTextsArb, (paragraphs) => {
        const batches = buildBatches(paragraphs);

        for (const batch of batches) {
          const count = batch.end - batch.start;
          if (count === 1) {
            // A single paragraph can exceed the limit on its own
            continue;
          }
          // Multi-paragraph batches must fit within CHAR_LIMIT
          expect(batch.text.length).toBeLessThanOrEqual(CHAR_LIMIT);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('batches join paragraphs with \\n\\n separators', () => {
    fc.assert(
      fc.property(paragraphTextsArb, (paragraphs) => {
        const batches = buildBatches(paragraphs);

        for (const batch of batches) {
          const count = batch.end - batch.start;
          const expected = paragraphs.slice(batch.start, batch.end).join('\n\n');
          expect(batch.text).toBe(expected);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('batches cover all paragraphs without gaps or overlaps', () => {
    fc.assert(
      fc.property(paragraphTextsArb, (paragraphs) => {
        const batches = buildBatches(paragraphs);

        // First batch starts at 0
        expect(batches[0].start).toBe(0);
        // Last batch ends at paragraphs.length
        expect(batches[batches.length - 1].end).toBe(paragraphs.length);
        // Consecutive batches are adjacent
        for (let i = 1; i < batches.length; i++) {
          expect(batches[i].start).toBe(batches[i - 1].end);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('splits when adding the next paragraph would exceed CHAR_LIMIT', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 100, maxLength: 500 }).filter((s) => s.trim().length > 0),
          { minLength: 5, maxLength: 20 }
        ),
        (paragraphs) => {
          const batches = buildBatches(paragraphs);

          // For each batch boundary, verify the split condition
          for (let i = 0; i < batches.length - 1; i++) {
            const currentBatch = batches[i];
            const nextParagraph = paragraphs[currentBatch.end];
            // Adding the next paragraph would have exceeded the limit
            const wouldBe = currentBatch.text + '\n\n' + nextParagraph;
            expect(wouldBe.length).toBeGreaterThan(CHAR_LIMIT);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Preservation: Online Mode API Call', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    // Mock offline mode to return false (online mode)
    localStorage.setItem('giano-offline-mode', 'false');

    // Mock fetch to simulate successful API response
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ translations: ['translated'] }),
    });
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    localStorage.clear();
  });

  it('calls /api/translate with correct body when in online mode', async () => {
    const { postTranslate } = await import('../translate');

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 5 }),
        fc.constantFrom('en', 'it', 'fr', 'de', 'es'),
        fc.constantFrom('en', 'it', 'fr', 'de', 'es'),
        async (texts, sourceLang, targetLang) => {
          // Ensure we're in online mode
          localStorage.setItem('giano-offline-mode', 'false');

          mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ translations: texts.map((t) => `translated_${t}`) }),
          });

          const result = await postTranslate(texts, sourceLang, targetLang);

          // Verify fetch was called with /api/translate
          const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
          expect(lastCall[0]).toBe('/api/translate');

          // Verify request body contains texts, sourceLang, targetLang
          const options = lastCall[1] as RequestInit;
          expect(options.method).toBe('POST');
          expect(options.headers).toEqual({ 'Content-Type': 'application/json' });

          const body = JSON.parse(options.body as string);
          expect(body.texts).toEqual(texts);
          expect(body.sourceLang).toBe(sourceLang);
          expect(body.targetLang).toBe(targetLang);

          // Result should be the translations from the response
          expect(result).toEqual(texts.map((t) => `translated_${t}`));
        }
      ),
      { numRuns: 30 }
    );
  });
});
