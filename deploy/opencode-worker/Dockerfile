# opencode-worker: opencode `serve` + the opencode-a2a wrapper + nb, one task per container.
# Everything is pinned: base images by digest, npm deps by lockfile integrity (sha512),
# python deps by hash (--require-hashes). Config/plugin/hooks are MOUNTED at launch, not baked.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
ARG PY_IMAGE=python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df

FROM ${NODE_IMAGE} AS node-tools
WORKDIR /opt/tools
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund \
 && (cd node_modules/opencode-ai && node postinstall.mjs)

FROM ${PY_IMAGE} AS py-venv
COPY requirements.txt /tmp/requirements.txt
RUN python -m venv /opt/a2a && /opt/a2a/bin/pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt

FROM ${PY_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl procps \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --create-home --home-dir /home/worker --shell /bin/bash worker
COPY --from=node-tools /usr/local/bin/node /usr/local/bin/node
COPY --from=node-tools /opt/tools /opt/tools
COPY --from=py-venv /opt/a2a /opt/a2a
# Seed: opencode installs @opencode-ai/plugin (~63 MB) into its config dir on first boot (6-12 s, needs
# network). Do it once at build time; the entrypoint symlinks node_modules from here (read-only).
RUN mkdir -p /opt/seed && chown 1000:1000 /opt/seed
USER 1000:1000
RUN set -e; export HOME=/tmp/seedhome OPENCODE_CONFIG_DIR=/opt/seed XDG_DATA_HOME=/tmp/seeddata XDG_CONFIG_HOME=/tmp/seedxdg OPENCODE_DISABLE_AUTOUPDATE=1; \
    mkdir -p $HOME $XDG_DATA_HOME $XDG_CONFIG_HOME /opt/seed/plugins; \
    echo 'export const Seed = async () => ({})' > /opt/seed/plugins/seed.js; \
    /opt/tools/node_modules/.bin/opencode debug config >/dev/null; \
    ls /opt/seed/node_modules/@opencode-ai/plugin >/dev/null; rm -rf /tmp/seed* /opt/seed/plugins
USER root
COPY entrypoint.sh /usr/local/bin/worker-entrypoint
RUN chmod 0755 /usr/local/bin/worker-entrypoint \
 && ln -s /opt/tools/node_modules/.bin/opencode /usr/local/bin/opencode \
 && ln -s /opt/tools/node_modules/.bin/nb /usr/local/bin/nb \
 && ln -s /opt/a2a/bin/opencode-a2a /usr/local/bin/opencode-a2a
# Mount points must exist because the root filesystem is read-only at run time.
RUN mkdir -p /data /work /memory /cfg /run/secrets /kookr-hooks /kookr-spool
USER 1000:1000
ENV HOME=/home/worker XDG_DATA_HOME=/data/xdg-data XDG_CONFIG_HOME=/home/worker/.config \
    OPENCODE_DISABLE_AUTOUPDATE=1 NB_DIR=/memory
EXPOSE 8000
# Healthy = opencode serve answers AND the A2A wrapper serves its card.
HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=3 \
  CMD curl -fsS --max-time 3 -u "opencode:$(cat /run/secrets/opencode_password)" http://127.0.0.1:4096/global/health >/dev/null \
   && curl -fsS --max-time 3 http://127.0.0.1:8000/.well-known/agent-card.json >/dev/null
ENTRYPOINT ["worker-entrypoint"]
