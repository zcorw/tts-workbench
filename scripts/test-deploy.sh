#!/usr/bin/env bash
# Exercise the VPS script locally; Docker is replaced by a stdin-consuming test double.
set -euo pipefail
script=${1:-$(cd "$(dirname "$0")/.." && pwd)/deploy/scripts/deploy.sh}
scratch=$(mktemp -d /tmp/tts-deploy-test-XXXXXXXX)
trap 'rm -rf -- "$scratch"' EXIT
mkdir -p "$scratch/bin"
cat > "$scratch/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$DEPLOY_TEST_TRACE"
command=''
for arg in "$@"; do
  case "$arg" in config|pull|up|exec|run) command=$arg; break ;; esac
done
# Compose exec/run attach stdin by default, even with -T (no TTY).
case "$command" in
  exec|run)
    if [[ " $* " != *' --interactive=false '* ]]; then cat > /dev/null; fi
    ;;
esac
case "$command" in
  pull) [[ "$DEPLOY_TEST_FAIL" != pull ]] || exit 31 ;;
  exec)
    [[ "$DEPLOY_TEST_FAIL" != backup ]] || exit 32
    printf 'PGDMP-test-backup\n'
    ;;
  run) [[ "$DEPLOY_TEST_FAIL" != migrate ]] || exit 33 ;;
  up)
    if [[ "${!#}" == app && "$DEPLOY_TEST_FAIL" == readiness ]]; then
      [[ " $* " == *"$DEPLOY_TEST_PREVIOUS/compose.yaml"* ]] || exit 34
    fi
    ;;
esac
MOCK
chmod +x "$scratch/bin/docker"
export PATH="$scratch/bin:$PATH"
revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
image=ghcr.io/example/workbench@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
passed=0
fail() { printf 'FAIL: %s\n' "$*" >&2; cat "$case_dir/output" >&2; exit 1; }
contains() { grep -Fq -- "$1" "$2" || fail "Missing $1 in $2"; }
excludes() { if grep -Fq -- "$1" "$2"; then fail "Unexpected $1 in $2"; fi; }

for mode in stdin file; do
  for scenario in success pull backup migrate readiness-first readiness-previous; do
    case_dir="$scratch/$mode-$scenario"
    root="$case_dir/deployment"
    release="$root/releases/$revision"
    mkdir -p "$release"
    printf 'services: {}\n' > "$release/compose.yaml"
    : > "$root/.env.production"
    export DEPLOY_TEST_TRACE="$case_dir/trace"
    export DEPLOY_TEST_FAIL="$scenario"
    export DEPLOY_TEST_PREVIOUS="$root/releases/previous"
    : > "$DEPLOY_TEST_TRACE"
    if [[ "$scenario" == readiness-* ]]; then DEPLOY_TEST_FAIL=readiness; fi
    if [[ "$scenario" == readiness-previous ]]; then
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
      contains 'up -d --wait --wait-timeout 90 app' "$DEPLOY_TEST_TRACE"
      contains "Deployed $image" "$case_dir/output"
      [[ -L "$root/current" && "$(readlink "$root/current")" == "$release" ]] || fail 'current was not switched'
      contains PGDMP-test-backup "$root/backups/before-$revision.dump"
    else
      [[ "$status" != 0 ]] || fail "$mode $scenario incorrectly returned success"
      excludes 'Deployed ' "$case_dir/output"
      if [[ "$scenario" == readiness-previous ]]; then
        [[ "$(readlink "$root/current")" == "$DEPLOY_TEST_PREVIOUS" ]] || fail 'Previous release was lost'
        contains "$DEPLOY_TEST_PREVIOUS/compose.yaml up -d --wait --wait-timeout 90 app" "$DEPLOY_TEST_TRACE"
      else
        [[ ! -e "$root/current" && ! -L "$root/current" ]] || fail 'Failed release became current'
      fi
      case "$scenario" in
        pull|backup) excludes 'operations.js migrate' "$DEPLOY_TEST_TRACE" ;;
        migrate) excludes 'up -d --wait --wait-timeout 90 app' "$DEPLOY_TEST_TRACE" ;;
      esac
    fi
    printf 'PASS: %s / %s\n' "$mode" "$scenario"
    passed=$((passed + 1))
  done
done
printf 'Deployment regression checks passed (%s cases; no real Docker or VPS calls).\n' "$passed"
