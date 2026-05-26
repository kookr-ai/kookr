#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(
  cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null
  pwd -P
)"
ROOT_DIR="$(
  cd "${SCRIPT_DIR}/.." 2>/dev/null
  pwd -P
)"

if [[ "${KOOKR_PROD_DIR:-}" != "" ]]; then
  PROD_DIR="${KOOKR_PROD_DIR}"
elif [[ "$(basename "${ROOT_DIR}")" == "kookr-prod" ]]; then
  PROD_DIR="${ROOT_DIR}"
else
  PROD_DIR="${ROOT_DIR}/../kookr-prod"
fi

ENV_ROOT_DIR="${KOOKR_ENV_ROOT_DIR:-${ROOT_DIR}}"
if [[ "${KOOKR_ENV_ROOT_DIR:-}" == "" && "$(basename "${ROOT_DIR}")" == "kookr-prod" && -f "${ROOT_DIR}/../kookr/.env" ]]; then
  ENV_ROOT_DIR="$(
    cd "${ROOT_DIR}/../kookr" 2>/dev/null
    pwd -P
  )"
fi

if [[ ! -d "${PROD_DIR}" ]]; then
  echo "Production worktree not found: ${PROD_DIR}" >&2
  echo "Bootstrapping detached worktree from origin/main..." >&2
  cd "${ROOT_DIR}"
  git fetch origin
  git worktree add --detach "${PROD_DIR}" origin/main
fi

if [[ -f "${ENV_ROOT_DIR}/.env" ]]; then
  ln -sfn "${ENV_ROOT_DIR}/.env" "${PROD_DIR}/.env"
fi

cd "${PROD_DIR}"
git fetch origin
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Discarding tracked local changes in production worktree: ${PROD_DIR}" >&2
  git status --short --untracked-files=no >&2
  git reset --hard
fi
git switch --detach origin/main
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
pnpm build
bash "${ROOT_DIR}/scripts/prod-restart.sh"
