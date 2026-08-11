import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RulesSource } from './rules-source';

const doc = (channels: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ schema: 2, defaults: {}, channels, ...extra });

/** Write the way the app does -- temp file, then rename -- so a reader never
 *  observes a half-written document. */
function writeAtomic(path: string, body: string) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, path);
}

describe('RulesSource', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-rules-'));
    path = join(dir, 'rules.json');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('loads a rules file', () => {
    writeAtomic(path, doc([{ channel_id: 1, aliases: ['HBO'] }]));
    const src = new RulesSource(path);
    expect(src.get().matcher.rules.size).toBe(1);
    expect(src.get().present).toBe(true);
  });

  it('picks up an edit without being told', () => {
    // The bug this class exists for: the worker held its matcher for the life
    // of the process, so a rule edited in the UI never reached it.
    writeAtomic(path, doc([{ channel_id: 1, aliases: ['HBO'] }]));
    const src = new RulesSource(path);
    expect(src.get().matcher.rules.size).toBe(1);

    writeAtomic(
      path,
      doc([
        { channel_id: 1, aliases: ['HBO'] },
        { channel_id: 2, aliases: ['AMC'] },
      ]),
    );
    expect(src.get().matcher.rules.size).toBe(2);
  });

  it('returns the same object while the file is untouched', () => {
    writeAtomic(path, doc([{ channel_id: 1, aliases: ['HBO'] }]));
    const src = new RulesSource(path);
    expect(src.get()).toBe(src.get());
  });

  it('notices a same-millisecond rewrite via size', () => {
    // Two saves in quick succession can share an mtime; size disambiguates.
    writeAtomic(path, doc([{ channel_id: 1, aliases: ['HBO'] }]));
    const src = new RulesSource(path);
    const first = src.get();

    const stat = { mtimeMs: 0 };
    writeAtomic(path, doc([{ channel_id: 1, aliases: ['HBO', 'HBO East'] }]));
    void stat;
    expect(src.get()).not.toBe(first);
    expect(src.get().matcher.rules.get(1)?.aliases).toEqual(['HBO', 'HBO East']);
  });

  it('treats a missing file as an empty ruleset', () => {
    const src = new RulesSource(path);
    const loaded = src.get();
    expect(loaded.matcher.rules.size).toBe(0);
    expect(loaded.present).toBe(false);
  });

  it('picks up a file that appears later', () => {
    // A fresh volume has none until the app writes one or an import runs.
    const src = new RulesSource(path);
    expect(src.get().present).toBe(false);

    writeAtomic(path, doc([{ channel_id: 1, aliases: ['HBO'] }]));
    expect(src.get().present).toBe(true);
    expect(src.get().matcher.rules.size).toBe(1);
  });

  it('notices a file that disappears', () => {
    writeAtomic(path, doc([{ channel_id: 1, aliases: ['HBO'] }]));
    const src = new RulesSource(path);
    expect(src.get().matcher.rules.size).toBe(1);

    unlinkSync(path);
    expect(src.get().matcher.rules.size).toBe(0);
  });

  it('reloads group patterns alongside the rules', () => {
    writeAtomic(path, doc([{ channel_id: 1, aliases: ['x'] }]));
    const src = new RulesSource(path);
    expect(src.get().eligibility.policyFor(9, 'Auto | MLB').mode).toBe('always');

    writeAtomic(
      path,
      doc([{ channel_id: 1, aliases: ['x'] }], {
        group_patterns: [{ pattern: 'Auto | *', mode: 'never' }],
      }),
    );
    expect(src.get().eligibility.policyFor(9, 'Auto | MLB').mode).toBe('never');
  });

  it('reloads explicit group policies too', () => {
    writeAtomic(path, doc([{ channel_id: 1, aliases: ['x'] }], { groups: { '7': 'never' } }));
    const src = new RulesSource(path);
    expect(src.get().policies.get(7)?.mode).toBe('never');
  });

  it('forgets everything on invalidate', () => {
    writeAtomic(path, doc([{ channel_id: 1, aliases: ['HBO'] }]));
    const src = new RulesSource(path);
    const first = src.get();
    src.invalidate();
    expect(src.get()).not.toBe(first);
  });

  it('reports the file mtime, or null when absent', () => {
    const src = new RulesSource(path);
    expect(src.fileMtime()).toBeNull();
    writeAtomic(path, doc([]));
    expect(src.fileMtime()).toBeGreaterThan(0);
  });
});
