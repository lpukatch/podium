import { describe, expect, it } from 'vitest';
import { EpgCache } from './epg-cache';

describe('EpgCache', () => {
  it('misses until a value is recorded', () => {
    const cache = new EpgCache<string[]>(() => 1000);
    expect(cache.fresh('http://d', 60_000)).toBeNull();
    expect(cache.stale('http://d')).toBeNull();
  });

  it('serves a value within the TTL and misses once it expires', () => {
    let now = 1000;
    const cache = new EpgCache<string[]>(() => now);
    cache.set('http://d', ['a', 'b']);

    expect(cache.fresh('http://d', 60_000)).toEqual(['a', 'b']);
    now += 59_000;
    expect(cache.fresh('http://d', 60_000)).toEqual(['a', 'b']);
    now += 2_000; // 61s elapsed -> stale
    expect(cache.fresh('http://d', 60_000)).toBeNull();
    // ...but the last good value is still recoverable.
    expect(cache.stale('http://d')).toEqual(['a', 'b']);
  });

  it('treats a different source as a miss even when the entry is fresh', () => {
    let now = 1000;
    const cache = new EpgCache<string[]>(() => now);
    cache.set('http://d', ['a']);

    now += 10_000;
    expect(cache.fresh('http://other', 60_000)).toBeNull();
    expect(cache.stale('http://other')).toBeNull();
    // The original source is still served.
    expect(cache.fresh('http://d', 60_000)).toEqual(['a']);
  });

  it('replaces the entry when set is called again', () => {
    let now = 1000;
    const cache = new EpgCache<string[]>(() => now);
    cache.set('http://d', ['a']);
    now += 10_000;
    cache.set('http://d', ['b', 'c']);
    expect(cache.fresh('http://d', 60_000)).toEqual(['b', 'c']);
  });
});

describe('EpgCache.expiresAt', () => {
  it('reports when the cached grid stops being fresh', () => {
    let now = 1_000_000;
    const cache = new EpgCache<string[]>(() => now);
    // Nothing cached: no time to aim at, so the caller must not sleep on one.
    expect(cache.expiresAt('http://d', 60_000)).toBeNull();

    cache.set('http://d', ['a']);
    expect(cache.expiresAt('http://d', 60_000)).toBe(1_060_000);

    // A different backend is a miss here for the same reason it is a miss in
    // `fresh`: those rows describe somewhere else.
    expect(cache.expiresAt('http://other', 60_000)).toBeNull();

    // Past its TTL the answer is in the past, which is what tells the loop to
    // fetch rather than wait.
    now += 90_000;
    expect(cache.expiresAt('http://d', 60_000)).toBeLessThan(now);
  });
});
