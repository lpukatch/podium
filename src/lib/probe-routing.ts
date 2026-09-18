import type { RawConfig } from './config';
import type { StatusOptions } from './dispatcharr';

type RoutingConfig = Pick<
  RawConfig,
  | 'DISPATCHARR_URL'
  | 'PODIUM_PROBE_VIA_DISPATCHARR'
  | 'PODIUM_SOAK_VIA_DISPATCHARR'
  | 'PODIUM_PROBE_CLIENT_USER_AGENT'
  | 'PODIUM_USER_AGENT'
>;

export function probeProxyBase(config: RoutingConfig): string | null {
  return config.PODIUM_PROBE_VIA_DISPATCHARR ? config.DISPATCHARR_URL : null;
}

export function probeUserAgent(config: RoutingConfig): string {
  return config.PODIUM_PROBE_VIA_DISPATCHARR
    ? config.PODIUM_PROBE_CLIENT_USER_AGENT
    : config.PODIUM_USER_AGENT;
}

export function soakProxyBase(config: RoutingConfig): string | null {
  return config.PODIUM_SOAK_VIA_DISPATCHARR ? config.DISPATCHARR_URL : null;
}

export function soakUserAgent(config: RoutingConfig): string {
  return config.PODIUM_SOAK_VIA_DISPATCHARR
    ? config.PODIUM_PROBE_CLIENT_USER_AGENT
    : config.PODIUM_USER_AGENT;
}

export function activityOptions(config: RoutingConfig): StatusOptions {
  return config.PODIUM_PROBE_VIA_DISPATCHARR || config.PODIUM_SOAK_VIA_DISPATCHARR
    ? { ignoreUserAgent: config.PODIUM_PROBE_CLIENT_USER_AGENT }
    : {};
}
