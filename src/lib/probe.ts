/**
 * ffprobe-based stream analysis.
 *
 * Two bounded subprocesses per stream, both hard-killed on timeout: ffprobe for
 * codec/resolution/fps, then one ffmpeg read that yields bitrate and blackness
 * together.
 *
 * There is deliberately no loop detection. Catching a looping stream means
 * watching for at least one loop period -- on the order of 120s per stream
 * against the ~1s this costs, so a full pass would take days rather than hours
 * for a failure mode far rarer than dead, black or throttled.
 */

import { type ChildProcess, spawn } from 'child_process';

const runningChildren = new Set<ChildProcess>();

process.on('exit', () => {
  for (const child of runningChildren) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Ignore
    }
  }
});

export interface ProbeResult {
  alive: boolean;
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  videoCodec: string;
  audioCodec: string;
  /** Pixel format from ffprobe, e.g. "yuv420p". Published for Dispatcharr's UI. */
  pixelFormat: string;
  /** Audio channel count from ffprobe (2 = stereo). Published for Dispatcharr's UI. */
  audioChannels: number;
  elapsedMs: number;
  error: string;
  /** True when bitrate came from reading the stream rather than its metadata. */
  bitrateMeasured?: boolean;
  /**
   * True when the sampled window was mostly a black screen.
   *
   * The failure every quality metric misses: a stream that is alive, correctly
   * sized and comfortably above the bitrate floor, showing a "channel
   * unavailable" slate.
   */
  black?: boolean;
  blackSeconds?: number;
}

export const DEAD: Omit<ProbeResult, 'elapsedMs' | 'error'> = {
  alive: false,
  width: 0,
  height: 0,
  fps: 0,
  bitrateKbps: 0,
  videoCodec: '',
  audioCodec: '',
  pixelFormat: '',
  audioChannels: 0,
};

export interface ProbeOptions {
  /**
   * Read a few seconds of the stream to measure bitrate when the container
   * does not declare one.
   *
   * Live TS/HLS almost never reports `bit_rate` in either the stream or the
   * format block, so without this the highest-weighted scoring term is always
   * zero and same-resolution streams cannot be ranked at all. Cheap in
   * practice: these providers deliver far faster than realtime, so five
   * seconds of stream measured in about a third of a second.
   */
  measureBitrate?: boolean;
  measureSeconds?: number;
  ffmpegPath?: string;
  detectBlack?: boolean;
  /** Fraction of the sampled window that must be black to call it black. */
  blackRatio?: number;
  /** Hard ceiling. A stream that has not answered by then is treated as dead. */
  timeoutMs?: number;
  /**
   * The knob that dominates total run time. The tool this replaces used 30s per
   * stream; ffprobe reliably resolves codec, resolution, fps and bitrate well
   * before that on a live HLS/TS source.
   */
  analyzeSeconds?: number;
  userAgent?: string;
  ffprobePath?: string;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  bit_rate?: string;
  pix_fmt?: string;
  channels?: number;
}

interface FfprobePayload {
  streams?: FfprobeStream[];
  format?: { bit_rate?: string };
}

/**
 * `-user_agent` only applies to HTTP inputs.
 *
 * ffmpeg rejects it outright for a file path -- "Option not found" -- so
 * passing it unconditionally makes the probe work only against http(s) URLs.
 * Real provider streams are HTTP, which is why this went unnoticed, but it also
 * meant none of this could be exercised against a local file.
 */
function userAgentArgs(url: string, userAgent: string): string[] {
  return /^https?:\/\//i.test(url) ? ['-user_agent', userAgent] : [];
}

/**
 * What the input is allowed to reach, beyond itself.
 *
 * A stream URL is not ours: it arrives in the provider's M3U, through
 * Dispatcharr, from whoever sells the subscription. The playlist at the end of
 * it is theirs too, and an HLS playlist can name the protocol of each segment
 * -- so a remote input that is allowed `file` can ask ffmpeg to read the
 * container's filesystem and mix it into the decode. Nothing here reads that
 * output back (it goes to /dev/null), but bitrate and blackness both come out
 * of it, which is enough to answer questions about a file a byte at a time.
 *
 * A remote input therefore gets no `file`, and a local one -- which only exists
 * so this can be exercised against a sample on disk -- gets no network.
 */
function protocolArgs(url: string): string[] {
  return /^https?:\/\//i.test(url)
    ? ['-protocol_whitelist', 'http,https,tcp,tls,crypto,data']
    : ['-protocol_whitelist', 'file,crypto,data'];
}

/**
 * Why a URL cannot be handed to ffmpeg, or empty if it can.
 *
 * `spawn` takes an argv array and never a shell, so there is no injecting a
 * second command here. There is still argument injection: ffprobe takes its
 * input as a positional, so a "URL" of `-report` is read as an option and
 * writes a log file into the working directory instead of probing anything.
 * `--` would also end option parsing, but relying on it means relying on a
 * cmdutils behaviour across every ffmpeg build a self-hoster might have; a
 * stream URL that starts with a dash is not a stream URL, so say so instead.
 */
