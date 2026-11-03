import { describe, expect, it } from 'vitest';
import {
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
      expect(report.outliers[0]!.reason).toContain('divergent content');
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
        { extractPcm: fakeExtractor, maxConcurrent: 2 },
      );

      expect(report.analyzedCount).toBe(3);
      expect(report.consensusCluster).toEqual(expect.arrayContaining([1, 2]));
      expect(report.outliers).toHaveLength(1);
      expect(report.outliers[0]!.streamId).toBe(3);
      expect(report.outliers[0]!.similarityToCluster).toBeLessThan(0.4);
    });
  });
});
