import { describe, expect, it } from 'vitest';
import {
  type AudioFingerprint,
  checkStreamConsensus,
  compareFingerprints,
  computeAudioFingerprint,
  evaluateConsensus,
  FRAME_SIZE,
  SAMPLE_RATE,
} from './consensus';

/** Generate synthetic 16-bit mono PCM buffer with an amplitude-modulated tone. */
function generatePcm(
  durationSec: number,
  freqHz: number,
  modFreqHz = 2,
  noiseLevel = 0.05,
): Buffer {
  const numSamples = Math.floor(durationSec * SAMPLE_RATE);
  const buf = Buffer.alloc(numSamples * 2);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    // Amplitude modulation creates an envelope shape (speech/music rhythmic bursts)
    const envelope = 0.5 * (1 + Math.sin(2 * Math.PI * modFreqHz * t));
    const carrier = Math.sin(2 * Math.PI * freqHz * t);
    const noise = (Math.random() * 2 - 1) * noiseLevel;

    const sampleFloat = Math.max(-1, Math.min(1, (carrier * envelope + noise) * 0.8));
    const sampleInt16 = Math.round(sampleFloat * 32767);
    buf.writeInt16LE(sampleInt16, i * 2);
  }

  return buf;
}

/** Shift PCM buffer forward in time by padding zeros at the front. */
function shiftPcm(original: Buffer, shiftSeconds: number): Buffer {
  const shiftBytes = Math.floor(shiftSeconds * SAMPLE_RATE) * 2;
  const padding = Buffer.alloc(shiftBytes);
  return Buffer.concat([padding, original]).subarray(0, original.length);
}

