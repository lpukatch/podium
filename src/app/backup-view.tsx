'use client';

import { useState } from 'react';

const card = 'rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]';
const btn =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-2 text-[15px] hover:border-[var(--color-accent)] disabled:opacity-50';
const muted = 'text-[var(--color-muted)]';

export function BackupView() {
  const [pending, setPending] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const restore = async (file: File) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const resp = await fetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: await file.text(),
      });
      const body = await resp.json();
      if (!resp.ok || body.error) {
        setError(body.error ?? `HTTP ${resp.status}`);
        return;
      }
      // Every card on this tab holds its own fetched copy of the state that
      // just changed underneath it, and there is no shared refetch to call --
      // a reload is the honest refresh for an action this rare.
      setNote('Restored — reloading…');
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${card} p-5`}>
      <h3 className="text-sm font-semibold uppercase tracking-wide">Backup</h3>
      <p className={`mt-1 text-sm ${muted}`}>
        Everything you configured — rules, settings, Teamarr rules, assignment blocks — in one file.
        Measured data and history are not included; those re-accumulate.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <a className={btn} href="/api/backup" download>
          Download backup
        </a>
        {!pending && (
          <label className={`${btn} cursor-pointer`}>
            {busy ? 'Restoring…' : 'Import backup…'}
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) setPending(file);
              }}
            />
          </label>
        )}
        {note && <span className="text-sm text-[var(--color-accent)]">{note}</span>}
        {error && <span className="text-sm text-[var(--color-bad)]">{error}</span>}
      </div>

      {pending && (
        <div className="mt-4">
          <p className="text-sm text-[var(--color-bad)]">
            Restore {pending.name}? This replaces your rules, settings — including Dispatcharr
            credentials — Teamarr rules, and assignment blocks. Measured data is kept.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={`${btn} border-[var(--color-bad)] bg-[var(--color-bad)] font-medium text-white`}
              disabled={busy}
              onClick={() => void restore(pending)}
            >
              Yes, restore
            </button>
            <button type="button" className={btn} disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <p className={`mt-4 max-w-[70ch] text-sm ${muted}`}>
        A backup file contains your Dispatcharr API key or password. Treat it like one.
      </p>
    </div>
  );
}
