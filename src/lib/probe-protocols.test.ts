/**
 * Which transports a stream URL may name, and what ffmpeg may reach through it.
 *
 * One line decided both, and got both wrong in the same way. Anything that did
 * not match `^https?://` was handed the *local* whitelist -- `file,crypto,data`
 * -- so:
 *
 *   - a provider URL of `file:///app/data/podium.db` was probed with `file`
 *     allowed. Nothing reads the decode back, but bitrate and blackness both
 *     come out of it, which answers questions about a file a byte at a time.
 *   - every real streaming protocol an IPTV provider might hand over -- rtmp,
 *     rtsp, srt, udp -- was refused by ffmpeg with a protocol error that read
 *     from the outside like a dead stream.
 *
 * Naming the transports Podium supports fixes both: a scheme in the table is
 * probed with exactly what its own protocol needs, a scheme outside it is
 * refused before anything is spawned, and a bare path still gets the local
 * whitelist, which is how the probe is exercised against a sample on disk.
 */

import { readdirSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { deadReason, probe, rejectUrl, sampleStream, schemeOf } from './probe';

describe('schemeOf', () => {
  it('reads the scheme, and nothing else as one', () => {
    expect(schemeOf('rtmp://host/live')).toBe('rtmp');
    expect(schemeOf('HTTPS://HOST/x')).toBe('https');
    // A path is not a scheme, whatever it contains. The regex is anchored, so a
    // colon further along cannot be read as one.
    expect(schemeOf('/app/data/sample.ts')).toBe('');
    expect(schemeOf('./sample.ts')).toBe('');
    expect(schemeOf('/tmp/odd:name.ts')).toBe('');
  });
});

describe('rejectUrl', () => {
  it('accepts the streaming protocols providers actually hand out', () => {
    for (const url of [
      'http://provider.example/live/1.ts',
      'https://provider.example/live/1.m3u8',
      'rtmp://provider.example/live/key',
      'rtmps://provider.example/live/key',
      'rtsp://camera.lan:554/stream1',
      'srt://provider.example:9000',
      'udp://239.0.0.1:1234',
      'rtp://239.0.0.1:1234',
    ]) {
      expect(rejectUrl(url), url).toBe('');
    }
  });

  it('refuses a scheme that would read the container instead of a stream', () => {
    // The M3U is the provider's, and so is every URL in it.
    expect(rejectUrl('file:///app/data/podium.db')).toContain('file:');
    expect(rejectUrl('file:///dev/zero')).toContain('network streams only');
    // ffmpeg's own demuxer protocols, which read local paths by other names.
    expect(rejectUrl('concat:/etc/passwd|/etc/hosts')).toContain('network streams only');
    expect(rejectUrl('subfile:/app/data/podium.db')).toContain('network streams only');
  });

  it('still accepts a bare path, which is how a sample on disk is probed', () => {
    expect(rejectUrl('/app/data/sample.ts')).toBe('');
    expect(rejectUrl('./sample.ts')).toBe('');
  });

  it('classifies a refused scheme the way every other refusal is classified', () => {
    expect(deadReason(rejectUrl('file:///etc/hosts'))).toBe('rejected');
  });
});

describe('a refused scheme never reaches ffmpeg', () => {
  it('comes back dead, with the reason, and spawns nothing', async () => {
    const before = readdirSync(process.cwd());
    const result = await probe('file:///app/data/podium.db');

    expect(result.alive).toBe(false);
    expect(result.error).toContain('network streams only');
    // The probe is over in no time because nothing was started: a real spawn
    // against a local file, which is what this used to do, takes measurably
    // longer and would have produced a bitrate.
    expect(result.elapsedMs).toBe(0);
    expect(result.bitrateKbps).toBe(0);
    expect(readdirSync(process.cwd())).toEqual(before);
  });

  it('is not sampled either', async () => {
    expect(await sampleStream('file:///dev/zero')).toEqual({ bitrateKbps: 0, blackSeconds: 0 });
  });
});
