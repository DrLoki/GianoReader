import type { CacheKey } from '../types';

const DB_NAME = 'translation-cache';
const STORE_NAME = 'translations';
const DB_VERSION = 1;

let db: IDBDatabase | null = null;

function isIndexedDBAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function buildKey(key: CacheKey): string {
  return `${key.bookId}:${key.chapterIndex}:${key.paragraphId}:${key.targetLang}`;
}

function openDB(): Promise<IDBDatabase | null> {
  if (db) return Promise.resolve(db);
  if (!isIndexedDBAvailable()) return Promise.resolve(null);

  return new Promise<IDBDatabase | null>((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };

    request.onerror = () => {
      resolve(null);
    };
  });
}

export async function get(key: CacheKey): Promise<string | undefined> {
  const database = await openDB();
  if (!database) return undefined;

  const compositeKey = buildKey(key);

  return new Promise<string | undefined>((resolve) => {
    const tx = database.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(compositeKey);

    request.onsuccess = () => {
      const result = request.result as string | undefined;
      // Treat empty/whitespace-only cached entries as a cache miss. These can
      // happen when a previous translation attempt failed silently (e.g. the
      // translation engine merged short adjacent lines and one paragraph
      // ended up with no text) — we don't want to serve that stale blank
      // result forever, so we force a retranslation instead.
      if (result === undefined || result.trim() === '') {
        resolve(undefined);
        return;
      }
      resolve(result);
    };

    request.onerror = () => {
      resolve(undefined);
    };
  });
}

export async function set(key: CacheKey, value: string): Promise<void> {
  // Never persist an empty/whitespace-only translation: it's almost always
  // the symptom of a failed/lost translation rather than a legitimate
  // result, and caching it would make the failure permanent for this
  // paragraph (see `get()` above for the matching read-side guard).
  if (!value || value.trim() === '') return;

  const database = await openDB();
  if (!database) return;

  const compositeKey = buildKey(key);

  return new Promise<void>((resolve) => {
    const tx = database.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(value, compositeKey);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      resolve();
    };
  });
}
