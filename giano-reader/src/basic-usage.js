// Monthly usage of the BASIC engine (Google Cloud Translation v2).
//
// Google does not expose a key's usage through the key itself, so the app
// counts the characters it sends. Under Tauri the count is kept by the Rust
// backend (`get_basic_usage` / `record_basic_usage`), which also adds the
// BASIC translations served by the web server to the PWA. In a plain browser
// it falls back to localStorage.

/** Characters per month covered by Google's free tier for Cloud Translation. */
export const BASIC_FREE_CHARS = 500000;

/** Default warning threshold, as a percentage of the free tier. */
export const DEFAULT_BASIC_WARN_PCT = 80;

/** Event fired on `window` after every recorded BASIC request (detail: usage). */
export const BASIC_USAGE_EVENT = 'giano-basic-usage';

const LS_KEY = 'giano-reader-basic-usage';

const isTauri = () => typeof window !== 'undefined'
  && !!(window.__TAURI__ || window.__TAURI_INTERNALS__);

/** "YYYY-MM" of a date (local time, as on the Rust side). */
export function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Characters billed by Google: Unicode code points, whitespace included. */
export function billedChars(texts) {
  let n = 0;
  for (const t of texts) n += Array.from(t || '').length;
  return n;
}

/** Normalizes a stored value to the given month (another month → 0). */
export function usageForMonth(stored, month) {
  if (stored && stored.month === month && Number.isFinite(stored.chars)) {
    return { month, chars: stored.chars };
  }
  return { month, chars: 0 };
}

/**
 * Data for the settings line: used characters, percentage of the free tier
 * (not capped, so going over is visible) and whether the tier is exceeded.
 */
export function usageSummary(chars, freeChars = BASIC_FREE_CHARS) {
  const used = Math.max(0, chars || 0);
  const pct = freeChars > 0 ? (used / freeChars) * 100 : 0;
  return { used, freeChars, pct, over: used > freeChars };
}

/** Warning threshold from a settings value: integer 1–100, default 80. */
export function normalizeWarnPct(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || value === '' || value === null || value === undefined) return DEFAULT_BASIC_WARN_PCT;
  return Math.max(1, Math.min(100, n));
}

/**
 * What to do about the BASIC quota given the month's count.
 * - `limitReached`: "switch to FREE at 100 %" is on and the free tier is used up.
 * - `warn`: the warning threshold is reached and the warning was not shown yet
 *   this month (`warnedMonth`). Not raised together with `limitReached`, which
 *   has its own message.
 */
export function basicQuotaStatus(chars, { warnPct, autoFree = false, warnedMonth = null, month = monthKey() } = {}, freeChars = BASIC_FREE_CHARS) {
  const { pct } = usageSummary(chars, freeChars);
  const limitReached = !!autoFree && freeChars > 0 && (chars || 0) >= freeChars;
  const warn = !limitReached && pct >= normalizeWarnPct(warnPct) && warnedMonth !== month;
  return { pct, limitReached, warn };
}

function readLocal() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; }
}

/** Count of the current month: { month, chars }. */
export async function getBasicUsage() {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke('get_basic_usage');
    } catch (e) {
      console.warn('[basic-usage] get failed:', e);
    }
  }
  return usageForMonth(readLocal(), monthKey());
}

function notifyUsage(usage) {
  if (typeof window === 'undefined' || typeof CustomEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(BASIC_USAGE_EVENT, { detail: usage }));
}

/**
 * Adds the characters of a BASIC request sent by the desktop frontend,
 * returns the new count and fires BASIC_USAGE_EVENT.
 */
export async function recordBasicUsage(chars) {
  if (!(chars > 0)) return null;
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const usage = await invoke('record_basic_usage', { chars });
      notifyUsage(usage);
      return usage;
    } catch (e) {
      console.warn('[basic-usage] record failed:', e);
    }
  }
  const usage = usageForMonth(readLocal(), monthKey());
  usage.chars += chars;
  try { localStorage.setItem(LS_KEY, JSON.stringify(usage)); } catch { /* ignore */ }
  notifyUsage(usage);
  return usage;
}

/** Tells the web server (Tauri) whether to stop BASIC once the free tier is used up. */
export async function setBasicAutoFree(enabled) {
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_basic_auto_free', { enabled: !!enabled });
  } catch (e) {
    console.warn('[basic-usage] set_basic_auto_free failed:', e);
  }
}
