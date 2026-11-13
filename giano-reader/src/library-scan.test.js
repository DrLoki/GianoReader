import { describe, it, expect } from 'vitest';
import {
  fileFingerprint, hasFileChanged, planScan, markEditedFields, mergeReanalysis,
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
