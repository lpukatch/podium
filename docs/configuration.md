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
| `PODIUM_IDLE_MAX_MS` | `1800000` | longest sleep when nothing is due; [see below](#when-there-is-nothing-to-do) |
| `PODIUM_LIVE_TTL_MS` | `86400000` | how long a working stream is trusted |
| `PODIUM_DEAD_TTL_MS` | `10800000` | how soon a stream that *just* died is rechecked |
| `PODIUM_DEAD_TTL_MAX_MS` | `86400000` | ceiling once that has backed off; [see below](#when-there-is-nothing-to-do) |
| `PODIUM_UNKNOWN_BITRATE_TTL_MS` | `1800000` | how soon an alive-but-unmeasured stream is tried again; [see below](#streams-whose-bitrate-never-resolved) |
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
| `PODIUM_AUTO_ASSIGN` | `true` | lets a pass put matched streams onto channels that do not carry them; `false` is reorder-only |
| `PODIUM_AUTO_ASSIGN_MAX` | `10` | ceiling on how many matched streams a channel may gain this way |

### Auto-assign

An alias names the streams a channel should be ranked on. With
`PODIUM_AUTO_ASSIGN` on — the default — it also names the streams a channel
should *carry*: write a flat `ESPN` alias, add a provider, and on the next pass
its ESPN streams join the channel in rank order.

With it off, an alias only ever **reorders** what Dispatcharr already put on the
channel. A stream the alias matched but the channel does not carry stays a
ranking candidate that podium probes and then discards from the write, which
makes adding a provider a two-step job: wire its streams onto channels in
Dispatcharr, then let podium rank them.

> **Upgrading?** This defaults on, so the first pass after an upgrade may add
> streams to channels. Nothing is removed and no channel goes past the cap, but
> lineups do change. Set `PODIUM_AUTO_ASSIGN=false` to keep the old behaviour,
> or turn it off on the settings page.

What it will and will not do:

- **Only usable streams.** A candidate is assigned only if its verdict passes
  the same `isUsable` bar the ranker uses — alive, not a black screen, not
  under the bitrate floor. Dead candidates still get ranked (they have to, to
  sink) but are never added.
- **Only up to the cap.** `PODIUM_AUTO_ASSIGN_MAX` counts the matched streams a
  channel ends up carrying. A channel already at or over it gains nothing.
- **Never removes anything.** The cap limits additions only; lowering it will
  not unassign streams a channel already has. Dropping streams remains
  `PODIUM_REMOVE_UNMATCHED`'s job.
- **Never resurrects a manual removal.** Taking a stream off a channel through
  the unassign endpoint records the decision, and no later pass assigns it back
  to that channel. Without that the button would be useless with this on.
- **Nothing under `PODIUM_DRY_RUN`.** Same as every other write.

The risk is a loose alias. `ESPN` also matches ESPN2 and ESPN Deportes, and with
auto-assign on that claim becomes a write rather than a discarded candidate. The
cap and the usable-only rule bound the damage, but they do not make a wrong
alias right — check a channel or two in the UI before turning this on across an
install. `podium_streams_assigned_total` counts what it has done, and every
assignment is logged with the stream ids and their providers.
| `PODIUM_WRITE_STATS` | `true` | publish results to Dispatcharr `stream_stats` |

## Concurrency

| Variable | Default | Notes |
| --- | --- | --- |
| `PODIUM_MAX_CONCURRENT_PROBES` | `6` | ceiling across all lanes; `0` removes it |

## Metrics

`/api/metrics` serves Prometheus text format, derived from the database on each
scrape. The per-provider families are always present once a pass has written a
catalogue snapshot.

| Variable | Default | Notes |
| --- | --- | --- |
| `PODIUM_METRICS_CHANNELS` | `true` | also expose the per-channel source series — every managed channel's slots with provider and verdict; the only families that scale with the catalogue, so the switch exists for a Prometheus watching its cardinality |

### Comparing providers

| Family | Labels | What it says |
| --- | --- | --- |
| `podium_provider_streams` | `provider`, `state` | distinct managed streams by verdict: `alive` (would rank as usable), `dead`, `black`, `low_bitrate`, `unmeasured` |
| `podium_provider_dead_streams` | `provider`, `reason` | why the dead ones died — `auth`, `not_found`, `server_error`, `timeout`, `unreachable`, `unsupported`, `rejected`, `probe_error`, `other` |
| `podium_provider_resolution_streams` | `provider`, `resolution` | distinct streams by measured height, whether or not usable |
| `podium_provider_bitrate_kbps` | `provider`, `resolution`, `stat` | median measured bitrate, overall (`resolution="all"`) and per bucket |
| `podium_provider_bitrate_measured` | `provider` | how many of those medians rest on a real measurement |
| `podium_provider_score` | `provider`, `stat` | median podium score over the provider's usable streams — the same 0..1 the ranker uses |
| `podium_provider_verdict_age_seconds` | `provider`, `stat` | how old the verdicts above are |
| `podium_provider_channels` | `provider` | distinct channels the provider appears on, at any slot |
| `podium_provider_rank1_channels` | `provider` | channels where it holds slot 0 |
| `podium_provider_rank1_healthy` | `provider` | of those, how many rank as usable |

The headline ratio is win rate, which needs the coverage denominator:

```promql
podium_provider_rank1_channels / podium_provider_channels
```

Against the total channel count instead, you would be measuring how big a
provider's catalogue is rather than how good its streams are.

Three things to hold in mind when reading these:

- **Check the ages first.** A lane pinned at its provider's `max_streams` gets
  round-tripped least often, so the providers you most want to judge carry the
  stalest verdicts. `podium_provider_verdict_age_seconds` is the only family
  that distinguishes "this provider looks excellent" from "this provider has
  not been checked since Tuesday".
- **Bitrate is only comparable within a resolution.** 4500 kbps is generous at
  720p and thin at 1080p, so `resolution="all"` scores a provider partly on its
  channel mix. Compare like buckets.
- **The population is survivors.** The catalogue holds only streams currently
  assigned to a channel, and podium removes streams itself — via
  `PODIUM_REMOVE_UNMATCHED` and the unassign endpoint. A provider's dead rate is
  therefore suppressed by however much cleanup it has already had. These
  families answer "best among the streams that are still in play", not "best
  supplier in the abstract".

`probe_error` on `podium_provider_dead_streams` is deliberately its own bucket:
a missing ffprobe or an unparseable payload is a local failure, and folding it
in with the rest would make whichever provider happened to be probed at the
time look broken.

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

**The loop sleeps until the answer could actually differ.** When a pass probes
nothing, changes nothing, defers nothing and has nothing left it could probe,
the next one is scheduled for the earlier of two instants: when the earliest
verdict *it could act on* falls due, and when the earliest channel it held back
turns eligible. Both come from the pass itself, not from the cache: a verdict on
an excluded channel expires like any other and is never refreshed, so a
cache-wide answer would wake the loop every few minutes for work that does not
exist.

The second instant is what a gated group contributes, and the EPG window is
what makes it knowable. Podium reads `/api/epg/grid/`, which carries roughly a
day ahead, so the same rows answer both "what is airing" and "when does the next
event start". A channel waiting on kickoff opens at its programme's start plus
the grace period; one showing a countdown block opens when the next programme
marked *live* begins, plus that same grace. Both are exact times, so the loop
waits for them rather than polling towards them.

A group with `require_live` off is gated on start times alone, so it takes the
next start of anything rather than the next live one. A channel the window lists
no upcoming programme for cannot be dated at all, and falls back to when the
next grid arrives (`PODIUM_EPG_TTL_MS`) — nothing before that can change its
answer.

Every sleep is capped by `PODIUM_IDLE_MAX_MS`, half an hour by default. The cap
only ever *shortens* a sleep, so it cannot make a channel probe late — a kickoff
further out than the cap costs one extra pass, which finds the channel still
held back and goes straight back to sleep until the kickoff itself. What the cap
is really for is the one thing neither the EPG nor the cache can announce: a
stream the provider has just added, which it will then measure within the cap
rather than immediately.

Raise it if you would rather have fewer passes than prompt discovery of new
streams; an hour lines it up with `PODIUM_EPG_TTL_MS`, which is the longest
anything else here waits.

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

## Streams whose bitrate never resolved

ffprobe declares no `bit_rate` on most live TS/HLS, so the number comes from the
short ffmpeg sample instead. When that sample does not land — disabled, timed
out, or empty — the verdict is "alive, 0kbps", which means *not measured* rather
than *delivers nothing*. The check panel shows these as **bitrate unknown**.

Two things follow from that:

**They are not treated as dead.** `PODIUM_MIN_BITRATE_KBPS` deliberately ignores
a zero, because a floor cannot judge a reading that was never taken.

**They rank behind every stream that does have a reading.** Scoring alone gets
this wrong: the bitrate term goes to zero, which costs the stream only its
weight, leaving an unmeasured 1080p50 feed above a 720p25 one measured at
2667kbps on resolution and fps alone. So ranking sinks an unmeasured stream
below anything measured, within whatever the ordering mode has already decided —
provider tiers and alias step order still come first, since those are explicit
curation and a missing measurement is no reason to overrule them.

The score shown next to such a stream is still its real score, which is why it
can read higher than the rows above it. That is the ranking saying "not proven",
not the score being wrong.

Because a demoted stream might genuinely be the best on its channel,
`PODIUM_UNKNOWN_BITRATE_TTL_MS` (30 minutes by default) expires its verdict
early so the next pass tries to measure it again, rather than leaving it parked
at the bottom for the full `PODIUM_LIVE_TTL_MS`. It can only ever shorten a live
verdict; set it to `0` to disable and let these expire with everything else.

If a stream is *persistently* unmeasurable, raising `PODIUM_ANALYZE_SECONDS` or
the probe timeout is the real fix — a short TTL alone will just re-probe it
every half hour to the same result.
