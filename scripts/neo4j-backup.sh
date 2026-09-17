#!/usr/bin/env bash
# Offline dump of Alfred's Neo4j DB.
#
# Community edition cannot do online backups, so `neo4j-admin database dump`
# requires a STOPPED database. This script stops the container, dumps the
# `neo4j` + `system` databases into ./scripts, restarts, then prunes old dumps.
# Schedule it nightly with a systemd timer or cron (low-traffic window).
#
#   chmod +x scripts/neo4j-backup.sh
#   ./scripts/neo4j-backup.sh
#
# Restore (into a STOPPED db / fresh volume):
#   docker compose stop neo4j
#   docker run --rm --volumes-from alfred-neo4j -v "$(pwd)/scripts:/backups" neo4j:5 \
#     neo4j-admin database load neo4j --from-path=/backups --overwrite-destination=true
#   docker compose start neo4j   # init() recreates indexes if restored fresh
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="neo4j"
CONTAINER="alfred-neo4j"
IMAGE="neo4j:5"
BACKUP_DIR="${COMPOSE_DIR}/scripts"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

cd "${COMPOSE_DIR}"
mkdir -p "${BACKUP_DIR}"

echo "[$(date)] stopping ${SERVICE}..."
docker compose stop "${SERVICE}"

echo "[$(date)] dumping neo4j + system databases..."
docker run --rm --volumes-from "${CONTAINER}" -v "${BACKUP_DIR}:/backups" "${IMAGE}" \
  neo4j-admin database dump neo4j system --to-path=/backups --overwrite-destination=true

for db in neo4j system; do
  [ -f "${BACKUP_DIR}/${db}.dump" ] && mv "${BACKUP_DIR}/${db}.dump" "${BACKUP_DIR}/${db}-${STAMP}.dump"
done

echo "[$(date)] restarting ${SERVICE}..."
docker compose start "${SERVICE}"

echo "[$(date)] pruning dumps older than ${KEEP_DAYS} days..."
find "${BACKUP_DIR}" -name '*.dump' -type f -mtime "+${KEEP_DAYS}" -delete

echo "[$(date)] backup complete -> ${BACKUP_DIR}"
# OFF-BOX (do this!): rsync -a "${BACKUP_DIR}/" user@nas:/vault/alfred-neo4j/  # or restic/borg
