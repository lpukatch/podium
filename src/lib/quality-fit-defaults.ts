/**
 * The fit numbers everything falls back to when no stored setting exists yet:
 * the schema defaults for `PODIUM_QUALITY_MIN_SAMPLES` and
 * `PODIUM_QUALITY_POINTS_PER_MBPS`, held in one leaf constant.
 *
 * This file is deliberately importable from anywhere -- it pulls in nothing --
 * because both sides of the fallback need it: `profileQuery`'s URL sweep (and
 * `buildProfile`/`teamarrRules` when their caller omits the option) on the
 * server, and the Quality tab's pre-profile copy in the browser, which must
 * not import the server config machinery to know what the defaults are. A
 * test in settings.test.ts pins the constant to `CONFIG_DEFAULTS`, so the
 * three cannot drift.
 */
export const QUALITY_FIT_DEFAULTS: { minSamples: number; pointsPerMbps: number } = {
  minSamples: 20,
  pointsPerMbps: 5,
};
