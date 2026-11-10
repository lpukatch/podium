const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

// Call only after the scan passed, inside the serialized publishing workflow.
// Consult current remote refs: queue order is not necessarily commit order.
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sha = git('rev-parse', 'HEAD');
const refs = git('ls-remote', 'origin', 'refs/heads/main', 'refs/tags/v*');
const event = process.env.CI_PIPELINE_EVENT;
let tags = [];
if (event === 'tag') {
  const tag = process.env.CI_COMMIT_TAG;
  if (!/^v\d+\.\d+\.\d+$/.test(tag || '')) throw new Error('Invalid release tag');
  const version = tag.slice(1);
  if (version !== JSON.parse(fs.readFileSync('package.json', 'utf8')).version) {
    throw new Error('Release tag must match package.json version');
  }
  const compare = (a, b) => {
    const x = a.split('.').map(Number);
    const y = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  };
  const versions = refs.split('\n').flatMap((line) => {
    const match = line.match(/\trefs\/tags\/v(\d+\.\d+\.\d+)$/);
    return match ? [match[1]] : [];
  });
  const minor = version.split('.').slice(0, 2).join('.');
  tags = [version];
  if (!versions.some((v) => v.startsWith(`${minor}.`) && compare(v, version) > 0)) tags.push(minor);
  if (!versions.some((v) => compare(v, version) > 0)) tags.push('latest');
} else if (['push', 'manual'].includes(event)) {
  if (refs.split('\n').some((line) => line === `${sha}\trefs/heads/main`)) tags = ['main'];
} else {
  throw new Error('Only publishing events may promote images');
}
fs.writeFileSync('.promotion-tags', tags.length ? `${tags.join('\n')}\n` : '');
console.log(tags.length ? `Promoting: ${tags.join(', ')}` : 'Stale main build: skipping promotion');
