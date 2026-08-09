import en from './en.json';
import it from './it.json';
import fr from './fr.json';
import de from './de.json';
import es from './es.json';
import pt from './pt.json';
import ru from './ru.json';
import zh from './zh.json';
import ja from './ja.json';
import ar from './ar.json';
import fil from './fil.json';
import sq from './sq.json';

const locales: Record<string, Record<string, string>> = {
  en, it, fr, de, es, pt, ru, zh, ja, ar, fil, sq,
};

let activeLocale: string = 'en';

/**
 * Sets the active UI locale. No validation — unknown codes
 * simply mean lookups will fall through to the English fallback.
 */
export function setLocale(locale: string): void {
  activeLocale = locale;
}

/** Returns the current active locale code. */
export function getLocale(): string {
  return activeLocale;
}

/**
 * Resolves a translation key using the fallback chain:
 *   active locale → English → raw key.
 *
 * Replaces `{varName}` placeholders with values from `vars` if provided.
 * Never throws.
 */
export function t(key: string, vars?: Record<string, string>): string {
  const dict = locales[activeLocale];
  let value: string | undefined = dict?.[key];

  if (value === undefined && activeLocale !== 'en') {
    value = locales['en']?.[key];
  }

  if (value === undefined) {
    return key;
  }

  if (vars) {
    for (const [name, replacement] of Object.entries(vars)) {
      value = value.replace(new RegExp(`\\{${name}\\}`, 'g'), replacement);
    }
  }

  return value;
}
