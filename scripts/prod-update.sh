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

if [[ ! -d "${PROD_DIR}" ]]; then
  echo "Production directory not found: ${PROD_DIR}" >&2
  exit 1
fi

cd "${PROD_DIR}"
git fetch origin
git switch --detach origin/main
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
pnpm build
bash "${ROOT_DIR}/scripts/prod-restart.sh"
