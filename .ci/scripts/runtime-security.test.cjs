const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const dockerfile = fs.readFileSync(path.join(__dirname, '../../Dockerfile'), 'utf8');
const runtime = dockerfile.split('AS runtime\n')[1];

test('runtime explicitly upgrades inherited packages alongside runtime dependencies', () => {
  assert.match(runtime, /apt-get update \\\n\s*&& apt-get install -y --no-install-recommends ffmpeg tini zlib1g/);
  assert.match(runtime, /&& apt-get upgrade -y --no-install-recommends/);
});

test('runtime rejects packages older than Debian security fixes without pinning future updates', () => {
  assert.match(runtime, /dpkg --compare-versions "\$\(dpkg-query -W -f='\$\{Version\}' zlib1g\)" ge '1:1\.3\.dfsg\+really1\.3\.1-1\+deb13u1'/);
  assert.match(runtime, /dpkg --compare-versions "\$\(dpkg-query -W -f='\$\{Version\}' libkrb5-3\)" ge '1\.21\.3-5\+deb13u2'/);
  assert.doesNotMatch(runtime, /apt-get install[^\n]*zlib1g=/);
  assert.doesNotMatch(runtime, /apt-get install[^\n]*libkrb5-3=/);
});