describe('consensus audio fingerprinting', () => {
  it('computes fingerprints from raw PCM buffers', () => {
    const pcm = generatePcm(3, 440);
    const fp = computeAudioFingerprint(pcm);

    expect(fp.sampleCount).toBe(3 * SAMPLE_RATE);
    expect(fp.frames.length).toBeGreaterThan(20);

    // Frame features should be standardized (mean near 0, std near 1)
    const rmsValues = fp.frames.map((f) => f.rms);
    const meanRms = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;
    expect(Math.abs(meanRms)).toBeLessThan(0.01);
  });

  it('handles short or empty buffers gracefully', () => {
    const emptyFp = computeAudioFingerprint(Buffer.alloc(0));
    expect(emptyFp.frames).toHaveLength(0);

    const tinyFp = computeAudioFingerprint(Buffer.alloc(FRAME_SIZE - 2));
    expect(tinyFp.frames).toHaveLength(0);
  });

  it('matches identical streams with near-perfect similarity', () => {
    const pcmA = generatePcm(4, 440, 1.5);
    const pcmB = Buffer.from(pcmA); // exact clone

    const fpA = computeAudioFingerprint(pcmA);
    const fpB = computeAudioFingerprint(pcmB);

    const comp = compareFingerprints(fpA, fpB);
    expect(comp.matched).toBe(true);
    expect(comp.similarity).toBeGreaterThan(0.95);
    expect(Math.abs(comp.offsetSeconds)).toBeLessThan(0.1);
  });

  it('matches time-delayed versions of the same broadcast', () => {
    // Stream B arrives 0.5s delayed behind Stream A (common across IPTV CDNs)
    const pcmA = generatePcm(5, 520, 2);
    const pcmB = shiftPcm(pcmA, 0.5);

    const fpA = computeAudioFingerprint(pcmA);
    const fpB = computeAudioFingerprint(pcmB);

    const comp = compareFingerprints(fpA, fpB);
    expect(comp.matched).toBe(true);
    expect(comp.similarity).toBeGreaterThan(0.85);
    // Detected time offset should be close to 0.5s
    expect(Math.abs(comp.offsetSeconds - 0.5)).toBeLessThan(0.15);
  });

  it('rejects completely different audio content', () => {
    // Stream A: 440 Hz with 1 Hz modulation (e.g. linear sports commentary)
    const pcmA = generatePcm(4, 440, 1.0);
    // Stream B: 1200 Hz with 5 Hz modulation (e.g. FAST studio news audio)
    const pcmB = generatePcm(4, 1200, 5.0);

    const fpA = computeAudioFingerprint(pcmA);
    const fpB = computeAudioFingerprint(pcmB);

    const comp = compareFingerprints(fpA, fpB);
    expect(comp.matched).toBe(false);
    expect(comp.similarity).toBeLessThan(0.4);
  });

  describe('evaluateConsensus', () => {
    it('identifies consensus cluster and isolates the news loop outlier', () => {
      // 3 feeds carrying the same network broadcast (with slight timing/noise differences)
      const broadcast = generatePcm(5, 440, 1.5);
      const fp1 = computeAudioFingerprint(broadcast);
      const fp2 = computeAudioFingerprint(shiftPcm(broadcast, 0.2));
      const fp3 = computeAudioFingerprint(shiftPcm(broadcast, 0.4));

      // 1 feed carrying completely different content (e.g. local 24/7 news loop)
      const newsAudio = generatePcm(5, 1000, 4.0);
      const fpNews = computeAudioFingerprint(newsAudio);

      const report = evaluateConsensus([
        { streamId: 101, name: 'ABC 13 OTA Feed 1', fingerprint: fp1 },
        { streamId: 102, name: 'ABC 13 OTA Feed 2', fingerprint: fp2 },
        { streamId: 103, name: 'ABC 13 Cable Feed 3', fingerprint: fp3 },
        { streamId: 999, name: 'Amazon US: ABC13 Houston (News Loop)', fingerprint: fpNews },
      ]);

      expect(report.analyzedCount).toBe(4);
      // The 3 linear feeds form the consensus cluster
      expect(report.consensusCluster).toEqual(expect.arrayContaining([101, 102, 103]));
      expect(report.consensusCluster).not.toContain(999);

      // Stream 999 is correctly flagged as an outlier
      expect(report.outliers).toHaveLength(1);
      expect(report.outliers[0]!.streamId).toBe(999);
      expect(report.outliers[0]!.similarityToCluster).toBeLessThan(0.4);
      expect(report.outliers[0]!.reason).toContain('divergent audio');
    });

    it('reports no outliers when all feeds agree', () => {
      const broadcast = generatePcm(4, 500, 2);
      const fp1 = computeAudioFingerprint(broadcast);
      const fp2 = computeAudioFingerprint(shiftPcm(broadcast, 0.15));

      const report = evaluateConsensus([
        { streamId: 10, name: 'Feed 1', fingerprint: fp1 },
        { streamId: 20, name: 'Feed 2', fingerprint: fp2 },
      ]);

      expect(report.consensusCluster).toEqual([10, 20]);
      expect(report.outliers).toHaveLength(0);
    });

    it('handles solitary or invalid streams gracefully', () => {
      const report = evaluateConsensus([
        { streamId: 10, name: 'Solitary Feed', fingerprint: null },
      ]);

      expect(report.analyzedCount).toBe(0);
      expect(report.consensusCluster).toEqual([]);
      expect(report.outliers).toHaveLength(0);
    });
  });

  describe('checkStreamConsensus', () => {
    it('executes bounded parallel extraction and evaluates consensus', async () => {
      const commonPcm = generatePcm(4, 440, 1.5);
      const outlierPcm = generatePcm(4, 1200, 4.0);

      const fakeExtractor = async (url: string) => {
        if (url.includes('outlier')) return outlierPcm;
        if (url.includes('fail')) throw new Error('Stream 404');
        return commonPcm;
      };

      const report = await checkStreamConsensus(
        [
          { id: 1, url: 'http://stream/feed1', name: 'Feed 1' },
          { id: 2, url: 'http://stream/feed2', name: 'Feed 2' },
          { id: 3, url: 'http://stream/outlier', name: 'Amazon US News Loop' },
          { id: 4, url: 'http://stream/fail', name: 'Dead Feed' },
        ],
        { extractPcm: fakeExtractor, maxCandidates: 4, maxConcurrent: 2 },
      );

      expect(report.analyzedCount).toBe(3);
      expect(report.consensusCluster).toEqual(expect.arrayContaining([1, 2]));
      expect(report.outliers).toHaveLength(1);
      expect(report.outliers[0]!.streamId).toBe(3);
      expect(report.outliers[0]!.similarityToCluster).toBeLessThan(0.4);
      // The extractor's own error reaches the report; a generic failure string
      // would hide which feed failed and why.
      expect(report.failures).toEqual([{ streamId: 4, name: 'Dead Feed', reason: 'Stream 404' }]);
    });

    it('bounds in-flight extractions and skips past the candidate cap', async () => {
      let inFlight = 0;
      let peak = 0;
      const slowExtractor = async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return generatePcm(4, 440, 1.5);
      };

      const streams = [1, 2, 3, 4, 5, 6].map((id) => ({
        id,
        url: `http://stream/feed${id}`,
        name: `Feed ${id}`,
      }));
      const report = await checkStreamConsensus(streams, {
        extractPcm: slowExtractor,
        maxCandidates: 4,
        maxConcurrent: 2,
      });

      expect(peak).toBeLessThanOrEqual(2);
      expect(report.analyzedCount).toBe(4);
      // The four sampled feeds agree outright, but two feeds were never
      // sampled, so the report withholds the confirmed verdict rather than
      // vouching for feeds it did not compare.
      expect(report.status).toBe('inconclusive');
      expect(report.consensusCluster).toEqual([1, 2, 3, 4]);
      expect(report.failures).toEqual([
        { streamId: 5, name: 'Feed 5', reason: 'Candidate limit exceeded' },
        { streamId: 6, name: 'Feed 6', reason: 'Candidate limit exceeded' },
      ]);
    });
  });
});

