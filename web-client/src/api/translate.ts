import { apiFetch } from './client';

/**
 * Sends texts to the translation endpoint.
 *
 * @param texts - Array of strings to translate
 * @param sourceLang - BCP-47 source language code
 * @param targetLang - BCP-47 target language code
 * @returns Array of translated strings in the same order as the input
 */
export async function postTranslate(
  texts: string[],
  sourceLang: string,
  targetLang: string,
): Promise<string[]> {
  const response = await apiFetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts, sourceLang, targetLang }),
  });

  const data = await response.json();
  return data.translations;
}

/**
 * Fetches the list of supported translation languages.
 *
 * @returns Array of language objects with code and display name
 */
export async function getLanguages(): Promise<{ code: string; name: string }[]> {
  const response = await apiFetch('/api/translate/languages');
  return response.json();
}
