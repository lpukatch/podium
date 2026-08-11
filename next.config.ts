import type { NextConfig } from 'next';

const config: NextConfig = {
  // Standalone keeps the runtime image to the production dependency closure,
  // so ffmpeg stays the dominant layer rather than node_modules.
  output: 'standalone',
  // better-sqlite3 is a native addon and must not be bundled.
  serverExternalPackages: ['better-sqlite3'],
};

export default config;
