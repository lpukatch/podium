import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { responseErrorText } from '@/lib/error-text';
import { Store } from '@/lib/store';

export async function POST() {
  const config = loadConfig(process.env);
  const store = new Store(config.dbPath);
  try {
    store.resetData();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: responseErrorText(error) }, { status: 500 });
  } finally {
    store.close();
  }
}
