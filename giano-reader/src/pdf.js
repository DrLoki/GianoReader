/**
 * PDF module for Giano Reader.
 * Encapsulates PDF loading, validation, text extraction, canvas rendering,
 * and navigation logic using pdfjs-dist.
 */

import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { t } from './i18n.js';
import { segmentPageWithCache } from './pdf-xycut-segmenter.js';

// Configure the pdf.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

/**
 * Checks whether a file size exceeds the configured maximum.
 * @param {number} size - File size in bytes
 * @param {number} maxFileSizeMB - Maximum allowed size in megabytes
 * @returns {boolean} true if the file is within the allowed size, false if it exceeds the limit
 */
export function checkFileSize(size, maxFileSizeMB) {
  return size <= maxFileSizeMB * 1024 * 1024;
}

/**
 * Validates that the buffer starts with the PDF magic bytes (%PDF-).
 * @param {ArrayBuffer} buffer - Raw file bytes
 * @returns {boolean} true if valid PDF magic bytes are present
 */
export function validateMagicBytes(buffer) {
  if (!buffer || buffer.byteLength < 5) return false;
  const header = new Uint8Array(buffer, 0, 5);
  const magic = String.fromCharCode(header[0], header[1], header[2], header[3], header[4]);
  return magic === '%PDF-';
}

/**
 * Resolves the document title from PDF metadata, falling back to filename.
 * @param {object} metadata - PDF metadata info object (from getMetadata())
 * @param {string} [filename] - Fallback filename (with extension)
 * @returns {string} Resolved title
 */
export function resolveTitle(metadata, filename = '') {
  const title = metadata?.info?.Title;
  if (title && typeof title === 'string' && title.trim().length > 0) {
    return title.trim();
  }
  // Remove the last extension from filename
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex > 0) {
    return filename.substring(0, dotIndex);
  }
  return filename || 'Untitled';
}

/**
 * Validates whether the PDF has extractable text content.
 * Analyzes the first 5 pages (or all pages if fewer than 5).
 * @param {PDFDocumentProxy} doc - The PDF document proxy
 * @returns {Promise<'ok'|'blocked'>} 'ok' if at least one page has text, 'blocked' if all pages are empty
 */
export async function validateTextContent(doc) {
  const pagesToCheck = Math.min(5, doc.numPages);

  for (let i = 1; i <= pagesToCheck; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();
    const text = textContent.items.map(item => item.str).join('');

    if (text.replace(/\s/g, '').length > 0) {
      return 'ok';
    }
  }

  return 'blocked';
}

/**
 * Manages navigation state for a loaded PDF document.
 * Supports dual-mode navigation: chapter-based (when outline exists) or page-based (fallback).
 *
 * Use the static `create()` factory method to instantiate, since destination resolution is async.
 */
export class PdfNavigator {
  /**
   * Static async factory that resolves all outline destinations and returns a ready-to-use PdfNavigator.
   * @param {PDFDocumentProxy} doc - The PDF document proxy (has `numPages`, `getDestination`, `getPageIndex`)
   * @param {Array|null} outline - Result of `doc.getOutline()` — null, empty array, or array of outline entries
   * @returns {Promise<PdfNavigator>}
   */
  static async create(doc, outline) {
    const nav = new PdfNavigator(doc, outline);
    await nav._resolveDestinations();
    return nav;
  }

  /**
   * @param {PDFDocumentProxy} doc
   * @param {Array|null} outline
   */
  constructor(doc, outline) {
    this._doc = doc;
    this._outline = outline;
    this._numPages = doc.numPages;
    this._currentIndex = 0;

    // Determine mode: 'chapter' if outline is a non-empty array, 'page' otherwise
    this._mode = (Array.isArray(outline) && outline.length > 0) ? 'chapter' : 'page';

    // Chapter ranges will be populated by _resolveDestinations() in chapter mode
    // Each entry: { title: string, startPage: number, endPage: number } (1-based)
    this._chapters = [];
  }

  /**
   * Resolves outline destinations to page numbers and computes contiguous chapter ranges.
   * Called internally by the static factory.
   * @private
   */
  async _resolveDestinations() {
    if (this._mode !== 'chapter') return;

    const entries = [];

    for (const entry of this._outline) {
      try {
        const pageNum = await this._resolveEntryPage(entry);
        if (pageNum !== null) {
          entries.push({ title: entry.title || '', startPage: pageNum });
        }
      } catch (e) {
        // Skip entries whose destination can't be resolved
        console.warn(`PdfNavigator: could not resolve outline entry "${entry.title}":`, e);
      }
    }

    // If no entries could be resolved, fall back to page mode
    if (entries.length === 0) {
      this._mode = 'page';
      return;
    }

    // Sort entries by start page (in case outline is not ordered)
    entries.sort((a, b) => a.startPage - b.startPage);

    // Deduplicate entries that point to the same page (keep first occurrence)
    const deduped = [];
    for (const entry of entries) {
      if (deduped.length === 0 || deduped[deduped.length - 1].startPage !== entry.startPage) {
        deduped.push(entry);
      }
    }

    // Compute contiguous ranges covering all pages 1..numPages
    this._chapters = deduped.map((entry, i) => {
      const startPage = i === 0 ? 1 : entry.startPage;
      const endPage = i < deduped.length - 1 ? deduped[i + 1].startPage - 1 : this._numPages;
      return { title: entry.title, startPage, endPage };
    });

    // Ensure first chapter starts at page 1
    if (this._chapters.length > 0 && this._chapters[0].startPage > 1) {
      this._chapters[0].startPage = 1;
    }
  }

