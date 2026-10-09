/**
 * Making Dispatcharr tell Podium about stream failures.
 *
 * The stability ledger reconstructs failures by diffing ten-second polls, and
 * reconstruct has a cost: a switch is only ever seen at the next poll, an
 * operator's manual change bills the stream it left, and a channel Dispatcharr
 * gives up on is charged to nobody. Dispatcharr's Connect webhooks say all
 * three outright on builds with the richer live-stream events -- so when the
 * setting is on, Podium subscribes itself.
 *
 * ## How a subscription is shaped
 *
 * A delivery's body is the event dict and nothing else: no event name (only
 * Dispatcharr's own "test" button sends one), no signature, no timestamp. The
 * event type therefore has to travel in the URL, and the only lever that sets
 * a URL is the *integration* -- subscriptions hang off one and share it. So
 * provisioning creates one webhook integration per subscribed event, each
 * pointing at its own path under Podium:
 *
 *     Podium: stream switch  ->  <PODIUM_CONNECT_URL>/api/connect/events/stream_switch
 *     Podium: channel error  ->  <PODIUM_CONNECT_URL>/api/connect/events/channel_error
 *
 * The names are the contract between this module and the receiver route:
 * integrations are matched by exact name, so an operator renaming one in
 * Dispatcharr's UI produces a second one on the next provision pass rather
 * than a silently un-updated URL.
 *
 * The body carries no authentication either, so the secret travels in
 * headers: the integration is created with `X-Podium-Connect-Token`, which
 * the receiver checks against the token in Podium's settings, plus
 * `X-Podium-Token` when `PODIUM_AUTH_TOKEN` guards this install's front door.
 * `requests.post(url, data=payload, headers=headers)` sends both verbatim.
 */

import { randomBytes } from 'crypto';
import { secretEquals } from './access';
import { CONNECT_EVENTS, type ConnectEventName } from './connect-events';
import type { DispatcharrClient } from './dispatcharr';

/** The webhook URL path segment for one event type. */
export function connectEventPath(event: ConnectEventName): string {
  return `/api/connect/events/${event}`;
}

/** The integration name provisioning manages for one event type. */
export function connectIntegrationName(event: ConnectEventName): string {
  if (event === 'stream_switch') return 'Podium: stream switch';
  return 'Podium: channel error';
}

/**
 * The token deliveries must carry, creating one if the settings have none.
 *
 * Stored in the settings table rather than the environment because it is
 * generated here, not chosen by an operator -- the same place the UI-entered
 * Dispatcharr credential lives, and readable by the receiver route, which is
 * the only thing that needs it.
 */
export function ensureConnectToken(existing: string | undefined): string {
  const trimmed = (existing ?? '').trim();
  if (trimmed !== '') return trimmed;
  return randomBytes(24).toString('hex');
}

export interface ProvisionInput {
  /** The base address Dispatcharr should call Podium at, no trailing path. */
  podiumUrl: string;
  /** The token deliveries must carry; see `ensureConnectToken`. */
  token: string;
  /** Podium's front-door token, when one guards this install. */
  authToken?: string;
}

export interface ProvisionResult {
  created: string[];
  updated: string[];
  removed: string[];
}

function deliveryHeaders(input: ProvisionInput): Record<string, string> {
  const headers: Record<string, string> = { 'X-Podium-Connect-Token': input.token };
  const auth = (input.authToken ?? '').trim();
  // The front door accepts this header as a credential, so a token-protected
  // install does not have to choose between its API auth and its webhooks.
  if (auth !== '') headers['X-Podium-Token'] = auth;
  return headers;
}

function sameDelivery(
  config: Record<string, unknown>,
  url: string,
  headers: Record<string, string>,
): boolean {
  if (config.url !== url) return false;
  const existing = (config.headers ?? {}) as Record<string, unknown>;
  return (
    Object.keys(existing).length === Object.keys(headers).length &&
    Object.entries(headers).every(([key, value]) => existing[key] === value)
  );
}

