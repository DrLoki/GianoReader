/**
 * Block elements read as paragraphs. Keep in sync with `TEXT_BLOCK_TAGS` in the
 * desktop `giano-reader/src/text-blocks.js`.
 */
export const TEXT_BLOCK_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote'];
export const TEXT_BLOCK_SELECTOR = TEXT_BLOCK_TAGS.join(', ');

/**
 * Element to read the text of a block from, without the text of the blocks
 * nested in it. Nested blocks are selected on their own, so reading them here
 * too would show their text twice (`<li><p>…</p></li>`, nested lists, a
 * `<blockquote>` of paragraphs).
 *
 * - no nested block: the element itself
 * - nested blocks plus text of its own: a copy without the nested blocks
 * - all its text is in nested blocks: `null` (skip the element)
 */
export function ownTextSource(el: Element): Element | null {
  if (!el.querySelector(TEXT_BLOCK_SELECTOR)) return el;
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll(TEXT_BLOCK_SELECTOR).forEach((nested) => nested.remove());
  return (clone.textContent || '').trim() ? clone : null;
}
