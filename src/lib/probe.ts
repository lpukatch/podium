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
  /** Audio channel count from ffprobe (2 = stereo, 6 = 5.1). Published for Dispatcharr's UI. */
  audioChannels: number;
  /** ffprobe's layout name for that track, e.g. "stereo" or "5.1(side)". */
  channelLayout: string;
  /** Declared bitrate of that track in kbps, 0 when the container omits it. */
  audioBitrateKbps: number;
  /** Sample rate of that track in Hz, e.g. 48000. */
  audioSampleRate: number;
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
  /**
   * ffprobe's `field_order`: `progressive`, `tt`/`bb`/`tb`/`bt` when
   * interlaced, `unknown` when it could not tell. Optional because every
   * verdict cached before this existed is missing it, and absent must read as
   * "not known to be interlaced" rather than as progressive.
   */
  fieldOrder?: string;
  /**
   * ffprobe's `color_transfer`: `arib-std-b67` for HLG, `smpte2084` for PQ
   * (HDR10), `bt709` for SDR. The one field that separates a provider's HLG
   * variant of a channel from its HDR10 one -- both are hevc / yuv420p10le /
   * 3840x2160 in every other respect. Optional because live TS streams often
   * omit it, and absent must read as "not known" rather than as SDR.
   */
  colorTransfer?: string;
  /** ffprobe's `color_primaries`, e.g. `bt2020` or `bt709`. Optional as above. */
  colorPrimaries?: string;
}

/**
 * Whether the picture is interlaced, from ffprobe's `field_order`.
 *
 * The three answers are not two: `unknown` is common on a short read of a live
 * TS, and treating it as interlaced would halve the frame rate of streams
 * nobody has established anything about. Only an explicit field order counts.
 */
export function isInterlaced(result: Pick<ProbeResult, 'fieldOrder'>): boolean {
  const order = result.fieldOrder;
  if (!order) return false;
  return order === 'tt' || order === 'bb' || order === 'tb' || order === 'bt';
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
  channelLayout: '',
  audioBitrateKbps: 0,
  audioSampleRate: 0,
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
  /**
   * When true, allows audio-only streams (no video track) to be considered alive.
   * If false (default), missing video track marks the stream as DEAD.
   */
  audioOnly?: boolean;
}

export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  /**
   * `progressive`, one of `tt`/`bb`/`tb`/`bt` for interlaced, or `unknown`.
   * Already in `-show_streams` output; reading it costs nothing extra.
   */
  field_order?: string;
  /**
   * `arib-std-b67` (HLG), `smpte2084` (PQ) or `bt709` (SDR). Also already in
   * `-show_streams` output; ffprobe omits the key when the stream does not say.
   */
  color_transfer?: string;
  /** `bt2020`, `bt709`. Omitted by ffprobe when unknown, as above. */
  color_primaries?: string;
  bit_rate?: string;
  pix_fmt?: string;
  channels?: number;
  channel_layout?: string;
  sample_rate?: string;
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
 * The transports a stream URL may name, and what each one may reach.
 *
 * A stream URL is not ours: it arrives in the provider's M3U, through
 * Dispatcharr, from whoever sells the subscription. The playlist at the end of
 * it is theirs too, and an HLS playlist can name the protocol of each segment
 * -- so a remote input that is allowed `file` can ask ffmpeg to read the
 * container's filesystem and mix it into the decode. Nothing here reads that
 * output back (it goes to /dev/null), but bitrate and blackness both come out
 * of it, which is enough to answer questions about a file a byte at a time.
 *
 * Hence a whitelist per scheme rather than one for "anything remote": an HTTP
 * input can follow a playlist to another HTTP segment, which is how HLS works,
 * and cannot open a UDP socket or a local file on the way. The transports each
 * entry carries are the ones its own protocol needs -- RTSP negotiates RTP over
 * UDP or TCP, RTMPS is RTMP inside TLS -- and no more.
 */
const PROTOCOL_WHITELISTS: Record<string, string> = {
  http: 'http,https,tcp,tls,crypto,data',
  https: 'http,https,tcp,tls,crypto,data',
  rtmp: 'rtmp,rtmpt,tcp,crypto,data',
  rtmps: 'rtmps,rtmpts,tcp,tls,crypto,data',
  rtsp: 'rtsp,rtp,udp,tcp,crypto,data',
  rtsps: 'rtsp,rtsps,rtp,udp,tcp,tls,crypto,data',
  srt: 'srt,udp,crypto,data',
  udp: 'udp,crypto,data',
  rtp: 'rtp,udp,crypto,data',
};

