import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSampleStderr, probe, sampleStream } from './probe';

/** ffmpeg is installed in CI; skip the integration tests where it is not. */
function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('parseSampleStderr', () => {
  it('takes the last bitrate, not the first', () => {
    // ffmpeg rewrites the stats line with \r as it goes; only the final line
    // is the total for the whole sample.
    const stderr =
      'frame=  10 bitrate= 100.0kbits/s\rframe=  50 bitrate= 900.5kbits/s\r' +
      'frame= 302 bitrate=4744.1kbits/s';
    expect(parseSampleStderr(stderr, '').bitrateKbps).toBe(4744.1);
  });

  it('reports zero when no bitrate was printed', () => {
    expect(parseSampleStderr('some error text', '').bitrateKbps).toBe(0);
  });

  it('sums every black run rather than taking one', () => {
    const black =
      '[blackdetect] black_start:0 black_end:1.5 black_duration:1.5\n' +
      '[blackdetect] black_start:3 black_end:4.25 black_duration:1.25\n';
    expect(parseSampleStderr('', black).blackSeconds).toBe(2.75);
  });

  it('reports no black when blackdetect said nothing', () => {
    expect(parseSampleStderr('bitrate=500.0kbits/s', '').blackSeconds).toBe(0);
  });

  it('handles both together', () => {
    const result = parseSampleStderr(
      'bitrate= 1.0kbits/s\rbitrate=2500.0kbits/s',
      '[blackdetect] black_start:0 black_end:5 black_duration:5\n',
    );
    expect(result).toEqual({ bitrateKbps: 2500, blackSeconds: 5 });
  });
});

describe('probe against generated video', () => {
  const available = hasFfmpeg();
  let dir: string;
  let blackFile: string;
  let colourFile: string;

  beforeAll(() => {
    if (!available) return;
    dir = mkdtempSync(join(tmpdir(), 'podium-probe-'));
    blackFile = join(dir, 'black.ts');
    colourFile = join(dir, 'colour.ts');
    // A genuinely black clip, and a moving test pattern that is not.
    execFileSync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=640x360:r=25:d=4',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      blackFile,
    ]);
    execFileSync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=s=640x360:r=25:d=4',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      colourFile,
    ]);
  }, 120_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(available)(
    'reads resolution, fps and codec off a real file',
    async () => {
      const result = await probe(colourFile, { detectBlack: false, measureBitrate: false });
      expect(result.alive).toBe(true);
      expect(result.width).toBe(640);
      expect(result.height).toBe(360);
      expect(result.fps).toBe(25);
      expect(result.videoCodec).toBe('h264');
      // pix_fmt comes straight off the ffprobe JSON we already fetch; the fixture
      // is encoded -pix_fmt yuv420p and has no audio track.
      expect(result.pixelFormat).toBe('yuv420p');
      expect(result.audioChannels).toBe(0);
    },
    120_000,
  );

  it.runIf(available)(
    'flags a black clip and leaves a real picture alone',
    async () => {
      // The failure every quality metric misses: alive, right size, healthy
      // bitrate, showing nothing.
      const black = await probe(blackFile, { measureSeconds: 3, blackRatio: 0.5 });
      const colour = await probe(colourFile, { measureSeconds: 3, blackRatio: 0.5 });
      expect(black.black).toBe(true);
      expect(colour.black).toBe(false);
    },
    120_000,
  );

  it.runIf(available)(
    'measures a bitrate the container does not declare',
    async () => {
      const sample = await sampleStream(colourFile, { seconds: 3 });
      expect(sample.bitrateKbps).toBeGreaterThan(0);
    },
    120_000,
  );

  it.runIf(available)(
    'treats a file that is not media as dead, without throwing',
    async () => {
      const result = await probe(join(dir, 'does-not-exist.ts'), {
        detectBlack: false,
        measureBitrate: false,
      });
      expect(result.alive).toBe(false);
      expect(result.error).not.toBe('');
    },
    120_000,
  );

  it.runIf(available)(
    'gives up at the timeout rather than hanging',
    async () => {
      const started = Date.now();
      const result = await probe('http://127.0.0.1:1/nothing', {
        timeoutMs: 2000,
        detectBlack: false,
        measureBitrate: false,
      });
      expect(result.alive).toBe(false);
      expect(Date.now() - started).toBeLessThan(20_000);
    },
    120_000,
  );
});
