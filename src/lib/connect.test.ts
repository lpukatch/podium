/**
 * Provisioning: making Dispatcharr's webhook subscriptions match the setting,
 * from any state they were left in.
 *
 * The fake client records the calls rather than performing them; what is under
 * test is the convergence, not Dispatcharr.
 */

import { describe, expect, it } from 'vitest';
import {
  connectEventPath,
  connectIntegrationName,
  connectTokenMatches,
  deprovisionConnectEvents,
  ensureConnectToken,
  provisionConnectEvents,
} from './connect';
import type { DispatcharrClient } from './dispatcharr';

interface ManagedIntegration {
  id: number;
  name: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
  subscriptions: Array<{ event: string; enabled: boolean }>;
}

/** A Dispatcharr stand-in that only knows the Connect calls provisioning makes. */
function fakeDispatcharr(initial: ManagedIntegration[] = []): {
  client: DispatcharrClient;
  calls: string[];
  state: ManagedIntegration[];
} {
  const state: ManagedIntegration[] = initial.map((row) => ({ ...row }));
  const calls: string[] = [];
  let nextId = Math.max(0, ...initial.map((row) => row.id)) + 1;
  const client = {
    connectIntegrations: async () => state.map((row) => ({ ...row })),
    createConnectIntegration: async (
      name: string,
      url: string,
      headers: Record<string, string>,
    ) => {
      calls.push(`create ${name}`);
      const row: ManagedIntegration = {
        id: nextId++,
        name,
        type: 'webhook',
        enabled: true,
        config: { url, headers },
        subscriptions: [],
      };
      state.push(row);
      return { id: row.id };
    },
    updateConnectIntegration: async (
      id: number,
      patch: { webhookUrl?: string; headers?: Record<string, string>; enabled?: boolean },
    ) => {
      calls.push(`update ${id}`);
      const row = state.find((r) => r.id === id);
      if (!row) throw new Error(`no integration ${id}`);
      if (patch.webhookUrl !== undefined) row.config.url = patch.webhookUrl;
      if (patch.headers !== undefined) row.config.headers = patch.headers;
      if (patch.enabled !== undefined) row.enabled = patch.enabled;
    },
    deleteConnectIntegration: async (id: number) => {
      calls.push(`delete ${id}`);
      const at = state.findIndex((r) => r.id === id);
      if (at !== -1) state.splice(at, 1);
    },
    setConnectSubscriptions: async (integrationId: number, events: string[]) => {
      calls.push(`subscribe ${integrationId}: ${events.join(',')}`);
      const row = state.find((r) => r.id === integrationId);
      if (!row) throw new Error(`no integration ${integrationId}`);
      row.subscriptions = events.map((event) => ({ event, enabled: true }));
    },
  } as unknown as DispatcharrClient;
  return { client, calls, state };
}

const INPUT = { podiumUrl: 'http://podium:3456', token: 'tok' };

const STREAM_SWITCH = connectIntegrationName('stream_switch');
const CHANNEL_ERROR = connectIntegrationName('channel_error');

