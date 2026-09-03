'use client';

import { useCallback, useEffect, useState } from 'react';

interface Sample {
  raw: string;
  normalized: string;
}

interface EntryReport {
  text: string;
  streams: number;
  samples: Sample[];
}

const card = 'rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]';
const btn =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-2 text-[15px] hover:border-[var(--color-accent)] disabled:opacity-50';
const pill = 'inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap';
const input =
  'w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 outline-none focus:border-[var(--color-accent)]';

/** Long enough that the preview is not re-run on every keystroke. */
const PREVIEW_DELAY_MS = 350;

/**
 * Words to delete from every provider stream name.
 *
 * Badge *glyphs* -- ◉ ▶ ⏺ ★ -- are handled centrally and are deliberately not
 * listed here: they are swept as a Unicode category, so there is nothing to
 * configure and nothing that goes stale. This is only for the badges spelled as
 * words, which no category can cover because each is noise on one catalogue.
 *
 * The preview is the point. A strip entry is the one rule that acts on every
 * channel at once, so it is shown against the live catalogue -- how many names
 * it changes, and what four of them become -- before it can be saved.
 */
export function NameNoiseView() {
  const [strip, setStrip] = useState<string[]>([]);
  const [entries, setEntries] = useState<EntryReport[]>([]);
  const [draft, setDraft] = useState('');
  const [candidate, setCandidate] = useState<EntryReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (query = '') => {
    try {
      const resp = await fetch(`/api/name-noise${query ? `?q=${encodeURIComponent(query)}` : ''}`);
      const body = await resp.json();
      if (!resp.ok || body.error) {
        setError(String(body.error ?? `HTTP ${resp.status}`));
        return;
      }
      setError('');
      setStrip(body.strip as string[]);
      setEntries(body.entries as EntryReport[]);
      setCandidate((body.candidate as EntryReport | null) ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Preview the word being typed, debounced: the count is a scan of the whole
  // catalogue, which is cheap once and wasteful per keystroke.
  useEffect(() => {
    const text = draft.trim();
    if (!text) {
      setCandidate(null);
      return;
    }
    const timer = setTimeout(() => void load(text), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, load]);

  const save = async (next: string[]) => {
    setSaving(true);
    try {
      const resp = await fetch('/api/name-noise', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strip: next }),
      });
      const body = await resp.json();
      if (!resp.ok || body.error) {
        setError(String(body.error ?? `HTTP ${resp.status}`));
        return;
      }
      setDraft('');
      setCandidate(null);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const add = () => {
    const text = draft.trim();
    if (!text || strip.includes(text)) return;
    void save([...strip, text]);
  };

  const report = (entry: EntryReport, tone: 'saved' | 'candidate') => (
    <div key={entry.text} className="border-b border-[var(--color-line)] py-2.5 last:border-0">
      <div className="flex flex-wrap items-center gap-3">
        <span className="mono min-w-0 flex-1">{entry.text}</span>
        <span className="flex-none text-sm tabular-nums text-[var(--color-muted)]">
          {entry.streams.toLocaleString()} name{entry.streams === 1 ? '' : 's'}
        </span>
        {tone === 'saved' ? (
          <button
            type="button"
            disabled={saving}
            title={`Stop stripping "${entry.text}"`}
            className={`${pill} mono flex-none border border-[var(--color-warn)] text-[var(--color-warn)] hover:border-[var(--color-accent)]`}
            onClick={() => void save(strip.filter((x) => x !== entry.text))}
          >
            ✕
          </button>
        ) : (
          <button
            type="button"
            disabled={saving || entry.streams === 0}
            className={`${btn} flex-none px-3 py-1.5 text-sm`}
            onClick={add}
          >
            Add
          </button>
        )}
      </div>
      {entry.samples.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {entry.samples.map((s) => (
            <li key={s.raw} className="mono text-xs text-[var(--color-muted)]">
              {s.raw} <span className="text-[var(--color-accent)]">→</span> {s.normalized}
            </li>
          ))}
        </ul>
      )}
      {tone === 'candidate' && entry.streams === 0 && (
        <p className="mt-1.5 text-xs text-[var(--color-muted)]">
          Changes no stream name. Either nothing carries it, or it is already handled.
        </p>
      )}
    </div>
  );

  return (
    <div className={`${card} p-5`}>
      <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        Name noise
      </h3>
      <p className="mt-1.5 text-sm text-[var(--color-muted)]">
        Words to delete from every provider stream name before matching reads it, so a badge the
        provider stamps on a name never has to be written into an alias. Badge symbols —{' '}
        <span className="mono">◉ ▶ ⏺ ★</span> — are already stripped and need nothing here; this is
        for the ones spelled as words, like <span className="mono">CATCHUP</span> or{' '}
        <span className="mono">24/7</span>. Whole words only, so <span className="mono">HD</span>{' '}
        will not eat the end of <span className="mono">GOLD</span>.
      </p>

      {error && (
        <p className="mt-3 rounded-lg border border-[var(--color-warn)] px-3 py-2 text-sm text-[var(--color-warn)]">
          {error}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
          placeholder="A word to strip, e.g. CATCHUP"
          className={input}
        />
        <button
          type="button"
          disabled={saving || !draft.trim() || strip.includes(draft.trim())}
          className={`${btn} flex-none`}
          onClick={add}
        >
          Add
        </button>
      </div>

      {candidate && !strip.includes(candidate.text) && (
        <div className="mt-3 rounded-lg border border-[var(--color-accent)] px-3 py-1">
          {report(candidate, 'candidate')}
        </div>
      )}

      {entries.length > 0 && (
        <div className="mt-3">{entries.map((entry) => report(entry, 'saved'))}</div>
      )}

      {!loading && entries.length === 0 && !error && (
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          Nothing stripped. Most installs never need an entry here — add one only when a word the
          provider adds is stopping an alias from matching.
        </p>
      )}
    </div>
  );
}
