import { DispatcharrClient } from '../lib/dispatcharr';

async function main() {
  const client = new DispatcharrClient(process.env.DISPATCHARR_URL!, {
    apiKey: process.env.DISPATCHARR_API_KEY,
  });
  const [channels, groups] = await Promise.all([client.channels(), client.groups()]);
  const name = new Map(groups.map((g) => [g.id, g.name]));
  const used = new Map<number, number>();
  for (const ch of channels) {
    if (ch.groupId !== null) used.set(ch.groupId, (used.get(ch.groupId) ?? 0) + 1);
  }
  for (const [id, count] of [...used].sort((a, b) => b[1] - a[1])) {
    const label = name.get(id) ?? String(id);
    const auto = /^auto\s*\|/i.test(label) || /sirius/i.test(label) ? '  <== exclude' : '';
    console.log(`${String(id).padStart(6)}  ${String(count).padStart(4)}ch  ${label}${auto}`);
  }
}
main();
