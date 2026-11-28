/** The version string and the lightweight health route that reports it. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { VERSION } from './version';

vi.mock('@/lib/config', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('@/lib/store', () => ({
  STALE_LOCK_MS: 120_000,
  Store: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('VERSION', () => {
  it('resolves to a non-empty string even without either build-time inline', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
  });
});

describe('GET /api/health', () => {
  it('reports the version without reading configuration or SQLite', async () => {
    vi.stubEnv('PODIUM_DATA_DIR', '/path/that/does/not/exist');

    const { GET } = await import('../app/api/health/route');
    const response = await GET();
    const body = await response.json();
    const { loadConfig } = await import('@/lib/config');
    const { Store } = await import('@/lib/store');

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: 'ok', version: VERSION });
    expect(loadConfig).not.toHaveBeenCalled();
    expect(Store).not.toHaveBeenCalled();
  });
});
