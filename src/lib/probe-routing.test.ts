import { describe, expect, it } from 'vitest';
import { activityOptions, probeProxyBase, probeUserAgent } from './probe-routing';

const direct = {
  DISPATCHARR_URL: 'http://dispatcharr:9191',
  PODIUM_PROBE_VIA_DISPATCHARR: false,
  PODIUM_PROBE_CLIENT_USER_AGENT: 'Podium-Probe/1',
  PODIUM_USER_AGENT: 'VLC/3.0.14',
};

describe('probe routing', () => {
  it('leaves direct probes and status reads unchanged by default', () => {
    expect(probeProxyBase(direct)).toBeNull();
    expect(probeUserAgent(direct)).toBe('VLC/3.0.14');
    expect(activityOptions(direct)).toEqual({});
  });

  it('switches the address, user agent, and activity filter together', () => {
    const proxied = { ...direct, PODIUM_PROBE_VIA_DISPATCHARR: true };
    expect(probeProxyBase(proxied)).toBe('http://dispatcharr:9191');
    expect(probeUserAgent(proxied)).toBe('Podium-Probe/1');
    expect(activityOptions(proxied)).toEqual({ ignoreUserAgent: 'Podium-Probe/1' });
  });
});
