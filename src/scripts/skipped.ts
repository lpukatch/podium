import { readFileSync } from 'fs';
import { convert } from '../lib/legacy';
import { loadRules } from '../lib/rules';

const doc = convert(JSON.parse(readFileSync('data/regex-import.json', 'utf8'))).doc;
const report = loadRules(doc);
const kinds = new Map<string, number>();
for (const s of report.skippedPatterns) {
  const key = (/SyntaxError: (.+)/.exec(s)?.[1] ?? s).replace(/\/.*$/, '').slice(0, 70);
  kinds.set(key, (kinds.get(key) ?? 0) + 1);
}
for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(4), k);
console.log('--- sample ---');
console.log(report.skippedPatterns[0]?.slice(0, 300));
