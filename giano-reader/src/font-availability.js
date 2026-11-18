// Which fonts of the font pickers are installed on this system.
//
// The pickers list fonts of Windows, macOS and Linux (for example the narrow
// ones: Arial Narrow, Bahnschrift SemiCondensed, Avenir Next Condensed,
// Liberation Sans Narrow, DejaVu Sans Condensed). A browser gives no list of
// installed fonts, so each font is measured: when text drawn with
// "'Font', <generic>" is as wide as with "<generic>" alone, for every generic
// family, the font is missing and the browser used the fallback. Fonts bundled
// with the app (`data-bundled` on the option) are always available.

const SAMPLE = 'mmmmmmmmmmlli WWW 0123456789 abcdefghijklmnopqrstuvwxyz';
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace']);

/** First family of a CSS font-family list, without quotes ("'A B', C" → "A B"). */
export function primaryFamily(value) {
  const first = String(value || '').split(',')[0].trim();
  return first.replace(/^(['"])(.*)\1$/, '$2').trim();
}

/**
 * True if `family` is installed. `measure(font, text)` returns the width of
 * `text` drawn with the CSS `font` shorthand (a canvas measureText).
 */
export function isFontAvailable(family, measure) {
  if (!family) return false;
  if (GENERIC.has(family.toLowerCase())) return true;
  const quoted = `"${family.replace(/"/g, '')}"`;
  for (const base of ['monospace', 'serif', 'sans-serif']) {
    if (measure(`72px ${base}`, SAMPLE) !== measure(`72px ${quoted}, ${base}`, SAMPLE)) return true;
  }
  return false;
}

/** measure() backed by a canvas, or null where canvas text is not available. */
export function canvasMeasure(doc = document) {
  try {
    const ctx = doc.createElement('canvas').getContext('2d');
    if (!ctx || typeof ctx.measureText !== 'function') return null;
    return (font, text) => { ctx.font = font; return ctx.measureText(text).width; };
  } catch {
    return null;
  }
}

/**
 * Hides, in each <select>, the options whose font is not installed. The
 * selected option always stays visible, so a saved choice is never lost from
 * view. Without a way to measure, nothing is hidden.
 * @returns {string[]} families found missing
 */
export function hideMissingFontOptions(selects, measure = canvasMeasure()) {
  const missing = new Set();
  if (!measure) return [];
  const cache = new Map();
  const available = (family) => {
    if (!cache.has(family)) cache.set(family, isFontAvailable(family, measure));
    return cache.get(family);
  };
  for (const select of selects) {
    if (!select) continue;
    for (const opt of select.options) {
      const family = primaryFamily(opt.value);
      const ok = opt.dataset.bundled !== undefined || available(family);
      if (!ok) missing.add(family);
      opt.hidden = !ok && opt.value !== select.value;
    }
  }
  return [...missing];
}