  /**
   * Resolves an outline entry's destination to a 1-based page number.
   * @param {object} entry - Outline entry with `dest` property (string or array)
   * @returns {Promise<number|null>} 1-based page number, or null if unresolvable
   * @private
   */
  async _resolveEntryPage(entry) {
    let dest = entry.dest;

    // If dest is a named destination (string), resolve it to an explicit destination array
    if (typeof dest === 'string') {
      dest = await this._doc.getDestination(dest);
    }

    if (!Array.isArray(dest) || dest.length === 0) {
      return null;
    }

    // The first element of the destination array is the page reference
    const ref = dest[0];
    const pageIndex = await this._doc.getPageIndex(ref); // 0-based
    return pageIndex + 1; // convert to 1-based
  }

  /** @returns {'chapter'|'page'} Current navigation mode */
  get mode() {
    return this._mode;
  }

  /** @returns {number} Total number of navigation units (chapters or pages) */
  get totalUnits() {
    return this._mode === 'chapter' ? this._chapters.length : this._numPages;
  }

  /** @returns {number} 0-based index of the current navigation unit */
  get currentIndex() {
    return this._currentIndex;
  }

  /**
   * Returns the label for the current navigation unit.
   * In chapter mode: the chapter title.
   * In page mode: "Pag. N / Total".
   * @returns {string}
   */
  get currentLabel() {
    if (this._mode === 'chapter') {
      return this._chapters[this._currentIndex].title;
    }
    return 'Pag. ' + (this._currentIndex + 1) + ' / ' + this.totalUnits;
  }

  /**
   * Returns the page range for the current navigation unit.
   * @returns {{ start: number, end: number }} 1-based page numbers
   */
  get pageRange() {
    if (this._mode === 'chapter') {
      const ch = this._chapters[this._currentIndex];
      return { start: ch.startPage, end: ch.endPage };
    }
    // In page mode, the range is a single page
    const page = this._currentIndex + 1;
    return { start: page, end: page };
  }

  /**
   * Navigate to a specific unit by index.
   * @param {number} index - 0-based unit index
   * @returns {boolean} true if navigation succeeded, false if index is out of bounds
   */
  goTo(index) {
    if (index < 0 || index >= this.totalUnits) {
      return false;
    }
    this._currentIndex = index;
    return true;
  }

  /**
   * Advance to the next navigation unit.
   * @returns {boolean} true if advanced, false if already at the end
   */
  next() {
    if (this._currentIndex >= this.totalUnits - 1) {
      return false;
    }
    this._currentIndex++;
    return true;
  }

  /**
   * Go to the previous navigation unit.
   * @returns {boolean} true if moved back, false if already at the start
   */
  prev() {
    if (this._currentIndex <= 0) {
      return false;
    }
    this._currentIndex--;
    return true;
  }

  /**
   * Returns TOC entries for the sidebar.
   * In chapter mode: returns entries from the outline with proper nesting levels.
   * In page mode: returns empty array (no TOC available).
   * @returns {Array<{ label: string, index: number, level: number }>}
   */
  getTocEntries() {
    if (this._mode !== 'chapter') {
      return [];
    }

    const entries = [];
    const topLevelOutline = this._outline || [];

    for (let i = 0; i < topLevelOutline.length; i++) {
      // Only top-level entries that resolved to chapters are navigation units.
      // We need to find the chapter index for this outline entry.
      // Since _chapters is built from resolved top-level entries (sorted/deduped),
      // we use the index within _chapters. The outline order may differ from _chapters
      // order if entries were sorted by page, but typically they align.
      const chapterIndex = Math.min(i, this._chapters.length - 1);
      this._collectTocEntries(topLevelOutline[i], chapterIndex, 0, entries);
    }

    return entries;
  }

  /**
   * Recursively collects TOC entries from an outline node and its children.
   * @param {object} node - Outline entry with title, dest, and items
   * @param {number} parentIndex - The navigation unit index (chapter index) for this entry
   * @param {number} level - Nesting level (0 = top-level)
   * @param {Array} result - Accumulator array
   * @private
   */
  _collectTocEntries(node, parentIndex, level, result) {
    result.push({
      label: node.title || '',
      index: parentIndex,
      level,
    });

    if (Array.isArray(node.items)) {
      for (const child of node.items) {
        this._collectTocEntries(child, parentIndex, level + 1, result);
      }
    }
  }

