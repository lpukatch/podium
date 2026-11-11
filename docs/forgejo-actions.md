# Forgejo Actions

The upstream Forgejo repository uses the workflows in `.forgejo/workflows/`.
The GitHub mirror still uses `.github/workflows/`; its publishing and release
behavior is unchanged. `.forgejo/default_merge_message/` is also unchanged.
Shared CI scripts live in `.ci/scripts/` and are used by both.

## Setup

1. Enable the **Actions** unit on the repository and register at least one
   Forgejo runner (Ubuntu-based `ubuntu-latest` label with Docker available,
   including inside jobs).
2. Keep branch protection requiring the CI checks; required check names are
   the workflow job names after the first run.
3. Create these repository variables/secrets:

   | Name | Secret? | Value | Events |
   | --- | --- | --- | --- |
   | `REGISTRY` | variable | Registry hostname, optionally with port; no scheme | push, pull_request, tag, manual |
   | `IMAGE_NAME` | variable | Image path, e.g. `you/podium` | push, pull_request, tag, manual |
   | `REGISTRY_USERNAME` | variable | Registry service account username | push, pull_request, tag, manual |
   | `REGISTRY_TOKEN` | secret | Registry token (read :buildcache on PRs; keep PR-scoped credentials read-only) | push, pull_request, tag, manual |
   | `PACKAGE_TOKEN` | secret | Forgejo token with only `package:write` scope; saves trivy scan reports to the generic package registry | push, tag, manual |
   | `BYPASS_TOKEN` | secret | Forgejo token allowed to push main and tags | **manual release only** |

   PRs require registry access to read the private build cache, as before.
   Giving credentials to PR code is inherently sensitive: prefer read-only
   credentials for PR events and never approve untrusted changes with write
   credentials. Scope the bypass token to this repository.

## Checks and images

- Pushes and PRs targeting `main` (`ci.yml`): the `.ci/scripts` contract
  tests, a gitleaks scan of the full commit history (Forgejo has no
  server-side secret scanning, and the GitHub mirror makes every landed
  commit public), a conventional-commit subject check on merge requests,
  plus format/lint, type checks, npm audit of the production closure, tests
  with real ffprobe and a coverage report. PRs additionally get an amd64
  Docker build (read-only against the `:buildcache` cache).
- Pushes to `main` (`build.yml`): validate, build a candidate, scan its
  digest, then promote it to `:main`. Builds also refresh `:buildcache` (a
  build cache, not a release).
- Tags `vX.Y.Z`: run validation, build and scan a candidate, then promote
  `:X.Y.Z`, `:X.Y`, and `:latest` without rebuilding.
- Every candidate image is scanned with trivy (pinned `aquasec/trivy` image);
  the workflow fails on HIGH or CRITICAL findings that have an available fix.
  The scan runs after pushing a run-specific `candidate-*` tag, but before
  moving any consumer tag. Scanning and promotion use the same digest, so
  another build cannot change the image being checked. Failed candidates stay
  in the registry for investigation but are never promoted. Accepted findings
  go in `.trivyignore`, one line each with a reason and a removal condition.
  If the registry presents an internal CA the trivy container cannot verify,
  add `--add-host` style flags or an env knob for `TRIVY_INSECURE=true` on
  the `Scan candidate` step.
- Findings live in two places. The full table is printed into the workflow
  log even when the gate fails, and the `Save scan report` step publishes
  the report to the upstream Forgejo's generic package registry — one report
  per commit at `podium-trivy/<commit sha>/trivy-<ref>.txt` — so each build's
  findings stay addressable after logs rotate. That upload runs even when the
  gate failed and is best-effort (`continue-on-error`): it never masks the
  gate's verdict. The Forgejo host is derived from the runtime server URL, so
  no hostname is committed here.
- Publishing is serialized with a shared `image-publication` concurrency
  group (`build.yml` and `bump.yml`). Before promotion, current remote refs
  are checked: stale main builds skip `:main`; older releases still get their
  version tag but do not overwrite aliases belonging to newer Git tags. This
  is intentionally conservative even if a newer tag's build failed. Tag
  updates are sequential, not transactional; retry a failed promotion to
  repair partially updated aliases.

Only tag builds move `latest`. Non-tag app versions include the short commit
SHA. Docker media types and disabled provenance preserve Unraid compatibility.
`regclient/regctl:v0.11.7-alpine` resolves candidate digests and copies
manifests without Docker-in-Docker or rebuilding. Candidate tags and scan
packages need a registry retention policy; do not delete a candidate while its
scan is running.

The registry hostname is configured in Actions variables, so it is never
committed to the public mirror, and no registry password is written into the
build context.

## Release

Run the **Version Bump** workflow (`bump.yml`) on `main`, choosing `BUMP_TYPE`
(`auto`, the default, or `patch`, `minor`, `major`).

`bump.sh` fetches current `main` and all tags, skips if there are no commits
since the last release, and derives the bump from Conventional Commit
subjects. It updates `package.json` and `package-lock.json`, commits, and
pushes an annotated tag using the bypass token. The changelog is printed in
the job log. The pushed tag starts the image build and, after mirroring, the
existing GitHub release workflow.

The release commit also carries `CHANGELOG.md`: bump.sh generates the new
release's section with git-cliff (`cliff.toml` is the template) and prepends
it. The version and checksum of the git-cliff build are pinned in `bump.yml`
(`# renovate:` annotation) with matching defaults in bump.sh for local
releases; a checksum mismatch aborts the release. The GitHub release body is
read back out of `CHANGELOG.md`, so what users read in the repo is what they
get on releases.

### Release from a local checkout

From a clean `main` checkout with Git push access, run:

```sh
npm run release:bump -- minor
```

Use `patch`, `minor`, `major`, or `auto` (the default). The command fetches main
and tags, fast-forwards to main, updates both package files, and atomically
pushes the release commit and annotated tag. The tag triggers Forgejo image
publishing and the mirrored GitHub release. Local releases use your existing
Git authentication; no CI token is needed.
