import { readFileSync } from 'fs';
import { DispatcharrClient } from '../lib/dispatcharr';
import { loadRules } from '../lib/rules';

async function main() {
  const client = new DispatcharrClient(process.env.DISPATCHARR_URL!, {
    apiKey: process.env.DISPATCHARR_API_KEY,
  });
  const [channels, streams, groups] = await Promise.all([
    client.channels(),
    client.streams(),
    client.groups(),
  ]);
  const { matcher } = loadRules(JSON.parse(readFileSync(process.env.PODIUM_RULES!, 'utf8')));
  const index = matcher.buildIndex(streams);
  const groupName = new Map(groups.map((g) => [g.id, g.name]));

  const perGroup = new Map<string, { ruled: number; zero: number }>();
  for (const ch of channels) {
    const rule = matcher.rules.get(ch.id);
    if (!rule) continue;
    const name = groupName.get(ch.groupId ?? -1) ?? '(none)';
    const row = perGroup.get(name) ?? { ruled: 0, zero: 0 };
    row.ruled += 1;
    if (matcher.match(rule, index).length === 0) row.zero += 1;
    perGroup.set(name, row);
  }
  console.log('groups where rules match NOTHING:');
  for (const [name, row] of [...perGroup].sort((a, b) => b[1].zero - a[1].zero).slice(0, 8)) {
    if (row.zero > 0) console.log(`  ${String(row.zero).padStart(4)}/${row.ruled} dead  ${name}`);
  }
}
main();
