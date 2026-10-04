/**
 * Resolution floors: the smallest picture a channel should lead with.
 *
 * Set on a channel group or on one channel, never globally. A floor that suits
 * a group of HD sports feeds is wrong for the SD regional simulcasts beside it,
 * and on a channel where nothing clears the floor it does nothing but stop
 * auto-assign adding to it.
 *
 * No imports, so the channel editor can offer exactly the choices the ranking
 * understands without pulling the probe into a client bundle.
 */

/**
 * What it takes to clear each floor: the height *or* the width.
 *
 * Height alone sinks every letterboxed feed -- a 2.39:1 film at 1920x800 is a
 * 1080p stream by any sensible reading, and fails a 1080-line cut. Width alone
 * fails the other way, on anamorphic 1440x1080. Either is enough. Both cuts sit
 * a little under the nominal figure so an encode a few lines short of its label
 * (1916x1076) is still the resolution it says it is. They are deliberately not
 * the generous boundaries `tierOfHeight` uses: 1600x900 is not 1080p, however a
 * name tier rounds it.
 */
export const MIN_RESOLUTIONS = {
  '720p': { height: 700, width: 1200 },
  '1080p': { height: 1040, width: 1800 },
  '2160p': { height: 2000, width: 3600 },
} as const;

export type MinResolution = keyof typeof MIN_RESOLUTIONS;

/** Lowest first, the order a picker offers them in. */
export const RESOLUTION_CHOICES = Object.keys(MIN_RESOLUTIONS) as MinResolution[];

/**
 * Read a floor from a rules file or a request body.
 *
 * Three answers, because a channel needs the third: `undefined` is "not set
 * here", `null` is "set here, to no floor". The second is how the one SD
 * simulcast in an otherwise HD group opts out of its group's floor.
 *
 * A floor names a line count, not a scan type, so `1080i` is the same floor as
 * `1080p`: broadcast IPTV labels half its HD feeds interlaced, and an operator
 * typing what their provider calls the stream should not quietly end up with no
 * floor at all. `1080`, `1080p`, `1080i` and `4K` all read as you would expect.
 *
 * Anything else reads as unset rather than failing the load -- but silence is
 * the wrong answer on its own, so `invalidMinResolution` lets a caller tell the
 * difference between "nothing was set" and "something unreadable was".
 */
export function parseMinResolution(raw: unknown): MinResolution | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim().toLowerCase();
  if (text === '' || text === 'inherit') return undefined;
  if (text === 'none' || text === 'any') return null;
  if (text === '4k' || text === 'uhd') return '2160p';
  // Scan type is not part of the question -- 1080i and 1080p clear the same
  // line count, and what the floor measures is the picture, not how it is sent.
  const key = `${text.replace(/[ip]$/, '')}p` as MinResolution;
  return RESOLUTION_CHOICES.includes(key) ? key : undefined;
}

/**
 * The text of a floor that could not be read, or `''` when there was nothing
 * wrong with it.
 *
 * Kept apart from `parseMinResolution` so that function stays a plain lookup,
 * and so the rules loader can report a typo the way it already reports a bad
 * pattern. `1o80p` silently becoming no floor leaves an operator certain they
 * set one, watching a channel that is ranked without it.
 */
export function invalidMinResolution(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  const text = String(raw).trim();
  if (text === '') return '';
  return parseMinResolution(raw) === undefined ? text : '';
}

/**
 * The floor a channel ranks under: its own, else its group's.
 *
 * An explicit `null` on either side is "no floor", and on the channel it beats
 * the group's -- see `parseMinResolution` for why a channel needs to be able to
 * say "none". A group says it by carrying an entry at all: an explicit group
 * entry shadows the name patterns outright, so the entry's own absence of a
 * floor is what overrides a pattern's.
 */
export function resolveResolutionFloor(
  channel: MinResolution | null | undefined,
  group: MinResolution | null | undefined,
): MinResolution | undefined {
  if (channel === null) return undefined;
  return channel ?? group ?? undefined;
}

/**
 * The floor for one channel, given every channel's and its group's.
 *
 * The pass, the Teamarr comparison, the rule-check inputs and the on-demand
 * check panel must all rank a channel under the same floor -- the check panel's
 * whole promise is that its preview matches what the worker writes. One lookup
 * they all call is what keeps that true, rather than four copies agreeing.
 */
export function channelResolutionFloor(
  floors: Map<number, MinResolution | null>,
  channelId: number,
  group: MinResolution | null | undefined,
): MinResolution | undefined {
  return resolveResolutionFloor(floors.get(channelId), group);
}

/**
 * What it takes to sit under each ceiling: the height *and* the width over it.
 *
 * The floor's mirror, argument for argument. To clear a floor, one dimension
 * is enough -- height alone would sink every letterboxed feed, width alone
 * every anamorphic one. To breach a ceiling, both must be over: a 2.39:1
 * film at 1920x800 is not over a 1080p cap (height within), and an anamorphic
 * 1440x1080 is not either (width within), while a 2560x1440 is over both
 * ways. These cuts sit a little *over* the nominal figure so an encode a few
 * lines past its label (1936x1088) is still the resolution it says it is --
 * the same tolerance the floor takes in the other direction.
 */
export const MAX_RESOLUTIONS = {
  '720p': { height: 736, width: 1280 },
  '1080p': { height: 1104, width: 1920 },
  '2160p': { height: 2208, width: 3840 },
} as const;

export type MaxResolution = keyof typeof MAX_RESOLUTIONS;

/**
 * Read a ceiling from a rules file or a request body.
 *
 * The same three answers for the same reasons -- `undefined` is "not set
 * here", `null` is "set here, to no cap" -- and the same readings: `1080i` is
 * the same cap as `1080p`, `4K` and `UHD` name the 2160p one, and anything
 * unreadable is unset, with `invalidMaxResolution` to say so.
 */
export function parseMaxResolution(raw: unknown): MaxResolution | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim().toLowerCase();
  if (text === '' || text === 'inherit') return undefined;
  if (text === 'none' || text === 'any') return null;
  if (text === '4k' || text === 'uhd') return '2160p';
  const key = `${text.replace(/[ip]$/, '')}p` as MaxResolution;
  return (Object.keys(MAX_RESOLUTIONS) as MaxResolution[]).includes(key) ? key : undefined;
}

/** The text of a ceiling that could not be read, or `''` when there was not one. */
export function invalidMaxResolution(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  const text = String(raw).trim();
  if (text === '') return '';
  return parseMaxResolution(raw) === undefined ? text : '';
}

/**
 * The ceiling a channel ranks under: its own, else its group's.
 *
 * Resolved exactly as the floor is, because the two are independent
 * instructions -- one says what the channel must not lead with, the other
 * what it must not be capped above, and either can be set without the other.
 */
export function resolveResolutionCeiling(
  channel: MaxResolution | null | undefined,
  group: MaxResolution | null | undefined,
): MaxResolution | undefined {
  if (channel === null) return undefined;
  return channel ?? group ?? undefined;
}

/**
 * The ceiling for one channel, given every channel's and its group's.
 *
 * The same single lookup `channelResolutionFloor` exists for: the pass, the
 * Teamarr comparison, the rule-check inputs and the check panel must all rank
 * a channel under the same ceiling or the panel's preview stops promising to
 * match what the worker writes.
 */
export function channelResolutionCeiling(
  ceilings: Map<number, MaxResolution | null>,
  channelId: number,
  group: MaxResolution | null | undefined,
): MaxResolution | undefined {
  return resolveResolutionCeiling(ceilings.get(channelId), group);
}