export function rejectUrl(url: string): string {
  if (url.trim() === '') return 'empty url';
  if (url.startsWith('-')) return 'refusing a url that begins with "-"';
  return '';
}

export function parseFps(rate: string | undefined): number {
  if (!rate || rate === '0/0') return 0;
  if (rate.includes('/')) {
    const [num, den] = rate.split('/', 2);
    const numerator = Number(num);
    const denominator = Number(den);
    if (!denominator || !Number.isFinite(numerator) || !Number.isFinite(denominator)) return 0;
    return Math.round((numerator / denominator) * 100) / 100;
  }
  const value = Number(rate);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

export function parsePayload(payload: FfprobePayload): Omit<ProbeResult, 'elapsedMs' | 'error'> {
  const video = (payload.streams ?? []).find((s) => s.codec_type === 'video');
  const audio = (payload.streams ?? []).find((s) => s.codec_type === 'audio');
  if (!video) return { ...DEAD };

  let bitrate = 0;
  for (const source of [video.bit_rate, payload.format?.bit_rate]) {
    if (!source) continue;
    const value = Number(source);
    if (Number.isFinite(value)) {
      bitrate = value / 1000;
      break;
    }
  }

  return {
    alive: true,
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: parseFps(video.avg_frame_rate ?? video.r_frame_rate),
    bitrateKbps: Math.round(bitrate * 100) / 100,
    videoCodec: video.codec_name ?? '',
    audioCodec: audio?.codec_name ?? '',
    pixelFormat: video.pix_fmt ?? '',
    audioChannels: audio?.channels ?? 0,
  };
}

export interface SampleResult {
  bitrateKbps: number;
  blackSeconds: number;
}

/**
 * Parse what ffmpeg wrote to stderr during a sample.
 *
 * Split out from the spawn so the fiddly parts are testable: the stats line is
 * rewritten repeatedly with \r so only the *last* bitrate is the total for the
 * whole sample, and blackdetect emits one line per black run which must be
 * summed rather than taken singly.
 */
export function parseSampleStderr(stderr: string, blackLines: string): SampleResult {
  const flat = stderr.replace(/\r/g, '\n');
  const rates = [...flat.matchAll(/bitrate=\s*([\d.]+)\s*kbits\/s/g)];
  const bitrateKbps = rates.length > 0 ? Number(rates[rates.length - 1]?.[1] ?? 0) : 0;

  let blackSeconds = 0;
  for (const m of blackLines.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)) {
    blackSeconds += Number(m[2]) - Number(m[1]);
  }
  return { bitrateKbps, blackSeconds: Math.round(blackSeconds * 1000) / 1000 };
}

/**
 * Read a bounded slice of the stream once and derive both bitrate and
 * blackness from it.
 *
 * Two outputs off one input: a stream copy whose muxed size gives the bitrate,
 * and a decoded branch running `blackdetect`. Doing this as two ffmpeg calls
 * would open two connections to the provider and so cost two slots against its
 * concurrency limit -- the reason to fold them together is capacity, not the
 * 0.2s of wall time.
 *
 * Returns zeroes rather than throwing: missing detail degrades ranking, it does
 * not invalidate the probe.
 */
export async function sampleStream(
  url: string,
  options: {
    seconds?: number;
    timeoutMs?: number;
    userAgent?: string;
    ffmpegPath?: string;
    blackMinSeconds?: number;
    blackPixelThreshold?: number;
  } = {},
): Promise<SampleResult> {
  const {
    seconds = 5,
    timeoutMs = 15_000,
    userAgent = 'VLC/3.0.14',
    ffmpegPath = 'ffmpeg',
    blackMinSeconds = 0.5,
    blackPixelThreshold = 0.1,
  } = options;

  const nul = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const args = [
    '-y',
    '-hide_banner',
    '-v',
    'info',
    '-stats',
    // One decode thread.
    //
    // Frame-level threading holds a queue of decoded frames per thread, and on
    // a 1080p source that is where nearly all of this process's memory goes.
    // Measured on a 1080p h264 sample: 177MiB default, 99MiB with one thread.
    // The lane limits allow as many concurrent samples as the providers have
    // slots between them, and nine of the former is what took the live pod past
    // its 2GiB limit and got it OOM-killed.
    //
    // Scaling the picture down before blackdetect was tried here too and made
    // no difference at all (179MiB) -- the frames are allocated by the decoder,
    // long before any filter sees them. It cost wall time for nothing, so it is
    // deliberately not here.
    //
    // These streams arrive far faster than realtime, so a single thread costs
    // about 0.2s on a five-second sample.
    '-threads',
    '1',
    ...userAgentArgs(url, userAgent),
    ...protocolArgs(url),
    '-t',
    String(seconds),
    '-i',
    url,
    // Branch 1: stream copy, for an honest byte count.
    '-map',
    '0',
    '-c',
    'copy',
    '-f',
    'mpegts',
    nul,
    // Branch 2: decode video only, for blackdetect.
    '-map',
    '0:v:0',
    '-vf',
    `blackdetect=d=${blackMinSeconds}:pix_th=${blackPixelThreshold}`,
    '-an',
    '-f',
    'null',
    '-',
  ];

  if (rejectUrl(url)) return { bitrateKbps: 0, blackSeconds: 0 };

  return new Promise<SampleResult>((resolve) => {
    // ffmpegPath defaults to a bare `ffmpeg` resolved from PATH, never a file in
    // this project. Without the opt-out Turbopack cannot prove that and traces
    // the whole source tree into the standalone output.
    const child = spawn(/*turbopackIgnore: true*/ ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    runningChildren.add(child);

    let stderr = '';
    let blackLines = '';
    let lineBuffer = '';
    let settled = false;

    const finish = (value: SampleResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runningChildren.delete(child);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ bitrateKbps: 0, blackSeconds: 0 });
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      if (stderr.length > 16384) stderr = stderr.slice(-8192);

      lineBuffer += text;
      const lines = lineBuffer.split(/[\r\n]+/);
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.includes('black_start')) blackLines += `${line}\n`;
      }
    });

    child.on('error', () => finish({ bitrateKbps: 0, blackSeconds: 0 }));
    child.on('close', () => {
      if (lineBuffer.includes('black_start')) blackLines += `${lineBuffer}\n`;
      finish(parseSampleStderr(stderr, blackLines));
    });
  });
}

