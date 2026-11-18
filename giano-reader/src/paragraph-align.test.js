import { describe, it, expect } from 'vitest';
import { findAnchor, anchorPosition, syncedScrollTop } from './paragraph-align.js';

const left = [
  { idx: '0', top: 0, height: 100 },
  { idx: '1', top: 100, height: 50 },
  { idx: '2', top: 150, height: 200 },
];
const right = [
  { idx: '0', top: 0, height: 140 },
  { idx: '1', top: 140, height: 80 },
  { idx: '2', top: 220, height: 300 },
];

// Mappings between the two fixtures (what alignedScrollTop does on the DOM)
const map = (from, to) => viewTop => {
  const a = findAnchor(from, viewTop);
  return anchorPosition(a, a && to.find(b => b.idx === a.idx));
};
const leftToRight = map(left, right);
const rightToLeft = map(right, left);

describe('paragraph-align: anchor', () => {
  it('finds the paragraph crossing the top of the view and the fraction', () => {
    expect(findAnchor(left, 125)).toEqual({ idx: '1', fraction: 0.5 });
    expect(findAnchor(left, 0)).toEqual({ idx: '0', fraction: 0 });
    expect(findAnchor(left, 100)).toEqual({ idx: '1', fraction: 0 });
  });

  it('past the last paragraph it anchors to the end of the last one', () => {
    expect(findAnchor(left, 400)).toEqual({ idx: '2', fraction: 1 });
  });

  it('returns null without paragraphs', () => {
    expect(findAnchor([], 10)).toBeNull();
  });

  it('aligns the same paragraph at the same fraction, not the same percentage', () => {
    expect(leftToRight(250)).toBe(370); // half of paragraph 2
  });

  it('returns null when the target has no matching paragraph', () => {
    expect(anchorPosition({ idx: '9', fraction: 0 }, undefined)).toBeNull();
    expect(anchorPosition(null, right[0])).toBeNull();
  });
});

describe('paragraph-align: scroll sync', () => {
  it('left → right without offset: same paragraph at the top', () => {
    expect(syncedScrollTop(leftToRight, 125, 0, true, 10000)).toBe(180);
  });

  it('right → left without offset: inverse mapping', () => {
    expect(syncedScrollTop(rightToLeft, 180, 0, false, 10000)).toBe(125);
  });

  it('keeps the manual offset of the right panel in both directions', () => {
    const r = syncedScrollTop(leftToRight, 125, 30, true, 10000);
    expect(r).toBe(210);
    expect(syncedScrollTop(rightToLeft, r, 30, false, 10000)).toBe(125);
  });

  it('clamps to the scrollable range', () => {
    expect(syncedScrollTop(leftToRight, 340, 0, true, 300)).toBe(300);
    expect(syncedScrollTop(leftToRight, 0, -50, true, 300)).toBe(0);
  });

  it('returns null when there is no mapping (percentage fallback)', () => {
    expect(syncedScrollTop(() => null, 100, 0, true, 1000)).toBeNull();
  });
});
