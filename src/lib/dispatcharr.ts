/**
 * Dispatcharr API client.
 *
 * Endpoint shapes were taken from a live instance, not from documentation:
 *
 *     POST  /api/accounts/token/        {access, refresh} JWT pair
 *     GET   /api/channels/channels/     paged {count,next,results}; results carry
 *                                       an *ordered* `streams: [id, ...]`
 *     GET   /api/channels/streams/      paged; name, url, m3u_account, stream_hash
 *     GET   /api/channels/groups/       paged
 *     GET   /api/m3u/accounts/          carries max_streams -- the lane limits --
 *                                       and profiles, the account's extra logins
 *     POST  /api/epg/current-programs/  real programmes airing now (skips dummy EPG)
 *     GET   /proxy/ts/status            {channels: [...], count} -- who is watching
 *     PATCH /api/channels/channels/{id}/  reorder by writing `streams`
 */

export const PAGE_SIZE = 500;
/**
 * Bounded, not unbounded. Dispatcharr is Django behind a small worker pool:
 * firing all 43 remaining stream pages at once queues them *and* adds
 * contention, measured ~10x slower than fetching serially. A handful in flight
 * is the sweet spot -- this took a cold load from 117s to under 4s.
 */
export const PAGE_CONCURRENCY = 4;

export interface Channel {
  id: number;
  uuid?: string;
  name: string;
  tvgId: string;
  /** Ordered. Writing this array back is what reorders the channel. */
  streams: number[];
  groupId: number | null;
  hidden_from_output?: boolean;
}

/** Raw channel row from Dispatcharr, before the effective_* aliases are folded. */
interface ChannelRow {
  id: number;
  uuid?: string;
  name?: string;
  effective_name?: string;
  tvg_id?: string;
  effective_tvg_id?: string;
  streams?: number[];
  channel_group_id?: number | null;
  effective_channel_group_id?: number | null;
  hidden_from_output?: boolean;
}

export interface Group {
  id: number;
  name: string;
}

export interface Stream {
  id: number;
  name: string;
  url: string;
  providerId: number;
  /**
   * The only meaningful change signal. `updated_at` is useless here -- the M3U
   * refresh bumps it on every stream every few minutes.
   */
  streamHash: string;
  currentViewers: number;
  /**
   * The provider group the stream was imported under, from the M3U's
   * `group-title`. Same table as a channel's group -- Dispatcharr keeps one
   * group list for both -- but in practice a group holds one or the other.
   */
  groupId: number | null;
  is_stale?: boolean;
}

/**
 * One login under an M3U account -- a "profile" in Dispatcharr.
 *
 * The stored stream URL carries the *default* profile's credentials; every
 * other profile reaches the same upstream by rewriting that URL with the
 * pattern pair, exactly as Dispatcharr does at playback.
 */
export interface ProviderProfile {
  id: number;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  /** That login's own connection cap; null = unset, callers fall back to the account max. */
  maxStreams: number | null;
  currentViewers: number;
  searchPattern: string;
  replacePattern: string;
}

export interface Provider {
  id: number;
  name: string;
  maxStreams: number;
  /**
   * The account's logins, including inactive ones -- `isActive` is the
   * caller's filter, not this mapping's, so an odd state (a disabled default,
   * say) stays visible rather than silently changing the variant count.
   */
  profiles: ProviderProfile[];
}

export class DispatcharrError extends Error {}

/**
 * Rewrite a stream URL with a profile's pattern pair, the way Dispatcharr does
 * at playback (`transform_url` in its live proxy).
 *
 * The patterns are authored JS-style -- `$1` and `$<name>` work in
 * `String.replace` natively -- and the `g` flag mirrors Python's `re.sub`,
 * which replaces every occurrence rather than just the first.
 *
 * Null means "no variant from this profile": an empty or invalid pattern is a
 * configuration error, not a request to probe the same URL twice. A pattern
 * that simply doesn't match returns the input unchanged, exactly as
 * Dispatcharr falls back; the caller's dedupe drops it there.
 */
