/**
 * Who is allowed to talk to this instance.
 *
 * Podium has no login, and for a single-tenant tool running next to Dispatcharr
 * on your own network that is the right shape. What it still needs is a
 * boundary against the two attacks that do not care whether you are on a
 * private network, because they arrive through a browser you already trust:
 *
 *   Cross-site requests. Every write here is a plain JSON POST/PUT, and
 *   `request.json()` does not require a JSON content-type -- so a page you
 *   happen to visit can POST to http://podium.lan:3456/api/state/reset or
 *   /api/apply/{id} with no CORS preflight to stop it. Nothing about being on
 *   a LAN prevents that; your browser is on the LAN.
 *
 *   DNS rebinding. An attacker's domain answers with their address once, then
 *   with yours. The page then reaches Podium as its *own* origin, so an Origin
 *   check sees nothing wrong -- but the Host header still says the attacker's
 *   domain, which is the part that cannot be faked.
 *
 * Hence two independent checks: cross-site requests are rejected by Origin and
 * Sec-Fetch-Site, and hosts Podium does not expect are rejected outright.
 * Neither needs credentials, so both work on a stock install that has never
 * been configured. `PODIUM_AUTH_TOKEN` is the separate, opt-in answer to
 * "I have deliberately put this on the internet".
 *
 * Everything here reads request headers only. It has to run before any route
 * opens the database or reaches Dispatcharr, and it must not depend on
 * settings -- which are editable through the very API it is protecting.
 */

/** Methods that change something. GET/HEAD are read-only across every route. */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Suffixes that cannot be registered by an attacker, so cannot be rebound.
 *
 * `.ts.net` is Tailscale's MagicDNS: publicly resolvable, but only ever to a
 * 100.64/10 address inside your own tailnet, and names under it are issued by
 * Tailscale rather than bought. It is how a lot of people reach a homelab.
 */
const PRIVATE_SUFFIXES = [
  '.localhost',
  '.local',
  '.lan',
  '.home',
  '.home.arpa',
  '.internal',
  '.localdomain',
  '.ts.net',
];

/**
 * The host, without its port and without IPv6 brackets.
 *
 * Returns null for an absent or empty header. A missing Host is not a rebinding
 * attack -- rebinding is a browser sending one -- so callers treat null as
 * allowed rather than as a failure.
 */
export function hostOf(header: string | null | undefined): string | null {
  const raw = (header ?? '').trim().toLowerCase();
  if (!raw) return null;

  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end === -1 ? null : raw.slice(1, end);
  }
  const colon = raw.indexOf(':');
  if (colon === -1) return raw;
  // More than one colon and no brackets is a bare IPv6 literal, not host:port.
  // Malformed in a Host header, but clients send it and it must not be read as
  // a hostname of "fe80" with a port of the rest.
  if (raw.indexOf(':', colon + 1) !== -1) return raw;
  return raw.slice(0, colon) || null;
}

/** The host an Origin header names, or null when there is no usable one. */
export function originHost(origin: string | null | undefined): string | null {
  const raw = (origin ?? '').trim();
  // "null" is a real Origin value: a sandboxed iframe or a redirected request.
  // It is opaque by definition and can never match, so treat it as a mismatch
  // rather than as an absent header.
  if (!raw || raw === 'null') return raw === 'null' ? '' : null;
  try {
    return hostOf(new URL(raw).host);
  } catch {
    return '';
  }
}

function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  // Digits only: Number(' 10') and Number('0x0a') both parse, and neither is
  // what a browser put in a Host header.
  if (!parts.every((p) => /^\d{1,3}$/.test(p))) return false;
  const [a, b] = parts.map(Number) as [number, number, number, number];
  if (parts.some((p) => Number(p) > 255)) return false;

  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  // 100.64/10, carrier-grade NAT -- and every Tailscale address.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIPv6(host: string): boolean {
  if (!host.includes(':')) return false;
  if (host === '::1' || host === '::') return true;
  // ::ffff:192.168.0.1 and friends: the v4 address is what actually routes.
  const tail = host.slice(host.lastIndexOf(':') + 1);
  if (tail.includes('.')) return isPrivateIPv4(tail);
  // fc00::/7 unique-local, fe80::/10 link-local.
  return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
}

/**
 * Is this a host Podium should answer to?
 *
 * The built-in set is everything that cannot be pointed at your machine from
 * the outside: loopback and private address literals, names under a suffix
 * nobody can register, and any single-label name. That last rule is what makes
 * `http://podium:3456` between containers and `http://podium` on a k8s cluster
 * work without configuration -- a rebinding attack needs a domain, and every
 * registrable domain has a dot in it.
 *
 * A public name is not refused because it is dangerous in itself; it is refused
 * because Podium cannot tell it apart from an attacker's. Naming it in
 * `PODIUM_ALLOWED_HOSTS` is the whole fix.
 */
