/**
 * What happens to a stream *after* the probe says it is fine.
 *
 * Every other measurement here is a snapshot: ffprobe resolves codec,
 * resolution and bitrate in a few seconds, and a stream that answers well in
 * those seconds is ranked as a good stream. The failure this module exists for
 * is the one that snapshot cannot see -- a feed that plays perfectly for forty
 * seconds and then goes silent, over and over. It probes clean every time,
 * takes slot 0 on merit, and is unwatchable.
 *
 * Observing it costs nothing, because Dispatcharr is already watching. The
 * `/proxy/ts/status` endpoint the pacer polls for viewer sessions also reports,
 * per live channel, which stream is feeding it, when the session started, what
 * state it is in and how many bytes it has pulled. Sampling that on a timer
 * while somebody is watching reconstructs the thing no probe can reach: how
 * long each stream actually held.
 *
 * Passive rather than a soak, for the reason every other decision in this
 * codebase about provider capacity goes the same way. A soak holds a
 * connection open for its whole window and so costs a slot against the
 * provider's limit -- and since the failure only shows at the 40-second mark,
 * a meaningful soak is minutes per stream. Across six streams on each of
 * hundreds of channels that is not affordable, and it would contend with the
 * viewers `blockingSession` exists to stay out of the way of. Polling a status
 * endpoint costs one HTTP request and measures the real thing rather than a
 * proxy for it. The soak is still available, on the operator's say-so, for the
 * streams nobody has ever watched -- see `soakStream` in `probe.ts`.
 *
 * ## What counts as evidence
 *
 * Only two things are charged against a stream, and both are unambiguous:
 *
 *   - a **failover**, where the stream serving a session changes while the
 *     session itself carries on. Dispatcharr only does that because the feed
 *     failed.
 *   - a **stall**, where the byte counter stops advancing while a client is
 *     still attached. This is the same-URL reconnect -- `MAX_RETRIES` against
 *     the same address before rotation is even considered -- which moves
 *     neither the stream id nor the session key and would otherwise leave no
 *     trace at all.
 *
 * A session that simply *ends* is charged to nobody. From a status poll, a
 * channel disappearing because the feed died and Dispatcharr gave up looks
 * exactly like a channel disappearing because the viewer switched over to the
 * news, and there is no third field that separates them. So it is recorded as
 * clean watched time and no failure -- which under-counts real failures and
 * never invents one. That is the bias to have: this term demotes streams, the
 * demotion has no undo short of an operator noticing, and the same argument
 * keeps `isInterlaced` from reading `unknown` as interlaced.
 *
 * ## Why an unmeasured stream is not a stable one
 *
 * The ledger's silence is a gap, not a verdict. A stream that has played and
 * held has earned full marks; a stream nobody has ever watched has earned
 * nothing at all -- not even the claim that it serves video. Callers
 * therefore treat never-observed as N/A rather than as full marks: the
 * published `stability_score` is null, the weight's term is dropped from the
 * quality score (from the normaliser as well as the numerator, so an
 * unmeasured stream is scored on the terms that were measured), and the
 * ranking sinks it below every measured stream once the stability weight is
 * on -- the same argument `bitrateUnknown` makes about bitrates.
 *
 * The drift that shape once guarded against is real, but it belonged to the
 * score, not the bucket. Being watched decides *whether* a stream is
 * measured, never how it scores: two clean streams -- one watched for two
 * minutes, one for twenty hours -- get the same term, and an unmeasured one
 * is not ranked by anything at all until `planSoaks` gets to it, which it
 * does first, deliberately, so a stream rises out of the unmeasured bucket
 * by being measured rather than by its channel happening to be popular.
 */

