/**
 * The live catalogue as the Teamarr scorer wants to see it.
 *
 * Lifted out of the rule-check route once the Teamarr push needed the same
 * thing: the push runs the check twice -- once on the rules Teamarr is running
 * and once on the set about to replace them -- and a second copy of this
 * assembly is the one bug that would make the comparison meaningless while
 * looking right, because the two sides would be scoring different populations.
 */

import { loadConfig } from './config';
import { assignmentIsRule, Eligibility } from './eligibility';
import { resolveOrdering } from './ordering';
import type { RankStrategy } from './scoring';
import { groupPatterns, ordering, policies, type Snapshot } from './server/state';
import type { Store } from './store';
import { type ChannelInput, factsFor, type StreamFacts } from './teamarr';

export interface CheckInputs {
  channels: ChannelInput[];
  strategy: RankStrategy;
}

/**
 * Build one `ChannelInput` per channel worth judging.
 *
 * Unmeasured streams are left out rather than ranked last: this report is about
 * where rules disagree with a measurement, and a stream nobody has probed
 * cannot disagree with anything -- including it would manufacture findings out
 * of what Podium has said least about.
 */
export function checkInputs(snap: Snapshot, store: Store): CheckInputs {
  const config = loadConfig();
  const providerNames = new Map(snap.providers.map((p) => [p.id, p.name]));
  const groupNames = new Map(snap.groups.map((g) => [g.id, g.name]));
  const strategy = resolveOrdering(ordering(), providerNames, config.PODIUM_MIN_BITRATE_KBPS);
  // Audio-only channels rank on audio, so ranking them as video would report
  // every radio channel as a disagreement with itself.
  const eligibility = new Eligibility(policies(), undefined, groupPatterns());
  const streamById = new Map(snap.streams.map((s) => [s.id, s]));

  // Every verdict in one read rather than per channel: a stream on several
  // channels is one row, and the chunking already lives in the store.
  const verdicts = store.verdicts([...new Set(snap.channels.flatMap((c) => c.streams))]);

  const channels: ChannelInput[] = [];
  for (const channel of snap.channels) {
    if (channel.hidden_from_output) continue;
    const groupName = channel.groupId === null ? undefined : groupNames.get(channel.groupId);
    const policy = eligibility.policyFor(channel.groupId, groupName);

    const streams: Array<{ facts: StreamFacts; stepOrder: number }> = [];
    channel.streams.forEach((streamId, position) => {
      const stream = streamById.get(streamId);
      const verdict = verdicts.get(streamId);
      if (!stream || !verdict) return;
      streams.push({
        facts: factsFor(
          {
            id: streamId,
            name: stream.name,
            providerName: providerNames.get(stream.providerId) ?? '',
            groupName: stream.groupId === null ? '' : (groupNames.get(stream.groupId) ?? ''),
          },
          verdict.result,
          strategy,
        ),
        stepOrder: position,
      });
    });

    if (streams.length < 2) continue;
    channels.push({
      channelId: channel.id,
      channelName: channel.name,
      audioOnly: policy.audioOnly,
      // Teamarr orders what it creates: the groups marked measure-only, or
      // ranked off their own assignment. Its rules reach nothing else.
      managed: Boolean(policy.measureOnly) || assignmentIsRule(policy.mode),
      streams,
    });
  }

  return { channels, strategy };
}
