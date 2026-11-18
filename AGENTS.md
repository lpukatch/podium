# Repository Agent Guidelines

## Workflow & Publication
- Work in an isolated git worktree and dedicated branch; never modify or discard unrelated uncommitted work.
- Open **at most one draft PR** per run and **never** merge, self-approve, or enable auto-merge.
- **Commit subjects** must follow Conventional Commits (`feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert`), enforced by `.ci/scripts/check-commit-subjects.cjs`.
- Never commit or print credentials, tokens, or sensitive logs.

## Local Validation
If `origin/main`, owned PRs, and open issues are unchanged since the last run, skip rerunning the full suite. Otherwise, run:
```bash
npm run format:check
npm run type-check
npm run test:run
```