function trimSlashes(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/**
 * Make Dispatcharr's subscriptions match the setting, whatever state they were
 * left in.
 *
 * Idempotent rather than create-once, for the same reason the worker re-reads
 * settings: the state can drift -- an operator edits or disables the
 * integration in Dispatcharr's UI, upgrades recreate the database, the Podium
 * URL changes -- and a subscription that quietly stopped delivering is worse
 * than none, because the ledger keeps scoring from polls alone and nothing
 * ever says the events went missing. Every provision pass therefore converges
 * on the same small state and costs one listing to confirm it.
 *
 * Integrations that match the managed names but point somewhere else are
 * *repointed*, not left alone -- a stale URL is exactly the drift this exists
 * to repair. Anything else in the list, including integrations an operator
 * made by hand for other listeners, is untouched.
 */
export async function provisionConnectEvents(
  client: DispatcharrClient,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const base = trimSlashes(input.podiumUrl);
  if (base === '') return { created: [], updated: [], removed: [] };
  const headers = deliveryHeaders(input);
  const existing = await client.connectIntegrations();

  const result: ProvisionResult = { created: [], updated: [], removed: [] };
  const managedIds = new Set<number>();
  // Already deleted by the duplicate collapse below, so the namespace sweep at
  // the end must not reach for them a second time.
  const goneIds = new Set<number>();

  for (const event of CONNECT_EVENTS) {
    const name = connectIntegrationName(event);
    const url = `${base}${connectEventPath(event)}`;
    const mine = existing.filter((row) => row.name === name);
    // Extras beyond the first are an operator's duplicate; the newest wins and
    // the rest go, so a rerun converges instead of accumulating.
    mine.sort((a, b) => b.id - a.id);
    const keep = mine[0];
    const drop = mine.slice(1);
    for (const row of drop) {
      await client.deleteConnectIntegration(row.id);
      goneIds.add(row.id);
      result.removed.push(name);
    }
    if (keep === undefined) {
      const created = await client.createConnectIntegration(name, url, headers);
      await client.setConnectSubscriptions(created.id, [event]);
      result.created.push(name);
      managedIds.add(created.id);
      continue;
    }
    managedIds.add(keep.id);
    if (!sameDelivery(keep.config, url, headers) || !keep.enabled) {
      await client.updateConnectIntegration(keep.id, { webhookUrl: url, headers, enabled: true });
      result.updated.push(name);
    }
    const wants = [event];
    const subscribed = new Set(
      keep.subscriptions.filter((sub) => sub.enabled).map((sub) => sub.event),
    );
    if (keep.subscriptions.length !== wants.length || wants.some((want) => !subscribed.has(want))) {
      await client.setConnectSubscriptions(keep.id, wants);
      if (!result.updated.includes(name)) result.updated.push(name);
    }
  }

  // Integrations in Podium's naming namespace that are no longer managed --
  // left over from an older build of this feature that subscribed to
  // different events -- are Podium's own litter and are removed. Anything
  // else in the list, including integrations an operator made by hand for
  // other listeners, is theirs and is kept: matching by exact name for
  // updates and by the "Podium:" prefix for removal means a rename in
  // Dispatcharr's UI produces a fresh managed integration rather than a
  // silently un-updated URL.
  for (const row of existing) {
    if (managedIds.has(row.id) || goneIds.has(row.id)) continue;
    if (!row.name.startsWith('Podium:')) continue;
    await client.deleteConnectIntegration(row.id);
    result.removed.push(row.name);
  }

  return result;
}

/**
 * Take down everything `provisionConnectEvents` could have left: the off side
 * of the same convergence.
 *
 * A subscription that kept delivering after the operator turned the setting
 * off would keep the ledger charging from events nobody asked for, and nothing
 * else ever removes it -- the receiver cannot see the setting, and Dispatcharr
 * has no expiry. The namespace rule is provisioning's own: everything
 * `Podium:`-prefixed goes, integrations an operator named anything else stay.
 */
export async function deprovisionConnectEvents(client: DispatcharrClient): Promise<string[]> {
  const existing = await client.connectIntegrations();
  const removed: string[] = [];
  for (const row of existing) {
    if (!row.name.startsWith('Podium:')) continue;
    await client.deleteConnectIntegration(row.id);
    removed.push(row.name);
  }
  return removed;
}

/** True when the delivery carried the token the settings expect. */
export function connectTokenMatches(presented: string, stored: string | undefined): boolean {
  const expected = (stored ?? '').trim();
  if (expected === '') return false;
  return secretEquals(presented.trim(), expected);
}
