/**
 * Rules for channels Dispatcharr has deleted are removed from the rules file.
 *
 * Deleting a rule loses aliases somebody wrote, so most of this is about what
 * must not be taken: a rule whose channel a short listing merely failed to
 * show, one whose lookup errored, a UI edit saved while the lookups were out,
 * and a whole file when Podium is pointed at a different Dispatcharr.
 */

import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config';
import { BACKUPS_KEPT, pruneDeletedChannelRules } from './rule-sync';
import { RulesSource } from './rules-source';
import { Runner } from './runner';
import { Store } from './store';

let dir: string;
let path: string;

const rule = (id: number | string, name = `Channel ${id}`) => ({
  channel_id: id,
  name,
  aliases: [name],
});

function writeRules(channels: unknown[], extra: Record<string, unknown> = {}): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ schema: 2, ...extra, channels }), 'utf8');
  renameSync(tmp, path);
}

const readRules = () => JSON.parse(readFileSync(path, 'utf8'));
const ids = () => readRules().channels.map((c: { channel_id: unknown }) => c.channel_id);
const backups = () => readdirSync(dir).filter((f) => f.startsWith('rules.json.pruned-'));

/** Ten rules, 1..10, so one or two missing is well inside the share guard. */
const tenRules = () => Array.from({ length: 10 }, (_, i) => rule(i + 1));
const allBut = (...missing: number[]) =>
  Array.from({ length: 10 }, (_, i) => i + 1).filter((id) => !missing.includes(id));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-rule-sync-'));
  path = join(dir, 'rules.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('pruneDeletedChannelRules', () => {
  it('removes a rule whose channel is deleted and keeps the rest of the file', async () => {
    writeRules(tenRules(), { ordering: { mode: 'quality' }, groups: { '7': { mode: 'never' } } });
    const before = readFileSync(path, 'utf8');

    const outcome = await pruneDeletedChannelRules(path, allBut(3), async (id) => id === 3);

    expect(outcome?.removed).toEqual([{ id: 3, name: 'Channel 3' }]);
    expect(ids()).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 10]);
    expect(readRules().ordering).toEqual({ mode: 'quality' });
    expect(readRules().groups).toEqual({ '7': { mode: 'never' } });
    // The file as it stood, byte for byte, beside the new one.
    expect(outcome?.backup).not.toBeNull();
    expect(readFileSync(outcome!.backup!, 'utf8')).toBe(before);
  });

  it('does nothing, and looks nothing up, when every ruled channel is listed', async () => {
    writeRules(tenRules());
    const isGone = vi.fn(async () => true);

    expect(await pruneDeletedChannelRules(path, allBut(), isGone)).toBeNull();
    expect(isGone).not.toHaveBeenCalled();
    expect(backups()).toEqual([]);
  });

  it('keeps a rule a short listing missed while its channel still answers', async () => {
    // The torn page: the channel exists, the listing just failed to show it.
    writeRules(tenRules());

    expect(await pruneDeletedChannelRules(path, allBut(4), async () => false)).toBeNull();
    expect(ids()).toHaveLength(10);
    expect(backups()).toEqual([]);
  });

  it('keeps a rule whose lookup failed, and still removes the confirmed one', async () => {
    writeRules(tenRules());

    const outcome = await pruneDeletedChannelRules(path, allBut(4, 5), async (id) => {
      if (id === 4) throw new Error('GET /api/channels/channels/4/ -> 502');
      return true;
    });

    expect(outcome?.removed.map((r) => r.id)).toEqual([5]);
    expect(ids()).toContain(4);
  });

  it('refuses when most of the file would go, without a lookup or a write', async () => {
    // Podium repointed at another Dispatcharr: every id is missing and would 404.
    const many = Array.from({ length: 30 }, (_, i) => rule(i + 1));
    writeRules(many);
    const before = readFileSync(path, 'utf8');
    const isGone = vi.fn(async () => true);

    const outcome = await pruneDeletedChannelRules(path, [1, 2, 3], isGone);

    expect(outcome?.removed).toEqual([]);
    expect(outcome?.refused).toContain('27 of 30');
    expect(isGone).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(backups()).toEqual([]);
  });

  it('prunes a small file below the share floor', async () => {
    // Two of three is most of the file, but a handful says nothing about which
    // Dispatcharr this is.
    writeRules([rule(1), rule(2), rule(3)]);

    const outcome = await pruneDeletedChannelRules(path, [1], async () => true);

    expect(outcome?.removed.map((r) => r.id)).toEqual([2, 3]);
    expect(ids()).toEqual([1]);
  });

  it('keeps a rule saved while the lookups were out', async () => {
    writeRules(tenRules());

    const outcome = await pruneDeletedChannelRules(path, allBut(3), async (id) => {
      // The UI saves a new rule mid-sync; the write must be built on it.
      writeRules([...tenRules(), rule(11, 'Saved meanwhile')]);
      return id === 3;
    });

    expect(outcome?.removed.map((r) => r.id)).toEqual([3]);
    expect(ids()).toContain(11);
  });

  it('matches an id imported as text', async () => {
    writeRules([...tenRules().slice(1), rule('1', 'Imported')]);

    const outcome = await pruneDeletedChannelRules(path, allBut(1), async (id) => id === 1);

    expect(outcome?.removed).toEqual([{ id: 1, name: 'Imported' }]);
  });

  it('removes a nameless rule too', async () => {
    writeRules([...tenRules(), { channel_id: 99, aliases: [] }]);

    const outcome = await pruneDeletedChannelRules(path, allBut(), async () => true);

    expect(outcome?.removed).toEqual([{ id: 99, name: '' }]);
  });

  it('keeps only the newest backups', async () => {
    const start = Date.parse('2026-09-14T00:00:00Z');
    for (let n = 0; n < BACKUPS_KEPT + 2; n += 1) {
      writeRules([...tenRules(), rule(100 + n)]);
      await pruneDeletedChannelRules(path, allBut(), async () => true, start + n * 60_000);
    }

    const kept = backups().sort();
    expect(kept).toHaveLength(BACKUPS_KEPT);
    // The two oldest went; the newest stayed.
    expect(kept[0]).toContain('2026-09-14T00-02-00');
    expect(kept.at(-1)).toContain('2026-09-14T00-06-00');
  });

  it('does nothing without a rules file', async () => {
    expect(await pruneDeletedChannelRules(path, [1], async () => true)).toBeNull();
  });
});

