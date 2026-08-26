# The name miner

The design, the thresholds, and the evidence behind both.

**Status.** Pass B (consolidation) ships and exports. Pass A (discrimination)
runs, reports, and exports nothing — its durability guard cannot be trusted
until an install has actually held seven days of samples, which no install had
until `SAMPLES_PER_BUCKET` was raised from 400 to 4000 in the same release. What
each pass found, and which guard stopped it, is on the quality screen under
**Mining the names**.

## What it is for

Teamarr ranks a channel's streams by summing the scoring rules each stream
matches. Four of its rule types could be generated; three are:

| type | matches on | Podium status |
| --- | --- | --- |
| `m3u` | the account a stream came from | **shipping** |
| `group` | Teamarr's own Event Group name for where the stream came from | **shipping** |
| `regex` | the stream's own name | tier tokens, plus Pass B |
| `dispatcharr_group` | the Dispatcharr group of a channel-source stream | not reachable — see below |

The first two are wholesale — a stream either belongs to the set or it does
not — and Podium fits them jointly (see
[usage](usage.md#which-dimension-gets-the-credit)). The third is the only lever
that reads the name, and today Podium fills it from a hand-picked vocabulary of
resolution tokens. On the install this was developed against that vocabulary
fits to exactly `0`: once you know the account, the resolution token adds
nothing, and **69% of stream names on Teamarr-ordered channels carry no
resolution token at all**.

The miner replaces the hand-picked list with whatever the names actually say.

## Two passes, because regex does two different jobs

Measured on the live catalogue:

```
NFL Game Pass:   8 samples,  2 accounts,  2 groups
   4  NFL Game Pass 🏈
   4  Sports | NFL Game Pass

Peacock:        17 samples,  3 accounts,  4 groups
   5  Sports | Peacock                4  USA: PEACOCK [PPV EVENTS] [1080p]
   4  Sports | Peacock (2)            4  US| PEACOCK PPV

H265 / HEVC:   174 samples,  3 accounts, 13 groups
PRIME:          91 samples,  1 account,   3 groups
NOW TV:         96 samples,  1 account,   1 group
```

`NFL Game Pass` **is** a group. A regex for it buys nothing a group rule does
not already give — the group effect will learn it unprompted.

`Peacock` is four groups under three accounts, spelled four different ways.
`H265` is thirteen groups. There one regex replaces N group rules and keeps
working when a provider renames a group. That is **consolidation**, and it is
not a contrast at all: inside `Sports | Peacock` every stream is a Peacock
stream, so nothing varies and a within-group test sees nothing.

`PRIME:` is three groups inside one account — a sub-provider route the `m3u`
lever cannot reach, because it is the same account.

And separately there are tokens that vary *inside* a single group, which no
wholesale rule can express at any granularity. That is **discrimination**.

So: **Pass A** finds tokens that discriminate within a cell. **Pass B** finds
tokens that consolidate across cells. A token is a candidate for one or the
other, never both — whichever it has more support for.

---

## Candidates

Shared by both passes.

**Sources.** The seed vocabularies `normalize.ts` already carries (codec, audio,
`RAW`/`MULTI`/`HDR`/`VIP`/`BACKUP`/`ALT`); bracket bodies, `[H265]` and
`(HEVC)`; prefix segments before a colon, `PRIME:`, `UK-NOWTV:`, `CAN:`;
and every remaining token in the name, plus its numbered stem — `SPORTS4`
contributes `SPORTS4` and `SPORTS\d*`.

**Shape filter.** Drop pure numerics, dates, clock times, and anything matching
the fixture-title shape. On the live catalogue `AUG` alone appears in 591
samples across 46 groups and is a month.

**Stop list.** Sport and competition words that name the channel rather than the
stream — they duplicate what the group already says.

## Pass A — discrimination

**Cell.** `(provider, group, tier, audioOnly)` — the same key the quality
profile buckets on, so a token is only ever compared against streams that are
alike in every other respect Podium can see.

**Estimate.** Within each cell, split on the token's presence and take the
difference of mean `effectiveKbps` — `median × aliveRate × (1 − blackRate)`,
so a token that predicts a stream being dead is penalised for it. Combine
cells by the weighted mean, weight `min(withToken, withoutToken)`.

Paired contrast rather than another factor in the global fit, deliberately.
Adding name tokens to the backfit would reproduce the failure the fit order
already had to be corrected for: with collinear factors whichever is estimated
first absorbs the signal, and a token that is really a provider marker would be
fitted as though it were a property of names. Pairing inside a cell holds the
account, group and tier constant by construction, so a provider marker simply
has no cell where it varies and produces no candidate. Not suppressed by a
threshold — absent, because there was never evidence for it.

**Guards.**

| guard | value | why |
| --- | --- | --- |
| samples per side | ≥ 20 | at 5 the live catalogue yields 36 tokens, nearly all noise |
| paired cells | ≥ 2 | one cell is a channel, not a pattern |
| effect | ≥ 500 kbps | below this it will not survive the points rounding |
| duration | ≥ 7 days | see below — the single most important one here |
| sign stability | same sign in both halves of its window | a token that flips is fitting a schedule |

**No account-dispersion guard.** An earlier draft required a token to appear
under ≥2 accounts, on the theory that a single-account token is the `m3u` rule
in disguise. That would throw out `PRIME:` — a sub-provider route inside one
account, which is precisely the case no wholesale rule can express. The paired
contrast already holds the account constant, so a single-account token is
measuring discrimination *within* that account. The guard must not come back.

**Why duration matters most here.** At a loose threshold the live catalogue's
top candidates are:

```
CHC   -5172 (cells=1)     BROADCAST  +3087 (cells=1)
SEA   -5172 (cells=1)     BASEBALL   +2832 (cells=1)
MIN   -3349 (cells=1)     AM/PM      ∓2755 (cells=2)
SD    -3349 (cells=1)     SKY        -2750 (cells=2)
```

`CHC`, `SEA` and `MIN` are team abbreviations. "Cubs streams are 5 Mbps worse"
fits this week's schedule and is worthless next week. `SD`, `HD` and `SKY` are
the durable ones. Nothing but persistence across fixture cycles separates the
two lists, so nothing else can be the primary guard.

**Decorrelation.** `AM` and `PM` above are one split counted twice, at exactly
mirrored magnitudes. Take candidates greedily by `|effect| × support`, and drop
any whose stream set overlaps an already-taken candidate beyond a threshold.

## Pass B — consolidation

**Question.** Do the groups carrying this token sit consistently above or below
the baseline, such that one regex can replace their group rules?

**Carriers.** A group *carries* a token when ≥80% of its sampled streams match
it. Below that the token varies inside the group and belongs to Pass A.

**Estimate.** The sample-weighted mean of the carrier groups' fitted
`deltaKbps` — their distance from the install baseline, which is already
computed.

**Guards.**

| guard | value | why |
| --- | --- | --- |
| carrier groups | ≥ 3 | one or two groups: write the group rules, they are cheaper |
| samples | ≥ 20 per carrier group | the group effect has to be fitted at all |
| consistency | all carriers same sign, and \|mean\| ≥ weighted stdev | otherwise the token is not the reason |
| non-carrier contamination | no group between 20% and 80% | an ambiguous token is neither pass's business |

No account requirement: `PRIME:` consolidates three groups inside one account
and still replaces three rules with one.

**Export, without double counting.** A consolidating regex must *replace* the
group rules it subsumes, or a Peacock stream scores its group's points and the
regex's on top. So:

1. emit one `regex` rule worth the consolidated effect;
2. re-emit each carrier group's rule worth its **residual** — its own effect
   minus the consolidated effect;
3. drop any residual that rounds to 0 points.

That is exactly additive, and the dropped residuals are the compression: four
Peacock groups all sitting near `+2000` become one `+10` regex and nothing
else.

## Output

**Form.** `(?i).*<token>.*` with token boundaries, matching the existing tier
export — Python `re`, inline flags, verified against `search`/`match`/
`fullmatch`. See [the regex form](usage.md#the-regex-form).

**Points.** `deltaKbps / 1000 × pointsPerMbps`, capped at ±15 like every other
generated rule, so the strongest inference stays below the first rung of a
measured `stats_metric` ladder.

**Cap.** 10 mined regex rules total, across both passes. Different fixtures
want different rules and the set has to stay legible.

**Export.** Automatic above the delta threshold, with the matching stream names
shown on the quality screen so a rule can be read back to the streams that
earned it.

**Slot tokens do not ship.** Positional markers (`EPL01`, `EPL05`) identify a
schedule slot rather than a stream's quality, and Teamarr rewrites them.

## Why Pass A does not export yet

Not a sample count — a candidate count. Pass A's export turns on when candidates
clear **20 per side, across ≥2 cells, over ≥7 days**, and on the install this was
developed against nothing does yet:

```
1639 in-scope samples · 1304 distinct names · 160 cells · 18 with ≥20
4 tokens vary inside a cell at ≥20 per side · 0 clear every guard
window: 3.0 days — short by 4
```

The binding constraint was never probing rate. It was **retention**:
`trimQuality` keeps `SAMPLES_PER_BUCKET` samples per `(provider, tier, policy)`,
and at 400 the busiest buckets held **0.8 to 3.0 days** — ten of thirty-five sat
exactly at the cap. The seven-day guard was not "not yet met", it was impossible
to meet, on any install, at any probing rate. `QUALITY_HISTORY_MS` at 90 days
never came close to binding. 4000 covers seven days at the rates those buckets
were actually running, for a table around fifteen thousand rows.

Fixture churn is the second constraint and it is real: 1304 distinct names behind
1639 samples means most streams are seen once before the fixture ends. What buys
volume is matchdays where nothing stalls the prober — which is what
`PODIUM_PROBE_IDLE_PROVIDERS` was built for.

## Codec tokens are withheld

`HEVC` cleared every consolidation guard on the live catalogue — four carrier
groups, no contamination, −3076 kbps at a weighted spread of 667. It is still not
exported, and the reason is not statistical.

Bitrate is only comparable within a codec. HEVC carries roughly the same picture
in roughly half the bits, so a codec token's measured deficit is mostly the codec
being efficient rather than the stream being worse. The four carrier groups
already have group rules making the same claim, but only about themselves, where
it is at least true of the population it was measured on. Promoting it to a regex
is what makes it travel to providers it was never measured on — a −15 on any
stream whose name says HEVC, including ones that are perfectly good and merely
smaller.

Withheld rather than dropped, following `confoundedTiers`: the number is reported
on the quality screen so the judgement is visible.

The real fix is upstream and now underway. `quality_samples.video_codec` records
what ffprobe found rather than what the name claims, and once enough samples
carry it the codec can be held constant in the cell the way account, group and
tier already are — at which point a codec token has no contrast to show and never
becomes a candidate at all.

## What this does not reach: `dispatcharr_group`

Teamarr has a fourth lever Podium cannot inform. `group` rules resolve against
Teamarr's own Event Group names; `dispatcharr_group` matches
`stream.dispatcharr_channel_group`, which is set only for **channel-source**
streams — curated Dispatcharr channels used as sources. On the live install that
is 22,724 of 226,414 managed streams, under a single Event Group named
`Dispatcharr Channels`, with values like `Sports | US` and `Sports UK`.

Podium has never probed one. Channel-source streams carry no `m3u_account`, so
they map to provider `0`, and the sample table has zero rows from them. Reaching
that lever is a probing change, not an export change, and it is not addressed
here.

Note also that Podium's exported `group` values are *Dispatcharr* group names
while Teamarr matches *Event Group* names. On the install this was developed
against all 18 exported group rules matched, because the Event Groups were named
to mirror the Dispatcharr groups — but that is naming discipline, not a
guarantee, and the export says so in its `note`.

## What it does not replace

The **label-accuracy** panel stays. It answers a different question — whether
an account's own claims survive being measured — and on the live install it
reports one account labelling 100% of its streams and being wrong 63% of the
time. That is worth knowing before anyone hand-writes a regex keyed on a
resolution token, mined or not.
