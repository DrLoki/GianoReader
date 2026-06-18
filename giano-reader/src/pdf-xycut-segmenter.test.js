import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock xycut.js to isolate unit tests from the actual XY-Cut engine
vi.mock('./xycut.js', () => ({
  performXYCut: vi.fn(),
}));

import {
  normaliseItems,
  collectLeafNodes,
  segmentPageWithCache,
  clearSegmentationCache,
} from './pdf-xycut-segmenter.js';

import { performXYCut } from './xycut.js';

// ── normaliseItems ──────────────────────────────────────────────────────────

describe('normaliseItems', () => {
  it('produces correct {x0, y0, x1, y1} values from known pdf.js items', () => {
    // A pdf.js item with transform [scaleX, skewX, skewY, scaleY, translateX, translateY]
    // fontSize = sqrt(12^2 + 0^2) = 12
    // x0 = 100 (transform[4])
    // y1 = 800 - 700 = 100 (pageHeight - transform[5])
    // y0 = 100 - 12 = 88
    // x1 = 100 + 50 = 150
    const pdfItems = [
      {
        str: 'Hello',
        transform: [12, 0, 0, 12, 100, 700],
        width: 50,
        fontName: 'Arial',
      },
    ];
    const pageHeight = 800;

    const result = normaliseItems(pdfItems, pageHeight);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      x0: 100,
      y0: 88,
      x1: 150,
      y1: 100,
      str: 'Hello',
      fontSize: 12,
      fontName: 'Arial',
    });
  });

  it('handles rotated text (non-zero skew in transform)', () => {
    // fontSize = sqrt(3^2 + 4^2) = 5
    // x0 = 200, y1 = 1000 - 600 = 400, y0 = 400 - 5 = 395, x1 = 200 + 80 = 280
    const pdfItems = [
      {
        str: 'Rotated',
        transform: [3, 4, -4, 3, 200, 600],
        width: 80,
        fontName: 'Times',
      },
    ];
    const pageHeight = 1000;

    const result = normaliseItems(pdfItems, pageHeight);

    expect(result).toHaveLength(1);
    expect(result[0].x0).toBe(200);
    expect(result[0].y0).toBe(395);
    expect(result[0].x1).toBe(280);
    expect(result[0].y1).toBe(400);
    expect(result[0].fontSize).toBe(5);
  });

  it('filters items with empty str.trim()', () => {
    const pdfItems = [
      { str: 'Keep', transform: [12, 0, 0, 12, 50, 700], width: 30, fontName: 'Arial' },
      { str: '', transform: [12, 0, 0, 12, 100, 700], width: 10, fontName: 'Arial' },
      { str: '   ', transform: [12, 0, 0, 12, 150, 700], width: 20, fontName: 'Arial' },
      { str: '\t\n', transform: [12, 0, 0, 12, 200, 700], width: 5, fontName: 'Arial' },
      { str: 'Also keep', transform: [12, 0, 0, 12, 250, 700], width: 60, fontName: 'Arial' },
    ];
    const pageHeight = 800;

    const result = normaliseItems(pdfItems, pageHeight);

    expect(result).toHaveLength(2);
    expect(result[0].str).toBe('Keep');
    expect(result[1].str).toBe('Also keep');
  });

  it('returns empty array when all items have empty str', () => {
    const pdfItems = [
      { str: '', transform: [12, 0, 0, 12, 50, 700], width: 30, fontName: 'Arial' },
      { str: '  ', transform: [12, 0, 0, 12, 100, 700], width: 10, fontName: 'Arial' },
    ];

    const result = normaliseItems(pdfItems, 800);

    expect(result).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(normaliseItems([], 800)).toEqual([]);
  });
});

// ── collectLeafNodes ────────────────────────────────────────────────────────

describe('collectLeafNodes', () => {
  it('returns leaves in expected depth-first order', () => {
    // Tree structure:
    //       root (container)
    //      /    \
    //    A       B (container)
    //  (leaf)   / \
    //         C    D
    //       (leaf) (leaf)
    const root = {
      type: 'container',
      children: [
        { type: 'leaf', text: 'A', bounds: { x: 0, y: 0, w: 100, h: 50 } },
        {
          type: 'container',
          children: [
            { type: 'leaf', text: 'C', bounds: { x: 0, y: 50, w: 50, h: 50 } },
            { type: 'leaf', text: 'D', bounds: { x: 50, y: 50, w: 50, h: 50 } },
          ],
        },
      ],
    };

    const leaves = collectLeafNodes(root);

    expect(leaves).toHaveLength(3);
    expect(leaves[0].text).toBe('A');
    expect(leaves[1].text).toBe('C');
    expect(leaves[2].text).toBe('D');
  });

  it('returns single leaf when root is a leaf node', () => {
    const root = { type: 'leaf', text: 'Only', bounds: { x: 0, y: 0, w: 100, h: 100 } };

    const leaves = collectLeafNodes(root);

    expect(leaves).toHaveLength(1);
    expect(leaves[0].text).toBe('Only');
  });

  it('returns empty array when tree has no leaf nodes', () => {
    const root = {
      type: 'container',
      children: [
        { type: 'container', children: [] },
      ],
    };

    const leaves = collectLeafNodes(root);

    expect(leaves).toEqual([]);
  });

  it('handles deeply nested tree structures', () => {
    // Deep nesting: root → container → container → leaf
    const root = {
      type: 'container',
      children: [
        {
          type: 'container',
          children: [
            {
              type: 'container',
              children: [
                { type: 'leaf', text: 'Deep', bounds: { x: 0, y: 0, w: 10, h: 10 } },
              ],
            },
          ],
        },
        { type: 'leaf', text: 'Shallow', bounds: { x: 10, y: 0, w: 10, h: 10 } },
      ],
    };

    const leaves = collectLeafNodes(root);

    expect(leaves).toHaveLength(2);
    expect(leaves[0].text).toBe('Deep');
    expect(leaves[1].text).toBe('Shallow');
  });
});

