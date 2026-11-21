import { describe, it, expect, beforeEach } from 'vitest';
import {
  BASIC_FREE_CHARS, monthKey, billedChars, usageForMonth, usageSummary,
  getBasicUsage, recordBasicUsage, normalizeWarnPct, basicQuotaStatus,
  DEFAULT_BASIC_WARN_PCT, BASIC_USAGE_EVENT,
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

  it('warning threshold defaults to 80 and is clamped to 1-100', () => {
    expect(DEFAULT_BASIC_WARN_PCT).toBe(80);
    expect(normalizeWarnPct(undefined)).toBe(80);
    expect(normalizeWarnPct('')).toBe(80);
    expect(normalizeWarnPct('abc')).toBe(80);
    expect(normalizeWarnPct('90')).toBe(90);
    expect(normalizeWarnPct(0)).toBe(1);
    expect(normalizeWarnPct(150)).toBe(100);
  });

  it('warns once per month at the threshold', () => {
    const month = '2026-11';
    expect(basicQuotaStatus(399999, { month }).warn).toBe(false);
    expect(basicQuotaStatus(400000, { month }).warn).toBe(true);
    expect(basicQuotaStatus(400000, { month, warnedMonth: month }).warn).toBe(false);
    expect(basicQuotaStatus(400000, { month, warnedMonth: '2026-10' }).warn).toBe(true);
    expect(basicQuotaStatus(300000, { month, warnPct: 50 }).warn).toBe(true);
  });

  it('limit reached only with auto switch on, and then no separate warning', () => {
    const month = '2026-11';
    expect(basicQuotaStatus(BASIC_FREE_CHARS, { month }).limitReached).toBe(false);
    expect(basicQuotaStatus(BASIC_FREE_CHARS - 1, { month, autoFree: true }).limitReached).toBe(false);
    const st = basicQuotaStatus(BASIC_FREE_CHARS, { month, autoFree: true });
    expect(st.limitReached).toBe(true);
    expect(st.warn).toBe(false);
  });

  it('recording fires the usage event with the new count', async () => {
    const seen = [];
    const onUsage = e => seen.push(e.detail.chars);
    window.addEventListener(BASIC_USAGE_EVENT, onUsage);
    await recordBasicUsage(10);
    await recordBasicUsage(5);
    window.removeEventListener(BASIC_USAGE_EVENT, onUsage);
    expect(seen).toEqual([10, 15]);
  });
});
