/**
 * Where a probe goes, and who it says it is.
 *
 * One question with three answers that must agree, which is why they live
 * together rather than being read off the config at each use. Probing through
 * Dispatcharr's proxy changes the address ffprobe opens, the User-Agent it
 * opens it with, and how `/proxy/ts/status` must be read afterwards -- and any
 * two of those without the third is a broken install rather than a partial
 * feature:
 *
 *   - address without agent: every probe is indistinguishable from a viewer,
 *     so the pacer shrinks each lane by the work already running in it and
 *     "pause when watching" aborts each pass on its own first probe.
 *   - agent without the read: same outcome, since nothing acts on the tag.
 *   - the read without the address: harmless but pointless -- no session
 *     carries the agent, so nothing is ever filtered.
 *
 * See `PODIUM_PROBE_VIA_DISPATCHARR` for what the mode buys and what it costs.
 */

import type { RawConfig } from './config';
import type { ActiveSessionOptions } from './dispatcharr';

type Routing = Pick<
  RawConfig,
  | 'DISPATCHARR_URL'
  | 'PODIUM_PROBE_VIA_DISPATCHARR'
  | 'PODIUM_PROBE_CLIENT_USER_AGENT'
  | 'PODIUM_USER_AGENT'
>;

/**
 * The base URL probes are routed through, or null to probe providers directly.
 *
 * The same address the API client uses. Podium already has to reach Dispatcharr
 * over HTTP to do anything at all, so a second knob for the proxy would be one
 * more thing to get wrong for a case (a Dispatcharr whose API and proxy live at
 * different addresses) that does not exist.
 */
export function probeProxyBase(config: Routing): string | null {
  return config.PODIUM_PROBE_VIA_DISPATCHARR ? config.DISPATCHARR_URL : null;
}

/**
 * The User-Agent a probe identifies itself with.
 *
 * Two different jobs, so two different values. Probing directly, the agent
 * reaches the *provider* and its job is to look like a player -- several
 * providers answer differently, or not at all, to anything that does not. In
 * proxy mode it reaches only Dispatcharr (the provider sees whatever the M3U
 * account is set to) and its job is the opposite: to look like nothing else on
 * the network, so Podium's own sessions can be subtracted from the viewer
 * counts it paces itself against.
 */
export function probeUserAgent(config: Routing): string {
  return config.PODIUM_PROBE_VIA_DISPATCHARR
    ? config.PODIUM_PROBE_CLIENT_USER_AGENT
    : config.PODIUM_USER_AGENT;
}

/**
 * How to read `/proxy/ts/status` under the current routing.
 *
 * Empty when probing directly: no session out there is Podium's, so there is
 * nothing to discount and the payload is read exactly as it always was.
 */
export function activityOptions(config: Routing): ActiveSessionOptions {
  return config.PODIUM_PROBE_VIA_DISPATCHARR
    ? { ignoreUserAgent: config.PODIUM_PROBE_CLIENT_USER_AGENT }
    : {};
}