  /**
   * Returns tick positions for the progress bar as an array of numbers in [0, 1].
   * In chapter mode: one tick per chapter, evenly spaced.
   * In page mode with P ≤ 20: one tick per page, evenly spaced.
   * In page mode with P > 20: one tick every 10 pages.
   * @returns {number[]}
   */
  getTickPositions() {
    const total = this.totalUnits;

    if (this._mode === 'chapter') {
      // One tick per chapter, evenly spaced
      const positions = [];
      for (let i = 0; i < total; i++) {
        positions.push(i / Math.max(1, total - 1));
      }
      return positions;
    }

    // Page mode
    const P = this._numPages;

    if (P <= 20) {
      // One tick per page, evenly spaced
      const positions = [];
      for (let i = 0; i < P; i++) {
        positions.push(i / Math.max(1, P - 1));
      }
      return positions;
    }

    // P > 20: one tick every 10 pages
    const tickCount = Math.floor(P / 10);
    const positions = [];
    for (let i = 0; i < tickCount; i++) {
      positions.push((i * 10) / P);
    }
    return positions;
  }

  /**
   * Returns the first page number (1-based) for a given navigation unit index.
   * In chapter mode: returns the startPage of the chapter at index idx.
   * In page mode: returns idx + 1 (1-based page number).
   * Returns null for invalid indices.
   * @param {number} idx - 0-based unit index
   * @returns {number|null}
   */
  getPageForUnit(idx) {
    if (idx < 0 || idx >= this.totalUnits) {
      return null;
    }

    if (this._mode === 'chapter') {
      return this._chapters[idx].startPage;
    }

    return idx + 1;
  }
}

// ─── Text Extraction ─────────────────────────────────────────────────────────

/**
 * Detects columns in a set of text items by analyzing X-position distribution.
 * Uses a gap-based heuristic: if there's a significant horizontal gap in the
 * middle region of the page, the page is likely multi-column.
 *
 * @param {Array<{str: string, x: number, y: number, height: number}>} items - Text items
 * @returns {{columns: Array<Array<{str: string, x: number, y: number, height: number}>>, splitX: number|null}} Object with columns array and the split X coordinate (null if single column)
 */
export function detectColumns(items) {
  if (items.length < 4) return { columns: [items], splitX: null };

  // Determine page X extent
  let minX = Infinity, maxX = -Infinity;
  for (const item of items) {
    if (item.x < minX) minX = item.x;
    if (item.x > maxX) maxX = item.x;
  }

  const pageWidth = maxX - minX;
  if (pageWidth < 50) return { columns: [items], splitX: null };

  // Group items into Y-rows (lines) first, then check if lines consistently
  // have a gap in the middle. This is more robust than a raw X histogram.
  const sortedByY = [...items].sort((a, b) => b.y - a.y);

  const yTolerance = 2;
  const lines = [];
  let currentLine = [sortedByY[0]];
  for (let i = 1; i < sortedByY.length; i++) {
    if (Math.abs(sortedByY[i].y - currentLine[0].y) <= yTolerance) {
      currentLine.push(sortedByY[i]);
    } else {
      lines.push(currentLine);
      currentLine = [sortedByY[i]];
    }
  }
  lines.push(currentLine);

  const midRegionStart = minX + pageWidth * 0.2;
  const midRegionEnd = minX + pageWidth * 0.8;

  const gapPositions = [];

  for (const line of lines) {
    if (line.length < 2) continue;

    const sorted = [...line].sort((a, b) => a.x - b.x);

    let maxGap = 0;
    let maxGapX = 0;
    for (let i = 1; i < sorted.length; i++) {
      const gapStart = sorted[i - 1].x;
      const gapEnd = sorted[i].x;
      const gapMid = (gapStart + gapEnd) / 2;
      const gap = gapEnd - gapStart;

      if (gap > maxGap && gapMid > midRegionStart && gapMid < midRegionEnd) {
        maxGap = gap;
        maxGapX = gapMid;
      }
    }

    if (maxGap > pageWidth * 0.15) {
      gapPositions.push(maxGapX);
    }
  }

  const multiItemLines = lines.filter(l => l.length >= 2).length;
  if (multiItemLines === 0 || gapPositions.length < multiItemLines * 0.5) {
    return { columns: [items], splitX: null };
  }

  gapPositions.sort((a, b) => a - b);
  const splitX = gapPositions[Math.floor(gapPositions.length / 2)];

  const leftCol = [];
  const rightCol = [];
  for (const item of items) {
    if (item.x < splitX) {
      leftCol.push(item);
    } else {
      rightCol.push(item);
    }
  }

  const totalItems = items.length;
  const minColItems = totalItems * 0.15;
  if (leftCol.length < minColItems || rightCol.length < minColItems) {
    return { columns: [items], splitX: null };
  }

  return { columns: [leftCol, rightCol], splitX };
}

