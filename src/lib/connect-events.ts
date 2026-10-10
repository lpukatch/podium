/**
 * Dispatcharr's live stream events, as Connect webhooks.
 *
 * Dispatcharr's proxy knows, from the inside, the three things the stability
 * ledger can only reconstruct by diffing ten-second polls of `/proxy/ts/status`:
 * which stream stalled, which stream the channel switched away from, and when
 * it had nowhere left to switch to. Builds since Connect grew the richer
 * payloads (#1564) put a `stream_id` on those events and a
 * `previous_stream_id` on switches, which is exactly the vocabulary the ledger
 * speaks -- so this module turns webhook deliveries into rows the worker can
 * fold into the tracker.
 *
 * Two event types are worth a subscription, and the other live-proxy events
 * are deliberately not subscribed to:
 *
 *   - `stream_switch` carries `previous_stream_id`, the new `stream_id` and
 *     the switch `reason`, which is everything a leg ending wants. The
 *     `channel_failover` event that fires alongside it says less (no previous
 *     stream) about the same instant, so subscribing to both would double the
 *     deliveries to dedupe rather than add a field.
 *   - `channel_error` with `error_type: buffering_timeout` is the stall that
 *     had nowhere to go: Dispatcharr could not switch, the channel is about to
 *     disappear, and the poller -- which charges a vanished channel to nobody
 *     -- would let the stream off uncharged. This is the one event that closes
 *     that gap.
 *
 *   `channel_buffering` and `channel_reconnect` describe the same-URL stall
 *   the byte counter already sees on the next poll; subscribing would count
 *   episodes the poller also counts, so the two sources would have to be
 *   reconciled before either could be trusted. Left out of this first pass.
 *
 * ## What a delivery looks like
 *
 * The body is whatever `requests.post(url, data=payload)` makes of the event
 * dict -- form-encoded, not JSON, unless the subscription carries a payload
 * template. Both spellings parse here, so a Dispatcharr that fixes the
 * encoding later does not turn into an outage. There is no `event` field on a
 * real delivery (only the connection's own "test" payload carries one), which
 * is why the receiver routes on the URL path and provisioning points one
 * integration per event type at its own path.
 *
 * Field discipline is the same as `parseStatusPayload`'s: a field the payload
 * did not carry reads as null, never as a value. Dispatcharr strips absent
 * fields before sending -- `previous_stream_id` only exists on switches that
 * know what they left, and the stream fields can be stripped when the Redis
 * state behind them has already cleared.
 */

import type { StreamEvent } from './stability';

/** The events Podium subscribes to, and the only paths the receiver accepts. */
export const CONNECT_EVENTS = ['stream_switch', 'channel_error'] as const;

export type ConnectEventName = (typeof CONNECT_EVENTS)[number];

export function isConnectEventName(raw: string): raw is ConnectEventName {
  return (CONNECT_EVENTS as readonly string[]).includes(raw);
}

/** One delivery, parsed and ready to store. */
export interface ConnectEvent {
  event: ConnectEventName;
  /** Optional display context; never used to identify or charge a leg. */
  channelName?: string;
  /**
   * The channel, as the ledger spells it.
   *
   * The payload's `channel_id` is the channel uuid -- the same identifier
   * `/proxy/ts/status` uses as its key -- so an event and a poll sample meet
   * in the tracker without a catalogue lookup. Null never happens here: the
   * live-proxy events are always raised with a channel, and a delivery
   * without one cannot be attributed to a leg at all, so it is refused at
   * parse.
   */
  channelKey: string;
  /** The numeric channel id when the payload carried one; context only. */
  channelId: number | null;
  /**
   * The stream the event is about: the one serving now on a switch, the one
   * that stalled on an error. Null when the payload did not say -- which for
   * a switch makes it unfolderable (nothing to open a leg on) and for an
   * error unchargeable, both of which the drain treats as "nothing observed"
   * rather than as a failure.
   */
  streamId: number | null;
  /** What a switch switched away from, when Dispatcharr knew. */
  previousStreamId: number | null;
  /** The switch reason verbatim (`buffering_timeout`, `manual`, ...). */
  reason: string;
  /** When the delivery arrived, in milliseconds. The leg timestamps come from this. */
  receivedAt: number;
}

