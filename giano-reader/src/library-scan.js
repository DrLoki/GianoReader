/**
 * library-scan.js
 *
 * Decides what a library folder scan has to analyse, and merges the result of
 * a new analysis into an existing library entry.
 *
 * Opening a book (unzipping an EPUB, reading every chapter for the page
 * estimate, drawing the cover thumbnail) is the slow part of a scan. Files
 * already in the library are recognised by their path and are analysed again
 * only when their size or modification time changed, i.e. when the book file
 * was edited after it was indexed.
 *
 * A scan never removes entries: books on a disk that is not connected stay in
 * the library. Removing missing books is a separate, explicit command.
 *
 * Pure functions, no DOM, filesystem or storage access.
 */

import { normalizeRating } from './library-sync.js';

/** Book metadata read from the file that the user can also edit in the app. */
export const EDITABLE_META_FIELDS = ['title', 'author', 'publisher', 'pubdate', 'language', 'description'];

/**
 * Key that identifies a file whatever the spelling of its path.
 *
 * The same Windows file can reach the library as `C:\Books\a.epub` (file
 * dialog) or `C:\Books/a.epub` (older folder scans joined paths with "/"), and
 * Windows paths are case-insensitive. Separators become "/", repeated
 * separators collapse (except a leading UNC `//`) and Windows paths are
 * lowercased. POSIX paths keep their case.
 * @param {string} path
 */
export function pathKey(path) {
  if (typeof path !== 'string' || !path) return '';
  const windows = /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\');
  const key = path.replace(/\\/g, '/').replace(/(?<!^)\/{2,}/g, '/');
  return windows ? key.toLowerCase() : key;
}

/** True when two paths point to the same file (see `pathKey`). */
export function samePath(a, b) {
  const ka = pathKey(a);
  return ka !== '' && ka === pathKey(b);
}

/** True when a path mixes "/" and "\" separators. */
function hasMixedSeparators(path) {
  return path.includes('/') && path.includes('\\');
}

const STATUS_RANK = { 'to-read': 1, reading: 2, read: 3 };

/**
 * Merges library entries that point to the same file (same `pathKey`).
 *
 * Kept: the entry added first (its id and place in the list), completed with
 * what the others know. The most advanced reading status wins, the most
 * recent rating wins, notes are joined, fields the user edited in any copy are
 * kept, and file size/time come from the most recent analysis. The path
 * spelling kept is one without mixed separators when there is one.
 *
 * @param {object[]} library
 * @returns {{ library: object[], merged: Array<{ entry: object, otherPaths: string[], removedIds: string[] }> }}
 *   `otherPaths`: the other spellings of the path, whose per-book data (the
 *   translation cache) has to be moved to `entry.filePath`.
 */
export function dedupeLibrary(library) {
  const groups = new Map();
  const out = [];
  for (const entry of Array.isArray(library) ? library : []) {
    const key = entry && pathKey(entry.filePath);
    if (!key) { out.push(entry); continue; }
    if (!groups.has(key)) {
      groups.set(key, [entry]);
      out.push(key); // placeholder, replaced below
    } else {
      groups.get(key).push(entry);
    }
  }
  const merged = [];
  const result = out.map(item => {
    if (typeof item !== 'string') return item;
    const group = groups.get(item);
    if (group.length === 1) return group[0];
    const entry = mergeDuplicateEntries(group);
    const otherPaths = [...new Set(group.map(e => e.filePath))].filter(p => p !== entry.filePath);
    const removedIds = group.map(e => e.id).filter(id => id !== entry.id);
    merged.push({ entry, otherPaths, removedIds });
    return entry;
  });
  return { library: result, merged };
}

function isEmptyValue(v) {
  return v === undefined || v === null || v === '';
}

function mergeDuplicateEntries(group) {
  const sorted = group.slice().sort((a, b) => (Number(a.addedAt) || 0) - (Number(b.addedAt) || 0));
  const base = sorted[0];
  const merged = { ...base };
  const edited = new Set(Array.isArray(base.editedFields) ? base.editedFields : []);

  for (const other of sorted.slice(1)) {
    // Fields edited by the user in another copy are kept
    for (const field of Array.isArray(other.editedFields) ? other.editedFields : []) {
      if (!edited.has(field)) { merged[field] = other[field]; edited.add(field); }
    }
    // Whatever the first copy does not know
    for (const [key, value] of Object.entries(other)) {
      if (isEmptyValue(merged[key]) && !isEmptyValue(value)) merged[key] = value;
    }
  }
  if (edited.size) merged.editedFields = [...edited];

  // Most advanced reading status
  const status = group.map(e => e.status).filter(s => STATUS_RANK[s])
    .sort((a, b) => STATUS_RANK[b] - STATUS_RANK[a])[0];
  if (status) merged.status = status;

  // Most recent rating (a rating cleared later counts too)
  const rated = group.slice().sort((a, b) => (Number(b.ratingUpdatedAt) || 0) - (Number(a.ratingUpdatedAt) || 0));
  const newest = rated[0];
  if (Number(newest.ratingUpdatedAt) > 0) {
    merged.rating = normalizeRating(newest.rating);
    merged.ratingUpdatedAt = Number(newest.ratingUpdatedAt);
  } else {
    const any = group.map(e => normalizeRating(e.rating)).find(r => r !== null);
    if (any) merged.rating = any;
  }

  // Notes of every copy
  const notes = [...new Set(group.map(e => (e.notes || '').trim()).filter(Boolean))];
  if (notes.length) merged.notes = notes.join('\n\n');

  // File size and time from the most recent analysis
  const analysed = group.filter(e => e.fileMtime != null)
    .sort((a, b) => Number(b.fileMtime) - Number(a.fileMtime))[0];
  if (analysed) {
    merged.fileSize = analysed.fileSize;
    merged.fileMtime = analysed.fileMtime;
  }

  // Path spelling: prefer one with consistent separators
  if (hasMixedSeparators(merged.filePath || '')) {
    const clean = sorted.find(e => e.filePath && !hasMixedSeparators(e.filePath));
    if (clean) merged.filePath = clean.filePath;
  }
  return merged;
}