describe('provisionConnectEvents', () => {
  it('creates one integration per event from nothing', async () => {
    const fake = fakeDispatcharr();
    const result = await provisionConnectEvents(fake.client, INPUT);
    expect(result.created).toEqual([STREAM_SWITCH, CHANNEL_ERROR]);
    const byName = new Map(fake.state.map((row) => [row.name, row]));
    expect(byName.get(STREAM_SWITCH)?.config.url).toBe(
      `http://podium:3456${connectEventPath('stream_switch')}`,
    );
    expect(byName.get(STREAM_SWITCH)?.config.headers).toEqual({ 'X-Podium-Connect-Token': 'tok' });
    expect(byName.get(STREAM_SWITCH)?.subscriptions).toEqual([
      { event: 'stream_switch', enabled: true },
    ]);
    expect(byName.get(CHANNEL_ERROR)?.subscriptions).toEqual([
      { event: 'channel_error', enabled: true },
    ]);
  });

  it('is idempotent: the second pass touches nothing', async () => {
    const fake = fakeDispatcharr();
    await provisionConnectEvents(fake.client, INPUT);
    const before = JSON.stringify(fake.state);
    fake.calls.length = 0;
    const result = await provisionConnectEvents(fake.client, INPUT);
    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(JSON.stringify(fake.state)).toBe(before);
  });

  it('repoints an integration left at a stale URL', async () => {
    const fake = fakeDispatcharr([
      {
        id: 4,
        name: STREAM_SWITCH,
        type: 'webhook',
        enabled: true,
        config: { url: 'http://10.244.1.91:3456/api/connect/events/stream_switch', headers: {} },
        subscriptions: [{ event: 'stream_switch', enabled: true }],
      },
    ]);
    const result = await provisionConnectEvents(fake.client, INPUT);
    expect(result.updated).toEqual([STREAM_SWITCH]);
    const row = fake.state.find((r) => r.name === STREAM_SWITCH);
    expect(row?.config.url).toBe(`http://podium:3456${connectEventPath('stream_switch')}`);
    expect(row?.config.headers).toEqual({ 'X-Podium-Connect-Token': 'tok' });
  });

  it('re-enables an integration an operator disabled by hand', async () => {
    const fake = fakeDispatcharr([
      {
        id: 7,
        name: CHANNEL_ERROR,
        type: 'webhook',
        enabled: false,
        config: {
          url: `http://podium:3456${connectEventPath('channel_error')}`,
          headers: { 'X-Podium-Connect-Token': 'tok' },
        },
        subscriptions: [{ event: 'channel_error', enabled: true }],
      },
    ]);
    const result = await provisionConnectEvents(fake.client, INPUT);
    expect(result.updated).toEqual([CHANNEL_ERROR]);
    expect(fake.state[0]?.enabled).toBe(true);
  });

  it('removes integrations in the Podium namespace that nobody manages any more', async () => {
    const fake = fakeDispatcharr([
      {
        id: 9,
        name: 'Podium: channel failover',
        type: 'webhook',
        enabled: true,
        config: { url: 'http://podium:3456/api/connect/events/channel_failover', headers: {} },
        subscriptions: [{ event: 'channel_failover', enabled: true }],
      },
    ]);
    const result = await provisionConnectEvents(fake.client, INPUT);
    expect(result.removed).toEqual(['Podium: channel failover']);
    expect(fake.state.map((row) => row.name)).toEqual([STREAM_SWITCH, CHANNEL_ERROR]);
  });

  it('keeps an operator integration even when it looks almost managed', async () => {
    const fake = fakeDispatcharr([
      {
        id: 11,
        name: 'Podium2 relay',
        type: 'webhook',
        enabled: true,
        config: { url: 'http://elsewhere:8080/hook', headers: {} },
        subscriptions: [{ event: 'stream_switch', enabled: true }],
      },
    ]);
    await provisionConnectEvents(fake.client, INPUT);
    expect(fake.state.map((row) => row.name)).toContain('Podium2 relay');
  });

  it('leaves integrations it does not manage alone', async () => {
    const theirs: ManagedIntegration = {
      id: 3,
      name: 'notify on recording',
      type: 'webhook',
      enabled: true,
      config: { url: 'http://elsewhere:8080/hook', headers: {} },
      subscriptions: [{ event: 'recording_start', enabled: true }],
    };
    const fake = fakeDispatcharr([theirs]);
    await provisionConnectEvents(fake.client, INPUT);
    expect(fake.state.map((row) => row.name)).toContain('notify on recording');
  });

  it('collapses duplicates onto the newest and drops the rest', async () => {
    const fake = fakeDispatcharr([
      {
        id: 5,
        name: STREAM_SWITCH,
        type: 'webhook',
        enabled: true,
        config: { url: 'http://old:1/x', headers: {} },
        subscriptions: [{ event: 'stream_switch', enabled: true }],
      },
      {
        id: 6,
        name: STREAM_SWITCH,
        type: 'webhook',
        enabled: true,
        config: { url: 'http://old:2/x', headers: {} },
        subscriptions: [{ event: 'stream_switch', enabled: true }],
      },
    ]);
    const result = await provisionConnectEvents(fake.client, INPUT);
    // Once for the collapse, and the namespace sweep must not reach for the
    // same row again: one delete, one entry in the report.
    expect(result.removed).toEqual([STREAM_SWITCH]);
    expect(fake.calls.filter((call) => call.startsWith('delete'))).toEqual(['delete 5']);
    expect(fake.state.filter((row) => row.name === STREAM_SWITCH)).toHaveLength(1);
    // Whatever survived is pointing at the current URL.
    expect(fake.state.find((row) => row.name === STREAM_SWITCH)?.config.url).toBe(
      `http://podium:3456${connectEventPath('stream_switch')}`,
    );
  });

  it('adds the front-door token header when the install is token-guarded', async () => {
    const fake = fakeDispatcharr();
    await provisionConnectEvents(fake.client, { ...INPUT, authToken: 'front-door' });
    expect(fake.state[0]?.config.headers).toEqual({
      'X-Podium-Connect-Token': 'tok',
      'X-Podium-Token': 'front-door',
    });
  });

  it('does nothing without an address to point at', async () => {
    const fake = fakeDispatcharr();
    const result = await provisionConnectEvents(fake.client, { podiumUrl: '  ', token: 'tok' });
    expect(result).toEqual({ created: [], updated: [], removed: [] });
    expect(fake.state).toEqual([]);
  });
});