/** One poll of one live channel. */
export interface SessionSample {
  /** Wall clock the poll was taken, in milliseconds. */
  at: number;
  /**
   * The status endpoint's own identifier for the channel -- a uuid on current
   * builds.
   *
   * The tracker keys on this rather than on Dispatcharr's numeric channel id
   * so that a poll needs no channel catalogue to make sense of. Resolving the
   * number means fetching every channel, which is a per-pass cost and not a
   * per-ten-seconds one.
   */
  channelKey: string;
  /** The numeric id when something could resolve the key; context only. */
  channelId: number | null;
  /**
   * The channel session's identity -- Dispatcharr's channel init time.
   *
   * Null on a build that does not report it, which is treated as "matches
   * whatever is open" rather than as a distinct session. Reading absence as a
   * new session would close and reopen a leg on every poll and turn a quiet
   * evening into a few hundred one-poll legs.
   */
  sessionKey: number | null;
  /** The stream feeding it; null when the payload did not say. */
  streamId: number | null;
  state: string;
  healthy: boolean | null;
  /** Bytes pulled so far; null when the payload did not say. */
  totalBytes: number | null;
  clientCount: number;
}

/**
 * How a leg ended.
 *
 * Two of the five are evidence against the stream and three are not:
 *
 *   - `failover` -- Dispatcharr moved a live session onto another stream,
 *     which it only does because the feed failed.
 *   - `dropped`  -- a soak's connection ended before the soak asked it to.
 *     The same event seen from the other side, and written by `soakStream`
 *     rather than by the poller.
 *   - `retune`, `gone`, `drain` -- the watching stopped, for reasons that say
 *     nothing about the feed. See the note on evidence at the top of the file.
 */
export type LegEnd = 'failover' | 'dropped' | 'retune' | 'gone' | 'drain';

/** The endings that count against a stream. */
export const BREAKING_ENDS: readonly LegEnd[] = ['failover', 'dropped'];

/**
 * A continuous span in which one stream served one channel session.
 *
 * The unit the ledger stores, rather than a running per-stream mean, for the
 * reason `quality_samples` stores samples: the useful summaries are rates over
 * a window, and a rate needs its window to be re-choosable after the fact. A
 * stored mean freezes today's window forever.
 */
export interface Leg {
  channelKey: string;
  channelId: number | null;
  streamId: number;
  /** First poll that saw this stream on this session. */
  startedAt: number;
  /** Last poll that did. */
  endedAt: number;
  /**
   * Observed serving time.
   *
   * Bounded below by the poll interval's resolution: a leg shorter than one
   * gap is never seen at all, and one that is seen is measured from the first
   * poll that caught it rather than from when it truly began. Both make this
   * an undercount of real serving time, which is the safe direction -- it
   * inflates the drop *rate* rather than hiding it.
   */
  watchedMs: number;
  /** Of that, time the byte counter did not advance while a client watched. */
  stalledMs: number;
  /** Stall episodes begun in this leg -- transitions from flowing to flat. */
  stalls: number;
  ended: LegEnd;
}

/** A leg the tracker is still filling in. */
interface OpenLeg {
  sessionKey: number | null;
  channelId: number | null;
  streamId: number;
  startedAt: number;
  lastAt: number;
  lastBytes: number | null;
  stalledMs: number;
  stalls: number;
  /** Whether the previous gap was already flat, so an episode is not recounted. */
  stalling: boolean;
}

/**
 * One Dispatcharr live-stream event, in the tracker's terms.
 *
 * The shape the webhook receiver's rows map onto -- see `connect-events.ts`
 * for why only `stream_switch` and `channel_error` are subscribed to. The
 * tracker stays ignorant of the wire spelling: what it needs to know is that
 * the stream serving a channel changed (`switch`) or that a stall had nowhere
 * left to switch to (`error`).
 */
export interface StreamEvent {
  /** When the delivery arrived, in milliseconds. Leg timestamps come from this. */
  at: number;
  /** The channel uuid, matching a poll sample's `channelKey`. */
  channelKey: string;
  kind: 'switch' | 'error';
  /** The stream the event is about; null when Dispatcharr did not say. */
  streamId: number | null;
  /** What a switch switched away from, when Dispatcharr knew. */
  previousStreamId: number | null;
  /** True when the switch was made by an operator rather than by a failing feed. */
  manual: boolean;
}

