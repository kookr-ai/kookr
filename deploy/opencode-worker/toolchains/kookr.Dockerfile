# Toolchain layer for the Kookr repo (RFC: workload fit). Derived from the repo-neutral opencode-worker:
#   docker build -f toolchains/kookr.Dockerfile --build-arg BASE=opencode-worker:<tag> -t opencode-worker-kookr .
# Adds node+npm and pnpm so a worker can run the repo checks. Dependencies are NOT baked: the clone gets
# `pnpm install --offline --frozen-lockfile` against the host pnpm store mounted read-only.
ARG BASE=opencode-worker:latest
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
FROM ${NODE_IMAGE} AS node-full
FROM ${BASE}
# pnpm is installed from its registry tarball, checked against this sha512 (the registry's dist.integrity, hex).
ARG PNPM_VERSION=10.33.0
ARG PNPM_SHA512=10568bb4a6afb58c9eb3630da90cc9516417abebd3fabbe6739f0ae795728da1491e9db5a544c76ad8eb7570f5c4bb3d6c637b2cb41bfdcdb47fa823c8649319
USER root
COPY --from=node-full /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && cd /tmp && npm pack pnpm@${PNPM_VERSION} --silent >/dev/null \
 && echo "${PNPM_SHA512}  pnpm-${PNPM_VERSION}.tgz" | sha512sum -c - \
 && npm install -g ./pnpm-${PNPM_VERSION}.tgz --no-audit --no-fund \
 && rm -f pnpm-${PNPM_VERSION}.tgz \
 && pnpm --version
USER 1000:1000
