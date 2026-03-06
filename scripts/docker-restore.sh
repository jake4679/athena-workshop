#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 <mysql-backup.sql> [results-backup.tgz]" >&2
  exit 1
fi

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE="${ROOT_DIR}/.env"
MYSQL_BACKUP=$1
RESULTS_BACKUP=${2:-}

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}. Copy .env.example to .env first." >&2
  exit 1
fi

if [[ ! -f "${MYSQL_BACKUP}" ]]; then
  echo "MySQL backup file not found: ${MYSQL_BACKUP}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

docker compose exec -T athena-mysql \
  mysql -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" "${MYSQL_DATABASE}" < "${MYSQL_BACKUP}"

if [[ -n "${RESULTS_BACKUP}" ]]; then
  if [[ ! -f "${RESULTS_BACKUP}" ]]; then
    echo "Results backup file not found: ${RESULTS_BACKUP}" >&2
    exit 1
  fi

  mkdir -p "${ROOT_DIR}/results"
  tar -xzf "${RESULTS_BACKUP}" -C "${ROOT_DIR}"
fi

echo "Restore completed."