/**
 * Sorts text items by Y position descending (top of page first in PDF coords),
 * then by X position ascending (left to right).
 * @param {Array<{str: string, x: number, y: number, height: number}>} items - Extracted text items
 * @returns {Array<{str: string, x: number, y: number, height: number}>} Sorted items (new array)
 */
export function sortTextItems(items) {
  return [...items].sort((a, b) => {
    if (b.y !== a.y) return b.y - a.y; // Y descending (higher Y = higher on page)
    return a.x - b.x; // X ascending (left to right)
  });
}

/**
 * Groups sorted text items into lines based on Y-position proximity.
 * Items whose Y values are within the given tolerance belong to the same line.
 * @param {Array<{str: string, x: number, y: number, height: number}>} sortedItems - Items sorted by Y desc, X asc
 * @param {number} [tolerance=2] - Maximum Y difference (in px) for items to be on the same line
 * @returns {Array<Array<{str: string, x: number, y: number, height: number}>>} Array of lines, each line is an array of items
 */
export function groupIntoLines(sortedItems, tolerance = 2) {
  if (sortedItems.length === 0) return [];

  const lines = [];
  let currentLine = [sortedItems[0]];

  for (let i = 1; i < sortedItems.length; i++) {
    const item = sortedItems[i];
    const prevY = currentLine[0].y;

    if (Math.abs(item.y - prevY) <= tolerance) {
      currentLine.push(item);
    } else {
      lines.push(currentLine);
      currentLine = [item];
    }
  }
  lines.push(currentLine);

  return lines;
}

/**
 * Groups lines into paragraphs based on vertical gaps.
 * A new paragraph starts when the gap between consecutive lines exceeds
 * 1.5× the average font height.
 * @param {Array<Array<{str: string, x: number, y: number, height: number}>>} lines - Array of lines
 * @param {number} avgHeight - Average font height across all items
 * @returns {Array<Array<Array<{str: string, x: number, y: number, height: number}>>>} Array of paragraphs, each paragraph is an array of lines
 */
export function groupIntoParagraphs(lines, avgHeight) {
  if (lines.length === 0) return [];

  const threshold = 1.5 * avgHeight;
  const paragraphs = [];
  let currentParagraph = [lines[0]];

  for (let i = 1; i < lines.length; i++) {
    const prevLine = lines[i - 1];
    const currLine = lines[i];

    // Gap between bottom of previous line and top of current line
    // In PDF coords, Y decreases going down the page
    // Previous line Y is higher (larger), current line Y is lower (smaller)
    const prevLineY = prevLine[0].y;
    const prevLineHeight = prevLine[0].height;
    const currLineY = currLine[0].y;

    // The gap is the distance from the bottom of the previous line to the top of the current line
    const gap = (prevLineY - prevLineHeight) - currLineY;

    if (gap > threshold) {
      paragraphs.push(currentParagraph);
      currentParagraph = [currLine];
    } else {
      currentParagraph.push(currLine);
    }
  }
  paragraphs.push(currentParagraph);

  return paragraphs;
}

/**
 * Splits a long paragraph text at sentence boundaries.
 * Splits at `. `, `! `, or `? ` when the text exceeds maxLen characters.
 * @param {string} text - The paragraph text to potentially split
 * @param {number} [maxLen=4500] - Maximum length before splitting
 * @returns {string[]} Array of text chunks (single element if no split needed)
 */
export function splitLongParagraph(text, maxLen = 4500) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Find the last sentence boundary within maxLen
    const searchRegion = remaining.substring(0, maxLen);
    let splitIndex = -1;

    // Search for the last sentence-ending punctuation followed by a space
    const lastPeriod = searchRegion.lastIndexOf('. ');
    const lastExcl = searchRegion.lastIndexOf('! ');
    const lastQuestion = searchRegion.lastIndexOf('? ');

    splitIndex = Math.max(lastPeriod, lastExcl, lastQuestion);

    if (splitIndex === -1) {
      // No sentence boundary found — force split at maxLen
      chunks.push(remaining.substring(0, maxLen));
      remaining = remaining.substring(maxLen);
    } else {
      // Split after the punctuation + space (include the punctuation in the chunk)
      chunks.push(remaining.substring(0, splitIndex + 2).trimEnd());
      remaining = remaining.substring(splitIndex + 2).trimStart();
    }
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Extracts text from a single PDF page and returns an array of paragraph strings.
 * Uses heuristic grouping based on text item positions.
 * Detects multi-column layouts and processes each column separately (left to right).
 * @param {PDFPageProxy} page - A single PDF page proxy
 * @param {number} pageNum - 1-based page number (for fallback messages)
 * @param {string} [lang='en'] - Language code for localized messages
 * @returns {Promise<string[]>} Array of paragraph strings
 */
