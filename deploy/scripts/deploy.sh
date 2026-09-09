#!/usr/bin/env bash
set -euo pipefail
umask 077
# Executed on the VPS only after an authorized Actions workflow; no remote execution during development.
root=${1:?deployment directory}; image=${2:?immutable image}; revision=${3:?git SHA}
[[ "$root" =~ ^/[A-Za-z0-9/_-]+$ && "$root" != / && "$revision" =~ ^[a-f0-9]{40}$ && "$image" =~ ^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$ ]] || exit 2
release="$root/releases/$revision"
test -f "$root/.env.production"
test -f "$release/compose.yaml"
mkdir -p "$root/backups"
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Another deployment is running'; exit 1; }
printf 'APP_IMAGE=%s\nRUNTIME_ENV_FILE=%s/.env.production\n' "$image" "$root" > "$release/release.env"
compose() { docker compose --project-name tts-workbench --env-file "$root/.env.production" --env-file "$release/release.env" -f "$release/compose.yaml" "$@"; }
compose config --quiet
compose pull
previous=''
if test -L "$root/current"; then previous=$(readlink -f "$root/current"); fi
compose up -d --wait db
# Backup includes account and personal rules; update never removes volumes.
compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$root/backups/before-$revision.dump"
compose run --rm --no-deps app node apps/api/dist/operations.js migrate
if compose up -d --wait --wait-timeout 90 app; then
  ln -sfn "$release" "$root/current"
  printf 'Deployed %s\n' "$image"
else
  echo 'Readiness failed; restoring previous compatible application image'
  if test -n "$previous"; then
    docker compose --project-name tts-workbench --env-file "$root/.env.production" --env-file "$previous/release.env" -f "$previous/compose.yaml" up -d --wait --wait-timeout 90 app
  fi
  exit 1
fi
