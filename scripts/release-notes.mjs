// Prints the notes of the latest release from RELEASE.md: the first
// "## … Changelog …" section, up to the next changelog or the next "# "
// release heading. (The release section of RELEASE.md can hold the changelogs
// of several versions, newest first.)
//
// Usage: node scripts/release-notes.mjs RELEASE.md > release-notes.md
import fs from 'node:fs';

const file = process.argv[2] || 'RELEASE.md';
const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
const isChangelog = l => /^## .*Changelog/i.test(l);
const start = lines.findIndex(isChangelog);
if (start < 0) {
  console.error(`${file}: no "## … Changelog" section found`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && (isChangelog(l) || /^# /.test(l)));
if (end < 0) end = lines.length;
const body = lines.slice(start, end).join('\n').trim();
// a trailing horizontal rule separating releases is not part of the notes
process.stdout.write(body.replace(/\n-{3,}\s*$/, '').trim() + '\n');
