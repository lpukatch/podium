/**
 * Lightweight audio fingerprinting and cross-stream consensus analysis.
 *
 * Compares short, concurrently requested audio samples. Agreement is evidence
 * of matching audio, not proof of a particular broadcast source.
 * Audio is decoded as mono 8 kHz PCM; at most four feeds are sampled, with at
 * most two extractions in flight at once.
 * Alignment tolerates up to two seconds of broadcast/startup delay. Larger
 * delays and different local ad breaks can still make a check inconclusive.
 */

import { type ChildProcess, spawn } from 'child_process';
import { protocolArgs, rejectUrl, userAgentArgs } from './probe';

export interface FrameFeature {
  /** Root-mean-square energy of the frame. */
  rms: number;
  /** Zero-crossing rate (frequency / spectral density indicator). */
  zcr: number;
  /** High-frequency energy flux (first-order difference energy). */
  flux: number;
}

export interface AudioFingerprint {
  frames: FrameFeature[];
  durationSeconds: number;
  sampleCount: number;
}

export interface ComparisonResult {
  similarity: number;
  offsetSeconds: number;
  matched: boolean;
}

export interface StreamConsensusInput {
  streamId: number;
  name?: string;
  fingerprint?: AudioFingerprint | null;
  error?: string;
}

export interface ConsensusReport {
  /**
   * `confirmed`: every sampled feed agreed with no extraction failures.
   * `divergent`: a majority cluster with at least one feed clearly outside it.
   * `partial`: a unique agreeing clique that is not a majority (two of four,
   * say) -- the agreement is real, the remaining feeds are just unverified.
   * `inconclusive`: nothing verifiable was learned.
   */
  status: 'confirmed' | 'divergent' | 'partial' | 'inconclusive';
  failures: Array<{ streamId: number; name?: string; reason: string }>;
  analyzedCount: number;
  /** Stream IDs in verified audio agreement: the majority for
   * `confirmed`/`divergent`, the agreeing clique alone for `partial`. */
  consensusCluster: number[];
  /** Stream IDs with divergent audio (e.g. 24/7 FAST news loops). */
  outliers: Array<{
    streamId: number;
    name?: string;
    similarityToCluster: number;
    reason: string;
  }>;
  /** Pairwise similarity lookup: "streamA:streamB" -> score in [0, 1]. */
  pairwise: Record<string, number>;
}

/** Sample rate for fingerprinting (8 kHz mono is sufficient for speech/music envelopes). */
export const SAMPLE_RATE = 8000;
/** Frame size in samples: 800 samples = 100 ms. */
export const FRAME_SIZE = 800;
/** Hop size in samples: 400 samples = 50 ms (50% overlap). */
export const HOP_SIZE = 400;
/** Minimum similarity score to consider two streams carrying the same broadcast. */
export const MATCH_THRESHOLD = 0.65;
/** Similarity ceiling below which a stream is classified as a divergent outlier. */
export const OUTLIER_THRESHOLD = 0.4;

/**
 * Compute an acoustic energy & spectral feature fingerprint from raw 16-bit PCM.
 */
