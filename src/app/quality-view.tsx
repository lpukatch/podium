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

interface Profile {
  generatedAt: number;
  totalSamples: number;
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
 * The group table leads because it is the strongest thing here and the only
 * place it exists: a group's effect routinely spans thousands of kbps where an
 * account's spans tens. It is also the one Podium cannot export -- Teamarr
 * matches a group only on channel-source streams -- so a view is the only way
 * it reaches anybody.
 */
export function QualityView() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [minSamples, setMinSamples] = useState(20);
  const [pointsPerMbps, setPointsPerMbps] = useState(10);
  const [showAudio, setShowAudio] = useState(false);
  const [showThin, setShowThin] = useState(false);
  const [merging, setMerging] = useState(false);
  const [merged, setMerged] = useState('');

  const load = useCallback(async (min: number) => {
    setLoading(true);
    try {
      const resp = await fetch(`/api/quality-profile?minSamples=${min}`);
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
    void load(minSamples);
  }, [load, minSamples]);

  const query = `minSamples=${minSamples}&pointsPerMbps=${pointsPerMbps}`;

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

  if (loading && !profile) {
    return <p className={`p-5 ${muted}`}>Loading…</p>;
  }

  if (error && !profile) {
    return <p className="p-5 text-[var(--color-bad)]">{error}</p>;
  }

  if (profile && profile.totalSamples === 0) {
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
          </span>
        </div>
        <p className={`mt-2 max-w-[70ch] text-sm ${muted}`}>
          What a stream from each provenance is worth, measured rather than claimed. Effects are
          fitted against each other, so a group is compared against other groups at the same tier on
          the same account rather than against the install as a whole.
        </p>
      </section>

      <section className={`${card} p-5`}>
        <h3 className="text-base">Groups</h3>
        <p className={`mt-1 max-w-[70ch] text-sm ${muted}`}>
          The strongest signal Podium has, and the one it does not export: Teamarr can only match a
          group on channel-source streams. It is fitted anyway, because leaving it out of the model
          lets it contaminate the account and tier numbers that do get exported.
        </p>
        <EffectTable
          effects={profile?.groups ?? []}
          empty="No group has cleared the sample floor yet."
        />
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className={`${card} p-5`}>
          <h3 className="text-base">Provider accounts</h3>
          <p className={`mt-1 text-sm ${muted}`}>Exported as Teamarr M3U Account rules.</p>
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

        <p className={`mt-3 max-w-[70ch] text-sm ${muted}`}>
          Teamarr&apos;s import <strong>replaces</strong> its whole rule set. Export your rules from
          Teamarr and merge them here first, or the import will delete everything you wrote by hand.
          A rule Podium also generated is updated in place rather than added twice, so re-importing
          next month refreshes the numbers instead of stacking a second set of points.
        </p>
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
