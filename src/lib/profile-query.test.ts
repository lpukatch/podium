/**
 * The query knobs on `/api/quality-profile`.
 *
 * These exist because the defaults were unreachable on a live install: absent
 * parameters resolved to 0 rather than to the documented fallbacks, so the
 * documented `?format=teamarr` curl returned an empty rule set and the profile
 * fitted over one-sample buckets. The UI passed both parameters explicitly,
 * which is exactly why nothing looked wrong from the browser.
 */

import { describe, expect, it } from 'vitest';
import { buildProfile, profileQuery, teamarrRules } from '@/lib/quality';
import type { StoredQualitySample } from '@/lib/store';

const sample = (over: Partial<StoredQualitySample> = {}): StoredQualitySample => ({
  providerId: 1,
  providerName: 'Provider A',
  tier: 'fhd',
  streamName: 'Sports Alpha FHD',
  groupId: 1,
  groupName: 'Sports | MLB',
  channelGroupId: 10,
  channelGroupName: 'Auto | Baseball | MLB',
  policyMode: 'after_epg_start',
  audioOnly: false,
  sampledAt: 1_700_000_000_000,
  alive: true,
  black: false,
  bitrateKbps: 9000,
  measured: true,
  height: 1080,
  fps: 50,
  videoCodec: 'h264',
  ...over,
});

describe('query defaults', () => {
  it('uses the documented defaults when a parameter is absent', () => {
    // Number(null) is 0 and 0 is finite, which is how both defaults went
    // missing without any request failing.
    expect(profileQuery(new URLSearchParams())).toEqual({
      minSamples: 20,
      pointsPerMbps: 5,
      deadPoints: -100,
      bitratePoints: 8,
    });
  });

  it('treats a blank parameter as absent', () => {
    expect(profileQuery(new URLSearchParams('pointsPerMbps=&minSamples='))).toEqual({
      minSamples: 20,
      pointsPerMbps: 5,
      deadPoints: -100,
      bitratePoints: 8,
    });
  });

  it('still reads and clamps a value that was given', () => {
    expect(profileQuery(new URLSearchParams('minSamples=0&pointsPerMbps=99999'))).toEqual({
      minSamples: 1,
      pointsPerMbps: 10_000,
      deadPoints: -100,
      bitratePoints: 8,
    });
  });

  it('falls back rather than zeroing on nonsense', () => {
    expect(profileQuery(new URLSearchParams('pointsPerMbps=lots')).pointsPerMbps).toBe(5);
  });

  it('takes an explicit zero as a request to suppress, not as absent', () => {
    // The one place `0` has to survive the blank-is-absent rule: it is how a
    // caller turns the liveness rules or the ladder off.
    const query = profileQuery(new URLSearchParams('deadPoints=0&bitratePoints=0'));
    expect(query.deadPoints).toBe(0);
    expect(query.bitratePoints).toBe(0);
  });

  it('will not let a demotion be written as a promotion', () => {
    // A positive deadPoints would reward a stream for having measured dead.
    expect(profileQuery(new URLSearchParams('deadPoints=50')).deadPoints).toBe(0);
  });

  it('exports rules for the URL the documentation gives', () => {
    // The end-to-end shape of the bug: every rule was worth zero points, and
    // `teamarrRules` drops a rule worth zero, so the file came back empty.
    const samples = [
      ...Array.from({ length: 40 }, () => sample({ bitrateKbps: 9000 })),
      ...Array.from({ length: 40 }, () =>
        sample({ providerId: 2, providerName: 'Provider B', bitrateKbps: 2000 }),
      ),
    ];
    const { minSamples, pointsPerMbps } = profileQuery(new URLSearchParams('format=teamarr'));
    const profile = buildProfile(samples, { minSamples });
    expect(teamarrRules(profile, { minSamples, pointsPerMbps }).rules.length).toBeGreaterThan(0);
  });
});
