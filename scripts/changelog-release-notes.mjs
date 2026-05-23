import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = process.argv[2] ?? packageJson.version;
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8').replaceAll('\r\n', '\n');
const lines = changelog.split('\n');
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const versionHeader = new RegExp(`^## \\[${escapedVersion}\\](?:\\(|\\s|$)`);
const start = lines.findIndex((line) => versionHeader.test(line));

if (start === -1) {
  console.error(`Could not find CHANGELOG.md section for ${version}`);
  process.exit(1);
}

const next = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
const section = lines.slice(start, next === -1 ? undefined : next).join('\n').trim();

console.log(`${section}\n`);
