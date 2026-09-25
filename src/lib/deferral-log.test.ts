import { describe, expect, it } from 'vitest';
import { DEFERRED_LOG_EVERY_MS, DeferralLog } from './deferral-log';

describe('DeferralLog', () => {
  it('logs the first pass of an episode with the old wording', () => {
    const log = new DeferralLog();
    expect(log.note('6', 72, 1_000)).toBe(
      'deferring 72 streams on provider(s) 6: no spare capacity',
    );
  });

  it('stays quiet while the same provider set holds, then heartbeats', () => {
    // A 30-minute heartbeat against the live pass cadence of ~90s: three hours
    // of viewing is 120 passes, of which five say anything.
    const log = new DeferralLog(30 * 60_000);
    const start = 1_000;
    expect(log.note('6', 72, start)).toContain('deferring 72');
    let lines = 0;
    for (let t = start + 90_000; t < start + 3 * 3_600_000; t += 90_000) {
      if (log.note('6', 80, t) !== null) lines += 1;
    }
    expect(lines).toBe(5); // at 30, 60, 90, 120, 150 minutes
    // The heartbeat says it is a continuation and for how long.
    expect(log.note('6', 80, start + 3 * 3_600_000)).toBe(
      'still deferring 80 streams on provider(s) 6: no spare capacity (180m)',
    );
  });

  it('logs again as soon as the provider set changes', () => {
    const log = new DeferralLog(30_000);
    expect(log.note('6', 72, 1_000)).toContain('provider(s) 6');
    expect(log.note('6', 72, 2_000)).toBeNull();
    // A second provider saturates: new episode, new line, no waiting out the
    // heartbeat.
    expect(log.note('6, 12', 90, 3_000)).toBe(
      'deferring 90 streams on provider(s) 6, 12: no spare capacity',
    );
  });

  it('names the episode end once, with its length', () => {
    const log = new DeferralLog(30_000);
    log.note('6', 72, 1_000);
    expect(log.cleared(1_000 + 95 * 60_000)).toBe(
      'provider(s) 6 probing again after 95m at capacity',
    );
    // Nothing further: the next quiet pass and the next episode both start clean.
    expect(log.cleared(1_000 + 96 * 60_000)).toBeNull();
    expect(log.note('6', 5, 1_000 + 97 * 60_000)).toContain('deferring 5');
  });

  it('never heartbeats before the configured interval', () => {
    const log = new DeferralLog(DEFERRED_LOG_EVERY_MS);
    const start = 1_000;
    log.note('6', 72, start);
    expect(log.note('6', 72, start + DEFERRED_LOG_EVERY_MS - 1)).toBeNull();
    expect(log.note('6', 72, start + DEFERRED_LOG_EVERY_MS)).toContain('still deferring');
  });
});
