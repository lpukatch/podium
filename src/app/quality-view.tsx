'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Types come from the modules that produce them, never re-declared here.
 *
 * Every interface below used to be a hand-copied mirror of a library type. The
 * copies compiled whatever the server actually sent, so a field renamed in
 * `quality.ts` or `teamarr.ts` reached this file as a silent `undefined` at
 * runtime rather than as a type error at build time -- which is the one job the
 * type checker was there to do. `import type` is erased entirely, so nothing
 * here reaches the browser bundle; only `MAX_TIER_ACCOUNT_SHARE` is a real
 * import, and `quality.ts` pulls in nothing but pure functions.
 */
import type { MinerGuard, MinerReport } from '@/lib/miner';
import type { Effect, LabelAccuracy, QualityProfile, ScopeSummary } from '@/lib/quality';
import { MAX_TIER_ACCOUNT_SHARE } from '@/lib/quality';
import type { StoredRuleCheckRow, StoredRuleMiss } from '@/lib/store';
import type { RuleCheck } from '@/lib/teamarr';

/** What `/api/quality-profile` returns: the profile, with the miner's findings. */
type Profile = QualityProfile & { miner?: MinerReport };

/** What `GET /api/rule-check` returns. */
interface CheckHistory {
  rulesUploadedAt: number | null;
  ruleCount: number;
  history: StoredRuleCheckRow[];
  latest: StoredRuleMiss[];
}

/** How a rule set scored, in the terms two of them are compared on. */
interface SyncScore {
  channels: number;
  agreed: number;
  deadFirst: number;
  gapKbps: number;
}

/** What one push did, including the ones that declined to write. */
interface SyncOutcome {
  at: number;
  pushed: boolean;
  reason?: string;
  error?: string;
  rules?: { existing: number; generated: number; replaced: number; total: number };
  before?: SyncScore;
  after?: SyncScore;
  approximate?: boolean;
}

/** What `GET /api/teamarr-sync` returns. */
interface SyncStatus {
  configured: boolean;
  scheduled: boolean;
  everyMs?: number;
  minSamples?: number;
  /** When a push was last *attempted* — successes, refusals and failures alike. */
  lastAttemptAt?: number | null;
  /** When the schedule fires next, or null when nothing is scheduled. */
  nextAt?: number | null;
  last?: SyncOutcome | null;
}

/**
 * What the last push did.
 *
 * The refusals matter more than the successes here: a declined push leaves
 * Teamarr byte-identical, so without this the operator cannot tell a scheduled
 * sync that ran and chose not to act from one that never ran.
 */
