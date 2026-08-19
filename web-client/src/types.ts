// Mirror of Rust response shapes for the Web Client REST API

export interface BookSummary {
  id: string;
  title: string;
  author: string;
  coverUrl: string | null;
  progress: number; // 0–100
  status?: 'to-read' | 'reading' | 'read' | null;
}

export interface TocEntry {
  index: number;
  title: string;
  href: string;
  level: number;
  spineIndex: number | null;
}

export interface ChapterResponse {
  chapterIndex: number;
  title: string;
  paragraphs: Paragraph[];
}

export interface Paragraph {
  id: string;
  index: number;
  html: string;
  text: string;
}

export interface ReadingState {
  currentChapter: number;
  paragraphId: string | null;
  scrollOffset: number;
  progress: number;
}

export interface Bookmark {
  id: string;
  chapterIndex: number;
  paragraphId: string;
  paragraphIndex?: number;
  label?: string;
  createdAt: string;
}

export interface Preferences {
  theme: 'light' | 'dark' | 'sepia';
  uiLanguage: string;
  translationLang: string;
  fontSize: number;
  cloudflareWorkerSubdomain?: string;
}

export interface CacheKey {
  bookId: string;
  chapterIndex: number;
  paragraphId: string;
  targetLang: string;
}
