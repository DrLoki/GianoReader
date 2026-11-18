import { describe, it, expect, beforeEach } from 'vitest';
import {
  BASIC_FREE_CHARS, monthKey, billedChars, usageForMonth, usageSummary,
  getBasicUsage, recordBasicUsage,
} from './basic-usage.js';

describe('basic-usage', () => {
  beforeEach(() => localStorage.clear());

  it('month key is YYYY-MM', () => {
    expect(monthKey(new Date(2026, 0, 5))).toBe('2026-01');
    expect(monthKey(new Date(2026, 10, 30))).toBe('2026-11');
  });

  it('counts code points, whitespace included', () => {
    expect(billedChars(['abc', 'è ü'])).toBe(6);
    expect(billedChars(['😀'])).toBe(1);
    expect(billedChars([])).toBe(0);
  });

  it('a different month starts from zero', () => {
    expect(usageForMonth({ month: '2026-10', chars: 9 }, '2026-11')).toEqual({ month: '2026-11', chars: 0 });
    expect(usageForMonth({ month: '2026-11', chars: 9 }, '2026-11').chars).toBe(9);
    expect(usageForMonth(null, '2026-11').chars).toBe(0);
  });

  it('summary against the free tier, going over is not capped', () => {
    expect(usageSummary(250000)).toEqual({ used: 250000, freeChars: BASIC_FREE_CHARS, pct: 50, over: false });
    const over = usageSummary(600000);
    expect(over.pct).toBe(120);
    expect(over.over).toBe(true);
  });

  it('browser fallback accumulates in localStorage', async () => {
    await recordBasicUsage(100);
    await recordBasicUsage(50);
    await recordBasicUsage(0);
    expect(await getBasicUsage()).toEqual({ month: monthKey(), chars: 150 });
  });
});
