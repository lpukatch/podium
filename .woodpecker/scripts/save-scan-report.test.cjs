const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// The scan gate writes trivy-report.txt; save-scan-report publishes it to the
// upstream Forgejo's generic package registry. Contracts kept off drift: the
// gate's exit code must survive the report handling, the upload must run
// after a failed gate without being able to fail the pipeline itself, and the
// Forgejo host must stay runtime-derived (this file ships to the public
// mirror, same rule as the registry hostname).

test('the scan gate keeps its exit code through the report handling', () => {
  const build = read('.woodpecker/build.yml');
  assert.match(build, /--exit-code 1 --severity/);
  assert.match(build, /--format table --output trivy-report\.txt/);
  assert.match(build, /\|\| RC=\$\$\?/);
  assert.match(build, /cat trivy-report\.txt/);
  assert.match(build, /exit \$\$\{RC:-0\}/);
});

test('no command scalar ends with a backslash continuation', () => {
  // YAML folds multi-line plain scalars into one line, turning a trailing
  // "\" into "\" + space: a stray positional argument (trivy aborted with
  // "multiple targets cannot be specified" on exactly this). Commands must
  // be one physical line each.
  for (const line of read('.woodpecker/build.yml').split('\n')) {
    const s = line.trim();
    if (s.startsWith('- ')) {
      assert.ok(!s.endsWith('\\'), `continuation folds into a stray arg: ${s}`);
    }
  }
});

test('save-scan-report runs after a failed gate but cannot gate itself', () => {
  const build = read('.woodpecker/build.yml');
  assert.match(build, /- name: save-scan-report/);
  assert.match(build, /status: \[success, failure\]/);
  assert.match(build, /failure: ignore/);
  assert.match(build, /from_secret: package_token/);
});

test('the Forgejo host is derived from the clone URL, not committed', () => {
  const build = read('.woodpecker/build.yml');
  assert.match(build, /CI_REPO_CLONE_URL/);
  assert.match(build, /\/api\/packages\//);
  assert.doesNotMatch(build, /needcoffee/);
});

test('the package token is documented for the events that scan', () => {
  const docs = read('docs/woodpecker.md');
  assert.match(docs, /`package_token`/);
  // PR pipelines publish nothing, so they never need it.
  assert.doesNotMatch(docs, /package_token.*pull_request/);
});
