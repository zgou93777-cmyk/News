#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: sudo deploy-release.sh /path/to/policy-monitor.tar.gz" >&2
  exit 64
fi
if [[ ${EUID} -ne 0 ]]; then
  echo "deploy-release.sh must run as root" >&2
  exit 77
fi

RELEASE_ARCHIVE=$(readlink -f "$1")
APP_DIR=${APP_DIR:-/opt/policy-monitor}
DATA_DIR=${DATA_DIR:-/var/lib/policy-monitor}
DB_PATH=${DB_PATH:-${DATA_DIR}/policy-monitor.db}
BACKUP_ROOT=${BACKUP_ROOT:-/var/backups/policy-monitor}
NODE_BIN=${NODE_BIN:-/usr/local/bin/node}
NPM_BIN=${NPM_BIN:-/usr/local/bin/npm}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR="${BACKUP_ROOT}/${STAMP}"
STAGE_DIR=$(mktemp -d /opt/policy-monitor-stage.XXXXXX)
SERVICES_STOPPED=0

cleanup() {
  rm -rf -- "$STAGE_DIR"
}

recover_services() {
  if [[ $SERVICES_STOPPED -eq 1 ]]; then
    systemctl start policy-monitor.service || true
    systemctl start policy-monitor-collector.timer policy-monitor-historical.timer || true
  fi
}

on_error() {
  local status=$?
  echo "Deployment failed; backups are in ${BACKUP_DIR}" >&2
  recover_services
  exit "$status"
}

trap cleanup EXIT
trap on_error ERR

for command in "$NODE_BIN" "$NPM_BIN" systemctl tar curl install cp; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command not found: ${command}" >&2
    exit 69
  fi
done
if [[ ! -f "$RELEASE_ARCHIVE" ]]; then
  echo "Release archive not found: ${RELEASE_ARCHIVE}" >&2
  exit 66
fi

tar -xzf "$RELEASE_ARCHIVE" -C "$STAGE_DIR" --no-same-owner
if [[ ! -f "${STAGE_DIR}/server/schema.sql" || ! -f "${STAGE_DIR}/collector/src/cli.js" ]]; then
  echo "Release archive must contain the repository at its root" >&2
  exit 65
fi

(
  cd "${STAGE_DIR}/server"
  "$NPM_BIN" ci
  "$NODE_BIN" --test
)
(
  cd "${STAGE_DIR}/collector"
  "$NODE_BIN" --test
)

install -d -m 0750 "$BACKUP_DIR" "$DATA_DIR"
systemctl stop policy-monitor-collector.timer policy-monitor-historical.timer
systemctl stop policy-monitor-collector.service policy-monitor-historical.service policy-monitor.service || true
SERVICES_STOPPED=1

if [[ -d "$APP_DIR" ]]; then
  tar --exclude='server/node_modules' --exclude='.git' -czf "${BACKUP_DIR}/application.tar.gz" -C "$APP_DIR" .
fi
for database_file in "$DB_PATH" "${DB_PATH}-wal" "${DB_PATH}-shm"; do
  if [[ -f "$database_file" ]]; then
    cp -a "$database_file" "$BACKUP_DIR/"
  fi
done

install -d -m 0755 "$APP_DIR"
tar -xzf "$RELEASE_ARCHIVE" -C "$APP_DIR" --no-same-owner
chmod 0755 "$APP_DIR"
chmod -R a+rX "$APP_DIR"
(
  cd "${APP_DIR}/server"
  "$NPM_BIN" ci --omit=dev
)

install -m 0644 "${APP_DIR}/deploy/policy-monitor.service" /etc/systemd/system/policy-monitor.service
install -m 0644 "${APP_DIR}/deploy/policy-monitor-alert@.service" /etc/systemd/system/policy-monitor-alert@.service
install -m 0644 "${APP_DIR}/collector/systemd/policy-monitor-collector.service" /etc/systemd/system/policy-monitor-collector.service
install -m 0644 "${APP_DIR}/collector/systemd/policy-monitor-collector.timer" /etc/systemd/system/policy-monitor-collector.timer
install -m 0644 "${APP_DIR}/collector/systemd/policy-monitor-historical.service" /etc/systemd/system/policy-monitor-historical.service
install -m 0644 "${APP_DIR}/collector/systemd/policy-monitor-historical.timer" /etc/systemd/system/policy-monitor-historical.timer

(
  cd "${APP_DIR}/server"
  DB_PATH="$DB_PATH" "$NODE_BIN" --disable-warning=ExperimentalWarning scripts/init-db.js
)
DB_PATH="$DB_PATH" "$NODE_BIN" --disable-warning=ExperimentalWarning \
  "${APP_DIR}/deploy/verify-production.js" --db-path "$DB_PATH" --check-ocr

systemctl daemon-reload
systemctl enable policy-monitor.service policy-monitor-collector.timer policy-monitor-historical.timer
systemctl start policy-monitor.service
systemctl start policy-monitor-collector.timer policy-monitor-historical.timer
SERVICES_STOPPED=0

for _ in {1..20}; do
  if curl --fail --silent --show-error http://127.0.0.1:5191/api/health >/dev/null; then
    echo "Deployment complete; backup: ${BACKUP_DIR}"
    exit 0
  fi
  sleep 1
done

echo "Service did not pass local health check" >&2
exit 1
