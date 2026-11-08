import { NextResponse } from 'next/server';
import { responseErrorText } from '@/lib/error-text';
import { config } from '@/lib/server/state';
import { Store } from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function POST() {
  // The strongest action on the box, and until now the only destructive one
  // with no route-level gate at all: a one-channel reorder is gated twice
  // (credentials, then the dry run), and this deleted nineteen tables behind
  // nothing but the proxy's same-origin checks. The dry run is the gate it
  // was missing: it is the install's own "nothing gets written while I am
  // watching", and `resetData` is a write by any reading -- it just writes
  // deletion. `requireCredentials` is deliberately *not* added: reset touches
  // only Podium's own database, and gating it on Dispatcharr credentials
  // would lock out exactly the install that has no Dispatcharr to write to.
  const cfg = config();
  if (cfg.PODIUM_DRY_RUN) {
    return NextResponse.json(
      { error: 'PODIUM_DRY_RUN is set; refusing to write' },
      { status: 409 },
    );
  }

  const store = new Store(cfg.dbPath);
  try {
    store.resetData();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: responseErrorText(error) }, { status: 500 });
  } finally {
    store.close();
  }
}
