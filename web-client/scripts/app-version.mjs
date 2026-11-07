// App version shown in the PWA. The PWA ships inside the desktop app, so it
// uses the desktop version from giano-reader/package.json (single source of
// truth) rather than its own package.json.
import { readFileSync } from 'node:fs';

const pkgUrl = new URL('../../giano-reader/package.json', import.meta.url);

export const APP_VERSION = JSON.parse(readFileSync(pkgUrl, 'utf-8')).version;
