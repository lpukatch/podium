const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// The scan gate writes trivy-report.txt; save-scan-report publishes it to the
// upstream Forgejo's generic package registry. Contracts kept off drift: the
// gate's exit code must survive the report handling, the upload must run
// after a failed gate without being able to fail the workflow itself, and the
// Forgejo host must stay runtime-derived (this file ships to the public
// mirror, same rule as the registry hostname).

test('the scan gate keeps its exit code through the report handling', () => {
  const build = read('.forgejo/workflows/build.yml');
  assert.match(build, /--exit-code 1 --severity/);
  assert.match(build, /--format table --output \/tmp\/trivy-report\.txt/);
  assert.match(build, /> trivy-report\.txt \|\| RC=\$\?/);
  assert.match(build, /cat trivy-report\.txt \|\| true/);
  assert.match(build, /exit "\$\{RC:-0\}"/);
  // The ignorefile must be regenerated inside the trivy container: trivy
  // fatals at flag conversion on an --ignorefile that does not exist, and a
  // bind mount cannot deliver workspace files to this runner (see
  // docker-workspace-mounts.test.cjs).
  assert.match(build, /printf "%s" "\$PODIUM_TRIVY_IGNORES" > \/tmp\/\.trivyignore/);
});

test('no command scalar ends with a backslash continuation', () => {
  // YAML folds multi-line plain scalars into one line, turning a trailing
  // "\" into "\" + space: a stray positional argument (trivy aborted with
  // "multiple targets cannot be specified" on exactly this). Commands must
  // be one physical line each.
  for (const rel of ['.forgejo/workflows/build.yml', '.forgejo/workflows/bump.yml']) {
    for (const line of read(rel).split('\n')) {
      const s = line.trim();
      if (s.startsWith('- ') || s.startsWith('run: ')) {
        assert.ok(!s.endsWith('\\'), `${rel}: continuation folds into a stray arg: ${s}`);
      }
    }
  }
});

test('save-scan-report runs after a failed gate but cannot gate itself', () => {
  const build = read('.forgejo/workflows/build.yml');
  assert.match(build, /- name: Save scan report/);
  assert.match(build, /if: always\(\) && hashFiles\('trivy-report\.txt'\) != ''/);
  assert.match(build, /continue-on-error: true/);
  assert.match(build, /PACKAGE_TOKEN: \$\{\{ secrets\.PACKAGE_TOKEN \}\}/);
});

test('report uploads have connection and transfer timeouts', () => {
  const build = read('.forgejo/workflows/build.yml');
  assert.match(build, /curl -fsS --retry 3 --connect-timeout 10 --max-time 120/);
});

test('the Forgejo host is derived from the runtime URL, not committed', () => {
  const build = read('.forgejo/workflows/build.yml');
  assert.match(build, /GITHUB_SERVER_URL/);
  assert.match(build, /\/api\/packages\//);
  assert.doesNotMatch(build, /needcoffee/);
});

test('the package token is documented for the events that scan', () => {
  const docs = read('docs/forgejo-actions.md');
  assert.match(docs, /`PACKAGE_TOKEN`/);
  // PR pipelines publish nothing, so they never need it.
  assert.doesNotMatch(docs, /PACKAGE_TOKEN.*pull_request/);
});
