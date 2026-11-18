// Last reading position of each book, saved automatically when the user
// changes book or closes the app and restored when the book is opened again.
// Pure functions: storage and DOM live in main.js.
//
// Stored shape (key `giano-reader-positions`):
//   { [filePath]: { chapterIndex, scrollPct, fileType, pdfMode?, updatedAt } }
// For a PDF, `chapterIndex` is a navigation unit, whose meaning depends on
// `pdfMode` ('chapter' or 'page'): a position saved in another mode is not restored.

/** Books remembered at most: the oldest positions are dropped beyond this. */
export const MAX_READING_POSITIONS = 500;

/**
 * Validates a stored position.
 * @returns {{chapterIndex:number, scrollPct:number, fileType:'epub'|'pdf', pdfMode?:string, updatedAt:number} | null}
 */
export function normalizePosition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const chapterIndex = Number(raw.chapterIndex);
  if (!Number.isInteger(chapterIndex) || chapterIndex < 0) return null;
  let scrollPct = Number(raw.scrollPct);
  if (!Number.isFinite(scrollPct)) scrollPct = 0;
  scrollPct = Math.round(Math.min(100, Math.max(0, scrollPct)) * 100) / 100;
  const fileType = raw.fileType === 'pdf' ? 'pdf' : 'epub';
  const updatedAt = Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0;
  const pos = { chapterIndex, scrollPct, fileType, updatedAt };
  if (fileType === 'pdf' && typeof raw.pdfMode === 'string' && raw.pdfMode) pos.pdfMode = raw.pdfMode;
  return pos;
}

/** Returns the valid position saved for `key`, or null. */
export function getReadingPosition(map, key) {
  if (!key || !map || typeof map !== 'object' || Array.isArray(map)) return null;
  if (!Object.prototype.hasOwnProperty.call(map, key)) return null;
  return normalizePosition(map[key]);
}

/**
 * Returns a new map with the position of `key` replaced. Invalid entries are
 * dropped, and beyond `max` books the least recently updated ones go.
 */
export function setReadingPosition(map, key, pos, max = MAX_READING_POSITIONS) {
  const out = {};
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    for (const [k, v] of Object.entries(map)) {
      const p = normalizePosition(v);
      if (p) out[k] = p;
    }
  }
  const p = normalizePosition(pos);
  if (key && p) out[key] = p;
  const keys = Object.keys(out);
  if (keys.length <= max) return out;
  keys.sort((a, b) => out[b].updatedAt - out[a].updatedAt);
  const kept = {};
  // The position just written always stays, whatever its timestamp
  if (key && out[key]) kept[key] = out[key];
  for (const k of keys) {
    if (Object.keys(kept).length >= max) break;
    kept[k] = out[k];
  }
  return kept;
}

/** True when two positions point at the same place (timestamps ignored). */
export function samePosition(a, b) {
  const pa = normalizePosition(a);
  const pb = normalizePosition(b);
  if (!pa || !pb) return pa === pb;
  return pa.chapterIndex === pb.chapterIndex
    && pa.scrollPct === pb.scrollPct
    && pa.fileType === pb.fileType
    && (pa.pdfMode || '') === (pb.pdfMode || '');
}

/**
 * Where to reopen a book, given the saved position and the book just loaded.
 * @param {*} pos saved position
 * @param {{fileType:'epub'|'pdf', unitCount:number, pdfMode?:string}} book
 * @returns {{chapterIndex:number, scrollPct:number} | null} null = default opening
 */
export function resolveRestoreTarget(pos, book) {
  const p = normalizePosition(pos);
  if (!p || !book) return null;
  if (p.fileType !== (book.fileType === 'pdf' ? 'pdf' : 'epub')) return null;
  if (!Number.isInteger(book.unitCount) || p.chapterIndex >= book.unitCount) return null;
  if (p.fileType === 'pdf' && p.pdfMode && book.pdfMode && p.pdfMode !== book.pdfMode) return null;
  return { chapterIndex: p.chapterIndex, scrollPct: p.scrollPct };
}
