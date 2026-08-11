import { readFileSync } from 'fs';
import { DispatcharrClient } from '../lib/dispatcharr';
import { loadRules } from '../lib/rules';

async function main() {
  const client = new DispatcharrClient(process.env.DISPATCHARR_URL!, {
    apiKey: process.env.DISPATCHARR_API_KEY,
  });
  const [channels, groups] = await Promise.all([client.channels(), client.groups()]);
  const rules = loadRules(JSON.parse(readFileSync(process.env.PODIUM_RULES!, 'utf8')));

  const byId = new Map(groups.map((g) => [g.id, g.name]));
  const used = new Map<number, { name: string; channels: number; withRules: number }>();
  for (const ch of channels) {
    if (ch.groupId === null) continue;
    const row = used.get(ch.groupId) ?? {
      name: byId.get(ch.groupId) ?? String(ch.groupId),
      channels: 0,
      withRules: 0,
    };
    row.channels += 1;
    if (rules.matcher.rules.has(ch.id)) row.withRules += 1;
    used.set(ch.groupId, row);
  }
  console.log('provider groups (all):', groups.length);
  console.log('user groups (used by channels):', used.size);
  console.log(
    'user groups containing a ruled channel:',
    [...used.values()].filter((r) => r.withRules > 0).length,
  );
  console.log();
  const sorted = [...used.values()].sort((a, b) => b.channels - a.channels);
  for (const row of sorted.slice(0, 22)) {
    console.log(
      `  ${String(row.channels).padStart(4)} ch (${String(row.withRules).padStart(3)} ruled)  ${row.name}`,
    );
  }
  console.log(`  ... ${Math.max(sorted.length - 22, 0)} more`);
}
main();
