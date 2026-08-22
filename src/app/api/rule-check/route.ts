import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { Eligibility } from '@/lib/eligibility';
import { resolveOrdering } from '@/lib/ordering';
import { groupPatterns, ordering, policies, snapshot } from '@/lib/server/state';
import { Store } from '@/lib/store';
import {
  type ChannelInput,
  checkRules,
  factsFor,
  type RuleInput,
  type StreamFacts,
} from '@/lib/teamarr';

export const dynamic = 'force-dynamic';

/**
 * Score a Teamarr rule set against what Podium has measured.
 *
 * POST the file Teamarr's Export button produced -- a bare array or a
 * `{rules: [...]}` envelope, the same shape the quality-profile merge takes --
 * and get back, per channel, the stream those rules put first and the stream
 * the measurements say should be first.
 *
 * Read-only and probe-free: every verdict it reads is already cached, so this
 * costs a Dispatcharr snapshot and nothing else. That matters for how it is
 * meant to be used -- edit a rule, run it again, see whether the disagreements
 * went down -- which nobody does if each run costs a probing pass.
 */
export async function POST(request: Request) {
  let store: Store | null = null;
  try {
    const parsed = (await request.json()) as unknown;
    const container = parsed as { rules?: unknown };
    const raw = Array.isArray(parsed) ? parsed : container?.rules;
    if (!Array.isArray(raw)) {
      return NextResponse.json(
        { error: 'expected a rules array, or a {"rules": [...]} envelope' },
        { status: 400 },
      );
    }
    const rules = raw.filter(
      (rule): rule is RuleInput => Boolean(rule) && typeof rule === 'object',
    );

    const snap = await snapshot();
    const config = loadConfig();
    store = new Store(config.dbPath);

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
        // Unmeasured streams are left out rather than ranked last. This report
        // is about where rules disagree with a measurement, and a stream nobody
        // has probed cannot disagree with anything -- including it would
        // manufacture findings out of what Podium has said least about.
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
        streams,
      });
    }

    return NextResponse.json(checkRules(channels, rules, strategy));
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}
