# Woodpecker CI

The upstream Forgejo repository uses the workflows in `.woodpecker/`.
The GitHub mirror still uses `.github/workflows/`; its publishing and release
behavior is unchanged. `.forgejo/default_merge_message/` is also unchanged.

## Setup

1. Enable the repository in Woodpecker using its Forgejo integration. Leave the
   pipeline path empty (auto-detection), or set it to `.woodpecker/`.
2. Enable push, pull-request, tag, and manual events. Keep approval required for
   forked pull requests and review their pipeline changes before approval.
3. On the Woodpecker server, allowlist the pinned Buildx plugin for privileged
   execution:

   ```sh
   WOODPECKER_PLUGINS_PRIVILEGED=woodpeckerci/plugin-docker-buildx:6.1.2
   ```

   Keep this setting in sync when updating the plugin image. The Docker backend
   needs a Linux amd64 runner that can run Docker-in-Docker. No host Docker socket
   mount or blanket trusted-repository setting is needed.
4. Create these repository secrets (Forgejo Actions variables/secrets are not
   automatically imported):

   | Secret | Value | Events |
   | --- | --- | --- |
   | `registry` | Registry hostname, optionally with port; no scheme | push, pull_request, tag, manual |
   | `image_name` | Image path, e.g. `you/podium` | push, pull_request, tag, manual |
   | `registry_username` | Registry service account username | push, pull_request, tag, manual |
   | `registry_token` | Registry token (existing `REGISTRY_TOKEN`) | push, pull_request, tag, manual |
   | `bypass_token` | Forgejo token allowed to push main and tags (existing `BYPASS_TOKEN`) | **manual only** |
   | `package_token` | Forgejo token with only `package:write` scope; saves trivy scan reports to the generic package registry | push, manual, tag |

   PRs require registry access to read the private build cache, as before. Giving
   credentials to PR code is inherently sensitive: prefer read-only credentials
   for PR events and never approve untrusted changes with write credentials.
   Scope the bypass token to this repository. The clone URL must use HTTPS for
   the release script's token authentication.
5. Update Forgejo branch-protection required checks to the new Woodpecker check
   names after the first run. Remove the old Actions check requirements.
6. Disable the **Actions** unit in the upstream Forgejo repository's **Settings**
   once Woodpecker is working. This is a repository setting, not a Git change:
   it prevents Forgejo from running the GitHub workflows as a fallback after
   `.forgejo/workflows/` is removed. Leave GitHub Actions enabled on the mirror
   and leave the shared Forgejo runner running for other repositories.

## Checks and images

- Pushes and PRs targeting `main`: a gitleaks scan of the full commit history
  (Forgejo has no server-side secret scanning, and the GitHub mirror makes
  every landed commit public), plus format/lint, type checks, tests with real
  ffprobe, and an amd64 Docker build.
- Pushes to `main`: validate, build a candidate, scan its digest, then promote
  it to `:main`. Builds also refresh `:buildcache` (a build cache, not a release).
- PRs: build without publishing an image or writing the cache.
- Tags `vX.Y.Z`: run validation, build and scan a candidate, then promote
  `:X.Y.Z`, `:X.Y`, and `:latest` without rebuilding.
- Manual pipelines on `main`: checks and a `:main` image, unless `RELEASE=true`.
- Every candidate image is scanned with trivy (pinned `aquasec/trivy` image);
  the pipeline fails on HIGH or CRITICAL findings that have an available fix.
  The scan runs after pushing a run-specific `candidate-*` tag, but before
  moving any consumer tag. Both scanning and promotion use the same digest,
  so another build cannot change the image being checked. Failed candidates
  stay in the registry for investigation but are never promoted. Accepted findings go in
  `.trivyignore`, one line each with a reason and a removal condition. If the
  registry presents an internal CA the trivy container cannot verify, set
  `TRIVY_INSECURE=true` on the `image-scan` step.
- Findings live in two places. The full table is printed into the pipeline log
  even when the gate fails, and the `save-scan-report` step publishes the
  report to the upstream Forgejo's generic package registry — one report per
  commit at `podium-trivy/<commit sha>/trivy-<ref>.txt` — so each build's
  findings stay addressable after logs rotate. That upload runs even when the
  gate failed and is best-effort (`failure: ignore`): it never masks the
  gate's verdict. It derives the Forgejo host from the runtime clone URL, so
  no hostname is committed here.

Only tag builds move `latest`. Non-tag app versions include the short commit
SHA. Docker media types and disabled provenance preserve Unraid compatibility.
The build workflow depends on successful `ci` validation, including tag events.
Publishing is serialized (`concurrency.limit: 1`). Before promotion, current
remote refs are checked: stale main builds skip `:main`; older releases still
get their version tag but do not overwrite aliases belonging to newer Git tags.
This is intentionally conservative even if a newer tag's build failed. GitHub
uses the same promotion planner, a reusable validation workflow, and one
publication concurrency group. Tag updates are sequential, not transactional;
retry a failed promotion to repair partially updated aliases.

`regclient/regctl:v0.11.7-alpine` resolves candidate digests and copies manifests
without Docker-in-Docker or rebuilding. Candidate tags and scan packages need
a registry retention policy; do not delete a candidate while its scan is running.
The generated BuildKit exporter explicitly sets `push=true` for publishing and
`push=false` for PRs. With a custom exporter, the plugin's `dry_run` flag alone
does not control exporter pushes, and omitting `push=` invokes a separate
`docker push` that cannot see BuildKit's image store.
The build explicitly sets `tags_file: .tags`: the pinned plugin splits that file
on newlines. Its implicit `.tags` CLI source does not split newlines, so release
tags otherwise collapse into one invalid image reference.

Build metadata is generated at runtime so the registry hostname is not committed
to the public mirror. No registry password is written into the build context.

## Release

Start a **new manual pipeline on `main`** in Woodpecker, adding custom variables:

```text
RELEASE=true
BUMP_TYPE=auto
```

`BUMP_TYPE` defaults to `auto`; `patch`, `minor`, and `major` are also supported.
Without `RELEASE=true`, a manual pipeline never bumps the version.

The release commit also carries `CHANGELOG.md`: bump.sh generates the new
release's section with git-cliff (`cliff.toml` is the template) and prepends
it. The version and checksum of the git-cliff build are pinned in `bump.yml`
(`# renovate:` annotation) with matching defaults in bump.sh for local
releases; a checksum mismatch aborts the release. The GitHub release body is
read back out of `CHANGELOG.md`, so what users read in the repo is what they
get on releases.

The release workflow fetches current `main` and all tags, skips if there are no
commits since the last release, and derives the bump from Conventional Commit
subjects. It updates `package.json`, commits, and pushes an annotated tag using
the bypass token. The changelog is printed in the job log. The pushed tag starts
the image build and, after mirroring, the existing GitHub release workflow.
Release bump workflows are serialized and depend on validation. If main advances
after that validation, the bump refuses to release; start a new manual pipeline.

### Release from a local checkout

From a clean `main` checkout with Git push access, run:

```sh
npm run release:bump -- minor
```

Use `patch`, `minor`, `major`, or `auto` (the default). The command fetches main
and tags, fast-forwards to main, updates both package files, and atomically
pushes the release commit and annotated tag. The tag triggers Woodpecker image
publishing and the mirrored GitHub release. Local releases use your existing
Git authentication; no Woodpecker token is needed.
