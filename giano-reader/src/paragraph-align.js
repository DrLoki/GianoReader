// Paragraph-based alignment of the two text panels.
//
// Aligning by scroll percentage drifts when the translation is longer or
// shorter than the original paragraph by paragraph. Instead, find the
// paragraph at the top of the source panel (and how far into it the view is)
// and scroll the target so the paragraph with the same index (data-idx) sits
// at the same relative point. Used by the double-click realignment and by the
// scroll sync in text view.

/**
 * @typedef {{ idx: string, top: number, height: number }} ParaBox
 * `top` is relative to the scroll content (i.e. includes scrollTop).
 */

/**
 * Binary search for the paragraph that crosses (or first follows) `viewTop`.
 * Past the last paragraph it returns the last one with fraction 1.
 * @param {number} count
 * @param {(i: number) => ParaBox} boxAt boxes sorted by top
 * @param {number} viewTop
 * @returns {{ idx: string, fraction: number } | null}
 */
export function findAnchorBy(count, boxAt, viewTop) {
  if (count <= 0) return null;
  let lo = 0, hi = count - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = boxAt(mid);
    if (b.top + b.height > viewTop) { found = mid; hi = mid - 1; } else lo = mid + 1;
  }
  if (found < 0) return { idx: boxAt(count - 1).idx, fraction: 1 };
  const b = boxAt(found);
  const fraction = b.height > 0 ? Math.min(1, Math.max(0, (viewTop - b.top) / b.height)) : 0;
  return { idx: b.idx, fraction };
}

/** @param {ParaBox[]} items @param {number} viewTop */
export function findAnchor(items, viewTop) {
  return findAnchorBy(items.length, i => items[i], viewTop);
}

/**
 * Position (in the target's scroll coordinates) of the anchor point.
 * @param {{ idx: string, fraction: number } | null} anchor
 * @param {ParaBox | null | undefined} targetBox box of the paragraph with anchor.idx
 */
export function anchorPosition(anchor, targetBox) {
  if (!anchor || !targetBox) return null;
  return targetBox.top + anchor.fraction * targetBox.height;
}

/**
 * New scrollTop of the target during the scroll sync.
 * `offsetPx` is the manual offset of the RIGHT panel with respect to the
 * paragraph-aligned position (0 = aligned).
 * @param {(viewTop: number) => number | null} alignedFromSource maps a source
 *   viewTop to the aligned target position
 * @param {number} sourceTop source scrollTop
 * @param {number} offsetPx
 * @param {boolean} sourceIsLeft
 * @param {number} maxScroll target scrollHeight - clientHeight
 */
export function syncedScrollTop(alignedFromSource, sourceTop, offsetPx, sourceIsLeft, maxScroll) {
  // left → right: aligned + offset. right → left: take away the offset from
  // the right first, then align (the mapping is monotonic).
  const aligned = sourceIsLeft
    ? alignedFromSource(sourceTop)
    : alignedFromSource(sourceTop - offsetPx);
  if (aligned === null) return null;
  const top = sourceIsLeft ? aligned + offsetPx : aligned;
  return Math.max(0, Math.min(Math.max(0, maxScroll), top));
}

// ── DOM ──────────────────────────────────────────────────────────────────

function contentBase(container) {
  return container.getBoundingClientRect().top + container.clientTop - container.scrollTop;
}

function boxOf(el, base) {
  const r = el.getBoundingClientRect();
  return { idx: el.dataset.idx, top: r.top - base, height: r.height };
}

function findParagraph(container, idx) {
  for (const el of container.children) if (el.dataset && el.dataset.idx === idx) return el;
  return null;
}

/**
 * Position in `target` matching `viewTop` in `source` (same paragraph, same
 * point inside it), or null when the panels have no matching paragraphs.
 */
export function alignedScrollTop(source, target, viewTop = source.scrollTop) {
  const els = source.querySelectorAll(':scope > [data-idx]');
  if (!els.length) return null;
  const sBase = contentBase(source);
  const anchor = findAnchorBy(els.length, i => boxOf(els[i], sBase), viewTop);
  if (!anchor) return null;
  const tEl = findParagraph(target, anchor.idx);
  if (!tEl) return null;
  return anchorPosition(anchor, boxOf(tEl, contentBase(target)));
}

/** Manual offset of `right` with respect to the position aligned to `left`. */
export function paragraphOffset(left, right) {
  const aligned = alignedScrollTop(left, right);
  return aligned === null ? 0 : right.scrollTop - aligned;
}

/**
 * Scrolls `target` following `source` by paragraph.
 * @returns {boolean} false when there are no matching paragraphs
 */
export function syncByParagraph(source, target, offsetPx, sourceIsLeft) {
  const top = syncedScrollTop(
    viewTop => alignedScrollTop(source, target, viewTop),
    source.scrollTop, offsetPx, sourceIsLeft,
    target.scrollHeight - target.clientHeight);
  if (top === null) return false;
  target.scrollTop = top;
  return true;
}

/** Scrolls `target` so it shows the same paragraph as `source` (no offset). */
export function alignByParagraph(source, target) {
  return syncByParagraph(source, target, 0, true);
}
