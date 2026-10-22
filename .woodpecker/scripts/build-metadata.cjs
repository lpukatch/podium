const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const registry = process.env.REGISTRY;
const image = process.env.IMAGE_NAME;
if (!registry || !image || !/^[a-zA-Z0-9.:-]+$/.test(registry) || !/^[a-z0-9._/-]+$/.test(image)) {
  throw new Error('Set registry (hostname[:port]) and image_name (owner/podium) secrets');
}

const event = process.env.CI_PIPELINE_EVENT;
const tag = process.env.CI_COMMIT_TAG;
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const metadata = {
  PLUGIN_REPO: `${registry}/${image}`,
  // The plugin parses cache_from as a list; escape its literal comma.
  PLUGIN_CACHE_FROM: String.raw`type=registry\,ref=${registry}/${image}:buildcache`,
  PLUGIN_DRY_RUN: event === 'pull_request' ? 'true' : 'false',
};

let tags;
if (event === 'tag') {
  if (!/^v\d+\.\d+\.\d+$/.test(tag || '')) {
    throw new Error('Release image tags must have the form vX.Y.Z');
  }
  const released = tag.slice(1);
  tags = [released, released.split('.').slice(0, 2).join('.'), 'latest'];
  metadata.PODIUM_BUILD_VERSION = version;
} else {
  tags = [event === 'pull_request' ? `pr-${process.env.CI_COMMIT_PULL_REQUEST}` : 'main'];
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  metadata.PODIUM_BUILD_VERSION = `${version}+g${sha}`;
}

// PRs only read the cache. Only main/tag builds publish images or cache layers.
metadata.PLUGIN_CACHE_TO = event === 'pull_request'
  ? ''
  : `type=registry,ref=${registry}/${image}:buildcache,mode=max`;
fs.writeFileSync('.tags', `${tags.join('\n')}\n`);
// Single-quoted dotenv values preserve the cache list escape and prevent expansion.
fs.writeFileSync('.woodpecker-build.env', Object.entries(metadata)
  .map(([key, value]) => `${key}='${value}'`).join('\n') + '\n');
