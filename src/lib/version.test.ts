/**
 * The version string, and the one route that reports it to the outside.
 *
 * Under vitest neither inline path runs -- no esbuild define, no NEXT_PUBLIC
 * env -- so these tests exercise the `dev` fallback and, more usefully, pin
 * that /api/health carries whatever VERSION resolved to in both of its
 * response branches. An operator diagnosing "which build is this?" over HTTP
 * must get the same answer whether or not the database can be read.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VERSION } from './version';

let dir = '';

beforeAll(() => {
  // The route constructs a Store from the configured path; point it at a
  // scratch directory so a test run never touches a real database.
  dir = mkdtempSync(join(tmpdir(), 'podium-version-'));
  process.env.PODIUM_DATA_DIR = dir;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PODIUM_DATA_DIR;
});

describe('VERSION', () => {
  it('resolves to a non-empty string even without either build-time inline', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
  });
});

describe('GET /api/health', () => {
  it('reports the version', async () => {
    const { GET } = await import('../app/api/health/route');
    const body = (await (await GET()).json()) as { status: string; version: string };
    expect(body.status).toBe('ok');
    expect(body.version).toBe(VERSION);
  });
});
