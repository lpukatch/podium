/**
 * Parsing Dispatcharr's live-stream event deliveries, and mapping them onto
 * the ledger's vocabulary.
 *
 * The shapes here are what Dispatcharr actually sends -- verified against a
 * live build: the body is form-encoded, absent fields are simply missing, and
 * there is no event name in the body at all.
 */

import { describe, expect, it } from 'vitest';
import { CONNECT_EVENTS, parseConnectEvent, toLedgerEvents } from './connect-events';

const FORM = 'application/x-www-form-urlencoded';

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

describe('parseConnectEvent', () => {
  it('parses the form-encoded spelling Dispatcharr sends', () => {
    const event = parseConnectEvent(
      'stream_switch',
      FORM,
      form({
        channel_id: '09bbd059-1a49-47ee-a525-c1444e1c6bd7',
        channel_name: 'ESPN',
        reason: 'buffering_timeout',
        stream_id: '77177',
        previous_stream_id: '77013',
      }),
      1_000,
    );
    expect(event).toEqual({
      event: 'stream_switch',
      channelKey: '09bbd059-1a49-47ee-a525-c1444e1c6bd7',
      channelId: null,
      streamId: 77177,
      previousStreamId: 77013,
      reason: 'buffering_timeout',
      receivedAt: 1_000,
    });
  });

  it('parses the JSON spelling a build that fixed the encoding would send', () => {
    const event = parseConnectEvent(
      'channel_error',
      'application/json',
      JSON.stringify({ channel_id: 'abc', stream_id: 77013, error_type: 'buffering_timeout' }),
      2_000,
    );
    expect(event).toMatchObject({ channelKey: 'abc', streamId: 77013, reason: '' });
  });

  it('reads absent fields as not-observed, never as values', () => {
    const event = parseConnectEvent('stream_switch', FORM, form({ channel_id: 'abc' }), 3_000);
    expect(event).toEqual({
      event: 'stream_switch',
      channelKey: 'abc',
      channelId: null,
      streamId: null,
      previousStreamId: null,
      reason: '',
      receivedAt: 3_000,
    });
  });

  it('resolves a numeric channel id when the payload carries one', () => {
    const event = parseConnectEvent('channel_error', FORM, form({ channel_id: '35200' }), 4_000);
    expect(event?.channelId).toBe(35200);
  });

  it('refuses a delivery that cannot name a channel', () => {
    expect(
      parseConnectEvent('channel_error', FORM, form({ stream_id: '77013' }), 5_000),
    ).toBeNull();
    expect(parseConnectEvent('channel_error', FORM, '', 5_000)).toBeNull();
    expect(parseConnectEvent('channel_error', 'application/json', '[1,2]', 5_000)).toBeNull();
    expect(parseConnectEvent('channel_error', 'application/json', 'not json', 5_000)).toBeNull();
  });

  it('leaves a uuid alone rather than reading one as a number', () => {
    // Number() would take the leading digits of some uuid spellings; the
    // parse must not invent a channel id from a string that is not one.
    const event = parseConnectEvent('channel_error', FORM, form({ channel_id: '12abc' }), 6_000);
    expect(event?.channelId).toBeNull();
    expect(event?.channelKey).toBe('12abc');
  });
});

describe('toLedgerEvents', () => {
  it('maps switches with manual spelled out', () => {
    const events = toLedgerEvents([
      {
        event: 'stream_switch',
        channelKey: 'abc',
        streamId: 2,
        previousStreamId: 1,
        reason: 'manual',
        receivedAt: 100,
      },
      {
        event: 'stream_switch',
        channelKey: 'abc',
        streamId: 3,
        previousStreamId: 2,
        reason: 'buffering_timeout',
        receivedAt: 200,
      },
    ]);
    expect(events).toEqual([
      {
        at: 100,
        channelKey: 'abc',
        kind: 'switch',
        streamId: 2,
        previousStreamId: 1,
        manual: true,
      },
      {
        at: 200,
        channelKey: 'abc',
        kind: 'switch',
        streamId: 3,
        previousStreamId: 2,
        manual: false,
      },
    ]);
  });

  it('maps channel errors and drops event names it does not speak', () => {
    const events = toLedgerEvents([
      {
        event: 'channel_buffering',
        channelKey: 'abc',
        streamId: 1,
        previousStreamId: null,
        reason: '',
        receivedAt: 50,
      },
      {
        event: 'channel_error',
        channelKey: 'abc',
        streamId: 1,
        previousStreamId: null,
        reason: '',
        receivedAt: 100,
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'error', streamId: 1 });
  });

  it('keeps arrival order, which is what chained switches fold in', () => {
    const events = toLedgerEvents([
      {
        event: 'stream_switch',
        channelKey: 'x',
        streamId: 2,
        previousStreamId: 1,
        reason: '',
        receivedAt: 1,
      },
      {
        event: 'stream_switch',
        channelKey: 'x',
        streamId: 3,
        previousStreamId: 2,
        reason: '',
        receivedAt: 2,
      },
    ]);
    expect(events.map((event) => event.streamId)).toEqual([2, 3]);
  });
});

describe('CONNECT_EVENTS', () => {
  // The receiver routes on the URL path, so the names here and the paths
  // provisioning registers have to be the same strings.
  it('are exactly the names the ledger knows how to fold', () => {
    expect(CONNECT_EVENTS).toEqual(['stream_switch', 'channel_error']);
  });
});
