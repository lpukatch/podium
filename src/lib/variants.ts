/**
 * Per-login probe targets.
 *
 * A Dispatcharr M3U account can carry several profiles -- separate logins to
 * the same upstream server. The stored stream URL is written from the account's
 * own credentials, and at playback Dispatcharr rewrites it with the chosen
 * profile's search/replace pattern -- the *default* profile included, which is
 * created as an identity rewrite but can be edited to, say, swap a LAN address
 * for a WAN one. Podium probes the same set of URLs, so a stream's verdict
 * reflects every login it could play through rather than only one of them.
 */

import {
  type Provider,
  type ProviderProfile,
  transformUrl,
  xtreamPlaybackUrl,
} from './dispatcharr';
import type { ProbeResult } from './probe';
import { bitrateUnknown, DEFAULT_WEIGHTS, isUsable, score, type Weights } from './scoring';

/**
 * One login on a provider: a lane of its own, and a rewrite that turns the
 * stored stream URL into the URL that login plays.
 *
 * `id` is 0 for the default login and the profile id for every other, which is
 * both the variant id the cache keys on and the profile half of the lane key.
 * Zero is safe as the default's marker because Dispatcharr profile ids start at
 * 1, and it keeps a single-login account on exactly the lane and cache rows it
 * had before profiles existed.
 */
export interface ProviderLogin {
  id: number;
  /**
   * The profile's own id in Dispatcharr, which `id` discards for the default
   * login. Kept because `/proxy/ts/status` names the login a viewer is on by
   * this id, and charging that viewer to the right lane needs the two to be
   * matchable. Null only for an account Dispatcharr reports no profiles for,
   * which has no profile to name.
   */
  dispatcharrProfileId: number | null;
  name: string;
  /** null when this login plays the stored URL unchanged. */
  rewrite: { search: string; replace: string } | null;
  /** This login's own connection cap, already resolved against the account's. */
  maxStreams: number;
  /** What Dispatcharr reports is currently playing through this login. */
  currentViewers: number;
  /** True for the login the stored URL's credentials belong to. */
  isDefault: boolean;
  /**
   * True when the account is Xtream Codes, whose playback URL is rebuilt from
   * transformed credentials rather than rewritten. See `xtreamPlaybackUrl`.
   */
  xtreamCodes: boolean;
}

/**
 * The logins Podium should probe a provider through, and pace itself against.
 *
 * Only *active* profiles: an account with one is the shape everything had
 * before profiles existed, and the ones Dispatcharr will not play through are
 * not worth a connection. Where Dispatcharr has no profiles to report at all --
 * an older build, or a provider the catalogue does not carry -- the stored URL
 * stands on its own, unrewritten.
 *
 * A deactivated *default* is the one case worth spelling out: Dispatcharr
 * refuses to play such an account at all ("M3U account has no default
 * profile"), and the stored URL carries exactly the credentials it has switched
 * off. Probing it would measure a login nobody can watch through, so the
 * remaining active profiles get the lanes and the stored URL gets none.
 */
export function providerLogins(provider: Provider): ProviderLogin[] {
  const xtreamCodes = provider.accountType === 'XC';
  const active = provider.profiles.filter((p) => p.isActive);
  if (active.length === 0) {
    return [
      {
        id: 0,
        dispatcharrProfileId: null,
        name: 'default',
        rewrite: null,
        maxStreams: provider.maxStreams,
        currentViewers: 0,
        isDefault: true,
        xtreamCodes,
      },
    ];
  }

  const out: ProviderLogin[] = [];
  const cap = (profile: ProviderProfile) => profile.maxStreams ?? provider.maxStreams;
  const defaultProfile = active.find((p) => p.isDefault);
  if (defaultProfile) {
    out.push({
      id: 0,
      dispatcharrProfileId: defaultProfile.id,
      name: defaultProfile.name,
      // Applied rather than assumed: the default profile's pattern is an
      // identity rewrite when Dispatcharr creates it, but the M3U profile
      // editor exposes it precisely so it can be made to do something.
      rewrite: { search: defaultProfile.searchPattern, replace: defaultProfile.replacePattern },
      maxStreams: cap(defaultProfile),
      currentViewers: defaultProfile.currentViewers,
      isDefault: true,
      xtreamCodes,
    });
  }
  for (const profile of active) {
    if (profile.isDefault) continue;
    out.push({
      id: profile.id,
      dispatcharrProfileId: profile.id,
      name: profile.name,
      rewrite: { search: profile.searchPattern, replace: profile.replacePattern },
      maxStreams: cap(profile),
      currentViewers: profile.currentViewers,
      isDefault: false,
      xtreamCodes,
    });
  }
  return out;
}