export function computeAudioFingerprint(pcm: Buffer, sampleRate = SAMPLE_RATE): AudioFingerprint {
  const sampleCount = Math.floor(pcm.byteLength / 2);
  if (sampleCount < FRAME_SIZE) {
    return { frames: [], durationSeconds: sampleCount / sampleRate, sampleCount };
  }

  const int16 = new Int16Array(pcm.buffer, pcm.byteOffset, sampleCount);
  const numFrames = Math.floor((sampleCount - FRAME_SIZE) / HOP_SIZE) + 1;
  const rawFrames: FrameFeature[] = new Array(numFrames);

  let sumRms = 0;
  let sumZcr = 0;
  let sumFlux = 0;

  for (let f = 0; f < numFrames; f++) {
    const offset = f * HOP_SIZE;
    let sumSq = 0;
    let zc = 0;
    let diffSq = 0;

    let prevSample = int16[offset]! / 32768.0;
    sumSq += prevSample * prevSample;

    for (let i = 1; i < FRAME_SIZE; i++) {
      const sample = int16[offset + i]! / 32768.0;
      sumSq += sample * sample;
      if ((prevSample >= 0 && sample < 0) || (prevSample < 0 && sample >= 0)) {
        zc++;
      }
      const diff = sample - prevSample;
      diffSq += diff * diff;
      prevSample = sample;
    }

    const rms = Math.sqrt(sumSq / FRAME_SIZE);
    const zcr = zc / (FRAME_SIZE - 1);
    const flux = Math.sqrt(diffSq / (FRAME_SIZE - 1));

    rawFrames[f] = { rms, zcr, flux };
    sumRms += rms;
    sumZcr += zcr;
    sumFlux += flux;
  }

  // Standardization: remove global DC / volume offsets across frames
  const meanRms = sumRms / numFrames;
  const meanZcr = sumZcr / numFrames;
  const meanFlux = sumFlux / numFrames;

  let varRms = 0;
  let varZcr = 0;
  let varFlux = 0;

  for (const frame of rawFrames) {
    varRms += (frame.rms - meanRms) ** 2;
    varZcr += (frame.zcr - meanZcr) ** 2;
    varFlux += (frame.flux - meanFlux) ** 2;
  }

  const stdRms = Math.sqrt(varRms / numFrames) || 1e-6;
  const stdZcr = Math.sqrt(varZcr / numFrames) || 1e-6;
  const stdFlux = Math.sqrt(varFlux / numFrames) || 1e-6;

  const normalizedFrames: FrameFeature[] = rawFrames.map((frame) => ({
    rms: (frame.rms - meanRms) / stdRms,
    zcr: (frame.zcr - meanZcr) / stdZcr,
    flux: (frame.flux - meanFlux) / stdFlux,
  }));

  return {
    frames: normalizedFrames,
    durationSeconds: sampleCount / sampleRate,
    sampleCount,
  };
}

/**
 * Calculate Pearson correlation coefficient for acoustic features over an overlapping window.
 */
function computeWindowPearson(
  framesA: FrameFeature[],
  framesB: FrameFeature[],
  startA: number,
  startB: number,
  len: number,
): { rRms: number; rZcr: number; rFlux: number } {
  if (len < 15) return { rRms: 0, rZcr: 0, rFlux: 0 };
  let sumRmsA = 0,
    sumRmsB = 0;
  let sumZcrA = 0,
    sumZcrB = 0;
  let sumFluxA = 0,
    sumFluxB = 0;

  for (let i = 0; i < len; i++) {
    const a = framesA[startA + i]!;
    const b = framesB[startB + i]!;
    sumRmsA += a.rms;
    sumRmsB += b.rms;
    sumZcrA += a.zcr;
    sumZcrB += b.zcr;
    sumFluxA += a.flux;
    sumFluxB += b.flux;
  }

  const meanRmsA = sumRmsA / len;
  const meanRmsB = sumRmsB / len;
  const meanZcrA = sumZcrA / len;
  const meanZcrB = sumZcrB / len;
  const meanFluxA = sumFluxA / len;
  const meanFluxB = sumFluxB / len;

  let numRms = 0,
    varRmsA = 0,
    varRmsB = 0;
  let numZcr = 0,
    varZcrA = 0,
    varZcrB = 0;
  let numFlux = 0,
    varFluxA = 0,
    varFluxB = 0;

  for (let i = 0; i < len; i++) {
    const a = framesA[startA + i]!;
    const b = framesB[startB + i]!;

    const dRmsA = a.rms - meanRmsA;
    const dRmsB = b.rms - meanRmsB;
    numRms += dRmsA * dRmsB;
    varRmsA += dRmsA * dRmsA;
    varRmsB += dRmsB * dRmsB;

    const dZcrA = a.zcr - meanZcrA;
    const dZcrB = b.zcr - meanZcrB;
    numZcr += dZcrA * dZcrB;
    varZcrA += dZcrA * dZcrA;
    varZcrB += dZcrB * dZcrB;

    const dFluxA = a.flux - meanFluxA;
    const dFluxB = b.flux - meanFluxB;
    numFlux += dFluxA * dFluxB;
    varFluxA += dFluxA * dFluxA;
    varFluxB += dFluxB * dFluxB;
  }

  const denomRms = Math.sqrt(varRmsA * varRmsB);
  const denomZcr = Math.sqrt(varZcrA * varZcrB);
  const denomFlux = Math.sqrt(varFluxA * varFluxB);

  return {
    rRms: denomRms > 1e-9 ? numRms / denomRms : 0,
    rZcr: denomZcr > 1e-9 ? numZcr / denomZcr : 0,
    rFlux: denomFlux > 1e-9 ? numFlux / denomFlux : 0,
  };
}

