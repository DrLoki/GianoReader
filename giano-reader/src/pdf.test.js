import { describe, it, expect, vi } from 'vitest';

// Mock pdfjs-dist to avoid DOMMatrix dependency in test environment
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
}));

import {
  validateTextContent,
  sortTextItems,
  groupIntoLines,
  groupIntoParagraphs,
  splitLongParagraph,
  extractPageText,
  detectColumns,
} from './pdf.js';

/**
 * Creates a mock PDFDocumentProxy for testing validateTextContent.
 * @param {string[]} pageTexts - Array of text strings, one per page
 * @returns {object} Mock PDFDocumentProxy
 */
function createMockDoc(pageTexts) {
  return {
    numPages: pageTexts.length,
    getPage(n) {
      return Promise.resolve({
        getTextContent() {
          const text = pageTexts[n - 1] || '';
          const items = text ? [{ str: text }] : [];
          return Promise.resolve({ items });
        },
      });
    },
  };
}

describe('validateTextContent', () => {
  it('returns "ok" when at least one page has text', async () => {
    const doc = createMockDoc(['Hello world', '', '']);
    expect(await validateTextContent(doc)).toBe('ok');
  });

  it('returns "blocked" when all pages have no text', async () => {
    const doc = createMockDoc(['', '', '']);
    expect(await validateTextContent(doc)).toBe('blocked');
  });

  it('returns "blocked" when all pages have only whitespace', async () => {
    const doc = createMockDoc(['   ', '\t\n', '  \r\n  ']);
    expect(await validateTextContent(doc)).toBe('blocked');
  });

  it('returns "ok" when text is found on a later page', async () => {
    const doc = createMockDoc(['', '', 'Some text here']);
    expect(await validateTextContent(doc)).toBe('ok');
  });

  it('analyzes only the first 5 pages of a longer document', async () => {
    // Pages 1-5 are empty, page 6 has text — should still return blocked
    const doc = createMockDoc(['', '', '', '', '', 'Text on page 6']);
    expect(await validateTextContent(doc)).toBe('blocked');
  });

  it('returns "ok" for a single page with text', async () => {
    const doc = createMockDoc(['Content']);
    expect(await validateTextContent(doc)).toBe('ok');
  });

  it('returns "blocked" for a single empty page', async () => {
    const doc = createMockDoc(['']);
    expect(await validateTextContent(doc)).toBe('blocked');
  });

  it('handles pages with multiple text items', async () => {
    const doc = {
      numPages: 1,
      getPage() {
        return Promise.resolve({
          getTextContent() {
            return Promise.resolve({
              items: [{ str: '  ' }, { str: '' }, { str: '  ' }],
            });
          },
        });
      },
    };
    expect(await validateTextContent(doc)).toBe('blocked');
  });

  it('returns "ok" when one text item among many has non-whitespace', async () => {
    const doc = {
      numPages: 1,
      getPage() {
        return Promise.resolve({
          getTextContent() {
            return Promise.resolve({
              items: [{ str: '  ' }, { str: 'a' }, { str: '  ' }],
            });
          },
        });
      },
    };
    expect(await validateTextContent(doc)).toBe('ok');
  });
});


describe('sortTextItems', () => {
  it('sorts by Y descending then X ascending', () => {
    const items = [
      { str: 'A', x: 100, y: 500, height: 12 },
      { str: 'B', x: 50, y: 500, height: 12 },
      { str: 'C', x: 50, y: 700, height: 12 },
    ];
    const sorted = sortTextItems(items);
    expect(sorted[0].str).toBe('C'); // highest Y first
    expect(sorted[1].str).toBe('B'); // same Y as A, lower X
    expect(sorted[2].str).toBe('A'); // same Y as B, higher X
  });

  it('returns empty array for empty input', () => {
    expect(sortTextItems([])).toEqual([]);
  });

  it('does not mutate the original array', () => {
    const items = [
      { str: 'A', x: 100, y: 500, height: 12 },
      { str: 'B', x: 50, y: 700, height: 12 },
    ];
    const original = [...items];
    sortTextItems(items);
    expect(items).toEqual(original);
  });
});

