/**
 * Import regex rules out of an older rule set.
 *
 * A migration tool, so it is a separate entrypoint rather than something that
 * runs on every boot.
 *
 *   npm run import -- --json export.json --out data/rules.json
 *   npm run import -- --json export.json --out data/rules.json --raw
 *
 * `--raw` keeps the legacy regexes verbatim (schema 1). The default converts
 * them to aliases plus per-channel guards (schema 2), which is what makes the
 * rules editable by hand.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { convert } from '../lib/legacy';
import { loadRules } from '../lib/rules';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const input = arg('json');
const output = arg('out');
const raw = process.argv.includes('--raw');

if (!input || !output) {
  console.error('usage: import --json <export.json> --out <rules.json> [--raw]');
  process.exit(2);
}

const source = JSON.parse(readFileSync(input, 'utf8'));
let doc: unknown;

if (raw) {
  doc = source;
  console.log(`keeping ${source.channels?.length ?? 0} channels as legacy regex`);
} else {
  const converted = convert(source);
  doc = converted.doc;
  const { channels, converted: ok, keptRegex, patterns } = converted.stats;
  const aliases = (converted.doc.channels as Array<{ aliases: string[] }>).reduce(
    (n, c) => n + c.aliases.length,
    0,
  );
  console.log(
    `converted ${ok}/${channels} channels to aliases (${aliases} aliases from ${patterns} patterns); ` +
      `${keptRegex} still carry regex`,
  );
}

// Load it back before writing: a rules file that does not parse would take the
// next worker start down, and this is the one place to catch that.
const report = loadRules(doc);
console.log(
  `validated: ${report.loaded} rules (${report.aliasBased} alias-based, ` +
    `${report.regexBased} regex-based, ${report.skippedPatterns.length} skipped)`,
);
for (const problem of report.skippedPatterns.slice(0, 10)) console.warn(`  warning: ${problem}`);

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(doc, null, 1), 'utf8');
console.log(`wrote ${output}`);
process.exit(report.skippedPatterns.length > 0 ? 1 : 0);
