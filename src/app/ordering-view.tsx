'use client';

import { useCallback, useEffect, useState } from 'react';

type Mode = 'quality' | 'provider' | 'alias';

interface Provider {
  id: number;
  name: string;
}

/** Weight values are held as strings so the inputs behave like the settings form. */
interface Weights {
  resolution: string;
  bitrate: string;
  fps: string;
  codec: string;
  audio: string;
  preferH265: boolean;
}

interface OrderingState {
  mode: Mode;
  preference: string[];
  weights: Weights;
}

interface Response {
  mode: Mode;
  providerPreference: string[];
  weights: {
    resolution: number;
    bitrate: number;
    fps: number;
    codec: number;
    audio: number;
    preferH265: boolean;
  };
  defaults: {
    resolution: number;
    bitrate: number;
    fps: number;
    codec: number;
    audio: number;
    preferH265: boolean;
  };
  providers: Provider[];
}

const card = 'rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]';
const btn =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-2 text-[15px] hover:border-[var(--color-accent)] disabled:opacity-50';
const input =
  'w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 outline-none focus:border-[var(--color-accent)]';
const iconBtn =
  'rounded-md border border-[var(--color-line)] px-1.5 text-xs hover:border-[var(--color-accent)] disabled:opacity-30';

const MODES: { value: Mode; label: string; help: string }[] = [
  { value: 'quality', label: 'Quality', help: 'Best source wins outright.' },
  {
    value: 'provider',
    label: 'Provider, then quality',
    help: 'Preferred providers first, best within each.',
  },
  {
    value: 'alias',
    label: 'Alias / step order',
    help: 'The position of the matching alias leads, as before.',
  },
];

const WEIGHT_FIELDS: { key: keyof Omit<Weights, 'preferH265'>; label: string }[] = [
  { key: 'resolution', label: 'Resolution' },
  { key: 'bitrate', label: 'Bitrate' },
  { key: 'fps', label: 'FPS' },
  { key: 'codec', label: 'Codec' },
  { key: 'audio', label: 'Audio' },
];

const toWeights = (w: Response['weights']): Weights => ({
  resolution: String(w.resolution),
  bitrate: String(w.bitrate),
  fps: String(w.fps),
  codec: String(w.codec),
  audio: String(w.audio),
  preferH265: w.preferH265,
});

const same = (a: OrderingState, b: OrderingState): boolean =>
  a.mode === b.mode &&
  a.preference.join('\n') === b.preference.join('\n') &&
  JSON.stringify(a.weights) === JSON.stringify(b.weights);

/**
 * How channels are ranked and the order written back to Dispatcharr.
 *
 * The strategy lives in the top-level `ordering` block of rules.json (hot-reloaded
 * each pass), edited here through /api/ordering. The bitrate floor is intentionally
 * absent -- it is the "Minimum bitrate" field on the main settings form, and the
 * ranking falls back to it when no override is set here.
 */
