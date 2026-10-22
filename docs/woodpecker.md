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

- Pushes and PRs targeting `main`: format/lint, type checks, tests with real
  ffprobe, and an amd64 Docker build.
- Pushes to `main`: publish `:main` and refresh `:buildcache`.
- PRs: build without publishing an image or writing the cache.
- Tags `vX.Y.Z`: publish `:X.Y.Z`, `:X.Y`, and `:latest` and refresh the cache.
- Manual pipelines on `main`: checks and a `:main` image, unless `RELEASE=true`.

Only tag builds move `latest`. Non-tag app versions include the short commit
SHA. Docker media types and disabled provenance preserve Unraid compatibility.
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

The release workflow fetches current `main` and all tags, skips if there are no
commits since the last release, and derives the bump from Conventional Commit
subjects. It updates `package.json`, commits, and pushes an annotated tag using
the bypass token. The changelog is printed in the job log. The pushed tag starts
the image build and, after mirroring, the existing GitHub release workflow.
Run only one release pipeline at a time.