export async function extractPageText(page, pageNum, lang = 'en') {
  const content = await page.getTextContent();
  const items = content.items;

  // Filter out items with empty str (after trimming)
  const filtered = items
    .filter(item => item.str && item.str.trim().length > 0)
    .map(item => ({
      str: item.str,
      x: item.transform[4],
      y: item.transform[5],
      height: Math.sqrt(item.transform[0] ** 2 + item.transform[1] ** 2),
    }));

  // If no text items found, return localized notice
  if (filtered.length === 0) {
    return [t(lang, 'pdf_no_text_notice', { n: pageNum })];
  }

  // Detect columns — returns object with columns array and splitX
  const { columns } = detectColumns(filtered);

  // Process each column independently and concatenate results
  const result = [];
  for (const colItems of columns) {
    // Sort items by Y descending, then X ascending
    const sorted = sortTextItems(colItems);

    // Group into lines (items within 2px Y tolerance)
    const lines = groupIntoLines(sorted);

    // Compute average font height for this column
    const avgHeight = colItems.reduce((sum, item) => sum + item.height, 0) / colItems.length;

    // Group lines into paragraphs
    const paragraphGroups = groupIntoParagraphs(lines, avgHeight);

    // Join items within lines, then lines within paragraphs
    const paragraphs = paragraphGroups.map(paragraph => {
      const lineTexts = paragraph.map(line =>
        line.map(item => item.str).join(' ')
      );
      return lineTexts.join(' ');
    });

    // Split long paragraphs at sentence boundaries
    for (const para of paragraphs) {
      const chunks = splitLongParagraph(para);
      result.push(...chunks);
    }
  }

  return result;
}

// ─── Multi-Page Text Aggregation ─────────────────────────────────────────────

/**
 * Extracts text from all pages in a range and concatenates the paragraph arrays.
 * @param {PDFDocumentProxy} doc - The PDF document proxy
 * @param {{ start: number, end: number }} pageRange - 1-based inclusive page range
 * @param {string} [lang='en'] - Language code for localized messages
 * @returns {Promise<string[]>} Combined paragraph array from all pages
 */
export async function extractChapterText(doc, pageRange, lang = 'en') {
  const result = [];

  for (let n = pageRange.start; n <= pageRange.end; n++) {
    const page = await doc.getPage(n);
    const paragraphs = await extractPageText(page, n, lang);
    result.push(...paragraphs);
  }

  return result;
}

// ─── Canvas Rendering ─────────────────────────────────────────────────────────

/**
 * Computes the scale factor to fit a PDF page within a container width.
 * @param {number} pageWidth - Original page width
 * @param {number} pageHeight - Original page height
 * @param {number} containerWidth - Available container width
 * @returns {{ scale: number, canvasWidth: number, canvasHeight: number }}
 */
export function computeCanvasScale(pageWidth, pageHeight, containerWidth) {
  const scale = containerWidth / pageWidth;
  return {
    scale,
    canvasWidth: pageWidth * scale,
    canvasHeight: pageHeight * scale,
  };
}

/**
 * Renders PDF pages to canvas elements inside a container.
 * @param {PDFDocumentProxy} doc - The PDF document proxy
 * @param {number[]} pageNumbers - 1-based page numbers to render
 * @param {HTMLElement} container - DOM element to append canvases to
 * @returns {Promise<void>}
 */
export async function renderPdfCanvas(doc, pageNumbers, container) {
  // Clear previous canvases for memory management
  container.innerHTML = '';

  for (const n of pageNumbers) {
    const page = await doc.getPage(n);
    const defaultViewport = page.getViewport({ scale: 1 });
    const scale = container.clientWidth / defaultViewport.width;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.display = 'block';
    canvas.style.marginBottom = '8px';

    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    container.appendChild(canvas);
  }
}

// ─── PDF Translation Overlay Rendering ───────────────────────────────────────

/**
 * Renders PDF pages as canvas with positioned overlay placeholders for translated text.
 * Each paragraph gets an overlay div positioned at its bounding box, using the full
 * column width (not just the text width) for proper text reflow.
 *
 * @param {PDFDocumentProxy} doc - The PDF document proxy
 * @param {number[]} pageNumbers - 1-based page numbers to render
 * @param {HTMLElement} container - DOM element to append page wrappers to
 * @param {string} [pdfHash=''] - Unique identifier for the current PDF document (used for caching)
 * @param {string} [lang='en'] - UI language code for localised messages
 * @returns {Promise<Array<{pageNum: number, blocks: Array<{text: string, el: HTMLElement, fontSize: number, noTranslate?: boolean}>}>>}
 */
