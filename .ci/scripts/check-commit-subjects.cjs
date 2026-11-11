'use strict';

const { execFileSync } = require('node:child_process');

// The release job reads commit subjects to pick the next version
// (.ci/scripts/bump.sh), so a subject that is not a conventional
// commit is not just untidy -- `feature:` instead of `feat:` silently
// downgrades the next release from a minor to a patch. MR pipelines enforce
// the same families bump.sh acts on.
//
// Merge commits are excluded: the forge writes their subjects ("Merge pull
// request ..."), and a merge of main into the branch carries none of this
// branch's changes. `git revert`'s default subject ("Revert \"...\\"") is
// accepted too -- rejecting a legitimate revert teaches people to hide it.
const TYPES = 'feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert';
const CONVENTIONAL = new RegExp(`^(${TYPES})(\\([\\w./-]+\\))?!?: .+`);
const GIT_REVERT = /^Revert "/;

function validate(subjects) {
  return subjects.filter((subject) => !CONVENTIONAL.test(subject) && !GIT_REVERT.test(subject));
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function main() {
  // The default clone is shallow; the range needs the full history and the
  // main ref (the clone plugin only guarantees the pipeline's own ref).
  if (git('rev-parse', '--is-shallow-repository').trim() === 'true') {
    execFileSync('git', ['fetch', '--unshallow', 'origin'], { stdio: 'inherit' });
  }
  git('fetch', 'origin', 'main');
  const commits = git('log', 'origin/main..HEAD', '--no-merges', '--pretty=format:%h%x09%s')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      return { hash: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
  const offenders = validate(commits.map((commit) => commit.subject));
  if (offenders.length === 0) {
    console.log(`commit-subjects: ${commits.length} commit(s) OK`);
    return;
  }
  console.error('Commit subjects must be Conventional Commits (see CONTRIBUTING.md):');
  console.error(`  <type>(<scope>)?[!]: <subject>   types: ${TYPES.replace(/\|/g, ' ')}`);
  console.error('Offending commits:');
  for (const commit of commits) {
    if (offenders.includes(commit.subject)) console.error(`  ${commit.hash} ${commit.subject}`);
  }
  console.error('The release job reads these subjects to pick patch/minor/major;');
  console.error('a non-conventional one silently downgrades the next release.');
  process.exitCode = 1;
}

module.exports = { validate };

if (require.main === module) main();
