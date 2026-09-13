/**
 * Routes that read a setting, and where they read it from.
 *
 * Podium resolves configuration in two layers -- the environment, with the
 * settings table on top -- and every route that reads a *settable* value has to
 * do both or it answers from a value nobody is using any more. Paths are the
 * deliberate exception: `dbPath` and `rulesPath` come from the environment
 * alone, which is what makes opening the database to read the rest
 * non-circular.
 *
 * Two routes were reading `loadConfig()` flat. The metrics scrape reported its
 * freshness target and staleness against the environment's max age, so a target
 * changed in Settings moved the pacer and the progress page but not the
 * dashboard drawn from these numbers. The rule check read the Teamarr URL the
 * same way, and a URL entered in the UI left it quietly skipping the
 * `epg_match` and `stream_type` reads and marking its own answer approximate.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProbeResult } from './probe';
import { Store } from './store';

let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-route-settings-'));
  writeFileSync(join(dir, 'rules.json'), JSON.stringify({ schema: 2, channels: [] }), 'utf8');
  process.env.PODIUM_DATA_DIR = dir;
  process.env.PODIUM_RULES = join(dir, 'rules.json');
});

afterAll(() => {
  delete process.env.PODIUM_DATA_DIR;
  delete process.env.PODIUM_RULES;
  rmSync(dir, { recursive: true, force: true });
});

const withSettings = (values: Record<string, string | null>) => {
  const store = new Store(join(dir, 'podium.db'));
  try {
    store.setSettings(values);
  } finally {
    store.close();
  }
};

/** One cached verdict, which is what makes the freshness block appear at all. */
const withOneVerdict = () => {
  const store = new Store(join(dir, 'podium.db'));
  try {
    store.put(1, 'h', {
      alive: true,
      width: 1920,
      height: 1080,
      fps: 30,
      bitrateKbps: 5000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      pixelFormat: 'yuv420p',
      audioChannels: 2,
      channelLayout: 'stereo',
      audioBitrateKbps: 128,
      audioSampleRate: 48_000,
      elapsedMs: 100,
      error: '',
    } as ProbeResult);
  } finally {
    store.close();
  }
};

describe('GET /api/metrics', () => {
  beforeEach(() => {
    withSettings({ PODIUM_MAX_AGE_MS: null });
    withOneVerdict();
  });

  const scrape = async () => {
    const { GET } = await import('../app/api/metrics/route');
    return (await GET()).text();
  };

  it('reports the freshness target the app is actually working towards', async () => {
    // 24h is the default, and what the environment says here.
    expect(await scrape()).toContain('podium_freshness_target_seconds 86400');

    // Four hours, entered in Settings. The pacer picks this up on its next
    // pass; before this fix the scrape went on publishing 86400 forever, and an
    // alert built on it fired against a window nobody had chosen.
    withSettings({ PODIUM_MAX_AGE_MS: String(4 * 3_600_000) });
    expect(await scrape()).toContain('podium_freshness_target_seconds 14400');
  });
});
