/**
 * The version of the running build, from package.json.
 *
 * The number is inlined at build time, not read at runtime: the standalone
 * image ships no source tree, and a version read from a file that may or may
 * not have been copied into the image is a version that can be wrong. Two
 * build steps inline it, one per bundle:
 *
 * - `next.config.ts` puts it in `env.NEXT_PUBLIC_PODIUM_VERSION`, which Next
 *   replaces in both the server and the client bundle.
 * - `npm run build:worker` defines `__PODIUM_VERSION__` for esbuild, which
 *   folds it into `dist/entry.cjs` as a string literal.
 *
 * Neither runs under `next dev` / `tsx`, so a working copy falls back to
 * `dev` -- which is honest, since that is the only place it can appear.
 *
 * CI may set PODIUM_BUILD_VERSION before building, which both steps prefer
 * over package.json: a :main edge image carries the released version plus the
 * short commit sha (`1.15.1+ge39c992`), so two edge builds never answer "what
 * version is this?" identically.
 */

declare const __PODIUM_VERSION__: string | undefined;

export const VERSION: string =
  (typeof __PODIUM_VERSION__ !== 'undefined' ? __PODIUM_VERSION__ : undefined) ??
  process.env.NEXT_PUBLIC_PODIUM_VERSION ??
  'dev';
