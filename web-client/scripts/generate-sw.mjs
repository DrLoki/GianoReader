#!/usr/bin/env node
/**
 * generate-sw.mjs
 *
 * Post-build script: injects the full precache manifest into dist/sw.js.
 *
 * The service worker in public/sw.js contains two placeholders that can only
 * be resolved after `vite build`, because Vite emits hashed asset filenames:
 *   - BUILD_VERSION  → replaced with a content hash of the whole dist output
 *                      (every new build bumps the cache name, so old caches
 *                      are purged on activation)
 *   - PRECACHE_URLS  → replaced with the list of every file in dist/
 *                      (index.html, hashed JS/CSS, icons, manifest, ...)
 *
 * Exits with non-zero code if a placeholder cannot be replaced.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, resolve, relative, sep } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const distDir = resolve(__dirname, '../dist');
const swPath = join(distDir, 'sw.js');

function fail(msg) {
  console.error(`\u274C ${msg}`);
  process.exit(1);
}

if (!existsSync(swPath)) {
  fail(`dist/sw.js not found at ${swPath}. Run 'vite build' first.`);
}

/** Recursively collect all files in a directory. */
function getFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...getFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

// All dist files except the service worker itself, as root-relative URLs
const assetUrls = getFiles(distDir)
  .filter((f) => f !== swPath)
  .map((f) => '/' + relative(distDir, f).split(sep).join('/'))
  .sort();

// '/' fetches the app shell too; keep it alongside '/index.html'
const precacheUrls = ['/', ...assetUrls];

// Build version: content hash over file names + contents
const hash = createHash('sha256');
for (const url of assetUrls) {
  hash.update(url);
  hash.update(readFileSync(join(distDir, url)));
}
const buildVersion = hash.digest('hex').slice(0, 12);

let sw = readFileSync(swPath, 'utf-8');

const versionReplaced = sw.replace(
  /const BUILD_VERSION = '[^']*';/,
  `const BUILD_VERSION = '${buildVersion}';`
);
if (versionReplaced === sw) {
  fail('BUILD_VERSION placeholder not found in dist/sw.js');
}
sw = versionReplaced;

const manifestReplaced = sw.replace(
  /const PRECACHE_URLS = \[[\s\S]*?\];/,
  `const PRECACHE_URLS = ${JSON.stringify(precacheUrls, null, 2)};`
);
if (manifestReplaced === sw) {
  fail('PRECACHE_URLS placeholder not found in dist/sw.js');
}
sw = manifestReplaced;

writeFileSync(swPath, sw);

console.log(`\u2705 dist/sw.js updated: version ${buildVersion}, ${precacheUrls.length} precache URLs`);
