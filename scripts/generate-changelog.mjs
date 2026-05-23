import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = packageJson.version;
const tag = `v${version}`;
const releaseDate = process.env.RELEASE_DATE ?? new Date().toISOString().slice(0, 10);
const repository = getRepository();
const image = `ghcr.io/${repository.toLowerCase()}:${version}`;

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function getRepository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;

  const url = packageJson.repository?.url ?? '';
  const match = url.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/);
  if (match) return match[1];

  return 'bitsocialnet/bitsocial-seeder';
}

function parseVersion(input) {
  const match = input.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return match.slice(1).map((part) => Number(part));
}

function compareVersions(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function findPreviousTag() {
  const current = parseVersion(version);
  if (!current) return null;

  const tags = git(['tag', '--list', 'v[0-9]*', '--sort=-v:refname'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const candidate of tags) {
    const parsed = parseVersion(candidate);
    if (parsed && compareVersions(parsed, current) < 0) return candidate;
  }

  return null;
}

function getCommits(previousTag) {
  const range = previousTag ? `${previousTag}..HEAD` : 'HEAD';
  const output = git(['log', '--reverse', '--no-merges', '--format=%H%x00%s', range]);
  if (!output) return [];

  return output
    .split('\n')
    .map((line) => {
      const [hash, subject] = line.split('\0');
      return { hash, subject };
    })
    .filter((commit) => commit.hash && commit.subject)
    .filter((commit) => commit.subject !== `chore(release): update changelog for ${tag}`);
}

function buildSection(previousTag) {
  const releaseUrl = previousTag
    ? `https://github.com/${repository}/compare/${previousTag}...${tag}`
    : `https://github.com/${repository}/releases/tag/${tag}`;
  const commits = getCommits(previousTag);
  const changes = commits.length
    ? commits.map((commit) => {
        const shortHash = commit.hash.slice(0, 7);
        return `- ${commit.subject} ([${shortHash}](https://github.com/${repository}/commit/${commit.hash}))`;
      })
    : ['- No code changes.'];

  return [
    `## [${version}](${releaseUrl}) (${releaseDate})`,
    '',
    `Docker image: \`${image}\``,
    '',
    '### Changes',
    '',
    ...changes,
  ].join('\n');
}

function updateChangelog(section) {
  const changelogPath = resolve(root, 'CHANGELOG.md');
  const existing = existsSync(changelogPath)
    ? readFileSync(changelogPath, 'utf8').replaceAll('\r\n', '\n').trim()
    : '# Changelog';
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^## \\[${escapedVersion}\\]`, 'm');
  const match = header.exec(existing);

  if (match) {
    const next = existing.slice(match.index + 1).search(/\n## \[/);
    const end = next === -1 ? existing.length : match.index + 1 + next;
    const updated = `${existing.slice(0, match.index).trimEnd()}\n\n${section}\n\n${existing.slice(end).trimStart()}`.trim();
    writeFileSync(changelogPath, `${updated}\n`);
    return;
  }

  const withoutTitle = existing.replace(/^# Changelog\s*/u, '').trim();
  const updated = ['# Changelog', '', section, withoutTitle ? `\n${withoutTitle}` : ''].join('\n').trim();
  writeFileSync(changelogPath, `${updated}\n`);
}

updateChangelog(buildSection(findPreviousTag()));