// Deterministic, nonperiodic features prevent a repeating tone from masking
// misalignment or accidentally matching unrelated audio.
function features(seed: number): AudioFingerprint {
  let state = seed;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000 - 0.5;
  };
  return {
    frames: Array.from({ length: 159 }, () => ({ rms: random(), zcr: random(), flux: random() })),
    durationSeconds: 8,
    sampleCount: 64000,
  };
}

describe('conservative consensus decisions', () => {
  const a = features(1);
  const b = features(42);
  it('does not choose a winner when two feeds disagree', () => {
    const inputs = [
      { streamId: 1, fingerprint: a },
      { streamId: 2, fingerprint: b },
    ];
    for (const order of [inputs, [...inputs].reverse()]) {
      expect(evaluateConsensus(order)).toMatchObject({
        status: 'inconclusive',
        consensusCluster: [],
        outliers: [],
      });
    }
  });
  it('does not choose a winner for a two versus two split', () => {
    expect(
      evaluateConsensus([
        { streamId: 1, fingerprint: a },
        { streamId: 2, fingerprint: a },
        { streamId: 3, fingerprint: b },
        { streamId: 4, fingerprint: b },
      ]),
    ).toMatchObject({ status: 'inconclusive', consensusCluster: [], outliers: [] });
  });
  it('returns inconclusive for failed, empty, and solitary samples', () => {
    for (const inputs of [
      [],
      [{ streamId: 1, fingerprint: null, error: 'failure' }],
      [{ streamId: 1, fingerprint: a }],
    ]) {
      expect(evaluateConsensus(inputs)).toMatchObject({
        status: 'inconclusive',
        consensusCluster: [],
        outliers: [],
      });
    }
  });
  it('retains extraction failures even when the remaining pair agrees', () => {
    expect(
      evaluateConsensus([
        { streamId: 1, fingerprint: a },
        { streamId: 2, fingerprint: a },
        { streamId: 3, error: 'failure' },
      ]),
    ).toMatchObject({
      status: 'inconclusive',
      consensusCluster: [1, 2],
      failures: [{ streamId: 3 }],
    });
  });
  it('requires the outlier threshold as well as majority agreement', () => {
    const mixed = {
      ...a,
      frames: a.frames.map((frame, i) => ({
        rms: 0.55 * frame.rms + 0.835 * b.frames[i]!.rms,
        zcr: 0.55 * frame.zcr + 0.835 * b.frames[i]!.zcr,
        flux: 0.55 * frame.flux + 0.835 * b.frames[i]!.flux,
      })),
    };
    const sim = compareFingerprints(a, mixed).similarity;
    expect(sim).toBeGreaterThan(0.4);
    expect(sim).toBeLessThan(0.65);
    expect(
      evaluateConsensus([
        { streamId: 1, fingerprint: a },
        { streamId: 2, fingerprint: a },
        { streamId: 3, fingerprint: mixed },
      ]),
    ).toMatchObject({ status: 'inconclusive', outliers: [] });
  });
  it('aligns nonperiodic audio near the supported two-second delay', () => {
    const delayed = { ...a, frames: [...b.frames.slice(0, 36), ...a.frames.slice(0, -36)] };
    expect(compareFingerprints(a, delayed)).toMatchObject({
      matched: true,
      similarity: 1,
      offsetSeconds: 1.8,
    });
  });
  it('confirms agreement and reports divergence only with a clear majority', () => {
    expect(
      evaluateConsensus([
        { streamId: 1, fingerprint: a },
        { streamId: 2, fingerprint: a },
      ]).status,
    ).toBe('confirmed');
    expect(
      evaluateConsensus([
        { streamId: 1, fingerprint: a },
        { streamId: 2, fingerprint: a },
        { streamId: 3, fingerprint: b },
      ]),
    ).toMatchObject({ status: 'divergent', outliers: [{ streamId: 3 }] });
  });
});

describe('capture scheduling', () => {
  it('holds extraction to two in flight and never queues feeds past the cap', async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const pending = checkStreamConsensus(
      Array.from({ length: 5 }, (_, id) => ({ id, url: String(id) })),
      {
        extractPcm: async (url, options) => {
          started.push(url);
          expect(options.seconds).toBe(8);
          await new Promise<void>((resolve) => releases.push(resolve));
          return Buffer.alloc(0);
        },
      },
    );
    // The default throttle starts the first two candidates and goes no
    // further until one lands -- all four at once was the behaviour the
    // option's name promised to prevent.
    expect(started).toEqual(['0', '1']);
    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toEqual(['0', '1', '2']);
    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toEqual(['0', '1', '2', '3']);
    // The fifth feed is past the candidate cap: freeing every slot must not
    // start it in a later batch. The cap skips; it does not queue.
    for (const release of releases.splice(0)) release();
    const report = await pending;
    expect(started).toEqual(['0', '1', '2', '3']);
    expect(report.status).toBe('inconclusive');
    expect(report.failures).toHaveLength(5);
  });
});
