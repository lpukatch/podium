import { NextResponse } from 'next/server';
import { loadConfig, requireCredentials } from '@/lib/config';
import { describeSettings, resolveEnv, validateSettings } from '@/lib/settings';
import { Store } from '@/lib/store';

export const dynamic = 'force-dynamic';

/** Where the database lives is fixed by environment; only that is needed here. */
function openStore(): Store {
  return new Store(loadConfig().dbPath);
}

export function GET() {
  let store: Store | null = null;
  try {
    store = openStore();
    const stored = store.settings();
    return NextResponse.json({
      // Secret values are never returned -- only whether one is set. The API
      // that writes a credential must not also read it back.
      fields: describeSettings(process.env, stored),
      // What the app is actually using right now, for the parts worth showing.
      effective: (() => {
        const config = loadConfig(resolveEnv(process.env, stored));
        return {
          dispatcharrUrl: config.DISPATCHARR_URL,
          dryRun: config.PODIUM_DRY_RUN,
          hasCredentials: config.hasCredentials,
        };
      })(),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}

export async function PUT(request: Request) {
  let store: Store | null = null;
  try {
    const patch = (await request.json()) as Record<string, unknown>;
    const { values, errors } = validateSettings(patch);
    if (errors.length > 0) {
      return NextResponse.json({ error: 'invalid settings', errors }, { status: 400 });
    }

    store = openStore();
    // Refuse a change that would leave the app unable to authenticate, rather
    // than accepting it and failing every run afterwards.
    const merged = { ...store.settings() };
    for (const [k, v] of Object.entries(values)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    const next = loadConfigSafely(merged);
    if (!next.ok) {
      return NextResponse.json({ error: next.message }, { status: 400 });
    }

    store.setSettings(values);
    return NextResponse.json({
      status: 'saved',
      fields: describeSettings(process.env, store.settings()),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}

/**
 * Would this patch leave the app unable to authenticate?
 *
 * `loadConfig` no longer refuses credential-less config -- it has to come up so
 * this page can be reached at all -- so the check that used to fall out of it
 * is made explicitly here. It is still on the *merged* result, so filling the
 * credentials in for the first time passes, and clearing the last one does not.
 */
function loadConfigSafely(stored: Record<string, string>): { ok: boolean; message: string } {
  try {
    requireCredentials(loadConfig(resolveEnv(process.env, stored)));
    return { ok: true, message: '' };
  } catch (error) {
    return {
      ok: false,
      message: String(error)
        .replace(/^Error:\s*/, '')
        .slice(0, 200),
    };
  }
}
