import ePub from 'epubjs';
import type { BookSummary, TocEntry, ChapterResponse, ReadingState, Bookmark, Preferences } from '../types';

const DB_NAME = 'giano_local_db';
const DB_VERSION = 1;

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

export function initDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
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

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getStore(storeName: string, mode: IDBTransactionMode): Promise<{ store: IDBObjectStore, transaction: IDBTransaction }> {
  return initDB().then((db) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    return { store, transaction };
  });
}

export async function getLocalBooks(): Promise<BookSummary[]> {
  const { store } = await getStore('books', 'readonly');
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
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

  // Save book summary
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('books', 'readwrite');
    const store = transaction.objectStore('books');
    const request = store.put({
      id,
      title,
      author,
      coverUrl,
      progress: 0,
      status: 'to-read',
    });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });

  // Save TOC
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('tocs', 'readwrite');
    const store = transaction.objectStore('tocs');
    const request = store.put({ bookId: id, toc });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });

  // Save chapters
  const transaction = db.transaction('chapters', 'readwrite');
  const store = transaction.objectStore('chapters');
  for (const ch of chapters) {
    await new Promise<void>((resolve, reject) => {
      const request = store.put({
        id: `${id}:${ch.chapterIndex}`,
        bookId: id,
        chapterIndex: ch.chapterIndex,
        paragraphs: ch.paragraphs,
      });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
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
      resolve(book?.coverUrl || '');
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
      resolve(entry?.toc || []);
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

  // Save the state
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('states', 'readwrite');
    const store = transaction.objectStore('states');
    const request = store.put({ bookId, state });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });

  // Update progress in the books collection
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('books', 'readwrite');
    const store = transaction.objectStore('books');
    const getReq = store.get(bookId);
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
    id: `local-bm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    ...bookmark,
    createdAt: new Date().toISOString(),
  };

  return new Promise((resolve, reject) => {
    const transaction = db.transaction('bookmarks', 'readwrite');
    const store = transaction.objectStore('bookmarks');
    const request = store.put({ ...fullBookmark, bookId });
    request.onsuccess = () => resolve(fullBookmark);
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extractParagraphs(body: HTMLElement): any[] {
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
    const seenIds = new Set<string>();
    blocks.forEach((el, index) => {
      const text = (el.textContent || '').trim();
      if (!text) return;
      let id = el.id || null;
      if (!id) {
        let parent = el.parentElement;
        while (parent && parent !== body) {
          if (parent.id) {
            id = parent.id;
            break;
          }
          parent = parent.parentElement;
        }
      }
      if (id && seenIds.has(id)) id = null;
      if (id) seenIds.add(id);
      r.push({
        text,
        html: safeInnerHtml(el as HTMLElement),
        id: id || `p-${index}`,
        index,
      });
    });
    if (r.length) return r;
  }
  // Fallback: split per newline
  return (body.textContent || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 2)
    .map((text, index) => ({
      text,
      html: escapeHtml(text),
      id: `p-fallback-${index}`,
      index,
    }));
}

export async function parseAndSaveEpub(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  // @ts-ignore
  const book = ePub(arrayBuffer);

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
  const toc: TocEntry[] = (nav.toc || []).map((item: any, i: number) => ({
    index: i,
    title: (item.label || '').trim(),
    href: item.href || '',
  }));

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
          const paragraphs = extractParagraphs(body);
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

  // Clean up
  try {
    book.destroy();
  } catch (_) {}

  return bookId;
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
      const res = await fetch(serverCoverUrl);
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

  // Fetch all chapters, stopping at the first 404
  const chapters: { chapterIndex: number; paragraphs: import('../types').Paragraph[] }[] = [];
  let i = 0;
  while (true) {
    try {
      const res = await fetch(`/api/books/${serverBookId}/chapter/${i}`);
      if (!res.ok) break;
      const data: import('../types').ChapterResponse = await res.json();
      chapters.push({ chapterIndex: i, paragraphs: data.paragraphs });
      i++;
      onProgress?.(i, Math.max(i + 1, toc.length));
    } catch {
      break;
    }
  }

  await saveLocalBook(localId, title, author, coverUrl, toc, chapters);

  // Pull server-side bookmarks into the local copy so they stay aligned
  await syncServerBookmarksToOffline(serverBookId);
}

// ── Offline / Online bookmark sync ───────────────────────────────────────────────

function getServerBookId(localBookId: string): string | null {
  return localBookId.startsWith('offline-') ? localBookId.slice('offline-'.length) : null;
}

async function deleteLocalBookmarksForBook(bookId: string): Promise<void> {
  const db = await initDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('bookmarks', 'readwrite');
    const store = tx.objectStore('bookmarks');
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (cursor) {
        if (cursor.value.bookId === bookId) {
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

/**
 * Downloads the server bookmarks for a book and stores them under its offline
 * copy id (`offline-{serverBookId}`). Existing local bookmarks for that offline
 * copy are removed first to avoid duplicates.
 */
export async function syncServerBookmarksToOffline(serverBookId: string): Promise<void> {
  const localId = `offline-${serverBookId}`;
  let serverBookmarks: Bookmark[] = [];
  try {
    const res = await fetch(`/api/books/${serverBookId}/bookmarks`);
    if (res.ok) {
      serverBookmarks = await res.json() as Bookmark[];
    }
  } catch {
    return;
  }

  if (serverBookmarks.length === 0) return;

  await deleteLocalBookmarksForBook(localId);

  const db = await initDB();
  const tx = db.transaction('bookmarks', 'readwrite');
  const store = tx.objectStore('bookmarks');

  await Promise.all(
    serverBookmarks.map(
      (bm) =>
        new Promise<void>((resolve, reject) => {
          const request = store.put({ ...bm, bookId: localId });
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        }),
    ),
  );
}

/**
 * Pushes locally created bookmarks from an offline copy (`offline-{serverBookId}`)
 * back to the server. On success the local copies are removed so they are not
 * duplicated on the next offline switch.
 */
export async function syncOfflineBookmarksToServer(offlineBookId: string): Promise<void> {
  const serverBookId = getServerBookId(offlineBookId);
  if (!serverBookId) return;

  const localBookmarks = await getLocalBookmarks(offlineBookId);
  if (localBookmarks.length === 0) return;

  for (const bm of localBookmarks) {
    try {
      const res = await fetch(`/api/books/${serverBookId}/bookmarks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chapterIndex: bm.chapterIndex,
          paragraphId: bm.paragraphId,
          label: bm.label || undefined,
        }),
      });
      if (!res.ok) return;
    } catch {
      return;
    }
  }

  await deleteLocalBookmarksForBook(offlineBookId);
}

/**
 * Synchronises bookmarks for every offline-cached server book back to the server.
 * Intended to be called once when the app starts in online/server mode.
 */
export async function syncOfflineBookmarksToServerForAll(): Promise<void> {
  const books = await getLocalBooks();
  for (const book of books) {
    if (book.id.startsWith('offline-')) {
      await syncOfflineBookmarksToServer(book.id);
    }
  }
}
