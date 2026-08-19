/**
 * Per-login probe targets.
 *
 * A Dispatcharr M3U account can carry several profiles -- separate logins to
 * the same upstream server. The stored stream URL is written with the default
 * profile's credentials, and at playback Dispatcharr rewrites it per profile
 * with that profile's search/replace pattern. Podium probes the same set of
 * URLs, so a stream's verdict reflects every login it could play through
 * rather than only the default one.
 */

import { type Provider, transformUrl } from './dispatcharr';
import type { ProbeResult } from './probe';
import { bitrateUnknown, DEFAULT_WEIGHTS, isUsable, score, type Weights } from './scoring';

/**
 * One probe target for a stream.
 *
 * `variantId` 0 is the stored URL (the default login); any other value is the
 * Dispatcharr profile id whose pattern produced `url`. `profileId` is the same
 * number in lane terms -- the dimension a per-login semaphore keys on.
 */
export interface StreamVariant {
  variantId: number;
  profileId: number;
  url: string;
}

/**
 * The probe targets for one stream.
 *
 * Always the stored URL; plus, when the account has more than one *active*
 * login, one rewritten URL per active non-default profile. Variants whose
 * pattern is broken, does not match, or lands on a URL another variant already
 * has are dropped -- probing the same address twice tells nobody anything. An
 * account with a single active profile gets exactly the one target, which is
 * the behaviour everything had before profiles existed.
 */
export function buildVariants(url: string, provider: Provider): StreamVariant[] {
  const out: StreamVariant[] = [{ variantId: 0, profileId: 0, url }];
  const active = provider.profiles.filter((p) => p.isActive);
  if (active.length <= 1) return out;

  const seen = new Set([url]);
  for (const profile of active) {
    if (profile.isDefault) continue;
    const rewritten = transformUrl(url, profile.searchPattern, profile.replacePattern);
    // Null is a broken pattern, and a rewrite equal to one already collected is
    // either a no-match (Dispatcharr falls back to the original) or two logins
    // sharing one address.
    if (rewritten === null || seen.has(rewritten)) continue;
    seen.add(rewritten);
    out.push({ variantId: profile.id, profileId: profile.id, url: rewritten });
  }
  return out;
}

/** A variant's verdict, paired with which login produced it. */
export interface VariantVerdict {
  variantId: number;
  result: ProbeResult;
}

/**
 * The one verdict a stream reports, from the verdicts of its variants.
 *
 * To Dispatcharr -- and everywhere on the podium pages -- the variants are one
 * stream: alive if any login can play it, carrying the measurements of the
 * best login that could. The ordering mirrors `rank()`'s comparator (usable,
 * then measured, then score) so the variant reported is the one the ranking
 * would have picked had the variants been separate streams; ties resolve to
 * the lower variantId, which puts the default login's verdict first among
 * equals. An empty input is no verdict at all.
 */
export function pickBestVariant(
  verdicts: VariantVerdict[],
  weights: Weights = DEFAULT_WEIGHTS,
): ProbeResult | null {
  let best: VariantVerdict | null = null;
  for (const verdict of verdicts) {
    if (best === null || compareVariants(verdict, best, weights) < 0) best = verdict;
  }
  return best?.result ?? null;
}

function compareVariants(a: VariantVerdict, b: VariantVerdict, weights: Weights): number {
  const usable = (isUsable(a.result, weights) ? 0 : 1) - (isUsable(b.result, weights) ? 0 : 1);
  if (usable !== 0) return usable;
  const measured = (bitrateUnknown(a.result) ? 1 : 0) - (bitrateUnknown(b.result) ? 1 : 0);
  if (measured !== 0) return measured;
  const delta = score(b.result, weights) - score(a.result, weights);
  if (delta !== 0) return delta;
  return a.variantId - b.variantId;
}
