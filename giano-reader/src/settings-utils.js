/**
 * Pure settings utility functions — no DOM dependencies.
 * Extracted so they can be imported in both main.js and test files.
 */

/**
 * Clamps a search-depth value to the valid range [1, 10].
 * Non-numeric values fall back to the default of 3.
 * @param {number} v
 * @returns {number}
 */
export function clampSearchDepth(v) {
  const n = isNaN(v) ? 3 : v;
  return Math.max(1, Math.min(10, n));
}