export function transformUrl(
  url: string,
  searchPattern: string,
  replacePattern: string,
): string | null {
  if (!searchPattern) return null;
  let search: RegExp;
  try {
    search = new RegExp(searchPattern, 'g');
  } catch {
    return null;
  }
  try {
    return url.replace(search, replacePattern);
  } catch {
    // A replacement that throws is the same class of authoring error as a
    // pattern that does not compile.
    return null;
  }
}

export interface DispatcharrAuth {
  apiKey?: string;
  username?: string;
  password?: string;
}

interface Paged<T> {
  count?: number;
  next?: string | null;
  results?: T[];
}

/**
 * Whether a grid row is a real programme rather than one Dispatcharr generated.
 *
 * Real rows carry the integer primary key of the `program_data` row they came
 * from; the synthesised ones carry a string marker built from the channel and
 * the hour. Anything unrecognised is *kept*: an id shape nobody anticipated is
 * far more likely to be a real programme than a dummy, and dropping real rows
 * would silently stop every gated channel from ever being probed.
 */
function isRealProgramme(row: unknown): boolean {
  const id = (row as { id?: unknown })?.id;
  return !(typeof id === 'string' && id.startsWith('dummy-'));
}

/**
 * Keep only what the eligibility gate reads.
 *
 * The grid is ~8,900 rows carrying descriptions, sub-titles and artwork ids
 * that nothing here looks at, and the worker holds a parsed copy of the whole
 * thing between passes. Trimming at the door takes that from 3.7MB to 1.3MB on
 * a live install, and costs one pass over rows we are already walking.
 */
function trimProgramme(row: Record<string, unknown>): Record<string, unknown> {
  return {
    tvg_id: row.tvg_id,
    start_time: row.start_time,
    end_time: row.end_time,
    title: row.title,
    is_live: row.is_live,
  };
}

export class DispatcharrClient {
  private readonly base: string;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private authPromise: Promise<void> | null = null;
  private refreshPromise: Promise<boolean> | null = null;

  constructor(
    baseUrl: string,
    private readonly auth: DispatcharrAuth,
    private readonly timeoutMs = 60_000,
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    if (this.accessToken) {
      return { Authorization: `Bearer ${this.accessToken}`, Accept: 'application/json' };
    }
    const key = this.auth.apiKey ?? '';
    // Dispatcharr accepts either header depending on how the key was issued;
    // sending both is harmless and avoids a config knob nobody wants to set.
    return { 'X-API-Key': key, Authorization: `Api-Key ${key}`, Accept: 'application/json' };
  }

  /** Obtain a JWT pair. No-op when only an API key is configured. */
  async login(): Promise<void> {
    if (!this.auth.username || !this.auth.password) return;
    // Concurrent callers must share one login, or a burst of requests each
    // mints a token and the last writer wins.
    if (this.authPromise) return this.authPromise;

    this.authPromise = (async () => {
      const resp = await this.raw('POST', '/api/accounts/token/', {
        username: this.auth.username,
        password: this.auth.password,
      });
      if (!resp.ok) {
        throw new DispatcharrError(`login failed: ${resp.status} ${await resp.text()}`);
      }
      const body = (await resp.json()) as { access?: string; refresh?: string };
      if (!body.access) throw new DispatcharrError('login response had no access token');
      this.accessToken = body.access;
      this.refreshToken = body.refresh ?? null;
    })();

    try {
      await this.authPromise;
    } finally {
      this.authPromise = null;
    }
  }

