'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

interface Bucket {
  providerId: number;
  providerName: string;
  tier: string;
  groupId: number | null;
  groupName: string;
  audioOnly: boolean;
  samples: number;
  aliveRate: number;
  blackRate: number;
  measuredSamples: number;
  medianBitrateKbps: number;
  p90BitrateKbps: number;
  medianHeight: number;
  effectiveKbps: number;
  lastSampledAt: number;
}

interface Effect {
  key: string;
  samples: number;
  effectiveKbps: number;
  deltaKbps: number;
}

interface ScopeSummary {
  eventOnly: boolean;
  include: string[];
  exclude: string[];
  inScope: number;
  excluded: number;
  notIncluded: number;
  notEvent: number;
  unrecorded: number;
}

interface MatchedRule {
  type: string;
  value: string;
  points: number;
}

interface PickView {
  streamId: number;
  name: string;
  providerName: string;
  groupName: string;
  points: number;
  matched: MatchedRule[];
  bitrateKbps: number;
  height: number;
  alive: boolean;
  black: boolean;
}

interface ChannelCheck {
  channelId: number;
  channelName: string;
  streams: number;
  agree: boolean;
  ambiguous: boolean;
  teamarr: PickView;
  podium: PickView;
  gapKbps: number;
}

interface RuleCheck {
  generatedAt: number;
  rules: { evaluated: number; skipped: Array<{ type: string; value: string; reason: string }> };
  summary: {
    channels: number;
    agreed: number;
    disagreed: number;
    ambiguous: number;
    deadFirst: number;
    gapKbps: number;
    approximate: boolean;
  };
  channels: ChannelCheck[];
}

interface StoredMiss {
  channelId: number;
  channelName: string;
  teamarrName: string;
  teamarrProvider: string;
  teamarrPoints: number;
  teamarrBitrate: number;
  teamarrAlive: boolean;
  teamarrBlack: boolean;
  teamarrMatched: MatchedRule[];
  podiumName: string;
  podiumProvider: string;
  podiumBitrate: number;
  gapKbps: number;
}

interface StoredCheck {
  checkedAt: number;
  channels: number;
  agreed: number;
  disagreed: number;
  ambiguous: number;
  deadFirst: number;
  gapKbps: number;
  approximate: boolean;
}

interface CheckHistory {
  rulesUploadedAt: number | null;
  ruleCount: number;
  history: StoredCheck[];
  latest: StoredMiss[];
}

interface Profile {
  generatedAt: number;
  totalSamples: number;
  recordedSamples: number;
  namedSamples: number;
  scope: ScopeSummary;
  audioOnlySamples: number;
  baselineKbps: number;
  buckets: Bucket[];
  accounts: Effect[];
  tiers: Effect[];
  groups: Effect[];
}

const card = 'rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]';
const btn =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-2 text-[15px] hover:border-[var(--color-accent)] disabled:opacity-50';
const input =
  'w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 outline-none focus:border-[var(--color-accent)]';
const muted = 'text-[var(--color-muted)]';

