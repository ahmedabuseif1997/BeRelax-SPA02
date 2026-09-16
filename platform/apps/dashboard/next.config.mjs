/**
 * The dashboard talks to the NestJS API cross-origin (credentials: 'include',
 * so the HttpOnly `brx_rt` cookie rides along). There is no Next API route and
 * no server-side data fetching: the access token lives in memory in the
 * browser tab and nowhere else (spec §6.2), so every authenticated read has to
 * happen client-side.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  // @berelax/contracts is a workspace package published as CommonJS; keeping it
  // in the transpile set makes the pnpm symlink behave like first-party source.
  transpilePackages: ['@berelax/contracts'],
  // Linting runs from the workspace's flat ESLint config (`pnpm lint`), not from
  // eslint-config-next, so `next build` does not need to shell out to it.
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
};

export default nextConfig;
