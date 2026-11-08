'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RequireClause } from '@/lib/setting-requirements';
import { clampNote, unsatisfiedRequires } from '@/lib/setting-requirements';
import { VERSION } from '@/lib/version';
import { ConnectActivityPanel } from './connect-activity';

interface Field {
  key: string;
  kind: 'string' | 'secret' | 'boolean' | 'number';
  label: string;
  help: string;
  more?: string;
  section: 'dispatcharr' | 'behaviour' | 'probing' | 'quality' | 'teamarr';
  /** Which named group of the page this renders in -- see GROUPS from the API. */
  group: string;
  requiresAll?: RequireClause[];
  requiresAny?: RequireClause[];
  clampedBy?: { key: string; direction: 'max' | 'min' };
  /** Stored units per displayed unit, for reading a clamp across two fields. */
  scale?: number;
  value: string;
  isSet: boolean;
  source: 'stored' | 'environment' | 'default';
  defaultValue: string;
  min?: number;
  max?: number;
}

/** The page's group taxonomy, delivered alongside the fields it sorts. */
interface Group {
  id: string;
  section: Field['section'];
  title: string;
  description: string;
  advanced?: boolean;
}

type SectionId = 'connection' | 'automation' | 'measurement' | 'learning';

/**
 * One provider in a Test Connection result.
 *
 * `profiles` carries the account's active logins with their own caps -- the
 * account-level `maxStreams` is only the default profile's cap, because
 * Dispatcharr keeps those two in sync and leaves every additional profile its
 * own limit. A null cap is Dispatcharr's 0, "unlimited".
 */
type TestProvider = {
  name: string;
  maxStreams: number;
  profiles?: Array<{ name: string; maxStreams: number | null }>;
};

/**
 * The connections one provider offers, as the test line prints them.
 *
 * Mirrors what Dispatcharr's own accounts table totals: per-profile limits,
 * not the account-level number. The resolution of an unlimited profile follows
 * the lane builder rather than Dispatcharr's ∞ -- it probes an unlimited login
 * at the account's cap -- so the total shown is the one the runner actually
 * gets. An account reporting no active profiles keeps the account-level cap:
 * that is the stored-URL lane such an account probes on.
 */
function describeTestProvider(p: TestProvider): string {
  const active = p.profiles ?? [];
  if (active.length === 0) return `${p.name} (${p.maxStreams})`;
  const caps = active.map((profile) => profile.maxStreams ?? p.maxStreams);
  const total = caps.reduce((sum, cap) => sum + cap, 0);
  return active.length > 1 ? `${p.name} (${caps.join('+')}=${total})` : `${p.name} (${total})`;
}

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
    title: 'Checking streams',
    blurb: 'Control how Podium checks playback and detects failures.',
  },
  {
    id: 'learning',
    sources: ['quality', 'teamarr'],
    title: 'Learn & export',
    blurb: 'Choose which results shape learned rules, then send those rules to Teamarr.',
  },
];

const card = 'rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]';
const btn =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-2 text-[15px] hover:border-[var(--color-accent)] disabled:opacity-50';
const pill = 'inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap';
const input =
  'w-full max-w-xl rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 outline-none focus:border-[var(--color-accent)]';

/**
 * Groups for a section: the API's taxonomy filtered to it, fields slotted in by
 * the `group` each field carries. The API's groups are written next to the
 * field list itself, so a newly added field lands in its group automatically;
 * one with a group no list knows about falls into "Other settings" rather than
 * disappearing.
 */
function groupedRows(section: { sources: Field['section'][] }, groups: Group[], rows: Field[]) {
  const out = groups
    .filter((g) => section.sources.includes(g.section))
    .map((g) => ({ group: g, rows: rows.filter((f) => f.group === g.id) }));
  const placed = new Set(out.flatMap((entry) => entry.rows.map((f) => f.key)));
  const remaining = rows.filter((f) => !placed.has(f.key));
  if (remaining.length)
    out.push({
      group: {
        id: 'other',
        // Never read again: this entry is appended after the section filter.
        section: section.sources[0] ?? 'dispatcharr',
        title: 'Other settings',
        description: 'Additional options.',
      },
      rows: remaining,
    });
  return out;
}

/**
 * The sentence explaining an unmet dependency, naming the fields by label.
 *
 * "Does nothing while X is off" rather than "requires X": the value stored is
 * fine, it is just that nothing reads it yet -- an error would send somebody
 * hunting for a mistake that is not there. A requiresAny clause reads as the
 * choice it is: "needs A or B on".
 */
