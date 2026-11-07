/**
 * Pure, DOM-free helpers for the reading screen. Kept out of the component so
 * they can be unit-tested directly.
 */
import type { TocEntry } from '../types';

/** Escapes text for safe insertion into HTML (element content or attributes). */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Whole-book progress (0–100) from the chapter index and the scroll ratio
 * inside that chapter. Falls back to the in-chapter ratio when the number of
 * chapters is unknown.
 */
export function bookProgress(
  chapterIndex: number,
  chapterRatio: number,
  totalChapters: number | null | undefined,
): number {
  const ratio = Math.min(1, Math.max(0, Number.isFinite(chapterRatio) ? chapterRatio : 0));
  if (!totalChapters || totalChapters <= 0) {
    return Math.round(ratio * 100);
  }
  const value = ((chapterIndex + ratio) / totalChapters) * 100;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Chunk (of `chunkSize` paragraphs) that contains paragraph position `position`. */
export function chunkOf(position: number, chunkSize: number): number {
  if (chunkSize <= 0 || position < 0 || !Number.isFinite(position)) return 0;
  return Math.floor(position / chunkSize);
}

export type EpubLinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'fragment'; fragment: string }
  | { kind: 'chapter'; chapterIndex: number; fragment: string | null }
  | { kind: 'unknown' };

function baseName(path: string): string {
  const clean = path.split('#')[0].split('?')[0];
  try {
    return decodeURIComponent(clean.split('/').pop() || clean).toLowerCase();
  } catch {
    return (clean.split('/').pop() || clean).toLowerCase();
  }
}

/**
 * Classifies a link found inside chapter content:
 * - http(s)/mailto → external (open in a new tab)
 * - `#id` → fragment inside the current chapter
 * - `other.xhtml#id` → another spine item, resolved through the TOC
 */
export function resolveEpubLink(href: string, toc: TocEntry[]): EpubLinkTarget {
  const trimmed = (href || '').trim();
  if (!trimmed) return { kind: 'unknown' };
  if (/^(https?:|mailto:)/i.test(trimmed)) return { kind: 'external', url: trimmed };
  if (trimmed.startsWith('#')) {
    const fragment = trimmed.slice(1);
    return fragment ? { kind: 'fragment', fragment } : { kind: 'unknown' };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return { kind: 'unknown' };

  const hashPos = trimmed.indexOf('#');
  const fragment = hashPos >= 0 ? trimmed.slice(hashPos + 1) || null : null;
  const target = baseName(trimmed);
  for (const entry of toc) {
    if (entry.spineIndex === null || entry.spineIndex === undefined) continue;
    if (baseName(entry.href || '') === target) {
      return { kind: 'chapter', chapterIndex: entry.spineIndex, fragment };
    }
  }
  return { kind: 'unknown' };
}
