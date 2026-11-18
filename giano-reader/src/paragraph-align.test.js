import { describe, it, expect } from 'vitest';
import { findAnchor, targetScrollTop } from './paragraph-align.js';

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

describe('paragraph-align', () => {
  it('finds the paragraph crossing the top of the view and the fraction', () => {
    expect(findAnchor(left, 125)).toEqual({ idx: '1', fraction: 0.5 });
    expect(findAnchor(left, 0)).toEqual({ idx: '0', fraction: 0 });
  });

  it('returns null past the last paragraph', () => {
    expect(findAnchor(left, 400)).toBeNull();
  });

  it('aligns the same paragraph at the same fraction, not the same percentage', () => {
    const anchor = findAnchor(left, 250); // half of paragraph 2
    expect(targetScrollTop(anchor, right, 10000)).toBe(370);
  });

  it('clamps to the scrollable range', () => {
    expect(targetScrollTop({ idx: '2', fraction: 1 }, right, 300)).toBe(300);
  });

  it('returns null when the target has no matching paragraph', () => {
    expect(targetScrollTop({ idx: '9', fraction: 0 }, right, 1000)).toBeNull();
    expect(targetScrollTop(null, right, 1000)).toBeNull();
  });
});
