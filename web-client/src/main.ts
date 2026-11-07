import { getPreferences } from './api/preferences';
import { getStoredPassword, resetUnauthorizedFlag } from './api/client';
import { setLocale } from './i18n/index';
import type { Preferences, ReadingState } from './types';
import { isOfflineMode, getLocalPreferences } from './api/local-db';
import './styles/base.css';
import './styles/themes.css';
import './styles/components.css';
import './components/disconnected-overlay';
import './components/password-prompt';
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
  // The app always starts on the library: drop a stale "reading" entry left
  // by a reload so the back button behaves predictably.
  if (history.state?.screen === 'reading') history.replaceState(null, '');

  let prefs: Preferences;
  if (isOfflineMode()) {
    prefs = getLocalPreferences();
  } else {
    try {
      prefs = await getPreferences();
    } catch {
      prefs = DEFAULT_PREFS;
    }
  }

  // Apply CSS custom properties before first paint
  applyPreferences(prefs);

  // Initialise i18n with the resolved uiLanguage
  setLocale(prefs.uiLanguage);

  // If server requires a password and we don't have one stored, show prompt
  if (!isOfflineMode() && prefs.passwordSet && !getStoredPassword()) {
    showPasswordPrompt();
    return;
  }

  // Mount <library-screen> as the initial view
  mountLibrary();
}

function mountLibrary(): void {
  const app = document.getElementById('app');
  if (app) {
    app.innerHTML = '';
    const libraryScreen = document.createElement('library-screen');
    app.appendChild(libraryScreen);
  }
}

function showPasswordPrompt(): void {
  if (!document.querySelector('password-prompt')) {
    const prompt = document.createElement('password-prompt');
    document.body.appendChild(prompt);
  }
  // Do NOT mount the library behind the prompt — it would call protected
  // endpoints and trigger 401 errors before the user has entered a password.
}

init();

// Register disconnected event listener
document.addEventListener('disconnected', () => {
  if (isOfflineMode()) return;
  // Only mount if not already present
  if (!document.querySelector('disconnected-overlay')) {
    const overlay = document.createElement('disconnected-overlay');
    document.body.appendChild(overlay);
  }
});

type ReadingScreenEl = HTMLElement & {
  setBook: (id: string, st: ReadingState) => void;
  getBookId: () => string;
  getCurrentState?: () => ReadingState;
  flushState?: () => void;
};

const EMPTY_STATE: ReadingState = { currentChapter: 0, paragraphId: null, scrollOffset: 0, progress: 0 };

/** Set when a new service worker took over: applied on the next return to the library. */
let updatePending = false;

function currentReadingScreen(): ReadingScreenEl | null {
  return document.querySelector('#app reading-screen') as ReadingScreenEl | null;
}

function mountReading(bookId: string, state: ReadingState): void {
  const app = document.getElementById('app');
  if (!app) return;
  currentReadingScreen()?.flushState?.();
  app.innerHTML = '';
  const readingScreen = document.createElement('reading-screen') as ReadingScreenEl;
  readingScreen.setBook(bookId, state);
  app.appendChild(readingScreen);
}

function showLibrary(): void {
  // Save the position of the book being closed before it is unmounted
  currentReadingScreen()?.flushState?.();
  if (updatePending) {
    // A new version was installed while reading: load it now
    window.location.reload();
    return;
  }
  mountLibrary();
}

// Register navigation event listener.
// Opening a book pushes a history entry so the Android/browser back button
// returns to the library instead of closing the app.
document.addEventListener('navigate', (e: Event) => {
  const detail = (e as CustomEvent).detail;
  const { screen, bookId, state } = detail || {};

  if (screen === 'reading' && bookId) {
    mountReading(bookId, state || EMPTY_STATE);
    if (history.state?.screen !== 'reading') {
      history.pushState({ screen: 'reading', bookId }, '');
    } else {
      history.replaceState({ screen: 'reading', bookId }, '');
    }
  } else if (screen === 'library') {
    if (history.state?.screen === 'reading') {
      // Pop the reading entry; the popstate handler shows the library
      history.back();
    } else {
      showLibrary();
    }
  }
});

window.addEventListener('popstate', (e: PopStateEvent) => {
  if (e.state?.screen === 'reading') {
    // Forward navigation back into a book: there is no saved state to
    // restore here, so stay on the library and drop the entry.
    history.replaceState(null, '');
  }
  const reading = currentReadingScreen();
  const sheets = document.querySelectorAll('toc-sheet, settings-sheet, bookmarks-sheet');
  if (reading && sheets.length > 0) {
    // Back with a sheet open closes the sheet only and keeps the book open
    sheets.forEach((el) => el.remove());
    history.pushState({ screen: 'reading', bookId: reading.getBookId() }, '');
    return;
  }
  if (reading) showLibrary();
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
  const readingScreen = currentReadingScreen();

  if (readingScreen) {
    // Re-mount the reading screen at the exact same position
    const bookId = readingScreen.getBookId();
    const state = readingScreen.getCurrentState?.() ?? EMPTY_STATE;
    mountReading(bookId, state);
  } else {
    // Re-mount library screen
    app.innerHTML = '';
    const libraryScreen = document.createElement('library-screen');
    app.appendChild(libraryScreen);
  }
});

// Show password prompt when server returns 401 (password required)
document.addEventListener('unauthorized', () => {
  if (isOfflineMode()) return;
  showPasswordPrompt();
});

// Reload library after successful password entry
document.addEventListener('password-accepted', () => {
  resetUnauthorizedFlag();
  mountLibrary();
});

// ── Service worker ───────────────────────────────────────────────────────────
// Registered here rather than with an inline <script>, which the server's
// Content-Security-Policy (script-src 'self') does not allow.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
    // A new version activated (sw.js uses skipWaiting + clients.claim). The
    // page still runs the old bundle: reload right away on the library, or
    // as soon as the reader goes back to it, so nobody loses their place.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return; // first install, nothing to update
      if (currentReadingScreen()) {
        updatePending = true;
      } else {
        window.location.reload();
      }
    });
  });
}