export function OrderingView() {
  const [mode, setMode] = useState<Mode>('quality');
  const [preference, setPreference] = useState<string[]>([]);
  const [weights, setWeights] = useState<Weights>({
    resolution: '',
    bitrate: '',
    fps: '',
    codec: '',
    audio: '',
    preferH265: true,
  });
  const [defaults, setDefaults] = useState<Weights>(weights);
  const [providers, setProviders] = useState<Provider[]>([]);

  const [saved, setSaved] = useState<OrderingState>({ mode, preference, weights });
  const [advanced, setAdvanced] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const apply = useCallback((body: Response) => {
    const w = toWeights(body.weights);
    setMode(body.mode);
    setPreference(body.providerPreference);
    setWeights(w);
    setDefaults(toWeights(body.defaults));
    setProviders(body.providers);
    setSaved({ mode: body.mode, preference: body.providerPreference, weights: w });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch('/api/ordering');
      const body = (await resp.json()) as Response & { error?: string };
      if (!resp.ok || body.error) {
        setError(String(body.error ?? `HTTP ${resp.status}`));
        return;
      }
      setError('');
      apply(body);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  const current: OrderingState = { mode, preference, weights };
  const dirty = !same(current, saved);

  const save = async () => {
    setSaving(true);
    try {
      const num = (s: string) => {
        const n = Number(s);
        return Number.isFinite(n) ? n : 0;
      };
      const resp = await fetch('/api/ordering', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          providerPreference: preference,
          weights: {
            resolution: num(weights.resolution),
            bitrate: num(weights.bitrate),
            fps: num(weights.fps),
            codec: num(weights.codec),
            audio: num(weights.audio),
            preferH265: weights.preferH265,
          },
        }),
      });
      const body = (await resp.json()) as { error?: string };
      if (!resp.ok || body.error) {
        setError(String(body.error ?? `HTTP ${resp.status}`));
        return;
      }
      setError('');
      // Reflect exactly what we sent as the new saved baseline.
      setSaved({ mode, preference, weights });
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= preference.length) return;
    const next = [...preference];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setPreference(next);
  };

  const remaining = providers.filter((p) => !preference.includes(p.name));
  const providerLocked = mode !== 'provider';
  const activeHelp = MODES.find((m) => m.value === mode)?.help ?? '';

  return (
    <div className={`${card} p-5`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          Stream ordering
        </h3>
        <span className="text-sm text-[var(--color-muted)]">
          {loading ? 'loading…' : activeHelp}
        </span>
      </div>
      <p className="mt-1.5 text-sm text-[var(--color-muted)]">
        How channels are ranked before the order is written back to Dispatcharr. Unusable streams
        (dead, black, or below the bitrate floor) always sink regardless of mode.
      </p>

      {error && (
        <p className="mt-3 rounded-lg border border-[var(--color-warn)] px-3 py-2 text-sm text-[var(--color-warn)]">
          {error}
        </p>
      )}

      <label className="mt-4 block text-sm font-semibold" htmlFor="ordering-mode">
        Mode
      </label>
      <select
        id="ordering-mode"
        value={mode}
        onChange={(e) => setMode(e.target.value as Mode)}
        disabled={loading || saving}
        className={`${input} mt-1`}
      >
        {MODES.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>

      {/* Provider preference -- only consulted in provider mode. */}
      <div className={`mt-4 ${providerLocked ? 'pointer-events-none opacity-50' : ''}`}>
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-semibold">Preferred providers</span>
          <span className="text-xs text-[var(--color-muted)]">in order</span>
        </div>
        {providerLocked && (
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Only used in <span className="mono">provider</span> mode.
          </p>
        )}

        {preference.length > 0 && (
          <ul className="mt-2">
            {preference.map((name, i) => (
              <li
                key={name}
                className="flex items-center gap-2 border-b border-[var(--color-line)] py-1.5 last:border-0"
              >
                <span className="mono min-w-0 flex-1 truncate">{name}</span>
                <button
                  type="button"
                  className={iconBtn}
                  disabled={i === 0}
                  title="Move up"
                  onClick={() => move(i, -1)}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className={iconBtn}
                  disabled={i === preference.length - 1}
                  title="Move down"
                  onClick={() => move(i, 1)}
                >
                  ▼
                </button>
                <button
                  type="button"
                  className={iconBtn}
                  title="Remove"
                  onClick={() => setPreference(preference.filter((n) => n !== name))}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        {remaining.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {remaining.map((p) => (
              <button
                key={p.id}
                type="button"
                className="rounded-full border border-[var(--color-line)] px-2 py-0.5 text-xs hover:border-[var(--color-accent)]"
                title={`Prefer ${p.name}`}
                onClick={() => setPreference([...preference, p.name])}
              >
                + {p.name}
              </button>
            ))}
          </div>
        )}
        {!loading && providers.length === 0 && !error && (
          <p className="mt-2 text-sm text-[var(--color-muted)]">No providers found.</p>
        )}
      </div>

      {/* Advanced: quality weights. */}
      <div className="mt-4">
        <button
          type="button"
          className="text-sm text-[var(--color-muted)] underline hover:text-[var(--color-accent)]"
          onClick={() => setAdvanced(!advanced)}
        >
          {advanced ? '▾' : '▸'} Advanced (quality weights)
        </button>
        {advanced && (
          <div className="mt-2">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {WEIGHT_FIELDS.map((f) => (
                <label key={f.key} className="block text-xs text-[var(--color-muted)]">
                  {f.label}
                  <input
                    value={weights[f.key]}
                    onChange={(e) => setWeights({ ...weights, [f.key]: e.target.value })}
                    inputMode="numeric"
                    className={`${input} mt-1`}
                  />
                </label>
              ))}
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={weights.preferH265}
                onChange={(e) => setWeights({ ...weights, preferH265: e.target.checked })}
              />
              Prefer H.265 / HEVC over H.264
            </label>
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              Relative weights for the quality score (higher = more important). They are normalised
              by their total, so what matters is their size relative to each other.
            </p>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              Audio prefers surround where a channel is carried both with and without it. New
              installs start at 0.1, which decides between streams whose video already ties without
              letting audio outrank resolution or bitrate; installs that predate the setting stay at
              0 until you raise it.
            </p>
            <button
              type="button"
              className="mt-2 text-xs text-[var(--color-muted)] underline hover:text-[var(--color-accent)]"
              onClick={() => setWeights(defaults)}
            >
              Reset to defaults
            </button>
          </div>
        )}
      </div>

      <div className="mt-4">
        <button type="button" className={btn} disabled={loading || saving || !dirty} onClick={save}>
          {saving ? 'Saving…' : 'Save ordering'}
        </button>
      </div>
    </div>
  );
}
