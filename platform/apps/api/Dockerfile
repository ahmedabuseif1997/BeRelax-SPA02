# ─────────────────────────────────────────────────────────────────────────────
#  BE RELAX API — production image
#
#  BUILD CONTEXT IS `platform/`, NOT `platform/apps/api/`.
#
#      docker build -f apps/api/Dockerfile -t berelax-api:local .      # from platform/
#
#  Needs BuildKit (the default in Docker 23+, and what Railway builds with):
#  the install layers use `RUN --mount=type=cache`. There is deliberately no
#  `# syntax=` directive — nothing here needs a frontend newer than the built-in
#  one, and pinning it makes every build pull an extra image first.
#
#  It has to be, because this is a pnpm workspace: the api imports
#  @berelax/contracts through a workspace symlink, and pnpm needs
#  pnpm-lock.yaml, pnpm-workspace.yaml and every package.json in the graph to
#  reproduce an install. A context of apps/api would build a package whose
#  dependency does not exist.
#
#  Stages:
#    base          node + corepack + pnpm, nothing else
#    manifests     just the package.json/lockfile layer — changes rarely, so the
#                  expensive install layers below it stay cached
#    deps          full install (dev included) for `api` and its workspace deps
#    prisma-cli    a standalone, npm-linked Prisma CLI for the RELEASE step
#    build         @berelax/contracts -> prisma generate -> nest build
#    runtime-deps  production-only install, with the Prisma client generated
#                  INTO that tree (not copied into it — see the note below)
#    runtime       distroless-ish: alpine + tini + a non-root user + dist
#
#  The dashboard is never installed here. It deploys to Vercel (apps/dashboard/
#  vercel.json) and its dependency tree — next, react, tailwind — has no
#  business inside the API image.
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=22.11.0
ARG ALPINE_VERSION=3.20


# ── base ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS base

ENV PNPM_HOME=/pnpm
ENV PATH="/pnpm:${PATH}"
# corepack otherwise stops to ask whether it may download pnpm, and a build
# that waits for stdin looks exactly like a build that has hung.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# bcrypt is a native addon and ships no musl prebuild, so every install below
# compiles it from source — without these, `pnpm install` dies in node-gyp with
# "python3: not found". openssl is what Prisma's linux-musl engine links
# against. None of this reaches the final image: the runtime stage starts from a
# clean node:alpine and only the compiled .node file is copied into it.
RUN apk add --no-cache python3 make g++ openssl

WORKDIR /app


# ── manifests ────────────────────────────────────────────────────────────────
# Every package.json in the workspace, and nothing else. pnpm refuses to resolve
# a filtered install without the full workspace manifest set, and keeping this
# layer manifest-only means editing a .ts file does not invalidate the install.
FROM base AS manifests

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json            apps/api/package.json
COPY apps/dashboard/package.json      apps/dashboard/package.json
COPY packages/contracts/package.json  packages/contracts/package.json


# ── deps ─────────────────────────────────────────────────────────────────────
# `--filter "api..."` selects api AND its workspace dependencies (contracts),
# and nothing else: not the dashboard, not the root's eslint toolchain.
FROM manifests AS deps

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "api..."


# ── prisma-cli ───────────────────────────────────────────────────────────────
# The release step runs `prisma migrate deploy`, so the CLI has to be IN the
# image — a migration that depends on the npm registry being up at 03:00 is not
# a migration you can rely on.
#
# The CLI is a devDependency, though, and pulling the whole dev tree into the
# runtime image to get it would drag jest, ts-node, the Nest CLI and TypeScript
# along with it. So it is materialised here on its own, with npm rather than
# pnpm, which gives a flat self-contained directory that COPY --from can move
# without pnpm's symlink farm coming too.
#
# The version is READ from the resolved @prisma/client rather than pinned by
# hand: Prisma refuses to run when the CLI and the client disagree, and a
# hard-coded version here would drift silently the first time the lockfile is
# updated.
FROM deps AS prisma-cli

