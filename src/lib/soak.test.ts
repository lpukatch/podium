/**
 * The active soak: holding a stream open to find out how long it lasts.
 *
 * Driven against stub ffmpeg scripts rather than a real stream, because what is
 * being tested is the loop's reading of how a connection ended -- ran its
 * course, came back early, or never served at all -- and each of those is a
 * three-line shell script. A real provider could not be made to reproduce them
 * on demand, which is the whole reason this feature exists.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
  let recordsArgs: string;
  let argsFile: string;

  beforeAll(() => {
    if (!usable) return;
    dir = mkdtempSync(join(tmpdir(), 'podium-soak-'));
    // A live stream never ends on its own, so neither does this: it serves
    // until the soak's own clock kills it. `exec` so the kill lands on the
    // process holding the pipe -- a `sleep` left behind as a child of `sh`
    // would keep stderr open and the leg would not end until it did.
    holds = stub('holds', ['exec sleep 60']);
    argsFile = join(dir, 'args.txt');
    recordsArgs = stub('records', [`printf '%s\\n' "$@" > '${argsFile}'`, 'exec sleep 60']);
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

  it.runIf(usable)('stops between connections when told to', async () => {
    let calls = 0;
    const result = await soakStream(URL_, {
      seconds: 30,
      ffmpegPath: dropsAfterOneSecond,
      // Let the first connection finish, then stop.
      stop: () => ++calls > 3,
    });
    expect(result.legs.length).toBeLessThan(5);
  });

  it.runIf(usable)('kills a connection already running rather than waiting it out', async () => {
    // The point of the stop hook. runLanes stops *dispatching* on an abort,
    // which is right for a ten-second probe and wrong for a three-minute soak:
    // without this a viewer arriving would wait out every soak in flight
    // before getting the connections back.
    const startedAt = Date.now();
    const result = await soakStream(URL_, {
      seconds: 30,
      ffmpegPath: holds,
      stop: () => Date.now() - startedAt > 1_000,
    });
    // Well inside the 30s budget it was given.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    // The killed connection is not recorded: charging the stream for a
    // connection this process cut would invent evidence against it.
    expect(result.legs).toEqual([]);
    expect(result.drops).toBe(0);
    // And it says so, which is what keeps the request in the queue. Without
    // this a stopped soak looked identical to a measured clean one and was
    // marked done unmeasured.
    expect(result.stopped).toBe(true);
  });

  it.runIf(usable)('does not stop when the hook stays false', async () => {
    const result = await soakStream(URL_, {
      seconds: 2,
      ffmpegPath: holds,
      stop: () => false,
    });
    expect(result.legs).toHaveLength(1);
    expect(result.legs[0]?.dropped).toBe(false);
    expect(result.stopped).toBe(false);
  });

  it.runIf(usable)('does not hand ffmpeg a media-time length', async () => {
    // The regression. `-t` is media time, and a live provider bursts buffered
    // stream on connect, so a healthy feed reached its `-t` before the wall
    // clock did and every such early finish was recorded as a drop. The first
    // real soak of a feed already seen playing clean for five minutes came back
    // with four drops, every one manufactured.
    await soakStream(URL_, { seconds: 1, ffmpegPath: recordsArgs });
    const args = readFileSync(argsFile, 'utf8').split('\n');
    expect(args).not.toContain('-t');
  });

  it.runIf(usable)('counts a connection still serving at the deadline as clean', async () => {
    const startedAt = Date.now();
    const result = await soakStream(URL_, { seconds: 1, ffmpegPath: holds });
    expect(result.drops).toBe(0);
    expect(result.legs).toEqual([{ heldMs: expect.any(Number), dropped: false, error: '' }]);
    // Ended by the soak's clock, not by the stub, which would have run a minute.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('refuses a hostile url without spawning anything', async () => {
    const result = await soakStream('file:///etc/passwd', { seconds: 60 });
    expect(result).toEqual({
      legs: [],
      heldMs: 0,
      drops: 0,
      unreachable: false,
      stopped: false,
    });
  });

  it('spends nothing when the budget is already gone', async () => {
    // `now` is injected so the loop's own deadline arithmetic can be driven
    // without waiting for a clock.
    const result = await soakStream(URL_, { seconds: 0, now: () => 1_000 });
    expect(result.legs).toEqual([]);
    expect(result.heldMs).toBe(0);
  });
});
