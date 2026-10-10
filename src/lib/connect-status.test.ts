import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { connectStatus } from './connect-status';
import { Store } from './store';

describe('Connect status', () => {
  it('distinguishes disabled, incomplete, unchecked, failed and configured states', () => {
    const store = new Store(':memory:');
    try {
      const config = loadConfig({
        PODIUM_CONNECT_EVENTS: 'true',
        PODIUM_CONNECT_URL: 'http://podium:3456',
      });
      const summary = store.connectActivity().summary;
      expect(connectStatus({ ...config, PODIUM_CONNECT_EVENTS: false }, summary)).toBe('disabled');
      expect(connectStatus({ ...config, PODIUM_STABILITY: false }, summary)).toBe('blocked');
      expect(connectStatus({ ...config, PODIUM_CONNECT_URL: ' ' }, summary)).toBe('blocked');
      expect(connectStatus(config, summary)).toBe('pending');
      store.recordConnectSync(
        {
          wanted: true,
          podiumUrl: config.PODIUM_CONNECT_URL,
          dispatcharrUrl: config.DISPATCHARR_URL,
        },
        'Failed',
      );
      expect(connectStatus(config, store.connectActivity().summary)).toBe('error');
      store.recordConnectSync(
        {
          wanted: true,
          podiumUrl: config.PODIUM_CONNECT_URL,
          dispatcharrUrl: config.DISPATCHARR_URL,
        },
        null,
      );
      expect(connectStatus(config, store.connectActivity().summary)).toBe('listening');
      expect(
        connectStatus(
          { ...config, PODIUM_CONNECT_URL: 'http://other:3456' },
          store.connectActivity().summary,
        ),
      ).toBe('pending');
      expect(
        connectStatus(
          { ...config, DISPATCHARR_URL: 'http://other:9191' },
          store.connectActivity().summary,
        ),
      ).toBe('pending');
      expect(
        connectStatus(
          { ...config, PODIUM_CONNECT_URL: 'http://podium:3456/' },
          store.connectActivity().summary,
        ),
      ).toBe('listening');
    } finally {
      store.close();
    }
  });
});
