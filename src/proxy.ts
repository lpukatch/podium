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
import { type AccessPolicy, checkAccess, forwardedHostOf, parseHostList } from './lib/access';

/** The cookie the token lands in, so a browser only presents it once. */
const TOKEN_COOKIE = 'podium_token';

function policy(): AccessPolicy {
  return {
    allowedHosts: parseHostList(process.env.PODIUM_ALLOWED_HOSTS),
    token: (process.env.PODIUM_AUTH_TOKEN ?? '').trim(),
  };
}

/** Environment booleans, in the four spellings people actually type. */
function flag(raw: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase());
}

/**
 * What the browser asked for, as opposed to what arrived at this process.
 *
 * Behind a reverse proxy those differ, and both differences break something.
 * nginx's default is `proxy_set_header Host $proxy_host`, so Podium sees
 * `Host: 127.0.0.1:3456` while the browser sent `Origin: https://podium.example`
 * -- the origin check compares those two, finds they disagree, and refuses every
 * POST, PUT and DELETE with a 403 that blames a cross-site request. And the hop
 * from the proxy is plain http even when the browser's connection is TLS, so the
 * token cookie was set without `Secure` and the `?token=` redirect pointed back
 * at `http://`, downgrading the session that had just been established.
 *
 * `X-Forwarded-Host` and `X-Forwarded-Proto` answer both, and are trusted only
 * when `PODIUM_TRUST_PROXY` says to. That opt-in is the point: `Host` is
 * load-bearing against DNS rebinding precisely because a page cannot change it,
 * and these headers are ones any client can write. Behind a proxy that sets
 * them the proxy is the only thing that can reach Podium, so they are exactly
 * as trustworthy as it is -- which is the trade the operator makes by setting
 * the variable, and is why it is not the default.
 */
function clientView(
  request: NextRequest,
  url: URL,
): { host: string | null; https: boolean; authority: string } {
  const host = request.headers.get('host');
  if (!flag(process.env.PODIUM_TRUST_PROXY)) {
    return { host, https: url.protocol === 'https:', authority: url.host };
  }
  const forwarded = (request.headers.get('x-forwarded-host') ?? '').split(',')[0]?.trim() ?? '';
  const forwardedProto = (request.headers.get('x-forwarded-proto') ?? '').split(',')[0]?.trim();
  return {
    // Without the port, which is what the host rules compare.
    host: forwardedHostOf(forwarded) ?? host,
    https: forwardedProto ? forwardedProto.toLowerCase() === 'https' : url.protocol === 'https:',
    // With it, because this one goes back out as an address the browser has to
    // be able to reach: `request.url` is built from the `Host` header, so a
    // proxy that rewrote it would otherwise have Podium redirect the browser to
    // the upstream address it cannot see.
    authority: forwarded || url.host,
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
  const client = clientView(request, url);
  const fromQuery = url.searchParams.get('token');
  if (token && fromQuery !== null) {
    const verdict = checkAccess(
      {
        method: request.method,
        path: url.pathname,
        host: client.host,
        origin: request.headers.get('origin'),
        secFetchSite: request.headers.get('sec-fetch-site'),
        credentials: [fromQuery],
      },
      policy(),
    );
    if (verdict.ok) {
      url.searchParams.delete('token');
      // Redirect to the scheme the *browser* is on. Behind a TLS-terminating
      // proxy this process only ever sees http, and sending the browser there
      // drops it out of HTTPS at the exact moment it is being handed a
      // credential.
      if (client.https) url.protocol = 'https:';
      // Port cleared first: the `host` setter only writes a port when the value
      // it is given carries one, so assigning "podium.example.com" over
      // "127.0.0.1:3456" would keep the 3456 and send the browser to a port the
      // proxy does not listen on.
      url.port = '';
      url.host = client.authority;
      const response = NextResponse.redirect(url);
      response.cookies.set(TOKEN_COOKIE, token, {
        httpOnly: true,
        // `lax`, not `strict`: strict drops the cookie on any cross-site
        // navigation, so following a bookmark or a link from another page would
        // land on a logged-out Podium and there is no login form to recover
        // with. Writes do not rely on the cookie being withheld -- Sec-Fetch-Site
        // and Origin refuse a cross-site POST whether or not it carries one.
        sameSite: 'lax',
        path: '/',
        // False on a plain-http install, where a Secure cookie would be set and
        // then silently never sent back.
        secure: client.https,
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
      host: client.host,
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
