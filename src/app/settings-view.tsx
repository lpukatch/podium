'use client';

import { useCallback, useEffect, useState } from 'react';

interface Field {
  key: string;
  kind: 'string' | 'secret' | 'boolean' | 'number';
  label: string;
  help: string;
  section: 'dispatcharr' | 'behaviour' | 'probing' | 'quality';
  value: string;
  isSet: boolean;
  source: 'stored' | 'environment' | 'default';
  defaultValue: string;
  min?: number;
  max?: number;
}

const SECTIONS: Array<{ id: Field['section']; title: string; blurb: string }> = [
  {
    id: 'dispatcharr',
    title: 'Dispatcharr',
    blurb: 'Where to reach it, and how to authenticate. Test before saving.',
  },
  {
    id: 'behaviour',
    title: 'Behaviour',
    blurb: 'What Podium is allowed to change, and how hard it works.',
  },
  { id: 'probing', title: 'Probing', blurb: 'How each stream is judged.' },
  {
    id: 'quality',
    title: 'Quality priors',
    blurb:
      'Which probes the learned priors — and the rules exported from them — are allowed to measure. Nothing here deletes a sample; it only decides what the fit reads.',
  },
];

const card = 'rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]';
const btn =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-2 text-[15px] hover:border-[var(--color-accent)] disabled:opacity-50';
const pill = 'inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap';
const input =
  'w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 outline-none focus:border-[var(--color-accent)]';

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
    <div className="p-5">
      {effective && (
        <div className={`${card} mb-4 flex flex-wrap items-center gap-3 p-4`}>
          <span
            className={`${pill} ${
              effective.dryRun
                ? 'bg-[var(--color-warn)] text-white'
                : 'bg-[var(--color-accent)] text-white'
            }`}
          >
            {effective.dryRun ? 'dry run — not writing' : 'live — writing to Dispatcharr'}
          </span>
          {!effective.hasCredentials && (
            <span className={`${pill} bg-[var(--color-bad)] text-white`}>no credentials set</span>
          )}
          <span className="flex-1" />
          <span className="text-sm text-[var(--color-muted)]">
            Changes apply on the next pass; no restart needed.
          </span>
        </div>
      )}

      {SECTIONS.map((section) => {
        const rows = fields.filter((f) => f.section === section.id);
        if (rows.length === 0) return null;
        return (
          <div key={section.id} className={`${card} mb-4 p-5`}>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
              {section.title}
            </h3>
            <p className="mt-1 text-sm text-[var(--color-muted)]">{section.blurb}</p>

            <div className="mt-4 grid gap-4">
              {rows.map((f) => (
                <label key={f.key} className="block">
                  <span className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium">{f.label}</span>
                    {f.source === 'environment' && (
                      <span className={`${pill} bg-[var(--color-line)] text-[var(--color-muted)]`}>
                        from environment
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
                    <span className="mt-2 flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--color-accent)]"
                        checked={checkedValue(f)}
                        onChange={(e) =>
                          setEdits({ ...edits, [f.key]: e.target.checked ? 'true' : 'false' })
                        }
                      />
                      <span className="text-sm text-[var(--color-muted)]">{f.help}</span>
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
                      <span className="mt-1 block text-sm text-[var(--color-muted)]">
                        {f.help}
                        {f.kind === 'number' && f.min !== undefined && f.max !== undefined && (
                          <>
                            {' '}
                            Between {f.min} and {f.max.toLocaleString()}.
                          </>
                        )}
                      </span>
                    </>
                  )}
                </label>
              ))}
            </div>

            {section.id === 'dispatcharr' && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className={btn}
                  disabled={busy}
                  onClick={() => void runTest()}
                >
                  {busy ? 'Testing…' : 'Test connection'}
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
          </div>
        );
      })}

      <div className={`${card} mb-4 border-[var(--color-bad)] p-5`}>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-bad)]">
          Danger Zone
        </h3>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Clear all cached probe results and run history. Podium will need to re-probe every stream
          from scratch on the next pass.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {!showResetConfirm ? (
            <button
              type="button"
              className={`${btn} border-[var(--color-bad)] text-[var(--color-bad)] hover:bg-[var(--color-bad)] hover:text-white hover:border-[var(--color-bad)]`}
              disabled={busy}
              onClick={() => setShowResetConfirm(true)}
            >
              Clear cache & history
            </button>
          ) : (
            <>
              <button
                type="button"
                className={`${btn} border-[var(--color-bad)] bg-[var(--color-bad)] text-white font-medium`}
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
      </div>

      <div className="sticky bottom-0 flex flex-wrap items-center gap-4 border-t border-[var(--color-line)] bg-[var(--color-panel)] py-3">
        <button
          type="button"
          className={`${btn} border-[var(--color-accent)] bg-[var(--color-accent)] text-white`}
          disabled={busy || !dirty}
          onClick={() => void save()}
        >
          Save
        </button>
        {dirty && (
          <button type="button" className={btn} disabled={busy} onClick={() => setEdits({})}>
            Discard
          </button>
        )}
        {note && <span className="text-sm text-[var(--color-accent)]">{note}</span>}
        {error && <span className="text-sm text-[var(--color-bad)]">{error}</span>}
        {!dirty && !note && !error && (
          <span className="text-sm text-[var(--color-muted)]">
            Clearing a field hands it back to the environment.
          </span>
        )}
      </div>
    </div>
  );
}
