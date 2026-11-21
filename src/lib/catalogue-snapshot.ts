import { randomUUID } from 'crypto';
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';

interface ChannelOrdersSnapshot {
  fetchedAt: number;
  channels: Array<{ id: number; streams: number[] }>;
}

/** Update only channel orders when the disk snapshot is the same crawl. */
export function mergePersistedChannelOrders(
  current: ChannelOrdersSnapshot,
  persisted: ChannelOrdersSnapshot,
): boolean {
  if (current.fetchedAt !== persisted.fetchedAt) return false;

  const persistedChannels = new Map(persisted.channels.map((channel) => [channel.id, channel]));
  let changed = false;
  for (const channel of current.channels) {
    const saved = persistedChannels.get(channel.id);
    if (
      saved &&
      Array.isArray(saved.streams) &&
      (saved.streams.length !== channel.streams.length ||
        saved.streams.some((id, index) => id !== channel.streams[index]))
    ) {
      channel.streams = [...saved.streams];
      changed = true;
    }
  }
  return changed;
}

/** A cheap token for detecting an order update written by another process. */
export function catalogueSnapshotVersion(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

/** Patch one or more orders into the persisted crawl without rewriting it per channel. */
export function updatePersistedChannelOrders(
  path: string,
  orders: Iterable<readonly [number, readonly number[]]>,
): boolean {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }

  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    !Array.isArray((snapshot as { channels?: unknown }).channels)
  ) {
    return false;
  }

  const channels = (snapshot as { channels: unknown[] }).channels;
  const orderByChannel = new Map(orders);
  if (orderByChannel.size === 0) return false;

  let changed = false;
  for (const channel of channels) {
    if (!channel || typeof channel !== 'object') continue;
    const row = channel as { id?: unknown; streams?: unknown };
    if (typeof row.id !== 'number') continue;
    const order = orderByChannel.get(row.id);
    if (!order) continue;
    row.streams = [...order];
    changed = true;
  }
  if (!changed) return false;

  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may not have been created.
    }
    return false;
  }
}
