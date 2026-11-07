/**
 * bookmarks-sync.js
 *
 * The bookmarks file (`giano-reader-bookmarks.json`) has two writers: the
 * desktop UI and the embedded web server (bookmarks created or deleted from the
 * phone PWA). Writing the desktop's in-memory list over the file would silently
 * drop the server's changes, so every save merges with what is on disk.
 *
 * Pure functions, no DOM or storage access.
 */

/** Stable identity of a bookmark (desktop ids are numbers, server ids strings). */
export function bookmarkKey(bm) {
  return String(bm && bm.id);
}

/**
 * Merges the list the desktop wants to save with the list currently on disk.
 *
 * @param {object[]} local    list the desktop wants to save
 * @param {object[]} onDisk   list currently stored on disk
 * @param {Set<string>} known keys the desktop saw at its last load/save
 * @returns {object[]} merged list
 *
 * Rules:
 *  - a local entry the desktop already knew but that is gone from disk was
 *    deleted elsewhere (PWA) → dropped
 *  - a local entry the desktop did not know is a new local bookmark → kept
 *  - a disk entry the desktop did not know was added elsewhere → kept
 *  - a disk entry the desktop knew but no longer has was deleted locally → dropped
 */
export function mergeBookmarkLists(local, onDisk, known) {
  const localList = Array.isArray(local) ? local : [];
  const diskList = Array.isArray(onDisk) ? onDisk : [];
  const knownKeys = known instanceof Set ? known : new Set();
  const diskKeys = new Set(diskList.map(bookmarkKey));
  const localKeys = new Set(localList.map(bookmarkKey));

  const kept = localList.filter(b => {
    const k = bookmarkKey(b);
    return !knownKeys.has(k) || diskKeys.has(k);
  });
  const external = diskList.filter(b => {
    const k = bookmarkKey(b);
    return !knownKeys.has(k) && !localKeys.has(k);
  });
  return [...kept, ...external];
}