export interface StabilityTracker {
  /**
   * Fold one poll in, returning the legs it completed.
   *
   * `at` is passed rather than read from the clock so a test can drive the
   * whole thing deterministically, and so every sample in one poll shares an
   * instant -- legs on different channels must not drift apart by the time the
   * loop took.
   */
  observe(samples: SessionSample[], at: number): Leg[];
  /**
   * Fold Dispatcharr's own account of a failure in, returning the legs it
   * completed.
   *
   * The events say what a poll can only infer: a switch names the stream it
   * left and why, so the leg closes at the instant it happened rather than at
   * the next poll, and an operator's manual switch closes a leg `retune`
   * instead of billing the old stream for a feed failure it did not have. An
   * `error` is a stall Dispatcharr has given up on switching away from -- the
   * event charges the episode to the stalled stream, which is the one case a
   * vanished channel would otherwise escape uncharged.
   *
   * Deliberately *not* a replacement for `observe`: events are instants, and
   * legs need watched time, which only sampling provides. Absence of an event
   * also proves nothing, so this never runs the gone-sweep `observe` runs --
   * only a poll that no longer sees a channel may close its leg as `gone`.
   *
   * A switch already reflected in the open leg -- the new stream matches --
   * is ignored, which is what keeps the two sources from billing one real
   * switch twice: whichever of the poll diff or the event arrives second
   * finds its work already done. Same for an error against a stream no open
   * leg is serving: unchargeable now, and the poller may still see it.
   */
  observeEvents(events: StreamEvent[]): Leg[];
  /**
   * Close every open leg, for a worker that is stopping or has lost the lock.
   *
   * Without it the legs in flight are simply lost, and on an install that
   * restarts often that is most of them. They close as `drain` rather than
   * `gone` so the two are distinguishable in the ledger: `gone` is a session
   * that ended, `drain` is one this process stopped being able to see.
   */
  drain(at: number): Leg[];
  /** Channels with a leg open. Exposed for the metrics gauge. */
  openLegs(): number;
}

/**
 * Whether two session keys describe the same session.
 *
 * Null on either side means the build does not report the key, so there is
 * nothing to disagree about and the open leg continues. See `sessionKey`.
 */
function sameSession(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return true;
  return a === b;
}

