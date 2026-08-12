# Configuration

All environment variables. Everything here changes run time or correctness.

Everything on this list can also be set in **Settings**, which is stored and
wins over the environment. Podium starts with no credentials at all and says
so — the settings page is how you enter them, so it cannot be behind a process
that refused to boot without them. Passes wait quietly until they are there.

![The Settings page, showing what Podium is allowed to change and the pacing
knobs](images/settings.png)

A value still coming from the environment is labelled `from environment`, and
clearing a field in the UI hands it back — so a setting you changed once and
forgot cannot silently shadow the environment you thought you were running.

- [Connecting to Dispatcharr](#connecting-to-dispatcharr)
- [Who can reach it](#who-can-reach-it)
- [Pacing](#pacing)
- [Probing](#probing)
- [Writing back](#writing-back)
- [Concurrency](#concurrency)
- [When there is nothing to do](#when-there-is-nothing-to-do)

## Connecting to Dispatcharr

| Variable | Default | Notes |
| --- | --- | --- |
| `DISPATCHARR_URL` | `http://dispatcharr:9191` | |
| `DISPATCHARR_API_KEY` | — | required, unless username/password |
| `DISPATCHARR_USERNAME` / `_PASSWORD` | — | JWT auth instead of an API key |
| `PODIUM_DATA_DIR` | `/app/data` | rules file, probe cache, run history |
| `PODIUM_ENABLE_WEB` / `_WORKER` | `true` | run the halves separately |
| `PORT` | `3456` | UI and API; 3000 is too crowded a default to sit on |

## Who can reach it

| Variable | Default | Notes |
| --- | --- | --- |
| `PODIUM_ALLOWED_HOSTS` | — | extra hostnames Podium will answer to |
| `PODIUM_AUTH_TOKEN` | — | require a shared token on every request |

Podium has no login, because a tool that manages one Dispatcharr on your own
network does not need accounts. It does need to be sure a request came from
*you*, and there are two ways it can be reached without being on your network at
all — both through a browser you already trust.

**Cross-site requests are refused.** Every write here is a JSON `POST` or `PUT`,
and nothing about being on a LAN stops a page you happen to be visiting from
sending one to `http://podium.lan:3456` — your browser is on the LAN. Podium
rejects any write whose `Origin` or `Sec-Fetch-Site` says it came from
somewhere else. This needs no configuration and cannot break a normal install.

**Unexpected hostnames are refused.** The other route in is DNS rebinding: an
attacker's domain answers first with their address, then with yours, and the
page that was loaded from it can then talk to Podium as its own origin. The
`Host` header is the part that cannot be faked, so Podium only answers to names
that cannot be pointed at you from outside:

- `localhost`, and any single-label name — `http://podium:3456` between
  containers, or a short Kubernetes service name. A rebinding attack needs a
  registrable domain, and every one of those has a dot in it.
- Loopback and private addresses: `127.0.0.0/8`, `10/8`, `172.16/12`,
  `192.168/16`, `169.254/16`, `100.64/10` (which is every Tailscale address),
  `::1`, `fc00::/7`, `fe80::/10`.
- Anything under `.local`, `.lan`, `.home`, `.home.arpa`, `.internal`,
  `.localdomain`, `.localhost` or `.ts.net`.

If you reach Podium at a real hostname — behind Caddy, Traefik, nginx, an
Ingress — name it, or it gets a 403 that says exactly this:

```sh
PODIUM_ALLOWED_HOSTS="podium.example.com"
```

Several are comma-separated, a leading dot is a subdomain wildcard
(`.example.com`), and `*` disables the check entirely.

**A token, if you have put it on the internet.** Setting `PODIUM_AUTH_TOKEN`
makes every request carry it: `Authorization: Bearer <token>`, an
`X-Podium-Token` header, or the `podium_token` cookie. Visiting
`http://podium.lan:3456/?token=<token>` once puts it in that cookie and takes it
back out of the URL, which is how you log a browser in without a login page.
`/api/health` is exempt so the container's own health check still works;
`/api/metrics` is not, so give Prometheus a `bearer_token`.

Both of these are environment-only, and deliberately not on the Settings page: a
boundary you can move through the API it protects is not a boundary. None of it
is a substitute for not exposing Podium — it can reorder your channels and it
holds a Dispatcharr credential.

## Pacing

| Variable | Default | Notes |
| --- | --- | --- |
| `PODIUM_MAX_AGE_MS` | `86400000` | freshness target; the UI shows this in minutes |
| `PODIUM_TICK_MS` | `60000` | how often a pass is considered, not how long one takes |
| `PODIUM_IDLE_MAX_MS` | `900000` | longest sleep when nothing is due; [see below](#when-there-is-nothing-to-do) |
| `PODIUM_LIVE_TTL_MS` | `86400000` | how long a working stream is trusted |
| `PODIUM_DEAD_TTL_MS` | `10800000` | how soon a stream that *just* died is rechecked |
| `PODIUM_DEAD_TTL_MAX_MS` | `86400000` | ceiling once that has backed off; [see below](#when-there-is-nothing-to-do) |
| `PODIUM_PAUSE_WHEN_WATCHING` | `true` | stop while anyone is streaming |

## Probing

| Variable | Default | Notes |
| --- | --- | --- |
| `PODIUM_ANALYZE_SECONDS` | `6` | biggest lever on run time |
| `PODIUM_MIN_BITRATE_KBPS` | `500` | below this counts as dead |
| `PODIUM_DETECT_BLACK` | `true` | black-screen detection |

## Writing back

| Variable | Default | Notes |
| --- | --- | --- |
| `PODIUM_DRY_RUN` | `true` | never writes while set; set `false` to let it reorder |
| `PODIUM_REMOVE_UNMATCHED` | `false` | `true` unassigns unclaimed streams |
| `PODIUM_WRITE_STATS` | `true` | publish results to Dispatcharr `stream_stats` |

## Concurrency

| Variable | Default | Notes |
| --- | --- | --- |
| `PODIUM_MAX_CONCURRENT_PROBES` | `6` | ceiling across all lanes; `0` removes it |

Lane limits come from each provider's own `max_streams` in Dispatcharr. There
is no override: a second place to set the limit could only ever disagree with
the one the provider actually enforces.

`PODIUM_MAX_CONCURRENT_PROBES` is a different question and needs its own knob.
The lane limits protect the *providers*; peak concurrency is their sum, so
adding a provider raises how much of the *machine* a pass uses with nothing
bounding it. Every probe in flight is an ffprobe and an ffmpeg decoding video —
about 100MiB each at 1080p — which is how a 2GiB container gets OOM-killed at
nine concurrent.

## When there is nothing to do

A pass fetches every channel and stream from Dispatcharr, so once the cache is
warm, considering one every minute is load whose only possible answer is
"nothing is due". Three things keep a settled install quiet.

**A reorder that would not change anything is not written.** The computed order
is compared with the one Dispatcharr already holds, and an identical list is
skipped. Without this, a managed channel takes a PATCH every minute forever, and
every pass reports having reordered everything.

**The loop sleeps until something actually expires.** When a pass probes nothing,
changes nothing and defers nothing, the next one is scheduled for when the
earliest verdict *it could act on* falls due. That number comes from the pass
itself, not from the cache: a verdict on an excluded channel expires like any
other and is never refreshed, so a cache-wide answer would wake the loop every
few minutes for work that does not exist. Capped by `PODIUM_IDLE_MAX_MS` so a
stream the provider added is still picked up. Anything held back for a reason
that resolves with the clock (waiting on kickoff or on EPG) keeps the normal
cadence.

**A stream that stays dead is asked less often.** A dead verdict starts at
`PODIUM_DEAD_TTL_MS` and doubles per consecutive dead verdict, up to
`PODIUM_DEAD_TTL_MAX_MS` — 3h, 6h, 12h, 24h by default. A stream that has only
just dropped out is still rechecked as promptly as ever, because its streak is
1; one that has failed every check for a week is not. Any alive verdict resets
it.

That backoff is what makes the idle sleep above actually happen. Permanently
dead streams — HTTP 4XX and "Invalid data found", not flapping — are a
surprisingly large share of all probing, and without a backoff a handful of them
come due every minute or two. The backlog is then never empty, so the loop never
takes its idle sleep and runs at the minimum tick around the clock, crawling the
full catalogue to find a median of about two due streams.

Set `PODIUM_DEAD_TTL_MAX_MS` equal to `PODIUM_DEAD_TTL_MS` to turn the backoff
off.
