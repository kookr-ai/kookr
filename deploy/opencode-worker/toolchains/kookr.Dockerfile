# Toolchain layer for the Kookr repo (RFC: workload fit). Derived from the repo-neutral opencode-worker:
#   docker build -f toolchains/kookr.Dockerfile --build-arg BASE=opencode-worker:<tag> -t opencode-worker-kookr .
# Adds node+npm and pnpm so a worker can run the repo checks. Dependencies are NOT baked: the clone gets
# `pnpm install --offline --frozen-lockfile` against the host pnpm store mounted read-only.
ARG BASE=opencode-worker:latest
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
FROM ${NODE_IMAGE} AS node-full
FROM ${BASE}
USER root
COPY --from=node-full /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && npm install -g pnpm@10.33.0 --no-audit --no-fund \
 && pnpm --version
USER 1000:1000
