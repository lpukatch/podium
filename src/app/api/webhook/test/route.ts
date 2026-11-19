import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { readJson } from '@/lib/http-body';
import { createWebhook } from '@/lib/notify';
import { mergeForTest, resolveEnv, validateSettings } from '@/lib/settings';
import { Store } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const noopLog = (): void => {};

/**
 * Send the test event to a webhook URL, and say what answered.
 *
 * The notifications themselves are fire-and-forget by design -- `send` never
 * blocks the pass and never reports back -- which is the right bargain for a
 * channel that fires at three in the morning and the wrong one for somebody
 * sitting in the settings page wondering whether they typed the address
 * right. This is the synchronous twin: one fixed `test` event, awaited, with
 * the outcome in the response.
 *
 * The payload is fixed, but the destination is not, and a POST the server
 * makes on an attacker's say-so is an outbound request regardless -- the same
 * reasoning that gates the Teamarr and Dispatcharr tests. The bar is the
 * same idea: the install has already committed to a webhook URL in what is
 * saved or configured. There is no toggle to read here -- the URL being set
 * *is* the commitment -- so once any URL is saved, testing a replacement
 * before saving it is exactly the flow the button serves; the gate only
 * holds the very first URL. That state is read from saved settings and the
 * environment, NOT from this request's fields, which are exactly what a
 * drive-by POST controls. An operator typing a fresh URL into an install
 * that has none saved hits the gate; the message is written for them rather
 * than for an attacker.
 */
export async function POST(request: Request) {
  let store: Store | null = null;
  try {
    const parsed = await readJson<Record<string, unknown>>(request, undefined, {
      allowEmpty: true,
    });
    if (!parsed.ok) {
      return NextResponse.json({ ok: false, error: parsed.message }, { status: parsed.status });
    }
    const patch = parsed.value;
    const { values, errors } = validateSettings(patch);
    if (errors.length > 0) {
      return NextResponse.json({ ok: false, error: errors[0]?.message ?? 'invalid' });
    }

    store = new Store(loadConfig().dbPath);
    // Same overlay the other test routes use, so a URL typed into the form is
    // tested before it is saved rather than after.
    const { merged } = mergeForTest(store.settings(), values, process.env);

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

    const url = config.PODIUM_WEBHOOK_URL.trim();
    if (!url) {
      return NextResponse.json({
        ok: false,
        error: 'No webhook URL is set. Enter one above, then test.',
      });
    }

    let savedUrl = '';
    try {
      savedUrl = loadConfig(resolveEnv(process.env, store.settings())).PODIUM_WEBHOOK_URL.trim();
    } catch {
      // Stored settings that do not load close the gate: there is no
      // committed state to test against, whatever the patch carries.
      savedUrl = '';
    }
    if (!savedUrl) {
      return NextResponse.json({
        ok: false,
        needsSave: true,
        error:
          'No webhook URL is saved yet, and this is not one the install already uses, so ' +
          'there is nothing to test against. Save the URL first, then test.',
      });
    }

    const out = await createWebhook(() => config, noopLog).deliver({ event: 'test' });
    if (!out.ok) {
      return NextResponse.json({ ok: false, error: out.error ?? 'delivery failed' });
    }
    return NextResponse.json({ ok: true, url, status: out.status ?? null });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: String(error)
        .replace(/^Error:\s*/, '')
        .slice(0, 300),
    });
  } finally {
    store?.close();
  }
}
