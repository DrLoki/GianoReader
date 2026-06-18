import { describe, it, expect, vi } from 'vitest';

// Mock pdfjs-dist to avoid DOMMatrix dependency in test environment
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}));

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: '',
}));

const { PdfNavigator } = await import('./pdf.js');

/**
 * Helper: creates a mock PDFDocumentProxy for page mode (no outline).
 */
function mockDoc(numPages) {
  return {
    numPages,
    getDestination: async () => null,
    getPageIndex: async () => 0,
  };
}

/**
 * Helper: creates a mock PDFDocumentProxy for chapter mode.
 * outlinePages is an array of 0-based page indices that each outline entry resolves to.
 */
function mockDocWithOutline(numPages, outlinePages) {
  return {
    numPages,
    getDestination: async (name) => {
      // Named destinations resolve to an array with a ref object
      const idx = parseInt(name.replace('dest', ''), 10);
      return [{ num: idx, gen: 0 }];
    },
    getPageIndex: async (ref) => {
      // ref.num is the 0-based page index
      return ref.num;
    },
  };
}

/**
 * Helper: creates an outline array from page indices (0-based).
 */
function makeOutline(pages, titles) {
  return pages.map((pageIdx, i) => ({
    title: titles ? titles[i] : `Chapter ${i + 1}`,
    dest: `dest${pageIdx}`,
    items: [],
  }));
}

describe('PdfNavigator — Page Mode', () => {
  it('should be in page mode when outline is null', async () => {
    const nav = await PdfNavigator.create(mockDoc(10), null);
    expect(nav.mode).toBe('page');
    expect(nav.totalUnits).toBe(10);
  });

  it('should be in page mode when outline is empty array', async () => {
    const nav = await PdfNavigator.create(mockDoc(5), []);
    expect(nav.mode).toBe('page');
    expect(nav.totalUnits).toBe(5);
  });

  it('should start at index 0', async () => {
    const nav = await PdfNavigator.create(mockDoc(10), null);
    expect(nav.currentIndex).toBe(0);
  });

  it('currentLabel returns "Pag. 1 / 10" at start', async () => {
    const nav = await PdfNavigator.create(mockDoc(10), null);
    expect(nav.currentLabel).toBe('Pag. 1 / 10');
  });

  it('currentLabel updates after navigation', async () => {
    const nav = await PdfNavigator.create(mockDoc(10), null);
    nav.goTo(4);
    expect(nav.currentLabel).toBe('Pag. 5 / 10');
  });

  it('pageRange returns single page in page mode', async () => {
    const nav = await PdfNavigator.create(mockDoc(10), null);
    expect(nav.pageRange).toEqual({ start: 1, end: 1 });
    nav.goTo(5);
    expect(nav.pageRange).toEqual({ start: 6, end: 6 });
  });

  it('goTo returns true for valid index', async () => {
    const nav = await PdfNavigator.create(mockDoc(10), null);
    expect(nav.goTo(5)).toBe(true);
    expect(nav.currentIndex).toBe(5);
  });

  it('goTo returns false for out-of-bounds index', async () => {
    const nav = await PdfNavigator.create(mockDoc(10), null);
    expect(nav.goTo(-1)).toBe(false);
    expect(nav.goTo(10)).toBe(false);
    expect(nav.currentIndex).toBe(0);
  });

  it('next() advances and returns true', async () => {
    const nav = await PdfNavigator.create(mockDoc(3), null);
    expect(nav.next()).toBe(true);
    expect(nav.currentIndex).toBe(1);
  });

  it('next() returns false at end', async () => {
    const nav = await PdfNavigator.create(mockDoc(3), null);
    nav.goTo(2);
    expect(nav.next()).toBe(false);
    expect(nav.currentIndex).toBe(2);
  });

  it('prev() goes back and returns true', async () => {
    const nav = await PdfNavigator.create(mockDoc(3), null);
    nav.goTo(2);
    expect(nav.prev()).toBe(true);
    expect(nav.currentIndex).toBe(1);
  });

  it('prev() returns false at start', async () => {
    const nav = await PdfNavigator.create(mockDoc(3), null);
    expect(nav.prev()).toBe(false);
    expect(nav.currentIndex).toBe(0);
  });
});