/**
 * Size and modification time of a file, from a `stat()` result.
 * @param {{ size?: number, mtime?: Date|string|number|null }} info
 * @returns {{ size: number, mtime: number|null }}
 */
export function fileFingerprint(info) {
  const size = Number(info && info.size) || 0;
  let mtime = null;
  if (info && info.mtime != null) {
    const ms = new Date(info.mtime).getTime();
    if (Number.isFinite(ms)) mtime = ms;
  }
  return { size, mtime };
}

/**
 * True when the file of `entry` changed since it was analysed.
 *
 * Entries written before modification times were recorded only have a size:
 * for them a different size counts as a change, an equal size does not (the
 * time is then recorded, so later edits are recognised). A size of 0 means the
 * previous analysis failed, which is worth another try.
 */
export function hasFileChanged(entry, fingerprint) {
  const knownSize = Number(entry.fileSize) || 0;
  if (!knownSize || knownSize !== fingerprint.size) return true;
  if (entry.fileMtime == null || fingerprint.mtime == null) return false;
  return Number(entry.fileMtime) !== fingerprint.mtime;
}

/**
 * Classifies the files found by a scan.
 *
 * @param {object[]} library  current library entries
 * @param {Array<{ path: string, fingerprint: { size: number, mtime: number|null } }>} files
 * @returns {{
 *   added: Array<{ path: string, fingerprint: object }>,
 *   changed: Array<{ entry: object, path: string, fingerprint: object }>,
 *   unchanged: Array<{ entry: object, path: string, fingerprint: object }>,
 * }}
 */
export function planScan(library, files) {
  // Paths are compared by `pathKey`: the same file spelled with other
  // separators or another case is not a new book
  const byPath = new Map();
  for (const entry of library) {
    if (entry && entry.filePath && !byPath.has(pathKey(entry.filePath))) byPath.set(pathKey(entry.filePath), entry);
  }
  const plan = { added: [], changed: [], unchanged: [] };
  const seen = new Set();
  for (const file of files) {
    const key = pathKey(file.path);
    if (seen.has(key)) continue; // same file reached twice (links)
    seen.add(key);
    const entry = byPath.get(key);
    if (!entry) plan.added.push(file);
    else if (hasFileChanged(entry, file.fingerprint)) plan.changed.push({ entry, ...file });
    else plan.unchanged.push({ entry, ...file });
  }
  return plan;
}

/**
 * Records which metadata fields the user changed in the book detail dialog, so
 * that a later analysis of the edited book file does not overwrite them.
 *
 * @param {object} entry   entry after the edit (updated in place)
 * @param {object} before  copy of the entry before the edit
 */
export function markEditedFields(entry, before) {
  const edited = new Set(Array.isArray(entry.editedFields) ? entry.editedFields : []);
  for (const field of EDITABLE_META_FIELDS) {
    if ((entry[field] ?? '') !== (before[field] ?? '')) edited.add(field);
  }
  if (edited.size) entry.editedFields = [...edited];
  return entry;
}

/**
 * Merges a fresh analysis of a changed book file into its library entry.
 *
 * Kept from the old entry: its id (bookmarks and reading state refer to it),
 * the date it was added, reading status, notes, rating and every metadata
 * field the user edited. Taken from the new analysis: the other metadata,
 * page count, cover and file size. Data computed from the old file content
 * (chapter lengths) is dropped and recomputed at the next opening.
 *
 * @param {object} oldEntry
 * @param {object} fresh       entry produced by the metadata extraction
 * @param {{ size: number, mtime: number|null }} fingerprint
 * @returns {object} the merged entry (a new object)
 */
export function mergeReanalysis(oldEntry, fresh, fingerprint) {
  const merged = { ...oldEntry };
  const edited = new Set(Array.isArray(oldEntry.editedFields) ? oldEntry.editedFields : []);

  for (const field of EDITABLE_META_FIELDS) {
    if (edited.has(field)) continue;
    // A failed analysis returns empty fields: keep what was known
    if (fresh[field] !== undefined && fresh[field] !== '') merged[field] = fresh[field];
  }
  if (fresh.pageCount) merged.pageCount = fresh.pageCount;
  if (fresh.coverDataUrl) merged.coverDataUrl = fresh.coverDataUrl;
  if (fresh.fileType) merged.fileType = fresh.fileType;

  merged.fileSize = fingerprint.size || fresh.fileSize || oldEntry.fileSize || 0;
  merged.fileMtime = fingerprint.mtime;
  delete merged.chapterLengths;
  delete merged.chapterLengthsFileSize;
  return merged;
}
