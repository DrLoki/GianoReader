/**
 * PDF XY-Cut Segmenter
 * Encapsulates all XY-Cut integration logic for the PDF Original View overlay pipeline.
 * Converts pdf.js text items to the format expected by performXYCut, runs segmentation,
 * caches results, and provides depth-first leaf node collection.
 */

import { performXYCut } from './xycut.js';

// ── Module-level cache ──────────────────────────────────────────────────────
// Map keyed by "${pdfHash}:${pageNum}" → LeafNode[]
const _cache = new Map();

/**
 * Converts pdf.js raw text items to the { x0, y0, x1, y1, str, fontSize, fontName }
 * format expected by performXYCut (top-down Y axis).
 * Filters out items whose str.trim() is empty.
 *
 * Coordinate conversion (bottom-left → top-down):
 *   fontSize = Math.sqrt(transform[0]**2 + transform[1]**2)
 *   x0 = transform[4]
 *   y1 = pageHeight − transform[5]          // bottom edge in top-down space
 *   y0 = y1 − fontSize                      // top edge
 *   x1 = x0 + item.width
 *
 * @param {object[]} pdfItems  - items from page.getTextContent()
 * @param {number}   pageHeight - defaultViewport.height at scale 1
 * @returns {object[]}
 */
export function normaliseItems(pdfItems, pageHeight) {
  const result = [];

  for (const item of pdfItems) {
    // Filter out items with empty or whitespace-only str
    if (!item.str || item.str.trim() === '') {
      continue;
    }

    const transform = item.transform;
    const fontSize = Math.sqrt(transform[0] ** 2 + transform[1] ** 2);
    const x0 = transform[4];
    const y1 = pageHeight - transform[5]; // bottom edge in top-down space
    const y0 = y1 - fontSize;             // top edge
    const x1 = x0 + item.width;

    result.push({
      x0,
      y0,
      x1,
      y1,
      str: item.str,
      fontSize,
      fontName: item.fontName,
    });
  }

  return result;
}

/**
 * Depth-first traversal of the XY-Cut result tree, collecting all leaf nodes in order.
 * A leaf node has type === 'leaf'.
 * Non-leaf nodes have a `children` array.
 *
 * @param {object} root  - root node returned by performXYCut
 * @returns {object[]}   - ordered array of leaf nodes
 */
export function collectLeafNodes(root) {
  const leaves = [];

  function traverse(node) {
    if (node.type === 'leaf') {
      leaves.push(node);
      return;
    }
    if (node.children) {
      for (const child of node.children) {
        traverse(child);
      }
    }
  }

  traverse(root);
  return leaves;
}

/**
 * Async: extracts text from one page, normalises items, calls performXYCut,
 * and returns the ordered list of leaf nodes.
 * Throws if performXYCut throws — caller is responsible for the fallback.
 *
 * performXYCut is called with: { thresholdX: 10, thresholdY: 5, priority: 'X', minWidth: 20, minHeight: 10 }
 * pageBounds: { x: 0, y: 0, w: defaultViewport.width, h: defaultViewport.height }
 *
 * @param {PDFPageProxy} page - pdf.js page object with getTextContent() and getViewport()
 * @param {{ thresholdX?, thresholdY?, priority?, minWidth?, minHeight? }} [options]
 * @returns {Promise<object[]>}
 */
export async function segmentPage(page, options) {
  const viewport = page.getViewport({ scale: 1 });
  const pageHeight = viewport.height;
  const pageWidth = viewport.width;

  const textContent = await page.getTextContent();
  const items = normaliseItems(textContent.items, pageHeight);

  const pageBounds = { x: 0, y: 0, w: pageWidth, h: pageHeight };

  const defaultOptions = {
    thresholdX: 10,
    thresholdY: 5,
    priority: 'X',
    minWidth: 20,
    minHeight: 10,
  };

  const mergedOptions = { ...defaultOptions, ...options };

  const { root } = performXYCut(items, pageBounds, mergedOptions);
  return collectLeafNodes(root);
}

/**
 * Cache-aware wrapper around segmentPage.
 * On a cache hit, returns the cached leaf node array directly (same reference).
 * On a miss, calls segmentPage and stores the result.
 * Does NOT cache results from the fallback path.
 * Does NOT throw — catches errors from segmentPage, logs a warning, and returns [].
 *
 * @param {PDFPageProxy} page
 * @param {number}       pageNum   - 1-based page number
 * @param {string}       pdfHash   - unique identifier for the current PDF document
 * @param {object}       [options]
 * @returns {Promise<object[]>}
 */
export async function segmentPageWithCache(page, pageNum, pdfHash, options) {
  const cacheKey = `${pdfHash}:${pageNum}`;

  if (_cache.has(cacheKey)) {
    return _cache.get(cacheKey);
  }

  try {
    const leaves = await segmentPage(page, options);
    _cache.set(cacheKey, leaves);
    return leaves;
  } catch (err) {
    console.warn(`[pdf-xycut-segmenter] segmentPage failed for page ${pageNum}:`, err);
    return [];
  }
}

/**
 * Clears the entire in-memory segmentation cache.
 * Called by main.js when a new PDF document is opened.
 */
export function clearSegmentationCache() {
  _cache.clear();
}
