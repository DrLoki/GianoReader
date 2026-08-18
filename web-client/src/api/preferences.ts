import { apiFetch } from './client';
import type { Preferences } from '../types';
import { isOfflineMode, getLocalPreferences, saveLocalPreferences } from './local-db';

/**
 * Fetches the current user preferences from the server.
 * Returns default preferences if none have been saved yet.
 *
 * Calls GET /api/preferences.
 */
export async function getPreferences(): Promise<Preferences> {
  if (isOfflineMode()) {
    return getLocalPreferences();
  }
  const response = await apiFetch('/api/preferences');
  return response.json() as Promise<Preferences>;
}

/**
 * Persists a partial update to user preferences.
 * Only the provided fields are updated; omitted fields remain unchanged.
 * Returns the full updated Preferences object.
 *
 * Calls PUT /api/preferences with a JSON body containing only the provided fields.
 *
 * @param partial - A subset of Preferences fields to update
 * @returns The full updated Preferences object after applying changes
 */
export async function putPreferences(partial: Partial<Preferences>): Promise<Preferences> {
  if (isOfflineMode()) {
    const current = getLocalPreferences();
    const updated = { ...current, ...partial };
    saveLocalPreferences(updated);
    return updated;
  }
  const response = await apiFetch('/api/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial),
  });
  return response.json() as Promise<Preferences>;
}