describe('deprovisionConnectEvents', () => {
  it('removes every Podium-named integration and nothing else', async () => {
    const fake = fakeDispatcharr([
      {
        id: 3,
        name: 'notify on recording',
        type: 'webhook',
        enabled: true,
        config: { url: 'http://elsewhere:8080/hook', headers: {} },
        subscriptions: [{ event: 'recording_start', enabled: true }],
      },
      {
        id: 8,
        name: STREAM_SWITCH,
        type: 'webhook',
        enabled: true,
        config: { url: `http://podium:3456${connectEventPath('stream_switch')}`, headers: {} },
        subscriptions: [{ event: 'stream_switch', enabled: true }],
      },
      {
        id: 9,
        name: 'Podium: channel failover',
        type: 'webhook',
        enabled: true,
        config: { url: 'http://podium:3456/api/connect/events/channel_failover', headers: {} },
        subscriptions: [{ event: 'channel_failover', enabled: true }],
      },
    ]);
    const removed = await deprovisionConnectEvents(fake.client);
    // The managed names and the older shape's litter go; an integration an
    // operator named anything else is theirs.
    expect(removed).toEqual([STREAM_SWITCH, 'Podium: channel failover']);
    expect(fake.state.map((row) => row.name)).toEqual(['notify on recording']);
  });
});

describe('the connect token', () => {
  it('keeps an existing one rather than rotating it', () => {
    expect(ensureConnectToken('  abc  ')).toBe('abc');
  });

  it('generates one when there is none', () => {
    const token = ensureConnectToken(undefined);
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    // And again rather than re-reading the first: two calls in a row with
    // nothing stored must not agree, or every install would ship the same
    // secret.
    expect(ensureConnectToken('')).toMatch(/^[0-9a-f]{48}$/);
    expect(ensureConnectToken('')).not.toBe(token);
  });

  it('refuses to match against nothing, which is the unprovisioned state', () => {
    expect(connectTokenMatches('anything', undefined)).toBe(false);
    expect(connectTokenMatches('anything', '')).toBe(false);
    expect(connectTokenMatches('tok', 'tok')).toBe(true);
  });
});
