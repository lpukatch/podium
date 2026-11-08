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
  const bump = read('.woodpecker/scripts/bump.sh');
  assert.match(bump, /--unreleased --tag "v\$NEW_VERSION" --prepend CHANGELOG\.md/);
  assert.match(bump, /git add package\.json package-lock\.json CHANGELOG\.md/);
});

test('bump.yml pins the git-cliff version and checksum bump.sh defaults to', () => {
  const bumpYml = read('.woodpecker/bump.yml');
  assert.match(bumpYml, /# renovate: datasource=github-releases depName=orhun\/git-cliff/);
  const pinned = bumpYml.match(/GIT_CLIFF_VERSION: "?([^"\s]+)"?/)[1];
  const sha = bumpYml.match(/GIT_CLIFF_SHA256: ([0-9a-f]{64})/)[1];
  const bump = read('.woodpecker/scripts/bump.sh');
  assert.match(bump, new RegExp(`GIT_CLIFF_SHA256:-${sha}`));
  assert.match(bump, new RegExp(`GIT_CLIFF_VERSION:-${pinned.replace(/\./g, '\\.')}`));
});