/** kbps as the operator thinks of it: Mbps once it stops being a small number. */
export function rate(kbps: number): string {
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

export function signed(kbps: number): string {
  return `${kbps > 0 ? '+' : kbps < 0 ? '−' : ''}${rate(Math.abs(kbps))}`;
}

/**
 * A delta's colour, on the one scale the whole view shares.
 *
 * Deliberately not a red/green pair keyed on the sign alone: nearly every
 * effect is non-zero by a few kbps, and painting a +40kbps account green next
 * to a +3000kbps group green says the two are the same kind of finding. The
 * threshold is where a delta starts being worth acting on.
 */
export function tone(kbps: number): string {
  if (kbps >= 500) return 'text-[var(--color-accent)]';
  if (kbps <= -500) return 'text-[var(--color-bad)]';
  return muted;
}

/**
 * The scope in a sentence.
 *
 * Written out rather than shown as three fields because the rules compose in a
 * way a field list does not say: the excludes are a veto over the other two,
 * and someone reading "events" beside "*VOD*" has no way to know which wins.
 */
export function describeScope(scope: ScopeSummary): string {
  const parts: string[] = [];
  if (scope.eventOnly) parts.push('channels in groups set to after EPG start or assigned');
  if (scope.include.length > 0) parts.push(`groups matching ${scope.include.join(', ')}`);
  const admitted = parts.length > 0 ? parts.join(', or ') : 'every probe';
  return scope.exclude.length > 0
    ? `Learning from ${admitted} — except groups matching ${scope.exclude.join(', ')}.`
    : `Learning from ${admitted}.`;
}

/** Why samples were left out, as counted rows, most explicable first. */
export function scopeDrops(scope: ScopeSummary): Array<{ label: string; count: number }> {
  return [
    { label: 'excluded by pattern', count: scope.excluded },
    { label: 'not an event channel', count: scope.notEvent },
    { label: 'matched no include pattern', count: scope.notIncluded },
    { label: 'probed before the scope was recorded', count: scope.unrecorded },
  ].filter((row) => row.count > 0);
}

function ago(at: number): string {
  const hours = (Date.now() - at) / 3_600_000;
  if (hours < 1) return 'under an hour ago';
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * What Podium has learned about stream quality by provenance, and the export
 * that hands it to Teamarr.
 *
 * The group table leads because it is the strongest thing here: a group's
 * effect routinely spans thousands of kbps where an account's spans tens, so it
 * is both the most useful row to read and the most valuable rule to ship.
 */
export function QualityView() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [minSamples, setMinSamples] = useState(20);
  const [pointsPerMbps, setPointsPerMbps] = useState(5);
  const [showAudio, setShowAudio] = useState(false);
  const [showThin, setShowThin] = useState(false);
  // A preview, never a saved setting. The cost of a scope that is too narrow is
  // invisible from inside it -- a smaller table looks like a quieter install --
  // so the answer to "what am I not being shown" has to be one click away.
  const [ungated, setUngated] = useState(false);
  const [merging, setMerging] = useState(false);
  const [merged, setMerged] = useState('');
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<RuleCheck | null>(null);
  const [history, setHistory] = useState<CheckHistory | null>(null);

  const load = useCallback(async (min: number, open: boolean) => {
    setLoading(true);
    try {
      const resp = await fetch(
        `/api/quality-profile?minSamples=${min}${open ? '&eventOnly=0&include=&exclude=' : ''}`,
      );
      const body = await resp.json();
      if (!resp.ok || body.error) {
        setError(String(body.error ?? `HTTP ${resp.status}`));
        return;
      }
      setError('');
      setProfile(body as Profile);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(minSamples, ungated);
  }, [load, minSamples, ungated]);

  const loadHistory = useCallback(async () => {
    try {
      const resp = await fetch('/api/rule-check');
      const body = await resp.json();
      if (resp.ok && !body.error) setHistory(body as CheckHistory);
    } catch {
      // The stored view is an extra; failing to read it must not take the page
      // down with it.
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // The export carries the scope being previewed, so the file always describes
  // the table it was downloaded from. Handing over rules fitted on a population
  // the page was not showing is the one way this feature could lie outright.
  const query =
    `minSamples=${minSamples}&pointsPerMbps=${pointsPerMbps}` +
    (ungated ? '&eventOnly=0&include=&exclude=' : '');

  /**
   * Merge Podium's rules into the file Teamarr exported.
   *
   * Teamarr's import replaces its whole rule set, so handing over a bare
   * export deletes every hand-written rule on the instance. Doing the merge
   * behind a file picker rather than documenting a curl is the difference
   * between a feature and a trap.
   */
  const mergeInto = async (file: File) => {
    setMerging(true);
    setMerged('');
    try {
      const resp = await fetch(`/api/quality-profile?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: await file.text(),
      });
      const text = await resp.text();
      if (!resp.ok) {
        setError(String(JSON.parse(text).error ?? `HTTP ${resp.status}`));
        return;
      }
      const body = JSON.parse(text) as { podium?: { merged?: Record<string, number> } };
      const stats = body.podium?.merged;
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'stream-ordering-rules.json';
      link.click();
      URL.revokeObjectURL(url);
      setError('');
      setMerged(
        stats
          ? `${stats.existing} of your rules kept, ${stats.generated} from Podium, ` +
              `${stats.replaced} updated in place.`
          : 'Merged.',
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setMerging(false);
    }
  };

  /**
   * Score the rules Teamarr is running against what Podium has measured.
   *
   * Reads only cached verdicts, so it can be run after every edit -- which is
   * the whole point: a scoring rule is otherwise unfalsifiable, and the only
   * visible consequence of a wrong one is which stream somebody gets weeks
   * later.
   */
  const checkAgainst = async (file: File) => {
    setChecking(true);
    setCheck(null);
    try {
      const resp = await fetch('/api/rule-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: await file.text(),
      });
      const body = await resp.json();
      if (!resp.ok || body.error) {
        setError(String(body.error ?? `HTTP ${resp.status}`));
        return;
      }
      setError('');
      setCheck(body as RuleCheck);
      void loadHistory();
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  };

  const buckets = useMemo(() => {
    if (!profile) return [];
    // Below the floor by default. An install of any size has hundreds of
    // one- and two-sample buckets -- a provider's every fixture group, each
    // probed once -- and listing them all buries the forty that count under
    // three hundred that do not.
    return profile.buckets.filter(
      (b) => (showAudio || !b.audioOnly) && (showThin || b.samples >= minSamples),
    );
  }, [profile, showAudio, showThin, minSamples]);

  const hidden = (profile?.buckets.length ?? 0) - buckets.length;

  const counted =
    profile?.buckets.filter((b) => b.samples >= minSamples && !b.audioOnly).length ?? 0;

  const drops = profile ? scopeDrops(profile.scope) : [];

  if (loading && !profile) {
    return <p className={`p-5 ${muted}`}>Loading…</p>;
  }

  if (error && !profile) {
    return <p className="p-5 text-[var(--color-bad)]">{error}</p>;
  }

  if (profile && profile.totalSamples === 0 && profile.recordedSamples === 0) {
    return (
      <div className={`m-5 p-5 ${card}`}>
        <h2 className="text-lg">Nothing measured yet</h2>
        <p className={`mt-2 text-sm ${muted}`}>
          Podium records what it learns about a provider each time it probes, so this fills in as
          passes run — no extra probing, and it accumulates in dry-run too. A few days of ordinary
          passes is usually enough for the first buckets to clear the sample floor.
        </p>
      </div>
    );
  }

  // Samples exist and the gate took all of them. Distinguished from having no
  // samples at all because the two look identical on the page and are fixed in
  // opposite ways -- one by waiting, one by widening the scope.
  if (profile && profile.totalSamples === 0) {
    return (
      <div className={`m-5 p-5 ${card}`}>
        <h2 className="text-lg">Nothing in scope</h2>
        <p className={`mt-2 max-w-[75ch] text-sm ${muted}`}>
          {profile.recordedSamples.toLocaleString()} samples are held, and the scope admits none of
          them. {describeScope(profile.scope)}{' '}
          {profile.scope.unrecorded > 0 && (
            <>
              {profile.scope.unrecorded.toLocaleString()} of them were probed before Podium recorded
              which channel a probe was for, so their policy cannot be read — name their groups
              under <strong>Always learn from groups matching</strong> in Settings to use them, or
              leave them and let new passes accumulate.
            </>
          )}
        </p>
        <label className={`mt-3 flex cursor-pointer items-center gap-2 text-sm ${muted}`}>
          <input
            type="checkbox"
            checked={ungated}
            onChange={(e) => setUngated(e.target.checked)}
            className="h-4 w-4 accent-[var(--color-accent)]"
          />
          Ignore the scope and show everything measured
        </label>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-5">
      {error && <p className="text-[var(--color-bad)]">{error}</p>}

      <section className={`${card} p-5`}>
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <h2 className="text-lg">Measured quality</h2>
          <span className={`text-sm ${muted}`}>
            {profile?.totalSamples.toLocaleString()} samples · {counted} buckets counted · baseline{' '}
            {rate(profile?.baselineKbps ?? 0)}
            {profile && profile.audioOnlySamples > 0 && (
              <> · {profile.audioOnlySamples.toLocaleString()} audio-only held out</>
            )}
            {/* The readiness number for name-pattern mining: samples taken
                before names were kept carry none, so this climbs from zero as
                ordinary passes run. Hidden once every sample has one, when it
                has stopped saying anything. */}
            {profile && profile.namedSamples < profile.totalSamples && (
              <> · {profile.namedSamples.toLocaleString()} with names</>
            )}
          </span>
        </div>
        <p className={`mt-2 max-w-[70ch] text-sm ${muted}`}>
          What a stream from each provenance is worth, measured rather than claimed. Effects are
          fitted against each other, so a group is compared against other groups at the same tier on
          the same account rather than against the install as a whole.
        </p>

        {profile && (
          <div className="mt-4 border-t border-[var(--color-line)] pt-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
              <p className={`max-w-[70ch] text-sm ${muted}`}>
                <strong className="text-[var(--color-text)]">Scope.</strong>{' '}
                {describeScope(profile.scope)}{' '}
                {drops.length > 0 && (
                  <>
                    {(profile.recordedSamples - profile.totalSamples).toLocaleString()} of{' '}
                    {profile.recordedSamples.toLocaleString()} samples sit outside it —{' '}
                    {drops.map((d) => `${d.count.toLocaleString()} ${d.label}`).join(', ')}. They
                    are kept, not deleted: widening the scope in Settings brings them back with no
                    waiting.
                  </>
                )}
              </p>
              <label className={`flex cursor-pointer items-center gap-2 text-sm ${muted}`}>
                <input
                  type="checkbox"
                  checked={ungated}
                  onChange={(e) => setUngated(e.target.checked)}
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                Ignore the scope
              </label>
            </div>
          </div>
        )}
      </section>

      <section className={`${card} p-5`}>
        <h3 className="text-base">Groups</h3>
        <p className={`mt-1 max-w-[70ch] text-sm ${muted}`}>
          The strongest signal Podium has — a group is how a provider organises what it sells, and a
          sports package and a VOD dump are not the same product. Exported as Teamarr Group rules,
          matched on the name exactly as the provider writes it.
        </p>
        <EffectTable
          effects={profile?.groups ?? []}
          empty="No group has cleared the sample floor yet."
        />
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className={`${card} p-5`}>
          <h3 className="text-base">Provider accounts</h3>
          <p className={`mt-1 text-sm ${muted}`}>
            Exported as Teamarr M3U Account rules — wholesale, like groups.
          </p>
          <EffectTable
            effects={profile?.accounts ?? []}
            empty="No account has enough samples yet."
          />
        </section>

        <section className={`${card} p-5`}>
          <h3 className="text-base">Quality tiers</h3>
          <p className={`mt-1 text-sm ${muted}`}>
            From the token in the stream&apos;s own name. Exported as regex rules; streams naming no
            tier are the reference level and get none.
          </p>
          <EffectTable effects={profile?.tiers ?? []} empty="No tier has enough samples yet." />
        </section>
      </div>

      <section className={`${card} p-5`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base">Buckets</h3>
          <div className="flex flex-wrap items-center gap-4">
            <label className={`flex cursor-pointer items-center gap-2 text-sm ${muted}`}>
              <input
                type="checkbox"
                checked={showThin}
                onChange={(e) => setShowThin(e.target.checked)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              Show below the floor{hidden > 0 && ` (${hidden})`}
            </label>
            <label className={`flex cursor-pointer items-center gap-2 text-sm ${muted}`}>
              <input
                type="checkbox"
                checked={showAudio}
                onChange={(e) => setShowAudio(e.target.checked)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              Show audio-only
            </label>
          </div>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className={`text-left ${muted}`}>
              <tr className="border-b border-[var(--color-line)]">
                <th className="py-2 pr-3 font-normal">Account</th>
                <th className="py-2 pr-3 font-normal">Group</th>
                <th className="py-2 pr-3 font-normal">Tier</th>
                <th className="py-2 pr-3 text-right font-normal">Samples</th>
                <th className="py-2 pr-3 text-right font-normal">Alive</th>
                <th className="py-2 pr-3 text-right font-normal">Black</th>
                <th className="py-2 pr-3 text-right font-normal">Median</th>
                <th className="py-2 pr-3 text-right font-normal">p90</th>
                <th className="py-2 pr-3 text-right font-normal">Effective</th>
                <th className="py-2 text-right font-normal">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr
                  key={`${b.providerId}:${b.groupId ?? ''}:${b.tier}:${b.audioOnly}`}
                  className={`border-b border-[var(--color-line)] ${
                    b.samples < minSamples ? 'opacity-50' : ''
                  }`}
                >
                  <td className="py-2 pr-3">{b.providerName}</td>
                  <td className="py-2 pr-3">{b.groupName || <span className={muted}>—</span>}</td>
                  <td className={`py-2 pr-3 ${muted}`}>
                    {b.tier}
                    {b.audioOnly && ' · audio'}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{b.samples}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {(b.aliveRate * 100).toFixed(0)}%
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {b.blackRate > 0 ? `${(b.blackRate * 100).toFixed(0)}%` : '—'}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{rate(b.medianBitrateKbps)}</td>
                  <td className={`py-2 pr-3 text-right tabular-nums ${muted}`}>
                    {rate(b.p90BitrateKbps)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{rate(b.effectiveKbps)}</td>
                  <td className={`py-2 text-right ${muted}`}>{ago(b.lastSampledAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={`mt-3 text-sm ${muted}`}>
          Bitrates are measured ones only — a container&apos;s declared figure, a dead stream&apos;s
          zero and a slate&apos;s trickle all describe something other than what a viewer receives.
          How often those happen is the alive and black columns. Faded rows are below the sample
          floor and contribute nothing.
        </p>
      </section>

      <section className={`${card} p-5`}>
        <h3 className="text-base">Export to Teamarr</h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className={`text-sm ${muted}`}>Minimum samples per bucket</span>
            <input
              type="number"
              min={1}
              value={minSamples}
              onChange={(e) => setMinSamples(Math.max(1, Number(e.target.value) || 1))}
              className={`mt-1 ${input}`}
            />
            <span className={`mt-1 block text-xs ${muted}`}>
              Below this a bucket is measured but contributes nothing. A reading off four streams is
              noise with a number attached.
            </span>
          </label>
          <label className="block">
            <span className={`text-sm ${muted}`}>Points per Mbps</span>
            <input
              type="number"
              min={0}
              value={pointsPerMbps}
              onChange={(e) => setPointsPerMbps(Math.max(0, Number(e.target.value) || 0))}
              className={`mt-1 ${input}`}
            />
            <span className={`mt-1 block text-xs ${muted}`}>
              Only the ratio against your own rules matters. Raise it if those use larger numbers.
              No generated rule exceeds ±15 either way: Teamarr already scores a measured stream
              from the bitrate Podium publishes, and a prior about streams like it should never
              outrank a reading of the stream itself.
            </span>
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <a className={btn} href={`/api/quality-profile?format=teamarr&${query}`} download>
            Download rules
          </a>
          <label className={`${btn} cursor-pointer`}>
            {merging ? 'Merging…' : 'Merge into my Teamarr rules…'}
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              disabled={merging}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void mergeInto(file);
              }}
            />
          </label>
          {merged && <span className={`text-sm ${muted}`}>{merged}</span>}
        </div>

        {ungated && (
          <p className="mt-3 max-w-[70ch] text-sm text-[var(--color-bad)]">
            The scope is switched off, so these rules would be fitted on every probe this install
            has taken — VOD and filler included — and evaluated on fixtures. Turn it back on above
            before exporting unless you mean that.
          </p>
        )}

        <p className={`mt-3 max-w-[70ch] text-sm ${muted}`}>
          Teamarr&apos;s import <strong>replaces</strong> its whole rule set. Export your rules from
          Teamarr and merge them here first, or the import will delete everything you wrote by hand.
          A rule Podium also generated is updated in place rather than added twice, so re-importing
          next month refreshes the numbers instead of stacking a second set of points.
        </p>
      </section>

      <section className={`${card} p-5`}>
        <h3 className="text-base">Check the rules you are running</h3>
        <p className={`mt-1 max-w-[75ch] text-sm ${muted}`}>
          A scoring rule cannot be checked from inside Teamarr: a +20 that matches nothing, a regex
          pinned to the wrong end of a name and a rule that works all look the same in the file, and
          the only visible consequence is which stream somebody gets weeks later. Upload your rules
          and Podium scores them against every channel it has measured — the stream your rules put
          first, beside the stream the measurements say should be first. Nothing is written and no
          stream is probed, so run it after every edit. The set you upload is kept and re-checked by
          every later pass — which is the only way a fixture channel is ever checked, since its
          streams are gone by the next morning.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className={`${btn} cursor-pointer`}>
            {checking ? 'Scoring…' : 'Check my Teamarr rules…'}
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              disabled={checking}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void checkAgainst(file);
              }}
            />
          </label>
          {check && (
            <span className="text-sm">
              <strong>{check.summary.agreed}</strong> of {check.summary.channels} channels agree
              {check.summary.disagreed > 0 && (
                <span className="text-[var(--color-bad)]">
                  {' '}
                  · {check.summary.disagreed} pick a worse stream
                </span>
              )}
              {check.summary.deadFirst > 0 && (
                <span className="text-[var(--color-bad)]">
                  {' '}
                  · {check.summary.deadFirst} put a dead or black stream first
                </span>
              )}
              {check.summary.ambiguous > 0 && (
                <span className={muted}> · {check.summary.ambiguous} decided by a tie</span>
              )}
            </span>
          )}
        </div>

        {check && check.summary.gapKbps > 0 && (
          <p className={`mt-3 text-sm ${muted}`}>
            Across the disagreements, {rate(check.summary.gapKbps)} of measured bitrate goes to the
            stream that is not chosen.
          </p>
        )}

        {check && check.rules.skipped.length > 0 && (
          <p className={`mt-3 max-w-[75ch] text-sm ${muted}`}>
            {check.rules.evaluated} rules scored; {check.rules.skipped.length} could not be:{' '}
            {check.rules.skipped.map((rule) => `${rule.type} (${rule.reason})`).join('; ')}. Those
            read Teamarr&apos;s own state, so this comparison is approximate — a rule that applies
            to every stream on a channel cancels out and changes no ordering, but that cannot be
            shown from here.
          </p>
        )}

        {check?.channels.some((row) => !row.agree) && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className={`text-left ${muted}`}>
                <tr className="border-b border-[var(--color-line)]">
                  <th className="py-2 pr-3 font-normal">Channel</th>
                  <th className="py-2 pr-3 font-normal">Your rules pick</th>
                  <th className="py-2 pr-3 text-right font-normal">Scored</th>
                  <th className="py-2 pr-3 font-normal">Measurement picks</th>
                  <th className="py-2 text-right font-normal">Given up</th>
                </tr>
              </thead>
              <tbody>
                {check.channels
                  .filter((row) => !row.agree)
                  .map((row) => (
                    <tr key={row.channelId} className="border-b border-[var(--color-line)]">
                      <td className="py-2 pr-3">{row.channelName}</td>
                      <td className="py-2 pr-3">
                        <span className="block truncate">{row.teamarr.name}</span>
                        <span className={`block text-xs ${muted}`}>
                          {row.teamarr.providerName} ·{' '}
                          {row.teamarr.alive && !row.teamarr.black ? (
                            rate(row.teamarr.bitrateKbps)
                          ) : (
                            <span className="text-[var(--color-bad)]">
                              {row.teamarr.alive ? 'black screen' : 'dead'}
                            </span>
                          )}
                          {row.teamarr.matched.length > 0 &&
                            ` · ${row.teamarr.matched
                              .map(
                                (rule) =>
                                  `${rule.type} ${rule.points > 0 ? '+' : ''}${rule.points}`,
                              )
                              .join(', ')}`}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{row.teamarr.points}</td>
                      <td className="py-2 pr-3">
                        <span className="block truncate">{row.podium.name}</span>
                        <span className={`block text-xs ${muted}`}>
                          {row.podium.providerName} · {rate(row.podium.bitrateKbps)} · scored{' '}
                          {row.podium.points}
                        </span>
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {row.gapKbps > 0 ? rate(row.gapKbps) : '—'}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}

        {/* What the passes have found on their own. The half that survives a
            fixture: a live check can only see channels whose streams still
            exist, and an event channel's are gone by morning. */}
        {history && history.rulesUploadedAt !== null && (
          <div className="mt-5 border-t border-[var(--color-line)] pt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <h4 className="text-sm font-semibold">Checked automatically each pass</h4>
              <span className={`text-sm ${muted}`}>
                {history.ruleCount} rules, uploaded {ago(history.rulesUploadedAt)}
              </span>
            </div>
            {history.history.length === 0 ? (
              <p className={`mt-2 max-w-[75ch] text-sm ${muted}`}>
                No pass has run since these rules were uploaded. The next one will check them while
                its verdicts are fresh, which is the only moment a fixture channel can be checked at
                all — by tomorrow its streams are gone and there is nothing left to compare.
              </p>
            ) : (
              <>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className={`text-left ${muted}`}>
                      <tr className="border-b border-[var(--color-line)]">
                        <th className="py-2 pr-3 font-normal">Pass</th>
                        <th className="py-2 pr-3 text-right font-normal">Channels</th>
                        <th className="py-2 pr-3 text-right font-normal">Agreed</th>
                        <th className="py-2 pr-3 text-right font-normal">Picked worse</th>
                        <th className="py-2 pr-3 text-right font-normal">Dead first</th>
                        <th className="py-2 text-right font-normal">Given up</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.history.slice(0, 10).map((row) => (
                        <tr key={row.checkedAt} className="border-b border-[var(--color-line)]">
                          <td className={`py-2 pr-3 ${muted}`}>{ago(row.checkedAt)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{row.channels}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{row.agreed}</td>
                          <td
                            className={`py-2 pr-3 text-right tabular-nums ${
                              row.disagreed > 0 ? 'text-[var(--color-bad)]' : ''
                            }`}
                          >
                            {row.disagreed}
                          </td>
                          <td
                            className={`py-2 pr-3 text-right tabular-nums ${
                              row.deadFirst > 0 ? 'text-[var(--color-bad)]' : ''
                            }`}
                          >
                            {row.deadFirst}
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {row.gapKbps > 0 ? rate(row.gapKbps) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {history.latest.length > 0 && (
                  <>
                    <p className={`mt-3 max-w-[75ch] text-sm ${muted}`}>
                      What the most recent pass got wrong, worst first. These name the streams as
                      they stood at the time — a fixture&apos;s are gone by now, which is why the
                      row is kept rather than re-derived.
                    </p>
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className={`text-left ${muted}`}>
                          <tr className="border-b border-[var(--color-line)]">
                            <th className="py-2 pr-3 font-normal">Channel</th>
                            <th className="py-2 pr-3 font-normal">Rules picked</th>
                            <th className="py-2 pr-3 font-normal">Measurement picked</th>
                            <th className="py-2 text-right font-normal">Given up</th>
                          </tr>
                        </thead>
                        <tbody>
                          {history.latest.slice(0, 20).map((miss) => (
                            <tr
                              key={`${miss.channelId}:${miss.teamarrName}`}
                              className="border-b border-[var(--color-line)]"
                            >
                              <td className="py-2 pr-3">{miss.channelName}</td>
                              <td className="py-2 pr-3">
                                <span className="block truncate">{miss.teamarrName}</span>
                                <span className={`block text-xs ${muted}`}>
                                  {miss.teamarrProvider} ·{' '}
                                  {miss.teamarrAlive && !miss.teamarrBlack ? (
                                    rate(miss.teamarrBitrate)
                                  ) : (
                                    <span className="text-[var(--color-bad)]">
                                      {miss.teamarrAlive ? 'black screen' : 'dead'}
                                    </span>
                                  )}{' '}
                                  · scored {miss.teamarrPoints}
                                  {miss.teamarrMatched.length > 0 &&
                                    ` (${miss.teamarrMatched
                                      .map(
                                        (rule) =>
                                          `${rule.type} ${rule.points > 0 ? '+' : ''}${rule.points}`,
                                      )
                                      .join(', ')})`}
                                </span>
                              </td>
                              <td className="py-2 pr-3">
                                <span className="block truncate">{miss.podiumName}</span>
                                <span className={`block text-xs ${muted}`}>
                                  {miss.podiumProvider} · {rate(miss.podiumBitrate)}
                                </span>
                              </td>
                              <td className="py-2 text-right tabular-nums">
                                {miss.gapKbps > 0 ? rate(miss.gapKbps) : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {check && check.summary.disagreed === 0 && check.summary.channels > 0 && (
          <p className={`mt-3 text-sm ${muted}`}>
            Every measured channel puts the same stream first under your rules as it would under the
            measurements. Worth re-running as the priors fill in — a rule set that is right today is
            right about the providers you have today.
          </p>
        )}
      </section>
    </div>
  );
}

function EffectTable({ effects, empty }: { effects: Effect[]; empty: string }) {
  if (effects.length === 0) {
    return <p className={`mt-3 text-sm ${muted}`}>{empty}</p>;
  }
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className={`text-left ${muted}`}>
          <tr className="border-b border-[var(--color-line)]">
            <th className="py-2 pr-3 font-normal">Name</th>
            <th className="py-2 pr-3 text-right font-normal">Samples</th>
            <th className="py-2 pr-3 text-right font-normal">Worth</th>
            <th className="py-2 text-right font-normal">vs baseline</th>
          </tr>
        </thead>
        <tbody>
          {effects.map((effect) => (
            <tr key={effect.key} className="border-b border-[var(--color-line)]">
              <td className="py-2 pr-3">{effect.key}</td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {effect.samples.toLocaleString()}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{rate(effect.effectiveKbps)}</td>
              <td className={`py-2 text-right tabular-nums ${tone(effect.deltaKbps)}`}>
                {signed(effect.deltaKbps)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
