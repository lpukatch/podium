import { NextResponse } from 'next/server';
import { DEFAULT_WEIGHTS, NEW_INSTALL_AUDIO } from '@/lib/scoring';
import { ordering, readRulesDoc, snapshot, writeRulesDoc } from '@/lib/server/state';

export const dynamic = 'force-dynamic';

/** The editable weight keys exposed in the UI (the bitrate floor has its own field). */
const WEIGHT_KEYS = ['resolution', 'bitrate', 'fps', 'codec', 'audio'] as const;
type WeightKey = (typeof WEIGHT_KEYS)[number];

export interface OrderingResponse {
  mode: 'quality' | 'provider' | 'alias';
  providerPreference: string[];
  weights: Record<WeightKey, number> & { preferH265: boolean };
  defaults: Record<WeightKey, number> & { preferH265: boolean };
  providers: { id: number; name: string }[];
}

/**
 * The ranking strategy and the provider list to pick preferences from.
 *
 * Mirrors the stream-groups route: a GET over the parsed rules `ordering` block
 * plus the live providers, a PUT that writes the block back through the shared
 * `readRulesDoc`/`writeRulesDoc` pair (which hot-reloads the worker).
 */
export async function GET() {
  try {
    const cfg = ordering();
    const snap = await snapshot();

    // Merge stored overrides over the built-in defaults so every input always
    // has a value to show, then keep only the editable keys.
    const merged = { ...DEFAULT_WEIGHTS, ...cfg.weights };
    const pick = (k: WeightKey) => merged[k];
    const weights = {
      resolution: pick('resolution'),
      bitrate: pick('bitrate'),
      fps: pick('fps'),
      codec: pick('codec'),
      audio: pick('audio'),
      preferH265: merged.preferH265,
    };
    const defaults = {
      resolution: DEFAULT_WEIGHTS.resolution,
      bitrate: DEFAULT_WEIGHTS.bitrate,
      fps: DEFAULT_WEIGHTS.fps,
      codec: DEFAULT_WEIGHTS.codec,
      // What a new install is seeded with, not the 0 that keeps upgrades still:
      // "reset" should hand back what podium ships today.
      audio: NEW_INSTALL_AUDIO,
      preferH265: DEFAULT_WEIGHTS.preferH265,
    };

    return NextResponse.json({
      mode: cfg.mode,
      providerPreference: cfg.providerPreference,
      weights,
      defaults,
      providers: snap.providers.map((p) => ({ id: p.id, name: p.name })),
    } satisfies OrderingResponse);
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  }
}

/**
 * Replace the `ordering` block wholesale.
 *
 * Deliberately does not call `snapshot()`: saving the strategy must not depend on
 * Dispatcharr being up. An unknown provider name is harmless -- `resolveOrdering`
 * simply maps nothing to it -- so the preference list is trimmed and de-duped
 * rather than validated against the live providers.
 */
export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as {
      mode?: string;
      providerPreference?: string[];
      weights?: Record<string, unknown>;
    };

    const mode: OrderingResponse['mode'] =
      body.mode === 'provider' || body.mode === 'alias' ? body.mode : 'quality';

    const providerPreference = [
      ...new Set((body.providerPreference ?? []).map((n) => String(n).trim()).filter(Boolean)),
    ];

    const w = body.weights ?? {};
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const weights = {
      resolution: num(w.resolution),
      bitrate: num(w.bitrate),
      fps: num(w.fps),
      codec: num(w.codec),
      audio: num(w.audio),
      prefer_h265: Boolean(w.preferH265),
    };

    const doc = readRulesDoc();
    doc.ordering = { mode, provider_preference: providerPreference, weights };
    writeRulesDoc(doc);

    return NextResponse.json({ status: 'saved' });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  }
}
