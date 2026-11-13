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

/** Book metadata read from the file that the user can also edit in the app. */
export const EDITABLE_META_FIELDS = ['title', 'author', 'publisher', 'pubdate', 'language', 'description'];

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
  const byPath = new Map();
  for (const entry of library) {
    if (entry && entry.filePath) byPath.set(entry.filePath, entry);
  }
  const plan = { added: [], changed: [], unchanged: [] };
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file.path)) continue; // same file reached twice (links)
    seen.add(file.path);
    const entry = byPath.get(file.path);
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
