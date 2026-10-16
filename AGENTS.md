# Repository instructions

## Pull request titles and releases

- Every pull request title must use Conventional Commits:
  `<type>(optional-scope)!: description`, with the scope and `!` optional.
- Choose the type for the complete change: `feat` for new functionality,
  `fix` for bug fixes, and `perf` for performance improvements. Use `!` for
  breaking changes. Other supported types are `docs`, `style`, `refactor`,
  `test`, `build`, `ci`, `chore`, and `revert`.
- Valid examples: `feat: agent layout`, `fix: scrolling`,
  `perf(sessions): reduce switching latency`, and `feat!: breaking API change`.
- Validate the exact proposed PR title before creating or editing a pull request:
  `PR_TITLE='feat: agent layout' node scripts/check-pr-title.js`.
- Do not use a branch name or an unprefixed summary as the PR title.
  Conventional Commit messages alone do not satisfy the PR-title check; if it
  fails, correct the title of the pull request on GitHub.
- Squash-merge pull requests and preserve the Conventional Commit PR title as
  the squash-commit title so automatic versioning can detect the release type.
- Do not bypass or weaken the title check. `feat` triggers a minor release,
  `fix` and `perf` trigger a patch release, and breaking changes trigger a major
  release. Documentation and maintenance-only changes do not trigger a release.

See [the publishing guide](docs/PUBLISHING.md#commit-titles-and-version-numbers)
for the release workflow and versioning rules.
