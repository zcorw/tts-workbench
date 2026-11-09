#!/usr/bin/env bash
# Exercise the VPS script locally; Docker/authentication use synthetic test doubles.
set -euo pipefail
script=${1:-$(cd "$(dirname "$0")/.." && pwd)/deploy/scripts/deploy.sh}
scratch=$(mktemp -d /tmp/tts-deploy-test-XXXXXXXX)
trap 'rm -rf -- "$scratch"' EXIT
mkdir -p "$scratch/bin"
cat > "$scratch/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$DEPLOY_TEST_TRACE"
if [[ "${1:-}" == --config ]]; then
  isolated=$2
  shift 2
  [[ "$1" == pull && "$2" == "$DEPLOY_TEST_IMAGE" && "$#" == 2 ]] || exit 90
  [[ ! ${DOCKER_AUTH_CONFIG+x} ]] || exit 91
  [[ "$DOCKER_CONFIG" == "$DEPLOY_TEST_SHARED_CONFIG" ]] || exit 92
  [[ "$DOCKER_HOST" == tcp://fixture.invalid:2376 && "$DOCKER_TLS_VERIFY" == 1 ]] || exit 93
  [[ "$(stat -c %a "$isolated")" == 700 && "$(stat -c %a "$isolated/config.json")" == 600 ]] || exit 94
  [[ "$(cat "$isolated/config.json")" == '{"auths":{"ghcr.io":{}},"credHelpers":{},"credsStore":""}' ]] || exit 95
  printf '%s\n' "$isolated" >> "$DEPLOY_TEST_ANON_PATHS"
  [[ "$DEPLOY_TEST_FAIL" != pull ]] || exit 31
  exit 0
fi
# Shared commands retain their original config and environment after anonymous pull.
[[ "$DOCKER_CONFIG" == "$DEPLOY_TEST_SHARED_CONFIG" && "$DOCKER_AUTH_CONFIG" == fixture-parent-auth ]] || exit 96
if [[ "${1:-}" == context && "${2:-}" == show ]]; then
  printf '%s\n' "${DEPLOY_TEST_CONTEXT:-default}"
  exit 0
fi
command=''
for arg in "$@"; do
  case "$arg" in config|pull|up|exec|run) command=$arg; break ;; esac
done
case "$command" in
  up|run) [[ " $* " == *' --pull never '* ]] || exit 97 ;;
esac
# Compose exec/run attach stdin by default, even with -T (no TTY).
case "$command" in
  exec|run)
    if [[ " $* " != *' --interactive=false '* ]]; then cat > /dev/null; fi
    ;;
esac
case "$command" in
  pull) [[ "${!#}" == db ]] || exit 98; [[ "$DEPLOY_TEST_FAIL" != db-pull ]] || exit 36 ;;
  exec)
    [[ "$DEPLOY_TEST_FAIL" != backup ]] || exit 32
    printf 'PGDMP-test-backup\n'
    ;;
  run) [[ "$DEPLOY_TEST_FAIL" != migrate ]] || exit 33 ;;
  up)
    if [[ "${!#}" == app && "$DEPLOY_TEST_FAIL" == readiness* ]]; then
      [[ " $* " == *"$DEPLOY_TEST_PREVIOUS/compose.yaml"* ]] || exit 34
      [[ "$DEPLOY_TEST_FAIL" != readiness-missing ]] || exit 35
    fi
    ;;
esac
MOCK
chmod +x "$scratch/bin/docker"
export PATH="$scratch/bin:$PATH"
revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
image=ghcr.io/example/workbench@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export DEPLOY_TEST_IMAGE="$image"
export DEPLOY_TEST_SHARED_CONFIG="$scratch/shared-docker"
export DOCKER_CONFIG="$DEPLOY_TEST_SHARED_CONFIG"
export DOCKER_AUTH_CONFIG=fixture-parent-auth
export DOCKER_HOST=tcp://fixture.invalid:2376
export DOCKER_TLS_VERIFY=1
mkdir -p "$DOCKER_CONFIG"
printf '%s\n' '{"auths":{"ghcr.io":{"auth":"synthetic-shared-sentinel"},"https://index.docker.io/v1/":{"auth":"synthetic-hub-sentinel"}}}' > "$DOCKER_CONFIG/config.json"
shared_before=$(cksum "$DOCKER_CONFIG/config.json")
passed=0
fail() { printf 'FAIL: %s\n' "$*" >&2; cat "$case_dir/output" >&2; exit 1; }
contains() { grep -Fq -- "$1" "$2" || fail "Missing $1 in $2"; }
excludes() { if grep -Fq -- "$1" "$2"; then fail "Unexpected $1 in $2"; fi; }

