/**
 * Field dependencies as the settings form renders them.
 *
 * A leaf module on purpose: `settings.ts` knows these clauses too, but it also
 * carries the server config machinery, and the form needs the logic without
 * pulling a zod parse and the environment reader into the browser bundle. The
 * group integrity test imports both sides, so the two cannot drift.
 *
 * Reads the *displayed* form -- the same strings the settings page shows -- so
 * one implementation serves the form (against in-progress edits) and anything
 * reading stored values through `describeSettings`. Booleans are expected
 * normalised to exactly "true"/"false", which is what the form writes and what
 * `validateSettings` stores; a raw environment value of "1" is normalised on
 * its way into the form. `gt0` survives unit scaling, since scaling preserves
 * whether a number is above zero.
 */

export interface RequireClause {
  key: string;
  state: 'on' | 'set' | 'gt0';
}

/** The parts of a field the checks below read. */
export interface DependentField {
  key: string;
  requiresAll?: RequireClause[];
  requiresAny?: RequireClause[];
  clampedBy?: { key: string; direction: 'max' | 'min' };
  scale?: number;
}

/** What another field's displayed value must be for a clause to hold. */
export function unsatisfiedRequires(
  field: DependentField,
  values: Record<string, string>,
): RequireClause[] {
  const holds = (clause: RequireClause): boolean => {
    const text = (values[clause.key] ?? '').trim();
    if (clause.state === 'on') return text === 'true';
    if (clause.state === 'gt0') return Number(text) > 0;
    return text !== '';
  };
  const unmet = (field.requiresAll ?? []).filter((clause) => !holds(clause));
  if (field.requiresAny && !field.requiresAny.some(holds)) unmet.push(...field.requiresAny);
  return unmet;
}

/** The parts of a *target* field a clamp note needs to name it. */
export interface ClampTarget {
  key: string;
  label: string;
  scale?: number;
}

/**
 * The note for a field the code will silently bound against another, or null
 * while the displayed value sits inside that bound.
 *
 * A note rather than an error, on purpose: storing a back-off above the wait it
 * is capped by saves as typed and simply takes effect clipped, which is how the
 * code has always read the pair. Compared in stored units, so a clamp across
 * two fields shown in different ones still reads correctly. A blank field is
 * skipped: blank means "fall back to the default", not zero.
 */
export function clampNote(
  field: DependentField,
  values: Record<string, string>,
  fields: ClampTarget[],
): string | null {
  const clamp = field.clampedBy;
  if (!clamp) return null;
  const other = fields.find((f) => f.key === clamp.key);
  if (!other) return null;
  const mineText = (values[field.key] ?? '').trim();
  const theirText = (values[other.key] ?? '').trim();
  if (mineText === '' || theirText === '') return null;
  const mine = Number(mineText) * (field.scale ?? 1);
  const theirs = Number(theirText) * (other.scale ?? 1);
  if (!Number.isFinite(mine) || !Number.isFinite(theirs)) return null;
  if (clamp.direction === 'max' && mine > theirs) {
    return `The code never lets this run longer than “${other.label}” -- a higher value behaves as if it were set to that.`;
  }
  if (clamp.direction === 'min' && mine < theirs) {
    return `The code never lets this run shorter than “${other.label}” -- a lower value behaves as if it were set to that.`;
  }
  return null;
}
