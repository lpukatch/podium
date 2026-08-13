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
| **Exclude** | Reject a name even if an alias matches it. |
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

Qualifiers work on `contains` and `exclude` too. A prefix you name explicitly
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
| `always` | check on the normal freshness schedule (default) |
| `never` | never probe; leave the ordering alone |
| `after_epg_start` | only once the channel's EPG programme has started |

`after_epg_start` exists for event channels. A channel carrying a 2pm first
pitch is genuinely dead at 1pm — probing it then records a dead stream, sinks it
in the ranking, and the next person to tune in at 2:05 gets the worst stream on
the channel.

Name patterns like `Auto | *` apply a policy to groups that do not exist yet,
which matters because Dispatcharr creates groups on its own.

`after_epg_start` is also the one policy that covers channels with no rule at
all. Channels created by another app — a scheduler that spawns one per fixture —
have streams assigned but nothing in the rules file naming them, so under any
other policy podium leaves them alone. In an `after_epg_start` group it ranks
what the channel already carries instead, once the programme has started: the
assignment stands in for the rule. It still only reorders, never assigns, and
streams in a provider group you excluded stay out. Such a channel shows as
`assigned only` in the channel list.

![A channel group with its policy chips and the channels it holds](images/group-policy.png)

The policy is the row of chips at the top of a group. `assigned` is what
Dispatcharr has on the channel now; `matched` is what your rules claim — the two
differing is how you spot a stream the provider has just added.

## Ranking

Step order first (an alias you put first wins), then a weighted score:
resolution, bitrate, fps, codec. Dead streams sink to the bottom, and so do
streams below `PODIUM_MIN_BITRATE_KBPS` or showing a black screen — a slate is
not a fallback.

Bitrate is *measured*, not read from the container: live TS/HLS almost never
declares one. Podium reads a few seconds of the stream, which also gives it the
black-screen check from the same read, so it costs one provider connection
rather than two.

There is deliberately no loop detection. Catching a loop means watching for at
least one loop period — around 120s per stream against the ~1s the other checks
cost — for a failure far rarer than dead, black or throttled.

![Stream ordering settings: mode, preferred providers, and quality weights](images/stream-ordering.png)

Mode and weights live in **Settings → Stream ordering**. Preferred providers
only apply in `provider` mode; in `quality` mode the best measured source wins
outright, whoever carries it.

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