/**
 * One probe target for a stream: which login it authenticates as, and the URL
 * that login plays.
 */
export interface StreamVariant {
  variantId: number;
  profileId: number;
  url: string;
}

/**
 * Why a login contributed no target of its own.
 *
 * `unusable-pattern` is a configuration error -- an empty search pattern, one
 * JS cannot compile even after the Python spellings are translated, or a
 * replacement carrying an escape `re.sub` would reject. `duplicate-url` is a
 * rewrite that landed on a
 * URL another login already probes, which is either a pattern that did not
 * match anything or two profiles genuinely sharing an address.
 */
export type VariantIssue = 'unusable-pattern' | 'duplicate-url';

/**
 * The probe targets for one stream, one per login that reaches a distinct URL.
 *
 * A login whose rewrite is unusable falls back to the stored URL rather than
 * disappearing, because that is what Dispatcharr's `transform_url` does with a
 * pattern that throws -- it returns its input. What then decides whether the
 * login gets a target of its own is the dedupe: probing one address twice tells
 * nobody anything and costs a connection to learn it, so the first login to
 * claim a URL keeps it. In practice that means the default login holds the
 * stored URL and a broken profile falls in behind it, which is both the right
 * outcome and the one Dispatcharr would produce.
 *
 * `onIssue` reports every login that ended up with no target, and why -- the
 * unusable pattern in preference to the dedupe it then lost, since that is the
 * fault worth fixing. It fires per stream, so callers with a catalogue to get
 * through should fold the reports by login rather than log them as they arrive.
 */
export function buildVariants(
  url: string,
  logins: ProviderLogin[],
  onIssue?: (login: ProviderLogin, issue: VariantIssue) => void,
): StreamVariant[] {
  const out: StreamVariant[] = [];
  const seen = new Set<string>();
  for (const login of logins) {
    let target = url;
    let issue: VariantIssue | null = null;
    if (login.rewrite) {
      const { search, replace } = login.rewrite;
      if (login.xtreamCodes && (!search || !replace)) {
        // An XC account transforms only when both halves of the pair are set;
        // with either missing Dispatcharr plays the account's own credentials,
        // which is the stored URL. Called out rather than left to the dedupe,
        // because a half-filled pattern is a profile that silently does
        // nothing.
        issue = 'unusable-pattern';
      } else {
        const rewritten = transformUrl(url, search, replace);
        if (rewritten === null) issue = 'unusable-pattern';
        else target = login.xtreamCodes ? xtreamPlaybackUrl(url, rewritten) : rewritten;
      }
    }
    if (seen.has(target)) {
      onIssue?.(login, issue ?? 'duplicate-url');
      continue;
    }
    if (issue) onIssue?.(login, issue);
    seen.add(target);
    out.push({ variantId: login.id, profileId: login.id, url: target });
  }
  // Only reachable when the caller passed no logins at all: `providerLogins`
  // always names at least one, synthesising the stored-URL default for an
  // account Dispatcharr reports no profiles for.
  if (out.length === 0) out.push({ variantId: 0, profileId: 0, url });
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
 * equals -- the same order Dispatcharr tries them in at playback. An empty
 * input is no verdict at all.
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