function requireNote(
  field: Field,
  values: Record<string, string>,
  labels: Record<string, string>,
): string {
  const unmet = unsatisfiedRequires(field, values);
  if (unmet.length === 0) return '';
  const name = (clause: RequireClause): string => labels[clause.key] ?? clause.key;
  const inList = (list: RequireClause[] | undefined, clause: RequireClause): boolean =>
    list?.some((c) => c.key === clause.key && c.state === clause.state) ?? false;
  const from = (clauses: RequireClause[]): string =>
    clauses
      .map((clause) =>
        clause.state === 'on'
          ? `“${name(clause)}” is off`
          : clause.state === 'gt0'
            ? `“${name(clause)}” is zero`
            : `“${name(clause)}” is empty`,
      )
      .join(' and ');
  const sentences: string[] = [];
  const allUnmet = unmet.filter((clause) => inList(field.requiresAll, clause));
  const anyUnmet = unmet.filter((clause) => inList(field.requiresAny, clause));
  const switchedOff = allUnmet.filter((clause) => clause.state === 'on');
  if (switchedOff.length) sentences.push(`Does nothing while ${from(switchedOff)}.`);
  const notUsable = allUnmet.filter((clause) => clause.state !== 'on');
  if (notUsable.length) sentences.push(`Has no effect while ${from(notUsable)}.`);
  if (anyUnmet.length)
    sentences.push(
      `Needs ${anyUnmet
        .map((clause) =>
          clause.state === 'on'
            ? `“${name(clause)}” on`
            : clause.state === 'gt0'
              ? `“${name(clause)}” above zero`
              : `“${name(clause)}” filled in`,
        )
        .join(' or ')}.`,
    );
  return sentences.join(' ');
}

