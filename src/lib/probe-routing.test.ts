import { describe, expect, it } from 'vitest';
import {
  activityOptions,
  probeProxyBase,
  probeUserAgent,
  soakProxyBase,
  soakUserAgent,
} from './probe-routing';

const direct = {
  DISPATCHARR_URL: 'http://dispatcharr:9191',
  PODIUM_PROBE_VIA_DISPATCHARR: false,
  PODIUM_SOAK_VIA_DISPATCHARR: false,
  PODIUM_PROBE_CLIENT_USER_AGENT: 'Podium-Probe/1',
  PODIUM_USER_AGENT: 'VLC/3.0.14',
};

describe('probe routing', () => {
  it('leaves direct probes and status reads unchanged by default', () => {
    expect(probeProxyBase(direct)).toBeNull();
    expect(probeUserAgent(direct)).toBe('VLC/3.0.14');
    expect(probeUserAgent(direct, 'Vendor Player/1.0')).toBe('Vendor Player/1.0');
    expect(soakProxyBase(direct)).toBeNull();
    expect(soakUserAgent(direct)).toBe('VLC/3.0.14');
    expect(activityOptions(direct)).toEqual({});
  });

  it('switches the address, user agent, and activity filter together', () => {
    const proxied = { ...direct, PODIUM_PROBE_VIA_DISPATCHARR: true };
    expect(probeProxyBase(proxied)).toBe('http://dispatcharr:9191');
    expect(probeUserAgent(proxied)).toBe('Podium-Probe/1');
    expect(probeUserAgent(proxied, 'Vendor Player/1.0')).toBe('Podium-Probe/1');
    expect(activityOptions(proxied)).toEqual({ ignoreUserAgent: 'Podium-Probe/1' });
  });

  it('routes only soaks through Dispatcharr when requested', () => {
    const proxied = { ...direct, PODIUM_SOAK_VIA_DISPATCHARR: true };
    expect(probeProxyBase(proxied)).toBeNull();
    expect(soakProxyBase(proxied)).toBe('http://dispatcharr:9191');
    expect(soakUserAgent(proxied)).toBe('Podium-Probe/1');
    expect(activityOptions(proxied)).toEqual({ ignoreUserAgent: 'Podium-Probe/1' });
  });
});