describe('PdfNavigator — Chapter Mode', () => {
  it('should be in chapter mode when outline is non-empty', async () => {
    const doc = mockDocWithOutline(20, [0, 5, 12]);
    const outline = makeOutline([0, 5, 12]);
    const nav = await PdfNavigator.create(doc, outline);
    expect(nav.mode).toBe('chapter');
  });

  it('totalUnits equals number of outline entries', async () => {
    const doc = mockDocWithOutline(20, [0, 5, 12]);
    const outline = makeOutline([0, 5, 12]);
    const nav = await PdfNavigator.create(doc, outline);
    expect(nav.totalUnits).toBe(3);
  });

  it('chapter ranges are contiguous and cover all pages', async () => {
    const doc = mockDocWithOutline(20, [0, 5, 12]);
    const outline = makeOutline([0, 5, 12]);
    const nav = await PdfNavigator.create(doc, outline);

    // Check all chapters cover pages 1-20
    nav.goTo(0);
    expect(nav.pageRange).toEqual({ start: 1, end: 5 });
    nav.goTo(1);
    expect(nav.pageRange).toEqual({ start: 6, end: 12 });
    nav.goTo(2);
    expect(nav.pageRange).toEqual({ start: 13, end: 20 });
  });

  it('currentLabel returns chapter title', async () => {
    const doc = mockDocWithOutline(20, [0, 5, 12]);
    const outline = makeOutline([0, 5, 12], ['Intro', 'Methods', 'Results']);
    const nav = await PdfNavigator.create(doc, outline);
    expect(nav.currentLabel).toBe('Intro');
    nav.goTo(1);
    expect(nav.currentLabel).toBe('Methods');
    nav.goTo(2);
    expect(nav.currentLabel).toBe('Results');
  });

  it('navigation boundary checks work in chapter mode', async () => {
    const doc = mockDocWithOutline(20, [0, 5, 12]);
    const outline = makeOutline([0, 5, 12]);
    const nav = await PdfNavigator.create(doc, outline);

    expect(nav.prev()).toBe(false);
    expect(nav.currentIndex).toBe(0);

    expect(nav.next()).toBe(true);
    expect(nav.currentIndex).toBe(1);

    nav.goTo(2);
    expect(nav.next()).toBe(false);
    expect(nav.currentIndex).toBe(2);
  });

  it('falls back to page mode when all outline entries fail to resolve', async () => {
    const doc = {
      numPages: 10,
      getDestination: async () => null, // all destinations unresolvable
      getPageIndex: async () => { throw new Error('not found'); },
    };
    const outline = [{ title: 'Ch1', dest: 'bad', items: [] }];
    const nav = await PdfNavigator.create(doc, outline);
    expect(nav.mode).toBe('page');
    expect(nav.totalUnits).toBe(10);
  });

  it('handles outline entries with array destinations', async () => {
    const doc = {
      numPages: 10,
      getDestination: async () => null,
      getPageIndex: async (ref) => ref.num,
    };
    // Outline with direct array destinations (not named)
    const outline = [
      { title: 'Part 1', dest: [{ num: 0, gen: 0 }, 'Fit'], items: [] },
      { title: 'Part 2', dest: [{ num: 4, gen: 0 }, 'Fit'], items: [] },
    ];
    const nav = await PdfNavigator.create(doc, outline);
    expect(nav.mode).toBe('chapter');
    expect(nav.totalUnits).toBe(2);
    expect(nav.pageRange).toEqual({ start: 1, end: 4 });
    nav.goTo(1);
    expect(nav.pageRange).toEqual({ start: 5, end: 10 });
  });

  it('first chapter always starts at page 1 even if outline starts later', async () => {
    // Outline starts at page 3 (0-based index 2)
    const doc = mockDocWithOutline(10, [2, 6]);
    const outline = makeOutline([2, 6]);
    const nav = await PdfNavigator.create(doc, outline);
    nav.goTo(0);
    expect(nav.pageRange.start).toBe(1);
  });

  it('last chapter extends to last page', async () => {
    const doc = mockDocWithOutline(50, [0, 10, 30]);
    const outline = makeOutline([0, 10, 30]);
    const nav = await PdfNavigator.create(doc, outline);
    nav.goTo(2);
    expect(nav.pageRange.end).toBe(50);
  });
});

