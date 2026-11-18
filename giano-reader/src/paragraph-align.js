// Paragraph-based realignment of the two text panels.
//
// Aligning by scroll percentage drifts when the translation is longer or
// shorter than the original paragraph by paragraph. Instead, find the
// paragraph at the top of the source panel (and how far into it the view is)
// and scroll the target so the paragraph with the same index sits at the same
// relative point.

/**
 * @typedef {{ idx: string, top: number, height: number }} ParaBox
 * `top` is relative to the scroll content (i.e. includes scrollTop).
 */

/**
 * Finds the paragraph that crosses (or first follows) `viewTop`.
 * @param {ParaBox[]} items sorted by top
 * @param {number} viewTop
 * @returns {{ idx: string, fraction: number } | null}
 */
export function findAnchor(items, viewTop) {
  for (const it of items) {
    if (it.top + it.height > viewTop) {
      const fraction = it.height > 0 ? Math.min(1, Math.max(0, (viewTop - it.top) / it.height)) : 0;
      return { idx: it.idx, fraction };
    }
  }
  return null;
}

/**
 * scrollTop to give the target so that the anchor paragraph sits at the same
 * relative position at the top of its view. Returns null if not found.
 * @param {{ idx: string, fraction: number }} anchor
 * @param {ParaBox[]} targetItems
 * @param {number} maxScroll
 */
export function targetScrollTop(anchor, targetItems, maxScroll) {
  if (!anchor) return null;
  const match = targetItems.find(it => it.idx === anchor.idx);
  if (!match) return null;
  const top = match.top + anchor.fraction * match.height;
  return Math.max(0, Math.min(maxScroll, top));
}

/** Measures the [data-idx] children of a scroll container. */
export function measureParagraphs(container) {
  const base = container.getBoundingClientRect().top - container.scrollTop;
  return Array.from(container.querySelectorAll(':scope > [data-idx]')).map(el => {
    const r = el.getBoundingClientRect();
    return { idx: el.dataset.idx, top: r.top - base, height: r.height };
  });
}

/**
 * Scrolls `target` so it shows the same paragraph as `source`.
 * @returns {boolean} true if realigned, false if no matching paragraph
 */
export function alignByParagraph(source, target) {
  const anchor = findAnchor(measureParagraphs(source), source.scrollTop);
  const top = targetScrollTop(anchor, measureParagraphs(target),
    target.scrollHeight - target.clientHeight);
  if (top === null) return false;
  target.scrollTop = top;
  return true;
}
