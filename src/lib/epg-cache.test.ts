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