describe('PdfNavigator — getTocEntries()', () => {
  it('returns empty array in page mode', async () => {
    const nav = await PdfNavigator.create(mockDoc(10), null);
    expect(nav.getTocEntries()).toEqual([]);
  });

  it('returns flat entries for outline without nesting', async () => {
    const doc = mockDocWithOutline(30, [0, 10, 20]);
    const outline = makeOutline([0, 10, 20], ['Intro', 'Body', 'Conclusion']);
    const nav = await PdfNavigator.create(doc, outline);
    const entries = nav.getTocEntries();
    expect(entries).toEqual([
      { label: 'Intro', index: 0, level: 0 },
      { label: 'Body', index: 1, level: 0 },
      { label: 'Conclusion', index: 2, level: 0 },
    ]);
  });

  it('returns nested entries with correct levels and parent index', async () => {
    const doc = {
      numPages: 30,
      getDestination: async (name) => {
        const idx = parseInt(name.replace('dest', ''), 10);
        return [{ num: idx, gen: 0 }];
      },
      getPageIndex: async (ref) => ref.num,
    };
    const outline = [
      {
        title: 'Chapter 1',
        dest: 'dest0',
        items: [
          { title: 'Section 1.1', dest: 'dest2', items: [] },
          { title: 'Section 1.2', dest: 'dest5', items: [
            { title: 'Sub 1.2.1', dest: 'dest6', items: [] },
          ] },
        ],
      },
      {
        title: 'Chapter 2',
        dest: 'dest15',
        items: [
          { title: 'Section 2.1', dest: 'dest18', items: [] },
        ],
      },
    ];
    const nav = await PdfNavigator.create(doc, outline);
    const entries = nav.getTocEntries();
    expect(entries).toEqual([
      { label: 'Chapter 1', index: 0, level: 0 },
      { label: 'Section 1.1', index: 0, level: 1 },
      { label: 'Section 1.2', index: 0, level: 1 },
      { label: 'Sub 1.2.1', index: 0, level: 2 },
      { label: 'Chapter 2', index: 1, level: 0 },
      { label: 'Section 2.1', index: 1, level: 1 },
    ]);
  });

  it('single chapter with nested items', async () => {
    const doc = mockDocWithOutline(10, [0]);
    const outline = [
      {
        title: 'Only Chapter',
        dest: 'dest0',
        items: [
          { title: 'Sub A', dest: 'dest2', items: [] },
          { title: 'Sub B', dest: 'dest5', items: [] },
        ],
      },
    ];
    const nav = await PdfNavigator.create(doc, outline);
    const entries = nav.getTocEntries();
    expect(entries).toEqual([
      { label: 'Only Chapter', index: 0, level: 0 },
      { label: 'Sub A', index: 0, level: 1 },
      { label: 'Sub B', index: 0, level: 1 },
    ]);
  });
});

describe('PdfNavigator — getTickPositions()', () => {
  it('returns one tick per chapter in chapter mode', async () => {
    const doc = mockDocWithOutline(30, [0, 10, 20]);
    const outline = makeOutline([0, 10, 20]);
    const nav = await PdfNavigator.create(doc, outline);
    const ticks = nav.getTickPositions();
    expect(ticks).toHaveLength(3);
    expect(ticks[0]).toBeCloseTo(0);
    expect(ticks[1]).toBeCloseTo(0.5);
    expect(ticks[2]).toBeCloseTo(1);
  });

  it('returns one tick per page when P <= 20 in page mode', async () => {
    const nav = await PdfNavigator.create(mockDoc(5), null);
    const ticks = nav.getTickPositions();
    expect(ticks).toHaveLength(5);
    expect(ticks[0]).toBeCloseTo(0);
    expect(ticks[4]).toBeCloseTo(1);
  });

  it('returns floor(P/10) ticks when P > 20 in page mode', async () => {
    const nav = await PdfNavigator.create(mockDoc(50), null);
    const ticks = nav.getTickPositions();
    expect(ticks).toHaveLength(5); // floor(50/10) = 5
    expect(ticks[0]).toBeCloseTo(0);
    expect(ticks[1]).toBeCloseTo(10 / 50);
    expect(ticks[2]).toBeCloseTo(20 / 50);
    expect(ticks[3]).toBeCloseTo(30 / 50);
    expect(ticks[4]).toBeCloseTo(40 / 50);
  });

  it('returns 20 ticks for exactly 20 pages (P <= 20 case)', async () => {
    const nav = await PdfNavigator.create(mockDoc(20), null);
    const ticks = nav.getTickPositions();
    expect(ticks).toHaveLength(20);
    expect(ticks[0]).toBeCloseTo(0);
    expect(ticks[19]).toBeCloseTo(1);
  });

  it('returns floor(P/10) ticks for 21 pages (P > 20 case)', async () => {
    const nav = await PdfNavigator.create(mockDoc(21), null);
    const ticks = nav.getTickPositions();
    expect(ticks).toHaveLength(2); // floor(21/10) = 2
    expect(ticks[0]).toBeCloseTo(0);
    expect(ticks[1]).toBeCloseTo(10 / 21);
  });

  it('single chapter returns single tick at 0', async () => {
    const doc = mockDocWithOutline(10, [0]);
    const outline = makeOutline([0]);
    const nav = await PdfNavigator.create(doc, outline);
    const ticks = nav.getTickPositions();
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toBeCloseTo(0);
  });

  it('single page returns single tick at 0', async () => {
    const nav = await PdfNavigator.create(mockDoc(1), null);
    const ticks = nav.getTickPositions();
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toBeCloseTo(0);
  });
});

