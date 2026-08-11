import { readFileSync } from 'fs';
import { DispatcharrClient } from '../lib/dispatcharr';
import {
  currentProgrammes,
  Eligibility,
  parseGroupPatterns,
  parsePolicies,
} from '../lib/eligibility';
import { loadRules } from '../lib/rules';

async function main() {
  const client = new DispatcharrClient(process.env.DISPATCHARR_URL!, {
    apiKey: process.env.DISPATCHARR_API_KEY,
  });
  const [channels, groups, epg] = await Promise.all([
    client.channels(),
    client.groups(),
    client.epgNow(),
  ]);
  const doc = JSON.parse(readFileSync(process.env.PODIUM_RULES!, 'utf8'));
  const { matcher } = loadRules(doc);
  const policies = parsePolicies(doc.groups);
  const patterns = parseGroupPatterns(doc.group_patterns);
  const eligibility = new Eligibility(policies, undefined, patterns);
  const programmes = currentProgrammes(epg as never[]);
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const now = new Date();

  console.log('now (UTC):', now.toISOString().slice(0, 16));
  const targets = channels.filter((c) => /WSH\/PHI/.test(c.name));
  for (const c of targets) {
    const gname = groupName.get(c.groupId ?? -1) ?? '(none)';
    const policy = eligibility.policyFor(c.groupId, gname);
    const verdict = eligibility.allows(c.groupId, c.tvgId, programmes, now, gname);
    const prog = programmes.get(c.tvgId);
    const hasRule = matcher.rules.has(c.id);
    console.log(`\n${c.name}  (channel ${c.id})`);
    console.log(`  group      : ${gname}`);
    console.log(
      `  policy     : ${policy.mode} (grace ${policy.graceMinutes}m, window ${policy.windowMinutes}m)`,
    );
    console.log(`  has rule   : ${hasRule}`);
    console.log(
      `  programme  : ${prog ? `${prog.title} started ${Math.round((now.getTime() - prog.start.getTime()) / 60000)}m ago` : 'none airing'}`,
    );
    console.log(`  ELIGIBLE   : ${verdict.allowed}${verdict.reason ? ` (${verdict.reason})` : ''}`);
    console.log(`  WOULD PROBE: ${verdict.allowed && hasRule}`);
  }

  // What would change if the group used after_epg_start instead of never?
  const hypothetical = new Eligibility(new Map(), undefined, [
    { pattern: 'Auto | *', mode: 'after_epg_start', graceMinutes: 5, windowMinutes: 180 },
  ]);
  console.log('\n--- if "Auto | *" were after_epg_start instead of never ---');
  for (const c of targets) {
    const gname = groupName.get(c.groupId ?? -1) ?? '(none)';
    const v = hypothetical.allows(c.groupId, c.tvgId, programmes, now, gname);
    console.log(`  ${c.name.padEnd(34)} eligible=${v.allowed}${v.reason ? ` (${v.reason})` : ''}`);
  }
}
main();
