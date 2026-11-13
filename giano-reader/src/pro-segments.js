/**
 * pro-segments.js
 *
 * Numbered paragraph markers for PRO (LLM) translation.
 *
 * A batch of paragraphs used to be joined with blank lines and split again on
 * the blank lines of the answer. LLMs often merge or re-wrap short paragraphs,
 * the counts then differ and every paragraph of the batch had to be translated
 * again on its own (up to 12 paid requests instead of one). With a numbered
 * marker in front of each paragraph the answer can be realigned by number,
 * whatever the model does with the line breaks.
 *
 * The marker uses the same brackets as the inline image tokens (`⟦IMG0⟧`),
 * which translation engines leave alone; a paragraph marker holds only digits.
 *
 * Pure functions, no DOM or network access.
 */

const OPEN = '⟦';  // ⟦
const CLOSE = '⟧'; // ⟧

/** Matches a paragraph marker, tolerating spaces added by the model. */
const MARKER_RE = /⟦\s*(\d+)\s*⟧/g;

/** Marker of the paragraph number `n` (1-based). */
export function segmentMarker(n) {
  return `${OPEN}${n}${CLOSE}`;
}

/**
 * Joins `paragraphs` into one text, each paragraph preceded by its marker.
 * @param {string[]} paragraphs
 * @returns {string}
 */
export function buildNumberedBatch(paragraphs) {
  return paragraphs.map((text, i) => `${segmentMarker(i + 1)} ${text}`).join('\n\n');
}

/** Removes every paragraph marker from `text`. */
export function stripSegmentMarkers(text) {
  return text.replace(MARKER_RE, '').trim();
}

/**
 * Splits a translated numbered batch back into its paragraphs.
 *
 * @param {string} translated answer of the model
 * @param {number} count      number of paragraphs that were sent
 * @returns {string[]|null} the `count` translations in the original order, or
 *   `null` when the markers do not identify each paragraph exactly once (the
 *   caller then falls back to another strategy)
 */
export function parseNumberedBatch(translated, count) {
  if (typeof translated !== 'string' || count < 1) return null;

  const markers = [];
  for (const match of translated.matchAll(MARKER_RE)) {
    markers.push({ number: Number(match[1]), start: match.index, end: match.index + match[0].length });
  }
  if (markers.length !== count) return null;

  const parts = new Array(count).fill(null);
  for (let i = 0; i < markers.length; i++) {
    const { number, end } = markers[i];
    if (number < 1 || number > count || parts[number - 1] !== null) return null;
    const next = i + 1 < markers.length ? markers[i + 1].start : translated.length;
    parts[number - 1] = translated.slice(end, next).trim();
  }
  // Text before the first marker would be an introduction added by the model:
  // tolerated when short, but a paragraph must not be empty.
  if (parts.some((part) => !part)) return null;
  return parts;
}
