#!/bin/sh
set -eu

# CI releases require an explicit manual event; local releases use Git auth.
LOCAL=false
if [ "${1:-}" = --local ]; then
  LOCAL=true
  BUMP_TYPE=${2:-auto}
  test "$(git branch --show-current)" = main
  if [ -n "$(git status --porcelain)" ]; then
    echo 'Commit or stash changes before releasing.' >&2
    exit 1
  fi
else
  test "$CI_PIPELINE_EVENT" = manual
  test "$CI_COMMIT_BRANCH" = main
  test "${RELEASE:-}" = true
  : "${BYPASS_TOKEN:?Set the bypass_token secret}"
  BUMP_TYPE=${BUMP_TYPE:-auto}
fi
case "$BUMP_TYPE" in
  auto|patch|minor|major) ;;
  *) echo 'BUMP_TYPE must be auto, patch, minor, or major' >&2; exit 1 ;;
esac

# Fetch the current main and complete tag history even after a shallow clone.
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  git fetch --unshallow origin
fi
git fetch origin main --tags
if [ "$LOCAL" = true ]; then
  git merge --ff-only origin/main
  test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
else
  git checkout -B main origin/main
  git config user.name 'Woodpecker CI'
  git config user.email 'woodpecker@forgejo.local'
fi

LATEST_TAG=$(git tag -l 'v*' --sort=-v:refname | head -n 1)
LATEST_TAG=${LATEST_TAG:-v0.0.0}
if [ "$LATEST_TAG" != v0.0.0 ]; then
  if [ "$(git rev-list "$LATEST_TAG..HEAD" --count)" = 0 ]; then
    echo "No commits since $LATEST_TAG. Nothing to version."
    exit 0
  fi
fi

if [ "$BUMP_TYPE" = auto ]; then
  if [ "$LATEST_TAG" = v0.0.0 ]; then
    BUMP_TYPE=minor
  else
    COMMITS=$(git log "$LATEST_TAG..HEAD" --pretty=format:'%s')
    if printf '%s\n' "$COMMITS" | grep -qiE 'BREAKING CHANGE:|^[a-z]+(\(.+\))?!:'; then
      BUMP_TYPE=major
    elif printf '%s\n' "$COMMITS" | grep -qE '^feat(\(.+\))?:'; then
      BUMP_TYPE=minor
    else
      BUMP_TYPE=patch
    fi
  fi
fi

export LATEST_TAG BUMP_TYPE
NEW_VERSION=$(node <<'NODE'
const fs = require('node:fs');
const current = process.env.LATEST_TAG.slice(1);
if (!/^\d+\.\d+\.\d+$/.test(current)) throw new Error(`Invalid release version: ${current}`);
const v = current.split('.').map(Number);
const index = { major: 0, minor: 1, patch: 2 }[process.env.BUMP_TYPE];
v[index]++;
for (let i = index + 1; i < v.length; i++) v[i] = 0;
const version = v.join('.');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = version;
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
lock.version = version;
lock.packages[''].version = version;
fs.writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
console.log(version);
NODE
)

git add package.json package-lock.json
if ! git diff --cached --quiet; then
  git commit -m "chore(release): v$NEW_VERSION"
fi
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"

if [ "$LOCAL" = true ]; then
  git push --atomic origin HEAD:main "refs/tags/v$NEW_VERSION"
else
# Supply the bypass token only to the push, never in the remote URL or logs.
ASKPASS=$(mktemp)
trap 'rm -f "$ASKPASS"' EXIT
cat > "$ASKPASS" <<'ASKPASS_SCRIPT'
#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' 'oauth2' ;;
  *Password*) printf '%s\n' "$BYPASS_TOKEN" ;;
esac
ASKPASS_SCRIPT
chmod 700 "$ASKPASS"
GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 git -c credential.helper= push --atomic "$CI_REPO_CLONE_URL" HEAD:main "refs/tags/v$NEW_VERSION"
fi

printf '\nReleased v%s (previous: %s)\n\n## Changelog\n' "$NEW_VERSION" "$LATEST_TAG"
if [ "$LATEST_TAG" = v0.0.0 ]; then
  git log "v$NEW_VERSION" --pretty='- %s (%h)'
else
  git log "$LATEST_TAG..v$NEW_VERSION" --pretty='- %s (%h)'
fi
