'use client';

import { LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckPanel } from './check-panel';
import { OrderingView } from './ordering-view';
import { ProgressView } from './progress-view';
import { SettingsView } from './settings-view';
import { StreamGroupsView } from './stream-groups-view';
import { StreamSearch } from './stream-search';

type Mode = 'always' | 'never' | 'after_epg_start';
type Tab = 'groups' | 'all' | 'rules' | 'progress' | 'settings';
type ChanFilter = 'all' | 'regex' | 'noregex' | 'nomatch';

interface ChannelRow {
  id: number;
  name: string;
  tvgId: string;
  assigned: number;
  matched: number;
  aliases: string[];
  contains: string[];
  exclude: string[];
  patterns: string[];
  regexCount: number;
  hasRule: boolean;
  /** No rule, but an after-kickoff group: ranked off what the channel carries. */
  assignmentOnly?: boolean;
}

interface PatternRule {
  pattern: string;
  mode: Mode;
}

interface GroupRow {
  id: number;
  name: string;
  mode: Mode;
  fromPattern: boolean;
  channels: number;
  ruled: number;
  matchedChannels: number;
  links: number;
  rows: ChannelRow[];
}

interface StreamRow {
  id: number;
  raw: string;
  normalized: string;
  prefixes: string[];
  quality: { tier: string; codec: string; fps: number };
  provider: string;
  assigned: boolean;
  currentRank: number | null;
  lastProbedAt: number | null;
  lastAlive: boolean | null;
  lastHeight: number | null;
  lastBitrateKbps: number | null;
  lastBlack: boolean | null;
}

interface Preview {
  total: number;
  matched: StreamRow[];
  orphaned: StreamRow[];
  assignedCount: number;
  newlyMatched: number;
  currentOrder: StreamRow[];
}