describe('groupIntoLines', () => {
  it('groups items within Y tolerance into the same line', () => {
    const items = [
      { str: 'A', x: 10, y: 700, height: 12 },
      { str: 'B', x: 50, y: 701, height: 12 }, // within 2px
      { str: 'C', x: 10, y: 680, height: 12 }, // new line
    ];
    const lines = groupIntoLines(items);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveLength(2);
    expect(lines[0][0].str).toBe('A');
    expect(lines[0][1].str).toBe('B');
    expect(lines[1][0].str).toBe('C');
  });

  it('returns empty array for empty input', () => {
    expect(groupIntoLines([])).toEqual([]);
  });

  it('puts all items in one line if Y values are within tolerance', () => {
    const items = [
      { str: 'A', x: 10, y: 700, height: 12 },
      { str: 'B', x: 50, y: 700.5, height: 12 },
      { str: 'C', x: 90, y: 699, height: 12 },
    ];
    const lines = groupIntoLines(items);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(3);
  });

  it('respects custom tolerance', () => {
    const items = [
      { str: 'A', x: 10, y: 700, height: 12 },
      { str: 'B', x: 50, y: 696, height: 12 }, // 4px away
    ];
    // Default tolerance (2) should split them
    expect(groupIntoLines(items, 2)).toHaveLength(2);
    // Larger tolerance (5) should keep them together
    expect(groupIntoLines(items, 5)).toHaveLength(1);
  });
});

describe('groupIntoParagraphs', () => {
  it('groups lines into one paragraph when gaps are small', () => {
    const lines = [
      [{ str: 'Line 1', x: 10, y: 700, height: 12 }],
      [{ str: 'Line 2', x: 10, y: 686, height: 12 }], // gap = (700-12) - 686 = 2
    ];
    const paragraphs = groupIntoParagraphs(lines, 12);
    expect(paragraphs).toHaveLength(1);
  });

  it('starts a new paragraph when gap exceeds 1.5× avgHeight', () => {
    const lines = [
      [{ str: 'Line 1', x: 10, y: 700, height: 12 }],
      [{ str: 'Line 2', x: 10, y: 660, height: 12 }], // gap = (700-12) - 660 = 28 > 18
    ];
    const paragraphs = groupIntoParagraphs(lines, 12);
    expect(paragraphs).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(groupIntoParagraphs([], 12)).toEqual([]);
  });
});