export function isAllowedHost(host: string | null, allowed: string[] = []): boolean {
  if (host === null) return true;

  for (const entry of allowed) {
    if (entry === '*') return true;
    if (entry === host) return true;
    // A leading dot is a suffix rule: ".example.com" covers any subdomain, but
    // deliberately not "example.com" itself, which has to be listed if wanted.
    if (entry.startsWith('.') && host.endsWith(entry)) return true;
  }

  if (host === 'localhost') return true;
  if (!host.includes('.') && !host.includes(':')) return true;
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return isPrivateIPv4(host) || isPrivateIPv6(host);
}

/** Split a comma or space separated env list into lowercase entries. */
export function parseHostList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => hostOf(entry) ?? entry);
}

/**
 * Compare without leaking the answer through timing.
 *
 * Overkill against a LAN attacker who can just try again, but the token is a
 * shared secret with no rate limit in front of it, and this is four lines.
 */
export function secretEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface AccessRequest {
  method: string;
  /** Path only, no query. Used to exempt the container health check. */
  path: string;
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
  /** Every credential the request presented: header, cookie, query. */
  credentials?: string[];
}

export interface AccessPolicy {
  /** Extra hosts to accept, on top of the built-in private set. */
  allowedHosts: string[];
  /** Empty means no token is required. */
  token: string;
}

export type AccessVerdict =
  | { ok: true }
  | { ok: false; status: number; reason: 'host' | 'cross-site' | 'token'; message: string };

/**
 * Paths that answer before any check but the host one.
 *
 * Only the container's own health probe. It reports "the web process replied"
 * plus a worker heartbeat age, which is nothing an attacker wants and exactly
 * what Docker and Kubernetes need -- and a probe that cannot carry a token
 * would otherwise mark a token-protected install unhealthy and restart it
 * forever. Metrics are *not* here: they describe your library, and Prometheus
 * can send an Authorization header.
 */
const TOKEN_EXEMPT = new Set(['/api/health']);

export function checkAccess(request: AccessRequest, policy: AccessPolicy): AccessVerdict {
  // Normalised here rather than at the call site: the caller has a raw Host
  // header, which carries the port -- and "127.0.0.1:3456" matches none of the
  // rules below, so leaving this to the caller means the checks quietly refuse
  // everything the moment one forgets.
  const host = hostOf(request.host);
  if (!isAllowedHost(host, policy.allowedHosts)) {
    return {
      ok: false,
      status: 403,
      reason: 'host',
      message:
        `Refusing a request for host "${host}". Podium only answers to private ` +
        `addresses and names by default, which is what stops a hostile site from ` +
        `reaching it through your browser. If you reach Podium at this name on ` +
        `purpose, set PODIUM_ALLOWED_HOSTS="${host}".`,
    };
  }

  if (UNSAFE_METHODS.has(request.method.toUpperCase())) {
    const site = request.secFetchSite;
    // Sent by every current browser and by nothing else, so its absence is not
    // evidence either way -- the Origin check below is what covers that case.
    // "same-site" is refused along with "cross-site": a different port or
    // subdomain is a different application, and on a homelab box it is often
    // one you did not write.
    if (site && site !== 'same-origin' && site !== 'none') {
      return {
        ok: false,
        status: 403,
        reason: 'cross-site',
        message: `Refusing a ${site} ${request.method} request. Podium only accepts writes from its own pages.`,
      };
    }

    const from = originHost(request.origin);
    // Compared by hostname, not by full origin: behind a reverse proxy the
    // Origin carries the public scheme and port while the Host header carries
    // whatever the proxy forwarded, and requiring those to agree would reject
    // every proxied install. A browser that can send a matching hostname from
    // another origin has already lost to Sec-Fetch-Site above.
    if (from !== null && host !== null && from !== host) {
      return {
        ok: false,
        status: 403,
        reason: 'cross-site',
        message: `Refusing a ${request.method} request from origin "${request.origin}". Podium only accepts writes from its own pages.`,
      };
    }
  }

  if (policy.token && !TOKEN_EXEMPT.has(request.path)) {
    const presented = request.credentials ?? [];
    if (!presented.some((candidate) => secretEquals(candidate, policy.token))) {
      return {
        ok: false,
        status: 401,
        reason: 'token',
        message: 'PODIUM_AUTH_TOKEN is set and this request did not carry it.',
      };
    }
  }

  return { ok: true };
}
