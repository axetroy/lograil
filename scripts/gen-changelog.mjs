// Generates CHANGELOG.md (Keep a Changelog style) from git tags + commits.
// Safe to run anywhere with a git checkout; never throws on missing history.
/* global console */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function sortTags(tags) {
  return [...tags].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
  );
}

const tags = sortTags(sh('git tag -l "v*"').split('\n').filter(Boolean));
const HEAD = 'HEAD';

function commitsBetween(from, to) {
  const range = from ? `${from}..${to}` : to;
  return sh(`git log ${range} --pretty=format:%s`).split('\n').filter(Boolean);
}

function groupCommits(commits) {
  const seen = new Set();
  const out = [];
  for (const c of commits) {
    const line = c.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(`- ${line}`);
  }
  return out;
}

function section(version, ref, commits) {
  const date = sh(`git log -1 --format=%cs ${ref}`);
  const body = commits.length ? groupCommits(commits).join('\n') : '- (no notable changes)';
  return `## [${version}] - ${date || 'unreleased'}\n\n${body}\n`;
}

const parts = [];
parts.push(
  '# Changelog\n\n' +
    'All notable changes to this project are documented in this file.\n\n' +
    'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). ' +
    'This file is generated from git history by `scripts/gen-changelog.mjs` ' +
    '(run via `yarn changelog`) and refreshed automatically on each release.\n',
);

if (tags.length) {
  const latest = tags[tags.length - 1];
  const unreleased = commitsBetween(latest, HEAD);
  if (unreleased.length) {
    parts.push(section('Unreleased', HEAD, unreleased));
  }
  for (let i = tags.length - 1; i >= 0; i--) {
    const tag = tags[i];
    const prev = i > 0 ? tags[i - 1] : null;
    const commits = commitsBetween(prev, tag);
    parts.push(section(tag, tag, commits));
  }
} else {
  parts.push(section('Unreleased', HEAD, commitsBetween(null, HEAD)));
}

const compareLinks = tags
  .map((t, i) => {
    const prev = i > 0 ? tags[i - 1] : t;
    return `[${t}]: https://github.com/axetroy/lograil/compare/${prev}...${t}`;
  })
  .join('\n');

writeFileSync(
  'CHANGELOG.md',
  parts.join('\n') + (compareLinks ? `\n${compareLinks}\n` : '\n'),
  'utf8',
);
console.log(`CHANGELOG.md generated (${tags.length} tag(s)).`);
