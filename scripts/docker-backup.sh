#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE="${ROOT_DIR}/.env"
BACKUP_DIR="${ROOT_DIR}/docker/mysql/backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}. Copy .env.example to .env first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

mkdir -p "${BACKUP_DIR}"

docker compose exec -T athena-mysql \
  mysqldump -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" "${MYSQL_DATABASE}" \
  > "${BACKUP_DIR}/mysql-${TIMESTAMP}.sql"

tar -czf "${BACKUP_DIR}/results-${TIMESTAMP}.tgz" -C "${ROOT_DIR}" results

echo "Created ${BACKUP_DIR}/mysql-${TIMESTAMP}.sql"
echo "Created ${BACKUP_DIR}/results-${TIMESTAMP}.tgz"
