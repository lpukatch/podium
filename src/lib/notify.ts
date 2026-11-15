/**
 * Outbound webhook notifications: Podium telling the outside world that
 * something happened, instead of waiting for somebody to open the UI.
 *
 * Everything Podium reacts to is already detected -- a channel written, a
 * stream removed, a channel left with nothing watchable, a pass that failed --
 * and all of it was display-only. This is the smallest possible emitter for
 * the same events: a fire-and-forget JSON POST to a URL the operator chose,
 * shaped for the consumers such URLs actually have (ntfy, Home Assistant,
 * a self-hosted script), never awaited by the work that raised it.
 *
 * Deliberately not a notification *framework*: there is one URL, one payload
 * shape, no per-event filter, no retry. A retry would turn "at most once"
 * into "at least once" and double-fire into a consumer's automations; a
 * failed delivery is logged and dropped, and the next event of the same kind
 * carries the state again. `send` reads the URL from live config on every
 * event, so editing it in the UI takes effect on the next event rather than
 * on the next restart.
 *
 * The inbound half of this story -- Dispatcharr *calling* Podium -- is
 * `connect.ts`, which is a different direction and a different trust model.
 */

import type { Config } from './config';
import type { Log } from './rules-source';
import type { DegradedChannelRow } from './store';

/** How long a delivery may hang before it is treated as a failure. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * The most events delivered per window before the flood guard starts
 * dropping. A first pass with auto-assign on can legitimately write hundreds
 * of channels in minutes; a consumer receiving that burst is being attacked
 * by a friend. Dropped events are logged once per window, not per event.
 */
export const WEBHOOK_FLOOD_LIMIT = 20;
export const WEBHOOK_FLOOD_WINDOW_MS = 60_000;

/** One stream, named well enough to recognise it in a phone notification. */
export interface StreamRef {
  id: number;
  name: string;
  provider: string;
  /**
   * Why a write took this stream off a channel: `dead` (over the
   * remove-dead-after threshold) or `per-provider cap` (see
   * PODIUM_AUTO_ASSIGN_MAX_PER_PROVIDER). Absent on an addition.
   */
  reason?: string;
}

/** One event, in the shape the JSON body carries (besides the envelope). */
export type WebhookEvent =
  /**
   * The worker changed a channel in Dispatcharr -- reordered it, assigned
   * streams to it, or removed streams from it. One event per write, carrying
   * everything the write did: this is the audit trail the pass log only
   * prints once. Never emitted for a dry run, which writes nothing.
   */
  | {
      event: 'channel_updated';
      channelId: number;
      channelName: string;
      reordered: boolean;
      added: StreamRef[];
      removed: StreamRef[];
      /** What the channel leads with now, and what it led with before. */
      lead: StreamRef | null;
      was: StreamRef | null;
    }
  /**
   * A managed channel ended a pass with no watchable stream: every stream it
   * carries measured dead or black, and at least one of them has a verdict
   * (a channel never measured is unknown, not down). Sent once per
   * transition into that state, tracked durably, so a worker restart does
   * not re-announce an ongoing outage.
   */
  | {
      event: 'channel_down';
      channelId: number;
      channelName: string;
      /** How many streams the channel carries. */
      slots: number;
      /** What a viewer gets first, and why it is not watchable. */
      lead: { streamId: number; provider: string; status: 'dead' | 'black' | 'unmeasured' };
    }
  /**
   * The mirror of `channel_down`: a tracked channel carries something
   * watchable again. Also once per transition. `lead` is null when the
   * channel has left the catalogue entirely -- recovered by leaving, which
   * is worth saying rather than hiding.
   */
  | {
      event: 'channel_recovered';
      channelId: number;
      channelName: string;
      lead: { streamId: number; provider: string } | null;
    }
  /** A whole pass threw. Sent on the transition into failing, not per retry. */
  | { event: 'run_failed'; error: string }
  /** The synthetic event the settings page's test button sends. */
  | { event: 'test' };

/** The wire shape: the envelope is Podium's, the rest is the event. */
export type WebhookPayload = { source: 'podium'; sentAt: string } & WebhookEvent;

/** What one delivery attempt came to. `deliver` never throws. */
export interface DeliveryResult {
  ok: boolean;
  /** The HTTP status, when something answered. */
  status?: number;
  /** Why it did not deliver, when it did not. */
  error?: string;
}

