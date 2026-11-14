const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// The Actions runner's docker daemon cannot resolve the job container's
// workspace path: a `-v "$PWD":...` bind silently presents an EMPTY directory
// (docker auto-creates the source). During the 2026-11 publish outage this
// made trivy fatal on its --ignorefile at flag conversion on every run, made
// the regctl promotion read nothing from its plan files, and let gitleaks
// pass green while scanning nothing -- gitleaks logs a scan failure but exits
// 0 (gitleaks cmd/git.go: "don't exit on error, just log it"). Workspace
// content reaches a docker run only through streams (tar over stdin, the
// buildx context) or env -- never through a $PWD bind mount.

test('no docker run step binds the workspace path', () => {
  for (const rel of [
    '.forgejo/workflows/ci.yml',
    '.forgejo/workflows/build.yml',
    '.forgejo/workflows/bump.yml',
    '.github/workflows/ci.yml',
    '.github/workflows/publish.yml',
  ]) {
    assert.doesNotMatch(
      read(rel),
      /docker run[^\n]*-v "\$PWD/,
      `${rel}: workspace bind mount found; deliver the content via env or a tar stream instead`
    );
  }
});

test('gitleaks receives the tree as a tar stream and fails the step on failure', () => {
  for (const rel of ['.forgejo/workflows/ci.yml', '.forgejo/workflows/build.yml']) {
    const line = read(rel).match(/^.*tar -c --exclude=\.\/node_modules \. \| docker run.*$/m);
    assert.ok(line, `${rel}: tar-streamed gitleaks step missing`);
    // exec makes gitleaks' exit code the wrapper's -- a silent no-op must
    // not be possible again.
    assert.match(line[0], /exec gitleaks git --no-banner/);
  }
});

test('the promotion reads its plan files job-side and passes them as env', () => {
  for (const rel of ['.forgejo/workflows/build.yml', '.github/workflows/publish.yml']) {
    const text = read(rel);
    assert.match(text, /-e IMAGE_REF="\$\(cat \.image-ref\)"/);
    assert.match(text, /-e PROMOTION_TAGS="\$\(cat \.promotion-tags\)"/);
  }
});

test('the trivy scan passes the image ref and ignore content as env, not files', () => {
  const build = read('.forgejo/workflows/build.yml');
  assert.match(build, /-e IMAGE_REF /);
  assert.match(build, /-e PODIUM_TRIVY_IGNORES="\$\(cat \.trivyignore\)"/);
});
