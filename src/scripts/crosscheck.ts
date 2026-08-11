/**
 * Cross-validate the TypeScript port against the Python implementation.
 *
 * Runs the legacy conversion and the full match over the real exported rules and
 * the real stream list, and prints results in a form directly comparable with
 * the Python run. A port that changes behaviour here is a port that silently
 * stops matching channels.
 */

import { readFileSync } from 'fs';
import { convert } from '../lib/legacy';
import type { StreamLike } from '../lib/matcher';
import { loadRules } from '../lib/rules';

const [, , rulesPath, streamsPath] = process.argv;
if (!rulesPath || !streamsPath) {
  console.error('usage: crosscheck.ts <regex-import.json> <streams.json>');
  process.exit(2);
}

const legacyDoc = JSON.parse(readFileSync(rulesPath, 'utf8'));
const rawStreams = JSON.parse(readFileSync(streamsPath, 'utf8')) as Array<{
  id: number;
  name: string;
  m3u: number | null;
}>;
const streams: StreamLike[] = rawStreams.map((s) => ({
  id: s.id,
  name: s.name,
  providerId: s.m3u ?? 0,
}));

const t0 = Date.now();
const { doc, stats } = convert(legacyDoc);
console.log('convert stats:', JSON.stringify(stats));
const aliasTotal = (doc.channels as Array<{ aliases: string[] }>).reduce(
  (n, c) => n + c.aliases.length,
  0,
);
console.log('total aliases:', aliasTotal);
console.log('defaults:', JSON.stringify(doc.defaults));

const report = loadRules(doc);
console.log(
  `loaded ${report.loaded} rules (${report.aliasBased} alias-based, ` +
    `${report.regexBased} regex-based, ${report.skippedPatterns.length} skipped)`,
);

const t1 = Date.now();
const index = report.matcher.buildIndex(streams);
const t2 = Date.now();

const matched: Record<number, number[]> = {};
let channelsWithHits = 0;
let links = 0;
for (const [channelId, rule] of report.matcher.rules) {
  const hits = report.matcher.match(rule, index);
  if (hits.length > 0) channelsWithHits += 1;
  links += hits.length;
  matched[channelId] = hits.map(([id]) => id).sort((a, b) => a - b);
}
const t3 = Date.now();

console.log(`buildIndex: ${((t2 - t1) / 1000).toFixed(2)}s`);
console.log(`match all:  ${((t3 - t2) / 1000).toFixed(2)}s`);
console.log(`total:      ${((t3 - t0) / 1000).toFixed(2)}s`);
console.log(`channels with hits: ${channelsWithHits}`);
console.log(`stream links: ${links}`);

if (process.env.DUMP) {
  const { writeFileSync } = require('fs');
  writeFileSync(process.env.DUMP, JSON.stringify(matched));
  console.log(`wrote ${process.env.DUMP}`);
}
