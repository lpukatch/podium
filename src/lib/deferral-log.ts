/**
 * The no-capacity log line, once per episode rather than once per pass.
 *
 * "deferring 72 streams on provider(s) 6: no spare capacity" used to print on
 * every pass for as long as a provider had no lane -- and a provider with
 * viewers has no lane for the length of a game. Measured on a live install,
 * that is near-identical lines every 90 seconds across a viewing evening, and
 * 88-99k deferred streams *per day* across a weekend: a thousand lines saying
 * the same thing, burying the reorders and dead verdicts between them.
 *
 * The count still moves every pass, so it cannot be the trigger. What actually
 * changes is whether a provider is at capacity at all, so that is what logs:
 * the first pass that defers on a provider set, a heartbeat while the same set
 * holds, and one line when the episode ends and probing resumes. The per-pass
 * count stays available in `podium_run_deferred` and the progress view.
 */

/** How often to repeat the line while the same provider set stays at capacity. */
export const DEFERRED_LOG_EVERY_MS = 30 * 60_000;

const minutes = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))}m`;

export class DeferralLog {
  /** The provider set being deferred on, '' when nothing is. */
  private key = '';
  private beganAt = 0;
  private lastLoggedAt = 0;

  constructor(private readonly everyMs: number = DEFERRED_LOG_EVERY_MS) {}

  /**
   * The line for a pass that deferred `count` streams on `providers`, or null
   * when the episode is ongoing and the heartbeat has not come due. The first
   * line keeps the wording the old per-pass line had, so existing greps and
   * log parsers keep working.
   */
  note(providers: string, count: number, now: number): string | null {
    if (providers !== this.key) {
      this.key = providers;
      this.beganAt = now;
      this.lastLoggedAt = now;
      return `deferring ${count} streams on provider(s) ${providers}: no spare capacity`;
    }
    if (now - this.lastLoggedAt < this.everyMs) return null;
    this.lastLoggedAt = now;
    return (
      `still deferring ${count} streams on provider(s) ${providers}: no spare capacity ` +
      `(${minutes(now - this.beganAt)})`
    );
  }

  /**
   * The line for a pass that deferred nothing, when the previous one did --
   * the end of the episode, which under the old logging was only ever
   * inferable from the lines stopping.
   */
  cleared(now: number): string | null {
    if (this.key === '') return null;
    const providers = this.key;
    const beganAt = this.beganAt;
    this.key = '';
    this.beganAt = 0;
    this.lastLoggedAt = 0;
    return `provider(s) ${providers} probing again after ${minutes(now - beganAt)} at capacity`;
  }
}
