/**
 * The rules file, re-read when it changes.
 *
 * The worker used to load rules once at startup and hold that matcher for the
 * life of the process. Editing a rule in the UI therefore had no effect on the
 * thing doing the work until the pod restarted -- and the UI reloaded its own
 * copy on save, so the preview showed the new matches while the worker kept
 * using the old ones. It looked like it had worked.
 *
 * Checking mtime is enough. The file is written atomically (temp file then
 * rename) by both the editor and the seeder, so a reload never sees a partial
 * document, and a stat per run is free next to a pass over 22,000 streams.
 */

import { statSync } from 'fs';
import { Eligibility, type GroupPolicy, parseGroupPatterns, parsePolicies } from './eligibility';
import type { Matcher } from './matcher';
import type { OrderingConfig } from './ordering';
import { loadRules, readRulesFile } from './rules';

export type Log = (message: string) => void;

export interface Rules {
  matcher: Matcher;
  eligibility: Eligibility;
  policies: Map<number, GroupPolicy>;
  /** Parsed ranking strategy from the top-level `ordering` block. */
  ordering: OrderingConfig;
  loadedAt: number;
  /** Whether the file existed when this was loaded. */
  present: boolean;
}

export class RulesSource {
  private cached: Rules | null = null;
  private mtimeMs = -1;
  private size = -1;

  constructor(
    private readonly path: string,
    private readonly log: Log = () => {},
  ) {}

  /** The last-modified time of the rules file, or null when absent. */
  fileMtime(): number | null {
    try {
      return statSync(this.path).mtimeMs;
    } catch {
      return null;
    }
  }

  private changed(): boolean {
    try {
      const stat = statSync(this.path);
      // Size as well as mtime: a same-millisecond rewrite is entirely possible
      // when the editor saves twice quickly, and mtime alone would miss it.
      return stat.mtimeMs !== this.mtimeMs || stat.size !== this.size;
    } catch {
      // Absent now. Only a change if we previously had one.
      return this.mtimeMs !== -1;
    }
  }

  /** Current rules, reloading first if the file has changed since last read. */
  get(): Rules {
    if (this.cached && !this.changed()) return this.cached;

    const { doc, missing } = readRulesFile(this.path);
    const raw = doc as Record<string, unknown>;
    const report = loadRules(raw);
    const policies = parsePolicies(raw.groups, this.log);
    const patterns = parseGroupPatterns(raw.group_patterns, this.log);

    try {
      const stat = statSync(this.path);
      this.mtimeMs = stat.mtimeMs;
      this.size = stat.size;
    } catch {
      this.mtimeMs = -1;
      this.size = -1;
    }

    if (this.cached) {
      this.log(
        `rules reloaded: ${report.loaded} rules (${report.aliasBased} alias-based, ` +
          `${report.regexBased} regex-based, ${report.skippedPatterns.length} skipped)`,
      );
    } else {
      this.log(
        `loaded ${report.loaded} rules (${report.aliasBased} alias-based, ` +
          `${report.regexBased} regex-based, ${report.skippedPatterns.length} skipped)`,
      );
      for (const problem of report.skippedPatterns.slice(0, 10)) this.log(`  ${problem}`);
      for (const p of patterns) this.log(`group pattern: "${p.pattern}" -> ${p.mode}`);
    }

    this.cached = {
      matcher: report.matcher,
      eligibility: new Eligibility(policies, undefined, patterns),
      policies,
      ordering: report.ordering,
      loadedAt: Date.now(),
      present: !missing,
    };
    return this.cached;
  }

  /** Drop the cache so the next `get` re-reads regardless of mtime. */
  invalidate(): void {
    this.cached = null;
    this.mtimeMs = -1;
    this.size = -1;
  }
}
