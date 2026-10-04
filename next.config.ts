import { readFileSync } from 'fs';
import type { NextConfig } from 'next';
import { join } from 'path';

// CI sets PODIUM_BUILD_VERSION (released version on a tag build, version plus
// short commit sha on a :main edge build); everything else builds the version
// as committed.
const version =
  process.env.PODIUM_BUILD_VERSION ||
  (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version as string);

const config: NextConfig = {
  // Standalone keeps the runtime image to the production dependency closure,
  // so ffmpeg stays the dominant layer rather than node_modules.
  output: 'standalone',
  // better-sqlite3 is a native addon and must not be bundled.
  serverExternalPackages: ['better-sqlite3'],
  // Inlined into both bundles at build so the app can say what it is -- see
  // src/lib/version.ts for why the version is not read at runtime.
  env: { NEXT_PUBLIC_PODIUM_VERSION: version },
};

export default config;