/**
 * Anything at all that answers is success, not just 2xx: the consumers of
 * this URL range from ntfy (201) to a personal script (200) to a Home
 * Assistant webhook that answers 200 only when the trigger exists. What
 * matters is that the request arrived at something that chose a status --
 * a 500 from the consumer's own handler is that consumer's problem to see,
 * and reporting it as failure would invite a retry the design above rules
 * out. So `ok` is "delivered"; the status travels alongside for the test
 * route to show.
 */
const delivered = (status: number): DeliveryResult => ({ ok: true, status });

export interface Webhook {
  /**
   * Fire-and-forget: queues the delivery and returns immediately, so a slow
   * or dead consumer never delays the pass that raised the event. Subject to
   * the flood guard; failures are logged, never thrown.
   */
  send: (event: WebhookEvent) => void;
  /**
   * Deliver and wait, reporting the outcome. The test route's path: the
   * settings page is asking "does this URL answer", which is exactly the
   * question `send` exists to never block on. Not flood-guarded -- a test
   * is a deliberate, human-paced action.
   */
  deliver: (event: WebhookEvent) => Promise<DeliveryResult>;
}

/**
 * Is this text a usable webhook URL? Empty is legal (notifications off);
 * anything else must be an absolute http(s) URL with no credentials in it.
 *
 * Unlike the base URLs (`base-url.ts`) this one is posted to verbatim -- its
 * path *is* the destination for the consumers that use one, so it is kept
 * exactly as typed where a base URL would have its path refused. Credentials
 * are still refused: they ride in the URL, and the URL travels into logs on
 * both ends. Consumers that need a secret carry it in the path (ntfy, Home
 * Assistant) or front the endpoint with their own auth.
 */
export function webhookUrlProblem(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return 'Not a URL. Enter a full address, for example https://ntfy.example/podium';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Only http and https URLs can receive a webhook.';
  }
  if (url.username || url.password) {
    return 'Put no credentials in the URL -- they would sit in plaintext in both servers’ logs. Use a token in the path, or auth in front of the endpoint.';
  }
  return null;
}

/** The JSON body one event travels as. Pure, so tests pin the shape. */
export function webhookPayload(event: WebhookEvent, now = new Date()): WebhookPayload {
  return { source: 'podium', sentAt: now.toISOString(), ...event };
}

export function createWebhook(config: () => Config, log: Log): Webhook {
  // Send timestamps inside the flood window. A full bucket drops the event
  // rather than queuing it: a queue that outlives the incident replays it
  // at whoever just survived it.
  const recent: number[] = [];
  let floodLoggedAt = 0;

  const underLimit = (): boolean => {
    const now = Date.now();
    while (recent.length > 0) {
      const oldest = recent[0];
      if (oldest === undefined || now - oldest < WEBHOOK_FLOOD_WINDOW_MS) break;
      recent.shift();
    }
    if (recent.length >= WEBHOOK_FLOOD_LIMIT) {
      // Once per window: a consumer that is down does not need one line per
      // dropped event saying so.
      if (now - floodLoggedAt >= WEBHOOK_FLOOD_WINDOW_MS) {
        floodLoggedAt = now;
        log(
          `webhook flood guard dropped events -- over ${WEBHOOK_FLOOD_LIMIT}/` +
            `${WEBHOOK_FLOOD_WINDOW_MS / 1000}s; the writes themselves are still in the pass log`,
        );
      }
      return false;
    }
    recent.push(now);
    return true;
  };

  const deliver = async (event: WebhookEvent): Promise<DeliveryResult> => {
    const url = config().PODIUM_WEBHOOK_URL.trim();
    if (!url) return { ok: false, error: 'No webhook URL is set.' };
    const problem = webhookUrlProblem(url);
    if (problem) return { ok: false, error: problem };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhookPayload(event)),
      });
      return delivered(response.status);
    } catch (error) {
      // Readable for the same reason teamarr-client's is: "fetch failed"
      // names neither the address nor the reason, and the operator is
      // deciding whether the consumer is down or the address is wrong.
      if (controller.signal.aborted) {
        return {
          ok: false,
          error: `No answer within ${WEBHOOK_TIMEOUT_MS / 1000}s`,
        };
      }
      const cause = (error as { cause?: { code?: string } }).cause;
      const why = cause?.code ? ` (${cause.code})` : '';
      return { ok: false, error: `Could not reach the webhook${why}` };
    } finally {
      clearTimeout(timer);
    }
  };

  const send = (event: WebhookEvent): void => {
    if (!underLimit()) return;
    void deliver(event).then((out) => {
      if (!out.ok) log(`webhook delivery failed: ${out.error}`);
    });
  };

  return { send, deliver };
}

