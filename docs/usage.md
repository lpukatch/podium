# Usage

How to tell Podium which streams belong to which channel, and what to leave
alone. For environment variables and tuning, see
[configuration.md](configuration.md).

- [Matching](#matching)
  - [Sections](#sections)
- [Groups](#groups)
  - [Provider stream groups](#provider-stream-groups)
  - [Channel groups](#channel-groups)
- [Ranking](#ranking)
- [Importing existing rules](#importing-existing-rules)

## Matching

Channels claim streams by **alias** — the plain channel name:

```
Movie Network East
```

Casing, accents, `USA:` prefixes, `FHD H265` suffixes and unicode decoration are
normalised away centrally, so an alias is just a name. Order is preference.

There are four layers, in descending order of how often you should reach for
them:

| layer | when to use it |
| --- | --- |
| **Alias** | The channel name. What you want almost always. |
| **Contains** | Whole-word substring, for a call sign buried in a longer name. Looser, and it will claim more than you expect — prefer an alias where one works. |
| **Exclude** | Reject a name — or one quality variant of it — even if an alias matches. |
| **Regex** | An escape hatch for what the first three cannot express. |

The UI shows what each rule matches *as you type*, alongside what Dispatcharr
currently has assigned, so you can see what a change would actually do. This is
the fastest way to find out that a `contains` you were about to save claims half
a category.

![The rules editor for one channel, with its aliases and every stream they match](images/rules-editor.png)

Each matched stream carries its last verdict — resolution, measured bitrate and
how long ago it was checked — so the cost of a rule change is visible in the
same place you make it. `new` is a stream your rules claim that Dispatcharr has
not been given yet; it stays unwritten until you save.

A stream the channel carries but no rule claims is marked `NOT MATCHED`, and has
the two answers next to it: **+ alias** claims it, **✕** takes it off the channel
in Dispatcharr. The ✕ writes immediately — it removes that one stream and leaves
the order of the rest exactly as Dispatcharr has it. Podium never assigns, so
putting one back is a job for Dispatcharr. To clear several at once, use the
tick under **Check now** instead, which removes everything the rule does not
claim as part of applying the new order.

## Sections

Normalising `AU:` and `US:` away is right until the prefix *is* the difference.
`AU: Sports Alpha` and `US: Sports Alpha` carry different events; a `FAST:` copy
of a network is usually a free ad-supported feed rather than the linear channel.
A bare alias claims all of them.

Qualify it with `@`:

```
@AU Sports Alpha           only streams whose prefix is AU
@!FAST News Central        any News Central except the FAST: ones
@US @USA Sports Alpha 1    either prefix
@"US East" News Central    quote a multi-word prefix
```

Order is still preference, so "prefer the AU feed but take any other if there
is none" is two lines:

```
@AU Sports Alpha
Sports Alpha
```

Qualifiers — `@` here, and the `~` in [Quality variants](#quality-variants) —
work on `contains` and `exclude` too. A prefix you name explicitly
beats the region denylist — `@AU Sports Alpha` matches on a channel whose
`exclude_regions` holds `AU`, since naming it is the more specific instruction.

A prefix written the old way (`Radio: Coast FM`) is still just a name: the
prefix is normalised off both sides, exactly as before. Only `@` constrains.

`@` matches the **leading words** of a prefix, or of the name when the provider
never punctuated one — which matters because the same section often appears both
ways, and only the punctuated one has a separator for `normalize` to lift. A
qualifier is a section marker, so it stops at four words: `@` is not a second
spelling of an alias.

In the UI, **Find streams** lists the prefixes each name appears under with a
count — `AU ×3` `US ×5` — and clicking one adds the qualified alias. Searching a
word that sits *inside* a name offers the section chips rather than an alias,
because an alias there would be wrong.

## Quality variants

`@` answers the question at the front of a name. The tokens providers hang off
the **back** — `4K`, `H265`, `1080p`, `RAW`, `(Event Only)` — are the same
problem at the other end, and take a trailing `~`:

```
CNN ~4K            only the UHD copy
CNN ~!4K           any CNN except the UHD copy
CNN ~1080p         exactly that height
CNN ~hevc ~60fps   both, not either
```

Those tokens are the ones `normalize` lifts off the name, which is why they need
saying separately: "US: CNN 4K" and "US: CNN" both key as `CNN`, and that is the
whole reason one alias claims every variant.

Bracketed text is addressable the same way, and often it is the only thing there
is to name:

```
FS1 ~!"event only"    every FS1 except "FS1 4K (Event Only)"
ESPN ~!multi          not the "[HEVC Multi]" copy
~"event only"         the variant, whatever it is called
```

Brackets are stripped before a name is keyed — for decoration like `[Multi]`
that is right, and it is why an `exclude` of `FS1 (Event Only)` does **not** do
what it looks like: the bracket goes, the line means `FS1`, and the channel
matches nothing at all. Write the bracket as a `~` qualifier instead. A bracket
is matched whole *and* by word, because providers pack several tokens into one.

Unlike the quality words, bracket text is **not** in the bare vocabulary — an
`exclude` line of `Event Only` is a name and stays a name. A quality token can
never collide with a name (normalisation has already removed every one of them
from every name); bracket text has no such guarantee, so it takes an explicit
`~`. A qualifier may stand alone on the line, which is what makes the third
example above legal.

The marker is different from `@` on purpose, and sits where the thing it names
sits. `@` is the section in front, `~` is the token behind — so `@HD Sports`
still means the `HD:` section and nothing in an existing rules file changes
meaning.

Both ends combine, which is how one line says "that section's copy of that
variant, and nothing else":

```
@AU CNN ~4K        the AU section's 4K copy
```

Line order is still preference, so a qualified line above an unqualified one is
a fallback rather than a hard selection — `@AU CNN ~4K` above `CNN` takes the AU
4K copy where there is one and anything else where there is not. Reach for that
when a variant is *better*; most quality rules are the plain kind above, where a
variant should simply never be picked.

A resolution word means its **tier**, not the literal token: `4K` covers `UHD`
and `2160p`, because they are one feed described three ways. Write the height
(`~2160p`) when the exact number is the point.

Stacked `~` qualifiers are **all of**, where stacked `@` qualifiers are any of.
That follows from what each names: a stream sits in one section spelled several
ways, so `@US @USA` is one question with two acceptable answers; a stream carries
tier, codec and fps at once, so `~4K ~hevc` is two questions.

`exclude` reads the same tokens, and a bare one is the short way to say it for a
whole channel:

```
4K                 drop the UHD copy, whatever it is called
@US 4K             ...in the US section only
@US CNN ~4K        ...only that name, only that section
```

All of this is rejection and selection, not ranking. If you would take the 4K
feed but rank it below the others, that is [ordering](configuration.md), which
already sorts on measured resolution — reach for these when the variant should
never be selected at all, usually because it is bandwidth you are not going to
spend.

## Groups

Dispatcharr keeps one group list for two different things, and Podium treats
them separately: **channel groups** decide what gets probed, **provider stream
groups** decide what is a candidate at all.

### Provider stream groups

You turn groups on per provider in Dispatcharr, and a subscription enabled for
its sports channels also brings in what sits next to them: per-fixture event
feeds, auto-built groups, VOD dumps. Those streams are candidates for every rule
in the file, and a loose `contains` picks them up — a per-fixture feed named
after both teams is something a team channel will happily claim, and it is dead
by morning.

Switch the group off instead:

```json
"defaults": { "exclude_groups": ["PPV EVENTS", "Auto | *"] }
```

Its streams leave matching entirely — no alias, `contains` or leftover regex
reaches them. Names, with `*`/`?` globs, rather than ids: providers churn their
M3U and Dispatcharr rebuilds the groups, so an id list quietly lets them back
in. This is the same reason the channel-side policy grew `Auto | *`.

**Settings → Provider stream groups** lists the groups your providers actually
import, how many streams each holds and how many are currently claimed —
claimed first, since a group nothing matches is not worth reading — with a
toggle per group.

![Provider stream groups in Settings, with two groups switched off by glob](images/provider-stream-groups.png)

A group switched off by a glob is struck through and says which pattern caught
it, so an `exclude_groups` entry that is quietly claiming more than you meant is
visible rather than inferred.

### Channel groups

Policy is per Dispatcharr channel group:

| mode | behaviour |
| --- | --- |
| `always` | check the group's **ruled** channels on the normal freshness schedule (default) |
| `never` | never probe; leave the ordering alone |
| `after_epg_start` | rule or not, but only once the channel's EPG programme has started |
| `assigned` | rule or not, on the normal freshness schedule |

Any of them can carry `measure_only`, which probes the group without ever
writing to it — see [Measure only](#measure-only-channels-another-app-owns).

The policy says *when* a channel is checked. What decides whether it is checked
at all is having a rule: under `always` — which is also what a group you have
never touched resolves to — a channel with no alias is not podium's to look at,
so a fresh install with an empty rules file checks nothing whatever its groups
say. The other two modes lift exactly that condition, which is the difference
worth reading the rest of this section for.

`after_epg_start` exists for event channels. A channel carrying a 2pm first
pitch is genuinely dead at 1pm — probing it then records a dead stream, sinks it
in the ranking, and the next person to tune in at 2:05 gets the worst stream on
the channel.

It waits for a programme the EPG marks **live**, not merely for one to be
airing. Event EPGs do not leave a channel blank until kickoff; they fill the gap
with a countdown block —

```
16:00Z–17:05Z  "Coming up: Minor League Baseball at 1:05 PM EDT"   is_live false
```

— whose start is the moment the countdown began, hours before first pitch. Gate
on that and the group is open all day, which is the opposite of what the mode is
for. Postgame blocks are the same problem afterwards.

If your EPG never marks anything live, every channel in the group is held back
with the reason `no live programme`, shown in the pass tally on the dashboard.
Set `require_live` to `false` on that group in `rules.json` to fall back to
gating on the programme's start alone:

```json
"groups": { "3618": { "mode": "after_epg_start", "require_live": false } }
```

It works the same way on a name pattern, alongside `grace_minutes` and
`window_minutes`.

Name patterns like `Auto | *` apply a policy to groups that do not exist yet,
which matters because Dispatcharr creates groups on its own.

`after_epg_start` and `assigned` are the two policies that cover channels with
no rule at all, by taking the channel's own assignment as the rule. Channels
created by another app — a scheduler that spawns one per fixture — have streams
assigned but nothing in the rules file naming them, so under `always` podium
leaves them alone; in one of these groups it ranks what the channel already
carries instead. `assigned` is that bargain for a lineup you have already built
by hand: point it at a group and podium keeps the order of every channel in it
honest without your writing a single alias. It still only reorders, never
assigns, and streams in a provider group you excluded stay out. Such a channel
shows as `assigned only` in the channel list.

An alias is still worth adding on top, per channel, where the order is not
purely a question of measurement: alias order is preference, and `exclude`
keeps a variant out of the ranking altogether. Rank-by-assignment has neither —
every stream on the channel is a candidate, scored on what it measures.

![A channel group with its policy chips and the channels it holds](images/group-policy.png)

The policy is the row of chips at the top of a group. `assigned` is what
Dispatcharr has on the channel now; `matched` is what your rules claim — the two
differing is how you spot a stream the provider has just added.

#### Measure only (channels another app owns)

A fixture channel created by Teamarr carries its own idea of stream order and
rewrites it on its own schedule. A reorder written from Podium is overwritten,
which makes the two applications take turns clobbering the field a viewer
actually reads — and Podium loses that race by design.

What is worth having from those channels is the *measurement*. Probed after
kickoff, while nobody is watching, they are the only source of what the right
order would have been, which is what the quality priors are fitted from and what
the exported rules hand back to the app that owns the channel.

Toggling **Measure only** on a group — or `"measure_only": true` in
`rules.json` / `rules.yml`, on a group or a name pattern — keeps everything
except the writes:

| still happens | suppressed |
| --- | --- |
| the probe, at the time the policy says | writing the stream order |
| the cached verdict and its TTL | assigning a matched stream to the channel |
| the quality sample the priors are fitted from | |
| `stream_stats` published to Dispatcharr | |

Auto-assignment is suppressed with the reorder, and deliberately so: adding a
stream to a channel another app curates is the more intrusive of the two writes,
not the lesser.

It is orthogonal to the mode, so the natural setting for a Teamarr install is
both at once — probe once the fixture is under way, and never write:

```json
"group_patterns": [
  { "pattern": "Auto | *", "mode": "after_epg_start", "measure_only": true }
]
```

Channels handled this way are counted as `measured only` in the pass line on the
dashboard rather than folded into `already in order`, which means something
else — that the channel was checked and found correct. These were ranked and the
ranking was withheld.

#### Audio only (Radio & Music groups)

Channels carrying radio stations, Sirius XM, or music feeds have audio tracks but no video stream. By default, Podium expects video streams and treats video-less feeds as dead, black-screened, or sub-floor.

Toggling **Audio only** on a group (or adding `"audio_only": true` in `rules.json` / `rules.yml` or group name patterns) tells Podium to:
- Accept streams with valid audio tracks as healthy (`alive: true`).
- Skip video black-screen detection during probing to prevent stream mapping errors.
- Bypass the video bitrate floor (e.g. 500kbps) while still validating audio channel counts and audio bitrates.
- Score and rank streams by audio quality (channel count, codec, sample rate, and audio bitrate).
- Auto-assign matched radio streams to radio channels normally.

## Re-checking on demand

The freshness target is a floor, not a schedule. "Nothing older than 24 hours"
is satisfied by a library measured at four this morning, which is not the same
as being ready for something that is on tonight — and the streams a provider
swaps out during the day are exactly the ones you find out about at kickoff.

Two buttons say "look again anyway":

| where | scope |
| --- | --- |
| a group's page | every stream on every channel in that group |
| **Progress** | the whole catalogue |

Both **queue** work rather than doing it. They write a single timestamp, and the
planner then treats every verdict older than it as expired, so the next pass
picks the streams up through the ordinary machinery: provider lanes at their own
limits, the pass yielding the moment somebody starts watching, and event
channels still held until their programme has actually started. Nothing about a
re-check bypasses any of that — it only stops the cache answering for those
streams.

The worker notices within 30 seconds, even from the middle of an idle sleep.

Cancelling is free. Nothing was deleted from the cache to queue the work, so
dropping the request puts the existing verdicts straight back into service, and
whatever was already re-probed stays re-probed.

Two things to know before queueing the whole catalogue:

- On a large install this is hours of probing, and the day you most want it —
  a house full of people with the TV on — is the day it spends most of its time
  paused for viewers. Queue it in the morning, not at half past five.
- Event channels are the ones a morning re-check helps least. A channel in an
  `after_epg_start` group is held back until its programme is live whether or
  not you asked, which is the whole point of the mode: probing a feed that is
  not up yet records a dead stream and sinks it. For those, queueing the group
  an hour or two before kickoff is worth more than queueing everything at nine.

For a single channel, the **Check now** panel on the channel itself is faster
still — it probes on the spot and shows the ordering the results imply without
writing anything. To probe all channels in a group immediately on demand, use
the **Probe all** button on the group view.

## Ranking

Step order first (an alias you put first wins), then a weighted score:
resolution, bitrate, fps, codec, audio. Dead streams sink to the bottom, and so
do streams below `PODIUM_MIN_BITRATE_KBPS` or showing a black screen — a slate
is not a fallback. The weights are normalised by their total, so only their size
relative to each other matters.

Audio earns its weight where a provider carries the same channel twice, once
with 5.1 and once without. Podium reads the richest audio track a stream has —
channel count first, the track's own bitrate to separate ties — and a new
install starts that weight at 0.1: enough to decide between feeds whose video
already ties, never enough to promote a 720p stream over a 1080p one on the
strength of its soundtrack. An install that predates the setting keeps it at 0,
so upgrading never reshuffles a lineup nobody asked to change; raise it in
**Settings → Stream ordering** to opt in.

A channel whose 5.1 only appears during live coverage will change position
between passes. That is the measurement being honest about a stream that
genuinely changed.

Bitrate is *measured*, not read from the container: live TS/HLS almost never
declares one. Podium reads a few seconds of the stream, which also gives it the
black-screen check from the same read, so it costs one provider connection
rather than two.

**Extra logins on one provider add capacity.** A Dispatcharr M3U account can
carry several profiles — separate logins to the same upstream, each with its own
connection cap. Podium treats them as a pool. Each login gets its own lane at
its own cap, and every stream is drawn by *one* of them (rewriting the URL with
that profile's pattern, exactly as Dispatcharr does at playback), so a login
capped at 3 beside one capped at 2 gets through the catalogue five streams at a
time without either exceeding its limit. The split follows the free slots each
login has left, so a login busy with people watching TV draws proportionally
fewer. Nothing to configure; it turns itself on when a second profile appears
on the account.

The verdict is cached against the stream, not against the login that fetched
it, because the logins reach the same upstream and a probe through any of them
measures the same stream. Probing every stream through every login instead —
which is what Podium did when profile support first landed — was measured on a
live install at 2134 probes for 1067 streams, with 98 streams checked on both
logins returning 98 identical verdicts: it made the provider's sweep *slower*
than it had been on one login, because capacity rose 1.67× while the work
doubled.

A few details are worth knowing. The default profile's own search and replace
are applied as well, not assumed to be the identity pair Dispatcharr creates it
with — so a default profile edited to swap a LAN address for a WAN one is
probed at the address it actually plays. Patterns may be written in either the
JavaScript style (`$1`, `$<name>`) or the Python one (`\1`, `\g<name>`,
`(?P<name>...)`), since Dispatcharr accepts both.

Xtream Codes accounts work differently under the hood, and Podium follows them
there. Dispatcharr never rewrites the stored URL on an XC account: it applies
the profile's pattern to a canonical `server/live/user/pass/…` address, reads
the username and password back out *by position*, and rebuilds the URL around
them. Two consequences follow. A pattern that renames the `live` segment is
undone, because the rebuild writes that segment back. And a pattern that leaves
the address no longer parsable as `…/user/pass/file` — or that fills in only
one half of the search/replace pair — is abandoned altogether, with the
account's own credentials played instead. Podium reproduces both, so it never
spends a connection probing an address Dispatcharr would not play. The one gap
left is credential rotation: Podium transforms the stored URL, so if an
account's credentials change without an M3U refresh it probes the old ones
until the next sync.

A login whose pattern does not compile, or that rewrites onto a URL another
login already covers, contributes no lane and is skipped with a line in the
worker log naming it — check there first if a second login does not seem to be
adding any capacity. Skipping it is the safe reading: a login that reaches the
same URL as another is the same credentials twice, not a second line, and
drawing on it would put more connections against that line than it allows.

There is deliberately no loop detection. Catching a loop means watching for at
least one loop period — around 120s per stream against the ~1s the other checks
cost — for a failure far rarer than dead, black or throttled.

![Stream ordering settings: mode, preferred providers, and quality weights](images/stream-ordering.png)

Mode and weights live in **Settings → Stream ordering**. Preferred providers
only apply in `provider` mode; in `quality` mode the best measured source wins
outright, whoever carries it.

## Exporting what Podium learned

Podium ranks a stream by measuring it. Some streams cannot be measured in time
to be useful: an event channel's streams are created for one fixture and gone
by morning, so by the time a probe would tell you anything the game has
started, and the verdict is swept with the stream the next time the catalogue
is fetched. Probing harder does not help. There is no *before* to probe in.

What outlives the fixture is where the stream came from. Podium keeps a running
record of every verdict against the provider account the stream arrived on and
the quality token in its name — `FHD`, `1080p`, `HD`, `4K` — and after a few
weeks of ordinary passes that record says something useful about a stream
nobody has ever probed: *streams like this one, from this account, measure
about 6800kbps and are dead one time in twenty.*

Nothing about this changes how Podium probes. The record is a byproduct of
verdicts already being produced, so it costs no extra provider connections, and
it accumulates in dry-run exactly as it does live.

### What it learns from

A rule exported from this is evaluated behind a fixture channel, at kickoff. A
catalogue is mostly not that — VOD dumps, 24/7 filler, entertainment packages —
so learning from all of it measures the wrong population twice over: the
baseline every exported number is quoted against becomes a film library's
bitrate, and an account's effect becomes a claim about its movie encoder.

**Settings → Quality priors** decides which probes count. Two signals, and an
`exclude` that vetoes both:

| Setting | What it does |
| --- | --- |
| **Learn only from event channels** | Counts a probe only when the channel it was run for sits in a group set to `after_epg_start` or `assigned` — the groups you already declared are events under [Channel groups](#channel-groups). On by default. |
| **Always learn from groups matching** | Globs — `* SPORT*, *PPV*` — matched against the provider group *and* the channel group. Admits a group whatever its policy says. |
| **Never learn from groups matching** | Globs — `*VOD*, *MOVIE*, *24/7*` — that drop a sample however it was admitted. |

Every sample is still recorded, whatever the scope says. The gate applies when
the profile is *built*, so narrowing it costs nothing permanent and widening it
takes effect immediately rather than after another month of probing. The
Quality tab reports what the scope dropped and why, and **Ignore the scope**
shows the ungated profile for comparison without saving anything.

One transitional case worth knowing about: samples recorded before this
existed carry no channel and no policy, so under **Learn only from event
channels** they cannot be judged and are reported as *probed before the scope
was recorded* rather than silently dropped. Naming their groups under **Always
learn from groups matching** puts them back in scope today; otherwise new
passes replace them over the following weeks.

### The profile

    GET /api/quality-profile

Returns every bucket Podium has samples for — how many, how often they were
alive, how often black, the median and p90 of the bitrates it actually
measured — along with the per-account and per-tier effects derived from them.
`?minSamples=` sets how many samples a bucket needs before it is allowed to
contribute an effect; the default is 20, because a reading off four streams is
noise with a number attached.

The response describes the scoped population: `totalSamples` is what the fit
read, `recordedSamples` is everything held, `namedSamples` is how many carry the
stream's name — kept for mining name patterns later, so it reads as zero on
history recorded before names were — and `scope` carries the rules in
force and a count per reason a sample was left out. `?eventOnly=0`,
`?include=` and `?exclude=` override the configured scope for one request —
`?eventOnly=0&include=&exclude=` is the ungated profile — which is how to ask
what a change would do before making it.

Bitrate percentiles use only bitrates that were *read*, on streams that were
alive and not black. A container's declared bitrate, a dead stream's zero and a
slate's 300kbps all describe something other than what a viewer receives; how
often those happen is carried separately, as the alive and black rates.

### As Teamarr rules

    GET /api/quality-profile?format=teamarr

Returns a `stream-ordering-rules.json` that [Teamarr](https://github.com/pharaoh-labs/teamarr)'s
**Channels → Stream Priority → Import** accepts as-is: one scoring rule per
provider account, one per provider group and one per quality tier, each
carrying that dimension's measured distance from your install's baseline.
Teamarr sums the rules a stream matches, so a good account, a good group and an
`FHD` token add up — no probe on Teamarr's side, and the ordering applies to a
stream the moment it appears.

The three are what Teamarr can match on, and they split the way its matcher
does: `m3u` and `group` are wholesale — a stream either came from that account
or that group — while `regex` is the only rule that reads the stream's own
name. Podium writes no `stats_metric` rules, deliberately: those already read
the `ffmpeg_output_bitrate` Podium publishes to Dispatcharr, so generating them
here would score the same measurement twice.

The effects are fitted against each other rather than averaged separately, so
an account is credited for the streams it runs *better than other accounts in
the same group at the same tier* — not for happening to sell more 1080p, which
the tier rule already pays for, or for carrying a better class of package.
Averaging the dimensions independently looks equivalent and is not. On the
install this was developed against it collapsed four provider accounts into a
366kbps spread while their 1080p streams alone spanned 3193kbps, and it flipped
the sign of one account's effect — from promote to demote — purely because that
account also carried a radio package.

The **provider group** is the strongest single predictor here — a group's
effect routinely spans thousands of kbps where an account's spans tens, which
stands to reason: a group is how a provider organises what it sells, and a
sports package and a VOD dump are not the same product. It is also the effect
that most needs fitting jointly rather than alone, because an account's number
otherwise absorbs the quality of whichever groups it happens to carry.

Audio-only streams — radio, SiriusXM, anything on a group marked **Audio only**
— are recorded but held out of the video model entirely. Their bitrate is an
audio bitrate, so a few hundred kbps means a healthy stream rather than a
throttled one, and pooling them in reads as a catastrophic provider. On the
install above they were 18% of all probes and 30% of the untagged tier.

`?pointsPerMbps=` scales the result; the default of 5 puts a provider running
3Mbps above average at +15, which reads alongside a hand-written "+20 for the
home feed" as an opinion of comparable strength rather than one that drowns it.
Raise it if your own rules use larger numbers — only the ratio matters.

No generated rule exceeds **±15** whatever it fitted. Teamarr scores a stream
it has measurements for from `stats_metric` rules reading the bitrate Podium
published — a reading of *that stream* — while everything generated here is an
inference about streams of the same provenance. The cap keeps the strongest
inference below the first rung of a measured ladder, so a stream measured at
10Mbps outranks one that merely comes from a good account.

### The regex form

Tier rules are emitted as

```
(?i).*(?<![A-Za-z0-9])(?:FHD|1080P|1080I)\d*(?![A-Za-z]).*
```

which is more armour than it looks. The inline `(?i)` because the exported
pattern carries no flags of its own and every token is written uppercase —
without it a rule for `1080P` scores nothing on the `1080p` providers actually
write. The `.*` on each end because a rules file cannot say whether Teamarr
calls `search`, `match` or `fullmatch`, and under `match` an unanchored pattern
is pinned to offset 0 and fires only on names that *begin* with the token. The
left boundary stops `HD` matching inside `FHD` and `UHD`. The right boundary is
deliberately weaker — `\d*` then "no letter" — because providers number their
feeds: `EPL01`, `EPL05`, `1080p60`. A symmetric boundary rejects all three
while looking correct.

Verified against Python `re` under all three call styles.

The exported file carries the scope it was fitted under, in its `podium` block.
The points are otherwise unfalsifiable once they leave: a +40 fitted on event
channels and a +40 fitted on a film library are the same two characters.

Streams whose names advertise no quality at all are the reference level and get
no rule — they score their account's effect alone, which is the right answer
when the name was the only thing to go on.

> [!IMPORTANT]
> Teamarr's import **replaces** its entire rule set rather than merging, so
> importing a bare export would delete every rule you wrote by hand. Export
> your rules from Teamarr first and POST them to the same endpoint to get a
> file carrying both:
>
> ```sh
> curl -X POST --data-binary @stream-ordering-rules.json \
>   -H 'Content-Type: application/json' \
>   http://podium:3456/api/quality-profile > merged.json
> ```
>
> Your rules come back untouched and in their original order. A rule Podium
> also generated is updated in place rather than added a second time, so
> re-importing next month refreshes the numbers instead of stacking a second
> set of points on top of the first.

## Importing existing rules

If you are arriving with a set of generated regexes, Podium can convert them
rather than making you retype every channel:

```sh
npm run import -- --json export.json --out data/rules.json
```

It decomposes the patterns into aliases plus global guards where it can, and
leaves the rest as regex rather than guessing. Channels still carrying one are
flagged in the UI so they can be retired deliberately, once the aliases cover
the same streams.

`--raw` keeps the regexes verbatim instead of converting them.

> [!WARNING]
> An exported config may embed a live Dispatcharr API key. Keep it out of
> version control.
