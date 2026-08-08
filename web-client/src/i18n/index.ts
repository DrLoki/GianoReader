import en from './en.json';
import it from './it.json';

const locales: Record<string, Record<string, string>> = { en, it };

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