describe('a pass', () => {
  let store: Store;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    store = new Store(join(dir, 'podium.db'));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    store.close();
  });

  /** Lists `listed`; answers 404 for any channel looked up on its own. */
  function stubDispatcharr(listed: number[]) {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const one = /^\/api\/channels\/channels\/\d+\/$/.test(url.pathname);
      const body = url.pathname.includes('/proxy/ts/status')
        ? // Someone watching: the pass pauses straight after the channel list.
          { channels: [{ channel_id: 1 }], count: 1 }
        : url.pathname === '/api/channels/channels/'
          ? {
              count: listed.length,
              next: null,
              results: listed.map((id) => ({ id, name: `Channel ${id}`, streams: [] })),
            }
          : { count: 0, next: null, results: [] };
      return {
        ok: !one,
        status: one ? 404 : 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    }) as unknown as typeof fetch;
  }

  it('removes the rules for deleted channels even when it then pauses', async () => {
    writeRules(tenRules());
    stubDispatcharr(allBut(2, 7));
    const lines: string[] = [];

    const summary = await new Runner({
      config: () => loadConfig({ PODIUM_DATA_DIR: dir, DISPATCHARR_API_KEY: 'k' }),
      store,
      rules: new RulesSource(path),
      log: (m) => lines.push(m),
    }).runOnce();

    expect(summary.paused).toBe(true);
    expect(ids()).toEqual(allBut(2, 7));
    expect(lines.join('\n')).toContain(
      'removed 2 rules for channels deleted in Dispatcharr: 2 (Channel 2), 7 (Channel 7)',
    );
  });

  it('says once, not every pass, why it refused', async () => {
    writeRules(Array.from({ length: 30 }, (_, i) => rule(i + 1)));
    stubDispatcharr([1]);
    const lines: string[] = [];
    const runner = new Runner({
      config: () => loadConfig({ PODIUM_DATA_DIR: dir, DISPATCHARR_API_KEY: 'k' }),
      store,
      rules: new RulesSource(path),
      log: (m) => lines.push(m),
    });

    await runner.runOnce();
    await runner.runOnce();

    expect(lines.filter((l) => l.startsWith('rules not synced')).length).toBe(1);
    expect(ids()).toHaveLength(30);
  });
});
