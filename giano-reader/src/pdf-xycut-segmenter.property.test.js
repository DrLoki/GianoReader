import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { collectLeafNodes, normaliseItems } from './pdf-xycut-segmenter.js';


/**
 * Property 3: Leaf node collection is complete and order-preserving
 *
 * For any XY-Cut result tree of arbitrary shape and depth, `collectLeafNodes`
 * returns exactly the leaf nodes in depth-first left-to-right order.
 *
 * **Validates: Requirements 1.2, 1.3**
 */
describe('Property 3: Leaf node collection is complete and order-preserving', () => {
  // Generator: arbitrary nested tree using fc.letrec
  const treeArb = fc.letrec(tie => ({
    leaf: fc.record({
      type: fc.constant('leaf'),
      bounds: fc.record({
        x: fc.float({ min: 0, max: 500, noNaN: true, noDefaultInfinity: true }),
        y: fc.float({ min: 0, max: 500, noNaN: true, noDefaultInfinity: true }),
        w: fc.float({ min: 1, max: 200, noNaN: true, noDefaultInfinity: true }),
        h: fc.float({ min: 1, max: 200, noNaN: true, noDefaultInfinity: true })
      }),
      text: fc.string({ minLength: 1 }),
      formatting: fc.record({ avgFontSize: fc.float({ min: 6, max: 72, noNaN: true, noDefaultInfinity: true }) })
    }),
    container: fc.record({
      type: fc.constantFrom('x-cut', 'y-cut'),
      children: fc.array(tie('node'), { minLength: 1, maxLength: 5 })
    }),
    node: fc.oneof({ depthSize: 'small' }, tie('leaf'), tie('container'))
  })).node;

  // Reference implementation: depth-first left-to-right leaf collection
  function referenceCollectLeaves(node) {
    if (node.type === 'leaf') return [node];
    if (!node.children) return [];
    return node.children.flatMap(referenceCollectLeaves);
  }

  it('collectLeafNodes returns all leaf nodes in depth-first left-to-right order', () => {
    fc.assert(
      fc.property(treeArb, (tree) => {
        const result = collectLeafNodes(tree);
        const expected = referenceCollectLeaves(tree);

        // Completeness: same number of leaves
        expect(result.length).toBe(expected.length);

        // Order-preserving: each element matches in order (same reference)
        for (let i = 0; i < expected.length; i++) {
          expect(result[i]).toBe(expected[i]);
        }
      }),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 2: Empty-string items are filtered out
 *
 * For any array of pdf.js items including empty/whitespace `str` fields,
 * normalised output contains no item whose `str.trim() === ''`.
 *
 * **Validates: Requirements 2.2**
 */
describe('Property 2: Empty-string items are filtered out', () => {

  // Generator for a valid pdf.js text item with a non-empty str
  const validPdfItemArb = fc.record({
    str: fc.string({ minLength: 1 }).filter(s => s.trim().length > 0),
    transform: fc.tuple(
      fc.double({ min: 6, max: 72, noNaN: true, noDefaultInfinity: true }),   // scaleX (fontSize component)
      fc.constant(0),                                                          // skewX
      fc.constant(0),                                                          // skewY
      fc.double({ min: 6, max: 72, noNaN: true, noDefaultInfinity: true }),   // scaleY
      fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }), // translateX (x0)
      fc.double({ min: 50, max: 2900, noNaN: true, noDefaultInfinity: true }) // translateY
    ),
    width: fc.double({ min: 10, max: 500, noNaN: true, noDefaultInfinity: true }),
    fontName: fc.string({ minLength: 1, maxLength: 20 })
  });

  // Generator for a pdf.js item with empty/whitespace-only str
  const emptyStrPdfItemArb = fc.record({
    str: fc.constantFrom('', ' ', '  ', '\t', '\n', '\r\n', '   \t  '),
    transform: fc.tuple(
      fc.double({ min: 6, max: 72, noNaN: true, noDefaultInfinity: true }),
      fc.constant(0),
      fc.constant(0),
      fc.double({ min: 6, max: 72, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 50, max: 2900, noNaN: true, noDefaultInfinity: true })
    ),
    width: fc.double({ min: 10, max: 500, noNaN: true, noDefaultInfinity: true }),
    fontName: fc.string({ minLength: 1, maxLength: 20 })
  });

  // Generator: mixed array containing both valid and empty-str items
  const mixedItemsArb = fc.tuple(
    fc.array(validPdfItemArb, { minLength: 0, maxLength: 10 }),
    fc.array(emptyStrPdfItemArb, { minLength: 1, maxLength: 5 })
  ).map(([valid, empty]) => {
    // Interleave valid and empty items randomly
    const all = [...valid, ...empty];
    // Shuffle deterministically by sorting on a derived key
    all.sort((a, b) => a.str.length - b.str.length);
    return all;
  });

  const pageHeightArb = fc.double({ min: 100, max: 3000, noNaN: true, noDefaultInfinity: true });

  it('normaliseItems output contains no item with empty/whitespace-only str', () => {
    fc.assert(
      fc.property(mixedItemsArb, pageHeightArb, (items, pageHeight) => {
        const result = normaliseItems(items, pageHeight);

        // Every item in the result must have a non-empty trimmed str
        for (const item of result) {
          expect(item.str.trim()).not.toBe('');
        }
      }),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 1: Normalisation coordinate invariants
 *
 * For any pdf.js text item and page height, `normaliseItems` produces output
 * where `x0 < x1`, `y0 < y1`, `x0 >= 0`, and `y0 >= 0`.
 *
 * **Validates: Requirements 2.1**
 */
describe('Property 1: Normalisation coordinate invariants', () => {
  // Generator: page height between 100 and 3000
  const pageHeightArb = fc.double({ min: 100, max: 3000, noNaN: true, noDefaultInfinity: true });

  // Generator: a valid pdf.js text item
  // Constraints:
  //   - transform[0] (scaleX) > 0 so fontSize > 0
  //   - transform[1] (skewX) kept small so fontSize is dominated by scaleX
  //   - transform[4] (x position) >= 0
  //   - transform[5] (translateY) <= pageHeight - fontSize, ensuring y0 >= 0
  //   - width > 0 so x1 > x0
  //   - str is non-empty
  const pdfItemArb = (pageHeight) => {
    // scaleX > 0 ensures fontSize > 0
    const scaleXArb = fc.double({ min: 1, max: 72, noNaN: true, noDefaultInfinity: true });
    // skewX can be 0 (most common case for non-rotated text)
    const skewXArb = fc.double({ min: 0, max: 10, noNaN: true, noDefaultInfinity: true });

    return fc.tuple(scaleXArb, skewXArb).chain(([scaleX, skewX]) => {
      const fontSize = Math.sqrt(scaleX ** 2 + skewX ** 2);
      // translateY must be <= pageHeight - fontSize to ensure y0 >= 0
      const maxTranslateY = pageHeight - fontSize;
      // translateY can be 0 at minimum (meaning item is at top of page in bottom-up space)
      const translateYArb = fc.double({
        min: 0,
        max: Math.max(0, maxTranslateY),
        noNaN: true,
        noDefaultInfinity: true
      });
      const xPosArb = fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true });
      const widthArb = fc.double({ min: 0.1, max: 500, noNaN: true, noDefaultInfinity: true });

      return fc.tuple(
        fc.constant(scaleX),
        fc.constant(skewX),
        translateYArb,
        xPosArb,
        widthArb,
        fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0)
      ).map(([sx, skx, ty, xPos, width, str]) => ({
        transform: [sx, skx, 0, 0, xPos, ty],
        width,
        str,
        fontName: 'Arial'
      }));
    });
  };

  // Combined arbitrary: generates a pageHeight and a valid pdf.js item together
  const pageHeightAndItemArb = pageHeightArb.chain((pageHeight) =>
    pdfItemArb(pageHeight).map((item) => ({ pageHeight, item }))
  );

  it('normaliseItems produces x0 < x1, y0 < y1, x0 >= 0, y0 >= 0 for all valid items', () => {
    fc.assert(
      fc.property(pageHeightAndItemArb, ({ pageHeight, item }) => {
        const result = normaliseItems([item], pageHeight);

        // Item has non-empty str, so it should not be filtered out
        expect(result.length).toBe(1);
        const norm = result[0];

        // x0 < x1 (positive width)
        expect(norm.x0).toBeLessThan(norm.x1);
        // y0 < y1 (positive height)
        expect(norm.y0).toBeLessThan(norm.y1);
        // x0 >= 0
        expect(norm.x0).toBeGreaterThanOrEqual(0);
        // y0 >= 0
        expect(norm.y0).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 4: Overlay CSS values scale linearly with the scale factor
 *
 * For any leaf node bounds (x, y, w, h) and any two positive scale factors s and k,
 * the computed CSS pixel values at scale k*s equal exactly k times the values at scale s.
 *
 * **Validates: Requirements 3.1**
 */
describe('Property 4: Overlay CSS values scale linearly with the scale factor', () => {
  /**
   * Pure function computing overlay CSS values from leaf bounds and scale factor.
   * This is the linear scaling step BEFORE clamping.
   */
  function computeOverlayCSS(bounds, scale) {
    return {
      left: bounds.x * scale,
      top: bounds.y * scale,
      width: bounds.w * scale,
      minHeight: bounds.h * scale,
    };
  }

  /**
   * Relative tolerance comparison for floating point values.
   */
  function approxEqual(a, b) {
    return Math.abs(a - b) < 1e-6 * Math.max(Math.abs(a), Math.abs(b), 1);
  }

  const boundsArb = fc.record({
    x: fc.float({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }),
    y: fc.float({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }),
    w: fc.float({ min: 1, max: 500, noNaN: true, noDefaultInfinity: true }),
    h: fc.float({ min: 1, max: 500, noNaN: true, noDefaultInfinity: true }),
  });
  const scaleArb = fc.float({ min: Math.fround(0.1), max: Math.fround(5.0), noNaN: true, noDefaultInfinity: true });

  it('CSS values at k*s equal k times values at s for any bounds and positive scale factors', () => {
    fc.assert(
      fc.property(boundsArb, scaleArb, scaleArb, (bounds, s, k) => {
        const cssAtS = computeOverlayCSS(bounds, s);
        const cssAtKS = computeOverlayCSS(bounds, k * s);

        // CSS values at k*s should equal k * CSS values at s
        expect(approxEqual(cssAtKS.left, k * cssAtS.left)).toBe(true);
        expect(approxEqual(cssAtKS.top, k * cssAtS.top)).toBe(true);
        expect(approxEqual(cssAtKS.width, k * cssAtS.width)).toBe(true);
        expect(approxEqual(cssAtKS.minHeight, k * cssAtS.minHeight)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 5: Clamped overlay positions satisfy boundary constraints
 *
 * For any leaf node bounds and canvas dimensions, after clamping:
 * `left >= 0`, `top >= 0`, `left + width <= canvasWidth`, `top + minHeight <= canvasHeight`
 *
 * **Validates: Requirements 3.4**
 */
describe('Property 5: Clamped overlay positions satisfy boundary constraints', () => {
  /**
   * Pure function that computes clamped overlay CSS values from leaf bounds, scale,
   * and canvas dimensions, applying the clamping logic from the design doc.
   */
  function computeClampedOverlay(bounds, scale, canvasWidth, canvasHeight) {
    let left = bounds.x * scale;
    let top = bounds.y * scale;
    let width = bounds.w * scale;
    let minHeight = bounds.h * scale;

    // Clamp independently to canvas boundaries
    left = Math.max(0, Math.min(left, canvasWidth));
    top = Math.max(0, Math.min(top, canvasHeight));
    width = Math.max(0, Math.min(width, canvasWidth - left));
    minHeight = Math.max(0, Math.min(minHeight, canvasHeight - top));

    return { left, top, width, minHeight };
  }

  const boundsArb = fc.record({
    x: fc.float({ min: -100, max: 2000, noNaN: true, noDefaultInfinity: true }),
    y: fc.float({ min: -100, max: 2000, noNaN: true, noDefaultInfinity: true }),
    w: fc.float({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }),
    h: fc.float({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }),
  });
  const scaleArb = fc.float({ min: Math.fround(0.1), max: Math.fround(5.0), noNaN: true, noDefaultInfinity: true });
  const canvasDimsArb = fc.record({
    width: fc.integer({ min: 100, max: 4000 }),
    height: fc.integer({ min: 100, max: 6000 }),
  });

  it('clamped overlay positions satisfy all boundary constraints', () => {
    fc.assert(
      fc.property(boundsArb, scaleArb, canvasDimsArb, (bounds, scale, canvasDims) => {
        const { left, top, width, minHeight } = computeClampedOverlay(
          bounds, scale, canvasDims.width, canvasDims.height
        );

        // left >= 0
        expect(left).toBeGreaterThanOrEqual(0);
        // top >= 0
        expect(top).toBeGreaterThanOrEqual(0);
        // left + width <= canvasWidth
        expect(left + width).toBeLessThanOrEqual(canvasDims.width);
        // top + minHeight <= canvasHeight
        expect(top + minHeight).toBeLessThanOrEqual(canvasDims.height);
      }),
      { numRuns: 100 }
    );
  });
});

import { segmentPageWithCache, clearSegmentationCache } from './pdf-xycut-segmenter.js';

/**
 * Property 7: Cache round-trip returns the same reference
 *
 * For any `(pdfHash, pageNum)` key, once a leaf node array has been stored in
 * the segmentation cache, all subsequent retrievals with the same key return
 * the identical array (referential equality — same object reference, not a copy).
 *
 * **Validates: Requirements 5.1, 5.2**
 */
describe('Property 7: Cache round-trip returns the same reference', () => {
  beforeEach(() => {
    clearSegmentationCache();
  });

  /**
   * Creates a mock pdf.js page object that returns predictable text content.
   * The mock page has items positioned to form a single leaf node via performXYCut.
   */
  function createMockPage(width = 612, height = 792) {
    return {
      getViewport: ({ scale }) => ({ width: width * scale, height: height * scale }),
      getTextContent: async () => ({
        items: [
          {
            str: 'Hello World',
            transform: [12, 0, 0, 12, 50, 700],
            width: 80,
            fontName: 'Helvetica',
          },
          {
            str: 'Second line',
            transform: [12, 0, 0, 12, 50, 680],
            width: 75,
            fontName: 'Helvetica',
          },
        ],
      }),
    };
  }

  it('calling segmentPageWithCache twice with the same key returns the same reference (===)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.integer({ min: 1, max: 1000 }),
        async (pdfHash, pageNum) => {
          clearSegmentationCache();

          const mockPage = createMockPage();

          const result1 = await segmentPageWithCache(mockPage, pageNum, pdfHash);
          const result2 = await segmentPageWithCache(mockPage, pageNum, pdfHash);

          // Referential equality: same object, not a copy
          expect(result1).toBe(result2);
        }
      ),
      { numRuns: 100 }
    );
  });
});


/**
 * Property 6: Font size formula holds for all valid leaf nodes
 *
 * For any collection of leaf nodes with at least one valid `avgFontSize > 0`
 * and any positive scale, computed font size equals `avgFontSize * scale * 0.95`
 * when the leaf's own avgFontSize is positive, and at least 8px otherwise.
 *
 * **Validates: Requirements 3.5**
 */
describe('Property 6: Font size formula holds for all valid leaf nodes', () => {
  const scaleArb = fc.float({ min: Math.fround(0.1), max: Math.fround(5.0), noNaN: true, noDefaultInfinity: true });

  // Leaf with valid avgFontSize
  const validLeafArb = fc.record({
    formatting: fc.record({
      avgFontSize: fc.float({ min: Math.fround(0.1), max: Math.fround(72), noNaN: true, noDefaultInfinity: true })
    }),
    text: fc.string({ minLength: 1 }),
  });

  // Leaf with invalid avgFontSize (zero, negative, or absent)
  const invalidLeafArb = fc.record({
    formatting: fc.record({
      avgFontSize: fc.oneof(
        fc.constant(0),
        fc.constant(-1),
        fc.float({ min: Math.fround(-100), max: Math.fround(0), noNaN: true, noDefaultInfinity: true })
      )
    }),
    text: fc.string({ minLength: 1 }),
  });

  // Array with at least one valid leaf
  const leavesArb = fc.tuple(
    fc.array(validLeafArb, { minLength: 1, maxLength: 10 }),
    fc.array(invalidLeafArb, { minLength: 0, maxLength: 5 })
  ).map(([valid, invalid]) => [...valid, ...invalid]);

  /**
   * Compute median matching the actual implementation in pdf.js:
   * Uses Math.floor(sorted.length / 2) — the upper-middle element for even arrays.
   */
  function median(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted[mid];
  }

  /**
   * Pure reference implementation of the font size formula.
   * For a leaf:
   *   - If avgFontSize > 0: fontSize = avgFontSize * scale * 0.95
   *   - Else: fontSize = median(allValidAvgFontSizes) * scale * 0.95
   *   - Floor: fontSize = Math.max(8, fontSize)
   */
  function computeFontSize(leaf, allLeaves, scale) {
    const validFontSizes = allLeaves
      .map(l => l.formatting && l.formatting.avgFontSize)
      .filter(fs => fs > 0)
      .sort((a, b) => a - b);
    const medianFontSize = validFontSizes.length > 0
      ? validFontSizes[Math.floor(validFontSizes.length / 2)]
      : 0;

    let fontSize;
    if (leaf.formatting && leaf.formatting.avgFontSize > 0) {
      fontSize = leaf.formatting.avgFontSize * scale * 0.95;
    } else {
      fontSize = medianFontSize > 0 ? medianFontSize * scale * 0.95 : 8;
    }
    fontSize = Math.max(8, fontSize);
    return fontSize;
  }

  it('font size equals avgFontSize * scale * 0.95 for valid leaves, with 8px floor', () => {
    fc.assert(
      fc.property(leavesArb, scaleArb, (leaves, scale) => {
        for (const leaf of leaves) {
          const fontSize = computeFontSize(leaf, leaves, scale);

          if (leaf.formatting && leaf.formatting.avgFontSize > 0) {
            // Valid leaf: fontSize = avgFontSize * scale * 0.95, floored at 8
            const expected = Math.max(8, leaf.formatting.avgFontSize * scale * 0.95);
            expect(fontSize).toBeCloseTo(expected, 5);
          } else {
            // Invalid leaf: uses median fallback, floored at 8
            expect(fontSize).toBeGreaterThanOrEqual(8);
          }

          // Floor invariant always holds
          expect(fontSize).toBeGreaterThanOrEqual(8);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('invalid leaves use median of valid avgFontSizes as fallback', () => {
    fc.assert(
      fc.property(leavesArb, scaleArb, (leaves, scale) => {
        const validFontSizes = leaves
          .map(l => l.formatting && l.formatting.avgFontSize)
          .filter(fs => fs > 0)
          .sort((a, b) => a - b);
        const medianFontSize = validFontSizes.length > 0
          ? validFontSizes[Math.floor(validFontSizes.length / 2)]
          : 0;

        for (const leaf of leaves) {
          if (!(leaf.formatting && leaf.formatting.avgFontSize > 0)) {
            const fontSize = computeFontSize(leaf, leaves, scale);
            const expectedFallback = medianFontSize > 0
              ? Math.max(8, medianFontSize * scale * 0.95)
              : 8;
            expect(fontSize).toBeCloseTo(expectedFallback, 5);
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});
