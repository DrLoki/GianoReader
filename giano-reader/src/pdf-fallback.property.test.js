import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

// Mock pdfjs-dist to avoid loading the real pdf.js worker
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}));

// Mock the pdf.js worker URL import
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

// Mock segmentPageWithCache to always throw — forcing the fallback path
vi.mock('./pdf-xycut-segmenter.js', () => ({
  segmentPageWithCache: vi.fn().mockRejectedValue(new Error('XY-Cut segmentation failure')),
  clearSegmentationCache: vi.fn(),
}));

// Mock i18n to avoid missing key errors
vi.mock('./i18n.js', () => ({
  t: vi.fn((lang, key) => key),
}));

import { renderPdfWithOverlayPlaceholders } from './pdf.js';
import { segmentPageWithCache } from './pdf-xycut-segmenter.js';

/**
 * Property 8: Fallback output format matches the XY-Cut path output format
 *
 * For any page where `segmentPage` throws, the fallback path produces overlay
 * blocks conforming to `{ text: string, el: HTMLElement, fontSize: number }`
 * and does not propagate the error.
 *
 * **Validates: Requirements 1.5**
 */
describe('Property 8: Fallback output format matches the XY-Cut path output format', () => {

  // Generator: a valid pdf.js text item positioned on a page
  // Items need reasonable positions and font sizes for detectColumns to work
  const pdfTextItemArb = fc.record({
    str: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
    transform: fc.tuple(
      fc.float({ min: 8, max: 24, noNaN: true, noDefaultInfinity: true }),   // scaleX (fontSize)
      fc.constant(0),                                                          // skewX
      fc.constant(0),                                                          // skewY
      fc.float({ min: 8, max: 24, noNaN: true, noDefaultInfinity: true }),   // scaleY
      fc.float({ min: 20, max: 550, noNaN: true, noDefaultInfinity: true }), // x position
      fc.float({ min: 50, max: 750, noNaN: true, noDefaultInfinity: true })  // y position (bottom-up)
    ),
    width: fc.float({ min: 20, max: 200, noNaN: true, noDefaultInfinity: true }),
    fontName: fc.constant('Helvetica'),
  });

  // Generate 1-20 text items for a page
  const textItemsArb = fc.array(pdfTextItemArb, { minLength: 1, maxLength: 20 });

  /**
   * Creates a mock pdf.js page object with the given text items.
   */
  function createMockPage(items) {
    const renderPromise = { promise: Promise.resolve() };
    return {
      getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale }),
      getTextContent: () => Promise.resolve({ items }),
      render: () => renderPromise,
    };
  }

  /**
   * Creates a mock pdf.js document object that returns the given pages.
   */
  function createMockDoc(pages) {
    return {
      numPages: pages.length,
      getPage: (n) => Promise.resolve(pages[n - 1]),
    };
  }

  /**
   * Creates a mock container element with a fixed width.
   */
  function createMockContainer(width = 600) {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: width, configurable: true });
    return container;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-mock segmentPageWithCache to throw for each test
    segmentPageWithCache.mockRejectedValue(new Error('XY-Cut segmentation failure'));
  });

  it('fallback path does not throw and produces blocks with correct shape {text, el, fontSize}', async () => {
    await fc.assert(
      fc.asyncProperty(textItemsArb, async (items) => {
        const mockPage = createMockPage(items);
        const mockDoc = createMockDoc([mockPage]);
        const container = createMockContainer(600);

        // The function should NOT throw even though segmentPageWithCache throws
        let result;
        try {
          result = await renderPdfWithOverlayPlaceholders(mockDoc, [1], container, 'test-hash');
        } catch (err) {
          // If it throws, the property is violated
          expect.fail(`renderPdfWithOverlayPlaceholders threw: ${err.message}`);
        }

        // Result should be an array
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(1);

        const pageResult = result[0];
        expect(pageResult).toHaveProperty('pageNum', 1);
        expect(Array.isArray(pageResult.blocks)).toBe(true);

        // Since we have text items, the fallback should produce at least one block
        // (detectColumns should find at least one block from valid text items)
        expect(pageResult.blocks.length).toBeGreaterThan(0);

        // Every block must conform to { text: string, el: HTMLElement, fontSize: number }
        for (const block of pageResult.blocks) {
          // text is a string
          expect(typeof block.text).toBe('string');
          expect(block.text.length).toBeGreaterThan(0);

          // el is an HTMLElement
          expect(block.el).toBeInstanceOf(HTMLElement);
          expect(block.el.className).toContain('pdf-text-overlay');
          expect(block.el.className).toContain('pending');

          // fontSize is a positive number
          expect(typeof block.fontSize).toBe('number');
          expect(block.fontSize).toBeGreaterThan(0);
          expect(Number.isFinite(block.fontSize)).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });
});
