#!/usr/bin/env bash
set -euo pipefail
umask 077
root=${1:?deployment directory}
[[ "$root" =~ ^/[A-Za-z0-9/_-]+$ && "$root" != / ]] || exit 2
release=$(readlink -f "$root/current")
mkdir -p "$root/backups"
docker compose --project-name tts-workbench --env-file "$root/.env.production" --env-file "$release/release.env" -f "$release/compose.yaml" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$root/backups/daily-$(date -u +%Y%m%dT%H%M%SZ).dump"
# Retention applies only to this application's daily backups, never DB volumes or pre-deploy backups.
find "$root/backups" -maxdepth 1 -type f -name 'daily-*.dump' -mtime +7 -delete
