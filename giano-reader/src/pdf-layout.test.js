import { describe, it, expect, vi } from 'vitest';

// pdf.js needs DOMMatrix, missing in jsdom
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' } }));

import {
  genericFamily, selectParagraphs, leadingRatio, segmentStyle, buildDistUnits,
  PdfLayoutAnalyzer, ANALYSIS_MARGIN_PAGES, createSegmentBox, restyleSegments,
} from './pdf-layout.js';

const seg = (pageNum, over = {}) => ({
  pageNum, bounds: { x: 0, y: 0, w: 100, h: 50 }, lines: [], charCount: 10,
  fontSize: 10, fontName: 'Garamond', bold: false, italic: false, alignment: 'left', ...over,
});
const par = (id, segments, over = {}) => ({ id, role: 'body', text: 'testo', translatable: true, segments, ...over });

describe('genericFamily', () => {
  it('maps font names to a generic family', () => {
    expect(genericFamily('ABCDEF+Helvetica-Bold')).toMatch(/sans-serif/);
    expect(genericFamily('Courier New')).toMatch(/monospace/);
    expect(genericFamily('Garamond')).toMatch(/serif/);
    expect(genericFamily(undefined)).toMatch(/serif/);
  });
});

describe('selectParagraphs', () => {
  const result = {
    paragraphs: [
      par('a', [seg(1)]),
      par('b', [seg(2)]),
      par('c', [seg(2), seg(3)]),                // continues out of range
      par('d', [seg(2)], { translatable: false }), // page number
      par('e', [seg(2)], { text: '   ' }),
    ],
  };
  it('keeps translatable paragraphs with a segment in range', () => {
    expect(selectParagraphs(result, 2, 2).map(p => p.id)).toEqual(['b', 'c']);
  });
  it('is safe on empty input', () => {
    expect(selectParagraphs(null, 1, 1)).toEqual([]);
    expect(selectParagraphs({}, 1, 1)).toEqual([]);
  });
});

describe('segmentStyle', () => {
  it('measures the original leading, clamped', () => {
    const rows = [{ y: 0 }, { y: 12 }, { y: 24 }];
    expect(leadingRatio(seg(1, { lines: rows, fontSize: 10 }))).toBeCloseTo(1.2);
    expect(leadingRatio(seg(1, { lines: [{ y: 0 }, { y: 60 }], fontSize: 10 }))).toBe(1.6);
    expect(leadingRatio(seg(1))).toBe(1.18);
  });
  it('makes headings bold and keeps italic and alignment', () => {
    const st = segmentStyle(seg(1, { italic: true, alignment: 'justify' }), 'heading');
    expect(st.fontWeight).toBe('700');
    expect(st.fontStyle).toBe('italic');
    expect(st.textAlign).toBe('justify');
  });
});

describe('buildDistUnits', () => {
  it('weights segments by original characters and falls back to the source text', () => {
    const ps = [par('a', [seg(1, { charCount: 30 }), seg(2, { charCount: 70 })]), par('b', [seg(1)])];
    const units = buildDistUnits(ps, new Map([['a', 'tradotto']]));
    expect(units[0]).toEqual({ text: 'tradotto', weights: [30, 70] });
    expect(units[1].text).toBe('testo');
  });
});

describe('PdfLayoutAnalyzer', () => {
  const makeDoc = (numPages) => ({ numPages });
  const setup = (numPages = 20) => {
    const extract = vi.fn(async (_doc, n) => ({ data: { pageNum: n } }));
    const invoke = vi.fn(async () => ({ paragraphs: [] }));
    return { extract, invoke, an: new PdfLayoutAnalyzer(makeDoc(numPages), { extract, invoke }) };
  };

  it('analyzes the range plus a margin, clamped to the document', () => {
    const { an } = setup(20);
    expect(an.windowFor(10, 12)).toEqual({ lo: 10 - ANALYSIS_MARGIN_PAGES, hi: 12 + ANALYSIS_MARGIN_PAGES });
    expect(an.windowFor(1, 1)).toEqual({ lo: 1, hi: 1 + ANALYSIS_MARGIN_PAGES });
    expect(an.windowFor(19, 20)).toEqual({ lo: 19 - ANALYSIS_MARGIN_PAGES, hi: 20 });
  });

  it('extracts each page once and reuses the last analysis', async () => {
    const { an, extract, invoke } = setup();
    await an.analyze(5, 5);
    expect(extract).toHaveBeenCalledTimes(5);
    await an.analyze(5, 5);
    expect(invoke).toHaveBeenCalledTimes(1);
    await an.analyze(6, 6); // overlaps: only page 9 is new
    expect(extract).toHaveBeenCalledTimes(6);
    expect(invoke).toHaveBeenCalledTimes(2);
    const sent = invoke.mock.calls[1][1].pages.map(p => p.pageNum);
    expect(sent).toEqual([4, 5, 6, 7, 8]);
  });

  it('stops when aborted', async () => {
    const { an, invoke } = setup();
    const ac = new AbortController();
    ac.abort();
    expect(await an.analyze(5, 5, { signal: ac.signal })).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports progress', async () => {
    const { an } = setup();
    const onProgress = vi.fn();
    await an.analyze(1, 1, { onProgress });
    expect(onProgress).toHaveBeenLastCalledWith(3, 3);
  });
});

describe('paragraphTextsForRange', () => {
  it('returns the texts of the paragraphs that start in the range, skipping page numbers', async () => {
    const { paragraphTextsForRange } = await import('./pdf-layout.js');
    const result = { paragraphs: [
      par('a', [seg(1)], { text: 'prima' }),
      par('b', [seg(2), seg(3)], { text: 'a cavallo' }),
      par('c', [seg(3)], { text: 'seconda pagina' }),
      par('d', [seg(2)], { text: '12', translatable: false }),
    ] };
    expect(paragraphTextsForRange(result, 2, 2)).toEqual(['a cavallo']);
    expect(paragraphTextsForRange(result, 1, 3)).toEqual(['prima', 'a cavallo', 'seconda pagina']);
    expect(paragraphTextsForRange(null, 1, 3)).toEqual([]);
  });
});

describe('expandLigatures', () => {
  it('expands typographic ligatures', async () => {
    const { expandLigatures } = await import('./pdf.js');
    expect(expandLigatures('diﬀerent identiﬁed ﬂight oﬃce')).toBe('different identified flight office');
  });
});

describe('font of the translation boxes', () => {
  const seg = { bounds: { x: 10, y: 20, w: 100, h: 30 }, fontSize: 10, fontName: 'Helvetica', lines: [] };
  const par = { id: 'p1', role: 'body' };

  it('uses the family of the original unless one is chosen', () => {
    const wrapper = document.createElement('div');
    const a = createSegmentBox(wrapper, par, seg, 2);
    expect(a.style.fontFamily).toContain('Arial');
    expect(a.dataset.basePx).toBe('20');
    const b = createSegmentBox(wrapper, par, seg, 2, { fontFamily: "'Arial Narrow', sans-serif" });
    expect(b.style.fontFamily).toContain('Arial Narrow');
  });

  it('restyle changes the family and goes back to the original with null', () => {
    const wrapper = document.createElement('div');
    const el = createSegmentBox(wrapper, par, seg, 2);
    el.style.fontSize = '12px';
    restyleSegments(wrapper, 'Verdana, sans-serif');
    expect(el.style.fontFamily).toContain('Verdana');
    expect(el.style.fontSize).toBe('20px'); // pending box: back to the original size
    restyleSegments(wrapper, null);
    expect(el.style.fontFamily).toContain('Inter');
  });
});
