/**
 * Dropping rules for channels Dispatcharr no longer has.
 *
 * A rule is keyed on a channel id, and nothing removed it when that channel was
 * deleted upstream. Such a rule never runs -- a pass works from Dispatcharr's
 * channel list -- but it is not inert: the provider stream groups and the stream
 * search count what it matches as claimed, and the UI, which only lists channels
 * that exist, offers no way to find it. One install carried 242 of them, and 584
 * streams read as taken by channels that were gone.
 *
 * Deleting a rule throws away aliases somebody wrote, so one listing is not
 * enough evidence:
 *
 *   - Missing from the channel listing is only a suspicion. A paged read can
 *     still come back short (see `DispatcharrClient.paged`), so each suspect is
 *     looked up on its own and only a 404 condemns it. A lookup that fails any
 *     other way keeps the rule for this pass.
 *   - More than half the rules missing at once is refused without looking. That
 *     is not housekeeping, it is Podium pointed at a different or rebuilt
 *     Dispatcharr, where every id 404s and a prune would empty the file.
 *   - The file as it stood is copied aside before the write, and the last few
 *     copies are kept, so a prune is never the only record of what it removed.
 */

import { readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';

/** Past this share of the ruled channels, a prune is refused -- see above. */
export const MAX_PRUNE_SHARE = 0.5;

/**
 * Below this many suspects the share guard does not apply.
 *
 * On a file of three rules, one deleted channel is a third of them and two is
 * most of them; a handful says nothing about which Dispatcharr this is, and the
 * backup covers the rest.
 */
export const PRUNE_SHARE_FLOOR = 10;

/** How many pre-prune copies of the rules file are kept beside it. */
export const BACKUPS_KEPT = 5;

/** Lookups in flight at once. The first sync on an old file can have hundreds. */
const LOOKUP_CONCURRENCY = 4;

const BACKUP_TAG = '.pruned-';

export interface RulePrune {
  /** Rules taken out of the file, by channel id and the name the rule carried. */
  removed: Array<{ id: number; name: string }>;
  /** Where the file was copied before the write; null when nothing was written. */
  backup: string | null;
  /** Why nothing was removed although channels look deleted; null otherwise. */
  refused: string | null;
}

interface RuleRow {
  channel_id?: unknown;
  name?: unknown;
}

function ruleRows(doc: unknown): RuleRow[] {
  const channels = (doc as { channels?: unknown } | null)?.channels;
  return Array.isArray(channels) ? (channels as RuleRow[]) : [];
}

/** The loader's coercion: imported rule sets store the id as text. */
function ruleId(row: RuleRow): number {
  return Number(row.channel_id);
}

function readDoc(path: string): { text: string; doc: unknown } | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return { text, doc: JSON.parse(text) };
}

/**
 * Remove the rules whose channel is confirmed deleted, and say what happened.
 *
 * `listed` is the channel listing the caller already holds; `isGone` answers
 * for one id, true only when Dispatcharr says that channel does not exist.
 * Null when there was nothing to do.
 */
export async function pruneDeletedChannelRules(
  path: string,
  listed: Iterable<number>,
  isGone: (channelId: number) => Promise<boolean>,
  now = Date.now(),
): Promise<RulePrune | null> {
  const first = readDoc(path);
  if (!first) return null;

  const listedIds = new Set(listed);
  const ruled = new Set(ruleRows(first.doc).map(ruleId).filter(Number.isFinite));
  const suspects = [...ruled].filter((id) => !listedIds.has(id));
  if (suspects.length === 0) return null;

  if (suspects.length > Math.max(PRUNE_SHARE_FLOOR, ruled.size * MAX_PRUNE_SHARE)) {
    return {
      removed: [],
      backup: null,
      refused:
        `${suspects.length} of ${ruled.size} ruled channels are not in Dispatcharr's channel ` +
        'list; keeping their rules, because that many at once looks like a different ' +
        'Dispatcharr rather than deleted channels',
    };
  }

  const gone = new Set<number>();
  const queue = [...suspects];
  await Promise.all(
    Array.from({ length: Math.min(LOOKUP_CONCURRENCY, queue.length) }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          if (await isGone(id)) gone.add(id);
        } catch {
          // Unknown is not gone. The next pass asks again.
        }
      }
    }),
  );
  if (gone.size === 0) return null;

  // Read again: a rule saved in the UI while the lookups were out must survive
  // the write. Nothing is awaited from here to the rename, and the web server
  // shares this process, so no save can land in between.
  const current = readDoc(path);
  if (!current) return null;
  const kept: RuleRow[] = [];
  const removed: RulePrune['removed'] = [];
  for (const row of ruleRows(current.doc)) {
    if (gone.has(ruleId(row))) {
      removed.push({ id: ruleId(row), name: typeof row.name === 'string' ? row.name : '' });
    } else {
      kept.push(row);
    }
  }
  if (removed.length === 0) return null;

  const backup = `${path}${BACKUP_TAG}${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
  writeFileSync(backup, current.text, 'utf8');
  const tmp = `${path}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ ...(current.doc as object), channels: kept }, null, 1),
    'utf8',
  );
  renameSync(tmp, path);
  trimBackups(path);
  return { removed, backup, refused: null };
}

/** Keep the newest `BACKUPS_KEPT` copies; the ISO stamp sorts by age. */
function trimBackups(path: string): void {
  const dir = dirname(path);
  const prefix = `${basename(path)}${BACKUP_TAG}`;
  const copies = readdirSync(dir)
    .filter((file) => file.startsWith(prefix))
    .sort();
  for (const file of copies.slice(0, Math.max(0, copies.length - BACKUPS_KEPT))) {
    unlinkSync(join(dir, file));
  }
}
