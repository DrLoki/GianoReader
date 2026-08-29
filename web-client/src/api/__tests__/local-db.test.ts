import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initDB,
  saveLocalBook,
  getLocalChapter,
  getLocalBookToc,
  getLocalReadingState,
  putLocalReadingState,
} from '../local-db';

describe('local-db module', () => {
  beforeEach(async () => {
    // Clear indexedDB databases between tests if supported
    const db = await initDB();
    const tx = db.transaction(['books', 'chapters', 'tocs', 'states', 'bookmarks'], 'readwrite');
    tx.objectStore('books').clear();
    tx.objectStore('chapters').clear();
    tx.objectStore('tocs').clear();
    tx.objectStore('states').clear();
    tx.objectStore('bookmarks').clear();
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
  });

  it('saves multiple chapters without TransactionInactiveError and retrieves them', async () => {
    const bookId = 'offline-test-book-123';
    const chapters = [
      { chapterIndex: 0, paragraphs: [{ text: 'Para 1', id: 'p1' }] },
      { chapterIndex: 1, paragraphs: [{ text: 'Para 2', id: 'p2' }] },
      { chapterIndex: 2, paragraphs: [{ text: 'Para 3', id: 'p3' }] },
    ];

    await saveLocalBook(bookId, 'Test Title', 'Test Author', null, [], chapters);

    const ch0 = await getLocalChapter(bookId, 0);
    expect(ch0.chapterIndex).toBe(0);
    expect(ch0.paragraphs[0].text).toBe('Para 1');

    const ch1 = await getLocalChapter(bookId, 1);
    expect(ch1.chapterIndex).toBe(1);
    expect(ch1.paragraphs[0].text).toBe('Para 2');

    const ch2 = await getLocalChapter(bookId, 2);
    expect(ch2.chapterIndex).toBe(2);
    expect(ch2.paragraphs[0].text).toBe('Para 3');
  });

  it('resolves offline-{serverId} fallback when queried with server UUID', async () => {
    const serverBookId = 'e54a6691491d891b';
    const offlineId = `offline-${serverBookId}`;
    const chapters = [
      { chapterIndex: 0, paragraphs: [{ text: 'Server Para 0', id: 'sp0' }] },
    ];

    await saveLocalBook(offlineId, 'Server Book', 'Server Author', null, [{ index: 0, title: 'Ch 1', href: '', level: 0, spineIndex: null }], chapters);

    // Querying with bare server ID should fallback to offline-{serverBookId}
    const ch = await getLocalChapter(serverBookId, 0);
    expect(ch.chapterIndex).toBe(0);
    expect(ch.paragraphs[0].text).toBe('Server Para 0');

    const toc = await getLocalBookToc(serverBookId);
    expect(toc).toHaveLength(1);
    expect(toc[0].title).toBe('Ch 1');

    await putLocalReadingState(serverBookId, {
      currentChapter: 0,
      paragraphId: 'sp0',
      scrollOffset: 100,
      progress: 50,
    });

    const state = await getLocalReadingState(serverBookId);
    expect(state.progress).toBe(50);
    expect(state.scrollOffset).toBe(100);
  });
});
