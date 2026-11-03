/**
 * Lightweight audio fingerprinting and cross-stream consensus analysis.
 *
 * Compares short, concurrently requested audio samples. Agreement is evidence
 * of matching audio, not proof of a particular broadcast source.
 * Audio is decoded as mono 8 kHz PCM; at most four feeds are opened together.
 * Alignment tolerates up to two seconds of broadcast/startup delay. Larger
 * delays and different local ad breaks can still make a check inconclusive.
 */

import { type ChildProcess, spawn } from 'child_process';
import { rejectUrl } from './probe';

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
  status: 'confirmed' | 'divergent' | 'inconclusive';
  failures: Array<{ streamId: number; name?: string; reason: string }>;
  analyzedCount: number;
  /** Stream IDs in majority audio agreement (among the sampled feeds). */
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
      reason: input.error ? 'Audio extraction failed' : 'Insufficient audio to compare',
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
  const consensusCluster = hasMajority && unique ? largest : [];
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
    ...(options.userAgent ? ['-user_agent', options.userAgent] : []),
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
      child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
      fail(new Error(`Audio extraction timed out after ${timeoutMs}ms`));
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
    maxConcurrent?: number;
    extractPcm?: (url: string, opts: ExtractAudioOptions) => Promise<Buffer>;
  } = {},
): Promise<ConsensusReport> {
  const extractor = options.extractPcm ?? extractAudioPcm;
  const limit = Math.min(4, Math.max(1, Math.floor(options.maxConcurrent ?? 4)));
  const candidates = streams.slice(0, limit);
  const inputs: StreamConsensusInput[] = await Promise.all(
    candidates.map(async (stream) => {
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
      } catch {
        return {
          streamId: stream.id,
          name: stream.name,
          fingerprint: null,
          error: 'Audio extraction failed',
        };
      }
    }),
  );
  for (const stream of streams.slice(limit)) {
    inputs.push({ streamId: stream.id, name: stream.name, error: 'Candidate limit exceeded' });
  }
  return evaluateConsensus(inputs);
}
