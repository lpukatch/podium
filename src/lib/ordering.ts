/**
 * Resolving the ranking strategy from configuration.
 *
 * `rank()` (see scoring.ts) takes a `RankStrategy` -- mode, weights, and a
 * provider-preference map. Those are not stored ready-made anywhere: the mode
 * and the human-readable provider names come from the rules `ordering` block,
 * the weight overrides too, and the bitrate floor falls back to an environment
 * knob that existing installs rely on. This module turns that bag of inputs into
 * the one object the comparator needs, once per pass.
 */

import { DEFAULT_WEIGHTS, type RankStrategy, type Weights } from './scoring';

export type { OrderingMode } from './scoring';

/** The subset of `Weights` an operator is allowed to override from the rules file. */
export type WeightOverrides = Partial<Weights>;

/** Parsed (but not yet resolved) ordering configuration from the rules file. */
export interface OrderingConfig {
  mode: RankStrategy['mode'];
  /** Provider display names, most-preferred first. Used only in `provider` mode. */
  providerPreference: string[];
  /** camelCase weight overrides; anything unset falls back to the built-in defaults. */
  weights: WeightOverrides;
}

/** Quality-first, no overrides -- the out-of-the-box behaviour. */
export const DEFAULT_ORDERING: OrderingConfig = {
  mode: 'quality',
  providerPreference: [],
  weights: {},
};

/**
 * Turn an `OrderingConfig` into a `RankStrategy` against the live provider list.
 *
 * Provider names are matched case-insensitively against the live id->name map, so
 * an operator can write the name as Dispatcharr shows it without worrying about
 * exact casing. A name that matches no provider simply contributes nothing (that
 * tier is empty) rather than failing the pass -- a typo should not halt ranking.
 */
export function resolveOrdering(
  config: OrderingConfig | undefined,
  providerNames: Map<number, string>,
  envMinBitrateKbps: number,
): RankStrategy {
  const cfg = config ?? DEFAULT_ORDERING;

  const weights: Weights = {
    ...DEFAULT_WEIGHTS,
    ...cfg.weights,
    // The floor defaults to the environment knob for back-compat, but an explicit
    // value in the rules file wins -- it is the more specific, intentional setting.
    minBitrateKbps: cfg.weights.minBitrateKbps ?? envMinBitrateKbps,
  };

  const providerRank = new Map<number, number>();
  if (cfg.mode === 'provider') {
    const wanted = cfg.providerPreference.map((name) => name.trim().toLowerCase()).filter(Boolean);
    for (const [providerId, name] of providerNames) {
      const tier = wanted.indexOf(name.trim().toLowerCase());
      if (tier >= 0) providerRank.set(providerId, tier);
    }
  }

  return { mode: cfg.mode, weights, providerRank };
}