/** A numeric field, or null when the payload did not carry a usable one. */
function eventNumber(val: unknown): number | null {
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (typeof val !== 'string' || val.trim() === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function firstString(val: unknown): string {
  // Form bodies carry every value as a string; a JSON spelling carries real
  // types, and a channel id that arrived as a number is still a channel id --
  // refusing it would bar the very JSON builds this parser prepares for.
  if (typeof val === 'string') return val;
  if (typeof val === 'number' && Number.isFinite(val)) return String(val);
  return '';
}

/**
 * How stale a queued delivery may be when the drain reaches it.
 *
 * A minute -- six poll intervals, so ordinary operation never hits it. Beyond
 * that the delivery describes a channel whose legs have mostly moved on, and
 * folding it late would close a leg that is serving fine now; the failures it
 * names are lost to the ledger, which is the same undercount a poll that
 * could not read the channel makes.
 */
export const MAX_CONNECT_EVENT_AGE_MS = 60_000;

/**
 * Queued deliveries, in the tracker's terms, in arrival order.
 *
 * Rows whose event names nobody here speaks -- a downgrade, or a newer build
 * that subscribed to something else -- are dropped rather than passed: the
 * tracker treats an unknown event as noise, and guessing a kind would charge
 * a stream on a guess.
 */
export function toLedgerEvents(
  rows: Array<{
    event: string;
    channelKey: string;
    streamId: number | null;
    previousStreamId: number | null;
    reason: string;
    receivedAt: number;
  }>,
): StreamEvent[] {
  const out: StreamEvent[] = [];
  for (const row of rows) {
    if (row.event === 'stream_switch') {
      out.push({
        at: row.receivedAt,
        channelKey: row.channelKey,
        kind: 'switch',
        streamId: row.streamId,
        previousStreamId: row.previousStreamId,
        // The only reason an operator's own change carries; every other
        // reason -- buffering_timeout, max_retries_exceeded, health_monitor --
        // is Dispatcharr failing the stream over because the feed broke.
        manual: row.reason === 'manual',
      });
      continue;
    }
    if (row.event === 'channel_error') {
      out.push({
        at: row.receivedAt,
        channelKey: row.channelKey,
        kind: 'error',
        streamId: row.streamId,
        previousStreamId: null,
        manual: false,
      });
    }
  }
  return out;
}

/**
 * Flatten a delivery body into one record.
 *
 * Form-encoded bodies carry every value as a string, JSON ones as their real
 * types; both arrive with absent fields simply missing. `null` for the event
 * name means the body had nothing usable in it at all.
 */
export function parseConnectEvent(
  event: ConnectEventName,
  contentType: string,
  text: string,
  receivedAt: number,
): ConnectEvent | null {
  let fields: Record<string, unknown>;
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === 'application/json') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      fields = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  } else {
    // The spelling Dispatcharr actually sends today. Anything that is not
    // JSON is parsed as a form rather than refused -- a body nobody
    // recognises still names its fields the same way, and refusing it would
    // trade one unknown encoding for a silently dead ledger.
    fields = Object.fromEntries(new URLSearchParams(text));
  }

  const channelKey = firstString(fields.channel_id).trim();
  if (channelKey === '') return null;
  return {
    event,
    ...(fields.channel_name ? { channelName: firstString(fields.channel_name).slice(0, 200) } : {}),
    channelKey,
    channelId: eventNumber(fields.channel_id),
    streamId: eventNumber(fields.stream_id),
    previousStreamId: eventNumber(fields.previous_stream_id),
    reason:
      firstString(fields.reason) ||
      (event === 'channel_error' ? firstString(fields.error_type) : ''),
    receivedAt,
  };
}
