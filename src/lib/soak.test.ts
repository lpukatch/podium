/**
 * The active soak: holding a stream open to find out how long it lasts.
 *
 * Driven against stub ffmpeg scripts rather than a real stream, because what is
 * being tested is the loop's reading of how a connection ended -- ran its
 * course, came back early, or never served at all -- and each of those is a
 * three-line shell script. A real provider could not be made to reproduce them
 * on demand, which is the whole reason this feature exists.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { soakStream } from './probe';

const usable = process.platform !== 'win32';
const URL_ = 'http://provider.example/live/stream.ts';

let dir: string;

/** A stub ffmpeg that runs the script body and exits. */
function stub(name: string, body: string[]): string {
  const path = join(dir, name);
  writeFileSync(path, ['#!/bin/sh', ...body, ''].join('\n'), { mode: 0o755 });
  return path;
}

describe('soakStream', () => {
  let holds: string;
  let dropsAfterOneSecond: string;
  let refuses: string;

  beforeAll(() => {
    if (!usable) return;
    dir = mkdtempSync(join(tmpdir(), 'podium-soak-'));
    // Serves for as long as it was asked to. `-t <seconds>` is the 8th
    // argument-ish, so rather than parse it the stub sleeps longer than any
    // budget the tests use and relies on nothing killing it early -- which is
    // wrong for a real ffmpeg but right for "this connection did not drop".
    holds = stub('holds', ['sleep 2']);
    dropsAfterOneSecond = stub('drops', [
      'sleep 1',
      "printf '[in#0/mpegts @ 0x1] Error during demuxing: Connection timed out\\n' >&2",
      'exit 1',
    ]);
    refuses = stub('refuses', ["printf 'Server returned 403 Forbidden\\n' >&2", 'exit 1']);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(usable)('reports no drops when the connection serves its whole budget', async () => {
    const result = await soakStream(URL_, { seconds: 2, ffmpegPath: holds });
    expect(result.drops).toBe(0);
    expect(result.legs).toHaveLength(1);
    expect(result.legs[0]?.dropped).toBe(false);
    expect(result.unreachable).toBe(false);
  });

  it.runIf(usable)('counts a connection that comes back early as a drop', async () => {
    const result = await soakStream(URL_, { seconds: 4, ffmpegPath: dropsAfterOneSecond });
    // It reconnects and drops again until the budget runs out, which is what a
    // flapping feed looks like from this side.
    expect(result.drops).toBeGreaterThanOrEqual(2);
    expect(result.legs[0]?.dropped).toBe(true);
    expect(result.heldMs).toBeGreaterThan(0);
  });

  it.runIf(usable)('keeps what ffmpeg said about the drop', async () => {
    const result = await soakStream(URL_, { seconds: 2, ffmpegPath: dropsAfterOneSecond });
    expect(result.legs[0]?.error).toContain('Connection timed out');
  });

  it.runIf(usable)('stops early, as unreachable, when it cannot connect at all', async () => {
    const result = await soakStream(URL_, { seconds: 60, ffmpegPath: refuses });
    // Two dead dials and it gives up rather than spending a minute redialling.
    expect(result.unreachable).toBe(true);
    expect(result.legs).toHaveLength(2);
    expect(result.legs[0]?.error).toContain('403');
  });

  it.runIf(usable)('honours a lower dead-connection limit', async () => {
    const result = await soakStream(URL_, {
      seconds: 60,
      ffmpegPath: refuses,
      maxDeadConnections: 1,
    });
    expect(result.legs).toHaveLength(1);
    expect(result.unreachable).toBe(true);
  });

  it.runIf(usable)('reports a spawn failure as unreachable rather than hanging', async () => {
    const result = await soakStream(URL_, {
      seconds: 60,
      ffmpegPath: join(dir, 'does-not-exist'),
    });
    expect(result.unreachable).toBe(true);
    expect(result.legs[0]?.error).toContain('spawn failed');
  });

  it('refuses a hostile url without spawning anything', async () => {
    const result = await soakStream('file:///etc/passwd', { seconds: 60 });
    expect(result).toEqual({ legs: [], heldMs: 0, drops: 0, unreachable: false });
  });

  it('spends nothing when the budget is already gone', async () => {
    // `now` is injected so the loop's own deadline arithmetic can be driven
    // without waiting for a clock.
    const result = await soakStream(URL_, { seconds: 0, now: () => 1_000 });
    expect(result.legs).toEqual([]);
    expect(result.heldMs).toBe(0);
  });
});
