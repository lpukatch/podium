import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { describeSettings, FIELD_KEYS, resolveEnv, validateSettings } from './settings';
import { Store } from './store';

describe('resolveEnv', () => {
  it('lets a stored value win over the environment', () => {
    // The whole point: an edit in the UI has to beat the deploy-time value, or
    // it silently does nothing after the next restart.
    const out = resolveEnv({ DISPATCHARR_URL: 'http://env' }, { DISPATCHARR_URL: 'http://stored' });
    expect(out.DISPATCHARR_URL).toBe('http://stored');
  });

  it('falls back to the environment when nothing is stored', () => {
    expect(resolveEnv({ DISPATCHARR_URL: 'http://env' }, {}).DISPATCHARR_URL).toBe('http://env');
  });

  it('ignores stored keys that are not settable', () => {
    // The settings table must not become a way to set arbitrary process config
    // -- PODIUM_DATA_DIR would move the database out from under a running app.
    const out = resolveEnv(
      { PODIUM_DATA_DIR: '/app/data' },
      {
        PODIUM_DATA_DIR: '/tmp/evil',
        PATH: '/tmp/evil',
      },
    );
    expect(out.PODIUM_DATA_DIR).toBe('/app/data');
    expect(FIELD_KEYS.has('PODIUM_DATA_DIR')).toBe(false);
  });

  it('produces a config the loader accepts', () => {
    const env = resolveEnv({}, { DISPATCHARR_API_KEY: 'k', PODIUM_DRY_RUN: 'true' });
    const config = loadConfig(env);
    expect(config.DISPATCHARR_API_KEY).toBe('k');
    expect(config.PODIUM_DRY_RUN).toBe(true);
  });

  it('defaults to dry-run when nothing says otherwise', () => {
    // The documented promise is that an install nobody has configured does not
    // write. A reorder has no undo, so this default is load-bearing, not a
    // preference -- assert it rather than leaving it to whoever edits the
    // schema next.
    expect(loadConfig(resolveEnv({}, { DISPATCHARR_API_KEY: 'k' })).PODIUM_DRY_RUN).toBe(true);
  });
});

describe('describeSettings', () => {
  it('never returns a secret, only whether one is set', () => {
    // The endpoint that writes a credential must not also read it back.
    const views = describeSettings({}, { DISPATCHARR_API_KEY: 'super-secret' });
    const key = views.find((f) => f.key === 'DISPATCHARR_API_KEY');
    expect(key?.value).toBe('');
    expect(key?.isSet).toBe(true);
    expect(JSON.stringify(views)).not.toContain('super-secret');
  });

  it('reports where each value came from', () => {
    const views = describeSettings({ DISPATCHARR_URL: 'http://env' }, { PODIUM_MAX_SLICE: '50' });
    expect(views.find((f) => f.key === 'DISPATCHARR_URL')?.source).toBe('environment');
    expect(views.find((f) => f.key === 'PODIUM_MAX_SLICE')?.source).toBe('stored');
    expect(views.find((f) => f.key === 'PODIUM_USER_AGENT')?.source).toBeUndefined();
  });

  it('returns non-secret values so the form can show them', () => {
    const views = describeSettings({}, { DISPATCHARR_URL: 'http://d:9191' });
    expect(views.find((f) => f.key === 'DISPATCHARR_URL')?.value).toBe('http://d:9191');
  });

  it('shows a scaled field in the units its label claims', () => {
    const views = describeSettings({ PODIUM_MAX_AGE_MS: '86400000' }, {});
    const field = views.find((f) => f.key === 'PODIUM_MAX_AGE_MS');
    expect(field?.label).toContain('minutes');
    expect(field?.value).toBe('1440');
  });

  it('reports the default a blank field falls back to', () => {
    // The form has nothing else to put in an empty box, which is how "what is
    // analyze seconds set to?" became unanswerable from the settings page.
    const views = describeSettings({}, {});
    expect(views.find((f) => f.key === 'PODIUM_ANALYZE_SECONDS')?.defaultValue).toBe('6');
    expect(views.find((f) => f.key === 'PODIUM_MAX_AGE_MS')?.defaultValue).toBe('1440');
    expect(views.find((f) => f.key === 'PODIUM_TICK_MS')?.defaultValue).toBe('1');
  });
});

