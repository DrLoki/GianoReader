/**
 * storage-file.js
 *
 * Safe read and write of the JSON data files (library, bookmarks) kept in the
 * app data folder. The embedded web server reads and writes the same files.
 *
 * - A file that exists but cannot be read or parsed raises `StorageReadError`.
 *   Callers must not treat that as "no data": saving afterwards would replace
 *   the user's library or bookmarks with an empty list.
 * - Writes go to a temporary file that is then renamed over the target, so a
 *   reader never sees a half-written file.
 *
 * The filesystem is passed in (`@tauri-apps/plugin-fs` in the app), which keeps
 * this module free of Tauri and DOM dependencies.
 */

export class StorageReadError extends Error {
  constructor(path, cause) {
    super(`Cannot read ${path}: ${cause && cause.message ? cause.message : cause}`);
    this.name = 'StorageReadError';
    this.path = path;
    this.cause = cause;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads and parses a JSON file.
 *
 * @param {{ exists: Function, readTextFile: Function }} fs
 * @param {string} path
 * @param {{ retries?: number, retryDelayMs?: number }} [options] a failed read
 *   is retried, because the other writer may be replacing the file right now
 * @returns {Promise<{ found: boolean, value?: any }>} `found: false` when the
 *   file is missing or empty
 * @throws {StorageReadError} when the file exists but is unreadable or invalid
 */
export async function readJsonFile(fs, path, { retries = 2, retryDelayMs = 120 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs);
    try {
      if (!(await fs.exists(path))) return { found: false };
      const content = await fs.readTextFile(path);
      // An empty file holds no data to protect (e.g. a write interrupted at creation)
      if (!content || !content.trim()) return { found: false };
      return { found: true, value: JSON.parse(content) };
    } catch (e) {
      lastError = e;
    }
  }
  throw new StorageReadError(path, lastError);
}

/**
 * Writes `value` as JSON through a temporary file renamed over `path`.
 * If the rename is not possible, falls back to writing the file directly.
 *
 * @param {{ writeTextFile: Function, rename?: Function, remove?: Function }} fs
 */
export async function writeJsonFileAtomic(fs, path, value) {
  const content = JSON.stringify(value, null, 2);
  // Not `${path}.tmp`: that name is used by the web server for the same files
  const tmpPath = `${path}.desktop.tmp`;
  try {
    await fs.writeTextFile(tmpPath, content);
    await fs.rename(tmpPath, path);
  } catch (e) {
    console.warn(`[Storage] atomic write failed for ${path}, writing directly:`, e);
    await fs.writeTextFile(path, content);
    try { if (fs.remove) await fs.remove(tmpPath); } catch { /* leftover tmp is harmless */ }
  }
}
