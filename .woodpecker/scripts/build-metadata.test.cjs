const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

for (const event of ['push', 'pull_request', 'tag', 'manual']) {
  test(`${event}: exporter, tags and cache publication agree`, () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-build-metadata-'));
    try {
      const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
      fs.writeFileSync(path.join(cwd, 'package.json'), '{"version":"1.2.3"}\n');
      git('init');
      git('add', 'package.json');
      git('-c', 'user.name=CI test', '-c', 'user.email=ci@example.com', 'commit', '-m', 'test');
      execFileSync(process.execPath, [path.join(__dirname, 'build-metadata.cjs')], {
        cwd,
        env: {
          ...process.env,
          REGISTRY: 'registry.example.com',
          IMAGE_NAME: 'you/podium',
          CI_PIPELINE_EVENT: event,
          CI_COMMIT_TAG: 'v1.2.3',
          CI_COMMIT_PULL_REQUEST: '317',
        },
      });

      const metadata = Object.fromEntries(fs.readFileSync(path.join(cwd, '.woodpecker-build.env'), 'utf8')
        .trim().split('\n').map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 2, -1)];
        }));
      const publish = event !== 'pull_request';
      assert.equal(metadata.PLUGIN_OUTPUT, `type=image,oci-mediatypes=false,push=${publish}`);
      assert.equal(metadata.PLUGIN_DRY_RUN, String(!publish));
      assert.equal(metadata.PLUGIN_CACHE_TO, publish
        ? 'type=registry,ref=registry.example.com/you/podium:buildcache,mode=max' : '');
      assert.equal(metadata.PLUGIN_CACHE_FROM, String.raw`type=registry\,ref=registry.example.com/you/podium:buildcache`);
      const tags = fs.readFileSync(path.join(cwd, '.tags'), 'utf8').trim().split('\n');
      assert.deepEqual(tags, event === 'tag' ? ['1.2.3', '1.2', 'latest']
        : event === 'pull_request' ? ['pr-317'] : ['main']);
      assert.equal(metadata.PODIUM_BUILD_VERSION, event === 'tag'
        ? '1.2.3' : `1.2.3+g${git('rev-parse', '--short', 'HEAD').toString().trim()}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}
