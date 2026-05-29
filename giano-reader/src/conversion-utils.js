/**
 * Pure conversion utility functions — no DOM, no Tauri, no side effects.
 * Extracted so they can be imported in both main.js and test files.
 */

/**
 * Computes progress bar display values.
 * @param {string} stage - Phase label (e.g., "Rendering pages...")
 * @param {number} current - Current step
 * @param {number} total - Total steps
 * @returns {{ width: number, stageText: string, countText: string }}
 */
export function updateProgressBar(stage, current, total) {
  return {
    width: Math.round((current / total) * 100),
    stageText: stage,
    countText: `${current}/${total}`,
  };
}

/**
 * Formats a log line with severity prefix.
 * @param {"error" | "warn"} severity
 * @param {string} message
 * @returns {string}
 */
export function formatLogLine(severity, message) {
  const prefix = severity === 'error' ? '[ERROR]' : '[WARN]';
  return `${prefix} ${message}`;
}

/**
 * Formats a cost value in USD with up to 4 decimal places.
 * No trailing zeros beyond what's needed, maximum 4 decimal places.
 * @param {number} costUsd
 * @returns {string}
 */
export function formatCost(costUsd) {
  // Round to 4 decimal places, then remove unnecessary trailing zeros
  const rounded = Math.round(costUsd * 10000) / 10000;
  const formatted = rounded.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return `$${formatted}`;
}

/**
 * Filters a list of models to only those that support vision.
 * @param {Array<{ id: string, name: string, description: string, supports_vision: boolean }>} models
 * @returns {Array<{ id: string, name: string, description: string, supports_vision: boolean }>}
 */
export function filterVisionModels(models) {
  return models.filter((model) => model.supports_vision === true);
}

/**
 * Builds a library entry from a conversion result with metadata fallback.
 * @param {{ epub_path: string, title?: string, author?: string }} conversionResult
 * @param {string} filename - Original PDF filename (e.g., "book.pdf")
 * @returns {{ title: string, author: string, path: string, addedAt: string, status: string }}
 */
export function buildLibraryEntry(conversionResult, filename) {
  const filenameWithoutExt = filename.replace(/\.[^.]+$/, '');
  return {
    title: conversionResult.title || filenameWithoutExt,
    author: conversionResult.author || '',
    path: conversionResult.epub_path,
    addedAt: new Date().toISOString(),
    status: 'to-read',
  };
}

/**
 * Determines whether the Convert button should be visible.
 * Returns true iff both apiKey and modelId are non-empty strings.
 * @param {*} apiKey
 * @param {*} modelId
 * @returns {boolean}
 */
export function shouldShowConvertButton(apiKey, modelId) {
  return typeof apiKey === 'string' && apiKey.length > 0
    && typeof modelId === 'string' && modelId.length > 0;
}
