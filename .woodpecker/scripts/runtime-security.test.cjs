const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const dockerfile = fs.readFileSync(path.join(__dirname, '../../Dockerfile'), 'utf8');
const runtime = dockerfile.split('AS runtime\n')[1];

test('runtime explicitly upgrades inherited zlib alongside runtime dependencies', () => {
  assert.match(runtime, /apt-get update \\\n\s*&& apt-get install -y --no-install-recommends ffmpeg tini zlib1g/);
});

test('runtime rejects zlib older than the Debian security fix without pinning future updates', () => {
  assert.match(runtime, /dpkg --compare-versions "\$\(dpkg-query -W -f='\$\{Version\}' zlib1g\)" ge '1:1\.3\.dfsg\+really1\.3\.1-1\+deb13u1'/);
  assert.doesNotMatch(runtime, /apt-get install[^\n]*zlib1g=/);
});
