/**
 * Reading `/proxy/ts/status` for the stability ledger.
 *
 * The payload shape is the one a live Dispatcharr build emits -- uuid channel
 * keys, a `stream_id` from Redis metadata, `started_at` in float seconds, and
 * a running `total_bytes`. The fixtures below are trimmed copies of it.
 */

import { describe, expect, it } from 'vitest';
import { parseStatusPayload } from './dispatcharr';

/** One channel as the live endpoint describes it. */
function live(over: Record<string, unknown> = {}) {
  return {
    channel_id: '09bbd059-1a49-47ee-a525-c1444e1c6bd7',
    state: 'active',
    url: 'https://provider.example/live/a/b/15053.ts',
    owner: 'dispatcharr-abc:317',
    buffer_index: 269,
    client_count: 1,
    uptime: 307.2,
    started_at: 1789529704.443,
    m3u_profile_id: 6,
    stream_id: 77013,
    stream_name: 'DC | Washington | ABC 7 WJLA',
    total_bytes: 179363468,
    avg_bitrate_kbps: 5321.4,
    healthy: true,
    ...over,
  };
}

describe('parseStatusPayload', () => {
  it('reads the fields the ledger needs off a live channel', () => {
    const { channels } = parseStatusPayload({ channels: [live()], count: 1 });
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      key: '09bbd059-1a49-47ee-a525-c1444e1c6bd7',
      streamId: 77013,
      profileId: 6,
      state: 'active',
      healthy: true,
      totalBytes: 179363468,
      clientCount: 1,
    });
  });

  it('converts started_at from float seconds to whole milliseconds', () => {
    const { channels } = parseStatusPayload({ channels: [live()] });
    expect(channels[0]?.startedAt).toBe(1789529704443);
  });

  it('keeps the uuid key even when no map can resolve it to an id', () => {
    const { channels } = parseStatusPayload({ channels: [live()] });
    expect(channels[0]?.key).toBe('09bbd059-1a49-47ee-a525-c1444e1c6bd7');
    expect(channels[0]?.channelId).toBeNull();
  });

  it('resolves the numeric id when a map knows the uuid', () => {
    const { channels } = parseStatusPayload(
      { channels: [live()] },
      { '09bbd059-1a49-47ee-a525-c1444e1c6bd7': 35200 },
    );
    expect(channels[0]?.channelId).toBe(35200);
  });

  it('reports absent numbers as null rather than as zero', () => {
    const { channels } = parseStatusPayload({
      channels: [live({ stream_id: undefined, total_bytes: undefined, started_at: undefined })],
    });
    expect(channels[0]).toMatchObject({ streamId: null, totalBytes: null, startedAt: null });
  });

  it('reads numbers that arrive as strings', () => {
    const { channels } = parseStatusPayload({
      channels: [live({ stream_id: '77013', total_bytes: '4096' })],
    });
    expect(channels[0]).toMatchObject({ streamId: 77013, totalBytes: 4096 });
  });

  it('does not invent a health flag the payload never carried', () => {
    const { channels } = parseStatusPayload({ channels: [live({ healthy: undefined })] });
    expect(channels[0]?.healthy).toBeNull();
  });

  it('keeps a bare id entry, with nothing the ledger can measure', () => {
    const { channels } = parseStatusPayload({ channels: [12], count: 1 });
    expect(channels[0]).toMatchObject({ key: '12', channelId: 12, streamId: null });
  });

  it('reports the payload count even when nothing resolved', () => {
    const { rawCount, channels } = parseStatusPayload({ channels: [live()], count: 1 });
    expect(rawCount).toBe(1);
    expect(channels).toHaveLength(1);
  });

  it('drops a proxy session only when every client is a Podium probe', () => {
    const { channels, ignoredCount } = parseStatusPayload(
      {
        channels: [
          live({ clients: [{ user_agent: 'Podium-Probe/1' }] }),
          live({
            channel_id: 12,
            clients: [{ user_agent: 'Podium-Probe/1' }, { user_agent: 'VLC' }],
          }),
          live({ channel_id: 13 }),
        ],
      },
      undefined,
      { ignoreUserAgent: 'Podium-Probe/1' },
    );
    expect(ignoredCount).toBe(1);
    expect(channels.map((channel) => channel.channelId)).toEqual([12, 13]);
  });

  it('is empty on a payload with no channels', () => {
    expect(parseStatusPayload({ channels: [], count: 0 }).channels).toEqual([]);
    expect(parseStatusPayload({}).channels).toEqual([]);
  });
});
