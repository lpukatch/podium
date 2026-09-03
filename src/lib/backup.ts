/**
 * The backup bundle: everything Podium is told, and nothing it measured.
 *
 * A backup exists to survive a lost volume, so it carries the two halves of
 * configured state -- the rules file and the four config tables -- and
 * deliberately excludes the probe cache and quality history those settings
 * go on to produce. Re-measuring costs probe budget; re-deciding hundreds of
 * channel rules and re-entering a credential costs the evening.
 *
 * The settings section includes stored credentials in the clear. That is the
 * point of a backup, and the reason a downloaded one is treated like a
 * credential everywhere else (the gitignore already assumes this).
 */

import { z } from 'zod';
import { loadConfig, requireCredentials } from './config';
import { type LoadReport, loadRules } from './rules';
import { FIELD_KEYS, resolveEnv } from './settings';

export const BACKUP_VERSION = 1;

export const backupBundleSchema = z.object({
  kind: z.literal('podium-backup'),
  version: z.literal(BACKUP_VERSION),
  createdAt: z.number().int().nonnegative(),
  /**
   * The rules doc exactly as it sits on disk, carried through unparsed.
   *
   * Deliberately not `rulesDocSchema`: that schema declares the keys the
   * loader reads and zod drops the rest, and `group_patterns` -- written by
   * the group-policy UI, read by the matcher -- is not among them. Parsing
   * the doc *into* the bundle would drop those patterns from the backup and,
   * on restore, from rules.json. So the doc travels byte-for-byte and the
   * validation happens beside it, in `parseBundle`.
   */
  rules: z.record(z.string(), z.unknown()),
  /** Stored settings rows, credentials included. */
  settings: z.record(z.string(), z.string()),
  /** The uploaded Teamarr rule set, or null when none was stored. */
  teamarrRules: z
    .object({
      rules: z.array(z.unknown()),
      uploadedAt: z.number().int().nonnegative(),
    })
    .nullable(),
  /** "Never auto-assign this stream here" decisions. */
  assignBlocks: z.array(
    z.object({
      channelId: z.number().int(),
      streamId: z.number().int(),
      blockedAt: z.number().int().nonnegative(),
    }),
  ),
});

export type BackupBundle = z.infer<typeof backupBundleSchema>;

/**
 * Parse a bundle and prove its rules doc loads.
 *
 * The load round-trip is the rule the import script established: a rules file
 * that does not parse must never reach disk, because it takes the next worker
 * boot down with it. It is also the only validation the rules half gets -- the
 * bundle schema keeps the doc verbatim -- and it is the stronger of the two,
 * since `loadRules` runs `rulesDocSchema` itself and then refines and compiles
 * what it accepts.
 */
export function parseBundle(raw: unknown): { bundle: BackupBundle; loadReport: LoadReport } {
  const bundle = backupBundleSchema.parse(raw);
  const loadReport = loadRules(bundle.rules);
  return { bundle, loadReport };
}

/**
 * Keep only real settings keys.
 *
 * The settings table must not become a way to set arbitrary process
 * configuration, so a bundle -- which nobody has promised to be trustworthy --
 * goes through the same FIELD_KEYS allowlist `resolveEnv` applies.
 */
export function settingsForRestore(bundle: BackupBundle): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(bundle.settings)) {
    if (FIELD_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Would restoring these stored settings leave Podium unable to authenticate?
 *
 * The same merged-env check the settings PUT makes: env and restored stored
 * values considered together, so a backup from a keyless install still
 * restores onto an install whose credentials live in the environment.
 */
export function wouldBreakAuth(
  env: Record<string, string | undefined>,
  stored: Record<string, string>,
): boolean {
  try {
    requireCredentials(loadConfig(resolveEnv(env, stored)));
    return false;
  } catch {
    return true;
  }
}

/** `podium-backup-2026-09-02.json` -- dated so a folder of them sorts. */
export function backupFilename(now = new Date()): string {
  const part = (n: number) => String(n).padStart(2, '0');
  return `podium-backup-${now.getFullYear()}-${part(now.getMonth() + 1)}-${part(now.getDate())}.json`;
}