/**
 * Cross-correlate two fingerprints across a sliding time window to account for broadcast delays.
 *
 * @param fpA First stream fingerprint
 * @param fpB Second stream fingerprint
 * @param maxOffsetFrames Maximum sliding shift in frames (40 frames = 2.0s shift)
 */
export function compareFingerprints(
  fpA: AudioFingerprint,
  fpB: AudioFingerprint,
  maxOffsetFrames = 40,
): ComparisonResult {
  if (fpA.frames.length < 15 || fpB.frames.length < 15) {
    return { similarity: 0, offsetSeconds: 0, matched: false };
  }

  const lenA = fpA.frames.length;
  const lenB = fpB.frames.length;
  let bestSim = 0;
  let bestOffset = 0;

  // Slide fpB relative to fpA
  const minOffset = -Math.min(maxOffsetFrames, lenA - 15);
  const maxOffset = Math.min(maxOffsetFrames, lenB - 15);

  for (let offset = minOffset; offset <= maxOffset; offset++) {
    const startA = Math.max(0, -offset);
    const endA = Math.min(lenA, lenB - offset);
    const overlapLen = endA - startA;

    if (overlapLen < 15) continue;

    const startB = startA + offset;
    const { rRms, rZcr, rFlux } = computeWindowPearson(
      fpA.frames,
      fpB.frames,
      startA,
      startB,
      overlapLen,
    );

    // Weighted fusion: RMS envelope carries the bulk of musical/speech pacing,
    // while ZCR and flux confirm spectral shape.
    const fused = 0.5 * rRms + 0.25 * rZcr + 0.25 * rFlux;
    const similarity = Math.max(0, Math.min(1, fused));

    if (similarity > bestSim) {
      bestSim = similarity;
      bestOffset = offset;
    }
  }

  return {
    similarity: Math.round(bestSim * 1000) / 1000,
    offsetSeconds: Math.round(bestOffset * (HOP_SIZE / SAMPLE_RATE) * 100) / 100,
    matched: bestSim >= MATCH_THRESHOLD,
  };
}

/**
 * Evaluate candidate streams for a channel to discover the consensus broadcast cluster
 * and identify outlier feeds (e.g. news loops).
 */
