const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('promotion plans reject stale main builds and preserve newer release aliases', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-promotion-'));
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'CI test');
    git('config', 'user.email', 'ci@example.com');
    git('commit', '--allow-empty', '-m', 'first');
    const old = git('rev-parse', 'HEAD');
    git('remote', 'add', 'origin', cwd);
    const plan = (event, tag = '') => {
      fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ version: tag.slice(1) }));
      execFileSync(process.execPath, [path.join(__dirname, 'promotion-plan.cjs')], {
        cwd, env: { ...process.env, CI_PIPELINE_EVENT: event, CI_COMMIT_TAG: tag },
      });
      return fs.readFileSync(path.join(cwd, '.promotion-tags'), 'utf8').trim();
    };
    assert.equal(plan('push'), 'main');
    git('commit', '--allow-empty', '-m', 'second');
    git('checkout', '--detach', old);
    assert.equal(plan('push'), '');
    assert.equal(plan('manual'), '');
    git('tag', 'v1.2.4');
    git('tag', 'v2.0.0');
    assert.equal(plan('tag', 'v1.2.3'), '1.2.3');
    assert.equal(plan('tag', 'v1.3.0'), '1.3.0\n1.3');
    assert.equal(plan('tag', 'v2.0.1'), '2.0.1\n2.0\nlatest');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('real scan commands preserve failure and do not reach promotion', () => {
  const build = read('.woodpecker/build.yml');
  const scan = build.split('  - name: image-scan\n')[1].split('\n  - name:')[0];
  const commands = scan.split('\n').filter((line) => line.startsWith('      - '))
    .map((line) => line.slice(8).replaceAll('$$', '$'));
  // Only commands, not the event filter.
  const script = commands.slice(commands.findIndex((line) => line.startsWith('trivy '))).join('\n');
  for (const rc of [0, 1, 2]) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-scan-'));
    try {
      fs.writeFileSync(path.join(cwd, '.image-ref'), 'registry.example.com/podium@sha256:abc\n');
      const result = spawnSync('sh', ['-ec', `
        trivy() { printf 'scan evidence\n' > trivy-report.txt; return ${rc}; }
        ( ${script}\n )
        touch promoted
      `], { cwd, encoding: 'utf8' });
      assert.equal(result.status, rc);
      assert.equal(fs.existsSync(path.join(cwd, 'promoted')), rc === 0);
      assert.match(result.stdout, /scan evidence/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test('both publishers gate promotion on validation and digest scans', () => {
  const wood = read('.woodpecker/build.yml');
  assert.match(wood, /depends_on: \[ci\]/);
  assert.match(wood, /concurrency:\n  limit: 1/);
  assert.ok(wood.indexOf('name: image-scan') < wood.indexOf('name: promote-scanned-image'));
  assert.match(wood, /"\$\(cat \.image-ref\)"/);
  const github = read('.github/workflows/publish.yml');
  assert.match(github, /needs: validate/);
  assert.match(github, /@\$\{\{ steps.build.outputs.digest \}\}/);
  assert.ok(github.indexOf('name: Scan candidate') < github.indexOf('name: Promote scanned image'));
  assert.match(read('.woodpecker/ci.yml'), /event: tag/);
});

test('promotion stops on the first failed registry copy', () => {
  const build = read('.woodpecker/build.yml');
  const step = build.split('  - name: promote-scanned-image\n')[1].split('\n  # Woodpecker')[0];
  const loop = step.split('\n').find((line) => line.startsWith('      - while '))
    .slice(8).replaceAll('$$', '$');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-copy-'));
  try {
    fs.writeFileSync(path.join(cwd, '.promotion-tags'), '1.2.3\n1.2\nlatest\n');
    fs.writeFileSync(path.join(cwd, '.image-ref'), 'registry.example.com/podium@sha256:abc\n');
    const result = spawnSync('sh', ['-ec', `
      regctl() { printf '%s\n' "$*" >> copies; return 7; }
      ${loop}
    `], { cwd, encoding: 'utf8', env: { ...process.env, REGISTRY: 'registry.example.com', IMAGE_NAME: 'podium' } });
    assert.equal(result.status, 7);
    const copies = fs.readFileSync(path.join(cwd, 'copies'), 'utf8').trim().split('\n');
    assert.deepEqual(copies, ['image copy registry.example.com/podium@sha256:abc registry.example.com/podium:1.2.3']);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