RUN set -eux; \
    cd /app/apps/api; \
    PRISMA_VERSION="$(node -p "require('@prisma/client/package.json').version")"; \
    mkdir -p /opt/prisma; \
    cd /opt/prisma; \
    npm init -y > /dev/null; \
    npm install --no-audit --no-fund --omit=dev "prisma@${PRISMA_VERSION}"; \
    /opt/prisma/node_modules/.bin/prisma --version


# ── build ────────────────────────────────────────────────────────────────────
# Order matters. @berelax/contracts is consumed through its BUILT dist/ (see
# apps/api/tsconfig.json — there is deliberately no `paths` mapping to its
# source), so it is built first or the api build cannot resolve it.
FROM deps AS build

COPY packages/contracts packages/contracts
COPY apps/api          apps/api

RUN pnpm --filter @berelax/contracts build
RUN pnpm --filter api exec prisma generate
RUN pnpm --filter api build


# ── runtime-deps ─────────────────────────────────────────────────────────────
# Production dependencies only, plus the generated Prisma client.
#
# The client is generated HERE rather than copied from `build`, and that is not
# a detail: `prisma generate` writes into the real path of @prisma/client inside
# pnpm's content-addressed store, and that path differs between a dev install
# and a --prod install. Copying it across produces an image that boots and then
# throws "@prisma/client did not initialize yet" on the first query — at 03:00,
# after the health check has already gone green.
FROM manifests AS runtime-deps

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "api..."

COPY --from=prisma-cli /opt/prisma /opt/prisma
COPY apps/api/prisma/schema.prisma apps/api/prisma/schema.prisma

RUN /opt/prisma/node_modules/.bin/prisma generate --schema=apps/api/prisma/schema.prisma


# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS runtime

# tini reaps zombies and forwards SIGTERM to node. Without it node is PID 1,
# and PID 1 ignores signals it has no handler for — the platform's graceful
# shutdown becomes a 30-second wait followed by SIGKILL, mid-transaction.
# openssl: Prisma's query engine links against it. No compiler here — the
# native modules arrive already built.
RUN apk add --no-cache tini openssl

ENV NODE_ENV=production
# Store UTC, render Dubai. business_day() does the conversion; a container-level
# TZ of Asia/Dubai would make every `new Date()` in a log line disagree with
# every timestamptz in the database. Spec §3.2.
ENV TZ=UTC
ENV PORT=3000

WORKDIR /app

# Non-root, no shell, no home to write into. The process reads its config from
# the environment and writes nothing to disk.
RUN addgroup -g 10001 -S berelax \
 && adduser  -u 10001 -S -G berelax -h /app -s /sbin/nologin berelax

# Root-owned, world-readable: the app can read its own code and cannot rewrite it.
COPY --from=runtime-deps --chown=root:root /app                          /app
COPY --from=prisma-cli   --chown=root:root /opt/prisma                   /opt/prisma
COPY --from=build        --chown=root:root /app/packages/contracts/dist  /app/packages/contracts/dist
COPY --from=build        --chown=root:root /app/apps/api/dist            /app/apps/api/dist

# Migrations travel with the image so the release step and the code that needs
# them are always the same version. prisma/seed.ts deliberately does NOT: the
# seed is development-only (README), and a seed script that cannot be reached
# is a seed script that cannot be run against production by accident.
COPY --from=build --chown=root:root /app/apps/api/prisma/migrations       /app/apps/api/prisma/migrations
COPY --from=build --chown=root:root /app/apps/api/prisma/migration_lock.toml /app/apps/api/prisma/migration_lock.toml

USER berelax

EXPOSE 3000
STOPSIGNAL SIGTERM

# /health/ready is a SELECT 1 against the pool, and it is excluded from the /v1
# global prefix in main.ts. Liveness (/health) only proves the process is up;
# readiness is the one that tells the platform not to send this replica traffic.
#
# node -e rather than curl or wget: node 22 has global fetch, and the image
# stays free of an HTTP client that a CVE scanner will file a ticket about.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/sbin/tini", "--"]

# NOTE: this is the START command and it does exactly one thing — start the
# server. It does NOT run migrations. Migrations are a release step; see
# apps/api/railway.json and docs/runbooks/go-live.md.
CMD ["node", "apps/api/dist/main.js"]