describe('splitLongParagraph', () => {
  it('returns single element for short text', () => {
    const text = 'Hello world.';
    expect(splitLongParagraph(text)).toEqual([text]);
  });

  it('splits at sentence boundary when text exceeds maxLen', () => {
    const sentence1 = 'A'.repeat(3000) + '. ';
    const sentence2 = 'B'.repeat(2000);
    const text = sentence1 + sentence2;
    const chunks = splitLongParagraph(text, 4500);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should end at the sentence boundary
    expect(chunks[0]).toContain('A');
    expect(chunks[0].endsWith('.')).toBe(true);
  });

  it('force-splits when no sentence boundary found', () => {
    const text = 'A'.repeat(10000); // no sentence boundaries
    const chunks = splitLongParagraph(text, 4500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].length).toBe(4500);
  });

  it('handles exclamation and question marks as boundaries', () => {
    const part1 = 'A'.repeat(3000) + '! ';
    const part2 = 'B'.repeat(2000);
    const text = part1 + part2;
    const chunks = splitLongParagraph(text, 4500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].endsWith('!')).toBe(true);
  });

  it('respects custom maxLen', () => {
    const text = 'Hello world. This is a test. More text here.';
    const chunks = splitLongParagraph(text, 20);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe('extractPageText', () => {
  /**
   * Creates a mock PDF page with text items.
   * @param {Array<{str: string, transform: number[], height?: number}>} textItems
   */
  function createMockPage(textItems) {
    return {
      getTextContent() {
        return Promise.resolve({
          items: textItems.map(item => ({
            str: item.str,
            transform: item.transform,
            height: item.height || Math.sqrt(item.transform[0] ** 2 + item.transform[1] ** 2),
          })),
        });
      },
    };
  }

  it('returns localized no-text notice when page has no text items', async () => {
    const page = createMockPage([]);
    const result = await extractPageText(page, 3, 'en');
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('Page 3');
    expect(result[0]).toContain('no selectable text');
  });

  it('returns localized no-text notice when all items are whitespace', async () => {
    const page = createMockPage([
      { str: '   ', transform: [12, 0, 0, 12, 50, 700] },
      { str: '\t', transform: [12, 0, 0, 12, 100, 700] },
    ]);
    const result = await extractPageText(page, 1, 'en');
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('no selectable text');
  });

  it('extracts text from a simple single-line page', async () => {
    const page = createMockPage([
      { str: 'Hello', transform: [12, 0, 0, 12, 50, 700] },
      { str: 'World', transform: [12, 0, 0, 12, 100, 700] },
    ]);
    const result = await extractPageText(page, 1, 'en');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('Hello World');
  });

  it('groups items into separate lines by Y position', async () => {
    const page = createMockPage([
      { str: 'Line1', transform: [12, 0, 0, 12, 50, 700] },
      { str: 'Line2', transform: [12, 0, 0, 12, 50, 686] }, // 14px gap, within same paragraph
    ]);
    const result = await extractPageText(page, 1, 'en');
    // Both lines should be in the same paragraph (gap = (700-12) - 686 = 2, < 1.5*12=18)
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('Line1 Line2');
  });

  it('creates separate paragraphs for large vertical gaps', async () => {
    const page = createMockPage([
      { str: 'Para1', transform: [12, 0, 0, 12, 50, 700] },
      { str: 'Para2', transform: [12, 0, 0, 12, 50, 650] }, // gap = (700-12) - 650 = 38 > 18
    ]);
    const result = await extractPageText(page, 1, 'en');
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('Para1');
    expect(result[1]).toBe('Para2');
  });

  it('sorts items correctly regardless of input order', async () => {
    const page = createMockPage([
      { str: 'Right', transform: [12, 0, 0, 12, 200, 700] },
      { str: 'Left', transform: [12, 0, 0, 12, 50, 700] },
    ]);
    const result = await extractPageText(page, 1, 'en');
    expect(result[0]).toBe('Left Right');
  });

  it('splits long paragraphs at sentence boundaries', async () => {
    const longSentence = 'A'.repeat(3000) + '. ' + 'B'.repeat(2000) + '. ' + 'C'.repeat(1000);
    const page = createMockPage([
      { str: longSentence, transform: [12, 0, 0, 12, 50, 700] },
    ]);
    const result = await extractPageText(page, 1, 'en');
    expect(result.length).toBeGreaterThan(1);
    // All chunks should be <= 4500 chars (or forced split)
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(4500);
    }
  });
});

describe('detectColumns', () => {
  it('returns single group for items all in one column', () => {
    // All items clustered on the left side
    const items = [
      { str: 'A', x: 50, y: 700, height: 12 },
      { str: 'B', x: 60, y: 700, height: 12 },
      { str: 'C', x: 50, y: 686, height: 12 },
      { str: 'D', x: 60, y: 686, height: 12 },
    ];
    const { columns, splitX } = detectColumns(items);
    expect(columns).toHaveLength(1);
    expect(columns[0]).toEqual(items);
    expect(splitX).toBeNull();
  });

  it('returns single group for fewer than 4 items', () => {
    const items = [
      { str: 'A', x: 50, y: 700, height: 12 },
      { str: 'B', x: 400, y: 700, height: 12 },
    ];
    const { columns } = detectColumns(items);
    expect(columns).toHaveLength(1);
  });

  it('detects two columns with a clear gap in the middle', () => {
    // Left column items (x: 50-150), right column items (x: 350-450)
    // Gap at x: 150-350
    const items = [];
    for (let row = 0; row < 10; row++) {
      items.push({ str: `L${row}`, x: 50, y: 700 - row * 14, height: 12 });
      items.push({ str: `L${row}b`, x: 100, y: 700 - row * 14, height: 12 });
      items.push({ str: `R${row}`, x: 350, y: 700 - row * 14, height: 12 });
      items.push({ str: `R${row}b`, x: 400, y: 700 - row * 14, height: 12 });
    }
    const { columns, splitX } = detectColumns(items);
    expect(columns).toHaveLength(2);
    // Left column should have items with x < 250 (midpoint of gap)
    expect(columns[0].every(item => item.x < 250)).toBe(true);
    // Right column should have items with x >= 250
    expect(columns[1].every(item => item.x >= 250)).toBe(true);
    // splitX should be defined
    expect(splitX).toBeTypeOf('number');
    expect(splitX).toBeGreaterThan(100);
    expect(splitX).toBeLessThan(350);
  });

  it('returns single group when items are evenly distributed (no gap)', () => {
    // Simulate a single-column page where each line has multiple words spanning the width
    const items = [];
    for (let row = 0; row < 10; row++) {
      // Each row has 10 words spread across the width with small gaps (like normal text)
      for (let word = 0; word < 10; word++) {
        items.push({ str: `word${word}`, x: 50 + word * 45, y: 700 - row * 14, height: 12 });
      }
    }
    const { columns } = detectColumns(items);
    expect(columns).toHaveLength(1);
  });

  it('returns single group when one side has too few items', () => {
    // Most items on the left, only 1 on the right
    const items = [];
    for (let row = 0; row < 20; row++) {
      items.push({ str: `L${row}`, x: 50, y: 700 - row * 14, height: 12 });
    }
    items.push({ str: 'R0', x: 400, y: 700, height: 12 });
    const { columns } = detectColumns(items);
    expect(columns).toHaveLength(1);
  });
});

describe('extractPageText - multi-column', () => {
  function createMockPage(textItems) {
    return {
      getTextContent() {
        return Promise.resolve({
          items: textItems.map(item => ({
            str: item.str,
            transform: item.transform,
            height: item.height || Math.sqrt(item.transform[0] ** 2 + item.transform[1] ** 2),
          })),
        });
      },
    };
  }

  it('extracts two-column text in correct reading order (left column first)', async () => {
    // Simulate a two-column page:
    // Left column (x=50): "Chapter 1" (y=700), "Introduction text" (y=686)
    // Right column (x=350): "Chapter 2" (y=700), "More content here" (y=686)
    // With enough items to trigger column detection (need >= 4 items, 15% each side)
    const items = [];
    // Left column - 10 lines
    for (let i = 0; i < 10; i++) {
      items.push({ str: `Left line ${i + 1}`, transform: [12, 0, 0, 12, 50, 700 - i * 14] });
    }
    // Right column - 10 lines
    for (let i = 0; i < 10; i++) {
      items.push({ str: `Right line ${i + 1}`, transform: [12, 0, 0, 12, 350, 700 - i * 14] });
    }

    const result = await extractPageText(createMockPage(items), 1, 'en');

    // All left column text should come before right column text
    const fullText = result.join(' | ');
    const leftLastIndex = fullText.lastIndexOf('Left line');
    const rightFirstIndex = fullText.indexOf('Right line');
    expect(leftLastIndex).toBeLessThan(rightFirstIndex);
  });

  it('single-column page still works correctly', async () => {
    // All items in a single column (x around 50-100)
    const items = [
      { str: 'First paragraph line 1', transform: [12, 0, 0, 12, 50, 700] },
      { str: 'First paragraph line 2', transform: [12, 0, 0, 12, 50, 686] },
      { str: 'Second paragraph', transform: [12, 0, 0, 12, 50, 650] },
    ];
    const result = await extractPageText(createMockPage(items), 1, 'en');
    expect(result[0]).toContain('First paragraph line 1');
    expect(result[0]).toContain('First paragraph line 2');
  });
});
