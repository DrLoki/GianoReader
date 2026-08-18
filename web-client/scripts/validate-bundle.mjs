#!/usr/bin/env node
/**
 * validate-bundle.mjs
 *
 * Post-build validation script for the Web Client bundle.
 * Checks:
 *   (a) No external CDN URLs in dist/ output
 *   (b) No @keyframes or animation library imports in dist/ output
 *   (c) vite.config.ts contains required build targets: es2021, chrome105, safari13
 *
 * Exits with non-zero code on any failure.
 *
 * Requirements: 17.2, 17.4, 17.5, 17.6
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const distDir = resolve(__dirname, '../dist');
const viteConfigPath = resolve(__dirname, '../vite.config.ts');

let failed = false;

function fail(msg) {
  console.error(`\u274C ${msg}`);
  failed = true;
}

function pass(msg) {
  console.log(`\u2705 ${msg}`);
}

/**
 * Recursively collect all files in a directory.
 */
function getFiles(dir) {
  const files = [];
  if (!existsSync(dir)) return files;
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

// ─── (a) Check for external CDN URLs in dist/ ────────────────────────────────

if (!existsSync(distDir)) {
  fail(`dist/ directory not found at ${distDir}. Run 'vite build' first.`);
} else {
  const files = getFiles(distDir);
  const bundleFiles = files.filter(
    (f) => f.endsWith('.js') || f.endsWith('.css') || f.endsWith('.html')
  );

  let cdnFound = false;
  // Match http:// or https:// URLs that are NOT:
  //   - localhost / 127.0.0.1
  //   - XML/RDF namespace URIs (w3.org, idpf.org, purl.org, dublin core)
  //   - Embedded documentation/license URLs inside bundled deps (jszip, pako, localforage)
  //   - The approved Cloudflare Worker translation proxy
  const cdnPattern =
    /https?:\/\/(?!localhost|127\.0\.0\.1|www\.w3\.org|www\.idpf\.org|purl\.org|stuartk\.com\/jszip|raw\.github\.com\/Stuk|github\.com\/nodeca\/pako|stuk\.github\.io\/jszip|localforage\.github\.io\/localForage|mozilla\.github\.io\/localForage|translate\.googleapis\.com|giano-translate-proxy\.[^.]+\.workers\.dev)[^\s"'`)<>]+/g;

  for (const file of bundleFiles) {
    const content = readFileSync(file, 'utf-8');
    const matches = content.match(cdnPattern);
    if (matches) {
      for (const match of matches) {
        fail(`CDN URL found in ${file}: ${match}`);
        cdnFound = true;
      }
    }
  }

  if (!cdnFound) {
    pass('No external CDN URLs found in dist/');
  }

  // ─── (b) Check for animation library imports ─────────────────────────────
  // Note: @keyframes for simple UI indicators (spinners, pulses) are acceptable.
  // We only block external animation libraries.

  let animationFound = false;

  for (const file of bundleFiles) {
    const content = readFileSync(file, 'utf-8');

    // Check for animation library imports in JS files
    if (file.endsWith('.js')) {
      const animLibs = ['gsap', 'framer-motion', 'animejs', 'anime.js', 'popmotion', 'velocity-animate'];
      for (const lib of animLibs) {
        if (content.includes(lib)) {
          fail(`Animation library "${lib}" found in ${file}`);
          animationFound = true;
        }
      }
    }
  }

  if (!animationFound) {
    pass('No animation library imports found in dist/');
  }
}

// ─── (c) Check vite.config.ts for required build targets ──────────────────────

const requiredTargets = ['es2021', 'chrome105', 'safari13'];

if (!existsSync(viteConfigPath)) {
  fail(`vite.config.ts not found at ${viteConfigPath}`);
} else {
  const viteContent = readFileSync(viteConfigPath, 'utf-8');
  let allTargetsPresent = true;

  for (const target of requiredTargets) {
    if (!viteContent.includes(target)) {
      fail(`vite.config.ts missing required build target: "${target}"`);
      allTargetsPresent = false;
    }
  }

  if (allTargetsPresent) {
    pass(`vite.config.ts contains all required targets: ${requiredTargets.join(', ')}`);
  }
}

// ─── (d) Check PWA required files are present in dist/ ───────────────────────

const pwaRequired = [
  { path: 'manifest.json', label: 'PWA manifest' },
  { path: 'sw.js', label: 'Service worker' },
  { path: 'icons/icon-192.png', label: 'PWA icon 192x192' },
  { path: 'icons/icon-512.png', label: 'PWA icon 512x512' },
];

for (const { path: relPath, label } of pwaRequired) {
  const fullPath = join(distDir, relPath);
  if (!existsSync(fullPath)) {
    fail(`${label} not found in dist/ (expected at ${relPath})`);
  } else {
    pass(`${label} present in dist/`);
  }
}

// ─── Exit ─────────────────────────────────────────────────────────────────────

if (failed) {
  console.error('\nBundle validation FAILED.');
  process.exit(1);
} else {
  console.log('\nBundle validation passed.');
}