/** "3m ago" / "2h ago" / "never" -- the question is freshness, not the date. */
function since(ms: number | null): string {
  if (!ms) return 'never probed';
  const s = Math.max(Math.round((Date.now() - ms) / 1000), 0);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const MODES: Array<{ value: Mode; label: string }> = [
  { value: 'always', label: 'Always' },
  { value: 'never', label: 'Never' },
  { value: 'after_epg_start', label: 'After kickoff' },
];

const card = 'rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]';
const pill = 'inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap';
const btn =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-2 text-[15px] hover:border-[var(--color-accent)] disabled:opacity-50';
const rowCls =
  'flex w-full items-center justify-between gap-4 border-b border-[var(--color-line)] px-5 py-4 text-left hover:bg-[var(--color-accent-soft)] active:bg-[var(--color-accent-soft)]';
const chip = (on: boolean) =>
  `rounded-lg border px-3 py-1.5 text-sm ${
    on
      ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white'
      : 'border-[var(--color-line)] text-[var(--color-muted)]'
  }`;

const TAB_LABELS: Record<Tab, string> = {
  groups: 'Groups',
  all: 'All channels',
  rules: 'Name rules',
  progress: 'Progress',
  settings: 'Settings',
};

const lines = (text: string) =>
  text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

export default function Page() {
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [patterns, setPatterns] = useState<PatternRule[]>([]);
  const [streamCount, setStreamCount] = useState(0);
  const [error, setError] = useState<{
    error: string;
    detail?: string;
    hint?: string;
    /** Not configured yet, as opposed to configured and unreachable. */
    needsSetup?: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  const [tab, setTab] = useState<Tab>('groups');
  const [groupId, setGroupId] = useState<number | null>(null);
  const [channelId, setChannelId] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [chanFilter, setChanFilter] = useState<ChanFilter>('all');
  const [showDisabled, setShowDisabled] = useState(false);
  const [patternText, setPatternText] = useState('');
  const [groupFilter, setGroupFilter] = useState('');

  const [aliases, setAliases] = useState('');
  const [contains, setContains] = useState('');
  const [exclude, setExclude] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saved, setSaved] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const resp = await fetch(`/api/state${refresh ? '?refresh=1' : ''}`);
      const text = await resp.text();
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text);
      } catch {
        setError({ error: 'Unreadable response', detail: text.slice(0, 200) });
        return;
      }
      if (!resp.ok || body.error) {
        setError(body as never);
        return;
      }
      setError(null);
      setGroups(body.groups as GroupRow[]);
      setPatterns((body.patterns ?? []) as PatternRule[]);
      setStreamCount(body.streamCount as number);
    } catch (e) {
      setError({ error: 'Podium is not responding', detail: String(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Deep links: every view is addressable, and Back does what it should.
  // Written with the History API rather than the router so that typing in the
  // alias box never triggers a Next navigation.
  const applyUrl = useCallback((params: URLSearchParams) => {
    const t = params.get('tab');
    setTab(t === 'all' || t === 'rules' || t === 'progress' || t === 'settings' ? t : 'groups');
    const g = Number(params.get('group'));
    const c = Number(params.get('channel'));
    setGroupId(Number.isInteger(g) && g > 0 ? g : null);
    setChannelId(Number.isInteger(c) && c > 0 ? c : null);
  }, []);

  useEffect(() => {
    applyUrl(new URLSearchParams(window.location.search));
    const onPop = () => applyUrl(new URLSearchParams(window.location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [applyUrl]);

  const navigate = useCallback(
    (next: { tab?: Tab; group?: number | null; channel?: number | null }) => {
      const params = new URLSearchParams();
      const t = next.tab ?? tab;
      if (t !== 'groups') params.set('tab', t);
      const g = next.group === undefined ? groupId : next.group;
      const c = next.channel === undefined ? channelId : next.channel;
      if (g) params.set('group', String(g));
      if (g && c) params.set('channel', String(c));
      const qs = params.toString();
      window.history.pushState(null, '', qs ? `?${qs}` : window.location.pathname);
      if (next.tab !== undefined) setTab(next.tab);
      if (next.group !== undefined) setGroupId(next.group);
      if (next.channel !== undefined) setChannelId(next.channel);
    },
    [tab, groupId, channelId],
  );

  const group = useMemo(() => groups.find((g) => g.id === groupId) ?? null, [groups, groupId]);
  const channel = useMemo(
    () => group?.rows.find((c) => c.id === channelId) ?? null,
    [group, channelId],
  );

  const visibleGroups = useMemo(() => {
    const base = showDisabled ? groups : groups.filter((g) => g.mode !== 'never');
    const q = groupFilter.trim().toLowerCase();
    return q ? base.filter((g) => g.name.toLowerCase().includes(q)) : base;
  }, [groups, showDisabled, groupFilter]);

  /** Fill the rule boxes from a channel's saved rule. */
  const seededFor = useRef<number | null>(null);
  const seedRules = useCallback((c: ChannelRow) => {
    seededFor.current = c.id;
    setAliases(c.aliases.join('\n'));
    setContains(c.contains.join('\n'));
    setExclude(c.exclude.join('\n'));
    setPreview(null);
  }, []);

  // Arriving by URL rather than by click: the channel id comes from the query
  // string before the state fetch has the row to seed from, so seed as soon as
  // the row shows up. The ref keeps a later refresh -- saving reloads state --
  // from overwriting whatever is in the boxes.
  useEffect(() => {
    if (channelId === null) {
      seededFor.current = null;
      return;
    }
    if (seededFor.current === channelId || !channel) return;
    seedRules(channel);
  }, [channelId, channel, seedRules]);

  const openChannel = (c: ChannelRow, gid?: number) => {
    navigate({ group: gid ?? groupId, channel: c.id });
    seedRules(c);
  };

  const runPreview = useCallback(async () => {
    if (channelId === null) return;
    setPreviewing(true);
    try {
      const resp = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelId,
          aliases: lines(aliases),
          contains: lines(contains),
          exclude: lines(exclude),
        }),
      });
      if (resp.ok) setPreview((await resp.json()) as Preview);
    } finally {
      setPreviewing(false);
    }
  }, [channelId, aliases, contains, exclude]);

  useEffect(() => {
    if (channelId === null) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void runPreview(), 200);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [channelId, runPreview]);

  const save = async () => {
    if (channelId === null) return;
    const resp = await fetch(`/api/rules/${channelId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aliases: lines(aliases),
        contains: lines(contains),
        exclude: lines(exclude),
      }),
    });
    setSaved(resp.ok ? 'Saved' : 'Save failed');
    setTimeout(() => setSaved(''), 1800);
    if (resp.ok) await load();
  };

  const dropRegex = async () => {
    if (channelId === null) return;
    await fetch(`/api/rules/${channelId}/patterns`, { method: 'DELETE' });
    await load();
    void runPreview();
  };

  const setMode = async (id: number, mode: Mode) => {
    await fetch(`/api/groups/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    await load();
  };

  const savePattern = async (mode: Mode) => {
    const pattern = patternText.trim();
    if (!pattern) return;
    await fetch('/api/group-patterns', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern, mode }),
    });
    setPatternText('');
    await load();
  };

  const dropPattern = async (pattern: string) => {
    await fetch(`/api/group-patterns?pattern=${encodeURIComponent(pattern)}`, { method: 'DELETE' });
    await load();
  };

  /** One click from "this stream is unclaimed" to "this stream is an alias". */
  const addAlias = (name: string) => {
    const current = lines(aliases);
    if (!current.some((a) => a.toLowerCase() === name.toLowerCase())) {
      setAliases([...current, name].join('\n'));
    }
  };

  const addContains = (needle: string) => {
    const current = lines(contains);
    if (!current.some((c) => c.toLowerCase() === needle.toLowerCase())) {
      setContains([...current, needle].join('\n'));
    }
  };

  const allChannels = useMemo(() => {
    const out: Array<ChannelRow & { groupName: string; groupId: number; groupMode: Mode }> = [];
    for (const g of groups) {
      if (!showDisabled && g.mode === 'never') continue;
      for (const c of g.rows) {
        out.push({ ...c, groupName: g.name, groupId: g.id, groupMode: g.mode });
      }
    }
    return out
      .filter((c) => {
        if (chanFilter === 'regex') return c.regexCount > 0;
        if (chanFilter === 'noregex') return c.regexCount === 0;
        if (chanFilter === 'nomatch')
          return c.groupMode !== 'never' && c.hasRule && c.matched === 0;
        return true;
      })
      .filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [groups, chanFilter, filter, showDisabled]);

  const totals = useMemo(() => {
    const active = groups.filter((g) => g.mode !== 'never');
    return {
      managed: active.reduce((n, g) => n + g.ruled, 0),
      excluded: groups.filter((g) => g.mode === 'never').reduce((n, g) => n + g.channels, 0),
      gaps: active.reduce(
        (n, g) => n + g.rows.filter((c) => c.hasRule && c.matched === 0).length,
        0,
      ),
      regex: active.reduce((n, g) => n + g.rows.filter((c) => c.regexCount > 0).length, 0),
    };
  }, [groups]);

  const unifiedRows = useMemo(() => {
    if (!preview) return [];
    const assigned = preview.currentOrder;
    const assignedIds = new Set(assigned.map((r) => r.id));
    const newStreams = preview.matched.filter((r) => !assignedIds.has(r.id));
    return [...assigned, ...newStreams];
  }, [preview]);

  const orphanedIds = useMemo(() => {
    if (!preview) return new Set<number>();
    return new Set(preview.orphaned.map((r) => r.id));
  }, [preview]);

  // Every reason this fails is fixed in Settings -- a missing credential, a
  // wrong URL, a Dispatcharr that moved -- so the settings form is part of the
  // error screen rather than behind a tab bar this early return skips. Without
  // it, clearing the environment variables to use the UI left an error card
  // whose only button was a Retry that could never succeed.
  if (error) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <div className={`${card} ${error.needsSetup ? '' : 'border-[var(--color-bad)]'} p-6`}>
          <h2
            className={`text-lg font-semibold ${error.needsSetup ? '' : 'text-[var(--color-bad)]'}`}
          >
            {error.error}
          </h2>
          <p className="mt-2 text-[var(--color-muted)]">{error.detail || error.hint}</p>
          {error.detail && error.hint && (
            <p className="mt-1 text-sm text-[var(--color-muted)]">{error.hint}</p>
          )}
          <button type="button" className={`${btn} mt-4`} onClick={() => void load()}>
            {error.needsSetup ? 'Continue' : 'Retry'}
          </button>
        </div>
        <div className="mt-4">
          <SettingsView />
        </div>
      </main>
    );
  }

  // First load fetches every channel and stream from Dispatcharr, which is
  // seconds on a real install. Without this the page renders its own empty
  // state -- "0 managed, 0 groups" -- which reads as a broken install rather
  // than one that has not finished loading.
  //
  // Progress and Settings read the database, not Dispatcharr, so they are held
  // up by nothing: making them wait on the channel list meant the page you
  // open to ask "is the worker alive" was the slowest one to appear.
  if (loading && groups.length === 0 && tab !== 'progress' && tab !== 'settings') {
    return (
      <main className="mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center gap-4 p-8">
        <LoaderCircle
          className="h-8 w-8 animate-spin text-[var(--color-accent)]"
          aria-hidden="true"
        />
        <p role="status" className="text-[var(--color-muted)]">
          Loading channels from Dispatcharr…
        </p>
      </main>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col">
      <header className="sticky top-0 z-10 border-b border-[var(--color-line)] bg-[var(--color-panel)] px-5 py-3">
        <div className="flex items-center gap-3">
          {/* Breadcrumb doubles as the back control -- no separate back button
              to miss on a phone. */}
          <nav className="flex min-w-0 flex-1 items-center gap-2 text-[15px]">
            <button
              type="button"
              onClick={() => navigate({ tab: 'groups', group: null, channel: null })}
              className={groupId === null ? 'font-semibold' : 'text-[var(--color-accent)]'}
            >
              Podium
            </button>
            {group && (
              <>
                <span className="text-[var(--color-muted)]">/</span>
                <button
                  type="button"
                  onClick={() => navigate({ channel: null })}
                  className={`min-w-0 truncate ${
                    channel ? 'text-[var(--color-accent)]' : 'font-semibold'
                  }`}
                >
                  {group.name}
                </button>
              </>
            )}
            {channel && (
              <>
                <span className="text-[var(--color-muted)]">/</span>
                <span className="min-w-0 truncate font-semibold">{channel.name}</span>
              </>
            )}
          </nav>
          <button
            type="button"
            className={`${btn} flex items-center gap-2`}
            disabled={loading}
            onClick={() => void load(true)}
          >
            {loading && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {loading ? 'Refreshing' : 'Refresh'}
          </button>
        </div>
        {!group && (
          <p className="mt-1.5 text-sm tabular-nums text-[var(--color-muted)]">
            {totals.managed} managed · {totals.excluded} excluded · {totals.gaps} with no match ·{' '}
            {totals.regex} on regex · {streamCount.toLocaleString()} streams
          </p>
        )}
      </header>

      <main className="flex-1">
        {!group && (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-panel)] px-5 py-3">
              {(['groups', 'all', 'rules', 'progress', 'settings'] as const).map((t) => (
                <button
                  type="button"
                  key={t}
                  onClick={() => navigate({ tab: t })}
                  className={chip(tab === t)}
                >
                  {TAB_LABELS[t]}
                </button>
              ))}
              {(tab === 'groups' || tab === 'all') && (
                <>
                  <span className="flex-1" />
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--color-muted)]">
                    <input
                      type="checkbox"
                      checked={showDisabled}
                      onChange={(e) => setShowDisabled(e.target.checked)}
                      className="h-4 w-4 accent-[var(--color-accent)]"
                    />
                    Show disabled
                  </label>
                </>
              )}
            </div>

            {tab === 'progress' && <ProgressView />}

            {tab === 'settings' && (
              <>
                <SettingsView />
                <div className="mt-4">
                  <OrderingView />
                </div>
                {/* Which provider streams are candidates at all sits with the
                    rest of the global config, not on any one channel. */}
                <div className="mt-4">
                  <StreamGroupsView />
                </div>
              </>
            )}

            {tab === 'groups' && (
              <>
                <div className="border-b border-[var(--color-line)] bg-[var(--color-panel)] p-4">
                  <input
                    value={groupFilter}
                    onChange={(e) => setGroupFilter(e.target.value)}
                    placeholder="Filter groups…"
                    className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
                  />
                  <p className="mt-2 text-sm tabular-nums text-[var(--color-muted)]">
                    {visibleGroups.length} groups
                  </p>
                </div>
                <ul>
                  {visibleGroups.map((g) => (
                    <li key={g.id}>
                      <button
                        type="button"
                        className={rowCls}
                        onClick={() => navigate({ group: g.id, channel: null })}
                      >
                        <span className="min-w-0">
                          <span
                            className={`block truncate text-[16px] ${
                              g.mode === 'never' ? 'text-[var(--color-muted)] line-through' : ''
                            }`}
                          >
                            {g.name}
                          </span>
                          <span className="text-sm tabular-nums text-[var(--color-muted)]">
                            {g.ruled}/{g.channels} ruled · {g.links} links
                            {g.mode !== 'never' && g.ruled - g.matchedChannels > 0
                              ? ` · ${g.ruled - g.matchedChannels} no match`
                              : ''}
                          </span>
                        </span>
                        <span className="flex flex-none items-center gap-2">
                          {g.mode !== 'always' && (
                            <span
                              className={`${pill} ${
                                g.mode === 'never'
                                  ? 'bg-[var(--color-line)] text-[var(--color-muted)]'
                                  : 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                              }`}
                            >
                              {g.mode === 'never' ? 'never' : 'kickoff'}
                              {g.fromPattern ? ' *' : ''}
                            </span>
                          )}
                          <span className="text-[var(--color-muted)]">›</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {tab === 'rules' && (
              <div className="p-5">
                <div className={`${card} p-5`}>
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                    Name rules
                  </h3>
                  <p className="mt-1.5 text-sm text-[var(--color-muted)]">
                    Match group names with <code>*</code>, e.g. <code>Auto | *</code>. Also applies
                    to groups Dispatcharr creates later, which a fixed list would miss. An explicit
                    per-group setting always wins.
                  </p>
                  {patterns.map((p) => (
                    <div key={p.pattern} className="mt-3 flex items-center gap-3">
                      <code className="mono min-w-0 flex-1 truncate">{p.pattern}</code>
                      <span className={`${pill} bg-[var(--color-line)] text-[var(--color-muted)]`}>
                        {p.mode === 'never' ? 'never' : 'after kickoff'}
                      </span>
                      <button
                        type="button"
                        className={`${btn} px-3 py-1.5 text-sm`}
                        onClick={() => void dropPattern(p.pattern)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <input
                      value={patternText}
                      onChange={(e) => setPatternText(e.target.value)}
                      placeholder="Auto | *"
                      className="mono min-w-0 flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
                    />
                    <button type="button" className={btn} onClick={() => void savePattern('never')}>
                      Never
                    </button>
                    <button
                      type="button"
                      className={btn}
                      onClick={() => void savePattern('after_epg_start')}
                    >
                      After kickoff
                    </button>
                  </div>
                </div>
              </div>
            )}

            {tab === 'all' && (
              <>
                <div className="border-b border-[var(--color-line)] bg-[var(--color-panel)] p-4">
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        ['all', 'All'],
                        ['noregex', 'No regex'],
                        ['regex', 'On regex'],
                        ['nomatch', 'No match'],
                      ] as const
                    ).map(([v, label]) => (
                      <button
                        type="button"
                        key={v}
                        onClick={() => setChanFilter(v)}
                        className={chip(chanFilter === v)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter channels…"
                    className="mt-3 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
                  />
                  <p className="mt-2 text-sm tabular-nums text-[var(--color-muted)]">
                    {allChannels.length} channels
                  </p>
                </div>
                <ul>
                  {allChannels.slice(0, 500).map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className={rowCls}
                        onClick={() => openChannel(c, c.groupId)}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[16px]">
                            {c.name || '(unnamed)'}
                          </span>
                          <span className="text-sm tabular-nums text-[var(--color-muted)]">
                            {c.groupName} · {c.assigned} assigned · {c.matched} matched
                            {c.regexCount > 0 ? ` · ${c.regexCount} regex` : ''}
                          </span>
                        </span>
                        <span className="flex flex-none items-center gap-2">
                          {c.groupMode !== 'never' && c.hasRule && c.matched === 0 && (
                            <span className={`${pill} bg-[var(--color-bad)] text-white`}>0</span>
                          )}
                          {c.regexCount > 0 && (
                            <span className={`${pill} text-[var(--color-warn)]`}>rx</span>
                          )}
                          <span className="text-[var(--color-muted)]">›</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        {group && !channel && (
          <>
            <div className="border-b border-[var(--color-line)] bg-[var(--color-accent-soft)] px-5 py-4">
              <button
                type="button"
                onClick={() => navigate({ group: null, channel: null })}
                className="text-sm text-[var(--color-accent)]"
              >
                ‹ All groups
              </button>
              <h2 className="mt-1 text-xl font-semibold">{group.name}</h2>
              <p className="text-sm tabular-nums text-[var(--color-muted)]">
                {group.ruled}/{group.channels} channels ruled · {group.links} stream links
                {group.ruled - group.matchedChannels > 0
                  ? ` · ${group.ruled - group.matchedChannels} with no match`
                  : ''}
              </p>
            </div>
            <div className="border-b border-[var(--color-line)] bg-[var(--color-panel)] p-4">
              <div className="flex flex-wrap gap-2">
                {MODES.map((m) => (
                  <button
                    type="button"
                    key={m.value}
                    onClick={() => void setMode(group.id, m.value)}
                    className={chip(group.mode === m.value)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              {group.fromPattern && (
                <p className="mt-2 text-sm text-[var(--color-muted)]">
                  Currently set by a name rule. Choosing here pins this group explicitly.
                </p>
              )}
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter channels…"
                className="mt-3 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
              />
            </div>
            <ul>
              {group.rows
                .filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()))
                .map((c) => (
                  <li key={c.id}>
                    <button type="button" className={rowCls} onClick={() => openChannel(c)}>
                      <span className="min-w-0">
                        <span className="block truncate text-[16px]">{c.name || '(unnamed)'}</span>
                        <span className="text-sm tabular-nums text-[var(--color-muted)]">
                          {c.assigned} assigned · {c.matched} matched
                          {c.regexCount > 0 ? ` · ${c.regexCount} regex` : ''}
                          {c.assignmentOnly ? ' · assigned only' : !c.hasRule ? ' · no rule' : ''}
                        </span>
                      </span>
                      <span className="flex flex-none items-center gap-2">
                        {c.hasRule && c.matched === 0 && (
                          <span className={`${pill} bg-[var(--color-bad)] text-white`}>0</span>
                        )}
                        {c.regexCount > 0 && (
                          <span className={`${pill} text-[var(--color-warn)]`}>rx</span>
                        )}
                        <span className="text-[var(--color-muted)]">›</span>
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
          </>
        )}

        {channel && (
          <div className="p-5">
            <p className="mb-4 text-sm text-[var(--color-muted)]">
              channel {channel.id}
              {channel.tvgId ? ` · ${channel.tvgId}` : ''} · {channel.assigned} assigned in
              Dispatcharr
              {group?.mode === 'never' ? ' · group excluded from checking' : ''}
            </p>

            {/* Aliases and their live result sit together: the whole point is
                watching the match set change as you type. */}
            <div className={`${card} mt-4 p-5`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                  Aliases
                </h3>
                <span className="text-sm tabular-nums text-[var(--color-muted)]">
                  {previewing ? (
                    'matching…'
                  ) : preview ? (
                    <>
                      <b
                        className={
                          preview.total === 0
                            ? 'text-[var(--color-bad)]'
                            : 'text-[var(--color-accent)]'
                        }
                      >
                        {preview.total}
                      </b>{' '}
                      matched · {preview.newlyMatched} new · {preview.orphaned.length} unclaimed
                    </>
                  ) : (
                    '—'
                  )}
                </span>
              </div>
              <textarea
                value={aliases}
                onChange={(e) => setAliases(e.target.value)}
                rows={4}
                className="mono mt-3 w-full resize-y rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] p-3 outline-none focus:border-[var(--color-accent)]"
              />
              <p className="mt-2 text-sm text-[var(--color-muted)]">
                One per line. Casing, accents, “USA:” prefixes and “FHD H265” suffixes are handled
                for you. Order = preference. Matches update as you type.
              </p>
              <p className="mt-1.5 text-sm text-[var(--color-muted)]">
                Prefix it with <code className="mono">@AU</code> to take only that region’s feed, or{' '}
                <code className="mono">@!Prime</code> to keep one out.
              </p>
              <p className="mt-1.5 text-sm text-[var(--color-muted)]">
                Suffix it with <code className="mono">~4K</code> to take only that variant, or{' '}
                <code className="mono">~!4K</code> to keep it out —{' '}
                <code className="mono">~1080p</code>, <code className="mono">~hevc</code>,{' '}
                <code className="mono">~60fps</code> and <code className="mono">~raw</code> work the
                same. Both ends combine: <code className="mono">@AU CNN ~4K</code>.
              </p>
              {preview && unifiedRows.length > 0 && (
                <StreamList
                  title={`Live ordering & Matched (${unifiedRows.length})`}
                  hint="Shows the current order in Dispatcharr, followed by newly matched streams. Unmatched streams are highlighted."
                  rows={unifiedRows}
                  tone="normal"
                  flush
                  orphanedIds={orphanedIds}
                  onAdd={addAlias}
                />
              )}
            </div>

            <CheckPanel channelId={channel.id} onApplied={() => void load(true)} />

            <div className="mt-4">
              <StreamSearch onAdd={addAlias} onAddContains={addContains} />
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Editor
                title="Contains"
                hint="Whole-word substring, for a call sign buried in a longer name. Looser than an alias — prefer an alias when one works."
                value={contains}
                onChange={setContains}
              />
              <Editor
                title="Exclude"
                hint="Reject these even if an alias matches. A name, or a tail token to drop one variant — 4K, HEVC, 1080p, RAW."
                value={exclude}
                onChange={setExclude}
              />
            </div>

            {channel.regexCount > 0 && (
              <div className={`${card} mt-4 border-[var(--color-warn)] p-5`}>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-warn)]">
                  Legacy regex ({channel.regexCount})
                </h3>
                <p className="mt-1.5 text-sm text-[var(--color-muted)]">
                  Imported from an older rule set and still active. Once the aliases above cover the
                  same streams, remove it.
                </p>
                {channel.patterns.map((p) => (
                  <pre
                    key={p}
                    className="mono mt-3 overflow-x-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] p-3 text-xs"
                  >
                    {p}
                  </pre>
                ))}
                <button type="button" className={`${btn} mt-3`} onClick={() => void dropRegex()}>
                  Remove regex
                </button>
              </div>
            )}

            <div className="sticky bottom-0 mt-4 flex items-center gap-4 border-t border-[var(--color-line)] bg-[var(--color-panel)] py-3">
              <button
                type="button"
                className={`${btn} border-[var(--color-accent)] bg-[var(--color-accent)] text-white`}
                onClick={() => void save()}
              >
                Save
              </button>
              <span className="text-[var(--color-accent)]">{saved}</span>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function Editor({
  title,
  hint,
  value,
  onChange,
}: {
  title: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className={`${card} p-5`}>
      <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        {title}
      </h3>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="mono mt-3 w-full resize-y rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] p-3 outline-none focus:border-[var(--color-accent)]"
      />
      <p className="mt-2 text-sm text-[var(--color-muted)]">{hint}</p>
    </div>
  );
}

function StreamList({
  title,
  hint,
  rows,
  tone,
  onAdd,
  flush,
  orphanedIds,
}: {
  title: string;
  hint?: string;
  rows: StreamRow[];
  tone: 'normal' | 'warn';
  onAdd?: (name: string) => void;
  flush?: boolean;
  orphanedIds?: Set<number>;
}) {
  return (
    <div
      className={
        flush
          ? 'mt-4 border-t border-[var(--color-line)] pt-3'
          : `${card} mt-4 p-5 ${tone === 'warn' ? 'border-[var(--color-warn)]' : ''}`
      }
    >
      <h3
        className={`text-sm font-semibold uppercase tracking-wide ${
          tone === 'warn' ? 'text-[var(--color-warn)]' : 'text-[var(--color-muted)]'
        }`}
      >
        {title}
      </h3>
      {hint && <p className="mt-1.5 text-sm text-[var(--color-muted)]">{hint}</p>}
      <ul className="mt-2 max-h-[420px] overflow-y-auto">
        {rows.length === 0 ? (
          <li className="py-3 text-[var(--color-muted)]">Nothing here yet.</li>
        ) : (
          rows.map((r) => {
            const orphaned = orphanedIds?.has(r.id);
            return (
              <li
                key={r.id}
                className="flex flex-wrap items-start gap-3 border-b border-[var(--color-line)] py-3 last:border-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="mono block break-all text-sm">{r.raw}</span>
                  <span className="mt-1 block text-sm text-[var(--color-muted)]">
                    {r.prefixes.map((p) => (
                      <span key={p} className={`${pill} mr-1 border border-[var(--color-line)]`}>
                        {p}
                      </span>
                    ))}
                    <b className="text-[var(--color-ink)]">{r.normalized}</b> · {r.provider}
                    {[r.quality.tier?.toUpperCase(), r.quality.codec, r.quality.fps || null]
                      .filter(Boolean)
                      .map((q) => ` · ${q}`)
                      .join('')}
                    {r.currentRank
                      ? ` · currently #${r.currentRank}`
                      : r.assigned
                        ? ' · assigned'
                        : ' · new'}
                    {orphaned && (
                      <span className="ml-2 font-semibold text-[var(--color-bad)]">
                        NOT MATCHED
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-sm">
                    {r.lastProbedAt ? (
                      <>
                        <span
                          className={
                            r.lastBlack
                              ? 'text-[var(--color-bad)]'
                              : r.lastAlive
                                ? 'text-[var(--color-accent)]'
                                : 'text-[var(--color-bad)]'
                          }
                        >
                          {r.lastBlack ? 'black screen' : r.lastAlive ? 'live' : 'dead'}
                        </span>
                        <span className="text-[var(--color-muted)]">
                          {r.lastAlive && !r.lastBlack && r.lastHeight
                            ? ` · ${r.lastHeight}p · ${Math.round(r.lastBitrateKbps ?? 0)}kbps`
                            : ''}
                          {` · checked ${since(r.lastProbedAt)}`}
                        </span>
                      </>
                    ) : (
                      <span className="text-[var(--color-muted)]">never probed</span>
                    )}
                  </span>
                </span>
                {onAdd && orphaned && (
                  <button
                    type="button"
                    className={`${btn} flex-none px-3 py-1.5 text-sm`}
                    onClick={() => onAdd(r.normalized)}
                  >
                    + alias
                  </button>
                )}
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
