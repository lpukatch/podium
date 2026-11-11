const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// The tools npm cannot pin live in mise.toml and are re-stated in the
// workflows; these asserts keep the copies from drifting silently.

test('setup-node pins the same node major as mise.toml', () => {
  const major = read('mise.toml').match(/^node = "(\d+)"$/m)[1];
  // The GitHub mirror too: these tests run there as well, so a mirror-only
  // bump of node-version would fail its own CI until mise.toml moves with it.
  for (const f of [
    '.forgejo/workflows/ci.yml',
    '.forgejo/workflows/build.yml',
    '.github/workflows/ci.yml',
  ]) {
    assert.match(
      read(f),
      new RegExp(`node-version: '${major}'`),
      `${f} node-version should match mise.toml's node = "${major}"`
    );
  }
});

test('bump.yml pins the mise release and checksum that install-mise.sh verifies', () => {
  const bumpYml = read('.forgejo/workflows/bump.yml');
  assert.match(bumpYml, /# renovate: datasource=github-releases depName=jdx\/mise/);
  const version = bumpYml.match(/MISE_VERSION: "?([^"\s]+)"?/)[1];
  const sha = bumpYml.match(/MISE_SHA256: ([0-9a-f]{64})/)[1];
  assert.ok(version, 'MISE_VERSION missing from bump.yml');
  assert.ok(sha, 'MISE_SHA256 missing from bump.yml');
  const installer = read('.ci/scripts/install-mise.sh');
  assert.match(installer, /mise-v\$\{MISE_VERSION\}-linux-x64/);
  assert.match(installer, /sha256sum -c/);
  // The checksum cannot be validated statically; presence and pairing with the
  // version is the contract -- renovate bumps only the version line.
  assert.match(bumpYml, /mise install/);
  assert.match(bumpYml, /mise exec -- sh \.ci\/scripts\/bump\.sh/);
});

test('workflows never reference jdx/mise-action (missing from the forge mirror)', () => {
  for (const f of ['ci.yml', 'build.yml', 'bump.yml']) {
    assert.doesNotMatch(read(`.forgejo/workflows/${f}`), /uses:.*mise-action/);
  }
});
