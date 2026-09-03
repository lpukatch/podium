import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_VERSION,
  type BackupBundle,
  backupFilename,
  parseBundle,
  settingsForRestore,
  wouldBreakAuth,
} from './backup';
import { EMPTY_RULES_DOC } from './rules';
import { Store } from './store';

function bundle(overrides: Partial<BackupBundle> = {}): BackupBundle {
  return {
    kind: 'podium-backup',
    version: BACKUP_VERSION,
    createdAt: 1,
    rules: { schema: 2, defaults: {}, channels: [{ channel_id: 7, aliases: ['ESPN'] }] },
    settings: {},
    teamarrRules: null,
    assignBlocks: [],
    ...overrides,
  };
}

describe('backup bundle', () => {
  it('accepts a minimal bundle', () => {
    expect(parseBundle(bundle({ rules: EMPTY_RULES_DOC })).bundle.version).toBe(1);
  });

  it('reports what the rules doc loads as', () => {
    const { loadReport } = parseBundle(bundle());
    expect(loadReport.loaded).toBe(1);
  });

  it('rejects a file that is not a Podium backup', () => {
    expect(() => parseBundle({ ...bundle(), kind: 'something-else' })).toThrow();
    expect(() => parseBundle({ ...bundle(), version: 2 })).toThrow();
  });

  it('rejects wrong shapes inside the bundle', () => {
    expect(() => parseBundle({ ...bundle(), settings: 'nope' })).toThrow();
    expect(() => parseBundle({ ...bundle(), assignBlocks: {} })).toThrow();
    expect(() => parseBundle({ ...bundle(), rules: { schema: 2, channels: 'no' } })).toThrow();
  });
});

describe('settingsForRestore', () => {
  it('keeps real settings keys and drops everything else', () => {
    const kept = settingsForRestore(
      bundle({
        settings: {
          DISPATCHARR_API_KEY: 'k',
          // Deliberately not a settable field: where data lives is
          // environment-only, and a bundle is not a way around that.
          PODIUM_DATA_DIR: '/elsewhere',
        },
      }),
    );
    expect(kept).toEqual({ DISPATCHARR_API_KEY: 'k' });
  });
});

describe('wouldBreakAuth', () => {
  it('passes when the environment already carries a credential', () => {
    expect(wouldBreakAuth({ DISPATCHARR_API_KEY: 'k' }, {})).toBe(false);
  });

  it('passes when the backup carries one', () => {
    expect(wouldBreakAuth({}, { DISPATCHARR_API_KEY: 'k' })).toBe(false);
  });

  it('refuses when neither does', () => {
    expect(wouldBreakAuth({}, {})).toBe(true);
  });
});

describe('backupFilename', () => {
  it('is dated so a folder of them sorts', () => {
    expect(backupFilename(new Date(2026, 8, 2))).toBe('podium-backup-2026-09-02.json');
  });
});

describe('config snapshot round-trip', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-backup-'));
    store = new Store(join(dir, 's.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('exports the seeded config', () => {
    store.setSettings({ PODIUM_DRY_RUN: 'false' });
    store.saveTeamarrRules([{ id: 'x' }]);
    store.blockAssignment(3, 30);

    const snap = store.exportConfig();
    expect(snap.settings).toEqual({ PODIUM_DRY_RUN: 'false' });
    expect(snap.teamarrRules?.rules).toEqual([{ id: 'x' }]);
    expect(snap.assignBlocks).toEqual([
      { channelId: 3, streamId: 30, blockedAt: expect.any(Number) },
    ]);
  });

  it('replaces rather than merges', () => {
    store.setSettings({ PODIUM_DRY_RUN: 'false', DISPATCHARR_URL: 'http://old' });
    store.saveTeamarrRules([{ id: 'old' }]);
    store.blockAssignment(1, 10);

    store.restoreConfig({
      settings: { PODIUM_DRY_RUN: 'true' },
      teamarrRules: { rules: [{ id: 'new' }], uploadedAt: 12_345 },
      assignBlocks: [{ channelId: 2, streamId: 20, blockedAt: 5 }],
    });

    // Wipe semantics: the keys the backup does not carry are gone, not kept.
    expect(store.settings()).toEqual({ PODIUM_DRY_RUN: 'true' });
    expect(store.teamarrRules()).toEqual({ rules: [{ id: 'new' }], uploadedAt: 12_345 });
    expect(store.assignBlocks(1)).toEqual(new Set());
    expect(store.assignBlocks(2)).toEqual(new Set([20]));
  });

  it('leaves live state alone', () => {
    store.setProgress({ ...store.getProgress(), phase: 'probing', probed: 3, total: 9 });
    const before = store.getProgress();

    store.restoreConfig({ settings: {}, teamarrRules: null, assignBlocks: [] });

    expect(store.getProgress()).toEqual(before);
  });

  it('stamps restored settings with a fresh updated_at', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      store.setSettings({ PODIUM_DRY_RUN: 'false' });
      expect(store.settingsVersion()).toBe(1_000_000);

      vi.setSystemTime(2_000_000);
      store.restoreConfig({
        settings: { PODIUM_DRY_RUN: 'true' },
        teamarrRules: null,
        assignBlocks: [],
      });

      // The version is MAX(updated_at), and both the worker's liveConfig()
      // and the web's config() cache on it: a version that went backwards
      // would leave every process running the pre-restore settings forever.
      expect(store.settingsVersion()).toBe(2_000_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
