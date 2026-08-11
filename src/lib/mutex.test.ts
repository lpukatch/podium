import { describe, expect, it } from 'vitest';
import { Mutex } from './mutex';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe('Mutex', () => {
  it('never runs two tasks at once, and keeps call order', async () => {
    const mutex = new Mutex();
    let active = 0;
    let peak = 0;
    const task = async (label: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
      return label;
    };

    const results = await Promise.all([
      mutex.run(() => task('a')),
      mutex.run(() => task('b')),
      mutex.run(() => task('c')),
    ]);

    expect(peak).toBe(1);
    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('runs the next task even when the previous one rejected', async () => {
    const mutex = new Mutex();
    const seen: string[] = [];

    await Promise.allSettled([
      mutex.run(async () => {
        seen.push('a');
        throw new Error('boom');
      }),
      mutex.run(async () => {
        seen.push('b');
      }),
    ]);

    expect(seen).toEqual(['a', 'b']);
  });

  it('propagates a rejection to the caller and stays usable', async () => {
    const mutex = new Mutex();
    await expect(
      mutex.run(async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');

    expect(await mutex.run(async () => 'ok')).toBe('ok');
  });
});