export function makeStabilityTracker(): StabilityTracker {
  const open = new Map<string, OpenLeg>();

  const close = (channelKey: string, leg: OpenLeg, at: number, ended: LegEnd): Leg => ({
    channelKey,
    channelId: leg.channelId,
    streamId: leg.streamId,
    startedAt: leg.startedAt,
    endedAt: at,
    watchedMs: Math.max(0, at - leg.startedAt),
    stalledMs: leg.stalledMs,
    stalls: leg.stalls,
    ended,
  });

  const start = (sample: SessionSample, at: number, streamId: number): OpenLeg => ({
    sessionKey: sample.sessionKey,
    channelId: sample.channelId,
    streamId,
    startedAt: at,
    lastAt: at,
    lastBytes: sample.totalBytes,
    stalledMs: 0,
    stalls: 0,
    stalling: false,
  });

  return {
    observeEvents(events: StreamEvent[]): Leg[] {
      const done: Leg[] = [];
      for (const event of events) {
        const leg = open.get(event.channelKey);
        if (!leg) continue;
        if (event.kind === 'error') {
          // Charge the stream that stalled, not whichever stream the channel
          // has since moved to: an event that arrives late, after a switch,
          // names the dead stream and must not bill its replacement.
          if (event.streamId !== null && event.streamId !== leg.streamId) continue;
          leg.stalls += 1;
          // The next poll's flat gap is this same episode, not a second one.
          leg.stalling = true;
          continue;
        }
        // A switch whose new stream is already the open leg's stream is one
        // real switch seen by both sources -- the poll diff or an earlier
        // delivery got here first.
        if (event.streamId !== null && event.streamId === leg.streamId) continue;
        done.push(close(event.channelKey, leg, event.at, event.manual ? 'retune' : 'failover'));
        // Nothing to open a leg on yet: the next poll (or a later event with
        // an id) will. A leg opened here carries no session key and no byte
        // counter -- unknown, not zero -- so the first gap after it cannot be
        // judged flat, which is the safe direction for both.
        if (event.streamId !== null) {
          open.set(
            event.channelKey,
            start(
              {
                at: event.at,
                channelKey: event.channelKey,
                channelId: null,
                sessionKey: null,
                streamId: event.streamId,
                state: '',
                healthy: null,
                totalBytes: null,
                clientCount: 0,
              },
              event.at,
              event.streamId,
            ),
          );
        } else {
          open.delete(event.channelKey);
        }
      }
      return done;
    },

    observe(samples: SessionSample[], at: number): Leg[] {
      const done: Leg[] = [];
      const seen = new Set<string>();

      for (const sample of samples) {
        seen.add(sample.channelKey);
        const leg = open.get(sample.channelKey);

        if (!leg) {
          // A session with no stream id yet is not a leg: there is nothing to
          // charge time to. The next poll opens one once metadata names it.
          if (sample.streamId !== null) {
            open.set(sample.channelKey, start(sample, at, sample.streamId));
          }
          continue;
        }

        if (!sameSession(leg.sessionKey, sample.sessionKey)) {
          done.push(close(sample.channelKey, leg, at, 'retune'));
          if (sample.streamId === null) open.delete(sample.channelKey);
          else open.set(sample.channelKey, start(sample, at, sample.streamId));
          continue;
        }

        if (sample.streamId !== null && sample.streamId !== leg.streamId) {
          done.push(close(sample.channelKey, leg, at, 'failover'));
          open.set(sample.channelKey, start(sample, at, sample.streamId));
          continue;
        }

        // Same stream, same session: extend. A sample whose stream id is
        // absent lands here too, and deliberately -- absence is not a
        // failover, and charging one would invent failures on every build that
        // does not report the field.
        const gap = Math.max(0, at - leg.lastAt);
        // Both counters have to be present and equal for the gap to be flat.
        // A null on either side is a sample that says nothing about
        // throughput, and must not read as "no bytes moved".
        const flat =
          sample.clientCount > 0 &&
          leg.lastBytes !== null &&
          sample.totalBytes !== null &&
          sample.totalBytes <= leg.lastBytes;
        if (flat) {
          leg.stalledMs += gap;
          if (!leg.stalling) leg.stalls += 1;
          leg.stalling = true;
        } else {
          leg.stalling = false;
        }
        leg.lastAt = at;
        // Only when the sample carried one: remembering a null would make the
        // *next* gap unjudgeable too, so one build hiccup would blind the
        // stall detector for the rest of the leg.
        if (sample.totalBytes !== null) leg.lastBytes = sample.totalBytes;
        leg.sessionKey = sample.sessionKey ?? leg.sessionKey;
        // A key that resolved on a later poll than the one that opened the leg
        // still belongs on the row -- the catalogue may simply not have been
        // fetched yet when the session started.
        leg.channelId = sample.channelId ?? leg.channelId;
      }

      for (const [channelKey, leg] of open) {
        if (seen.has(channelKey)) continue;
        done.push(close(channelKey, leg, leg.lastAt, 'gone'));
        open.delete(channelKey);
      }
      return done;
    },

    drain(at: number): Leg[] {
      const done: Leg[] = [];
      for (const [channelKey, leg] of open) {
        done.push(close(channelKey, leg, Math.max(at, leg.lastAt), 'drain'));
      }
      open.clear();
      return done;
    },

    openLegs(): number {
      return open.size;
    },
  };
}

/** What the ledger knows about one stream, over some window. */
export interface StabilityRecord {
  streamId: number;
  /** Legs observed, however they ended. */
  legs: number;
  /**
   * Legs that ended because the feed stopped serving.
   *
   * A Dispatcharr failover or a soak's connection dropping -- see
   * `BREAKING_ENDS`. Named for what it measures rather than for either source,
   * because the ranking cannot tell them apart and should not: both are the
   * stream failing to hold.
   */
  breaks: number;
  /** Stall episodes across those legs. */
  stalls: number;
  watchedMs: number;
  stalledMs: number;
  /** The most recent poll that saw this stream serving. */
  lastSeenAt: number;
}

