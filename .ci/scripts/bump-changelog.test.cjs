const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// The changelog is generated once per release by bump.sh (git-cliff), and the
// GitHub release body is read back out of the committed file. Three files
// share that contract; these asserts keep them from drifting apart silently.

test('CHANGELOG.md starts with the exact header cliff.toml declares', () => {
  // --prepend keeps only the matching block; a mismatched header would sink
  // the file's existing intro below the generated sections.
  const declared = read('cliff.toml').match(/header = """\n([\s\S]*?)"""/)[1];
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.startsWith(declared), 'CHANGELOG.md header drifted from cliff.toml');
});

test('section headings stay exactly "## " + tag', () => {
  // bump.sh passes --tag v$NEW_VERSION; publish.yml extracts with an
  // exact-line match against that heading (no date, no decoration), and
  // "## v1.1" must never match "## v1.18".
  const body = read('cliff.toml');
  assert.match(body, /## \{\{ version \}\}/);
  const publish = read('.github/workflows/publish.yml');
  assert.match(publish, /awk -v h="## \$\{TAG#v\}" '\$0 == h/);
  const changelog = read('CHANGELOG.md');
  assert.match(changelog, /^## v\d+\.\d+\.\d+$/m);
});

test('bump.sh prepends the generated section into the release commit', () => {
  const bump = read('.ci/scripts/bump.sh');
  assert.match(bump, /--unreleased --tag "v\$NEW_VERSION" --prepend CHANGELOG\.md/);
  assert.match(bump, /git add package\.json package-lock\.json CHANGELOG\.md/);
});

test('bump.yml supplies the validated commit SHA required by bump.sh', () => {
  const bump = read('.ci/scripts/bump.sh');
  assert.match(bump, /"\$\(git rev-parse origin\/main\)" != "\$CI_COMMIT_SHA"/);
  const workflow = read('.forgejo/workflows/bump.yml');
  assert.match(workflow, /^\s+CI_COMMIT_SHA: \$\{\{ github\.sha \}\}$/m);
});

test('git-cliff runs through mise with its version pinned in mise.toml', () => {
  const bump = read('.ci/scripts/bump.sh');
  assert.match(bump, /mise exec -- git-cliff --unreleased/);
  // The hand-rolled version+sha256 pair must stay gone: mise.toml is the only
  // pin now, and the workflows install git-cliff via mise-action.
  assert.doesNotMatch(bump, /GIT_CLIFF_(VERSION|SHA256)/);
  assert.doesNotMatch(read('.forgejo/workflows/bump.yml'), /GIT_CLIFF_/);
  assert.match(read('mise.toml'), /"git-cliff" = "\d+\.\d+\.\d+"/);
});
