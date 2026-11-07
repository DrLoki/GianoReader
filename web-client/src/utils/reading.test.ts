import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { escapeHtml, bookProgress, chunkOf, resolveEpubLink } from './reading';
import type { TocEntry } from '../types';

describe('escapeHtml', () => {
  it('escapes markup and quotes', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('round-trips through the DOM as plain text', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const div = document.createElement('div');
        div.innerHTML = escapeHtml(s);
        expect(div.children.length).toBe(0);
        expect(div.textContent).toBe(s.replace(/\r\n?/g, '\n'));
      }),
    );
  });
});

describe('bookProgress', () => {
  it('combines chapter index and in-chapter ratio', () => {
    expect(bookProgress(0, 0, 10)).toBe(0);
    expect(bookProgress(4, 0.5, 10)).toBe(45);
    expect(bookProgress(9, 1, 10)).toBe(100);
  });

  it('falls back to the chapter ratio when the length is unknown', () => {
    expect(bookProgress(3, 0.25, null)).toBe(25);
  });

  it('always stays within 0–100', () => {
    fc.assert(
      fc.property(fc.integer({ min: -5, max: 500 }), fc.double(), fc.option(fc.integer({ min: 0, max: 400 })), (c, r, t) => {
        const p = bookProgress(c, r, t);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(100);
      }),
    );
  });
});

describe('chunkOf', () => {
  it('maps positions to chunks', () => {
    expect(chunkOf(0, 12)).toBe(0);
    expect(chunkOf(11, 12)).toBe(0);
    expect(chunkOf(12, 12)).toBe(1);
    expect(chunkOf(-1, 12)).toBe(0);
  });
});

describe('resolveEpubLink', () => {
  const toc: TocEntry[] = [
    { index: 0, title: 'Intro', href: 'Text/intro.xhtml', level: 0, spineIndex: 1 },
    { index: 1, title: 'Notes', href: 'Text/notes.xhtml#top', level: 0, spineIndex: 7 },
    { index: 2, title: 'Broken', href: 'Text/missing.xhtml', level: 0, spineIndex: null },
  ];

  it('classifies external links', () => {
    expect(resolveEpubLink('https://example.com', toc)).toEqual({ kind: 'external', url: 'https://example.com' });
  });

  it('classifies in-chapter fragments', () => {
    expect(resolveEpubLink('#fn3', toc)).toEqual({ kind: 'fragment', fragment: 'fn3' });
  });

  it('resolves links to other spine items through the TOC', () => {
    expect(resolveEpubLink('../Text/notes.xhtml#fn3', toc)).toEqual({ kind: 'chapter', chapterIndex: 7, fragment: 'fn3' });
    expect(resolveEpubLink('intro.xhtml', toc)).toEqual({ kind: 'chapter', chapterIndex: 1, fragment: null });
  });

  it('never follows script URLs or unknown files', () => {
    expect(resolveEpubLink('javascript:alert(1)', toc).kind).toBe('unknown');
    expect(resolveEpubLink('missing.xhtml', toc).kind).toBe('unknown');
    expect(resolveEpubLink('', toc).kind).toBe('unknown');
  });
});
