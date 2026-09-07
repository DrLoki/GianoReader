import ePub from 'epubjs';
import type { BookSummary, TocEntry, ChapterResponse, ReadingState, Bookmark, Preferences } from '../types';
import { apiFetch } from './client';

const DB_NAME = 'giano_local_db';
const DB_VERSION = 1;

/** Maximum number of chapters to download when caching a book for offline use. */
const MAX_CHAPTERS_DOWNLOAD = 5000;

export function isOfflineMode(): boolean {
  return localStorage.getItem('giano-offline-mode') === 'true';
}

/** Returns true for any ID that lives in IndexedDB rather than on the server */
export function isLocalId(id: string): boolean {
  return id.startsWith('local-book-') || id.startsWith('offline-');
}

export function setOfflineMode(enabled: boolean): void {
  localStorage.setItem('giano-offline-mode', enabled ? 'true' : 'false');
}

export function getLocalPreferences(): Preferences {
  const stored = localStorage.getItem('giano-local-preferences');
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      // Ignore parsing errors
    }
  }
  return {
    theme: 'dark',
    uiLanguage: 'en',
    translationLang: 'it',
    fontSize: 16,
  };
}

export function saveLocalPreferences(prefs: Preferences): void {
  localStorage.setItem('giano-local-preferences', JSON.stringify(prefs));
}

// ── Singleton IndexedDB connection ────────────────────────────────────────────
let _dbInstance: IDBDatabase | null = null;
let _dbPromise: Promise<IDBDatabase> | null = null;

export function initDB(): Promise<IDBDatabase> {
  if (_dbInstance) return Promise.resolve(_dbInstance);
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('books')) {
        db.createObjectStore('books', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('chapters')) {
        db.createObjectStore('chapters', { keyPath: 'id' }); // id: bookId + ':' + chapterIndex
      }
      if (!db.objectStoreNames.contains('tocs')) {
        db.createObjectStore('tocs', { keyPath: 'bookId' });
      }
      if (!db.objectStoreNames.contains('states')) {
        db.createObjectStore('states', { keyPath: 'bookId' });
      }
      if (!db.objectStoreNames.contains('bookmarks')) {
        db.createObjectStore('bookmarks', { keyPath: 'id' });
      }
    };

    request.onsuccess = () => {
      _dbInstance = request.result;
      // If the connection is closed externally (e.g. versionchange from another tab),
      // reset the singleton so the next call re-opens.
      _dbInstance.onclose = () => { _dbInstance = null; _dbPromise = null; };
      _dbInstance.onversionchange = () => {
        _dbInstance?.close();
        _dbInstance = null;
        _dbPromise = null;
      };
      resolve(_dbInstance);
    };
    request.onerror = () => {
      _dbPromise = null;
      reject(request.error);
    };
  });

  return _dbPromise;
}

function getStore(storeName: string, mode: IDBTransactionMode): Promise<{ store: IDBObjectStore, transaction: IDBTransaction }> {
  return initDB().then((db) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    return { store, transaction };
  });
}

export async function getLocalBooks(): Promise<BookSummary[]> {
  const db = await initDB();
  const rawBooks = await new Promise<BookSummary[]>((resolve, reject) => {
    const tx = db.transaction('books', 'readonly');
    const store = tx.objectStore('books');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });

  // Verify that any offline- cached books actually have chapter 0.
  // If an offline entry has 0 chapters (corrupted/failed download), clean it up so it can be re-downloaded properly.
  const validBooks: BookSummary[] = [];
  const corruptedIds: string[] = [];

  const chaptersTx = db.transaction('chapters', 'readonly');
  const chaptersStore = chaptersTx.objectStore('chapters');

  await Promise.all(
    rawBooks.map(async (book) => {
      if (book.id.startsWith('offline-')) {
        const hasChapter0 = await new Promise<boolean>((res) => {
          const req = chaptersStore.get(`${book.id}:0`);
          req.onsuccess = () => res(!!req.result);
          req.onerror = () => res(false);
        });
        if (hasChapter0) {
          validBooks.push(book);
        } else {
          corruptedIds.push(book.id);
        }
      } else {
        validBooks.push(book);
      }
    })
  );

  if (corruptedIds.length > 0) {
    for (const corruptId of corruptedIds) {
      deleteLocalBook(corruptId).catch((err) => console.warn('Cleaned up corrupt offline book:', err));
    }
  }

  return validBooks;
}