describe('PdfNavigator — getPageForUnit()', () => {
  it('returns startPage of chapter in chapter mode', async () => {
    const doc = mockDocWithOutline(30, [0, 10, 20]);
    const outline = makeOutline([0, 10, 20]);
    const nav = await PdfNavigator.create(doc, outline);
    expect(nav.getPageForUnit(0)).toBe(1);
    expect(nav.getPageForUnit(1)).toBe(11);
    expect(nav.getPageForUnit(2)).toBe(21);
  });

  it('returns idx + 1 in page mode', async () => {
    const nav = await PdfNavigator.create(mockDoc(10), null);
    expect(nav.getPageForUnit(0)).toBe(1);
    expect(nav.getPageForUnit(5)).toBe(6);
    expect(nav.getPageForUnit(9)).toBe(10);
  });

  it('returns null for negative index', async () => {
    const nav = await PdfNavigator.create(mockDoc(10), null);
    expect(nav.getPageForUnit(-1)).toBe(null);
  });

  it('returns null for out-of-bounds index', async () => {
    const nav = await PdfNavigator.create(mockDoc(10), null);
    expect(nav.getPageForUnit(10)).toBe(null);
  });

  it('returns null for out-of-bounds index in chapter mode', async () => {
    const doc = mockDocWithOutline(30, [0, 10, 20]);
    const outline = makeOutline([0, 10, 20]);
    const nav = await PdfNavigator.create(doc, outline);
    expect(nav.getPageForUnit(3)).toBe(null);
    expect(nav.getPageForUnit(-1)).toBe(null);
  });
});

describe('PdfNavigator — Edge Cases', () => {
  it('single page document in page mode', async () => {
    const nav = await PdfNavigator.create(mockDoc(1), null);
    expect(nav.totalUnits).toBe(1);
    expect(nav.currentLabel).toBe('Pag. 1 / 1');
    expect(nav.pageRange).toEqual({ start: 1, end: 1 });
    expect(nav.next()).toBe(false);
    expect(nav.prev()).toBe(false);
  });

  it('single chapter in chapter mode', async () => {
    const doc = mockDocWithOutline(10, [0]);
    const outline = makeOutline([0], ['Only Chapter']);
    const nav = await PdfNavigator.create(doc, outline);
    expect(nav.totalUnits).toBe(1);
    expect(nav.currentLabel).toBe('Only Chapter');
    expect(nav.pageRange).toEqual({ start: 1, end: 10 });
    expect(nav.next()).toBe(false);
    expect(nav.prev()).toBe(false);
  });

  it('goTo does not change index on invalid input', async () => {
    const nav = await PdfNavigator.create(mockDoc(5), null);
    nav.goTo(3);
    expect(nav.goTo(-1)).toBe(false);
    expect(nav.currentIndex).toBe(3);
    expect(nav.goTo(5)).toBe(false);
    expect(nav.currentIndex).toBe(3);
  });
});
