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
pull_public_app() (
  # Never use or replace this user's shared registry login (other projects may need it).
  # A named context lives in the original config directory; do not silently change daemon.
  context=$(docker context show < /dev/null)
  if [[ "$context" != default ]]; then
    echo 'Anonymous app pull requires the existing default Docker context; no daemon was changed.' >&2
    exit 2
  fi
  anonymous_config=$(mktemp -d /tmp/tts-ghcr-anonymous-XXXXXXXX)
  trap 'rm -rf -- "$anonymous_config"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # The empty registry entry also prevents automatic credential-helper discovery.
  printf '%s\n' '{"auths":{"ghcr.io":{}},"credHelpers":{},"credsStore":""}' > "$anonymous_config/config.json"
  unset DOCKER_AUTH_CONFIG
  # Keep the original DOCKER_HOST/TLS environment; use the built-in pull command,
  # so switching config cannot hide a user-installed Compose plugin.
  docker --config "$anonymous_config" pull "$image" < /dev/null
)
compose config --quiet
printf 'Pulling release %s\n' "$revision"
pull_public_app
# Docker Hub credentials, if any, stay available for the separate database image.
compose pull db
previous=''
if test -L "$root/current"; then previous=$(readlink -f "$root/current"); fi
compose up -d --wait --pull never db
# Backup includes accounts, personal rules, articles and audio; keep existing volumes.
printf 'Backing up database\n'
compose exec -T --interactive=false db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$root/backups/before-$revision.dump"
printf 'Running database migrations\n'
compose run --rm -T --interactive=false --no-deps --pull never app node apps/api/dist/operations.js migrate
printf 'Starting app and waiting for readiness\n'
if compose up -d --wait --wait-timeout 90 --pull never app; then
  ln -sfn "$release" "$root/current"
  printf 'Deployed %s\n' "$image"
else
  echo 'Readiness failed; restoring previous compatible application image'
  if test -n "$previous"; then
    if ! docker compose --project-name tts-workbench --env-file "$root/.env.production" --env-file "$previous/release.env" -f "$previous/compose.yaml" up -d --wait --wait-timeout 90 --pull never app < /dev/null; then
      echo 'Rollback failed. The previous image must be cached; shared registry credentials were not used to pull it.' >&2
    fi
  fi
  exit 1
fi
