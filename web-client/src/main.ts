import { getPreferences } from './api/preferences';
import { setLocale } from './i18n/index';
import type { Preferences } from './types';
import './styles/base.css';
import './styles/themes.css';
import './styles/components.css';
import './components/disconnected-overlay';
import './components/library-screen';
import './components/reading-screen';
import './components/settings-sheet';

const DEFAULT_PREFS: Preferences = {
  theme: 'dark',
  uiLanguage: 'en',
  translationLang: 'it',
  fontSize: 16,
};

export function applyPreferences(prefs: Preferences): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', prefs.theme);
  root.style.setProperty('--font-size', `${prefs.fontSize}px`);
}

async function init(): Promise<void> {
  let prefs: Preferences;
  try {
    prefs = await getPreferences();
  } catch {
    prefs = DEFAULT_PREFS;
  }

  // Apply CSS custom properties before first paint
  applyPreferences(prefs);

  // Initialise i18n with the resolved uiLanguage
  setLocale(prefs.uiLanguage);

  // Mount <library-screen> as the initial view
  const app = document.getElementById('app');
  if (app) {
    app.innerHTML = '';
    const libraryScreen = document.createElement('library-screen');
    app.appendChild(libraryScreen);
  }
}

init();

// Register disconnected event listener
document.addEventListener('disconnected', () => {
  // Only mount if not already present
  if (!document.querySelector('disconnected-overlay')) {
    const overlay = document.createElement('disconnected-overlay');
    document.body.appendChild(overlay);
  }
});

// Register navigation event listener
document.addEventListener('navigate', (e: Event) => {
  const app = document.getElementById('app');
  if (!app) return;

  const detail = (e as CustomEvent).detail;
  const { screen, bookId, state } = detail || {};

  if (screen === 'reading' && bookId) {
    app.innerHTML = '';
    const readingScreen = document.createElement('reading-screen') as HTMLElement & {
      setBook: (id: string, st: any) => void;
    };
    readingScreen.setBook(bookId, state || { currentChapter: 0, paragraphId: null, scrollOffset: 0, progress: 0 });
    app.appendChild(readingScreen);
  } else if (screen === 'library') {
    app.innerHTML = '';
    const libraryScreen = document.createElement('library-screen');
    app.appendChild(libraryScreen);
  }
});

// Register open-settings event listener
document.addEventListener('open-settings', () => {
  // Only mount if not already open
  if (!document.querySelector('settings-sheet')) {
    const sheet = document.createElement('settings-sheet');
    document.body.appendChild(sheet);
  }
});

// Re-mount current view when UI locale changes (so all strings re-render)
document.addEventListener('locale-changed', () => {
  const app = document.getElementById('app');
  if (!app) return;

  // Detect what's currently mounted and re-mount it
  const readingScreen = app.querySelector('reading-screen') as HTMLElement & {
    getBookId: () => string;
  } | null;

  if (readingScreen) {
    // Re-navigate to reading screen with current state
    const bookId = readingScreen.getBookId();
    app.innerHTML = '';
    const newReading = document.createElement('reading-screen') as HTMLElement & {
      setBook: (id: string, st: any) => void;
    };
    newReading.setBook(bookId, { currentChapter: 0, paragraphId: null, scrollOffset: 0, progress: 0 });
    app.appendChild(newReading);
  } else {
    // Re-mount library screen
    app.innerHTML = '';
    const libraryScreen = document.createElement('library-screen');
    app.appendChild(libraryScreen);
  }
});