export function evaluateConsensus(
  inputs: StreamConsensusInput[],
  threshold = MATCH_THRESHOLD,
): ConsensusReport {
  const valid = inputs.filter((i) => i.fingerprint && i.fingerprint.frames.length >= 15);
  const pairwise: Record<string, number> = {};
  const failures = inputs
    .filter((input) => !valid.includes(input))
    .map((input) => ({
      streamId: input.streamId,
      name: input.name,
      // The caller's own reason -- a timeout, a rejected URL, the candidate
      // cap -- is more legible on the panel than a generic failure string.
      reason: input.error ?? 'Insufficient audio to compare',
    }));

  if (valid.length < 2) {
    return {
      status: 'inconclusive',
      failures,
      analyzedCount: valid.length,
      consensusCluster: [],
      outliers: [],
      pairwise: {},
    };
  }

  // Compute pairwise similarities
  const matrix: Map<number, Map<number, number>> = new Map();
  for (let i = 0; i < valid.length; i++) {
    const sA = valid[i]!;
    if (!matrix.has(sA.streamId)) matrix.set(sA.streamId, new Map());

    for (let j = i + 1; j < valid.length; j++) {
      const sB = valid[j]!;
      if (!matrix.has(sB.streamId)) matrix.set(sB.streamId, new Map());

      const res = compareFingerprints(sA.fingerprint!, sB.fingerprint!);
      pairwise[`${sA.streamId}:${sB.streamId}`] = res.similarity;
      pairwise[`${sB.streamId}:${sA.streamId}`] = res.similarity;

      matrix.get(sA.streamId)!.set(sB.streamId, res.similarity);
      matrix.get(sB.streamId)!.set(sA.streamId, res.similarity);
    }
  }

  // Find pairwise-agreeing groups rather than order-dependent seed groups.
  // The capture path limits inputs to four, so this small clique search is bounded.
  const clusters: number[][] = [];
  function search(group: number[], remaining: number[]) {
    if (remaining.length === 0) {
      if (group.length >= 2) clusters.push(group);
      return;
    }
    const [id, ...rest] = remaining;
    search(group, rest);
    if (group.every((member) => (matrix.get(member)?.get(id!) ?? 0) >= threshold)) {
      search([...group, id!], rest);
    }
  }
  search(
    [],
    valid.map((s) => s.streamId),
  );
  clusters.sort((a, b) => b.length - a.length);
  const largest = clusters[0] ?? [];
  const hasMajority = largest.length >= 2 && largest.length > valid.length / 2;
  const unique = largest.length > (clusters[1]?.length ?? 0);
  // A unique clique is a finding even when it is not a majority. Two of four
  // sampled feeds agreeing is the common shape of a multi-provider channel --
  // regional playouts and local ad breaks split the field -- and hiding it
  // behind an empty cluster threw away the one solid fact the run had
  // produced: those feeds demonstrably share audio.
  const consensusCluster = unique ? largest : [];
  if (consensusCluster.length === 0) {
    return {
      status: 'inconclusive',
      failures,
      analyzedCount: valid.length,
      consensusCluster: [],
      outliers: [],
      pairwise,
    };
  }
  // Without a majority there is no "rest of the channel" to judge divergent --
  // two agreeing feeds cannot outvote anything -- so a partial verdict stops
  // at naming who agrees, and outlier classification stays a
  // majority-cluster finding.
  if (!hasMajority) {
    return {
      status: 'partial',
      failures,
      analyzedCount: valid.length,
      consensusCluster,
      outliers: [],
      pairwise,
    };
  }
  const consensusSet = new Set(consensusCluster);

  const outliers: ConsensusReport['outliers'] = [];

  for (const s of valid) {
    if (consensusSet.has(s.streamId)) continue;

    // Calculate average similarity against consensus cluster members
    let sumSim = 0;
    for (const cId of consensusCluster) {
      sumSim += matrix.get(s.streamId)?.get(cId) ?? 0;
    }
    const avgSim = consensusCluster.length > 0 ? sumSim / consensusCluster.length : 0;

    if (avgSim < OUTLIER_THRESHOLD) {
      outliers.push({
        streamId: s.streamId,
        name: s.name,
        similarityToCluster: Math.round(avgSim * 1000) / 1000,
        reason: 'Audio differs from the majority of sampled feeds (divergent audio)',
      });
    }
  }

  return {
    status:
      outliers.length > 0
        ? 'divergent'
        : failures.length === 0 && consensusCluster.length === valid.length
          ? 'confirmed'
          : 'inconclusive',
    failures,
    analyzedCount: valid.length,
    consensusCluster,
    outliers,
    pairwise,
  };
}

