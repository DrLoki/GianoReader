import { describe, it, expect } from 'vitest';
import { mergeBookmarkLists, bookmarkKey } from './bookmarks-sync.js';

const keys = list => new Set(list.map(bookmarkKey));

describe('mergeBookmarkLists', () => {
  it('keeps bookmarks added on disk by the web server since the last load', () => {
    const loaded = [{ id: 1 }];
    const local = [...loaded, { id: 2 }]; // desktop adds #2
    const disk = [{ id: 1 }, { id: 'uuid-phone' }]; // phone added a bookmark meanwhile
    const merged = mergeBookmarkLists(local, disk, keys(loaded));
    expect(merged.map(b => b.id)).toEqual([1, 2, 'uuid-phone']);
  });

  it('drops bookmarks deleted from the phone', () => {
    const loaded = [{ id: 1 }, { id: 'uuid-phone' }];
    const local = [...loaded, { id: 3 }];
    const disk = [{ id: 1 }]; // phone deleted its bookmark
    const merged = mergeBookmarkLists(local, disk, keys(loaded));
    expect(merged.map(b => b.id)).toEqual([1, 3]);
  });

  it('applies local deletions', () => {
    const loaded = [{ id: 1 }, { id: 2 }];
    const local = [{ id: 1 }];
    const merged = mergeBookmarkLists(local, loaded, keys(loaded));
    expect(merged.map(b => b.id)).toEqual([1]);
  });

  it('keeps the local version of an edited bookmark', () => {
    const loaded = [{ id: 1, filePath: '/old.epub' }];
    const local = [{ id: 1, filePath: '/new.epub' }];
    const merged = mergeBookmarkLists(local, loaded, keys(loaded));
    expect(merged).toEqual([{ id: 1, filePath: '/new.epub' }]);
  });

  it('treats numeric and string ids consistently', () => {
    const merged = mergeBookmarkLists([{ id: 5 }], [{ id: '5' }], new Set(['5']));
    expect(merged).toHaveLength(1);
  });

  it('tolerates missing or invalid inputs', () => {
    expect(mergeBookmarkLists(null, undefined, null)).toEqual([]);
    expect(mergeBookmarkLists([{ id: 1 }], 'garbage', new Set())).toEqual([{ id: 1 }]);
  });
});
