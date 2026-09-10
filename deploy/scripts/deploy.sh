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
# The workflow supplies this script through `ssh ... bash -s`. Child commands must
# not consume that same stdin, or Bash can reach EOF before migration/app startup.
compose() { docker compose --project-name tts-workbench --env-file "$root/.env.production" --env-file "$release/release.env" -f "$release/compose.yaml" "$@" < /dev/null; }
compose config --quiet
printf 'Pulling release %s\n' "$revision"
compose pull
previous=''
if test -L "$root/current"; then previous=$(readlink -f "$root/current"); fi
compose up -d --wait db
# Backup includes accounts, personal rules, articles and audio; keep existing volumes.
printf 'Backing up database\n'
compose exec -T --interactive=false db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$root/backups/before-$revision.dump"
printf 'Running database migrations\n'
compose run --rm -T --interactive=false --no-deps app node apps/api/dist/operations.js migrate
printf 'Starting app and waiting for readiness\n'
if compose up -d --wait --wait-timeout 90 app; then
  ln -sfn "$release" "$root/current"
  printf 'Deployed %s\n' "$image"
else
  echo 'Readiness failed; restoring previous compatible application image'
  if test -n "$previous"; then
    docker compose --project-name tts-workbench --env-file "$root/.env.production" --env-file "$previous/release.env" -f "$previous/compose.yaml" up -d --wait --wait-timeout 90 app < /dev/null
  fi
  exit 1
fi
