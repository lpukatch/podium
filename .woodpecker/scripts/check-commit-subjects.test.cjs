const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { validate } = require('./check-commit-subjects.cjs');

test('accepts the subject families the release job acts on', () => {
  assert.deepEqual(validate([
    'feat: new thing',
    'feat(matcher): allow word-level exclusions',
    'fix!: stop dropping lanes',
    'chore(release): v1.17.1',
    'ci(secrets): scan history',
    'docs: explain the bump',
    'refactor(store): split lanes',
    'Revert "feat: new thing"',
  ]), []);
});

test('rejects subjects the release job would misread', () => {
  assert.deepEqual(validate([
    'Feature: capitalised type',
    'feat:no space after colon',
    'feat missing colon entirely',
    'added a thing',
    'Merge pull request \'feat: x\' (#1)',
    'chore(deps):', // type but no subject
    'fix(scope with spaces): unusual scope',
  ]), [
    'Feature: capitalised type',
    'feat:no space after colon',
    'feat missing colon entirely',
    'added a thing',
    'Merge pull request \'feat: x\' (#1)',
    'chore(deps):',
    'fix(scope with spaces): unusual scope',
  ]);
});

test('breaking-change subjects keep their bang', () => {
  assert.deepEqual(validate(['feat!(): missing scope name']), ['feat!(): missing scope name']);
  assert.deepEqual(validate(['feat(probe)!): malformed']), ['feat(probe)!): malformed']);
});

// The gate only runs on merge requests, where the branch's own commits are
// what review sees. These wiring asserts keep the gate and the pipelines in
// sync -- the script's whole value is being in the path for every MR.
test('woodpecker runs the check on pull_request events', () => {
  const ci = fs.readFileSync(path.join(__dirname, '../ci.yml'), 'utf8');
  assert.match(ci, /name: commit-subjects[\s\S]*?when:[\s\S]*?event: pull_request[\s\S]*?check-commit-subjects\.cjs/);
});

test('the mirror workflow runs the check on pull_request events', () => {
  const ci = fs.readFileSync(path.join(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /name: Commit subjects[\s\S]*?if: github\.event_name == 'pull_request'[\s\S]*?check-commit-subjects\.cjs/);
});
