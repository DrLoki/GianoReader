import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PdfProgress, PHASE_WEIGHT, formatDuration } from './pdf-progress.js';

const t = (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);

describe('formatDuration', () => {
  it('formats seconds and minutes', () => {
    expect(formatDuration(400)).toBe('<1 s');
    expect(formatDuration(12_400)).toBe('12 s');
    expect(formatDuration(185_000)).toBe('3 min 05 s');
    expect(formatDuration(-1)).toBe('');
    expect(formatDuration(NaN)).toBe('');
  });
});

describe('PdfProgress', () => {
  let clock, views, p;
  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
    views = [];
    p = new PdfProgress({ paint: v => views.push(v), t, now: () => clock, timers: globalThis });
  });
  const last = () => views[views.length - 1];

  it('an explicit run shows at once and walks through the phases', () => {
    p.begin();
    expect(last()).toMatchObject({ visible: true, phase: 'pdfProgressOpening', fraction: 0 });
    p.opening(50 * 1_048_576, 100 * 1_048_576);
    expect(last().fraction).toBeCloseTo(PHASE_WEIGHT.prepare / 2);
    expect(last().detail).toBe('50.0 / 100.0 MB');

    p.extract(0, 4, 10);
    expect(last().eta).toBe('pdfProgressEstimating');
    for (let k = 1; k <= 4; k++) { clock += 1000; p.extract(k, 4, 10 + k); }
    expect(last().phase).toBe('pdfProgressExtracting');
    expect(last().fraction).toBeCloseTo(PHASE_WEIGHT.prepare + PHASE_WEIGHT.extract);

    p.analyze(4);
    expect(last()).toMatchObject({ phase: 'pdfProgressAnalyzing', busy: true });
    const f0 = last().fraction;
    clock += 300; vi.advanceTimersByTime(250);
    expect(last().fraction).toBeGreaterThan(f0);
    expect(last().fraction).toBeLessThan(1);

    p.done('4 pages');
    expect(last()).toMatchObject({ phase: 'pdfProgressDone', detail: '4 pages', fraction: 1, state: 'done' });
    expect(p.active).toBe(false);
    vi.advanceTimersByTime(p.hideAfter);
    expect(last().visible).toBe(false);
  });

  it('a run started by a chapter change stays hidden when it is quick', () => {
    p.extract(0, 3, 1);
    p.extract(3, 3, 3);
    p.analyze(3);
    p.done('ok');
    vi.advanceTimersByTime(5000);
    expect(views).toEqual([]);
  });

  it('a slow implicit run appears after the delay', () => {
    p.extract(0, 3, 1);
    expect(views).toEqual([]);
    vi.advanceTimersByTime(p.showDelay);
    expect(last()).toMatchObject({ visible: true, phase: 'pdfProgressExtracting' });
  });

  it('learns the analysis speed', () => {
    p.begin();
    p.analyze(100);
    clock += 250 + 100 * 2; // 2 ms per page
    p.done();
    expect(p.analyzeMsPerPage).toBeCloseTo(2);
  });

  it('an error shows in red and hides later', () => {
    p.begin();
    p.fail('broken file');
    expect(last()).toMatchObject({ visible: true, phase: 'pdfProgressFailed', detail: 'broken file', state: 'error' });
    vi.advanceTimersByTime(p.failHideAfter);
    expect(last().visible).toBe(false);
  });

  it('hide() cancels a run without a summary', () => {
    p.begin();
    p.analyze(5);
    p.hide();
    expect(p.active).toBe(false);
    const n = views.length;
    vi.advanceTimersByTime(2000);
    expect(views.length).toBe(n); // the ticker stopped
  });
});
