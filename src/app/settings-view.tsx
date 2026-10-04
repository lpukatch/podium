'use client';

import { useCallback, useEffect, useState } from 'react';
import { VERSION } from '@/lib/version';

interface Field {
  key: string;
  kind: 'string' | 'secret' | 'boolean' | 'number';
  label: string;
  help: string;
  more?: string;
  section: 'dispatcharr' | 'behaviour' | 'probing' | 'quality' | 'teamarr';
  value: string;
  isSet: boolean;
  source: 'stored' | 'environment' | 'default';
  defaultValue: string;
  min?: number;
  max?: number;
}

type SectionId = 'connection' | 'automation' | 'measurement' | 'learning';

const SECTIONS: Array<{
  id: SectionId;
  sources: Field['section'][];
  title: string;
  blurb: string;
}> = [
  {
    id: 'connection',
    sources: ['dispatcharr'],
    title: 'Connect to Dispatcharr',
    blurb: 'Set the server address and sign-in details Podium uses.',
  },
  {
    id: 'automation',
    sources: ['behaviour'],
    title: 'Automation',
    blurb: 'Choose what Podium can change and when it does the work.',
  },
  {
    id: 'measurement',
    sources: ['probing'],
    title: 'Measure streams',
    blurb: 'Control how Podium checks playback and detects failures.',
  },
  {
    id: 'learning',
    sources: ['quality', 'teamarr'],
    title: 'Learn & export',
    blurb: 'Choose which results shape learned rules, then send those rules to Teamarr.',
  },
];

// Keep the field schema as the source of truth for labels, help and validation.
// These groups only decide how to scan the form; any newly added field falls
// into "Other settings" rather than disappearing or landing in the wrong group.
const GROUPS: Record<
  SectionId,
  Array<{ title: string; description: string; keys?: string[]; advanced?: boolean }>
> = {
  connection: [
    { title: 'Server', description: 'The address Podium connects to.', keys: ['DISPATCHARR_URL'] },
    {
      title: 'Sign in',
      description: 'Use an API key, or a username and password.',
      keys: ['DISPATCHARR_API_KEY', 'DISPATCHARR_USERNAME', 'DISPATCHARR_PASSWORD'],
    },
  ],
  automation: [
    {
      title: 'Changes to channels',
      description: 'Start in dry run to preview changes before Podium writes them.',
      keys: [
        'PODIUM_DRY_RUN',
        'PODIUM_AUTO_ASSIGN',
        'PODIUM_AUTO_ASSIGN_MAX',
        'PODIUM_AUTO_ASSIGN_MAX_PER_PROVIDER',
        'PODIUM_AUTO_ASSIGN_PRUNE_PER_PROVIDER',
        'PODIUM_REMOVE_UNMATCHED',
        'PODIUM_REMOVE_UNMATCHED_AFTER_MS',
        'PODIUM_REMOVE_DEAD_AFTER_CHECKS',
        'PODIUM_WRITE_STATS',
      ],
    },
    {
      title: 'While someone is watching',
      description: 'Protect viewing sessions from competing probes.',
      keys: [
        'PODIUM_PAUSE_WHEN_WATCHING',
        'PODIUM_PROBE_IDLE_PROVIDERS',
        'PODIUM_PROBE_WATCHED_PROVIDER',
        'PODIUM_WATCHED_FREE_SLOTS',
      ],
    },
    {
      title: 'Timing & cached results',
      description: 'Adjust how often Podium works and when a result needs checking again.',
      keys: [
        'PODIUM_MAX_AGE_MS',
        'PODIUM_TICK_MS',
        'PODIUM_IDLE_MAX_MS',
        'PODIUM_EPG_TTL_MS',
        'PODIUM_LIVE_TTL_MS',
        'PODIUM_DEAD_TTL_MS',
        'PODIUM_DEAD_TTL_MAX_MS',
        'PODIUM_UNKNOWN_BITRATE_TTL_MS',
        'PODIUM_MAX_SLICE',
      ],
      advanced: true,
    },
  ],
  measurement: [
    {
      title: 'Quick checks',
      description: 'Set the workload and decide what counts as a working stream.',
      keys: [
        'PODIUM_MAX_CONCURRENT_PROBES',
        'PODIUM_MIN_BITRATE_KBPS',
        'PODIUM_DETECT_BLACK',
        'PODIUM_ANALYZE_SECONDS',
      ],
    },
    {
      title: 'How to connect to streams',
      description: 'Choose whether checks use the provider directly or go through Dispatcharr.',
      keys: [
        'PODIUM_PROBE_VIA_DISPATCHARR',
        'PODIUM_DIRECT_PROFILE_USER_AGENT',
        'PODIUM_SOAK_VIA_DISPATCHARR',
        'PODIUM_PROBE_CLIENT_USER_AGENT',
      ],
      advanced: true,
    },
    {
      title: 'Stability & long checks',
      description: 'Find streams that fail after they start playing.',
      keys: [
        'PODIUM_STABILITY',
        'PODIUM_STABILITY_POLL_MS',
        'PODIUM_SOAK_WINDOW',
        'PODIUM_SOAK_SECONDS',
        'PODIUM_SOAK_MAX_PER_CHANNEL',
        'PODIUM_SOAK_MAX_AGE_MS',
        'PODIUM_SOAK_COOLDOWN_MS',
        'PODIUM_SOAK_SPARE_SLOTS',
      ],
      advanced: true,
    },
  ],
  learning: [
    {
      title: 'Which results to learn from',
      description: 'Limit the samples used to fit quality rules. Excluded history is kept.',
      keys: [
        'PODIUM_QUALITY_EVENT_ONLY',
        'PODIUM_QUALITY_INCLUDE_GROUPS',
        'PODIUM_QUALITY_EXCLUDE_GROUPS',
      ],
    },
    {
      title: 'Send rules to Teamarr',
      description: 'Set a destination and choose manual or scheduled pushes.',
      keys: ['PODIUM_TEAMARR_URL', 'PODIUM_TEAMARR_SYNC', 'PODIUM_TEAMARR_SYNC_MS'],
    },
    {
      title: 'Before a scheduled push',
      description: 'Require enough samples and channels before sending new rules.',
      keys: ['PODIUM_TEAMARR_MIN_SAMPLES', 'PODIUM_TEAMARR_MIN_CHANNELS'],
      advanced: true,
    },
  ],
};

