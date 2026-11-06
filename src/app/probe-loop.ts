/**
 * The client loop behind both Check-all buttons: every probeable channel in a
 * group (the Groups tab) and every channel carrying a dead or black stream
 * (the Dead tab).
 *
 * It exists once because the two used to be copies, and every rule the loop
 * learned -- stop on capacity refusals, never apply a partial verdict, report
 * a failed apply -- had to be written twice or the buttons drifted apart.
 */

import { orderToApply } from './check-panel';

export interface ProbeTarget {
  id: number;
  name: string | null;
}

export interface ProbeProgress {
  current: number;
  total: number;
  channelName: string;
  probed: number;
  dead: number;
  applied: number;
}

export interface ProbeOutcome {
  total: number;
  completed: number;
  probed: number;
  dead: number;
  applied: number;
  /** Checks whose order was not applied because their verdicts were partial. */
  partial: number;
  /** Applies the endpoint refused -- a dry run, an empty order, a lost race. */
  applyFailed: number;
  errors: number;
  aborted: boolean;
  /** Stopped early: two consecutive or four total checks found no spare capacity. */
  capacityStopped: boolean;
}

interface CheckResponse {
  probed?: number;
  dead?: number;
  error?: string;
  identical?: boolean;
  allowed?: boolean;
  workerOrder?: number[];
  kept?: number[];
  dropOrder?: number[];
  pruned?: number[];
  unprobed?: unknown[];
  truncated?: boolean;
}

/**
 * Probe each channel in turn, applying what the checks imply.
 *
 * One at a time on purpose: a check holds provider connections for as long as
 * its streams take to answer, and a row of them at once would compete with the
 * very lanes the checks are drawing from.
 */
export async function probeChannels(
  targets: ProbeTarget[],
  opts: {
    signal: AbortSignal;
    /** Apply each check's implied order. Off for the group loop, which only measures. */
    autoApply?: boolean;
    onProgress?: (progress: ProbeProgress) => void;
  },
): Promise<ProbeOutcome> {
  const out: ProbeOutcome = {
    total: targets.length,
    completed: 0,
    probed: 0,
    dead: 0,
    applied: 0,
    partial: 0,
    applyFailed: 0,
    errors: 0,
    aborted: false,
    capacityStopped: false,
  };
  // A single 503 can be a stream ending mid-check; two in a row is every lane
  // taken, and the channels after it would each pay a full Dispatcharr preamble
  // only to be told the same thing.
  // Bound mixed-error runs too: unrelated failures reset the streak, but four
  // refusals across the run are enough to stop spending time on busy providers.
  let capacityRefusals = 0;
  let capacityRefusalTotal = 0;

  for (const [i, chan] of targets.entries()) {
    if (opts.signal.aborted) {
      out.aborted = true;
      break;
    }
    opts.onProgress?.({
      current: i + 1,
      total: targets.length,
      channelName: chan.name || `Channel ${chan.id}`,
      probed: out.probed,
      dead: out.dead,
      applied: out.applied,
    });

    let check: CheckResponse;
    try {
      const resp = await fetch(`/api/check/${chan.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: opts.signal,
      });
      check = (await resp.json()) as CheckResponse;
      if (!resp.ok || check.error) {
        out.errors++;
        capacityRefusals = resp.status === 503 ? capacityRefusals + 1 : 0;
        if (resp.status === 503) capacityRefusalTotal++;
        if (capacityRefusals >= 2 || capacityRefusalTotal >= 4) {
          out.capacityStopped = true;
          break;
        }
        continue;
      }
    } catch {
      if (opts.signal.aborted) {
        out.aborted = true;
        break;
      }
      capacityRefusals = 0;
      out.errors++;
      continue;
    }
    capacityRefusals = 0;
    out.completed++;
    out.probed += check.probed ?? 0;
    out.dead += check.dead ?? 0;

    if (!opts.autoApply || check.identical || !check.workerOrder) continue;
    // A check that could not probe every stream the rule claims -- viewers
    // holding the lanes, or a rule matching past the endpoint's 50-stream
    // bound -- composes `workerOrder` from the verdicts it did get. The panel
    // surfaces `unprobed` and `truncated` for a person to weigh; an automatic
    // run defers to the next check rather than writing them.
    if ((check.unprobed?.length ?? 0) > 0 || check.truncated) {
      out.partial++;
      continue;
    }
    const targetOrder = orderToApply(
      {
        dropOrder: check.dropOrder ?? [],
        kept: check.kept ?? [],
        workerOrder: check.workerOrder,
      },
      false,
    );
    if (targetOrder.length === 0) continue;
    try {
      const resp = await fetch(`/api/apply/${chan.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: opts.signal,
        body: JSON.stringify({
          order: targetOrder,
          removeUnmatched: false,
          force: check.allowed === false,
          allowAssign: true,
          pruned: check.pruned ?? [],
        }),
      });
      // A refused apply is a fact about the run (a dry-run install refuses
      // every one of them), not something to fold into "applied".
      if (resp.ok) out.applied++;
      else out.applyFailed++;
    } catch {
      if (opts.signal.aborted) {
        out.aborted = true;
        break;
      }
      out.applyFailed++;
    }
  }
  return out;
}

/**
 * The one-line summary both tabs show under their Check-all button.
 *
 * `dryRun` is the effective setting, passed by a view that read it from
 * `/api/settings`. Under a dry run the server refuses every apply -- by
 * design -- so a bare "N apply failed" in red reads as a breakage when it is
 * the install doing exactly what it was configured to do. The refusals are
 * still counted and still reported; they are just named for what they are,
 * and the line stays green.
 */
export function probeNote(
  out: ProbeOutcome,
  opts: { dryRun?: boolean } = {},
): { text: string; bad: boolean } {
  const stats = `${out.probed} streams checked, ${out.dead} dead`;
  const applied = out.applied > 0 ? ` · ${out.applied} applied` : '';
  if (out.capacityStopped) {
    return {
      text: `Check stopped after ${out.completed} of ${out.total} channel(s): no spare provider capacity (${stats}${applied}). Try again once the watched stream ends or the worker's pass finishes.`,
      bad: false,
    };
  }
  if (out.aborted) {
    return {
      text: `Check cancelled after ${out.completed} of ${out.total} channel(s) (${stats}${applied}).`,
      bad: false,
    };
  }
  const segments =
    applied +
    (out.partial > 0 ? ` · ${out.partial} not applied (partial verdicts)` : '') +
    (out.applyFailed > 0
      ? opts.dryRun
        ? ` · ${out.applyFailed} left as-is (dry run)`
        : ` · ${out.applyFailed} apply failed`
      : '') +
    (out.errors > 0 ? ` · ${out.errors} skipped or failed` : '');
  return {
    text: `Finished checking ${out.completed} channel(s) (${stats})${segments}.`,
    bad:
      (out.errors > 0 && out.completed === 0) ||
      (out.applyFailed > 0 && out.applied === 0 && !opts.dryRun),
  };
}
