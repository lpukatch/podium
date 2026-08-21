/**
 * Which login probes a stream, and at which URL.
 *
 * A Dispatcharr M3U account can carry several profiles -- separate logins to
 * the same upstream server. The stored stream URL is written from the account's
 * own credentials, and at playback Dispatcharr rewrites it with the chosen
 * profile's search/replace pattern -- the *default* profile included, which is
 * created as an identity rewrite but can be edited to, say, swap a LAN address
 * for a WAN one. Podium reproduces those rewrites so it probes the URL a login
 * actually plays.
 *
 * The logins are a *pool*, not a fan-out. Each is a separate line into the same
 * upstream with its own connection cap, so their capacities add up and a
 * verdict fetched through any of them describes the stream. A stream is drawn
 * by one login per pass (`drawVariant`) and cached once; two logins at 3 and 2
 * get through the catalogue five streams at a time. See `drawVariant` for why
 * the alternative -- probing every stream through every login -- was measured
 * to be strictly worse.
 */

import {
  type Provider,
  type ProviderProfile,
  transformUrl,
  xtreamPlaybackUrl,
} from './dispatcharr';
import type { ProbeResult } from './probe';
import { laneKey } from './scheduler';
import { bitrateUnknown, DEFAULT_WEIGHTS, isUsable, score, type Weights } from './scoring';

/**
 * One login on a provider: a lane of its own, and a rewrite that turns the
 * stored stream URL into the URL that login plays.
 *
 * `id` is 0 for the default login and the profile id for every other. It is the
 * profile half of the lane key, which is what decides whose connection a probe
 * occupies. Zero is safe as the default's marker because Dispatcharr profile
 * ids start at 1, and it keeps a single-login account on exactly the lane it
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
 *
 * `profileId` is the lane -- the login whose connection this probe occupies.
 * `variantId` is the cache key, and under pooling it is always 0: a stream is
 * probed through *one* login per pass and the verdict describes the stream, not
 * the login that happened to fetch it, so there is one cache row per stream
 * however many logins the account carries. The column stays in `probe_cache`
 * because rows written by the fan-out that preceded this still key on it; they
 * are swept by `pruneVariants` on the first pass after the upgrade.
 */
export interface StreamVariant {
  variantId: number;
  profileId: number;
  url: string;
}

/** The cache key every pooled verdict is written under. See `StreamVariant`. */
export const POOLED_VARIANT = 0;

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
 * The distinct probe targets a stream offers, one per login that reaches a URL
 * no other login already covers.
 *
 * This is the *menu*, not the work: `drawVariant` picks one entry from it, and
 * only that one is probed. What the list is for is deciding which logins are
 * genuinely separate lines into the provider, because a login that reaches the
 * same URL as another is not extra capacity -- it is the same credentials
 * twice, and drawing on it would put more connections against that line than it
 * allows.
 *
 * A login whose rewrite is unusable falls back to the stored URL rather than
 * disappearing, because that is what Dispatcharr's `transform_url` does with a
 * pattern that throws -- it returns its input. The dedupe then drops it: the
 * first login to claim a URL keeps it, so the default login holds the stored
 * URL and a broken profile falls in behind it and contributes no lane. That is
 * both the right outcome and the one Dispatcharr would produce.
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
    out.push({ variantId: POOLED_VARIANT, profileId: login.id, url: target });
  }
  // Only reachable when the caller passed no logins at all: `providerLogins`
  // always names at least one, synthesising the stored-URL default for an
  // account Dispatcharr reports no profiles for.
  if (out.length === 0) out.push({ variantId: POOLED_VARIANT, profileId: 0, url });
  return out;
}

