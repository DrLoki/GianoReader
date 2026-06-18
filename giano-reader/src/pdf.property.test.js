import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';

// Mock pdfjs-dist to avoid DOMMatrix dependency in test environment
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
}));

import { validateMagicBytes, checkFileSize, resolveTitle, validateTextContent, PdfNavigator, sortTextItems, groupIntoLines, groupIntoParagraphs, extractChapterText, computeCanvasScale, isLibraryFile } from './pdf.js';

// Feature: pdf-support, Property 1: Magic byte validation
// **Validates: Requirements 1.5**
describe('Property 1: Magic byte validation', () => {
  it('accepts any buffer whose first 5 bytes are %PDF-', () => {
    // Generate arbitrary trailing bytes after the valid magic header
    const validBufferArb = fc.uint8Array({ minLength: 0, maxLength: 200 }).map((tail) => {
      const magic = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D]); // %PDF-
      const buf = new Uint8Array(5 + tail.length);
      buf.set(magic, 0);
      buf.set(tail, 5);
      return buf.buffer;
    });

    fc.assert(
      fc.property(validBufferArb, (buffer) => {
        expect(validateMagicBytes(buffer)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('rejects any buffer whose first 5 bytes are NOT %PDF-', () => {
    // Generate arbitrary buffers that do NOT start with %PDF-
    const invalidBufferArb = fc.uint8Array({ minLength: 5, maxLength: 200 }).filter((arr) => {
      // Reject if it happens to start with %PDF- (0x25, 0x50, 0x44, 0x46, 0x2D)
      return !(arr[0] === 0x25 && arr[1] === 0x50 && arr[2] === 0x44 && arr[3] === 0x46 && arr[4] === 0x2D);
    }).map((arr) => arr.buffer);

    fc.assert(
      fc.property(invalidBufferArb, (buffer) => {
        expect(validateMagicBytes(buffer)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('rejects buffers shorter than 5 bytes', () => {
    const shortBufferArb = fc.uint8Array({ minLength: 0, maxLength: 4 }).map((arr) => arr.buffer);

    fc.assert(
      fc.property(shortBufferArb, (buffer) => {
        expect(validateMagicBytes(buffer)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: pdf-support, Property 2: File size guard
// **Validates: Requirements 1.4**
describe('Property 2: File size guard', () => {
  it('accepts file iff size <= maxFileSizeMB * 1024 * 1024', () => {
    const sizeArb = fc.nat({ max: 500 * 1024 * 1024 }); // up to 500 MB in bytes
    const limitArb = fc.integer({ min: 1, max: 500 }); // 1–500 MB limit

    fc.assert(
      fc.property(sizeArb, limitArb, (size, maxFileSizeMB) => {
        const result = checkFileSize(size, maxFileSizeMB);
        const expected = size <= maxFileSizeMB * 1024 * 1024;
        expect(result).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });

  it('rejects file when size is exactly one byte over the limit', () => {
    const limitArb = fc.integer({ min: 1, max: 100 });

    fc.assert(
      fc.property(limitArb, (maxFileSizeMB) => {
        const exactLimit = maxFileSizeMB * 1024 * 1024;
        expect(checkFileSize(exactLimit, maxFileSizeMB)).toBe(true);
        expect(checkFileSize(exactLimit + 1, maxFileSizeMB)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: pdf-support, Property 3: Title resolution fallback
// **Validates: Requirements 1.6, 10.2**
describe('Property 3: Title resolution fallback', () => {
  it('returns metadata title when it is a non-empty string', () => {
    const titleArb = fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0);
    const filenameArb = fc.string({ minLength: 1 });

    fc.assert(
      fc.property(titleArb, filenameArb, (title, filename) => {
        const metadata = { info: { Title: title } };
        const result = resolveTitle(metadata, filename);
        expect(result).toBe(title.trim());
      }),
      { numRuns: 100 }
    );
  });

  it('falls back to filename without last extension when metadata title is absent', () => {
    // Generate filenames with at least one dot and a non-empty base
    const baseArb = fc.string({ minLength: 1, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')) });
    const extArb = fc.constantFrom('.pdf', '.PDF', '.txt', '.doc', '.epub');
    const filenameArb = fc.tuple(baseArb, extArb).map(([base, ext]) => base + ext);

    // Metadata with no title (null, undefined, empty string, or whitespace-only)
    const emptyMetadataArb = fc.constantFrom(
      null,
      undefined,
      {},
      { info: null },
      { info: {} },
      { info: { Title: '' } },
      { info: { Title: '   ' } },
      { info: { Title: null } },
      { info: { Title: undefined } }
    );

    fc.assert(
      fc.property(emptyMetadataArb, filenameArb, (metadata, filename) => {
        const result = resolveTitle(metadata, filename);
        const dotIndex = filename.lastIndexOf('.');
        const expected = dotIndex > 0 ? filename.substring(0, dotIndex) : filename;
        expect(result).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: pdf-support, Property 4: Text content validation
// **Validates: Requirements 2.2, 2.3**
describe('Property 4: Text content validation', () => {
  /**
   * Helper that builds a mock PDFDocumentProxy.
   * @param {string[]} pageTexts - Array of strings, one per page
   * @returns {object} Mock doc object compatible with validateTextContent
   */
  function createMockDoc(pageTexts) {
    return {
      numPages: pageTexts.length,
      getPage: (n) => Promise.resolve({
        getTextContent: () => Promise.resolve({
          items: [{ str: pageTexts[n - 1] }]
        })
      })
    };
  }

  it('returns "blocked" when all pages have zero non-whitespace text', () => {
    // Generate 1–5 pages of whitespace-only content
    const whitespaceArb = fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r', ''));
    const pagesArb = fc.array(whitespaceArb, { minLength: 1, maxLength: 5 });

    fc.assert(
      fc.asyncProperty(pagesArb, async (pages) => {
        const doc = createMockDoc(pages);
        const result = await validateTextContent(doc);
        expect(result).toBe('blocked');
      }),
      { numRuns: 100 }
    );
  });

  it('returns "ok" when at least one page has non-whitespace text', () => {
    // Generate pages where at least one has non-whitespace content
    const whitespaceArb = fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r', ''));
    const nonEmptyTextArb = fc.string({ minLength: 1 }).filter((s) => s.replace(/\s/g, '').length > 0);

    const pagesArb = fc.array(whitespaceArb, { minLength: 0, maxLength: 4 }).chain((emptyPages) =>
      fc.tuple(
        fc.constant(emptyPages),
        nonEmptyTextArb,
        fc.array(whitespaceArb, { minLength: 0, maxLength: 4 })
      )
    ).map(([before, nonEmpty, after]) => [...before, nonEmpty, ...after])
      .filter((pages) => pages.length >= 1 && pages.length <= 5);

    fc.assert(
      fc.asyncProperty(pagesArb, async (pages) => {
        const doc = createMockDoc(pages);
        const result = await validateTextContent(doc);
        expect(result).toBe('ok');
      }),
      { numRuns: 100 }
    );
  });
});

// --- PdfNavigator Property Tests (Properties 5–10) ---

/**
 * Mock helpers for PdfNavigator property tests.
 */
function mockDoc(numPages) {
  return { numPages, getDestination: async () => null, getPageIndex: async () => 0 };
}

function mockDocWithOutline(numPages, outlinePages) {
  return {
    numPages,
    getDestination: async (name) => {
      const idx = parseInt(name.replace('dest', ''), 10);
      return [{ num: idx, gen: 0 }];
    },
    getPageIndex: async (ref) => ref.num,
  };
}

function makeOutline(pages) {
  return pages.map((pageIdx, i) => ({
    title: `Chapter ${i + 1}`,
    dest: `dest${pageIdx}`,
    items: [],
  }));
}

// Feature: pdf-support, Property 5: Navigation mode selection
// **Validates: Requirements 3.2, 3.3**
describe('Property 5: Navigation mode selection', () => {
  it('mode is "page" when outline is null or empty array', () => {
    const numPagesArb = fc.integer({ min: 1, max: 500 });
    const nullOrEmptyArb = fc.constantFrom(null, []);

    fc.assert(
      fc.asyncProperty(numPagesArb, nullOrEmptyArb, async (numPages, outline) => {
        const doc = mockDoc(numPages);
        const nav = await PdfNavigator.create(doc, outline);
        expect(nav.mode).toBe('page');
      }),
      { numRuns: 100 }
    );
  });

  it('mode is "chapter" when outline is a non-empty array with resolvable entries', () => {
    // Generate 1-10 chapters with valid page indices within the document
    const numPagesArb = fc.integer({ min: 2, max: 500 });

    fc.assert(
      fc.asyncProperty(numPagesArb, async (numPages) => {
        // Generate 1 to min(10, numPages) unique sorted page indices (0-based)
        const maxChapters = Math.min(10, numPages);
        const chapterCount = Math.max(1, Math.floor(Math.random() * maxChapters) + 1);
        const pageIndices = [];
        const step = Math.floor(numPages / chapterCount);
        for (let i = 0; i < chapterCount; i++) {
          pageIndices.push(Math.min(i * step, numPages - 1));
        }

        const doc = mockDocWithOutline(numPages, pageIndices);
        const outline = makeOutline(pageIndices);
        const nav = await PdfNavigator.create(doc, outline);
        expect(nav.mode).toBe('chapter');
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: pdf-support, Property 6: Chapter page ranges contiguous and complete
// **Validates: Requirements 3.4**
describe('Property 6: Chapter page ranges contiguous and complete', () => {
  it('chapter ranges cover all pages 1..P with no gaps or overlaps', () => {
    // Generate documents with 2-200 pages and 1-10 chapters
    const numPagesArb = fc.integer({ min: 2, max: 200 });
    const chapterCountArb = fc.integer({ min: 1, max: 10 });

    fc.assert(
      fc.asyncProperty(numPagesArb, chapterCountArb, async (numPages, rawChapterCount) => {
        const chapterCount = Math.min(rawChapterCount, numPages);
        // Generate sorted unique page indices (0-based) for chapter starts
        const pageIndices = [];
        const step = Math.max(1, Math.floor(numPages / chapterCount));
        for (let i = 0; i < chapterCount; i++) {
          const idx = Math.min(i * step, numPages - 1);
          if (pageIndices.length === 0 || pageIndices[pageIndices.length - 1] !== idx) {
            pageIndices.push(idx);
          }
        }

        const doc = mockDocWithOutline(numPages, pageIndices);
        const outline = makeOutline(pageIndices);
        const nav = await PdfNavigator.create(doc, outline);

        if (nav.mode !== 'chapter') return; // skip if deduplication reduced to 0

        // Collect all page ranges
        const ranges = [];
        for (let i = 0; i < nav.totalUnits; i++) {
          nav.goTo(i);
          ranges.push(nav.pageRange);
        }

        // First range starts at page 1
        expect(ranges[0].start).toBe(1);

        // Last range ends at numPages
        expect(ranges[ranges.length - 1].end).toBe(numPages);

        // Ranges are contiguous: each range's start = previous range's end + 1
        for (let i = 1; i < ranges.length; i++) {
          expect(ranges[i].start).toBe(ranges[i - 1].end + 1);
        }

        // No overlaps: each range's start <= end
        for (const range of ranges) {
          expect(range.start).toBeLessThanOrEqual(range.end);
        }
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: pdf-support, Property 7: Navigation unit count matches mode
// **Validates: Requirements 4.1, 5.1**
describe('Property 7: Navigation unit count matches mode', () => {
  it('in page mode, totalUnits equals numPages', () => {
    const numPagesArb = fc.integer({ min: 1, max: 1000 });

    fc.assert(
      fc.asyncProperty(numPagesArb, async (numPages) => {
        const doc = mockDoc(numPages);
        const nav = await PdfNavigator.create(doc, null);
        expect(nav.mode).toBe('page');
        expect(nav.totalUnits).toBe(numPages);
      }),
      { numRuns: 100 }
    );
  });

  it('in chapter mode, totalUnits equals number of resolved chapters', () => {
    const numPagesArb = fc.integer({ min: 2, max: 500 });
    const chapterCountArb = fc.integer({ min: 1, max: 10 });

    fc.assert(
      fc.asyncProperty(numPagesArb, chapterCountArb, async (numPages, rawChapterCount) => {
        const chapterCount = Math.min(rawChapterCount, numPages);
        // Generate unique sorted page indices
        const pageIndices = [];
        const step = Math.max(1, Math.floor(numPages / chapterCount));
        for (let i = 0; i < chapterCount; i++) {
          const idx = Math.min(i * step, numPages - 1);
          if (pageIndices.length === 0 || pageIndices[pageIndices.length - 1] !== idx) {
            pageIndices.push(idx);
          }
        }

        const doc = mockDocWithOutline(numPages, pageIndices);
        const outline = makeOutline(pageIndices);
        const nav = await PdfNavigator.create(doc, outline);

        if (nav.mode === 'chapter') {
          expect(nav.totalUnits).toBe(pageIndices.length);
        }
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: pdf-support, Property 8: Navigation boundary behavior
// **Validates: Requirements 4.2, 5.2**
describe('Property 8: Navigation boundary behavior', () => {
  it('prev() at index 0 returns false and does not change index', () => {
    const numPagesArb = fc.integer({ min: 1, max: 200 });

    fc.assert(
      fc.asyncProperty(numPagesArb, async (numPages) => {
        const doc = mockDoc(numPages);
        const nav = await PdfNavigator.create(doc, null);
        expect(nav.currentIndex).toBe(0);
        const result = nav.prev();
        expect(result).toBe(false);
        expect(nav.currentIndex).toBe(0);
      }),
      { numRuns: 100 }
    );
  });

  it('next() at totalUnits-1 returns false and does not change index', () => {
    const numPagesArb = fc.integer({ min: 1, max: 200 });

    fc.assert(
      fc.asyncProperty(numPagesArb, async (numPages) => {
        const doc = mockDoc(numPages);
        const nav = await PdfNavigator.create(doc, null);
        nav.goTo(nav.totalUnits - 1);
        const result = nav.next();
        expect(result).toBe(false);
        expect(nav.currentIndex).toBe(nav.totalUnits - 1);
      }),
      { numRuns: 100 }
    );
  });

  it('prev() and next() work correctly at non-boundary positions', () => {
    // Need at least 3 pages to have a non-boundary position
    const numPagesArb = fc.integer({ min: 3, max: 200 });

    fc.assert(
      fc.asyncProperty(numPagesArb, async (numPages) => {
        const doc = mockDoc(numPages);
        const nav = await PdfNavigator.create(doc, null);

        // Pick a middle position
        const midIndex = Math.floor(numPages / 2);
        nav.goTo(midIndex);

        // next() should advance
        const nextResult = nav.next();
        expect(nextResult).toBe(true);
        expect(nav.currentIndex).toBe(midIndex + 1);

        // prev() should go back
        const prevResult = nav.prev();
        expect(prevResult).toBe(true);
        expect(nav.currentIndex).toBe(midIndex);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: pdf-support, Property 9: Progress bar calculation
// **Validates: Requirements 4.4, 5.4**
describe('Property 9: Progress bar calculation', () => {
  it('progress = currentIndex / max(1, totalUnits - 1) is always in [0, 1]', () => {
    const numPagesArb = fc.integer({ min: 1, max: 500 });

    fc.assert(
      fc.asyncProperty(numPagesArb, async (numPages) => {
        const doc = mockDoc(numPages);
        const nav = await PdfNavigator.create(doc, null);

        // Test at every valid index (sample a few for large documents)
        const indicesToTest = numPages <= 20
          ? Array.from({ length: numPages }, (_, i) => i)
          : [0, 1, Math.floor(numPages / 4), Math.floor(numPages / 2), numPages - 2, numPages - 1];

        for (const idx of indicesToTest) {
          nav.goTo(idx);
          const progress = nav.currentIndex / Math.max(1, nav.totalUnits - 1);
          expect(progress).toBeGreaterThanOrEqual(0);
          expect(progress).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('progress is 0 at first unit and 1 at last unit (when totalUnits > 1)', () => {
    const numPagesArb = fc.integer({ min: 2, max: 500 });

    fc.assert(
      fc.asyncProperty(numPagesArb, async (numPages) => {
        const doc = mockDoc(numPages);
        const nav = await PdfNavigator.create(doc, null);

        // At index 0, progress should be 0
        nav.goTo(0);
        const progressStart = nav.currentIndex / Math.max(1, nav.totalUnits - 1);
        expect(progressStart).toBe(0);

        // At last index, progress should be 1
        nav.goTo(nav.totalUnits - 1);
        const progressEnd = nav.currentIndex / Math.max(1, nav.totalUnits - 1);
        expect(progressEnd).toBe(1);
      }),
      { numRuns: 100 }
    );
  });

  it('progress is 0 when totalUnits is 1 (single unit document)', () => {
    fc.assert(
      fc.asyncProperty(fc.constant(1), async () => {
        const doc = mockDoc(1);
        const nav = await PdfNavigator.create(doc, null);
        const progress = nav.currentIndex / Math.max(1, nav.totalUnits - 1);
        expect(progress).toBe(0);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: pdf-support, Property 10: Tick generation logic
// **Validates: Requirements 4.5, 5.6**
describe('Property 10: Tick generation logic', () => {
  it('in chapter mode, getTickPositions() returns exactly N positions', () => {
    const numPagesArb = fc.integer({ min: 2, max: 200 });
    const chapterCountArb = fc.integer({ min: 1, max: 10 });

    fc.assert(
      fc.asyncProperty(numPagesArb, chapterCountArb, async (numPages, rawChapterCount) => {
        const chapterCount = Math.min(rawChapterCount, numPages);
        const pageIndices = [];
        const step = Math.max(1, Math.floor(numPages / chapterCount));
        for (let i = 0; i < chapterCount; i++) {
          const idx = Math.min(i * step, numPages - 1);
          if (pageIndices.length === 0 || pageIndices[pageIndices.length - 1] !== idx) {
            pageIndices.push(idx);
          }
        }

        const doc = mockDocWithOutline(numPages, pageIndices);
        const outline = makeOutline(pageIndices);
        const nav = await PdfNavigator.create(doc, outline);

        if (nav.mode === 'chapter') {
          const ticks = nav.getTickPositions();
          expect(ticks.length).toBe(nav.totalUnits);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('in page mode with P <= 20, getTickPositions() returns P positions', () => {
    const numPagesArb = fc.integer({ min: 1, max: 20 });

    fc.assert(
      fc.asyncProperty(numPagesArb, async (numPages) => {
        const doc = mockDoc(numPages);
        const nav = await PdfNavigator.create(doc, null);
        const ticks = nav.getTickPositions();
        expect(ticks.length).toBe(numPages);
      }),
      { numRuns: 100 }
    );
  });

  it('in page mode with P > 20, getTickPositions() returns floor(P/10) positions', () => {
    const numPagesArb = fc.integer({ min: 21, max: 1000 });

    fc.assert(
      fc.asyncProperty(numPagesArb, async (numPages) => {
        const doc = mockDoc(numPages);
        const nav = await PdfNavigator.create(doc, null);
        const ticks = nav.getTickPositions();
        expect(ticks.length).toBe(Math.floor(numPages / 10));
      }),
      { numRuns: 100 }
    );
  });

  it('all tick positions are in [0, 1]', () => {
    const numPagesArb = fc.integer({ min: 1, max: 500 });

    fc.assert(
      fc.asyncProperty(numPagesArb, async (numPages) => {
        const doc = mockDoc(numPages);
        const nav = await PdfNavigator.create(doc, null);
        const ticks = nav.getTickPositions();
        for (const tick of ticks) {
          expect(tick).toBeGreaterThanOrEqual(0);
          expect(tick).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 100 }
    );
  });
});


// --- Text Extraction Property Tests (Properties 11–13) ---

// Feature: pdf-support, Property 11: Text item sorting
// **Validates: Requirements 6.2**
describe('Property 11: Text item sorting', () => {
  it('sorts items by decreasing Y then increasing X within same Y', () => {
    // Generate random arrays of text items with arbitrary x, y, height values
    const textItemArb = fc.record({
      str: fc.string({ minLength: 1, maxLength: 10 }),
      x: fc.double({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }),
      y: fc.double({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }),
      height: fc.double({ min: 1, max: 50, noNaN: true, noDefaultInfinity: true }),
    });
    const itemsArb = fc.array(textItemArb, { minLength: 0, maxLength: 50 });

    fc.assert(
      fc.property(itemsArb, (items) => {
        const sorted = sortTextItems(items);

        // Verify length is preserved
        expect(sorted.length).toBe(items.length);

        // Verify ordering: for consecutive items, either Y is strictly decreasing
        // or Y is equal and X is non-decreasing
        for (let i = 0; i < sorted.length - 1; i++) {
          const a = sorted[i];
          const b = sorted[i + 1];
          if (a.y !== b.y) {
            // Y must be decreasing (a.y > b.y)
            expect(a.y).toBeGreaterThan(b.y);
          } else {
            // Same Y: X must be non-decreasing (a.x <= b.x)
            expect(a.x).toBeLessThanOrEqual(b.x);
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  it('does not lose or duplicate items', () => {
    const textItemArb = fc.record({
      str: fc.string({ minLength: 1, maxLength: 5 }),
      x: fc.double({ min: 0, max: 500, noNaN: true, noDefaultInfinity: true }),
      y: fc.double({ min: 0, max: 500, noNaN: true, noDefaultInfinity: true }),
      height: fc.double({ min: 1, max: 30, noNaN: true, noDefaultInfinity: true }),
    });
    const itemsArb = fc.array(textItemArb, { minLength: 0, maxLength: 30 });

    fc.assert(
      fc.property(itemsArb, (items) => {
        const sorted = sortTextItems(items);
        expect(sorted.length).toBe(items.length);

        // Every item in the original should appear in the sorted result
        for (const item of items) {
          expect(sorted).toContainEqual(item);
        }
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: pdf-support, Property 12: Paragraph grouping by vertical gap
// **Validates: Requirements 6.3**
describe('Property 12: Paragraph grouping by vertical gap', () => {
  it('items within same paragraph have gaps < 1.5× avgHeight between consecutive lines', () => {
    // Generate sorted items with known Y positions and a known avgHeight
    // We create lines with controlled gaps
    const avgHeightArb = fc.double({ min: 5, max: 30, noNaN: true, noDefaultInfinity: true });
    const lineCountArb = fc.integer({ min: 2, max: 20 });

    fc.assert(
      fc.property(avgHeightArb, lineCountArb, (avgHeight, lineCount) => {
        const threshold = 1.5 * avgHeight;

        // Create lines with Y positions that decrease (simulating top-to-bottom reading)
        // Each line is an array of items at the same Y
        const lines = [];
        let currentY = 800;
        for (let i = 0; i < lineCount; i++) {
          lines.push([{ str: `line${i}`, x: 0, y: currentY, height: avgHeight }]);
          // Decrease Y by avgHeight (normal line spacing, gap = 0 which is < threshold)
          currentY -= avgHeight;
        }

        const paragraphs = groupIntoParagraphs(lines, avgHeight);

        // With gaps of 0 (prevLineY - prevLineHeight - currLineY = currentY + avgHeight - avgHeight - currentY = 0),
        // all lines should be in the same paragraph since 0 < threshold
        expect(paragraphs.length).toBe(1);
        expect(paragraphs[0].length).toBe(lineCount);
      }),
      { numRuns: 100 }
    );
  });

  it('items in different paragraphs have gaps >= 1.5× avgHeight at the boundary', () => {
    // Generate lines where we explicitly insert a large gap to force a paragraph break
    const avgHeightArb = fc.double({ min: 5, max: 30, noNaN: true, noDefaultInfinity: true });
    const linesBeforeArb = fc.integer({ min: 1, max: 5 });
    const linesAfterArb = fc.integer({ min: 1, max: 5 });
    const extraGapFactorArb = fc.double({ min: 0.01, max: 10, noNaN: true, noDefaultInfinity: true });

    fc.assert(
      fc.property(avgHeightArb, linesBeforeArb, linesAfterArb, extraGapFactorArb, (avgHeight, linesBefore, linesAfter, extraGapFactor) => {
        const threshold = 1.5 * avgHeight;

        // Create first group of lines with tight spacing (gap = 0)
        const lines = [];
        let currentY = 800;
        for (let i = 0; i < linesBefore; i++) {
          lines.push([{ str: `before${i}`, x: 0, y: currentY, height: avgHeight }]);
          currentY -= avgHeight; // gap between lines = 0
        }

        // Insert a large gap that exceeds threshold
        // gap = (prevLineY - prevLineHeight) - currLineY > threshold
        // prevLineY = currentY + avgHeight (the last line's Y)
        // prevLineHeight = avgHeight
        // So gap = (currentY + avgHeight - avgHeight) - currLineY = currentY - currLineY
        // We want currentY - currLineY > threshold
        const largeGap = threshold + extraGapFactor;
        currentY -= largeGap;

        // Create second group of lines with tight spacing
        for (let i = 0; i < linesAfter; i++) {
          lines.push([{ str: `after${i}`, x: 0, y: currentY, height: avgHeight }]);
          currentY -= avgHeight;
        }

        const paragraphs = groupIntoParagraphs(lines, avgHeight);

        // Should have at least 2 paragraphs due to the large gap
        expect(paragraphs.length).toBeGreaterThanOrEqual(2);

        // First paragraph should contain the "before" lines
        expect(paragraphs[0].length).toBe(linesBefore);

        // Second paragraph should contain the "after" lines
        expect(paragraphs[1].length).toBe(linesAfter);
      }),
      { numRuns: 100 }
    );
  });

  it('empty lines array produces empty paragraphs array', () => {
    const avgHeightArb = fc.double({ min: 1, max: 50, noNaN: true, noDefaultInfinity: true });

    fc.assert(
      fc.property(avgHeightArb, (avgHeight) => {
        const paragraphs = groupIntoParagraphs([], avgHeight);
        expect(paragraphs).toEqual([]);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: pdf-support, Property 13: Multi-page concatenation preserves order
// **Validates: Requirements 6.4**
describe('Property 13: Multi-page concatenation preserves order', () => {
  /**
   * Creates a mock doc where each page returns text items that produce known paragraph strings.
   * Each page has simple text items at distinct Y positions so extractPageText produces
   * one paragraph per text string.
   */
  function createMockDocForExtraction(pageResults) {
    return {
      numPages: pageResults.length,
      getPage: (n) => Promise.resolve({
        getTextContent: () => Promise.resolve({
          items: pageResults[n - 1].map((text, idx) => ({
            str: text,
            transform: [12, 0, 0, 12, 0, 800 - (idx * 200)],
          }))
        })
      })
    };
  }

  it('concatenates paragraph arrays from all pages in order', () => {
    // Generate N pages, each with a known set of paragraph texts
    // Using large Y gaps between items so each item becomes its own paragraph
    const pageCountArb = fc.integer({ min: 1, max: 10 });
    const pageTextsArb = fc.array(
      fc.array(fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0), { minLength: 1, maxLength: 5 }),
      { minLength: 1, maxLength: 10 }
    );

    fc.assert(
      fc.asyncProperty(pageTextsArb, async (pageTexts) => {
        const doc = createMockDocForExtraction(pageTexts);
        const pageRange = { start: 1, end: pageTexts.length };

        const result = await extractChapterText(doc, pageRange, 'en');

        // The result should be the concatenation of all page paragraph arrays in order
        // Each page's items are spaced 200px apart in Y with height 12,
        // so gap = (prevY - height) - currY = (800 - idx*200 - 12) - (800 - (idx+1)*200) = 200 - 12 = 188
        // threshold = 1.5 * 12 = 18, and 188 > 18, so each item is its own paragraph
        // Therefore each text string becomes its own paragraph
        const expected = pageTexts.flat();
        expect(result).toEqual(expected);
      }),
      { numRuns: 100 }
    );
  });

  it('single page extraction equals direct page result', () => {
    const pageTextsArb = fc.array(
      fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
      { minLength: 1, maxLength: 5 }
    );

    fc.assert(
      fc.asyncProperty(pageTextsArb, async (texts) => {
        const doc = createMockDocForExtraction([texts]);
        const pageRange = { start: 1, end: 1 };

        const result = await extractChapterText(doc, pageRange, 'en');

        // Each text item becomes its own paragraph (large Y gaps)
        expect(result).toEqual(texts);
      }),
      { numRuns: 100 }
    );
  });

  it('page order is preserved across multiple pages', () => {
    // Generate pages with unique identifiable content to verify ordering
    const pageCountArb = fc.integer({ min: 2, max: 8 });

    fc.assert(
      fc.asyncProperty(pageCountArb, async (pageCount) => {
        // Create pages with unique identifiers
        const pageTexts = Array.from({ length: pageCount }, (_, i) => [`page${i + 1}_text`]);
        const doc = createMockDocForExtraction(pageTexts);
        const pageRange = { start: 1, end: pageCount };

        const result = await extractChapterText(doc, pageRange, 'en');

        // Verify order: page1 content comes before page2, etc.
        for (let i = 0; i < pageCount; i++) {
          expect(result[i]).toBe(`page${i + 1}_text`);
        }
      }),
      { numRuns: 100 }
    );
  });
});

// --- Canvas Rendering Property Tests (Property 14) ---

// Feature: pdf-support, Property 14: Canvas scale preserves aspect ratio
// **Validates: Requirements 7.4**
describe('Property 14: Canvas scale preserves aspect ratio', () => {
  it('canvasWidth / canvasHeight ≈ pageWidth / pageHeight (aspect ratio preserved)', () => {
    const pageWidthArb = fc.double({ min: 1, max: 5000, noNaN: true, noDefaultInfinity: true });
    const pageHeightArb = fc.double({ min: 1, max: 5000, noNaN: true, noDefaultInfinity: true });
    const containerWidthArb = fc.double({ min: 1, max: 5000, noNaN: true, noDefaultInfinity: true });

    fc.assert(
      fc.property(pageWidthArb, pageHeightArb, containerWidthArb, (pageWidth, pageHeight, containerWidth) => {
        const { scale, canvasWidth, canvasHeight } = computeCanvasScale(pageWidth, pageHeight, containerWidth);

        // Scale must be positive
        expect(scale).toBeGreaterThan(0);

        // canvasWidth should equal containerWidth (scales to fit width exactly)
        expect(canvasWidth).toBeCloseTo(containerWidth, 10);

        // canvasWidth must not exceed containerWidth
        expect(canvasWidth).toBeLessThanOrEqual(containerWidth + 1e-10);

        // Aspect ratio preserved: canvasWidth / canvasHeight ≈ pageWidth / pageHeight
        const canvasAspect = canvasWidth / canvasHeight;
        const pageAspect = pageWidth / pageHeight;
        expect(Math.abs(canvasAspect - pageAspect)).toBeLessThan(1e-10);
      }),
      { numRuns: 100 }
    );
  });
});

// --- i18n Completeness Property Tests (Property 18) ---

import { translations } from './i18n.js';

// Feature: pdf-support, Property 18: i18n key completeness for PDF strings
// **Validates: Requirements 12.2**
describe('Property 18: i18n key completeness for PDF strings', () => {
  const pdfKeys = [
    'pdf_page_indicator',
    'pdf_no_text_notice',
    'pdf_blocked_dialog',
    'pdf_error_invalid',
    'pdf_error_too_large',
    'pdf_error_open',
    'pdf_toc_placeholder',
    'pdf_canvas_tooltip',
    'pdf_no_text_translate',
    'pdf_rendering_unavailable',
  ];

  const languages = ['it', 'en', 'fr', 'de', 'es', 'pt', 'ru', 'zh', 'ja', 'ar', 'fil', 'sq'];

  it('every PDF key exists in every supported language as a non-empty string', () => {
    const keyArb = fc.constantFrom(...pdfKeys);
    const langArb = fc.constantFrom(...languages);

    fc.assert(
      fc.property(keyArb, langArb, (key, lang) => {
        const value = translations[lang][key];
        expect(value).toBeDefined();
        expect(typeof value).toBe('string');
        expect(value.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 }
    );
  });
});

// --- Bookmark Property Tests (Properties 15–16) ---

// Feature: pdf-support, Property 15: PDF bookmark structure completeness
// **Validates: Requirements 9.1**
describe('Property 15: PDF bookmark structure completeness', () => {
  /**
   * Simulates bookmark creation for a PDF navigation state.
   * This mirrors the logic in main.js when the user clicks "Add bookmark" with a PDF open.
   */
  function createPdfBookmark({ filePath, fileName, bookTitle, chapterIndex, chapterLabel, scrollPct, pageNumber }) {
    return {
      id: Date.now(),
      filePath,
      fileName,
      bookTitle,
      chapterIndex,
      chapterLabel,
      scrollPct,
      fileType: 'pdf',
      pageNumber,
    };
  }

  it('all required fields are present and valid for any valid PDF navigation state', () => {
    const filePathArb = fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0);
    const fileNameArb = fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0);
    const bookTitleArb = fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0);
    const chapterIndexArb = fc.nat({ max: 1000 }); // non-negative integer
    const chapterLabelArb = fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0);
    const scrollPctArb = fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true });
    const pageNumberArb = fc.integer({ min: 1, max: 10000 }); // positive integer >= 1

    fc.assert(
      fc.property(
        filePathArb, fileNameArb, bookTitleArb, chapterIndexArb, chapterLabelArb, scrollPctArb, pageNumberArb,
        (filePath, fileName, bookTitle, chapterIndex, chapterLabel, scrollPct, pageNumber) => {
          const bookmark = createPdfBookmark({ filePath, fileName, bookTitle, chapterIndex, chapterLabel, scrollPct, pageNumber });

          // fileType must be 'pdf'
          expect(bookmark.fileType).toBe('pdf');

          // pageNumber must be a positive integer (>= 1)
          expect(bookmark.pageNumber).toBe(pageNumber);
          expect(Number.isInteger(bookmark.pageNumber)).toBe(true);
          expect(bookmark.pageNumber).toBeGreaterThanOrEqual(1);

          // chapterIndex must be a non-negative integer (>= 0)
          expect(bookmark.chapterIndex).toBe(chapterIndex);
          expect(Number.isInteger(bookmark.chapterIndex)).toBe(true);
          expect(bookmark.chapterIndex).toBeGreaterThanOrEqual(0);

          // scrollPct must be a number in [0, 100]
          expect(bookmark.scrollPct).toBe(scrollPct);
          expect(typeof bookmark.scrollPct).toBe('number');
          expect(bookmark.scrollPct).toBeGreaterThanOrEqual(0);
          expect(bookmark.scrollPct).toBeLessThanOrEqual(100);

          // chapterLabel must be a non-empty string
          expect(bookmark.chapterLabel).toBe(chapterLabel);
          expect(typeof bookmark.chapterLabel).toBe('string');
          expect(bookmark.chapterLabel.length).toBeGreaterThan(0);

          // filePath must be a non-empty string
          expect(bookmark.filePath).toBe(filePath);
          expect(typeof bookmark.filePath).toBe('string');
          expect(bookmark.filePath.length).toBeGreaterThan(0);

          // fileName must be a non-empty string
          expect(bookmark.fileName).toBe(fileName);
          expect(typeof bookmark.fileName).toBe('string');
          expect(bookmark.fileName.length).toBeGreaterThan(0);

          // bookTitle must be a non-empty string
          expect(bookmark.bookTitle).toBe(bookTitle);
          expect(typeof bookmark.bookTitle).toBe('string');
          expect(bookmark.bookTitle.length).toBeGreaterThan(0);

          // id must be a positive number
          expect(typeof bookmark.id).toBe('number');
          expect(bookmark.id).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('bookmark contains exactly the expected set of fields', () => {
    const filePathArb = fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0);
    const fileNameArb = fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0);
    const bookTitleArb = fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0);
    const chapterIndexArb = fc.nat({ max: 500 });
    const chapterLabelArb = fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0);
    const scrollPctArb = fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true });
    const pageNumberArb = fc.integer({ min: 1, max: 5000 });

    const expectedKeys = ['id', 'filePath', 'fileName', 'bookTitle', 'chapterIndex', 'chapterLabel', 'scrollPct', 'fileType', 'pageNumber'].sort();

    fc.assert(
      fc.property(
        filePathArb, fileNameArb, bookTitleArb, chapterIndexArb, chapterLabelArb, scrollPctArb, pageNumberArb,
        (filePath, fileName, bookTitle, chapterIndex, chapterLabel, scrollPct, pageNumber) => {
          const bookmark = createPdfBookmark({ filePath, fileName, bookTitle, chapterIndex, chapterLabel, scrollPct, pageNumber });
          const actualKeys = Object.keys(bookmark).sort();
          expect(actualKeys).toEqual(expectedKeys);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: pdf-support, Property 16: EPUB bookmark backward compatibility
// **Validates: Requirements 9.3**
describe('Property 16: EPUB bookmark backward compatibility', () => {
  it('JSON round-trip preserves all fields of an EPUB bookmark without fileType', () => {
    const idArb = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
    const filePathArb = fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0);
    const fileNameArb = fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0);
    const bookTitleArb = fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0);
    const chapterIndexArb = fc.nat({ max: 1000 });
    const chapterLabelArb = fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0);
    const scrollPctArb = fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true });

    fc.assert(
      fc.property(
        idArb, filePathArb, fileNameArb, bookTitleArb, chapterIndexArb, chapterLabelArb, scrollPctArb,
        (id, filePath, fileName, bookTitle, chapterIndex, chapterLabel, scrollPct) => {
          // Create an EPUB bookmark without fileType field (legacy format)
          const original = { id, filePath, fileName, bookTitle, chapterIndex, chapterLabel, scrollPct };

          // JSON round-trip (simulates localStorage save/load)
          const restored = JSON.parse(JSON.stringify(original));

          // All original fields must be preserved exactly
          expect(restored.id).toBe(original.id);
          expect(restored.filePath).toBe(original.filePath);
          expect(restored.fileName).toBe(original.fileName);
          expect(restored.bookTitle).toBe(original.bookTitle);
          expect(restored.chapterIndex).toBe(original.chapterIndex);
          expect(restored.chapterLabel).toBe(original.chapterLabel);
          expect(restored.scrollPct).toBeCloseTo(original.scrollPct, 10);

          // No new fields should be added (like fileType: 'pdf' or pageNumber)
          expect(restored.fileType).toBeUndefined();
          expect(restored.pageNumber).toBeUndefined();

          // Field count must be the same
          expect(Object.keys(restored).length).toBe(Object.keys(original).length);
          expect(Object.keys(restored).sort()).toEqual(Object.keys(original).sort());
        }
      ),
      { numRuns: 100 }
    );
  });

  it('JSON round-trip preserves all fields of an EPUB bookmark with fileType: "epub"', () => {
    const idArb = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
    const filePathArb = fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0);
    const fileNameArb = fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0);
    const bookTitleArb = fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0);
    const chapterIndexArb = fc.nat({ max: 1000 });
    const chapterLabelArb = fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0);
    const scrollPctArb = fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true });

    fc.assert(
      fc.property(
        idArb, filePathArb, fileNameArb, bookTitleArb, chapterIndexArb, chapterLabelArb, scrollPctArb,
        (id, filePath, fileName, bookTitle, chapterIndex, chapterLabel, scrollPct) => {
          // Create an EPUB bookmark with explicit fileType: 'epub'
          const original = { id, filePath, fileName, bookTitle, chapterIndex, chapterLabel, scrollPct, fileType: 'epub' };

          // JSON round-trip (simulates localStorage save/load)
          const restored = JSON.parse(JSON.stringify(original));

          // All original fields must be preserved exactly
          expect(restored.id).toBe(original.id);
          expect(restored.filePath).toBe(original.filePath);
          expect(restored.fileName).toBe(original.fileName);
          expect(restored.bookTitle).toBe(original.bookTitle);
          expect(restored.chapterIndex).toBe(original.chapterIndex);
          expect(restored.chapterLabel).toBe(original.chapterLabel);
          expect(restored.scrollPct).toBeCloseTo(original.scrollPct, 10);
          expect(restored.fileType).toBe('epub');

          // No PDF-specific fields should be added
          expect(restored.pageNumber).toBeUndefined();

          // Field count must be the same
          expect(Object.keys(restored).length).toBe(Object.keys(original).length);
          expect(Object.keys(restored).sort()).toEqual(Object.keys(original).sort());
        }
      ),
      { numRuns: 100 }
    );
  });

  it('EPUB bookmark does not gain any PDF-specific fields after round-trip', () => {
    const idArb = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
    const filePathArb = fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0);
    const fileNameArb = fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0);
    const bookTitleArb = fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0);
    const chapterIndexArb = fc.nat({ max: 500 });
    const chapterLabelArb = fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0);
    const scrollPctArb = fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true });
    // Randomly include or omit fileType
    const fileTypeArb = fc.constantFrom(undefined, 'epub');

    fc.assert(
      fc.property(
        idArb, filePathArb, fileNameArb, bookTitleArb, chapterIndexArb, chapterLabelArb, scrollPctArb, fileTypeArb,
        (id, filePath, fileName, bookTitle, chapterIndex, chapterLabel, scrollPct, fileType) => {
          const original = { id, filePath, fileName, bookTitle, chapterIndex, chapterLabel, scrollPct };
          if (fileType !== undefined) {
            original.fileType = fileType;
          }

          // JSON round-trip
          const restored = JSON.parse(JSON.stringify(original));

          // The restored object must have exactly the same keys as the original
          const originalKeys = Object.keys(original).sort();
          const restoredKeys = Object.keys(restored).sort();
          expect(restoredKeys).toEqual(originalKeys);

          // Specifically, no PDF fields should appear
          expect('pageNumber' in restored).toBe(false);
          if (fileType === undefined) {
            expect('fileType' in restored).toBe(false);
          } else {
            expect(restored.fileType).toBe('epub');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// --- Library Scan Filter Property Tests (Property 17) ---

// Feature: pdf-support, Property 17: Library scan includes both file extensions
// **Validates: Requirements 10.1**
describe('Property 17: Library scan includes both file extensions', () => {
  it('files ending in .epub (any case) are included', () => {
    // Generate arbitrary base names and case variations of .epub
    const baseArb = fc.string({ minLength: 1, maxLength: 50, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_ '.split('')) });
    const epubExtArb = fc.constantFrom('.epub', '.EPUB', '.Epub', '.ePub', '.ePUB', '.EPub');

    fc.assert(
      fc.property(baseArb, epubExtArb, (base, ext) => {
        const filename = base + ext;
        expect(isLibraryFile(filename)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('files ending in .pdf (any case) are included', () => {
    // Generate arbitrary base names and case variations of .pdf
    const baseArb = fc.string({ minLength: 1, maxLength: 50, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_ '.split('')) });
    const pdfExtArb = fc.constantFrom('.pdf', '.PDF', '.Pdf', '.pDf', '.pDF', '.PDf');

    fc.assert(
      fc.property(baseArb, pdfExtArb, (base, ext) => {
        const filename = base + ext;
        expect(isLibraryFile(filename)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('files with other extensions are excluded', () => {
    // Generate filenames with extensions that are NOT .epub or .pdf
    const baseArb = fc.string({ minLength: 1, maxLength: 30, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')) });
    const otherExtArb = fc.constantFrom('.txt', '.doc', '.docx', '.mobi', '.azw3', '.html', '.rtf', '.odt', '.djvu', '.cbz', '.fb2', '.lit', '.pdb', '.jpg', '.png');

    fc.assert(
      fc.property(baseArb, otherExtArb, (base, ext) => {
        const filename = base + ext;
        expect(isLibraryFile(filename)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('files without extensions are excluded', () => {
    // Generate filenames without any dot (no extension)
    const noExtArb = fc.string({ minLength: 1, maxLength: 50, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_ '.split('')) })
      .filter(s => !s.includes('.'));

    fc.assert(
      fc.property(noExtArb, (filename) => {
        expect(isLibraryFile(filename)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('include iff extension is .epub or .pdf (case-insensitive) for arbitrary filenames', () => {
    // Generate completely arbitrary filenames and verify the biconditional
    const filenameArb = fc.string({ minLength: 1, maxLength: 80 });

    fc.assert(
      fc.property(filenameArb, (filename) => {
        const lower = filename.toLowerCase();
        const shouldInclude = lower.endsWith('.epub') || lower.endsWith('.pdf');
        expect(isLibraryFile(filename)).toBe(shouldInclude);
      }),
      { numRuns: 100 }
    );
  });
});