  private async refresh(): Promise<boolean> {
    if (!this.refreshToken) return false;
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      const resp = await this.raw('POST', '/api/accounts/token/refresh/', {
        refresh: this.refreshToken,
      });
      if (!resp.ok) return false;
      const body = (await resp.json()) as { access?: string; refresh?: string };
      if (!body.access) return false;
      this.accessToken = body.access;
      if (body.refresh) this.refreshToken = body.refresh;
      return true;
    })();

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async raw(method: string, path: string, body?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.base}${path}`, {
        method,
        signal: controller.signal,
        headers: body ? { ...this.headers(), 'Content-Type': 'application/json' } : this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** A request that transparently refreshes an expired JWT once. */
  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    let resp = await this.raw(method, path, body);
    if (resp.status === 401 && (await this.refresh())) {
      resp = await this.raw(method, path, body);
    }
    return resp;
  }

  private async getJson<T>(path: string): Promise<T> {
    const resp = await this.request('GET', path);
    if (!resp.ok) {
      throw new DispatcharrError(
        `GET ${path} -> ${resp.status}: ${(await resp.text()).slice(0, 200)}`,
      );
    }
    return (await resp.json()) as T;
  }

  private page<T>(path: string, page: number): Promise<Paged<T> | T[]> {
    const join = path.includes('?') ? '&' : '?';
    return this.getJson<Paged<T> | T[]>(`${path}${join}page=${page}&page_size=${PAGE_SIZE}`);
  }

  /**
   * Fetch every page, the remaining ones at bounded concurrency.
   *
   * `count` from page 1 tells us exactly how many remain, so the rest can be
   * planned rather than walked one `next` link at a time.
   */
  async paged<T>(path: string): Promise<T[]> {
    const first = await this.page<T>(path, 1);
    if (Array.isArray(first)) return first;

    const out: T[] = [...(first.results ?? [])];
    if (!first.next) return out;

    if (typeof first.count !== 'number') {
      // No count to plan with -- fall back to walking `next` serially.
      let n = 2;
      for (;;) {
        const body = await this.page<T>(path, n);
        if (Array.isArray(body)) return [...out, ...body];
        out.push(...(body.results ?? []));
        if (!body.next) return out;
        n += 1;
      }
    }

    const lastPage = Math.ceil(first.count / PAGE_SIZE);
    const pending: number[] = [];
    for (let n = 2; n <= lastPage; n++) pending.push(n);

    const collected = new Map<number, T[]>();
    const workers = Array.from({ length: Math.min(PAGE_CONCURRENCY, pending.length) }, async () => {
      for (;;) {
        const n = pending.shift();
        if (n === undefined) return;
        const body = await this.page<T>(path, n);
        collected.set(n, Array.isArray(body) ? body : (body.results ?? []));
      }
    });
    await Promise.all(workers);

    // Reassemble in page order; provider stream order is meaningful upstream.
    for (let n = 2; n <= lastPage; n++) out.push(...(collected.get(n) ?? []));
    return out;
  }

  /** Fold Dispatcharr's effective_* aliases onto a plain Channel. */
  private mapChannel(row: ChannelRow): Channel {
    return {
      id: row.id,
      uuid: row.uuid ?? '',
      name: row.effective_name || row.name || '',
      tvgId: row.effective_tvg_id || row.tvg_id || '',
      streams: row.streams ?? [],
      groupId: row.effective_channel_group_id ?? row.channel_group_id ?? null,
    };
  }

  async channels(): Promise<Channel[]> {
    return (await this.paged<ChannelRow>('/api/channels/channels/')).map((row) =>
      this.mapChannel(row),
    );
  }

  /**
   * One channel, live, by id. Null when it no longer exists (404).
   *
   * The paged `channels()` is the cached catalogue the UI shares; a reorder or a
   * channel edit can land between its refreshes, so anything that must reflect
   * "right now" -- the undo order before a destructive write, or the A/B
   * comparison in a check -- reads the single channel through here instead.
   */
  async channel(channelId: number): Promise<Channel | null> {
    const resp = await this.request('GET', `/api/channels/channels/${channelId}/`);
    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw new DispatcharrError(
        `GET /api/channels/channels/${channelId}/ -> ${resp.status}: ${(await resp.text()).slice(
          0,
          200,
        )}`,
      );
    }
    return this.mapChannel((await resp.json()) as ChannelRow);
  }

  async streams(): Promise<Stream[]> {
    type Row = {
      id: number;
      name?: string;
      url?: string;
      m3u_account?: number | null;
      stream_hash?: string;
      current_viewers?: number;
      channel_group?: number | null;
    };
    const rows = await this.paged<Row>('/api/channels/streams/');
    const out: Stream[] = [];
    for (const row of rows) {
      if (!row.url) continue;
      out.push({
        id: row.id,
        name: row.name ?? '',
        url: row.url,
        providerId: row.m3u_account ?? 0,
        streamHash: row.stream_hash ?? '',
        currentViewers: row.current_viewers ?? 0,
        groupId: row.channel_group ?? null,
      });
    }
    return out;
  }

  async groups(): Promise<Group[]> {
    type Row = { id: number; name?: string };
    const rows = await this.paged<Row>('/api/channels/groups/');
    return rows.map((row) => ({ id: row.id, name: row.name || String(row.id) }));
  }

  async providers(): Promise<Provider[]> {
    type ProfileRow = {
      id: number;
      name?: string;
      is_default?: boolean;
      is_active?: boolean;
      max_streams?: number | null;
      current_viewers?: number;
      search_pattern?: string;
      replace_pattern?: string;
    };
    type Row = {
      id: number;
      name?: string;
      max_streams?: number | null;
      is_active?: boolean;
      profiles?: ProfileRow[];
    };
    const rows = await this.paged<Row>('/api/m3u/accounts/');
    return rows
      .filter((row) => row.is_active !== false)
      .map((row) => ({
        id: row.id,
        name: row.name || String(row.id),
        // 0 or null in Dispatcharr means "unlimited"; we still cap it, because an
        // unbounded lane just moves the bottleneck onto the network.
        maxStreams: row.max_streams ? Number(row.max_streams) : 4,
        profiles: (row.profiles ?? []).map((profile) => ({
          id: profile.id,
          name: profile.name || String(profile.id),
          isDefault: Boolean(profile.is_default),
          isActive: profile.is_active !== false,
          // Null is preserved rather than defaulted here: a profile cap of 0
          // means "use the account's cap", a decision the lane builder makes.
          maxStreams: profile.max_streams ? Number(profile.max_streams) : null,
          currentViewers: profile.current_viewers ?? 0,
          searchPattern: profile.search_pattern ?? '',
          replacePattern: profile.replace_pattern ?? '',
        })),
      }));
  }

  /**
   * The EPG window: what is airing and what is coming, for after_epg_start.
   *
   * This used to read `current-programs`, which returns only what is airing at
   * the instant it is called. That is unusable for a cached grid, and the bug
   * it caused was not subtle: a countdown block ending drops out of the cached
   * rows, the live programme that replaced it was never fetched, and the
   * channel reads "no EPG data" until the cache expires. Measured on a live
   * install, 38 gated channels were held back that way while their games had
   * been under way for 28 minutes. `grid` carries ~28 hours ahead, so the same
   * rows answer "what is airing" correctly at any instant inside the window --
   * and, for the first time, "when does the next programme start".
   *
   * **Generated dummies are dropped here, and that is load-bearing.** `grid`
   * synthesises programmes for channels with no EPG data and for sources of
   * type `dummy` -- four-hour filler blocks keyed by the channel uuid, which is
   * exactly what a tvg_id falls back to. Left in, they would open the gate on
   * every channel that has no real schedule, which is precisely what
   * after_epg_start exists to prevent. Dispatcharr builds them with a string id
   * (`dummy-standard-{channel}-{hour}`, `dummy-custom-{channel}-{hour}`) where a
   * real programme carries its integer row id, so the two are told apart
   * exactly rather than by shape. Filtering on the marker rather than on
   * `is_live` is deliberate: a *custom* dummy can set `live` true from a pattern
   * in the channel name, so the live flag does not catch them all.
   *
   * Falls back to `current-programs` if `grid` is unavailable, so an older
   * Dispatcharr keeps the behaviour it had rather than losing the gate.
   */
  async epgWindow(): Promise<Array<Record<string, unknown>>> {
    const resp = await this.request('GET', '/api/epg/grid/');
    if (resp.ok) {
      const body = (await resp.json()) as { data?: unknown } | unknown[];
      // `{data: [...]}` today; a bare array is accepted so a shape change on
      // Dispatcharr's side degrades to "fewer rows", never to a crash.
      const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
      if (rows) return rows.filter(isRealProgramme).map(trimProgramme);
    }

    const legacy = await this.request('POST', '/api/epg/current-programs/', {});
    if (!legacy.ok) return [];
    const body = await legacy.json();
    return Array.isArray(body) ? body.map(trimProgramme) : [];
  }

  /** Channel ids currently being streamed. Resolves UUIDs if uuidMap is provided. */
  async activeChannelIds(
    uuidMap?: Map<string, number> | Record<string, number>,
  ): Promise<number[]> {
    const resp = await this.request('GET', '/proxy/ts/status');
    if (!resp.ok) throw new DispatcharrError(`activity probe -> ${resp.status}`);
    const body = (await resp.json()) as { channels?: unknown[]; count?: number };
    const rawCount = Math.max(
      typeof body.count === 'number' ? body.count : 0,
      Array.isArray(body.channels) ? body.channels.length : 0,
    );
    const entries = Array.isArray(body.channels) ? body.channels : [];
    const ids: number[] = [];
    for (const entry of entries) {
      if (typeof entry === 'number') {
        ids.push(entry);
      } else if (typeof entry === 'string') {
        if (entry.trim() !== '' && !Number.isNaN(Number(entry))) {
          ids.push(Number(entry));
        } else if (uuidMap) {
          const mapped = uuidMap instanceof Map ? uuidMap.get(entry) : uuidMap[entry];
          if (typeof mapped === 'number') ids.push(mapped);
        }
      } else if (entry && typeof entry === 'object') {
        const row = entry as Record<string, unknown>;
        for (const key of ['channel_id', 'id', 'channel']) {
          const val = row[key];
          if (typeof val === 'number') {
            ids.push(val);
            break;
          } else if (typeof val === 'string') {
            if (val.trim() !== '' && !val.includes('-') && !Number.isNaN(Number(val))) {
              ids.push(Number(val));
              break;
            } else if (uuidMap) {
              const mapped = uuidMap instanceof Map ? uuidMap.get(val) : uuidMap[val];
              if (typeof mapped === 'number') {
                ids.push(mapped);
                break;
              }
            }
          }
        }
      }
    }
    if (rawCount > 0 && ids.length === 0) {
      throw new DispatcharrError(
        `active channel probe status payload had ${rawCount} active entry/entries but 0 channel IDs resolved`,
      );
    }
    return ids;
  }

  /**
   * Publish probe results to a stream's `stream_stats`.
   *
   * Must be sent as an object: passing a JSON *string* is accepted with a 200
   * and stored double-encoded, which then reads back as a string and breaks
   * anything parsing it.
   *
   * `stream_stats_updated_at` is sent alongside it. It is a plain DateTimeField,
   * not auto-updated on write, and Dispatcharr's channel table refreshes stats
   * through a delta endpoint keyed on it (`stream_stats_updated_at__gt=since`)
   * while the frontend store skips rows whose timestamp did not change. A write
   * that omits it lands in the column but nothing ever fetches it back -- so to
   * Dispatcharr's UI the stats looked stale or empty until the proxy happened to
   * touch the same stream.
   */
  async setStreamStats(streamId: number, stats: Record<string, unknown>): Promise<void> {
    const resp = await this.request('PATCH', `/api/channels/streams/${streamId}/`, {
      stream_stats: stats,
      stream_stats_updated_at: new Date().toISOString(),
    });
    if (!resp.ok) {
      throw new DispatcharrError(
        `PATCH stream ${streamId} stats -> ${resp.status}: ${(await resp.text()).slice(0, 200)}`,
      );
    }
  }

  async setStreamOrder(channelId: number, streamIds: number[]): Promise<void> {
    const resp = await this.request('PATCH', `/api/channels/channels/${channelId}/`, {
      streams: streamIds,
    });
    if (!resp.ok) {
      throw new DispatcharrError(
        `PATCH channel ${channelId} -> ${resp.status}: ${(await resp.text()).slice(0, 200)}`,
      );
    }
  }
}