export async function saveLocalBook(
  id: string,
  title: string,
  author: string,
  coverUrl: string | null,
  toc: TocEntry[],
  chapters: { chapterIndex: number; paragraphs: any[] }[]
): Promise<void> {
  const db = await initDB();

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(['books', 'tocs', 'chapters'], 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);

    const booksStore = transaction.objectStore('books');
    booksStore.put({
      id,
      title,
      author,
      coverUrl,
      progress: 0,
      status: 'to-read',
    });

    const tocsStore = transaction.objectStore('tocs');
    tocsStore.put({ bookId: id, toc });

    const chaptersStore = transaction.objectStore('chapters');
    for (const ch of chapters) {
      chaptersStore.put({
        id: `${id}:${ch.chapterIndex}`,
        bookId: id,
        chapterIndex: ch.chapterIndex,
        paragraphs: ch.paragraphs,
      });
    }
  });
}

export async function deleteLocalBook(id: string): Promise<void> {
  const db = await initDB();

  // 1. Delete from books
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('books', 'readwrite');
    const store = tx.objectStore('books');
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });

  // 2. Delete from tocs
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('tocs', 'readwrite');
    const store = tx.objectStore('tocs');
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });

  // 3. Delete from states
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('states', 'readwrite');
    const store = tx.objectStore('states');
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });

  // 4. Delete chapters
  const chaptersTx = db.transaction('chapters', 'readwrite');
  const chaptersStore = chaptersTx.objectStore('chapters');
  // We can open a cursor to find all chapters starting with id:
  await new Promise<void>((resolve, reject) => {
    const range = IDBKeyRange.bound(`${id}:`, `${id}:\uFFFF`);
    const req = chaptersStore.openCursor(range);
    req.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });

  // 5. Delete bookmarks for this book
  const bookmarksTx = db.transaction('bookmarks', 'readwrite');
  const bookmarksStore = bookmarksTx.objectStore('bookmarks');
  await new Promise<void>((resolve, reject) => {
    const req = bookmarksStore.openCursor();
    req.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (cursor) {
        if (cursor.value.bookId === id) {
          cursor.delete();
        }
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getLocalBookCover(id: string): Promise<string> {
  const { store } = await getStore('books', 'readonly');
  return new Promise((resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const book = request.result as BookSummary | undefined;
      if (book?.coverUrl) {
        resolve(book.coverUrl);
      } else if (!isLocalId(id)) {
        getLocalBookCover(`offline-${id}`).then(resolve, reject);
      } else {
        resolve('');
      }
    };
    request.onerror = () => reject(request.error);
  });
}

export async function getLocalBookToc(id: string): Promise<TocEntry[]> {
  const { store } = await getStore('tocs', 'readonly');
  return new Promise((resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const entry = request.result as { bookId: string; toc: TocEntry[] } | undefined;
      if (entry?.toc) {
        resolve(entry.toc);
      } else if (!isLocalId(id)) {
        getLocalBookToc(`offline-${id}`).then(resolve, reject);
      } else {
        resolve([]);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

export async function getLocalChapter(bookId: string, chapterIndex: number): Promise<ChapterResponse> {
  const { store } = await getStore('chapters', 'readonly');
  return new Promise((resolve, reject) => {
    const request = store.get(`${bookId}:${chapterIndex}`);
    request.onsuccess = () => {
      const res = request.result;
      if (res) {
        resolve({
          chapterIndex: res.chapterIndex,
          title: `Chapter ${res.chapterIndex + 1}`,
          paragraphs: res.paragraphs,
        });
      } else if (!isLocalId(bookId)) {
        getLocalChapter(`offline-${bookId}`, chapterIndex).then(resolve, () => {
          reject(new Error(`Local chapter ${bookId}:${chapterIndex} not found`));
        });
      } else {
        reject(new Error(`Local chapter ${bookId}:${chapterIndex} not found`));
      }
    };
    request.onerror = () => reject(request.error);
  });
}

export async function getLocalReadingState(bookId: string): Promise<ReadingState> {
  const { store } = await getStore('states', 'readonly');
  return new Promise((resolve, reject) => {
    const request = store.get(bookId);
    request.onsuccess = () => {
      if (request.result) {
        resolve(request.result.state);
      } else if (!isLocalId(bookId)) {
        getLocalReadingState(`offline-${bookId}`).then(resolve, reject);
      } else {
        resolve({
          currentChapter: 0,
          paragraphId: null,
          scrollOffset: 0,
          progress: 0,
        });
      }
    };
    request.onerror = () => reject(request.error);
  });
}

export async function putLocalReadingState(bookId: string, state: ReadingState): Promise<void> {
  const db = await initDB();
  let targetId = bookId;
  if (!isLocalId(bookId)) {
    const cachedIds = await getOfflineCachedIds();
    if (cachedIds.has(bookId)) {
      targetId = `offline-${bookId}`;
    }
  }

  // Save the state
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('states', 'readwrite');
    const store = transaction.objectStore('states');
    const request = store.put({ bookId: targetId, state });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });

  // Update progress in the books collection
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('books', 'readwrite');
    const store = transaction.objectStore('books');
    const getReq = store.get(targetId);
    getReq.onsuccess = () => {
      const book = getReq.result;
      if (book) {
        book.progress = state.progress;
        if (state.progress >= 95) {
          book.status = 'read';
        } else if (state.progress > 0) {
          book.status = 'reading';
        }
        store.put(book);
      }
      resolve();
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

export async function getLocalBookmarks(bookId: string): Promise<Bookmark[]> {
  const { store } = await getStore('bookmarks', 'readonly');
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const all = request.result || [];
      const filtered = all.filter((b) => b.bookId === bookId);
      resolve(filtered);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function createLocalBookmark(bookId: string, bookmark: Omit<Bookmark, 'id' | 'createdAt'>): Promise<Bookmark> {
  const db = await initDB();
  const fullBookmark: Bookmark = {
    id: `local-bm-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
    ...bookmark,
    createdAt: new Date().toISOString(),
  };

  return new Promise((resolve, reject) => {
    const transaction = db.transaction('bookmarks', 'readwrite');
    const store = transaction.objectStore('bookmarks');
    // Store with bookId for querying, and return with bookId for caller convenience
    const record = { ...fullBookmark, bookId };
    const request = store.put(record);
    request.onsuccess = () => resolve(record as Bookmark & { bookId: string });
    request.onerror = () => reject(request.error);
  });
}

export async function deleteLocalBookmark(bookmarkId: string): Promise<void> {
  const { store } = await getStore('bookmarks', 'readwrite');
  return new Promise((resolve, reject) => {
    const request = store.delete(bookmarkId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// ── Client-side EPUB Parser & Import ──────────────────────────────────────────

/**
 * Generates a paragraph ID matching the Rust backend's `generate_paragraph_id`:
 * SHA-256(bookId + chapterIndex + paragraphIndex) → first 8 bytes → 16 hex chars.
 */
export async function generateParagraphId(bookId: string, chapterIndex: number, paragraphIndex: number): Promise<string> {
  const input = `${bookId}${chapterIndex}${paragraphIndex}`;
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray.slice(0, 8))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function safeInnerHtml(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('script, style').forEach((n) => n.remove());
  clone.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    Array.from(a.attributes).forEach((attr) => {
      if (attr.name !== 'href') a.removeAttribute(attr.name);
    });
    a.setAttribute('data-epub-href', href);
    a.removeAttribute('href');
    a.style.cursor = 'pointer';
  });
  clone.querySelectorAll('*').forEach((n) => {
    ['onclick', 'onmouseover', 'onerror', 'onload'].forEach((ev) => n.removeAttribute(ev));
  });
  return clone.innerHTML;
}

/**
 * Checks if an HTML tag string is in the allowed set: em, strong, a, span
 * (opening and closing variants, with optional attributes for a and span).
 */
function isAllowedTag(tag: string): boolean {
  return /^<\/?(em|strong|a|span)(\s[^>]*)?>$/i.test(tag);
}

/**
 * Strips all HTML tags except em, strong, a, span (and their closing variants),
 * preserving text content. Matches the Rust backend's `strip_disallowed_tags` behavior.
 */
export function stripDisallowedTags(html: string): string {
  let result = '';
  let pos = 0;
  while (pos < html.length) {
    if (html[pos] === '<') {
      const tagEnd = html.indexOf('>', pos);
      if (tagEnd === -1) { result += html[pos]; pos++; continue; }
      const tag = html.slice(pos, tagEnd + 1);
      if (isAllowedTag(tag)) {
        result += tag;
      }
      pos = tagEnd + 1;
    } else {
      result += html[pos];
      pos++;
    }
  }
  return result;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function extractParagraphs(body: HTMLElement, bookId: string, chapterIndex: number): Promise<any[]> {
  const selectors = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote'];
  const rawBlocks = body.querySelectorAll?.(selectors.join(', '));
  // Un <blockquote> che contiene a sua volta p/h*/li/blockquote (blocchi già
  // selezionati singolarmente) non va incluso come blocco proprio, altrimenti
  // il suo testo verrebbe duplicato. Va incluso solo se è "foglia" di testo
  // (contiene solo span/testo inline, come nei blockquote di dialogo/SMS).
  const blocks = rawBlocks
    ? Array.from(rawBlocks).filter((el) => {
        if (el.tagName.toLowerCase() !== 'blockquote') return true;
        return !el.querySelector(selectors.join(', '));
      })
    : rawBlocks;
  if (blocks && blocks.length > 0) {
    const r: any[] = [];
    let paragraphIndex = 0;
    let pendingNativeId: string | undefined;
    for (let index = 0; index < blocks.length; index++) {
      const el = blocks[index];
      const text = (el.textContent || '').trim();
      if (!text) {
        // Preserve the id from empty anchor paragraphs for the next non-empty one
        const elId = (el as HTMLElement).id;
        if (elId) pendingNativeId = elId;
        continue;
      }
      const id = await generateParagraphId(bookId, chapterIndex, paragraphIndex);
      paragraphIndex++;
      const nativeId = (el as HTMLElement).id || pendingNativeId || undefined;
      if (nativeId) pendingNativeId = undefined;
      r.push({
        text,
        html: stripDisallowedTags(safeInnerHtml(el as HTMLElement)),
        id,
        index,
        ...(nativeId ? { nativeId } : {}),
      });
    }
    if (r.length) return r;
  }
  // Fallback: split per newline
  const lines = (body.textContent || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 2);
  const fallbackResult: any[] = [];
  for (let index = 0; index < lines.length; index++) {
    const id = await generateParagraphId(bookId, chapterIndex, index);
    fallbackResult.push({
      text: lines[index],
      html: escapeHtml(lines[index]),
      id,
      index,
    });
  }
  return fallbackResult;
}

export async function parseAndSaveEpub(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  // @ts-ignore
  const book = ePub(arrayBuffer);

  try {
    const meta = await book.loaded.metadata;
    const bookId = `local-book-${Date.now()}`;
    const title = meta.title || file.name.replace(/\.epub$/i, '');
    const author = meta.creator || 'Unknown Author';

    // Get cover image as Base64 Data URL
    let coverUrl: string | null = null;
    try {
      const rawCoverUrl = await book.coverUrl();
      if (rawCoverUrl) {
        const res = await fetch(rawCoverUrl);
        const blob = await res.blob();
        coverUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }
    } catch (e) {
      console.error('Error extracting cover:', e);
    }

    // Get spine items
    await book.loaded.spine;
    const spineItems: any[] = [];
    book.spine.each((item: any) => spineItems.push(item));

    // Get table of contents
    const nav = await book.loaded.navigation;
    const toc: TocEntry[] = (nav.toc || []).map((item: any, i: number) => {
      const href = item.href || '';
      // Strip fragment to find the matching spine item
      const pathPart = href.split('#')[0];
      let spineIndex: number | null = null;
      if (pathPart) {
        const pathBase = pathPart.split('/').pop() || pathPart;
        for (let si = 0; si < spineItems.length; si++) {
          const spineHref = spineItems[si].href || '';
          const spineBase = spineHref.split('/').pop() || spineHref;
          if (spineHref === pathPart || spineBase === pathBase) {
            spineIndex = si;
            break;
          }
        }
      }
      return {
        index: i,
        title: (item.label || '').trim(),
        href,
        level: 0,
        spineIndex,
      };
    });

    // Parse chapters
    const chapters: { chapterIndex: number; paragraphs: any[] }[] = [];
    for (let i = 0; i < spineItems.length; i++) {
      const item = spineItems[i];
      try {
        await item.load(book.load.bind(book));
        const doc = item.document;
        if (doc) {
          const body = doc.body || doc.querySelector('body');
          if (body) {
            const paragraphs = await extractParagraphs(body, bookId, i);
            chapters.push({
              chapterIndex: i,
              paragraphs,
            });
          }
        }
        item.unload();
      } catch (err) {
        console.warn(`Failed to parse chapter ${i}:`, err);
      }
    }

    // Save parsed book to local DB
    await saveLocalBook(bookId, title, author, coverUrl, toc, chapters);

    // Keep track of the last opened book ID
    localStorage.setItem('giano-last-opened-book-id', bookId);

    return bookId;
  } finally {
    try { book.destroy(); } catch (_) { /* ignore */ }
  }
}

// ── Server → Offline Download ──────────────────────────────────────────────────

/**
 * Returns the set of server book IDs that have been downloaded for offline use.
 * Offline copies are stored with id = `offline-{serverBookId}`.
 */
export async function getOfflineCachedIds(): Promise<Set<string>> {
  const books = await getLocalBooks();
  const ids = new Set<string>();
  for (const b of books) {
    if (b.id.startsWith('offline-')) {
      ids.add(b.id.slice('offline-'.length));
    }
  }
  return ids;
}

/** Removes the locally cached offline copy of a server book. */
export async function removeOfflineBook(serverBookId: string): Promise<void> {
  return deleteLocalBook(`offline-${serverBookId}`);
}

/**
 * Downloads a server book (by its server ID) into IndexedDB so it can be read
 * in offline mode. The local copy is stored with id = `offline-{serverBookId}`.
 *
 * @param serverBookId   The server-side UUID of the book.
 * @param title          Book title (from the already-loaded BookSummary).
 * @param author         Book author.
 * @param serverCoverUrl Relative URL like `/api/books/{id}/cover`.
 * @param toc            TOC entries fetched from the server.
 * @param onProgress     Optional callback: (downloadedChapters, totalChapters).
 */
export async function downloadBookForOffline(
  serverBookId: string,
  title: string,
  author: string,
  serverCoverUrl: string | null,
  toc: import('../types').TocEntry[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const localId = `offline-${serverBookId}`;

  // Convert server cover to Base64 Data URL so it works offline
  let coverUrl: string | null = null;
  if (serverCoverUrl) {
    try {
      const res = await apiFetch(serverCoverUrl);
      if (res.ok) {
        const blob = await res.blob();
        coverUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }
    } catch (e) {
      console.warn('Failed to download cover for offline:', e);
    }
  }

  // Fetch all chapters, stopping at the first non-OK response or safety cap
  const chapters: { chapterIndex: number; paragraphs: import('../types').Paragraph[] }[] = [];
  const estimatedTotal = Math.max(toc.length, 1);
  let i = 0;
  while (i < MAX_CHAPTERS_DOWNLOAD) {
    try {
      const res = await apiFetch(`/api/books/${serverBookId}/chapter/${i}`);
      if (!res.ok) break;
      const data: import('../types').ChapterResponse = await res.json();
      if (!data.paragraphs) break; // malformed response guard
      chapters.push({ chapterIndex: i, paragraphs: data.paragraphs });
      i++;
      onProgress?.(i, Math.max(estimatedTotal, i));
    } catch {
      break;
    }
  }

  if (chapters.length === 0) {
    throw new Error(`No chapters could be downloaded for book ${serverBookId}`);
  }

  await saveLocalBook(localId, title, author, coverUrl, toc, chapters);
}


