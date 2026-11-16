// Builds the updater manifest (latest.json) read by tauri-plugin-updater from
// releases/latest/download/latest.json.
//
// Usage: node scripts/make-latest-json.mjs <artifacts dir> <tag> <repo> <out file>
//
// For each platform it takes the update bundle and the content of its .sig
// file (written by `tauri build` with createUpdaterArtifacts, or by
// `tauri signer sign` for the patched AppImage). GitHub replaces the spaces of
// asset names with dots, so the URL uses the same rule.
import fs from 'node:fs';
import path from 'node:path';

const [dir, tag, repo, out] = process.argv.slice(2);
if (!dir || !tag || !repo || !out) {
  console.error('usage: make-latest-json.mjs <artifacts dir> <tag> <repo> <out file>');
  process.exit(1);
}

const files = [];
const walk = d => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else files.push(p);
  }
};
walk(dir);

const find = re => files.find(f => re.test(path.basename(f)) && fs.existsSync(f + '.sig'));
const entry = file => ({
  signature: fs.readFileSync(file + '.sig', 'utf8').trim(),
  url: `https://github.com/${repo}/releases/download/${tag}/${path.basename(file).replace(/ /g, '.')}`,
});

const platforms = {};
const windows = find(/-setup\.exe$/);
const mac = find(/\.app\.tar\.gz$/);
const linux = find(/\.AppImage$/);
if (windows) platforms['windows-x86_64'] = entry(windows);
if (mac) {
  // universal build: the same bundle serves both architectures
  platforms['darwin-aarch64'] = entry(mac);
  platforms['darwin-x86_64'] = entry(mac);
}
if (linux) platforms['linux-x86_64'] = entry(linux);

if (!Object.keys(platforms).length) {
  console.error('No signed update bundle found: is TAURI_SIGNING_PRIVATE_KEY set?');
  process.exit(1);
}

const manifest = {
  version: tag.replace(/^v/, ''),
  notes: `Giano Reader ${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
};
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(`latest.json: ${Object.keys(platforms).join(', ')}`);