for mode in stdin file; do
  for scenario in success pull db-pull named-context backup migrate readiness-first readiness-previous readiness-missing; do
    case_dir="$scratch/$mode-$scenario"
    root="$case_dir/deployment"
    release="$root/releases/$revision"
    mkdir -p "$release"
    printf 'services: {}\n' > "$release/compose.yaml"
    : > "$root/.env.production"
    export DEPLOY_TEST_TRACE="$case_dir/trace"
    export DEPLOY_TEST_FAIL="$scenario"
    export DEPLOY_TEST_PREVIOUS="$root/releases/previous"
    export DEPLOY_TEST_ANON_PATHS="$case_dir/anonymous-paths"
    export DEPLOY_TEST_CONTEXT=default
    : > "$DEPLOY_TEST_TRACE"
    : > "$DEPLOY_TEST_ANON_PATHS"
    if [[ "$scenario" == named-context ]]; then DEPLOY_TEST_CONTEXT=remote-fixture; fi
    if [[ "$scenario" == readiness-first || "$scenario" == readiness-previous ]]; then DEPLOY_TEST_FAIL=readiness; fi
    if [[ "$scenario" == readiness-previous || "$scenario" == readiness-missing ]]; then
      mkdir -p "$DEPLOY_TEST_PREVIOUS"
      cp "$release/compose.yaml" "$DEPLOY_TEST_PREVIOUS/compose.yaml"
      printf 'APP_IMAGE=previous\n' > "$DEPLOY_TEST_PREVIOUS/release.env"
      ln -s "$DEPLOY_TEST_PREVIOUS" "$root/current"
    fi
    status=0
    if [[ "$mode" == stdin ]]; then
      bash -s -- "$root" "$image" "$revision" < "$script" > "$case_dir/output" 2>&1 || status=$?
    else
      bash "$script" "$root" "$image" "$revision" < /dev/null > "$case_dir/output" 2>&1 || status=$?
    fi
    if [[ "$scenario" == success ]]; then
      [[ "$status" == 0 ]] || fail "$mode $scenario exited $status"
      contains 'operations.js migrate' "$DEPLOY_TEST_TRACE"
      contains 'up -d --wait --wait-timeout 90 --pull never app' "$DEPLOY_TEST_TRACE"
      contains "Deployed $image" "$case_dir/output"
      [[ -L "$root/current" && "$(readlink "$root/current")" == "$release" ]] || fail 'current was not switched'
      contains PGDMP-test-backup "$root/backups/before-$revision.dump"
    else
      [[ "$status" != 0 ]] || fail "$mode $scenario incorrectly returned success"
      excludes 'Deployed ' "$case_dir/output"
      if [[ "$scenario" == readiness-previous || "$scenario" == readiness-missing ]]; then
        [[ "$(readlink "$root/current")" == "$DEPLOY_TEST_PREVIOUS" ]] || fail 'Previous release was lost'
        contains "$DEPLOY_TEST_PREVIOUS/compose.yaml up -d --wait --wait-timeout 90 --pull never app" "$DEPLOY_TEST_TRACE"
      else
        [[ ! -e "$root/current" && ! -L "$root/current" ]] || fail 'Failed release became current'
      fi
      case "$scenario" in
        pull|db-pull|named-context|backup) excludes 'operations.js migrate' "$DEPLOY_TEST_TRACE" ;;
        migrate) excludes 'up -d --wait --wait-timeout 90 --pull never app' "$DEPLOY_TEST_TRACE" ;;
      esac
    fi
    case "$scenario" in
      pull|named-context)
        excludes 'pull db' "$DEPLOY_TEST_TRACE"
        excludes 'Backing up database' "$case_dir/output"
        ;;
      db-pull) excludes 'Backing up database' "$case_dir/output" ;;
      readiness-missing) contains 'Rollback failed. The previous image must be cached' "$case_dir/output" ;;
    esac
    [[ "$(cksum "$DOCKER_CONFIG/config.json")" == "$shared_before" ]] || fail 'Shared Docker credentials were modified'
    [[ "$DOCKER_AUTH_CONFIG" == fixture-parent-auth ]] || fail 'Parent authentication environment was modified'
    while IFS= read -r isolated; do
      [[ ! -e "$isolated" ]] || fail 'Anonymous config was not cleaned up'
    done < "$DEPLOY_TEST_ANON_PATHS"
    if [[ "$scenario" == named-context ]]; then
      [[ ! -s "$DEPLOY_TEST_ANON_PATHS" ]] || fail 'Named context unexpectedly reached anonymous pull'
      contains 'requires the existing default Docker context' "$case_dir/output"
    else
      [[ "$(wc -l < "$DEPLOY_TEST_ANON_PATHS")" == 1 ]] || fail 'Expected exactly one anonymous app pull'
    fi
    printf 'PASS: %s / %s\n' "$mode" "$scenario"
    passed=$((passed + 1))
  done
done
printf 'Deployment regression checks passed (%s cases; no real Docker or VPS calls).\n' "$passed"
