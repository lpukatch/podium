/**
 * The two addresses Podium is pointed at, and what they are allowed to be.
 *
 * Both API clients here are built the same way: a base URL from configuration,
 * a fixed API path appended, and `fetch` on the result. That is only safe if
 * the base really is a base -- and `${base}${path}` does not check. A base of
 *
 *     http://169.254.169.254/latest/meta-data#
 *
 * concatenates to `http://169.254.169.254/latest/meta-data#/api/v1/settings/...`
 * and everything after the `#` is dropped before the request goes out: the API
 * path Podium believes it is calling never arrives, and the request lands
 * wherever the author of the base chose. A `?` does the same by turning the
 * appended path into part of a query string.
 *
 * That matters because neither address is only ever set by the person at the
 * keyboard. Both are settable through `PUT /api/settings`, which on a default
 * install has no credential in front of it -- so a base URL is attacker-
 * reachable input, and the check belongs at the point of use rather than only
 * in the form that usually supplies it.
 *
 * What is deliberately *not* checked is where the host points. Podium's whole
 * job is talking to services on private addresses -- `http://dispatcharr:9191`,
 * `http://192.168.1.10:9195`, a Tailscale name -- so refusing private
 * destinations would refuse every correct configuration. The guarantee here is
 * narrower and keepable: whatever host is named, the request goes to the API
 * path Podium intended, over http(s), carrying no credential smuggled into the
 * URL itself.
 */

/**
 * Why this cannot be a base URL, as a phrase that follows "<name> URL", or
 * empty if it can.
 */
export function baseUrlProblem(raw: string): string {
  const text = raw.trim();
  if (!text) return 'is not configured';

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'must be a full URL including the scheme, e.g. http://host:9191';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'must be an http(s) URL';
  }
  // A base carrying either of these cannot have a path appended to it: the
  // fragment is dropped and the query swallows what follows. Refused rather
  // than quietly trimmed, because a URL with one in it is not the address of an
  // API and whoever typed it has the wrong thing in their clipboard.
  //
  // Tested against the raw text rather than `url.hash` and `url.search`, which
  // are both empty for a *trailing* `#` or `?` -- and a trailing `#` is the
  // whole trick, because the character only has to be there for what Podium
  // appends after it to become a fragment.
  if (text.includes('#')) return 'must not contain a "#" fragment';
  if (text.includes('?')) return 'must not contain a "?" query string';
  // Would be sent as an Authorization header to that host on every request,
  // from a field the UI shows in the clear and a backup carries. Podium has its
  // own fields for credentials.
  if (url.username || url.password) return 'must not contain a username or password';
  return '';
}

/**
 * The base URL an API client should use, or throw saying why it cannot.
 *
 * Rebuilt from the parsed URL rather than returned as typed, so nothing that
 * only survives because concatenation never looked -- a fragment, a query, a
 * credential, a trailing slash -- reaches the request below it.
 */
export function normaliseBaseUrl(raw: string, name: string): string {
  const problem = baseUrlProblem(raw);
  if (problem) throw new Error(`${name} URL ${problem}`);
  const url = new URL(raw.trim());
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}