/**
 * The highest pairwise score in a report, with mirrored keys read once.
 *
 * A summary wants the one number that says how close a run came to agreement;
 * picking it out of a four-feed map's twelve entries (half of them mirrors) is
 * work every caller would otherwise repeat.
 */
export function strongestPair(
  pairwise: ConsensusReport['pairwise'],
): { a: number; b: number; similarity: number } | null {
  let best: { a: number; b: number; similarity: number } | null = null;
  const seen = new Set<string>();
  for (const [rawKey, similarity] of Object.entries(pairwise)) {
    const ids = rawKey.split(':').map(Number);
    if (ids.length !== 2 || ids.some((n) => !Number.isInteger(n))) continue;
    const a = Math.min(ids[0]!, ids[1]!);
    const b = Math.max(ids[0]!, ids[1]!);
    const key = `${a}:${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!best || similarity > best.similarity) best = { a, b, similarity };
  }
  return best;
}

/**
 * One loggable line for a report: the verdict, who agreed, how close it came.
 *
 * Consensus runs nowhere else in the worker, so without a line like this an
 * operator cannot tell from the container logs whether any of it ever ran.
 */
export function describeConsensus(report: ConsensusReport): string {
  const best = strongestPair(report.pairwise);
  const pair = best
    ? `best pair ${best.a}:${best.b} at ${best.similarity.toFixed(3)}`
    : 'no pair scored';
  const failed = report.failures.length > 0 ? `, ${report.failures.length} failed extraction` : '';
  const cluster = report.consensusCluster.length;
  switch (report.status) {
    case 'confirmed':
      return `confirmed -- all ${report.analyzedCount} feeds agree (${pair})`;
    case 'divergent':
      return `divergent -- ${report.outliers.length} outlier(s) against a ${cluster}-feed majority (${pair})${failed}`;
    case 'partial':
      return `partial -- ${cluster} of ${report.analyzedCount} feeds agree, rest unverified (${pair})${failed}`;
    case 'inconclusive':
      return `inconclusive -- no agreement among ${report.analyzedCount} feeds (${pair})${failed}`;
  }
}

/**
 * Extract a bounded 8 kHz mono 16-bit PCM buffer from a stream using ffmpeg.
 *
 * Uses `-vn` to avoid video decode and bounds the returned PCM buffer.
 */
/** Options for audio extraction, shared by the default and injected extractors. */
export interface ExtractAudioOptions {
  seconds?: number;
  timeoutMs?: number;
  userAgent?: string;
  ffmpegPath?: string;
}

export async function extractAudioPcm(
  url: string,
  options: ExtractAudioOptions = {},
): Promise<Buffer> {
  const seconds = options.seconds ?? 8;
  const timeoutMs = options.timeoutMs ?? 12000;
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';

  if (rejectUrl(url)) {
    throw new Error(`Rejected URL: ${url}`);
  }

  const maxBytes = SAMPLE_RATE * 2 * (seconds + 1); // 16-bit = 2 bytes per sample
  const args = [
    '-y',
    '-hide_banner',
    '-v',
    'error',
    '-threads',
    '1',
    // The same two rules every probe spawn follows: the user agent is an
    // HTTP-only option ffmpeg rejects on other transports, and the protocol
    // whitelist keeps a provider playlist from naming a file:// or udp://
    // segment this decode would otherwise follow.
    ...(options.userAgent ? userAgentArgs(url, options.userAgent) : []),
    ...protocolArgs(url),
    '-t',
    String(seconds),
    '-i',
    url,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(SAMPLE_RATE),
    '-f',
    's16le',
    'pipe:1',
  ];

  return new Promise<Buffer>((resolve, reject) => {
    let child: ChildProcess | null = null;
    try {
      // ffmpegPath defaults to a bare `ffmpeg` resolved from PATH, never a file
      // in this project. Without the opt-out Turbopack cannot prove that and
      // traces the whole source tree into the standalone output.
      child = spawn(/*turbopackIgnore: true*/ ffmpegPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return reject(err);
    }

    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      if (child) {
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore
        }
      }
    };

    const finish = (buf: Buffer) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(buf);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const timer = setTimeout(() => {
      // A slow CDN or an HLS stall that never lets ffmpeg reach `-t` can still
      // have delivered most of the sample -- five of eight seconds is fifty
      // frames, well past the fifteen a fingerprint needs. The close handler
      // accepts exactly this partial output, so the timeout must not be
      // stricter about it than an abnormal exit is.
      if (chunks.length > 0) finish(Buffer.concat(chunks));
      else fail(new Error(`Audio extraction timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      chunks.push(chunk);
      bytesRead += chunk.length;
      if (bytesRead >= maxBytes) {
        finish(Buffer.concat(chunks, maxBytes));
      }
    });

    child.stderr?.on('data', () => {
      // Ignored: ffmpeg stderr logging
    });

    child.on('error', fail);
    child.on('close', (code) => {
      if (code === 0 || chunks.length > 0) {
        finish(Buffer.concat(chunks));
      } else {
        fail(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
}

/**
 * Run audio consensus check on a list of candidate streams.
 * Requests bounded audio samples together, computes fingerprints,
 * and performs cross-stream pairwise consensus analysis.
 */
export async function checkStreamConsensus(
  streams: Array<{ id: number; url: string; name?: string; userAgent?: string }>,
  options: {
    sampleSeconds?: number;
    timeoutMs?: number;
    /** Fallback user agent; a stream's own takes precedence. */
    userAgent?: string;
    /** Candidate cap, at most four. Excess feeds are skipped, never sampled in later batches. */
    maxCandidates?: number;
    /**
     * How many extractions run at once. A cap on candidates alone would start
     * every ffmpeg decode simultaneously; this bounds the decodes in flight the
     * way the probe phase's own machine-level cap bounds its probes.
     */
    maxConcurrent?: number;
    extractPcm?: (url: string, opts: ExtractAudioOptions) => Promise<Buffer>;
  } = {},
): Promise<ConsensusReport> {
  const extractor = options.extractPcm ?? extractAudioPcm;
  const candidateCap = Math.min(4, Math.max(1, Math.floor(options.maxCandidates ?? 4)));
  const concurrency = Math.max(1, Math.floor(options.maxConcurrent ?? 2));
  const candidates = streams.slice(0, candidateCap);

  const extractOne = async (stream: (typeof candidates)[number]): Promise<StreamConsensusInput> => {
    try {
      const pcm = await extractor(stream.url, {
        seconds: options.sampleSeconds ?? 8,
        timeoutMs: options.timeoutMs ?? 12000,
        userAgent: stream.userAgent ?? options.userAgent,
      });
      return {
        streamId: stream.id,
        name: stream.name,
        fingerprint: computeAudioFingerprint(pcm),
      };
    } catch (err) {
      return {
        streamId: stream.id,
        name: stream.name,
        fingerprint: null,
        error: err instanceof Error ? err.message : 'Audio extraction failed',
      };
    }
  };

  // A worker pool, not Promise.all: at most `concurrency` extractions in
  // flight, the next candidate starting only as a slot frees.
  const inputs: StreamConsensusInput[] = [];
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const stream = candidates[next++]!;
      inputs.push(await extractOne(stream));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));

  for (const stream of streams.slice(candidateCap)) {
    inputs.push({ streamId: stream.id, name: stream.name, error: 'Candidate limit exceeded' });
  }
  // Completion order under the pool varies run to run; the verdict does not
  // depend on input order, but a stable order keeps the report comparable
  // across two checks of the same channel.
  inputs.sort((a, b) => a.streamId - b.streamId);
  return evaluateConsensus(inputs);
}