// ── segmentPageWithCache ────────────────────────────────────────────────────

describe('segmentPageWithCache', () => {
  /** Creates a mock pdf.js page object */
  function createMockPage(items = []) {
    return {
      getViewport: () => ({ width: 612, height: 792 }),
      getTextContent: () => Promise.resolve({ items }),
    };
  }

  beforeEach(() => {
    clearSegmentationCache();
    vi.clearAllMocks();
  });

  it('returns cached reference on second call (referential equality)', async () => {
    const leafNode = { type: 'leaf', text: 'Hello', bounds: { x: 0, y: 0, w: 100, h: 50 } };
    performXYCut.mockReturnValue({
      root: { type: 'container', children: [leafNode] },
      projections: [],
    });

    const page = createMockPage([
      { str: 'Hello', transform: [12, 0, 0, 12, 50, 700], width: 40, fontName: 'Arial' },
    ]);

    const result1 = await segmentPageWithCache(page, 1, 'hash123', {});
    const result2 = await segmentPageWithCache(page, 1, 'hash123', {});

    // Same reference — not a copy
    expect(result1).toBe(result2);
    // performXYCut should only be called once (cache hit on second call)
    expect(performXYCut).toHaveBeenCalledTimes(1);
  });

  it('does not throw when performXYCut throws (fallback returns [])', async () => {
    performXYCut.mockImplementation(() => {
      throw new Error('XY-Cut engine exploded');
    });

    const page = createMockPage([
      { str: 'Text', transform: [12, 0, 0, 12, 50, 700], width: 40, fontName: 'Arial' },
    ]);

    // Should not throw
    const result = await segmentPageWithCache(page, 1, 'hash456', {});

    expect(result).toEqual([]);
  });

  it('uses different cache entries for different page numbers', async () => {
    const leaf1 = { type: 'leaf', text: 'Page1', bounds: { x: 0, y: 0, w: 100, h: 50 } };
    const leaf2 = { type: 'leaf', text: 'Page2', bounds: { x: 0, y: 0, w: 100, h: 50 } };

    performXYCut
      .mockReturnValueOnce({ root: { type: 'container', children: [leaf1] }, projections: [] })
      .mockReturnValueOnce({ root: { type: 'container', children: [leaf2] }, projections: [] });

    const page = createMockPage([
      { str: 'Text', transform: [12, 0, 0, 12, 50, 700], width: 40, fontName: 'Arial' },
    ]);

    const result1 = await segmentPageWithCache(page, 1, 'hash789', {});
    const result2 = await segmentPageWithCache(page, 2, 'hash789', {});

    expect(result1[0].text).toBe('Page1');
    expect(result2[0].text).toBe('Page2');
    expect(performXYCut).toHaveBeenCalledTimes(2);
  });

  it('uses different cache entries for different pdfHash values', async () => {
    const leaf1 = { type: 'leaf', text: 'Doc1', bounds: { x: 0, y: 0, w: 100, h: 50 } };
    const leaf2 = { type: 'leaf', text: 'Doc2', bounds: { x: 0, y: 0, w: 100, h: 50 } };

    performXYCut
      .mockReturnValueOnce({ root: { type: 'container', children: [leaf1] }, projections: [] })
      .mockReturnValueOnce({ root: { type: 'container', children: [leaf2] }, projections: [] });

    const page = createMockPage([
      { str: 'Text', transform: [12, 0, 0, 12, 50, 700], width: 40, fontName: 'Arial' },
    ]);

    const result1 = await segmentPageWithCache(page, 1, 'docA', {});
    const result2 = await segmentPageWithCache(page, 1, 'docB', {});

    expect(result1[0].text).toBe('Doc1');
    expect(result2[0].text).toBe('Doc2');
    expect(performXYCut).toHaveBeenCalledTimes(2);
  });
});

// ── clearSegmentationCache ──────────────────────────────────────────────────

describe('clearSegmentationCache', () => {
  function createMockPage(items = []) {
    return {
      getViewport: () => ({ width: 612, height: 792 }),
      getTextContent: () => Promise.resolve({ items }),
    };
  }

  beforeEach(() => {
    clearSegmentationCache();
    vi.clearAllMocks();
  });

  it('empties the cache so subsequent calls miss and call performXYCut again', async () => {
    const leaf = { type: 'leaf', text: 'Cached', bounds: { x: 0, y: 0, w: 100, h: 50 } };
    performXYCut.mockReturnValue({
      root: { type: 'container', children: [leaf] },
      projections: [],
    });

    const page = createMockPage([
      { str: 'Text', transform: [12, 0, 0, 12, 50, 700], width: 40, fontName: 'Arial' },
    ]);

    // First call populates cache
    await segmentPageWithCache(page, 1, 'hashClear', {});
    expect(performXYCut).toHaveBeenCalledTimes(1);

    // Second call hits cache — no additional performXYCut call
    await segmentPageWithCache(page, 1, 'hashClear', {});
    expect(performXYCut).toHaveBeenCalledTimes(1);

    // Clear the cache
    clearSegmentationCache();

    // Third call should miss cache and call performXYCut again
    await segmentPageWithCache(page, 1, 'hashClear', {});
    expect(performXYCut).toHaveBeenCalledTimes(2);
  });
});