export async function renderPdfWithOverlayPlaceholders(doc, pageNumbers, container, pdfHash = '', lang = 'en') {
  container.innerHTML = '';
  const pages = [];

  for (const n of pageNumbers) {
    const page = await doc.getPage(n);
    const defaultViewport = page.getViewport({ scale: 1 });
    const containerWidth = container.clientWidth;
    const scale = containerWidth / defaultViewport.width;
    const viewport = page.getViewport({ scale });
    const pageHeight = defaultViewport.height;
    const pageWidth = defaultViewport.width;

    // Create wrapper
    const pageWrapper = document.createElement('div');
    pageWrapper.className = 'pdf-page-wrapper';
    pageWrapper.style.position = 'relative';
    pageWrapper.style.width = viewport.width + 'px';
    pageWrapper.style.height = viewport.height + 'px';
    pageWrapper.style.marginBottom = '8px';
    pageWrapper.style.overflow = 'hidden';

    // Render canvas
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.display = 'block';
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    pageWrapper.appendChild(canvas);

    // Canvas dimensions for clamping
    const canvasWidth = viewport.width;
    const canvasHeight = viewport.height;

    // Try XY-Cut segmentation path first
    let blockEls = [];
    let usedXYCut = false;

    try {
      const leaves = await segmentPageWithCache(page, n, pdfHash, {
        thresholdX: 10,
        thresholdY: 5,
        priority: 'X',
        minWidth: 20,
        minHeight: 10,
      });

      if (leaves.length > 0) {
        usedXYCut = true;

        // Compute median avgFontSize for fallback (only from leaves with valid avgFontSize)
        const validFontSizes = leaves
          .map(leaf => leaf.formatting && leaf.formatting.avgFontSize)
          .filter(fs => fs > 0)
          .sort((a, b) => a - b);
        const medianFontSize = validFontSizes.length > 0
          ? validFontSizes[Math.floor(validFontSizes.length / 2)]
          : 0;

        for (const leaf of leaves) {
          // Convert leaf bounds to CSS pixel space
          let left = leaf.bounds.x * scale;
          let top = leaf.bounds.y * scale;
          let width = leaf.bounds.w * scale;
          let minHeight = leaf.bounds.h * scale;

          // Clamp overlay positions to canvas boundaries independently
          left = Math.max(0, Math.min(left, canvasWidth));
          top = Math.max(0, Math.min(top, canvasHeight));
          width = Math.max(0, Math.min(width, canvasWidth - left));
          minHeight = Math.max(0, Math.min(minHeight, canvasHeight - top));

          // Compute font size
          let fontSize;
          if (leaf.formatting && leaf.formatting.avgFontSize > 0) {
            fontSize = leaf.formatting.avgFontSize * scale * 0.95;
          } else {
            fontSize = medianFontSize > 0 ? medianFontSize * scale * 0.95 : 8;
          }
          fontSize = Math.max(8, fontSize);

          const overlay = document.createElement('div');
          overlay.className = 'pdf-text-overlay pending';
          overlay.style.position = 'absolute';
          overlay.style.top = top + 'px';
          overlay.style.left = left + 'px';
          overlay.style.width = width + 'px';
          overlay.style.minHeight = minHeight + 'px';
          overlay.style.fontSize = fontSize + 'px';
          overlay.style.lineHeight = '1.15';
          overlay.style.overflow = 'hidden';
          overlay.style.boxSizing = 'border-box';
          overlay.style.padding = '1px 2px';
          overlay.style.backgroundColor = 'var(--surface, #1a1a2e)';
          overlay.style.color = 'var(--text, #e0e0e0)';
          overlay.textContent = '';

          pageWrapper.appendChild(overlay);
          blockEls.push({ text: leaf.text, el: overlay, fontSize });
        }
      } else {
        // segmentPageWithCache returned [] — check if there are text items on the page
        // If there are text items, fall back to detectColumns heuristic
        // If there are no text items, leave blocks empty (no overlays)
        const content = await page.getTextContent();
        const hasTextItems = content.items.some(item => item.str && item.str.trim().length > 0);

        if (!hasTextItems) {
          // No text items at all — render non-translatable message (Requirement 7.1)
          usedXYCut = true; // prevent fallback path from running
          const noTextDiv = document.createElement('div');
          noTextDiv.className = 'pdf-no-text-message';
          noTextDiv.textContent = t(lang, 'pdf_no_text_translate');
          noTextDiv.style.padding = '20px';
          noTextDiv.style.textAlign = 'center';
          noTextDiv.style.color = 'var(--text-muted, #888)';
          pageWrapper.appendChild(noTextDiv);
          blockEls.push({ text: '', el: noTextDiv, fontSize: 0, noTranslate: true });
        }
        // If hasTextItems is true, usedXYCut stays false — fallback runs below
      }
    } catch (err) {
      console.warn(`[PDF Overlay] XY-Cut segmentation failed for page ${n}, falling back to detectColumns:`, err);
      // usedXYCut stays false, fallback runs below
    }

    // Fallback path: use the existing detectColumns + line/block grouping heuristic
    if (!usedXYCut) {
      // Extract text items with width from pdf.js
      const content = await page.getTextContent();
      const filtered = content.items
        .filter(item => item.str && item.str.trim().length > 0)
        .map(item => ({
          str: item.str,
          x: item.transform[4],
          y: item.transform[5],
          height: Math.sqrt(item.transform[0] ** 2 + item.transform[1] ** 2),
          width: item.width, // pdf.js provides actual text width
        }));

      if (filtered.length === 0) {
        container.appendChild(pageWrapper);
        pages.push({ pageNum: n, blocks: [] });
        continue;
      }

      // Detect columns (for reading order only)
      const { columns } = detectColumns(filtered);

      // Strategy: group consecutive lines with the same font size into blocks.
      // Each block gets an overlay positioned at the top-left of its first line,
      // with width = widest line in the block, height = from first to last line.

      for (let ci = 0; ci < columns.length; ci++) {
        const colItems = columns[ci];

        // Sort items top-to-bottom, left-to-right
        const sorted = sortTextItems(colItems);
        // Group into lines
        const lines = groupIntoLines(sorted);

        if (lines.length === 0) continue;

        // For each line, compute its properties
        const lineProps = lines.map(line => {
          let minX = Infinity, maxX = -Infinity;
          let sumHeight = 0;
          for (const item of line) {
            if (item.x < minX) minX = item.x;
            const right = item.x + (item.width || 0);
            if (right > maxX) maxX = right;
            sumHeight += item.height;
          }
          const avgHeight = sumHeight / line.length;
          const y = line[0].y;
          const text = line.map(item => item.str).join(' ');
          return { minX, maxX, y, avgHeight, text };
        });

        // Group consecutive lines with the same font size (within 15% tolerance)
        // AND without large vertical gaps between them
        const blocks = [];
        let currentBlock = [lineProps[0]];

        for (let i = 1; i < lineProps.length; i++) {
          const prev = lineProps[i - 1];
          const curr = lineProps[i];
          const ratio = Math.max(prev.avgHeight, curr.avgHeight) / Math.min(prev.avgHeight, curr.avgHeight);
          // Check vertical gap: if gap between lines is > 1.5× the font height, split
          const verticalGap = prev.y - prev.avgHeight - curr.y; // gap in PDF coords (Y decreases downward)
          const maxGap = prev.avgHeight * 1.5;
          if (ratio <= 1.15 && verticalGap <= maxGap) {
            currentBlock.push(curr);
          } else {
            blocks.push(currentBlock);
            currentBlock = [curr];
          }
        }
        blocks.push(currentBlock);

        // Post-process: merge small blocks (1-2 lines) into adjacent blocks with same font size
        const mergedBlocks = [];
        for (let i = 0; i < blocks.length; i++) {
          const block = blocks[i];
          // If this is a small block (1-2 lines) and the next block has the same font size,
          // merge them together (the small block is likely a continuation)
          if (block.length <= 2 && i + 1 < blocks.length) {
            const nextBlock = blocks[i + 1];
            const ratio = Math.max(block[0].avgHeight, nextBlock[0].avgHeight) / Math.min(block[0].avgHeight, nextBlock[0].avgHeight);
            if (ratio <= 1.15) {
              // Merge: prepend this block's lines to the next block
              blocks[i + 1] = [...block, ...nextBlock];
              continue; // skip adding this block
            }
          }
          // If this is a small block and the previous merged block has the same font size, merge backward
          if (block.length <= 2 && mergedBlocks.length > 0) {
            const prevBlock = mergedBlocks[mergedBlocks.length - 1];
            const ratio = Math.max(block[0].avgHeight, prevBlock[0].avgHeight) / Math.min(block[0].avgHeight, prevBlock[0].avgHeight);
            if (ratio <= 1.15) {
              // Merge into previous block
              mergedBlocks[mergedBlocks.length - 1] = [...prevBlock, ...block];
              continue;
            }
          }
          mergedBlocks.push(block);
        }

        // Create an overlay for each block
        for (const block of mergedBlocks) {
          const firstLine = block[0];
          const lastLine = block[block.length - 1];

          // Vertical bounds
          const blockTopY = firstLine.y + firstLine.avgHeight;
          const blockBottomY = lastLine.y - lastLine.avgHeight * 0.2;

          // Horizontal bounds: use the most common left edge (median of minX values)
          // and the widest right edge (max of maxX values)
          const minXValues = block.map(lp => lp.minX).sort((a, b) => a - b);
          const blockMinX = minXValues[Math.floor(minXValues.length / 2)]; // median
          let blockMaxX = -Infinity;
          for (const lp of block) {
            if (lp.maxX > blockMaxX) blockMaxX = lp.maxX;
          }
          // Ensure maxX is at least as far as minX
          if (blockMaxX < blockMinX + 10) blockMaxX = blockMinX + 100;

          const blockWidth = blockMaxX - blockMinX;
          const blockHeight = blockTopY - blockBottomY;

          // Convert to canvas coordinates
          const overlayTop = (pageHeight - blockTopY) * scale;
          const overlayLeft = blockMinX * scale;
          const overlayWidth = blockWidth * scale;
          const overlayHeight = blockHeight * scale;

          // Concatenate text
          const text = block.map(lp => lp.text).join(' ');

          // Font size from the block's average height
          const fontSize = firstLine.avgHeight * scale * 0.95;

          const overlay = document.createElement('div');
          overlay.className = 'pdf-text-overlay pending';
          overlay.style.position = 'absolute';
          overlay.style.top = overlayTop + 'px';
          overlay.style.left = overlayLeft + 'px';
          overlay.style.width = overlayWidth + 'px';
          overlay.style.minHeight = overlayHeight + 'px';
          overlay.style.maxHeight = (overlayHeight * 1.3) + 'px';
          overlay.style.fontSize = fontSize + 'px';
          overlay.style.lineHeight = '1.15';
          overlay.style.overflow = 'hidden';
          overlay.style.boxSizing = 'border-box';
          overlay.style.padding = '1px 2px';
          overlay.style.backgroundColor = 'var(--surface, #1a1a2e)';
          overlay.style.color = 'var(--text, #e0e0e0)';
          overlay.textContent = '';

          pageWrapper.appendChild(overlay);
          blockEls.push({ text, el: overlay, fontSize });
        }
      }
    }

    container.appendChild(pageWrapper);
    pages.push({ pageNum: n, blocks: blockEls });

    // Debug log
    console.group(`[PDF Overlay] Page ${n} — ${usedXYCut ? 'XY-Cut' : 'detectColumns fallback'}`);
    console.log(`Page: ${pageWidth.toFixed(0)}×${pageHeight.toFixed(0)}, scale: ${scale.toFixed(3)}, blocks: ${blockEls.length}`);
    blockEls.forEach((b, i) => {
      const el = b.el;
      const preview = b.text.substring(0, 50) + (b.text.length > 50 ? '...' : '');
      console.log(`  [${i}] top:${parseFloat(el.style.top).toFixed(0)} left:${parseFloat(el.style.left).toFixed(0)} w:${parseFloat(el.style.width).toFixed(0)} h:${parseFloat(el.style.minHeight).toFixed(0)} fs:${parseFloat(el.style.fontSize).toFixed(1)}px "${preview}"`);
    });
    console.groupEnd();
  }

  // Requirement 7.3: If all pages in the navigation unit yield empty results
  // after all fallbacks, show pdf_no_text_translate message and signal no translation needed.
  const allPagesEmpty = pages.every(p =>
    p.blocks.length === 0 || p.blocks.every(b => b.noTranslate)
  );
  if (allPagesEmpty && pages.length > 0) {
    // Mark the result so callers know no translation API call is needed
    pages.allEmpty = true;
    // If no page already has a no-text message, add one to the first page's wrapper
    const hasMessage = pages.some(p => p.blocks.some(b => b.noTranslate));
    if (!hasMessage) {
      const firstPageWrapper = container.querySelector('.pdf-page-wrapper');
      if (firstPageWrapper) {
        const noTextDiv = document.createElement('div');
        noTextDiv.className = 'pdf-no-text-message';
        noTextDiv.textContent = t(lang, 'pdf_no_text_translate');
        noTextDiv.style.padding = '20px';
        noTextDiv.style.textAlign = 'center';
        noTextDiv.style.color = 'var(--text-muted, #888)';
        firstPageWrapper.appendChild(noTextDiv);
        pages[0].blocks.push({ text: '', el: noTextDiv, fontSize: 0, noTranslate: true });
      }
    }
  }

  return pages;
}