/**
 * Failures before the term is allowed to bite.
 *
 * One failover is an incident: a provider restarting an encoder, a router
 * dropping a packet, a moment of weather. Two is a pattern. Demoting a stream
 * on a single event would make the ranking jumpy in exactly the way an
 * operator notices and cannot explain, and the cost of waiting for the second
 * is one more bad viewing -- against which the cost of acting on the first is
 * reshuffling slot 0 on every channel that ever had a hiccup.
 *
 * Note this is a floor on *evidence*, not on watch time. A stream watched for
 * two minutes that failed over twice in them has earned the demotion; a stream
 * watched for nine hours with one failover has not.
 */
export const MIN_FAILURES = 2;

/**
 * The drop rate at which a stream scores half marks.
 *
 * One failure an hour: high enough that a stream dropping once across an
 * evening is barely marked down, low enough that the flapping this module was
 * written for lands near zero. The WJLA feed it was measured against failed
 * twice in 110 seconds -- 65 an hour -- and scores 0.015.
 */
export const TOLERATED_DROPS_PER_HOUR = 1;

/** Failures per hour of observed watching; 0 when nothing has been observed. */
export function dropsPerHour(record: StabilityRecord): number {
  const hours = record.watchedMs / 3_600_000;
  if (hours <= 0) return 0;
  return (record.breaks + record.stalls) / hours;
}

/**
 * How stable this stream has proved, in [0, 1].
 *
 * Hyperbolic rather than linear, and deliberately without a cliff: a threshold
 * anywhere on this axis would make one more drop flip a channel's slot 0,
 * which is the jumpiness the whole design is trying to avoid. `1 / (1 + r/t)`
 * is 1.0 at no drops, 0.5 at the tolerated rate, and approaches zero from
 * above without ever reaching it -- so even a catastrophic stream keeps an
 * ordering among its peers rather than collapsing into a tie at the bottom.
 *
 * Full marks for a record with nothing against it. An *absent* record is not
 * full marks but nothing to say -- callers branch on `observedPlaying` before
 * asking, so an unmeasured stream's value here never decides anything. See
 * the note on unmeasured streams at the top of this file.
 */
export function stabilityScore(
  record: StabilityRecord | undefined,
  toleratedPerHour = TOLERATED_DROPS_PER_HOUR,
): number {
  if (!record) return 1;
  if (record.breaks + record.stalls < MIN_FAILURES) return 1;
  const rate = dropsPerHour(record);
  if (rate <= 0) return 1;
  const tolerated = toleratedPerHour > 0 ? toleratedPerHour : TOLERATED_DROPS_PER_HOUR;
  return 1 / (1 + rate / tolerated);
}

/**
 * Whether this stream has proved *too* unstable to lead a channel.
 *
 * The health check beside the weight, in the same relation `minBitrateKbps`
 * has to the `bitrate` term: the weight expresses a preference among streams
 * worth ranking, and this says a stream is not fit to be served first whatever
 * its picture looks like. A 4K feed that dies every forty seconds is not a
 * better slot 0 than a 720p one that holds.
 *
 * Off at 0, which is the default, for the reason every scoring term added
 * since the first release defaults to inert: an existing install must not
 * reshuffle on upgrade.
 */
export function tooUnstable(record: StabilityRecord | undefined, maxDropsPerHour: number): boolean {
  if (!record || maxDropsPerHour <= 0) return false;
  if (record.breaks + record.stalls < MIN_FAILURES) return false;
  return dropsPerHour(record) > maxDropsPerHour;
}