describe('validateSettings', () => {
  it('rejects a key that is not settable', () => {
    const { errors } = validateSettings({ PODIUM_DATA_DIR: '/tmp' });
    expect(errors[0]?.key).toBe('PODIUM_DATA_DIR');
  });

  it('treats an empty value as "hand this back to the environment"', () => {
    expect(validateSettings({ DISPATCHARR_API_KEY: '' }).values).toEqual({
      DISPATCHARR_API_KEY: null,
    });
  });

  it('normalises booleans from the spellings people type', () => {
    expect(validateSettings({ PODIUM_DRY_RUN: 'yes' }).values.PODIUM_DRY_RUN).toBe('true');
    expect(validateSettings({ PODIUM_DRY_RUN: 'off' }).values.PODIUM_DRY_RUN).toBe('false');
  });

  it('rejects a negative or non-numeric number', () => {
    expect(validateSettings({ PODIUM_MAX_SLICE: '-1' }).errors).toHaveLength(1);
    expect(validateSettings({ PODIUM_MAX_SLICE: 'lots' }).errors).toHaveLength(1);
    expect(validateSettings({ PODIUM_MAX_SLICE: '200' }).values.PODIUM_MAX_SLICE).toBe('200');
  });

  it('requires a real http(s) URL and trims a trailing slash', () => {
    expect(validateSettings({ DISPATCHARR_URL: 'not a url' }).errors).toHaveLength(1);
    expect(validateSettings({ DISPATCHARR_URL: 'ftp://x' }).errors).toHaveLength(1);
    expect(validateSettings({ DISPATCHARR_URL: 'http://d:9191/' }).values.DISPATCHARR_URL).toBe(
      'http://d:9191',
    );
  });

  it('no longer accepts lane overrides at all', () => {
    // Dispatcharr's own max_streams is the authority; a second place to set a
    // provider limit could only ever disagree with it.
    expect(validateSettings({ PODIUM_LANE_OVERRIDES: '6:3' }).errors).toHaveLength(1);
    expect(FIELD_KEYS.has('PODIUM_LANE_OVERRIDES')).toBe(false);
  });

  it('stores a minutes field as the milliseconds the code works in', () => {
    // The label says minutes; PODIUM_MAX_AGE_MS still has to be milliseconds,
    // or an install configured by environment would change meaning.
    expect(validateSettings({ PODIUM_MAX_AGE_MS: '1440' }).values.PODIUM_MAX_AGE_MS).toBe(
      '86400000',
    );
    expect(validateSettings({ PODIUM_TICK_MS: '5' }).values.PODIUM_TICK_MS).toBe('300000');
  });

  it('rejects a value outside a field bounds, in the units shown', () => {
    expect(validateSettings({ PODIUM_ANALYZE_SECONDS: '0' }).errors[0]?.message).toMatch(
      /at least 1/,
    );
    expect(validateSettings({ PODIUM_ANALYZE_SECONDS: '600' }).errors[0]?.message).toMatch(
      /at most 60/,
    );
    expect(validateSettings({ PODIUM_ANALYZE_SECONDS: '6' }).errors).toHaveLength(0);
    // Below a minute the loop would spend its life re-fetching the channel list.
    expect(validateSettings({ PODIUM_TICK_MS: '0' }).errors).toHaveLength(1);
  });
});

describe('settings persistence', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-settings-'));
    store = new Store(join(dir, 's.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips values', () => {
    store.setSettings({ PODIUM_DRY_RUN: 'false', DISPATCHARR_URL: 'http://d' });
    expect(store.settings()).toEqual({ PODIUM_DRY_RUN: 'false', DISPATCHARR_URL: 'http://d' });
  });

  it('removes a key when handed null', () => {
    store.setSettings({ PODIUM_DRY_RUN: 'false' });
    store.setSettings({ PODIUM_DRY_RUN: null });
    expect(store.settings()).toEqual({});
  });

  it('advances the version so readers can detect a change cheaply', () => {
    expect(store.settingsVersion()).toBe(0);
    store.setSettings({ PODIUM_DRY_RUN: 'false' });
    expect(store.settingsVersion()).toBeGreaterThan(0);
  });

  it('turns dry run off through the stored value', () => {
    // The end-to-end point of the whole feature.
    expect(
      loadConfig(resolveEnv({ DISPATCHARR_API_KEY: 'k', PODIUM_DRY_RUN: 'true' }, store.settings()))
        .PODIUM_DRY_RUN,
    ).toBe(true);

    store.setSettings({ PODIUM_DRY_RUN: 'false' });
    expect(
      loadConfig(resolveEnv({ DISPATCHARR_API_KEY: 'k', PODIUM_DRY_RUN: 'true' }, store.settings()))
        .PODIUM_DRY_RUN,
    ).toBe(false);
  });
});
