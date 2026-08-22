import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { ALWAYS, assignmentIsRule, Eligibility, type GroupPolicy } from '@/lib/eligibility';
import { assignedCandidates } from '@/lib/runner';
import {
  config,
  groupPatterns,
  index,
  matcher,
  policies,
  snapshot,
  userGroups,
} from '@/lib/server/state';
import { NO_MARKS, type RefreshMarks, Store } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Everything the group-first view needs in one round trip: the user groups,
 * their policies, and per-channel rule/match counts.
 */
export async function GET(request: Request) {
  try {
    const refresh = new URL(request.url).searchParams.get('refresh') === '1';
    const snap = await snapshot(refresh);
    const m = matcher();
    const idx = await index();
    const policy = policies();
    const patterns = groupPatterns();
    // Resolve through Eligibility so the UI shows exactly what the worker will
    // do, including policies that come from a name pattern rather than an id.
    const resolver = new Eligibility(policy, undefined, patterns);

    // Best-effort: a database this cannot open is a reason to draw the groups
    // without their re-check state, not a reason to fail the page that is the
    // only way to fix it.
    let marks: RefreshMarks = NO_MARKS;
    let store: Store | null = null;
    try {
      store = new Store(loadConfig().dbPath);
      marks = store.refreshMarks();
    } catch {
      // left as NO_MARKS
    } finally {
      store?.close();
    }

    const groups = userGroups(snap);
    const byGroup = new Map<number, typeof snap.channels>();
    for (const channel of snap.channels) {
      if (channel.groupId === null) continue;
      const bucket = byGroup.get(channel.groupId);
      if (bucket) bucket.push(channel);
      else byGroup.set(channel.groupId, [channel]);
    }

    const providerNames = Object.fromEntries(snap.providers.map((p) => [p.id, p.name]));
    const streamById = new Map(snap.streams.map((s) => [s.id, s]));

    const payload = groups.map((group) => {
      const channels = byGroup.get(group.id) ?? [];
      const resolved = resolver.policyFor(group.id, group.name);
      const mode: GroupPolicy['mode'] = resolved.mode ?? ALWAYS;
      const fromPattern = !policy.has(group.id) && resolved.mode !== ALWAYS;
      let ruled = 0;
      let matchedChannels = 0;
      let links = 0;

      const rows = channels.map((channel) => {
        const rule = m.rules.get(channel.id);
        // A rule-less channel in an `assigned` or after-kickoff group is ranked
        // off its own assignment by the worker, so showing it as "no rule, 0
        // matched" would describe the opposite of what happens to it.
        const assignmentOnly = !rule && assignmentIsRule(mode);
        const hits = rule
          ? m.match(rule, idx)
          : assignmentOnly
            ? assignedCandidates(channel, streamById, idx.excludedGroups)
            : [];
        if (rule) ruled += 1;
        if (hits.length > 0) matchedChannels += 1;
        links += hits.length;
        return {
          id: channel.id,
          name: channel.name,
          tvgId: channel.tvgId,
          assigned: channel.streams.length,
          matched: hits.length,
          aliases: rule?.aliases ?? [],
          contains: rule?.contains ?? [],
          exclude: rule?.exclude ?? [],
          providers: rule?.providers ? [...rule.providers] : null,
          // Surfaced, not hidden: a channel still carrying a legacy regex looks
          // unmanaged otherwise, and you cannot decide whether an alias has
          // replaced it without seeing what it actually says.
          patterns: (rule?.patterns ?? []).map((p) => p.regex.source),
          regexCount: rule?.patterns.length ?? 0,
          hasRule: Boolean(rule),
          assignmentOnly,
        };
      });
      rows.sort((a, b) => a.name.localeCompare(b.name));

      return {
        id: group.id,
        name: group.name,
        mode,
        fromPattern,
        grace: resolved.graceMinutes,
        window: resolved.windowMinutes,
        audioOnly: resolved.audioOnly,
        measureOnly: resolved.measureOnly,
        channels: channels.length,
        ruled,
        matchedChannels,
        links,
        // When this group was last asked to re-check from scratch, if it still
        // is. The whole-catalogue mark is reported on its own below rather than
        // folded in here, so the UI can say which one is doing it -- cancelling
        // a group is not how you call off a catalogue-wide run.
        refreshQueuedAt: marks.byGroup.get(group.id) ?? null,
        rows,
      };
    });

    return NextResponse.json({
      groups: payload,
      providers: snap.providers,
      providerNames,
      patterns,
      streamCount: snap.streams.length,
      fetchedAt: snap.fetchedAt,
      refreshAllQueuedAt: marks.all,
    });
  } catch (error) {
    // "Cannot reach Dispatcharr" is the wrong thing to say to someone who has
    // simply not filled the credentials in yet, and it is the difference
    // between an outage and a first run. The client needs to tell them apart to
    // know whether to offer a retry or the settings form.
    const configured = config().hasCredentials;
    return NextResponse.json(
      {
        error: configured ? 'Cannot reach Dispatcharr' : 'Podium is not set up yet',
        detail: configured ? String(error).slice(0, 300) : '',
        hint: configured
          ? 'Check Dispatcharr is up, and the port-forward if running locally.'
          : 'Add a Dispatcharr URL and an API key (or username and password) below.',
        needsSetup: !configured,
      },
      { status: configured ? 502 : 503 },
    );
  }
}
