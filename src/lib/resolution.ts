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
