/**
 * The front door. Every request passes through here before any route runs.
 *
 * The checks themselves are in `lib/access.ts`, which is pure and tested; this
 * file is the wiring: pull the headers out, read the policy from the
 * environment, and turn a refusal into a response.
 *
 * Deliberately environment-only. Nothing here reads the settings table, because
 * settings are editable through the API this is protecting -- a boundary you
 * can move from outside is not one. It is also why this cannot open the
 * database: the proxy runs on every request including static assets, and a
 * SQLite handle per request would cost more than everything it guards.
 *
 * In Next 16 a proxy always runs on the Node.js runtime, so `process.env` is
 * read per request rather than inlined at build time -- which matters, because
 * every one of these knobs arrives from `docker run -e` long after the image
 * was built.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { type AccessPolicy, checkAccess, parseHostList } from './lib/access';

/** The cookie the token lands in, so a browser only presents it once. */
const TOKEN_COOKIE = 'podium_token';

function policy(): AccessPolicy {
  return {
    allowedHosts: parseHostList(process.env.PODIUM_ALLOWED_HOSTS),
    token: (process.env.PODIUM_AUTH_TOKEN ?? '').trim(),
  };
}

/**
 * Headers worth setting on everything we do serve.
 *
 * `X-Frame-Options` is the one that earns its place: with no login, a page that
 * can frame the UI can drive it by clicks alone, and the ordering editor has an
 * Apply button in it.
 */
function harden(response: NextResponse): NextResponse {
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'same-origin');
  return response;
}

function refuse(status: number, message: string, path: string): NextResponse {
  const wantsJson = path.startsWith('/api/');
  const response = wantsJson
    ? NextResponse.json({ error: message }, { status })
    : new NextResponse(`${message}\n`, {
        status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
  if (status === 401) response.headers.set('WWW-Authenticate', 'Bearer realm="podium"');
  return harden(response);
}

export function proxy(request: NextRequest): NextResponse {
  const url = new URL(request.url);
  const { token } = policy();

  // `?token=...` is how a browser gets its first credential: there is no login
  // page to type it into, and asking people to set a cookie by hand is how a
  // feature ends up unused. Accepted once, moved into an HttpOnly cookie, and
  // stripped from the URL by the redirect so it stays out of history and out of
  // any link they paste later.
  const fromQuery = url.searchParams.get('token');
  if (token && fromQuery !== null) {
    const verdict = checkAccess(
      {
        method: request.method,
        path: url.pathname,
        host: request.headers.get('host'),
        origin: request.headers.get('origin'),
        secFetchSite: request.headers.get('sec-fetch-site'),
        credentials: [fromQuery],
      },
      policy(),
    );
    if (verdict.ok) {
      url.searchParams.delete('token');
      const response = NextResponse.redirect(url);
      response.cookies.set(TOKEN_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: url.protocol === 'https:',
        maxAge: 60 * 60 * 24 * 365,
      });
      return harden(response);
    }
    return refuse(verdict.status, verdict.message, url.pathname);
  }

  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const verdict = checkAccess(
    {
      method: request.method,
      path: url.pathname,
      host: request.headers.get('host'),
      origin: request.headers.get('origin'),
      secFetchSite: request.headers.get('sec-fetch-site'),
      credentials: [
        bearer,
        request.headers.get('x-podium-token') ?? '',
        request.cookies.get(TOKEN_COOKIE)?.value ?? '',
      ].filter(Boolean),
    },
    policy(),
  );

  if (!verdict.ok) {
    // One line, not a stack: a scanner hitting a public address should not be
    // able to fill the log, and the message is the whole story anyway.
    console.warn(
      `${new Date().toISOString()} refused ${request.method} ${url.pathname} (${verdict.reason}): ${verdict.message}`,
    );
    return refuse(verdict.status, verdict.message, url.pathname);
  }

  return harden(NextResponse.next());
}

export const config = {
  // Everything except the build's own static output. API routes are the point,
  // so unlike the usual matcher they are emphatically not excluded.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