/**
 * The slice of the store the sweep reads, stated structurally so tests can
 * hand-build it -- the same bargain `dead.ts` strikes with its catalog. The
 * degraded row type lives with the query that produces it, in `store.ts`.
 */
export interface DegradedStore {
  degradedChannels(): DegradedChannelRow[];
  /** The current verdict on one stream, or null when it has none. */
  streamVerdictStatus(streamId: number): 'live' | 'black' | 'dead' | null;
  /** What a viewer would be served first on a channel, if it is catalogued. */
  catalogueLead(channelId: number): { streamId: number; provider: string } | null;
  notifyStateAll(): Array<{ key: string; value: string; at: number }>;
  notifyStateSet(key: string, value: string, at: number): void;
  notifyStateDelete(key: string): void;
}

/** The state key marking a channel as currently down. */
export const channelDownKey = (channelId: number): string => `channel_down:${channelId}`;
const CHANNEL_DOWN_PREFIX = 'channel_down:';

export interface SweepOutcome {
  /** Channels announced as down on this sweep. */
  announced: number;
  /** Tracked channels that came back on this sweep. */
  recovered: number;
}

/**
 * Diff the degraded set against the durable tracking state and emit the
 * transitions.
 *
 * Runs after each pass, over the whole managed catalogue -- not over what the
 * pass happened to probe -- because down-ness is a property of the verdicts a
 * channel carries right now, and a pass that probed one provider's lane still
 * changed the answer for every channel carrying that provider's streams.
 *
 * The tracking rows live in the store, not in memory, so the semantics
 * survive the worker: a restart mid-outage does not re-announce every down
 * channel, and a recovery while the worker was down is announced at the next
 * pass instead of being lost. The URL being unset (or the flood guard
 * dropping) does not consume a transition -- only the send call does, so an
 * install that adds a URL mid-outage hears about the outage at the next pass
 * rather than never.
 *
 * Synchronous on purpose: `send` is fire-and-forget, so the sweep adds one
 * catalog query and one state-table read to the pass and no network time.
 */
export function sweepDegraded(
  store: DegradedStore,
  notify: { send: (event: WebhookEvent) => void },
  now = Date.now(),
): SweepOutcome {
  const degraded = store.degradedChannels();
  const tracked = store.notifyStateAll().filter((row) => row.key.startsWith(CHANNEL_DOWN_PREFIX));
  const trackedKeys = new Set(tracked.map((row) => row.key));

  let announced = 0;
  for (const channel of degraded) {
    const key = channelDownKey(channel.channelId);
    if (trackedKeys.has(key)) continue;
    // `live` cannot reach a channel whose usable count is zero, but the
    // verdict read is a separate query -- defend the invariant here rather
    // than letting a type lie travel to a consumer.
    const status =
      channel.leadStreamId === null
        ? 'unmeasured'
        : store.streamVerdictStatus(channel.leadStreamId);
    notify.send({
      event: 'channel_down',
      channelId: channel.channelId,
      channelName: channel.channelName,
      slots: channel.slots,
      lead: {
        streamId: channel.leadStreamId ?? 0,
        provider: channel.leadProvider ?? '',
        status: status === 'live' ? 'unmeasured' : (status ?? 'unmeasured'),
      },
    });
    store.notifyStateSet(key, channel.channelName, now);
    announced += 1;
  }

  let recovered = 0;
  for (const row of tracked) {
    const id = Number(row.key.slice(CHANNEL_DOWN_PREFIX.length));
    if (degraded.some((channel) => channelDownKey(channel.channelId) === row.key)) continue;
    // A key that no longer parses was never written by this sweep; drop it
    // rather than announce a recovery for a channel id that cannot exist.
    if (!Number.isInteger(id) || id <= 0) {
      store.notifyStateDelete(row.key);
      continue;
    }
    const lead = store.catalogueLead(id);
    notify.send({
      event: 'channel_recovered',
      channelId: id,
      // The name as it was when the channel went down: the catalogue may no
      // longer carry the channel at all, and the old name is what the down
      // notification said.
      channelName: row.value,
      lead,
    });
    store.notifyStateDelete(row.key);
    recovered += 1;
  }

  return { announced, recovered };
}
