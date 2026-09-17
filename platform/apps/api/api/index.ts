/**
 * The file Vercel invokes. Everything it does is in src/serverless.ts; this is
 * four lines of glue and a page explaining why they are needed.
 *
 * ── WHY THIS IS NOT JUST src/serverless.ts ──────────────────────────────────
 *
 * Vercel compiles the files under api/ with esbuild. esbuild strips TypeScript
 * types without emitting the decorator metadata that Nest's injector reads at
 * run time — it does not implement `emitDecoratorMetadata` and does not warn
 * that it is ignoring it. Point Vercel at `../src/app.module` and the build
 * succeeds, the deploy goes green, and the first request fails with "Nest can't
 * resolve dependencies of X" because every constructor parameter is now
 * `undefined`. At 03:00, after the health check has already passed.
 *
 * So nothing decorated is compiled here. `pnpm --filter api build` runs the
 * Nest CLI, which runs tsc, which emits the metadata; this file loads only that
 * OUTPUT. The build command in vercel.json is what makes dist/ exist, and
 * `includeFiles` in the same file is what ships it with the function.
 *
 * `require` rather than `import`, deliberately: a static import of ../dist would
 * make `tsc --noEmit` — which CI runs BEFORE the build — fail on a clean
 * checkout for want of a directory that has not been built yet. The shape of
 * what comes back is declared below and checked at the boundary, so the cast is
 * an assertion about one file this repository builds itself, not a hole.
 *
 * ── ROUTING ─────────────────────────────────────────────────────────────────
 *
 * vercel.json rewrites every path to this function; Nest keeps its own /v1
 * prefix and its own exclusions for /health and /health/ready. No route table
 * is duplicated here, because two route tables disagree eventually.
 *
 * ── WHAT vercel.json SAYS, AND WHY ──────────────────────────────────────────
 *
 * vercel.json cannot carry comments, so its reasoning lives here.
 *
 *   regions: ["fra1"]
 *       The function must sit in the SAME region as the Supabase database.
 *       A check-in is several statements over the wire, and every one of them
 *       pays the round trip twice; put the function in Washington and the
 *       database in Frankfurt and a 20 ms booking becomes half a second of a
 *       receptionist watching a spinner with a guest in front of her. fra1 is
 *       eu-central-1, which is where apps/dashboard/vercel.json already puts
 *       the dashboard. [TO BE COMPLETED: confirm the Supabase project's region
 *       — Project Settings -> General — and change this to match it if it is
 *       not eu-central-1. bom1 for ap-south-1, iad1 for us-east-1.]
 *
 *   git.deploymentEnabled: false
 *       No deploy on push. Migrations are a release step run once from
 *       .github/workflows/platform-deploy.yml over DIRECT_URL, and Vercel has
 *       no release phase to put them in — so that workflow is now the ONLY
 *       path to production, and a push that deployed code ahead of the
 *       migration would break the one ordering that actually matters.
 *
 *   buildCommand
 *       @berelax/contracts first (the api consumes its built dist/), then
 *       `prisma generate` explicitly — Vercel caches node_modules between
 *       builds, so Prisma's postinstall may not run and the client would be
 *       whatever the last schema generated. `mkdir -p public` gives the build
 *       an output directory to point at; this project ships no static files.
 *
 *   memory: 1024
 *       Vercel scales CPU with memory, and a cold start is CPU-bound — Nest
 *       building its module graph and Prisma loading its query engine. This is
 *       bought for the boot time, not for the heap.
 *
 *   maxDuration: 30
 *       Every §12.1 target is under 600 ms. Thirty seconds is headroom for a
 *       cold start on top of a slow query, and a ceiling on a request that has
 *       stopped making progress.
 *
 *   includeFiles: "dist/**"
 *       The compiled application this file loads. Vercel traces `require`
 *       graphs, but tracing is an inference and this is a statement.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const compiled = require('../dist/serverless.js') as { default?: NodeHandler };

const handler = compiled.default;
if (typeof handler !== 'function') {
  // The build did not produce what this expects. Failing here names the cause;
  // failing later would surface as an unhelpful "handler is not a function" on
  // the first guest's booking.
  throw new Error(
    'dist/serverless.js has no default export. Run `pnpm --filter api build` before deploying.',
  );
}

export default handler;