export async function probe(url: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const {
    timeoutMs = 12_000,
    analyzeSeconds = 6,
    userAgent = 'VLC/3.0.14',
    ffprobePath = 'ffprobe',
    measureBitrate: shouldMeasure = true,
    measureSeconds = 5,
    ffmpegPath = 'ffmpeg',
    detectBlack = true,
    blackRatio = 0.8,
  } = options;

  const refusal = rejectUrl(url);
  if (refusal) return { ...DEAD, elapsedMs: 0, error: refusal };

  const micros = String(Math.round(analyzeSeconds * 1_000_000));
  const args = [
    '-v',
    'error',
    ...userAgentArgs(url, userAgent),
    ...protocolArgs(url),
    '-analyzeduration',
    micros,
    '-probesize',
    micros,
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    url,
  ];

  const started = Date.now();
  return new Promise<ProbeResult>((resolve) => {
    // Resolved from PATH, not the project tree -- see the note on the ffmpeg spawn.
    const child = spawn(/*turbopackIgnore: true*/ ffprobePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runningChildren.add(child);

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: Omit<ProbeResult, 'elapsedMs'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runningChildren.delete(child);
      resolve({ ...result, elapsedMs: Date.now() - started });
    };

    // The child is still live and holding a provider slot after a timeout, so
    // it must be killed explicitly or the lane leaks.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ...DEAD, error: 'timeout' });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      finish({ ...DEAD, error: `spawn failed: ${error.message}`.slice(0, 200) });
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const lines = stderr.trim().split('\n').filter(Boolean);
        const detail = lines.length > 0 ? lines[lines.length - 1]! : `exit ${code}`;
        finish({ ...DEAD, error: detail.slice(0, 200) });
        return;
      }
      try {
        const parsed = parsePayload(JSON.parse(stdout) as FfprobePayload);
        // Clear ffprobe timer once process exits cleanly
        clearTimeout(timer);

        // A dead stream has nothing worth sampling; a healthy one still does,
        // because live TS rarely declares a bitrate and never reveals a slate.
        if (!parsed.alive || (!shouldMeasure && !detectBlack)) {
          finish({ ...parsed, error: '' });
          return;
        }

        const remainingMs = timeoutMs - (Date.now() - started);
        if (remainingMs <= 0) {
          // Keep ffprobe parsed result with unknown bitrate rather than marking dead
          finish({ ...parsed, bitrateMeasured: false, error: '' });
          return;
        }

        sampleStream(url, {
          seconds: measureSeconds,
          timeoutMs: remainingMs,
          userAgent,
          ffmpegPath,
        })
          .then((sample) => {
            finish({
              ...parsed,
              bitrateKbps:
                shouldMeasure && sample.bitrateKbps > 0 ? sample.bitrateKbps : parsed.bitrateKbps,
              bitrateMeasured: shouldMeasure && sample.bitrateKbps > 0,
              black: detectBlack ? sample.blackSeconds >= measureSeconds * blackRatio : undefined,
              blackSeconds: detectBlack ? Math.round(sample.blackSeconds * 100) / 100 : undefined,
              error: '',
            });
          })
          .catch(() => {
            // Keep parsed ffprobe result on sample timeout
            finish({ ...parsed, bitrateMeasured: false, error: '' });
          });
      } catch (error) {
        clearTimeout(timer);
        finish({ ...DEAD, error: `unparseable: ${String(error)}`.slice(0, 200) });
      }
    });
  });
}
