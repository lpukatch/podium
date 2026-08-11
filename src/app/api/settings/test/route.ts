import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { DispatcharrClient } from '@/lib/dispatcharr';
import { resolveEnv, validateSettings } from '@/lib/settings';
import { Store } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Try a connection with the settings as submitted, without saving them.
 *
 * Saving a bad URL or a stale key would leave every run failing with nothing
 * in the UI to say why -- the worker logs it and carries on. Better to find
 * out at the moment of typing.
 */
export async function POST(request: Request) {
  let store: Store | null = null;
  try {
    const patch = (await request.json()) as Record<string, unknown>;
    const { values, errors } = validateSettings(patch);
    if (errors.length > 0) {
      return NextResponse.json({ ok: false, error: errors[0]?.message ?? 'invalid' });
    }

    store = new Store(loadConfig().dbPath);
    // Overlay the candidate values on what is already stored: a test of "just
    // the URL" should still use the saved credential.
    const merged = { ...store.settings() };
    for (const [k, v] of Object.entries(values)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }

    let config: ReturnType<typeof loadConfig>;
    try {
      config = loadConfig(resolveEnv(process.env, merged));
    } catch (error) {
      return NextResponse.json({
        ok: false,
        error: String(error)
          .replace(/^Error:\s*/, '')
          .slice(0, 200),
      });
    }

    const client = new DispatcharrClient(
      config.DISPATCHARR_URL,
      {
        apiKey: config.DISPATCHARR_API_KEY,
        username: config.DISPATCHARR_USERNAME,
        password: config.DISPATCHARR_PASSWORD,
      },
      15_000,
    );
    await client.login();
    const providers = await client.providers();

    return NextResponse.json({
      ok: true,
      // Enough to prove it reached the right instance, not just something.
      providers: providers.map((p) => ({ name: p.name, maxStreams: p.maxStreams })),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error).slice(0, 200) });
  } finally {
    store?.close();
  }
}
