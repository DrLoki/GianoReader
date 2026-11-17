import { describe, it, expect } from 'vitest';
import { filterLibrary, sortLibrary, normalizeLibrarySort, LIBRARY_SORTS } from './library-view.js';

const lib = [
  { id: '1', title: 'Volume 12', author: 'Hyuuga', publisher: 'J-Novel', status: 'reading', rating: 5 },
  { id: '2', title: 'volume 5', author: 'Hyuuga', publisher: '', status: 'to-read' },
  { id: '3', title: 'Élan', author: 'Abel', publisher: 'Tor', status: 'read', rating: 3 },
  { id: '4', title: '', author: '', status: 'to-read' },
];
const ids = list => list.map(e => e.id);

describe('filterLibrary', () => {
  it('searches title, author and publisher, ignoring case', () => {
    expect(ids(filterLibrary(lib, { query: 'tor' }))).toEqual(['3']);
    expect(ids(filterLibrary(lib, { query: 'HYUUGA' }))).toEqual(['1', '2']);
    expect(ids(filterLibrary(lib, { query: 'novel' }))).toEqual(['1']);
    expect(ids(filterLibrary(lib, { query: '  ' }))).toEqual(['1', '2', '3', '4']);
  });

  it('combines search, status and rating filters', () => {
    expect(ids(filterLibrary(lib, { status: 'to-read' }))).toEqual(['2', '4']);
    expect(ids(filterLibrary(lib, { rating: 'none' }))).toEqual(['2', '4']);
    expect(ids(filterLibrary(lib, { query: 'volume', rating: '5' }))).toEqual(['1']);
  });
});

describe('sortLibrary', () => {
  it('keeps the library order for "added" and unknown values', () => {
    expect(ids(sortLibrary(lib, 'added'))).toEqual(['1', '2', '3', '4']);
    expect(ids(sortLibrary(lib, 'bogus'))).toEqual(['1', '2', '3', '4']);
  });

  it('sorts by title with numbers in numeric order, accents ignored, untitled last', () => {
    expect(ids(sortLibrary(lib, 'title', 'en'))).toEqual(['3', '2', '1', '4']);
  });

  it('sorts by author, then title, without changing the input', () => {
    const input = lib.slice();
    expect(ids(sortLibrary(input, 'author', 'en'))).toEqual(['3', '2', '1', '4']);
    expect(input).toEqual(lib);
  });

  it('accepts an unknown locale', () => {
    expect(ids(sortLibrary(lib, 'title', 'not-a-locale!!'))).toEqual(['3', '2', '1', '4']);
  });
});

describe('normalizeLibrarySort', () => {
  it('returns a known sort or the default', () => {
    for (const s of LIBRARY_SORTS) expect(normalizeLibrarySort(s)).toBe(s);
    expect(normalizeLibrarySort(undefined)).toBe('added');
  });
});