/**
 * Which login draws this stream: one target from the menu, never all of them.
 *
 * The logins on an account are separate lines into the *same* upstream, so a
 * verdict fetched through any of them describes the stream just as well as a
 * verdict fetched through another. That makes them a pool rather than a
 * fan-out: an account with a 3-connection login and a 2-connection one gets
 * through the catalogue five streams at a time, not the same stream five ways.
 *
 * Probing every login instead was measured, on a live install, to cost exactly
 * what it sounds like -- 2134 probes for 1067 streams -- while 98 streams
 * checked on both logins produced 98 identical verdicts. Adding the second
 * login that way made the provider's sweep *slower* than it had been on one
 * login, because capacity rose 1.67x and the work rose 2x.
 *
 * `slots` is the pacer's post-viewer lane map, keyed as `laneKey` writes it, so
 * the draw is weighted by what each login can actually spare this pass: a login
 * whose connections are all occupied by people watching TV draws nothing, and
 * one with four free slots draws twice as often as one with two. `seq` is a
 * counter the caller advances per stream on the provider, which spreads the
 * catalogue across the logins in exactly that ratio rather than approximately.
 *
 * With no lane open at all the first target stands. That is deliberately a job
 * the caller cannot run: it lets the pass account for the stream as *deferred*
 * for want of capacity -- which it is -- rather than silently dropping it and
 * reporting a catalogue that looks fully checked.
 */
export function drawVariant(
  variants: StreamVariant[],
  providerId: number,
  slots: Map<string, number>,
  seq: number,
): StreamVariant {
  let total = 0;
  for (const variant of variants) {
    total += Math.max(0, slots.get(laneKey(providerId, variant.profileId)) ?? 0);
  }
  const first = variants[0];
  if (first === undefined) throw new Error('drawVariant needs at least one target');
  if (total === 0) return first;

  // Weighted round-robin without materialising the cycle: walk the logins
  // subtracting their widths until the counter lands inside one.
  let k = ((seq % total) + total) % total;
  for (const variant of variants) {
    const width = Math.max(0, slots.get(laneKey(providerId, variant.profileId)) ?? 0);
    if (k < width) return variant;
    k -= width;
  }
  // Unreachable: the widths sum to `total` and `k < total` on entry.
  return first;
}

/** A verdict, paired with the cache row it came from. */
export interface VariantVerdict {
  variantId: number;
  result: ProbeResult;
}

/**
 * The one verdict a stream reports, from whatever the cache holds for it.
 *
 * Pooling makes that a single row, and this returns it. It stays a fold because
 * a cache written by the per-login probing that preceded pooling holds a row
 * per login until `pruneVariants` sweeps them, and those rows must read as one
 * stream in the meantime: alive if any login could play it, carrying the
 * measurements of the best that could. The ordering mirrors `rank()`'s
 * comparator (usable, then measured, then score) so the verdict reported is
 * the one the ranking would have picked had the rows been separate streams;
 * ties resolve to the lower variantId, which puts the default login's verdict
 * first among equals -- the same order Dispatcharr tries them in at playback.
 * An empty input is no verdict at all.
 */
export function pickBestVariant(
  verdicts: VariantVerdict[],
  weights: Weights = DEFAULT_WEIGHTS,
  audioOnly = false,
): ProbeResult | null {
  let best: VariantVerdict | null = null;
  for (const verdict of verdicts) {
    if (best === null || compareVariants(verdict, best, weights, audioOnly) < 0) best = verdict;
  }
  return best?.result ?? null;
}

function compareVariants(
  a: VariantVerdict,
  b: VariantVerdict,
  weights: Weights,
  audioOnly = false,
): number {
  const usable =
    (isUsable(a.result, weights, audioOnly) ? 0 : 1) -
    (isUsable(b.result, weights, audioOnly) ? 0 : 1);
  if (usable !== 0) return usable;
  const measured = (bitrateUnknown(a.result) ? 1 : 0) - (bitrateUnknown(b.result) ? 1 : 0);
  if (measured !== 0) return measured;
  const delta = score(b.result, weights, audioOnly) - score(a.result, weights, audioOnly);
  if (delta !== 0) return delta;
  return a.variantId - b.variantId;
}
