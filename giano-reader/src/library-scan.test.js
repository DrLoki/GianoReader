import { describe, it, expect } from 'vitest';
import {
  fileFingerprint, hasFileChanged, planScan, markEditedFields, mergeReanalysis,
  pathKey, samePath, dedupeLibrary,
} from './library-scan.js';

const fp = (size, mtime = null) => ({ size, mtime });

describe('fileFingerprint', () => {
  it('reads size and modification time from a stat result', () => {
    expect(fileFingerprint({ size: 1200, mtime: new Date(5000) })).toEqual({ size: 1200, mtime: 5000 });
    expect(fileFingerprint({ size: 10, mtime: '1970-01-01T00:00:01.000Z' })).toEqual({ size: 10, mtime: 1000 });
  });

  it('copes with a missing or invalid time', () => {
    expect(fileFingerprint({ size: 10, mtime: null })).toEqual({ size: 10, mtime: null });
    expect(fileFingerprint({ size: 10, mtime: 'not a date' })).toEqual({ size: 10, mtime: null });
    expect(fileFingerprint(null)).toEqual({ size: 0, mtime: null });
  });
});

describe('hasFileChanged', () => {
  it('detects a different size or modification time', () => {
    const entry = { fileSize: 100, fileMtime: 5 };
    expect(hasFileChanged(entry, fp(100, 5))).toBe(false);
    expect(hasFileChanged(entry, fp(101, 5))).toBe(true);
    expect(hasFileChanged(entry, fp(100, 6))).toBe(true);
  });

  it('treats an entry without a recorded time as unchanged when the size matches', () => {
    expect(hasFileChanged({ fileSize: 100 }, fp(100, 7))).toBe(false);
    expect(hasFileChanged({ fileSize: 100 }, fp(90, 7))).toBe(true);
  });

  it('analyses again an entry whose previous analysis failed', () => {
    expect(hasFileChanged({ fileSize: 0 }, fp(100, 7))).toBe(true);
  });
});

describe('planScan', () => {
  it('splits the files into added, changed and unchanged', () => {
    const library = [
      { id: 'a', filePath: '/b/a.epub', fileSize: 100, fileMtime: 1 },
      { id: 'b', filePath: '/b/b.epub', fileSize: 200, fileMtime: 1 },
      { id: 'c', filePath: '/offline-disk/c.epub', fileSize: 300, fileMtime: 1 },
    ];
    const plan = planScan(library, [
      { path: '/b/a.epub', fingerprint: fp(100, 1) },
      { path: '/b/b.epub', fingerprint: fp(200, 2) },
      { path: '/b/new.epub', fingerprint: fp(50, 3) },
      { path: '/b/new.epub', fingerprint: fp(50, 3) },
    ]);

    expect(plan.added.map((f) => f.path)).toEqual(['/b/new.epub']);
    expect(plan.changed.map((f) => f.entry.id)).toEqual(['b']);
    expect(plan.unchanged.map((f) => f.entry.id)).toEqual(['a']);
    // A book on a disconnected drive is simply not part of the plan: never removed
    expect([...plan.added, ...plan.changed, ...plan.unchanged].some((f) => f.path.includes('offline-disk')))
      .toBe(false);
  });
});

describe('markEditedFields', () => {
  it('records the metadata fields the user changed', () => {
    const before = { title: 'Old', author: 'A', notes: '' };
    const entry = { ...before, title: 'New', notes: 'some notes' };
    markEditedFields(entry, before);
    expect(entry.editedFields).toEqual(['title']);
  });

  it('keeps fields recorded by earlier edits', () => {
    const before = { title: 'T', author: 'A', editedFields: ['title'] };
    const entry = { ...before, author: 'B' };
    markEditedFields(entry, before);
    expect(entry.editedFields.sort()).toEqual(['author', 'title']);
  });

  it('adds nothing when no metadata changed', () => {
    const entry = { title: 'T' };
    markEditedFields(entry, { title: 'T' });
    expect(entry.editedFields).toBeUndefined();
  });
});

describe('mergeReanalysis', () => {
  const oldEntry = {
    id: 'keep-id', filePath: '/b/x.epub', addedAt: 10, status: 'reading', notes: 'mine',
    rating: 4, ratingUpdatedAt: 20, title: 'My title', author: 'Old author', publisher: 'P',
    editedFields: ['title'], fileSize: 100, fileMtime: 1, pageCount: 50,
    coverDataUrl: 'data:old', chapterLengths: [1, 2], chapterLengthsFileSize: 100,
  };
  const fresh = {
    id: 'new-random-id', addedAt: 99, status: 'to-read', notes: '', title: 'File title',
    author: 'New author', publisher: '', pageCount: 60, coverDataUrl: 'data:new', fileSize: 120,
  };

  it('keeps identity, reading data and user-edited fields', () => {
    const merged = mergeReanalysis(oldEntry, fresh, fp(120, 2));
    expect(merged).toMatchObject({
      id: 'keep-id', addedAt: 10, status: 'reading', notes: 'mine', rating: 4, ratingUpdatedAt: 20,
      title: 'My title',
    });
  });

  it('takes the new metadata, cover, page count and fingerprint from the file', () => {
    const merged = mergeReanalysis(oldEntry, fresh, fp(120, 2));
    expect(merged).toMatchObject({
      author: 'New author', pageCount: 60, coverDataUrl: 'data:new', fileSize: 120, fileMtime: 2,
    });
    // An empty value from the file does not erase a known one
    expect(merged.publisher).toBe('P');
  });

  it('drops data computed from the old file content', () => {
    const merged = mergeReanalysis(oldEntry, fresh, fp(120, 2));
    expect(merged.chapterLengths).toBeUndefined();
    expect(merged.chapterLengthsFileSize).toBeUndefined();
    expect(oldEntry.chapterLengths).toEqual([1, 2]); // input not modified
  });

  it('keeps the old cover and page count when the new analysis failed', () => {
    const failed = { title: 'x', author: '', fileSize: 0, pageCount: 0, coverDataUrl: null };
    const merged = mergeReanalysis({ ...oldEntry, editedFields: [] }, failed, fp(120, 2));
    expect(merged).toMatchObject({ coverDataUrl: 'data:old', pageCount: 50, author: 'Old author', fileSize: 120 });
  });
});