// ─── PDF Loading ─────────────────────────────────────────────────────────────

/**
 * Determines whether a filename should be included in the library scan.
 * A file is included if and only if its extension (case-insensitive) is `.epub` or `.pdf`.
 * @param {string} filename - The filename to check
 * @returns {boolean} true if the file should be included in the library
 */
export function isLibraryFile(filename) {
  const lower = filename.toLowerCase();
  return lower.endsWith('.epub') || lower.endsWith('.pdf');
}

/**
 * Loads a PDF file from an ArrayBuffer and returns a PdfDocument wrapper.
 * @param {ArrayBuffer} buffer - Raw file bytes
 * @param {string} [filename] - Original filename (used as title fallback)
 * @returns {Promise<PdfDocument>} Parsed PDF document wrapper
 * @throws {Error} If magic bytes invalid or pdfjs fails to parse
 */
export async function loadPdf(buffer, filename = '') {
  // Validate magic bytes
  if (!validateMagicBytes(buffer)) {
    throw new Error('Invalid PDF file: magic bytes (%PDF-) not found');
  }

  // Load the document with pdfjs
  const proxy = await pdfjsLib.getDocument({ data: buffer }).promise;

  // Retrieve outline (TOC) — may be null
  const outline = await proxy.getOutline();

  // Extract metadata
  const meta = await proxy.getMetadata();
  const title = resolveTitle(meta, filename);
  const author = (meta?.info?.Author && typeof meta.info.Author === 'string')
    ? meta.info.Author.trim()
    : '';

  return {
    proxy,
    outline,
    pageCount: proxy.numPages,
    title,
    author,
  };
}