export function SettingsView({ active }: { active?: boolean } = {}) {
  const [fields, setFields] = useState<Field[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [effective, setEffective] = useState<{ dryRun: boolean; hasCredentials: boolean } | null>(
    null,
  );
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
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
      setGroups((body.groups ?? []) as Group[]);
      setEffective(body.effective);
      setEdits({});
      setFieldErrors({});
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
  const checkedValue = (f: Field): boolean => {
    const raw = (edits[f.key] ?? (f.value || f.defaultValue)).trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(raw);
  };
  const dirty = Object.keys(edits).length > 0;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (active && !dirtyRef.current) void load();
  }, [active, load]);

  /**
   * Every field's effective displayed value, as the dependency checks read the
   * world: the in-progress edit where there is one, the effective value where
   * not, falling through to the schema default when nothing is set anywhere.
   * Booleans come out exactly "true"/"false" off the checkbox, whatever raw
   * string the environment seeded them with.
   */
  const dependencyValues: Record<string, string> = {};
  for (const f of fields) {
    dependencyValues[f.key] =
      f.kind === 'boolean'
        ? checkedValue(f)
          ? 'true'
          : 'false'
        : currentValue(f) || f.defaultValue;
  }
  const labels: Record<string, string> = {};
  for (const f of fields) labels[f.key] = f.label;

  const change = (key: string, value: string) => {
    setEdits({ ...edits, [key]: value });
    // The note was about the old value; typing a new one starts it clean.
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

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
        const errors = body.errors as Array<{ key: string; message: string }> | undefined;
        if (errors?.length) {
          setFieldErrors(Object.fromEntries(errors.map((e) => [e.key, e.message])));
          setError('Some fields need attention — see the notes under them.');
          // Where the eye should go: the form is long, and the first bad
          // field is usually far below the fold.
          const first = errors[0];
          if (first) {
            const el = document.getElementById(`settings-field-${first.key}`);
            // A collapsed advanced group or an active search hides the field,
            // and scrollIntoView on a hidden element silently does nothing.
            el?.closest('details')?.setAttribute('open', '');
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            if (!el) setQuery('');
          }
          return;
        }
        setError(body.error ?? `HTTP ${resp.status}`);
        return;
      }
      setFields(body.fields as Field[]);
      setEdits({});
      setFieldErrors({});
      setNote('Saved — the worker starts a pass within half a minute.');
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
                .map((p: TestProvider) => describeTestProvider(p))
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

  const q = query.trim().toLowerCase();
  const matches = (f: Field): boolean =>
    q === '' || `${f.label} ${f.help} ${f.more ?? ''} ${f.key}`.toLowerCase().includes(q);
  const visibleFields = q === '' ? fields : fields.filter(matches);
  const searching = q !== '';

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
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            How Podium runs
            <span className="ml-2 align-middle text-sm font-normal tabular-nums text-[var(--color-muted)]">
              v{VERSION}
            </span>
          </h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Connect services, choose what changes automatically, and tune how streams are checked.
          </p>
        </div>
        <label className="block w-full max-w-xs">
          <input
            type="search"
            className={input}
            placeholder="Search settings…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
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
            Saved changes reach the worker within half a minute; no restart needed.
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
          {searching && (
            <div className="mb-5 flex items-center gap-3 text-sm text-[var(--color-muted)]">
              <span>
                {visibleFields.length === 0
                  ? 'No settings match.'
                  : `${visibleFields.length} setting${visibleFields.length === 1 ? '' : 's'} match.`}
              </span>
              <button type="button" className={btn} onClick={() => setQuery('')}>
                Show everything
              </button>
            </div>
          )}
          {SECTIONS.map((section) => {
            const rows = visibleFields.filter((f) => section.sources.includes(f.section));
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
                  {groupedRows(section, groups, rows)
                    .filter((entry) => entry.rows.length > 0)
                    .map(({ group, rows: groupRows }) => {
                      const controls = groupRows.map((f) => {
                        const unmet = unsatisfiedRequires(f, dependencyValues);
                        const clamp = clampNote(f, dependencyValues, fields);
                        return (
                          <div
                            key={f.key}
                            id={`settings-field-${f.key}`}
                            className="scroll-mt-24 border-t border-[var(--color-line)] pt-4 first:border-0 first:pt-0"
                          >
                            <div className={unmet.length > 0 ? 'opacity-60' : undefined}>
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
                                        change(f.key, e.target.checked ? 'true' : 'false')
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
                                      onChange={(e) => change(f.key, e.target.value)}
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
                            {unmet.length > 0 && (
                              <p className="mt-1 max-w-[70ch] text-sm text-[var(--color-warn)]">
                                {requireNote(f, dependencyValues, labels)}
                              </p>
                            )}
                            {clamp && (
                              <p className="mt-1 max-w-[70ch] text-sm text-[var(--color-warn)]">
                                {clamp}
                              </p>
                            )}
                            {fieldErrors[f.key] && (
                              <p
                                role="alert"
                                className="mt-1 max-w-[70ch] text-sm text-[var(--color-bad)]"
                              >
                                {fieldErrors[f.key]}
                              </p>
                            )}
                          </div>
                        );
                      });
                      return group.advanced ? (
                        <details
                          key={group.id}
                          className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] p-4 open:bg-[var(--color-panel)]"
                          open={searching || undefined}
                        >
                          <summary className="cursor-pointer select-none font-medium hover:text-[var(--color-accent)]">
                            {group.title}{' '}
                            <span className="ml-1 text-xs font-normal text-[var(--color-muted)]">
                              ({groupRows.length} settings)
                            </span>
                          </summary>
                          <p className="mt-1 text-sm text-[var(--color-muted)]">
                            {group.description}
                          </p>
                          <div className="mt-4 space-y-4">{controls}</div>
                        </details>
                      ) : (
                        <div key={group.id}>
                          <h4 className="font-semibold">{group.title}</h4>
                          <p className="mt-0.5 text-sm text-[var(--color-muted)]">
                            {group.description}
                          </p>
                          <div className="mt-4 space-y-4">{controls}</div>
                          {group.id === 'teamarr-push' && (
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

                {section.id === 'measurement' && <ConnectActivityPanel />}

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

          {searching && visibleFields.length === 0 && (
            <div className={`${card} mb-5 p-8 text-center text-sm text-[var(--color-muted)]`}>
              Nothing matches “{query.trim()}” in any setting.
            </div>
          )}

          <section
            id="settings-reset"
            className={`${card} mb-5 scroll-mt-4 border-[var(--color-bad)] p-4 sm:p-6`}
          >
            <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-bad)]">
              Danger Zone
            </h3>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Clear all cached check results and run history. Podium will need to re-check every
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
                  {/* Said here as well as enforced by the route: on a stock
                      install the dry run is on, and the reset now refuses
                      rather than answering a probe-wipe with a bare 200.
                      Better to read it before clicking than in the error. */}
                  {effective?.dryRun && (
                    <p className="text-sm text-[var(--color-bad)]">
                      The dry run is on, so the reset will be refused — turn it off above first.
                    </p>
                  )}
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
