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
 * simulcast in an otherwise HD group opts out of its group's floor. `1080`,
 * `1080p` and `4K` all read as you would expect; anything else is not a floor
 * anybody asked for, and reads as unset rather than failing the load.
 */
export function parseMinResolution(raw: unknown): MinResolution | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim().toLowerCase();
  if (text === '' || text === 'inherit') return undefined;
  if (text === 'none' || text === 'any') return null;
  if (text === '4k' || text === 'uhd') return '2160p';
  const key = (text.endsWith('p') ? text : `${text}p`) as MinResolution;
  return RESOLUTION_CHOICES.includes(key) ? key : undefined;
}

/**
 * The floor a channel ranks under: its own, else its group's.
 *
 * An explicit `null` on the channel beats the group's floor -- see
 * `parseMinResolution` for why a channel needs to be able to say "none".
 */
export function resolveResolutionFloor(
  channel: MinResolution | null | undefined,
  group: MinResolution | undefined,
): MinResolution | undefined {
  if (channel === null) return undefined;
  return channel ?? group;
}
