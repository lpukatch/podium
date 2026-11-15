const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

for (const workflow of ['.forgejo/workflows/build.yml', '.github/workflows/publish.yml']) {
  const source = fs.readFileSync(path.join(__dirname, '../..', workflow), 'utf8');
  // Execute the actual container shell body with a fake registry client.
  const body = source.match(/regclient\/regctl:[^\s]+ -ec '([^']+)'/)[1];
  const run = (tags, fail = '') => spawnSync('/bin/sh', ['-ec', `
    regctl() {
      if [ "$1" = registry ]; then cat >/dev/null; return; fi
      printf 'COPY %s %s\\n' "$3" "$4"
      [ "$4" != "$FAIL_DEST" ]
    }
    ${body}
  `], {
    encoding: 'utf8',
    env: { ...process.env, REGISTRY: 'registry.example.com', IMAGE_NAME: 'owner/app',
      REGISTRY_USERNAME: 'user', REGISTRY_TOKEN: 'test', IMAGE_REF: 'registry.example.com/owner/app@sha256:abc',
      PROMOTION_TAGS: tags, FAIL_DEST: fail },
  });
  const copies = (result) => result.stdout.split('\n').filter((line) => line.startsWith('COPY '));

  test(`${workflow}: promotes a single main tag without a trailing newline`, () => {
    const result = run('main');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(copies(result), ['COPY registry.example.com/owner/app@sha256:abc registry.example.com/owner/app:main']);
  });
  test(`${workflow}: promotes every release alias including latest`, () => {
    const result = run('1.18.0\n1.18\nlatest');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(copies(result).map((line) => line.split(':').pop()), ['1.18.0', '1.18', 'latest']);
  });
  test(`${workflow}: an empty plan copies nothing`, () => {
    const result = run('');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(copies(result), []);
  });
  test(`${workflow}: a failed copy fails promotion and stops later aliases`, () => {
    const result = run('1.18.0\n1.18\nlatest', 'registry.example.com/owner/app:1.18');
    assert.notEqual(result.status, 0);
    assert.equal(copies(result).length, 2);
    assert.doesNotMatch(result.stdout, /Promoted registry.example.com\/owner\/app:1.18\n/);
  });
}
