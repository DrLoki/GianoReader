import { getPreferences } from './api/preferences';
import { setLocale } from './i18n/index';
import type { Preferences } from './types';
import './styles/base.css';
import './styles/themes.css';
import './styles/components.css';
import './components/disconnected-overlay';
import './components/library-screen';

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