const card = 'rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]';
const btn =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-2 text-[15px] hover:border-[var(--color-accent)] disabled:opacity-50';
const pill = 'inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap';
const input =
  'w-full max-w-xl rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 outline-none focus:border-[var(--color-accent)]';

function groupedRows(section: SectionId, rows: Field[]) {
  const remaining = [...rows];
  const groups = GROUPS[section].map((group) => {
    const selected =
      group.keys?.flatMap((key) => remaining.filter((field) => field.key === key)) ?? [];
    for (const field of selected) remaining.splice(remaining.indexOf(field), 1);
    return { ...group, rows: selected };
  });
  if (remaining.length)
    groups.push({ title: 'Other settings', description: 'Additional options.', rows: remaining });
  return groups;
}

export function SettingsView() {
  const [fields, setFields] = useState<Field[]>([]);
  const [effective, setEffective] = useState<{ dryRun: boolean; hasCredentials: boolean } | null>(
    null,
  );
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [teamarrTest, setTeamarrTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const load = useCallback(async () => {
    try {
      const resp = await fetch('/api/settings');
      const body = await resp.json();
      if (!resp.ok || body.error) {
        setError(body.error ?? `HTTP ${resp.status}`);
        return;
      }
      setError('');
      setFields(body.fields as Field[]);
      setEffective(body.effective);
      setEdits({});
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const currentValue = (f: Field): string => edits[f.key] ?? (f.kind === 'secret' ? '' : f.value);
  /**
   * A checkbox has no placeholder to fall back on, so an unset boolean has to
   * render its effective default or the form states the opposite of the truth
   * -- "pause while anyone is watching" showed as off while it was on.
   */
  const checkedValue = (f: Field): boolean =>
    (edits[f.key] ?? (f.value || f.defaultValue)) === 'true';
  const dirty = Object.keys(edits).length > 0;

  const save = async () => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const resp = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edits),
      });
      const body = await resp.json();
      if (!resp.ok || body.error) {
        setError(
          body.errors
            ?.map((e: { key: string; message: string }) => `${e.key}: ${e.message}`)
            .join('; ') ??
            body.error ??
            `HTTP ${resp.status}`,
        );
        return;
      }
      setFields(body.fields as Field[]);
      setEdits({});
      setNote('Saved — the worker picks this up on its next pass.');
      setTimeout(() => setNote(''), 4000);
      void load();
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      const resp = await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edits),
      });
      const body = await resp.json();
      setTest(
        body.ok
          ? {
              ok: true,
              text: `Connected. ${body.providers.length} provider(s): ${body.providers
                .map((p: { name: string; maxStreams: number }) => `${p.name} (${p.maxStreams})`)
                .join(', ')}`,
            }
          : { ok: false, text: body.error ?? 'failed' },
      );
    } catch (e) {
      setTest({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const runTeamarrTest = async () => {
    setBusy(true);
    setTeamarrTest(null);
    try {
      const resp = await fetch('/api/teamarr-sync/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edits),
      });
      const body = await resp.json();
      if (!body.ok) {
        setTeamarrTest({ ok: false, text: body.error ?? 'failed' });
        return;
      }

      const types = Object.entries(body.byType as Record<string, number>)
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => `${count} ${type}`)
        .join(', ');
      // The rule count and breakdown are the part that proves it reached the
      // right instance: anything can answer, only Teamarr answers with these.
      let text = `Connected. ${body.total} rule(s) — ${types}.`;
      if (body.neverPushed) {
        text += ' Podium has not pushed here yet.';
      } else if (body.drift) {
        text += ` Since Podium's last push: ${body.drift}.`;
      } else {
        const when = body.lastPushedAt ? new Date(body.lastPushedAt).toLocaleString() : 'unknown';
        text += ` Exactly what Podium pushed on ${when}.`;
      }
      setTeamarrTest({ ok: true, text });
    } catch (e) {
      setTeamarrTest({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const runReset = async () => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const resp = await fetch('/api/state/reset', { method: 'POST' });
      const body = await resp.json();
      if (!resp.ok || body.error) {
        setError(body.error ?? `HTTP ${resp.status}`);
        return;
      }
      setNote('Cache and history have been cleared.');
      setShowResetConfirm(false);
      setTimeout(() => setNote(''), 4000);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && fields.length === 0) {
    return (
      <div className={`${card} m-5 border-[var(--color-bad)] p-5`}>
        <h3 className="font-semibold text-[var(--color-bad)]">Cannot read settings</h3>
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">{error}</p>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-5">
        <h2 className="text-xl font-semibold tracking-tight">
          How Podium runs
          <span className="ml-2 align-middle text-sm font-normal tabular-nums text-[var(--color-muted)]">
            v{VERSION}
          </span>
        </h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Connect services, choose what changes automatically, and tune how streams are measured.
        </p>
      </div>
      {effective && (
        <div className={`${card} mb-5 flex flex-wrap items-center gap-3 p-4`}>
          <span
            className={`${pill} ${
              effective.dryRun
                ? 'bg-[var(--color-warn)] text-[var(--color-on-warn)]'
                : 'bg-[var(--color-accent-solid)] text-[var(--color-on-accent)]'
            }`}
          >
            {effective.dryRun ? 'dry run — not writing' : 'live — writing to Dispatcharr'}
          </span>
          {!effective.hasCredentials && (
            <span className={`${pill} bg-[var(--color-bad)] text-[var(--color-on-bad)]`}>
              no credentials set
            </span>
          )}
          <span className="text-sm text-[var(--color-muted)] sm:ml-auto">
            Changes apply on the next pass; no restart needed.
          </span>
        </div>
      )}

      <div>
        <nav aria-label="Settings sections" className={`${card} mb-5 p-3`}>
          <p className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            On this page
          </p>
          <div className="no-scrollbar flex gap-2 overflow-x-auto">
            {SECTIONS.map((section) => (
              <a
                key={section.id}
                href={`#settings-${section.id}`}
                className="shrink-0 rounded-md px-2 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
              >
                {section.id === 'connection' ? 'Connection' : section.title}
              </a>
            ))}
            <a
              href="#settings-reset"
              className="shrink-0 rounded-md px-2 py-1.5 text-sm text-[var(--color-bad)] hover:bg-[var(--color-canvas)] focus-visible:outline-2 focus-visible:outline-[var(--color-bad)]"
            >
              Reset data
            </a>
          </div>
        </nav>
        <div className="min-w-0">
          {SECTIONS.map((section) => {
            const rows = fields.filter((f) => section.sources.includes(f.section));
            if (rows.length === 0) return null;
            return (
              <section
                id={`settings-${section.id}`}
                key={section.id}
                className={`${card} mb-5 scroll-mt-4 p-4 sm:p-6`}
                aria-labelledby={`settings-${section.id}-title`}
              >
                <h3
                  id={`settings-${section.id}-title`}
                  className="text-lg font-semibold tracking-tight"
                >
                  {section.title}
                </h3>
                <p className="mt-1 max-w-[70ch] text-sm text-[var(--color-muted)]">
                  {section.blurb}
                </p>

                <div className="mt-5 space-y-6">
                  {groupedRows(section.id, rows)
                    .filter((group) => group.rows.length > 0)
                    .map((group) => {
                      const controls = group.rows.map((f) => (
                        <div
                          key={f.key}
                          className="border-t border-[var(--color-line)] pt-4 first:border-0 first:pt-0"
                        >
                          <label className="block">
                            <span className="flex flex-wrap items-baseline gap-2">
                              <span className="font-medium">{f.label}</span>
                              {f.source === 'environment' && (
                                <span
                                  className={`${pill} bg-[var(--color-line)] text-[var(--color-muted)]`}
                                >
                                  from environment
                                </span>
                              )}
                              {f.source === 'stored' && (
                                <span
                                  className={`${pill} bg-[var(--color-accent-soft)] text-[var(--color-accent)]`}
                                >
                                  custom
                                </span>
                              )}
                              {f.kind === 'secret' && f.isSet && (
                                <span
                                  className={`${pill} bg-[var(--color-accent-soft)] text-[var(--color-accent)]`}
                                >
                                  set
                                </span>
                              )}
                            </span>

                            {f.kind === 'boolean' ? (
                              <span className="mt-2 flex items-start gap-3">
                                <input
                                  type="checkbox"
                                  className="contrast-checkbox mt-1 h-4 w-4 shrink-0"
                                  checked={checkedValue(f)}
                                  onChange={(e) =>
                                    setEdits({
                                      ...edits,
                                      [f.key]: e.target.checked ? 'true' : 'false',
                                    })
                                  }
                                />
                                <span className="max-w-[70ch] text-sm text-[var(--color-muted)]">
                                  {f.help}
                                </span>
                              </span>
                            ) : (
                              <>
                                <input
                                  className={`${input} mt-2`}
                                  type={f.kind === 'secret' ? 'password' : 'text'}
                                  inputMode={f.kind === 'number' ? 'numeric' : undefined}
                                  value={currentValue(f)}
                                  // A blank box with no hint of what it falls back to is
                                  // why "what is this actually set to?" was unanswerable.
                                  placeholder={
                                    f.kind === 'secret' && f.isSet
                                      ? 'unchanged — type to replace'
                                      : f.defaultValue
                                        ? `${f.defaultValue} (default)`
                                        : ''
                                  }
                                  autoComplete={f.kind === 'secret' ? 'new-password' : 'off'}
                                  onChange={(e) => setEdits({ ...edits, [f.key]: e.target.value })}
                                />
                                <span className="mt-1 block max-w-[70ch] text-sm text-[var(--color-muted)]">
                                  {f.help}
                                  {f.kind === 'number' &&
                                    f.min !== undefined &&
                                    f.max !== undefined && (
                                      <>
                                        {' '}
                                        Between {f.min} and {f.max.toLocaleString()}.
                                      </>
                                    )}
                                </span>
                              </>
                            )}
                          </label>
                          {/* Outside the label: inside it, opening this ticked the box. */}
                          {f.more && (
                            <details className="mt-1 text-sm text-[var(--color-muted)]">
                              <summary className="cursor-pointer select-none hover:text-[var(--color-accent)]">
                                More about {f.label}
                              </summary>
                              <p className="mt-1 max-w-[75ch]">{f.more}</p>
                            </details>
                          )}
                        </div>
                      ));
                      return group.advanced ? (
                        <details
                          key={group.title}
                          className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] p-4 open:bg-[var(--color-panel)]"
                        >
                          <summary className="cursor-pointer select-none font-medium hover:text-[var(--color-accent)]">
                            {group.title}{' '}
                            <span className="ml-1 text-xs font-normal text-[var(--color-muted)]">
                              ({group.rows.length} settings)
                            </span>
                          </summary>
                          <p className="mt-1 text-sm text-[var(--color-muted)]">
                            {group.description}
                          </p>
                          <div className="mt-4 space-y-4">{controls}</div>
                        </details>
                      ) : (
                        <div key={group.title}>
                          <h4 className="font-semibold">{group.title}</h4>
                          <p className="mt-0.5 text-sm text-[var(--color-muted)]">
                            {group.description}
                          </p>
                          <div className="mt-4 space-y-4">{controls}</div>
                          {group.keys?.includes('PODIUM_TEAMARR_URL') && (
                            <div className="mt-4 flex flex-wrap items-center gap-3">
                              <button
                                type="button"
                                className={btn}
                                disabled={busy}
                                onClick={() => void runTeamarrTest()}
                              >
                                {busy ? 'Testing…' : 'Test Teamarr connection'}
                              </button>
                              {teamarrTest && (
                                <span
                                  role="status"
                                  className={`text-sm ${teamarrTest.ok ? 'text-[var(--color-accent)]' : 'text-[var(--color-bad)]'}`}
                                >
                                  {teamarrTest.text}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>

                {section.id === 'connection' && (
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      className={btn}
                      disabled={busy}
                      onClick={() => void runTest()}
                    >
                      {busy ? 'Testing…' : 'Test Dispatcharr connection'}
                    </button>
                    {test && (
                      <span
                        className={`text-sm ${
                          test.ok ? 'text-[var(--color-accent)]' : 'text-[var(--color-bad)]'
                        }`}
                      >
                        {test.text}
                      </span>
                    )}
                  </div>
                )}
              </section>
            );
          })}

          <section
            id="settings-reset"
            className={`${card} mb-5 scroll-mt-4 border-[var(--color-bad)] p-4 sm:p-6`}
          >
            <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-bad)]">
              Danger Zone
            </h3>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Clear all cached probe results and run history. Podium will need to re-probe every
              stream from scratch on the next pass.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {!showResetConfirm ? (
                <button
                  type="button"
                  className={`${btn} border-[var(--color-bad)] text-[var(--color-bad)] hover:bg-[var(--color-bad)] hover:text-[var(--color-on-bad)] hover:border-[var(--color-bad)]`}
                  disabled={busy}
                  onClick={() => setShowResetConfirm(true)}
                >
                  Clear cache & history
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className={`${btn} !border-[var(--color-bad)] !bg-[var(--color-bad)] !text-[var(--color-on-bad)] font-medium`}
                    disabled={busy}
                    onClick={() => void runReset()}
                  >
                    Yes, clear everything
                  </button>
                  <button
                    type="button"
                    className={btn}
                    disabled={busy}
                    onClick={() => setShowResetConfirm(false)}
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          </section>
        </div>
      </div>

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-3 border-t border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-3 shadow-[0_-4px_16px_rgb(0_0_0_/_0.05)] sm:-mx-6 sm:px-6">
        <button
          type="button"
          className={`${btn} !border-[var(--color-accent-solid)] !bg-[var(--color-accent-solid)] !text-[var(--color-on-accent)]`}
          disabled={busy || !dirty}
          onClick={() => void save()}
        >
          Save changes
        </button>
        {dirty && (
          <button type="button" className={btn} disabled={busy} onClick={() => setEdits({})}>
            Discard
          </button>
        )}
        {dirty && !note && !error && (
          <span className="text-sm text-[var(--color-muted)]">Unsaved changes</span>
        )}
        {note && (
          <span role="status" className="text-sm text-[var(--color-accent)]">
            {note}
          </span>
        )}
        {error && (
          <span role="alert" className="text-sm text-[var(--color-bad)]">
            {error}
          </span>
        )}
        {!dirty && !note && !error && (
          <span className="hidden text-sm text-[var(--color-muted)] sm:inline">
            Clearing a field hands it back to the environment.
          </span>
        )}
      </div>
    </div>
  );
}
