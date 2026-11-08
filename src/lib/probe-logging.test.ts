import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { deadReason } from './probe';

describe('probe error classification', () => {
  it('classifies common probe failure reasons for logging', () => {
    expect(deadReason('timeout')).toBe('timeout');
    expect(deadReason('Server returned 403 Forbidden')).toBe('auth');
    expect(deadReason('401 Unauthorized')).toBe('auth');
    expect(deadReason('Server returned 404 Not Found')).toBe('not_found');
    expect(deadReason('Server returned 502 Bad Gateway')).toBe('server_error');
    expect(deadReason('connect ECONNREFUSED 192.168.1.1:8080')).toBe('unreachable');
    expect(deadReason('Invalid data found when processing input')).toBe('unsupported');
    expect(deadReason('refusing a url with no scheme')).toBe('rejected');
    expect(deadReason('spawn failed: ENOENT')).toBe('probe_error');
    expect(deadReason('unknown weird error')).toBe('other');
  });
});

describe('PODIUM_DEBUG configuration', () => {
  it('defaults to false', () => {
    const config = loadConfig({ DISPATCHARR_API_KEY: 'k' });
    expect(config.PODIUM_DEBUG).toBe(false);
  });

  it('can be enabled via PODIUM_DEBUG env var', () => {
    expect(loadConfig({ DISPATCHARR_API_KEY: 'k', PODIUM_DEBUG: 'true' }).PODIUM_DEBUG).toBe(true);
    expect(loadConfig({ DISPATCHARR_API_KEY: 'k', PODIUM_DEBUG: '1' }).PODIUM_DEBUG).toBe(true);
    expect(loadConfig({ DISPATCHARR_API_KEY: 'k', PODIUM_DEBUG: 'on' }).PODIUM_DEBUG).toBe(true);
    expect(loadConfig({ DISPATCHARR_API_KEY: 'k', PODIUM_DEBUG: 'false' }).PODIUM_DEBUG).toBe(
      false,
    );
  });

  it('falls back to standard DEBUG environment variable', () => {
    const prev = process.env.DEBUG;
    try {
      process.env.DEBUG = '1';
      expect(loadConfig({ DISPATCHARR_API_KEY: 'k' }).PODIUM_DEBUG).toBe(true);

      process.env.DEBUG = 'podium';
      expect(loadConfig({ DISPATCHARR_API_KEY: 'k' }).PODIUM_DEBUG).toBe(true);

      process.env.DEBUG = '0';
      expect(loadConfig({ DISPATCHARR_API_KEY: 'k' }).PODIUM_DEBUG).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = prev;
    }
  });

  it('allows PODIUM_DEBUG to override DEBUG environment variable', () => {
    const prev = process.env.DEBUG;
    try {
      process.env.DEBUG = '1';
      expect(loadConfig({ DISPATCHARR_API_KEY: 'k', PODIUM_DEBUG: 'false' }).PODIUM_DEBUG).toBe(
        false,
      );
    } finally {
      if (prev === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = prev;
    }
  });
});
