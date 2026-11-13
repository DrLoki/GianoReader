import { describe, it, expect, vi } from 'vitest';

// Mock pdfjs-dist to avoid DOMMatrix dependency in test environment
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}));

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: '',
}));

const { PdfNavigator } = await import('./pdf.js');

/** Outline entry whose destination is page `page` (1-based); `null` = unresolvable. */
const entry = (title, page, items = []) => ({
  title,
  dest: page === null ? null : [{ page }],
  items,
});

/** Minimal PDFDocumentProxy stand-in: destinations carry their own page number. */
const fakeDoc = (numPages) => ({
  numPages,
  getDestination: async () => null,
  getPageIndex: async (ref) => ref.page - 1,
});

async function tocOf(outline, numPages = 100) {
  const nav = await PdfNavigator.create(fakeDoc(numPages), outline);
  return { nav, toc: nav.getTocEntries() };
}

/** Navigates to a TOC entry and returns the page range shown. */
function rangeOf(nav, tocEntry) {
  nav.goTo(tocEntry.index);
  return nav.pageRange;
}

describe('PdfNavigator.getTocEntries chapter mapping', () => {
  it('maps each entry to its own chapter when the outline is ordered', async () => {
    const { toc } = await tocOf([entry('One', 1), entry('Two', 10), entry('Three', 30)]);
    expect(toc.map((e) => e.index)).toEqual([0, 1, 2]);
  });

  it('skips over an entry that cannot be resolved', async () => {
    const { nav, toc } = await tocOf([entry('One', 1), entry('Broken', null), entry('Three', 30)]);
    const three = toc.find((e) => e.label === 'Three');
    expect(rangeOf(nav, three).start).toBe(30);
    // The unresolved entry follows the previous one instead of shifting the rest
    expect(toc.find((e) => e.label === 'Broken').index).toBe(0);
  });

  it('follows the page order when the outline is not sorted', async () => {
    const { nav, toc } = await tocOf([entry('Late', 50), entry('Early', 1), entry('Middle', 20)]);
    expect(rangeOf(nav, toc.find((e) => e.label === 'Late')).start).toBe(50);
    expect(rangeOf(nav, toc.find((e) => e.label === 'Middle')).start).toBe(20);
    expect(rangeOf(nav, toc.find((e) => e.label === 'Early')).start).toBe(1);
  });

  it('sends entries that share a page to the same chapter', async () => {
    const { nav, toc } = await tocOf([entry('Cover', 1), entry('Title', 1), entry('Chapter', 5)]);
    expect(toc.map((e) => e.index)).toEqual([0, 0, 1]);
    expect(rangeOf(nav, toc[2]).start).toBe(5);
  });

  it('keeps sub-entries on the chapter of their parent', async () => {
    const { toc } = await tocOf([entry('One', 1), entry('Two', 10, [entry('Two.1', 12)])]);
    expect(toc.find((e) => e.label === 'Two.1')).toMatchObject({ index: 1, level: 1 });
  });
});