function SyncReport({ outcome }: { outcome: SyncOutcome }) {
  const when = new Date(outcome.at).toLocaleString();
  const tone = outcome.error
    ? 'text-[var(--color-bad)]'
    : outcome.pushed
      ? 'text-[var(--color-good)]'
      : 'text-[var(--color-muted)]';
  const headline = outcome.error
    ? `Failed — ${outcome.error}`
    : outcome.pushed
      ? `Pushed ${outcome.rules?.total ?? 0} rules`
      : (outcome.reason ?? 'Nothing written');
  return (
    <div className="mt-3 rounded-lg border border-[var(--color-line)] p-3 text-sm">
      <div className={tone}>{headline}</div>
      <div className={`mt-1 text-xs ${muted}`}>{when}</div>
      {outcome.rules && (
        <div className={`mt-2 text-xs ${muted}`}>
          {outcome.rules.existing} of yours kept · {outcome.rules.generated} from Podium ·{' '}
          {outcome.rules.replaced} updated in place
        </div>
      )}
      {outcome.before && outcome.after && (
        <table className="mt-2 text-xs">
          <thead>
            <tr className={muted}>
              <th className="pr-4 text-left font-normal" />
              <th className="pr-4 text-right font-normal">Now</th>
              <th className="text-right font-normal">Proposed</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="pr-4">Channels agreeing</td>
              <td className="pr-4 text-right tabular-nums">
                {outcome.before.agreed}/{outcome.before.channels}
              </td>
              <td className="text-right tabular-nums">
                {outcome.after.agreed}/{outcome.after.channels}
              </td>
            </tr>
            <tr>
              <td className="pr-4">Led by a dead stream</td>
              <td className="pr-4 text-right tabular-nums">{outcome.before.deadFirst}</td>
              <td className="text-right tabular-nums">{outcome.after.deadFirst}</td>
            </tr>
            <tr>
              <td className="pr-4">Bitrate given up</td>
              <td className="pr-4 text-right tabular-nums">{outcome.before.gapKbps} kbps</td>
              <td className="text-right tabular-nums">{outcome.after.gapKbps} kbps</td>
            </tr>
          </tbody>
        </table>
      )}
      {outcome.approximate && (
        <p className={`mt-2 max-w-[60ch] text-xs ${muted}`}>
          Approximate: the set carries rules Podium cannot evaluate — <code>epg_match</code> and{' '}
          <code>stream_type</code> are Teamarr&apos;s own state. Both columns are scored the same
          way, so the comparison holds even where the absolute numbers do not.
        </p>
      )}
    </div>
  );
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
 * The same, forwards.
 *
 * A time already past reads as "due now" rather than as a negative interval:
 * the worker checks on its heartbeat, so a run a minute overdue is not late,
 * it is about to happen.
 */
function until(at: number): string {
  const hours = (at - Date.now()) / 3_600_000;
  if (hours <= 0) return 'due now';
  if (hours < 1) return 'in under an hour';
  if (hours < 48) return `in ${Math.round(hours)}h`;
  return `in ${Math.round(hours / 24)}d`;
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
  const [syncing, setSyncing] = useState(false);
  const [sync, setSync] = useState<SyncStatus | null>(null);
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

  const loadSync = useCallback(async () => {
    try {
      const resp = await fetch('/api/teamarr-sync');
      const body = await resp.json();
      if (resp.ok && !body.error) setSync(body as SyncStatus);
    } catch {
      // The panel is an extra; failing to read it must not take the page down.
    }
  }, []);

  useEffect(() => {
    void loadSync();
  }, [loadSync]);

  /**
   * Push straight to Teamarr, or preview what a push would do.
   *
   * The preview is the point of having two buttons. A scheduled push runs
   * unattended and can decline, and "what would tonight do" is not a question
   * you can answer by doing it.
   */
  const pushToTeamarr = async (dryRun: boolean) => {
    setSyncing(true);
    setError('');
    try {
      const resp = await fetch(`/api/teamarr-sync?${dryRun ? 'dryRun=1' : ''}`, { method: 'POST' });
      const body = await resp.json();
      if (!resp.ok || body.error) {
        setError(String(body.error ?? `HTTP ${resp.status}`));
        return;
      }
      setSync((prev: SyncStatus | null) => ({
        ...(prev ?? { configured: true, scheduled: false }),
        last: body,
      }));
      if (!dryRun) void loadSync();
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  };

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
            tier match none of them, so they are the reference level and every other tier is quoted
            as its distance from them. A tier fitted almost entirely from one account is withheld
            from the export — see below for whether its labels are worth anything.
          </p>
          <EffectTable
            effects={profile?.tiers ?? []}
            empty="No tier has enough samples yet."
            warnSingleAccount
          />
        </section>
      </div>

      <section className={`${card} p-5`}>
        <h3 className="text-base">Mining the names</h3>
        <p className={`mt-1 max-w-[80ch] text-sm ${muted}`}>
          The account and group rules are wholesale — a stream either came from there or it did not.
          The stream&apos;s own name is the only per-stream lever, and rather than guess at a
          vocabulary Podium measures which tokens actually predict anything. Tokens carried by whole
          groups are exported as regex rules that <em>replace</em> those groups&apos; rules; tokens
          that vary within a bucket are reported here and not yet exported, because telling a
          durable one from this week&apos;s fixture takes a week of samples.
        </p>
        <MinerPanel report={profile?.miner} />
      </section>

      <section className={`${card} p-5`}>
        <h3 className="text-base">Do the labels mean anything?</h3>
        <p className={`mt-1 max-w-[80ch] text-sm ${muted}`}>
          Podium measures the picture it receives, so it can hold each account&apos;s own resolution
          claim up against it. This is the check that says whether a tier rule is worth exporting at
          all: a regex scoring streams on <code>1080p</code> is only useful where the token is
          telling the truth. <span className="whitespace-nowrap">Labels</span> is how often this
          account names a tier; <span className="whitespace-nowrap">Correct</span> is how often the
          name matched what was measured. An account that never labels cannot be wrong, and gets no
          row.
        </p>
        <LabelAccuracyTable rows={profile?.labelAccuracy ?? []} />
      </section>

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
              No generated <em>prior</em> exceeds ±15 either way — an account, group or name rule is
              an inference about streams of the same provenance, and it should never outrank a
              reading of the stream itself. The <code>stats_metric</code> rules sit outside that cap
              on purpose: they are the reading.
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

        <div className="mt-5 border-t border-[var(--color-line)] pt-4">
          <h4 className="text-sm font-medium">Push straight to Teamarr</h4>
          {!sync?.configured ? (
            <p className={`mt-1 max-w-[70ch] text-sm ${muted}`}>
              Set <strong>Teamarr URL</strong> in Settings and the four steps above collapse into
              one button: Podium reads the rules Teamarr is running, merges its own in, and writes
              the result back. Until then the file download is the only route.
            </p>
          ) : (
            <>
              <p className={`mt-1 max-w-[70ch] text-sm ${muted}`}>
                Reads what Teamarr is running, merges these rules in and writes the result back —
                the same merge as the file route, without the file. Before writing, both rule sets
                are scored against what Podium has measured, and the push is{' '}
                <strong>refused if the ordering would get worse</strong>: any rise in channels led
                by a dead stream, or fewer channels agreeing <em>and</em> more measured bitrate
                given up.
                {sync.scheduled
                  ? ` It also runs on its own every ${Math.round((sync.everyMs ?? 0) / 3_600_000)}h.`
                  : ' The schedule is off, so this button is the only thing that writes.'}
              </p>
              <div className={`mt-2 text-xs ${muted}`}>
                {sync.lastAttemptAt
                  ? `Last sync ${ago(sync.lastAttemptAt)}`
                  : 'No push has run yet'}
                {sync.scheduled && sync.nextAt
                  ? ` · next ${until(sync.nextAt)}`
                  : ' · not scheduled'}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className={btn}
                  disabled={syncing}
                  onClick={() => void pushToTeamarr(true)}
                >
                  {syncing ? 'Working…' : 'Preview a push'}
                </button>
                <button
                  type="button"
                  className={btn}
                  disabled={syncing}
                  onClick={() => void pushToTeamarr(false)}
                >
                  {syncing ? 'Working…' : 'Sync to Teamarr now'}
                </button>
              </div>
              {sync.last && <SyncReport outcome={sync.last} />}
            </>
          )}
        </div>
      </section>

      <section className={`${card} p-5`}>
        <h3 className="text-base">Check the rules you are running</h3>
        <p className={`mt-1 max-w-[75ch] text-sm ${muted}`}>
          A scoring rule cannot be checked from inside Teamarr: a +20 that matches nothing, a regex
          pinned to the wrong end of a name and a rule that works all look the same in the file, and
          the only visible consequence is which stream somebody gets weeks later. Upload your rules
          and Podium scores them against every channel <em>Teamarr orders</em> that it has measured
          — the stream your rules put first, beside the stream the measurements say should be first.
          Channels Teamarr does not order are left out: its rules are never evaluated on them, so a
          disagreement there judges the rules on a population they will never see. Nothing is
          written and no stream is probed, so run it after every edit. The set you upload is kept
          and re-checked by every later pass — which is the only way a fixture channel is ever
          checked, since its streams are gone by the next morning.
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
              <strong>{check.summary.managedAgreed}</strong> of {check.summary.managedChannels}{' '}
              Teamarr-managed channels agree
              {check.summary.managedChannels - check.summary.managedAgreed > 0 && (
                <span className="text-[var(--color-bad)]">
                  {' '}
                  · {check.summary.managedChannels - check.summary.managedAgreed} pick a worse
                  stream
                </span>
              )}
              {check.summary.managedDeadFirst > 0 && (
                <span className="text-[var(--color-bad)]">
                  {' '}
                  · {check.summary.managedDeadFirst} pick a dead stream over a working one
                </span>
              )}
              {check.summary.ambiguous > 0 && (
                <span className={muted}> · {check.summary.ambiguous} decided by a tie</span>
              )}
            </span>
          )}
        </div>

        {check && check.summary.managedGapKbps > 0 && (
          <p className={`mt-3 max-w-[75ch] text-sm ${muted}`}>
            Across these disagreements, {rate(check.summary.managedGapKbps)} of measured bitrate
            goes to the stream that is not chosen.
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
                      <td className="py-2 pr-3">
                        {row.channelName}
                        {/* Only reachable from a check stored before the scoping;
                            those rows still carry the wider population. */}
                        {!row.managed && (
                          <span className={`ml-2 text-xs ${muted}`}>not Teamarr-ordered</span>
                        )}
                      </td>
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
                        <th className="py-2 pr-3 font-normal">Found</th>
                        <th className="py-2 pr-3 text-right font-normal">Managed</th>
                        <th className="py-2 pr-3 text-right font-normal">Agreed</th>
                        <th className="py-2 pr-3 text-right font-normal">Picked worse</th>
                        <th className="py-2 pr-3 text-right font-normal">Dead over live</th>
                        <th className="py-2 text-right font-normal">Given up</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.history.slice(0, 10).map((row) => (
                        <tr key={row.checkedAt} className="border-b border-[var(--color-line)]">
                          <td className={`py-2 pr-3 ${muted}`}>
                            {ago(row.checkedAt)}
                            {row.repeated > 0 && (
                              // A row is one distinct finding, not one pass, so
                              // say how long it has been standing -- otherwise a
                              // result that has held all week reads as a single
                              // stale check from whenever it was first seen.
                              <span className="ml-1 whitespace-nowrap">
                                · held for {row.repeated + 1} passes
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {row.managedChannels}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{row.managedAgreed}</td>
                          <td
                            className={`py-2 pr-3 text-right tabular-nums ${
                              row.managedChannels - row.managedAgreed > 0
                                ? 'text-[var(--color-bad)]'
                                : ''
                            }`}
                          >
                            {row.managedChannels - row.managedAgreed}
                          </td>
                          <td
                            className={`py-2 pr-3 text-right tabular-nums ${
                              row.managedDeadFirst > 0 ? 'text-[var(--color-bad)]' : ''
                            }`}
                          >
                            {row.managedDeadFirst}
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {row.managedGapKbps > 0 ? rate(row.managedGapKbps) : '—'}
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
                              <td className="py-2 pr-3">
                                {miss.channelName}
                                {!miss.managed && (
                                  <span className={`ml-2 text-xs ${muted}`}>
                                    not Teamarr-ordered
                                  </span>
                                )}
                              </td>
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

function EffectTable({
  effects,
  empty,
  warnSingleAccount = false,
}: {
  effects: Effect[];
  empty: string;
  /**
   * Flag rows fitted almost entirely from one account.
   *
   * Only tiers ask for this, because only a tier rule is a regex Teamarr runs
   * against every provider's streams -- so it is the only one that carries a
   * number somewhere it was never measured. See the constant above.
   */
  warnSingleAccount?: boolean;
}) {
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
            <th className="py-2 text-right font-normal">
              {warnSingleAccount ? 'vs unlabelled' : 'vs baseline'}
            </th>
          </tr>
        </thead>
        <tbody>
          {effects.map((effect) => {
            const confounded = warnSingleAccount && effect.topAccountShare > MAX_TIER_ACCOUNT_SHARE;
            const shown = effect.vsReferenceKbps ?? effect.deltaKbps;
            return (
              <tr key={effect.key} className="border-b border-[var(--color-line)]">
                <td className="py-2 pr-3">
                  {effect.key}
                  {confounded && (
                    <span
                      className="ml-2 rounded border border-[var(--color-warn)] px-1.5 py-0.5 text-xs text-[var(--color-warn)]"
                      title={`${Math.round(effect.topAccountShare * 100)}% of these samples come from one account, so this number describes that account rather than the tier. Withheld from the export.`}
                    >
                      one account
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {effect.samples.toLocaleString()}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{rate(effect.effectiveKbps)}</td>
                {/* A confounded delta is shown but not coloured: the number is
                    real, what it is a number *about* is not what the row says.
                    Tiers are quoted against the unlabelled reference rather than
                    the baseline, because that is the distance the exported rule
                    carries -- an unlabelled stream matches no tier rule at all. */}
                <td className={`py-2 text-right tabular-nums ${confounded ? muted : tone(shown)}`}>
                  {effect.vsReferenceKbps !== null && effect.key === 'unknown' ? (
                    <span className={muted}>reference</span>
                  ) : (
                    signed(shown)
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Percentage, with the sample count that earned it. */
function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** What each guard means, in the terms the operator can act on. */
const GUARD_LABEL: Record<MinerGuard, string> = {
  samples: 'too few samples either side of the split',
  effect: 'difference too small to survive the points rounding',
  cells: 'seen in only one bucket — that is a channel, not a pattern',
  duration: 'has not been predicting the same thing for long enough',
  stability: 'flips sign across the window — it is fitting a schedule',
};

/**
 * What the miner found, and what is stopping it.
 *
 * The panel exists because the miner is silent by design: on a fresh install it
 * finds nothing for at least a week, and "nothing" is indistinguishable from
 * "broken" unless something says which guard the candidates are dying on. Pass
 * A's findings are reported here and deliberately not exported yet.
 */
function MinerPanel({ report }: { report: MinerReport | undefined }) {
  if (!report) return <p className={`mt-3 text-sm ${muted}`}>No samples yet.</p>;

  const short = report.durationShortfallDays > 0;
  return (
    <div className="mt-4 space-y-5">
      <div className="flex flex-wrap items-center gap-4 text-sm tabular-nums">
        <span>
          <span className={muted}>Window </span>
          {report.windowDays} d
        </span>
        <span>
          <span className={muted}>Buckets </span>
          {report.cells}
        </span>
        <span>
          <span className={muted}>Splittable </span>
          {report.cellsWithBothSides}
        </span>
        <span>
          <span className={muted}>Candidates </span>
          {report.passA.candidates.length}
        </span>
        <span>
          <span className={muted}>Clearing </span>
          {report.passA.clearing}
        </span>
      </div>

      {short && (
        <p className="text-sm">
          Needs <strong>{report.durationShortfallDays} more days</strong> of samples before any name
          rule can clear the durability guard. Nothing to do but keep probing.
        </p>
      )}

      {report.passB.consolidated.length > 0 && (
        <div>
          <h4 className="text-sm font-medium">Exported as regex rules</h4>
          <table className="mt-2 w-full text-sm tabular-nums">
            <thead className={`text-left ${muted}`}>
              <tr>
                <th className="py-1 font-normal">Token</th>
                <th className="py-1 text-right font-normal">Effect</th>
                <th className="py-1 text-right font-normal">Replaces</th>
              </tr>
            </thead>
            <tbody>
              {report.passB.consolidated.map((token) => (
                <tr key={token.token} className="border-[var(--color-line)] border-t">
                  <td className="py-1">
                    <code>{token.token}</code>
                  </td>
                  <td className={`py-1 text-right ${tone(token.deltaKbps)}`}>
                    {signed(token.deltaKbps)}
                  </td>
                  <td className={`py-1 text-right ${muted}`}>
                    {token.carriers.length} group rules
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report.passB.confoundedCodecs.length > 0 && (
        <div>
          <h4 className="text-sm font-medium">Withheld — names a codec</h4>
          <p className={`mt-1 max-w-[80ch] text-sm ${muted}`}>
            These cleared every guard. They are held back anyway because bitrate is not comparable
            across codecs: HEVC carries roughly the same picture in roughly half the bits, so the
            measured deficit is mostly the codec being efficient rather than the stream being worse.
            Exporting it would penalise every stream whose name says so, at every provider.
          </p>
          <ul className="mt-2 space-y-1 text-sm tabular-nums">
            {report.passB.confoundedCodecs.map((token) => (
              <li key={token.token}>
                <code>{token.token}</code>{' '}
                <span className={muted}>
                  would have scored {signed(token.deltaKbps)} across {token.carriers.length} groups
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.passA.candidates.length > 0 && (
        <div>
          <h4 className="text-sm font-medium">Name candidates, not yet exported</h4>
          <table className="mt-2 w-full text-sm tabular-nums">
            <thead className={`text-left ${muted}`}>
              <tr>
                <th className="py-1 font-normal">Token</th>
                <th className="py-1 text-right font-normal">Effect</th>
                <th className="py-1 text-right font-normal">Buckets</th>
                <th className="py-1 text-right font-normal">Span</th>
                <th className="py-1 font-normal"> Blocked by</th>
              </tr>
            </thead>
            <tbody>
              {report.passA.candidates.slice(0, 12).map((candidate) => (
                <tr key={candidate.token} className="border-[var(--color-line)] border-t">
                  <td className="py-1">
                    <code>{candidate.token}</code>
                  </td>
                  <td className={`py-1 text-right ${tone(candidate.effectKbps)}`}>
                    {signed(candidate.effectKbps)}
                  </td>
                  <td className="py-1 text-right">{candidate.cells}</td>
                  <td className="py-1 text-right">{candidate.spanDays} d</td>
                  <td className={`py-1 pl-3 ${muted}`}>
                    {candidate.blockedBy.length === 0
                      ? 'clears every guard'
                      : GUARD_LABEL[candidate.blockedBy[0] as MinerGuard]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LabelAccuracyTable({ rows }: { rows: LabelAccuracy[] }) {
  const checked = rows.filter((row) => row.labelled > 0);
  if (checked.length === 0) {
    return (
      <p className={`mt-3 text-sm ${muted}`}>
        No account has labelled a stream yet, so there is nothing to check.
      </p>
    );
  }
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className={`text-left ${muted}`}>
          <tr className="border-b border-[var(--color-line)]">
            <th className="py-2 pr-3 font-normal">Account</th>
            <th className="py-2 pr-3 text-right font-normal">Labels</th>
            <th className="py-2 pr-3 text-right font-normal">Correct</th>
            <th className="py-2 font-normal">Commonest miss</th>
          </tr>
        </thead>
        <tbody>
          {checked.map((row) => {
            const accuracy = row.accuracy ?? 0;
            return (
              <tr key={row.providerId} className="border-b border-[var(--color-line)]">
                <td className="py-2 pr-3">{row.providerName}</td>
                <td className={`py-2 pr-3 text-right tabular-nums ${muted}`}>
                  {pct(row.labelledShare)}{' '}
                  <span className="text-xs">
                    ({row.labelled.toLocaleString()}/{row.samples.toLocaleString()})
                  </span>
                </td>
                <td
                  className={`py-2 pr-3 text-right tabular-nums ${
                    accuracy >= 0.8
                      ? 'text-[var(--color-accent)]'
                      : accuracy >= 0.5
                        ? 'text-[var(--color-warn)]'
                        : 'text-[var(--color-bad)]'
                  }`}
                >
                  {pct(accuracy)}
                </td>
                <td className={`py-2 ${muted}`}>
                  {row.commonestMiss ? (
                    <>
                      says {row.commonestMiss.claimed}, measured {row.commonestMiss.measured}{' '}
                      <span className="text-xs">(×{row.commonestMiss.count.toLocaleString()})</span>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