describe('pathKey / samePath', () => {
  it('treats Windows paths with mixed separators or another case as the same file', () => {
    expect(samePath('C:\\Books\\Saga/Vol 1.epub', 'C:\\Books\\Saga\\Vol 1.epub')).toBe(true);
    expect(samePath('c:/books/saga/vol 1.epub', 'C:\\Books\\Saga\\Vol 1.epub')).toBe(true);
    expect(samePath('C:\\Books\\\\Saga\\Vol 1.epub', 'C:\\Books\\Saga\\Vol 1.epub')).toBe(true);
    expect(samePath('C:\\Books\\Vol 1.epub', 'C:\\Books\\Vol 2.epub')).toBe(false);
  });

  it('keeps the case of POSIX paths and the leading // of UNC paths', () => {
    expect(samePath('/home/a/Book.epub', '/home/a/book.epub')).toBe(false);
    expect(samePath('/home/a//Book.epub', '/home/a/Book.epub')).toBe(true);
    expect(pathKey('\\\\server\\share\\a.epub')).toBe('//server/share/a.epub');
  });

  it('never matches empty paths', () => {
    expect(pathKey('')).toBe('');
    expect(samePath('', '')).toBe(false);
    expect(samePath(undefined, null)).toBe(false);
  });
});

describe('planScan with differently spelled paths', () => {
  it('does not add again a book indexed with another spelling of its path', () => {
    const lib = [{ id: '1', filePath: 'C:\\Books\\Saga/a.epub', fileSize: 10, fileMtime: 5 }];
    const plan = planScan(lib, [{ path: 'C:\\Books\\Saga\\a.epub', fingerprint: fp(10, 5) }]);
    expect(plan.added).toEqual([]);
    expect(plan.unchanged.map(f => f.entry.id)).toEqual(['1']);
  });

  it('analyses a file found twice under two spellings only once', () => {
    const plan = planScan([], [
      { path: 'C:\\B\\a.epub', fingerprint: fp(1) },
      { path: 'C:\\B/a.epub', fingerprint: fp(1) },
    ]);
    expect(plan.added.length).toBe(1);
  });
});

describe('dedupeLibrary', () => {
  it('leaves a library without duplicates unchanged', () => {
    const lib = [{ id: 'a', filePath: 'C:\\x.epub' }, { id: 'b', filePath: 'C:\\y.epub' }, { id: 'c' }];
    const { library, merged } = dedupeLibrary(lib);
    expect(library).toEqual(lib);
    expect(merged).toEqual([]);
  });

  it('merges the copies of one file into the first added, in its place', () => {
    const lib = [
      { id: 'other', filePath: 'C:\\o.epub', addedAt: 0 },
      { id: 'old', filePath: 'C:\\S/a.epub', addedAt: 100, status: 'reading', notes: 'mine',
        title: 'A', coverDataUrl: null, rating: 3, ratingUpdatedAt: 10 },
      { id: 'new', filePath: 'C:\\S\\a.epub', addedAt: 200, status: 'to-read', notes: 'mine',
        title: 'A edited', editedFields: ['title'], coverDataUrl: 'data:c', fileSize: 9, fileMtime: 50,
        rating: 5, ratingUpdatedAt: 20 },
    ];
    const { library, merged } = dedupeLibrary(lib);
    expect(library.map(e => e.id)).toEqual(['other', 'old']);
    expect(library[1]).toMatchObject({
      id: 'old', addedAt: 100,
      filePath: 'C:\\S\\a.epub', // spelling without mixed separators
      status: 'reading', notes: 'mine', title: 'A edited', editedFields: ['title'],
      coverDataUrl: 'data:c', fileSize: 9, fileMtime: 50, rating: 5, ratingUpdatedAt: 20,
    });
    expect(merged).toEqual([{ entry: library[1], otherPaths: ['C:\\S/a.epub'], removedIds: ['new'] }]);
  });

  it('keeps the most advanced status, a rating cleared later and both notes', () => {
    const { library } = dedupeLibrary([
      { id: '1', filePath: 'C:\\a.epub', addedAt: 1, status: 'read', notes: 'one', rating: 4, ratingUpdatedAt: 5 },
      { id: '2', filePath: 'c:/A.epub', addedAt: 2, status: 'reading', notes: 'two', rating: null, ratingUpdatedAt: 9 },
    ]);
    expect(library).toHaveLength(1);
    expect(library[0]).toMatchObject({ id: '1', status: 'read', notes: 'one\n\ntwo', rating: null, ratingUpdatedAt: 9 });
  });
});
