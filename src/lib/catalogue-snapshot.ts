import { randomUUID } from 'crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import type { Store } from './store';

export interface ChannelOrdersSnapshot {
  fetchedAt: number;
  channels: Array<{ id: number; streams: number[] }>;
  /** Older snapshots have no revision and can replay the available updates. */
  orderRevision?: number;
}

/** Apply only orders recorded after this snapshot's crawl or last update. */
export function replayCatalogueOrders(snapshot: ChannelOrdersSnapshot, store: Store): boolean {
  const revision = snapshot.orderRevision ?? 0;
  const updates = store.catalogueOrdersSince(revision);
  if (updates.length === 0) return false;

  const orders = new Map(updates.map(({ channelId, streams }) => [channelId, streams]));
  let changed = false;
  for (const channel of snapshot.channels) {
    const streams = orders.get(channel.id);
    if (
      streams &&
      (streams.length !== channel.streams.length ||
        streams.some((id, index) => id !== channel.streams[index]))
    ) {
      channel.streams = streams;
      changed = true;
    }
  }
  snapshot.orderRevision = updates.reduce(
    (latest, update) => Math.max(latest, update.revision),
    revision,
  );
  return changed;
}

function writeSnapshot(path: string, snapshot: ChannelOrdersSnapshot): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may not have been created.
    }
    throw error;
  }
}

/** Best-effort cache publication, serialized with both web and worker patches. */
export function publishCatalogueSnapshot(
  path: string,
  store: Store,
  snapshot?: ChannelOrdersSnapshot,
): void {
  try {
    store.withCatalogueSnapshotWrite(() => {
      if (snapshot) {
        replayCatalogueOrders(snapshot, store);
        writeSnapshot(path, snapshot);
        return;
      }

      const saved = JSON.parse(readFileSync(path, 'utf8')) as ChannelOrdersSnapshot;
      if (!Array.isArray(saved?.channels)) return;
      const revision = saved.orderRevision;
      replayCatalogueOrders(saved, store);
      if (saved.orderRevision !== revision) writeSnapshot(path, saved);
    });
  } catch {
    // A missing/unwritable cache costs a crawl, not a failed order write.
  }
}
