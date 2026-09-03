import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import {
  BACKUP_VERSION,
  backupFilename,
  parseBundle,
  settingsForRestore,
  wouldBreakAuth,
} from '@/lib/backup';
import { loadConfig } from '@/lib/config';
import { rulesDocSchema } from '@/lib/rules';
import { readRulesDoc, writeRulesDoc } from '@/lib/server/state';
import { Store } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Download a backup: the rules file plus the configurable tables, credentials
 * included.
 *
 * That last part is a deliberate exception to the rule the settings API
 * follows -- the API that writes a credential must not also read it back. A
 * backup that cannot restore the credential is not a backup, so this response
 * carries it, relies on the same boundary every other endpoint has (host
 * allowlist, optional auth token), and the downloaded file must be treated
 * like the credential it contains.
 */
export function GET() {
  let store: Store | null = null;
  try {
    store = new Store(loadConfig().dbPath);
    const config = store.exportConfig();
    // Parsed rather than passed through: a rules file that has drifted out of
    // schema should fail the export loudly, not ship inside a "backup".
    const rules = rulesDocSchema.parse(readRulesDoc());
    const body = JSON.stringify(
      { kind: 'podium-backup', version: BACKUP_VERSION, createdAt: Date.now(), rules, ...config },
      null,
      2,
    );
    return new NextResponse(body, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${backupFilename()}"`,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}

/**
 * Restore a backup: replace the rules file and the configurable tables with
 * what the bundle carries.
 *
 * No atomic commit spans a file and SQLite, so the ordering is the safety:
 * everything that can reject runs before anything is written (a 400 never
 * mutates anything), the pre-validated atomic rules rename goes first, and
 * the database transaction -- the only step that can lose a race with the
 * worker -- goes last.
 */
export async function POST(request: Request) {
  let store: Store | null = null;
  try {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return NextResponse.json({ error: 'not a JSON file' }, { status: 400 });
    }

    let parsed: ReturnType<typeof parseBundle>;
    try {
      parsed = parseBundle(raw);
    } catch (error) {
      const detail =
        error instanceof ZodError
          ? error.issues.map((i) => `${i.path.join('.') || 'file'}: ${i.message}`).join('; ')
          : String(error);
      return NextResponse.json(
        { error: `not a Podium backup: ${detail.slice(0, 200)}` },
        { status: 400 },
      );
    }
    const { bundle, loadReport } = parsed;

    const settings = settingsForRestore(bundle);
    // The same refusal the settings PUT makes: accepting a restore that leaves
    // no credentials would put the app in a state only the environment can
    // rescue it from.
    if (wouldBreakAuth(process.env, settings)) {
      return NextResponse.json(
        { error: 'restoring this backup would leave Podium with no Dispatcharr credentials' },
        { status: 400 },
      );
    }

    store = new Store(loadConfig().dbPath);
    writeRulesDoc(bundle.rules);
    try {
      store.restoreConfig({
        settings,
        teamarrRules: bundle.teamarrRules,
        assignBlocks: bundle.assignBlocks,
      });
    } catch (error) {
      return NextResponse.json(
        {
          error:
            `rules.json was replaced, but the database was not restored: ${String(error).slice(0, 200)}. ` +
            'Import the same backup again once the cause is fixed.',
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      status: 'restored',
      restored: {
        channels: loadReport.loaded,
        settings: Object.keys(settings).length,
        teamarrRules: bundle.teamarrRules?.rules.length ?? 0,
        assignBlocks: bundle.assignBlocks.length,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 300) }, { status: 500 });
  } finally {
    store?.close();
  }
}