/** The scheme a URL names, lowercased, or empty for a bare path. */
export function schemeOf(url: string): string {
  return /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())?.[1]?.toLowerCase() ?? '';
}

/**
 * The table's entry for a scheme, if it has one of its own.
 *
 * Not a bare index: `constructor:` is a scheme by the regex above, and indexing
 * a plain object with it finds `Object` on the prototype -- truthy, so a check
 * on the result let it through, and `spawn` stringified the function into
 * ffmpeg's whitelist argument.
 */
function whitelistFor(scheme: string): string | undefined {
  return Object.hasOwn(PROTOCOL_WHITELISTS, scheme) ? PROTOCOL_WHITELISTS[scheme] : undefined;
}

function protocolArgs(url: string): string[] {
  // `rejectUrl` has already refused anything not in the table, so the fallback
  // is unreachable rather than a policy -- and if it ever becomes reachable, it
  // should be the strictest thing here rather than the loosest: no files, and
  // no network.
  return ['-protocol_whitelist', whitelistFor(schemeOf(url)) ?? 'crypto,data'];
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
 *
 * The scheme is checked against the table above rather than against a list of
 * schemes to refuse. Everything that used to fall outside `^https?://` was
 * handed the *local* whitelist, which is two bugs sharing a line: a provider
 * URL of `file:///app/data/podium.db` was probed with `file` allowed, and every
 * real streaming protocol -- rtmp, rtsp, srt, udp -- was refused by ffmpeg with
 * a protocol error that read like the stream was dead. One of those is a
 * disclosure and the other is a whole class of stream Podium could not measure;
 * naming the transports it does support fixes both at once.
 *
 * A bare path is refused with the rest. It used to be let through, with a
 * `file` whitelist, so the probe could be pointed at a sample on disk -- but an
 * M3U line is any string, Dispatcharr stores it as the stream's URL, and ffmpeg
 * opens a string with no scheme as a local file. That was `file://` by another
 * spelling, and nothing in Podium ever probed a sample that way.
 */
export function rejectUrl(url: string): string {
  if (url.trim() === '') return 'empty url';
  if (url.startsWith('-')) return 'refusing a url that begins with "-"';
  const scheme = schemeOf(url);
  if (!scheme) {
    return 'refusing a url with no scheme -- Podium probes network streams only';
  }
  if (!whitelistFor(scheme)) {
    // Worded to start the way the refusal above does: `deadReason` classifies
    // "refusing a url..." as `rejected`, and a message that reads the same to a
    // person but not to that test would land in the `other` bucket.
    return `refusing a url with a "${scheme}:" scheme -- Podium probes network streams only`;
  }
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

/**
 * The audio track a viewer will actually hear, out of everything on offer.
 *
 * Providers ship multi-track streams -- one of these carries HE-AAC stereo,
 * E-AC-3 stereo and E-AC-3 5.1 on the same channel -- and taking the first one
 * reported a "5.1 + Stereo" stream as 2-channel aac, because the stereo track
 * happens to be listed first. Most channels means best audio, which is also
 * ffmpeg's own default stream selection, so this is what a player picks too.
 *
 * Ties keep the earlier track: with nothing to separate them, the one the
 * provider listed first is the one a player defaults to.
 */
export function pickAudio(streams: FfprobeStream[]): FfprobeStream | undefined {
  let best: FfprobeStream | undefined;
  for (const stream of streams) {
    if (stream.codec_type !== 'audio') continue;
    if (!best || (stream.channels ?? 0) > (best.channels ?? 0)) best = stream;
  }
  return best;
}

/** A numeric ffprobe field, or 0 when absent or unparseable. */
function toNumber(raw: string | undefined): number {
  if (!raw) return 0;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

export function parsePayload(
  payload: FfprobePayload,
  audioOnly = false,
): Omit<ProbeResult, 'elapsedMs' | 'error'> {
  const video = (payload.streams ?? []).find((s) => s.codec_type === 'video');
  const audio = pickAudio(payload.streams ?? []);
  if (!video && !audio) return { ...DEAD };
  if (!video && !audioOnly) return { ...DEAD };

  let bitrate = 0;
  for (const source of [video?.bit_rate, audio?.bit_rate, payload.format?.bit_rate]) {
    if (!source) continue;
    const value = Number(source);
    if (Number.isFinite(value)) {
      bitrate = value / 1000;
      break;
    }
  }

  return {
    alive: true,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    // `??` alone was wrong: ffprobe returns the *string* `0/0` for an
    // undeterminable rate rather than omitting the key, so a nullish check
    // never reached `r_frame_rate` and the stream scored 0 on fps. Falling
    // back on the parsed value covers both the missing key and `0/0`.
    fps: video ? parseFps(video.avg_frame_rate) || parseFps(video.r_frame_rate) : 0,
    bitrateKbps: Math.round(bitrate * 100) / 100,
    videoCodec: video?.codec_name ?? '',
    audioCodec: audio?.codec_name ?? '',
    pixelFormat: video?.pix_fmt ?? '',
    ...(video?.field_order ? { fieldOrder: video.field_order } : {}),
    ...(video?.color_transfer ? { colorTransfer: video.color_transfer } : {}),
    ...(video?.color_primaries ? { colorPrimaries: video.color_primaries } : {}),
    audioChannels: audio?.channels ?? 0,
    channelLayout: audio?.channel_layout ?? '',
    // Unlike video, audio tracks do declare a bitrate in these streams -- ac3
    // and E-AC-3 carry it in the syncframe and aac in the ADTS header -- so
    // this needs no sampling to be worth reading.
    audioBitrateKbps: Math.round(toNumber(audio?.bit_rate) / 10) / 100,
    audioSampleRate: Math.round(toNumber(audio?.sample_rate)),
  };
}

export interface SampleResult {
  bitrateKbps: number;
  blackSeconds: number;
  /** True when the sample was cut short, so it covers less than the full window. */
  truncated?: boolean;
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
 * A sample that runs out of time still returns what it read. `-stats` rewrites
 * the total continuously, so the last line printed before the kill is an honest
 * average over the portion that was muxed -- and throwing that away is why 4K
 * streams came back with an unknown bitrate. The decode branch feeding
 * `blackdetect` is single-threaded and roughly realtime at 2160p, so a
 * five-second sample of 4K regularly outlasts the budget left over from
 * ffprobe, where the same sample at 1080p finishes in a fraction of a second.
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
    hasVideo?: boolean;
  } = {},
): Promise<SampleResult> {
  const {
    seconds = 5,
    timeoutMs = 15_000,
    userAgent = 'VLC/3.0.14',
    ffmpegPath = 'ffmpeg',
    blackMinSeconds = 0.5,
    blackPixelThreshold = 0.1,
    hasVideo = true,
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
    // Branch 2: decode video only, for blackdetect (only if video is present).
    ...(hasVideo
      ? [
          '-map',
          '0:v:0',
          '-vf',
          `blackdetect=d=${blackMinSeconds}:pix_th=${blackPixelThreshold}`,
          '-an',
          '-f',
          'null',
          '-',
        ]
      : []),
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

    /**
     * What the child has said so far. `stderr` already holds every chunk;
     * `lineBuffer` is only the tail that has not been split into lines yet, so
     * it is consulted for a blackdetect line the splitter has not seen.
     */
    const parseCollected = (): SampleResult => {
      const trailing = lineBuffer.includes('black_start') ? `${lineBuffer}\n` : '';
      return parseSampleStderr(stderr, blackLines + trailing);
    };

    const finish = (value: SampleResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runningChildren.delete(child);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ...parseCollected(), truncated: true });
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
    child.on('close', () => finish(parseCollected()));
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
    audioOnly = false,
  } = options;

  const refusal = rejectUrl(url);
  if (refusal) return { ...DEAD, elapsedMs: 0, error: refusal };

  const args = [
    // `error`, never `quiet`: a failed probe says why only on stderr, and the
    // last line of it is what `deadReason` classifies. Silence the channel and
    // every dead stream reports `exit 1` -- one `other` bucket where the
    // auth/not-found/server/unreachable split used to be.
    '-v',
    'error',
    ...userAgentArgs(url, userAgent),
    ...protocolArgs(url),
    '-analyzeduration',
    `${Math.round(analyzeSeconds * 1_000_000)}`,
    '-probesize',
    `${Math.round(analyzeSeconds * 1_000_000)}`,
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
        const parsed = parsePayload(JSON.parse(stdout) as FfprobePayload, audioOnly);
        // Clear ffprobe timer once process exits cleanly
        clearTimeout(timer);

        const hasVideo = Boolean(parsed.width || parsed.height || parsed.videoCodec);
        const canDetectBlack = detectBlack && hasVideo;

        // A dead stream has nothing worth sampling; a healthy one still does,
        // because live TS rarely declares a bitrate and never reveals a slate.
        if (!parsed.alive || (!shouldMeasure && !canDetectBlack)) {
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
          hasVideo,
        })
          .then((sample) => {
            // A cut-short sample still measured a real bitrate over the bytes it
            // read, but its black total is only a floor: the run it was in the
            // middle of never ended. Judging that floor against the full window
            // would report a definite "not black" on evidence we do not have, so
            // an unfinished sample that has not already cleared the bar leaves
            // the verdict open instead.
            const blackEnough =
              canDetectBlack && sample.blackSeconds >= measureSeconds * blackRatio;
            finish({
              ...parsed,
              bitrateKbps:
                shouldMeasure && sample.bitrateKbps > 0 ? sample.bitrateKbps : parsed.bitrateKbps,
              bitrateMeasured: shouldMeasure && sample.bitrateKbps > 0,
              black: canDetectBlack && (blackEnough || !sample.truncated) ? blackEnough : undefined,
              blackSeconds: canDetectBlack
                ? Math.round(sample.blackSeconds * 100) / 100
                : undefined,
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

/** The bounded set `deadReason` maps ffmpeg's stderr onto. */
export const DEAD_REASONS = [
  'auth',
  'not_found',
  'client_error',
  'server_error',
  'timeout',
  'unreachable',
  'unsupported',
  'rejected',
  'probe_error',
  'other',
] as const;
export type DeadReason = (typeof DEAD_REASONS)[number];

/**
 * Why a dead verdict is dead, in a handful of buckets.
 *
 * `result.error` is the last line of ffmpeg's stderr, which is unbounded text
 * and useless as a Prometheus label -- every URL produces its own. The point of
 * folding it is that "this provider's streams do not exist" (`not_found`) and
 * "this provider's servers are falling over" (`server_error`) and "our
 * credentials are wrong" (`auth`) are three completely different answers to
 * "how good is this provider", and a single `dead` count cannot tell them apart.
 *
 * `client_error` is the provider refusing the request for a reason that is
 * neither a login nor a missing stream. ffmpeg names 400, 401, 403 and 404 and
 * folds every other 4xx -- a rate limit, a connection cap -- into "4XX Client
 * Error, but not one of 40{0,1,3,4}". Before it had a bucket, that message was
 * 129 of one live provider's 130 dead streams, all filed under `other`.
 *
 * `probe_error` is deliberately separate: a missing ffprobe or an unparseable
 * payload is our failure, not the provider's, and smearing it across providers
 * would make whichever one happened to be probed look broken.
 */
export function deadReason(error: string): DeadReason {
  const text = error.toLowerCase();
  if (text === '') return 'other';
  // Ours before theirs: these strings are written by this file, not by ffmpeg.
  if (text.startsWith('spawn failed') || text.startsWith('unparseable')) return 'probe_error';
  if (text === 'empty url' || text.startsWith('refusing a url')) return 'rejected';
  // Ahead of the status codes because "Protocol not found" is ffmpeg failing to
  // handle the URL scheme, not a 404, and the substring would say otherwise.
  if (/protocol not found|could not find codec/.test(text)) return 'unsupported';
  // Status codes first -- a 403 body can mention any word below.
  if (/\b(401|403)\b|unauthorized|forbidden/.test(text)) return 'auth';
  if (/\b(404|410)\b|not found/.test(text)) return 'not_found';
  // On ffmpeg's own wording rather than a bare 4\d\d: the stored error carries
  // the stream URL, and a stream id like 429 in its path is not a status code.
  if (/server returned 4(\d\d|xx)\b|bad request/.test(text)) return 'client_error';
  if (/\b5\d\d\b|bad gateway|service unavailable|server error/.test(text)) return 'server_error';
  if (/timed? ?out|etimedout/.test(text)) return 'timeout';
  if (
    /connection refused|econnrefused|connection reset|network is unreachable|no route to host|name or service not known|failed to resolve|temporary failure in name resolution/.test(
      text,
    )
  )
    return 'unreachable';
  if (
    /invalid data found|protocol not found|unknown format|could not find codec|does not contain any stream|end of file|immediate exit/.test(
      text,
    )
  )
    return 'unsupported';
  return 'other';
}

/** What one ffmpeg leg of a soak did. */
/**
 * The shortest a connection can last and still count as having served.
 *
 * Anything under this came straight back: the provider refused the dial, or
 * accepted it and closed before a byte of stream arrived. Two seconds rather
 * than one because refusals are not instant -- the first real run recorded a
 * refused reconnect at exactly 1.0s, which a one-second floor let through as
 * a stream that had played and dropped.
 */
export const SOAK_DIAL_FLOOR_MS = 2_000;

/**
 * How long to wait before each reconnect after a connection ends, in turn.
 *
 * The first real soak of a one-connection account played for 100 seconds,
 * was closed, and then had three immediate reconnects refused inside two
 * seconds -- a provider cooldown, most likely. Redialling at once turned one
 * failure into four. Waiting lets a cooldown pass, and the last entry repeats
 * for any further retries. The wait comes out of the soak's own budget.
 */
export const SOAK_BACKOFF_MS = [2_000, 5_000, 15_000];

export interface SoakLeg {
  /** When the connection was opened, on the soak's clock. */
  startedAt: number;
  /** How long the connection served before it ended, in milliseconds. */
  heldMs: number;
  /**
   * True when a connection that had been serving was ended by the far end
   * before the soak's budget ran out.
   *
   * The whole output of the soak, really: the event a five-second probe can
   * never see. False for a connection the soak itself ended at its deadline,
   * and false for a failed dial -- see `failedDial`.
   */
  dropped: boolean;
  /**
   * True when the connection came straight back without serving anything.
   *
   * Kept apart from `dropped` on purpose. A refused reconnect is evidence the
   * stream is unavailable for a while, and it counts towards `unreachable`,
   * but it is not the stream failing to *hold* -- and counting each refusal as
   * a drop reported one failure as four and a rate four times the truth.
   */
  failedDial: boolean;
  /** ffmpeg's last words, when the far end ended it. Empty otherwise. */
  error: string;
}

export interface SoakResult {
  /** Each connection the soak made, in order. */
  legs: SoakLeg[];
  /** Total time connections were serving. */
  heldMs: number;
  /** Connections that served and were then ended by the far end. */
  drops: number;
  /** Connections that came straight back without serving. */
  failedDials: number;
  /**
   * True when the soak gave up because a reconnection would not establish at
   * all, rather than because its budget ran out.
   *
   * Distinct from a drop: a stream that will not connect a second time is dead,
   * and `probe` already has a vocabulary for dead. The soak reports it and
   * stops rather than spending its remaining budget failing to dial.
   */
  unreachable: boolean;
  /**
   * True when the `stop` hook cut the soak short.
   *
   * What a caller needs to tell "measured and found nothing" from "never got
   * to measure". Both come back with no legs and no drops, and treating the
   * second as the first is how a queued soak was marked done -- and dropped
   * from the queue -- when a viewer arriving had killed it seconds in.
   */
  stopped: boolean;
}

/**
 * How long a stream actually holds, by holding it.
 *
 * The active counterpart to the passive ledger in `stability.ts`, and the
 * answer to that module's one blind spot: it can only measure streams somebody
 * has watched, which on a channel with six sources is usually one of them. This
 * measures any stream on request.
 *
 * Deliberately *not* on a schedule. It costs a provider connection for its
 * whole window -- minutes, because the failure it is looking for takes tens of
 * seconds to appear -- so running it across a catalogue would cost more slots
 * than probing the catalogue does, and would contend with the viewers the whole
 * pacer exists to stay out of the way of. It is a button, and the operator
 * pressing it is the authorisation.
 *
 * ## Why a loop of short reads rather than one long one with reconnect
 *
 * ffmpeg can be told to reconnect (`-reconnect 1`), and then one invocation
 * covers the whole window -- but what it reports about those reconnections is a
 * log line at a verbosity that changes between builds, and counting drops by
 * parsing it would be guessing. Running one connection at a time and letting it
 * end is not a workaround for that; it is the measurement. A connection that
 * ends before this process ends it dropped, and the wall time it lasted is the
 * leg. That is exactly what the passive ledger records from the other side, so
 * the two produce the same rows and feed the same score.
 *
 * ## Why the deadline is a wall-clock kill and not `-t`
 *
 * This used to hand ffmpeg `-t <seconds>` and call any leg that came back early
 * a drop. `-t` is *media* time. A live provider sends a burst of buffered
 * stream the moment a connection opens, so a perfectly healthy feed reaches
 * 180 seconds of media after about 164 of wall clock and exits -- which read
 * as a drop sixteen seconds before the end. Each retry then asked for the
 * remainder, where the same burst is a larger share: sixteen seconds of media
 * arrived in six, nine in under half a second, and two of those sub-second
 * legs in a row were then called unreachable. The first real soak of a feed
 * already watched playing clean for five minutes came back with four drops and
 * no connection, every one of them manufactured.
 *
 * So ffmpeg is given no length at all, and this process kills it on its own
 * clock. The question being asked is "did the connection end before we ended
 * it", and only a wall-clock deadline can answer that; no media timestamp
 * can.
 */
export async function soakStream(
  url: string,
  options: {
    /** Total wall time to spend, across every connection. */
    seconds?: number;
    userAgent?: string;
    ffmpegPath?: string;
    /**
     * Give up after this many consecutive connections that never served.
     *
     * Three, with the backoff between them, gives a provider's reconnect
     * cooldown twenty-odd seconds to pass before the stream is called
     * unreachable. Beyond that the stream is gone for now, and spending the
     * rest of the budget rediscovering it helps nobody.
     */
    maxDeadConnections?: number;
    /** Waits before each reconnect. Injected by the tests to keep them quick. */
    backoffMs?: number[];
    /**
     * The least any reconnect waits, whatever the backoff says.
     *
     * A provider that keeps a closed connection counted for a few seconds
     * sees an early reconnect as one connection too many, and closes another.
     * The caller sets this to the account-wide cooldown.
     */
    minGapMs?: number;
    /** Called as each connection is opened, with the soak's clock. */
    onConnect?: (at: number) => void;
    /**
     * Polled to decide whether to stop early -- a viewer arriving, or the
     * worker shutting down.
     *
     * Checked between connections *and* while one is running, and the running
     * one is killed rather than left to finish. That distinction is the whole
     * point of having this at all: a probe cut short costs the ten seconds it
     * had left, where a soak left to finish holds a provider connection for up
     * to three more minutes after somebody has started watching -- which is
     * precisely the capacity the abort exists to hand back.
     */
    stop?: () => boolean;
    /** Injected by the tests; defaults to the real clock. */
    now?: () => number;
  } = {},
): Promise<SoakResult> {
  const {
    seconds = 180,
    userAgent = 'VLC/3.0.14',
    ffmpegPath = 'ffmpeg',
    maxDeadConnections = 3,
    backoffMs = SOAK_BACKOFF_MS,
    minGapMs = 0,
    onConnect,
    stop,
    now = Date.now,
  } = options;

  const empty: SoakResult = {
    legs: [],
    heldMs: 0,
    drops: 0,
    failedDials: 0,
    unreachable: false,
    stopped: false,
  };
  if (rejectUrl(url)) return empty;

  const deadline = now() + seconds * 1000;
  const legs: SoakLeg[] = [];
  let deadInARow = 0;
  let retries = 0;
  let wasStopped = false;
  let unreachable = false;

  const summarise = (): SoakResult => ({
    legs,
    heldMs: legs.reduce((sum, leg) => sum + leg.heldMs, 0),
    drops: legs.filter((leg) => leg.dropped).length,
    failedDials: legs.filter((leg) => leg.failedDial).length,
    unreachable,
    stopped: wasStopped,
  });

  while (now() < deadline) {
    if (stop?.()) {
      wasStopped = true;
      break;
    }

    if (legs.length > 0) {
      // Every reconnect waits first, so a provider that refuses a quick redial
      // is not charged a failure per attempt. The wait is spent against the
      // budget and still honours `stop`.
      const stepped = backoffMs.length > 0 ? backoffMs[Math.min(retries, backoffMs.length - 1)] : 0;
      const wait = Math.max(stepped ?? 0, minGapMs);
      retries += 1;
      if ((wait ?? 0) > 0) {
        const waitUntil = Math.min(now() + (wait ?? 0), deadline);
        while (now() < waitUntil) {
          if (stop?.()) {
            wasStopped = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(250, waitUntil - now())));
        }
        if (wasStopped) break;
      }
    }

    const remainingMs = deadline - now();
    // Too little left for a connection to establish and show anything; it
    // would only be recorded as a failed dial it did not earn.
    if (remainingMs < SOAK_DIAL_FLOOR_MS) break;

    const startedAt = now();
    onConnect?.(startedAt);
    const { error, stopped, ranOut } = await runSoakLeg(url, {
      ms: remainingMs,
      userAgent,
      ffmpegPath,
      stop,
    });
    const heldMs = now() - startedAt;
    if (stopped) {
      // Killed on the way out, not dropped by the far end. Recording it as a
      // leg at all would charge the stream for a connection this process cut,
      // so the time is discarded rather than counted as clean or as a break --
      // the same refusal to invent evidence the passive ledger makes about a
      // session that merely ended.
      wasStopped = true;
      break;
    }

    // Ours ended it, or theirs did -- and if theirs, whether anything was
    // served first. A connection still open at the deadline served however
    // briefly it ran.
    const failedDial = !ranOut && heldMs < SOAK_DIAL_FLOOR_MS;
    const dropped = !ranOut && !failedDial;
    legs.push({ startedAt, heldMs, dropped, failedDial, error: ranOut ? '' : error });

    if (ranOut) break;

    if (failedDial) {
      deadInARow += 1;
      if (deadInARow >= maxDeadConnections) {
        unreachable = true;
        break;
      }
    } else {
      deadInARow = 0;
      // A connection that served earns a fresh run of patience: the backoff
      // restarts, so a stream that drops every few minutes is not redialled
      // ever more slowly across a long soak.
      retries = 0;
    }
  }

  return summarise();
}

/**
 * One connection: read the stream to nowhere until it stops or the time is up.
 *
 * A stream copy with no decoding, unlike `sampleStream` -- nothing here looks
 * at the picture, so paying to decode minutes of 1080p would be memory and CPU
 * spent to learn nothing. That also makes a soak far cheaper on the machine
 * than its duration suggests: it is a socket and a mux.
 */
function runSoakLeg(
  url: string,
  options: {
    /** Wall clock to hold the connection for, after which this process ends it. */
    ms: number;
    userAgent: string;
    ffmpegPath: string;
    stop?: (() => boolean) | undefined;
  },
): Promise<{ error: string; stopped: boolean; ranOut: boolean }> {
  const args = [
    '-y',
    '-hide_banner',
    '-v',
    'error',
    '-threads',
    '1',
    ...userAgentArgs(url, options.userAgent),
    ...protocolArgs(url),
    // Deliberately no `-t`. See "Why the deadline is a wall-clock kill" on
    // `soakStream`: a media-time limit is reached early by any feed that
    // bursts on connect, which every live provider does.
    '-i',
    url,
    '-map',
    '0',
    '-c',
    'copy',
    // The null muxer, not MPEG-TS. Nothing reads what a soak writes, and a real
    // container has opinions about what it will carry -- a codec or data track
    // it refuses makes ffmpeg exit on the spot, which this would record as the
    // stream dropping. `null` accepts anything, so the only way a leg ends
    // early is the far end closing it.
    '-f',
    'null',
    '-',
  ];

  return new Promise<{ error: string; stopped: boolean; ranOut: boolean }>((resolve) => {
    // See `sampleStream` for why the path is opted out of Turbopack's tracing.
    const child = spawn(/*turbopackIgnore: true*/ options.ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    runningChildren.add(child);

    let stderr = '';
    let settled = false;
    let stopped = false;
    let ranOut = false;
    const finish = (error: string) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(deadline);
      runningChildren.delete(child);
      resolve({ error, stopped, ranOut });
    };

    // The deadline, on this process's clock. Reaching it is the clean ending:
    // the connection was still serving when we stopped asking.
    const deadline = setTimeout(
      () => {
        if (settled) return;
        ranOut = true;
        child.kill('SIGKILL');
      },
      Math.max(0, options.ms),
    );

    // A second is fine: the thing being handed back is a provider connection,
    // and a second of one is not worth a tighter loop on every soak in flight.
    const poll = setInterval(() => {
      if (settled || !options.stop?.()) return;
      stopped = true;
      child.kill('SIGKILL');
    }, 1_000);
    poll.unref?.();

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      // The tail is what matters: the last thing ffmpeg said before it gave up.
      if (stderr.length > 8192) stderr = stderr.slice(-4096);
    });
    child.on('error', (err) => finish(`spawn failed: ${String(err)}`));
    child.on('close', () => finish(stderr.trim().split('\n').at(-1)?.trim() ?? ''));
  });
}
