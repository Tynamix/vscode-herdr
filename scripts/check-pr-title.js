'use strict';

function validTitle(title) {
  return /^(feat|fix|perf|docs|style|refactor|test|build|ci|chore|revert)(\([^\r\n)]+\))?!?: [^\s].*$/.test(title || '');
}

if (require.main === module && !validTitle(process.env.PR_TITLE)) {
  console.error('Use a Conventional Commit PR title, for example "feat: agent layout", "fix: scrolling" or "feat!: breaking API change". Squash-merge with this title so automatic versioning can detect the release type.');
  process.exitCode = 1;
}

module.exports = { validTitle };