/** Fold legs into one record per stream. */
export function summarise(legs: Leg[]): Map<number, StabilityRecord> {
  const out = new Map<number, StabilityRecord>();
  for (const leg of legs) {
    const record = out.get(leg.streamId) ?? {
      streamId: leg.streamId,
      legs: 0,
      breaks: 0,
      stalls: 0,
      watchedMs: 0,
      stalledMs: 0,
      lastSeenAt: 0,
    };
    record.legs += 1;
    if (BREAKING_ENDS.includes(leg.ended)) record.breaks += 1;
    record.stalls += leg.stalls;
    record.watchedMs += leg.watchedMs;
    record.stalledMs += leg.stalledMs;
    record.lastSeenAt = Math.max(record.lastSeenAt, leg.endedAt);
    out.set(leg.streamId, record);
  }
  return out;
}

/** What the ledger says about a channel taken as a whole. */
export interface ChannelStability {
  /** Streams on the channel. */
  total: number;
  /** Of those, how many have enough evidence to be judged at all. */
  measured: number;
  /** Of the measured ones, how many drop more often than tolerated. */
  unstable: number;
  /**
   * Every stream on the channel has been measured, and every one of them
   * drops.
   *
   * The distinction worth drawing, because it is the one case reordering
   * cannot help. Everything else Podium does assumes a channel has a better
   * stream in it somewhere and the job is to find it; when this is true there
   * is no better stream, and shuffling the order only changes which bad feed a
   * viewer gets. That is a different instruction to the operator -- find
   * another source, or accept the channel is bad -- and stating it as
   * "reordered, no change" would hide it.
   *
   * Requires full coverage deliberately. A channel with three of six streams
   * measured and all three bad is a strong hint, but the three nobody has
   * watched might be fine, and telling somebody their channel is unfixable on
   * half the evidence is how they go and cancel a provider they did not need
   * to. `measured` and `total` are both reported so a caller can phrase the
   * partial case honestly instead.
   */
  allBad: boolean;
}

/**
 * Judge a channel by every stream on it.
 *
 * `minMeasured` is not a parameter because the answer is "all of them": any
 * lower bar makes `allBad` a claim about a sample rather than about the
 * channel. Callers wanting the partial picture read `measured` against
 * `total`.
 */
export function channelStability(
  streamIds: number[],
  records: Map<number, StabilityRecord>,
  maxDropsPerHour: number,
): ChannelStability {
  let measured = 0;
  let unstable = 0;
  for (const streamId of streamIds) {
    const record = records.get(streamId);
    // "Measured" means the ledger could reach a verdict, which is the same
    // evidence floor the weight uses -- not merely that a row exists.
    if (!record || record.breaks + record.stalls < MIN_FAILURES) {
      if (record && record.watchedMs > 0 && record.breaks + record.stalls === 0) measured += 1;
      continue;
    }
    measured += 1;
    if (dropsPerHour(record) > maxDropsPerHour) unstable += 1;
  }
  return {
    total: streamIds.length,
    measured,
    unstable,
    allBad: streamIds.length > 0 && measured === streamIds.length && unstable === measured,
  };
}

/**
 * Whether the ledger has ever seen this stream play -- the line between
 * "unmeasured" and "measured, with nothing against it".
 *
 * The same test `describeStability` applies when it chooses the
 * "never observed playing" sentence, kept as a boolean so the score and the
 * sentence beside it can never disagree about which side a stream is on.
 */
export function observedPlaying(record: StabilityRecord | undefined): record is StabilityRecord {
  return Boolean(record && record.legs > 0);
}

/** One line for the UI: what the ledger has on this stream. */
export function describeStability(record: StabilityRecord | undefined): string {
  if (!observedPlaying(record)) return 'never observed playing';
  const minutes = record.watchedMs / 60_000;
  const watched = minutes >= 60 ? `${(minutes / 60).toFixed(1)}h` : `${Math.round(minutes)}m`;
  const failures = record.breaks + record.stalls;
  if (failures === 0) return `${watched} watched, no drops`;
  const rate = dropsPerHour(record);
  return `${watched} watched, ${failures} drop${failures === 1 ? '' : 's'} (${
    rate >= 10 ? Math.round(rate) : rate.toFixed(1)
  }/h)`;
}
