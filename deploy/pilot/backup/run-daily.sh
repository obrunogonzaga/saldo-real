#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dump_dir=${LIQUIDO_BACKUP_DIR:-/opt/stacks/liquido-pilot/backups}
healthcheck_file=${LIQUIDO_HEALTHCHECK_FILE:-/etc/liquido-pilot/backup-healthcheck-url}
remote_base=r2-hostinger:hostinger-backups/daily/liquido-pilot
umask 077

monitoring_ready=false
if [ -f "$healthcheck_file" ] && [ ! -L "$healthcheck_file" ]; then
  monitoring_ready=true
else
  echo "Backup monitoring is not configured; local backup will still run." >&2
fi

ping() {
  "$script_dir/healthcheck-ping.sh" "$healthcheck_file" "$1"
}

result_file=
stage_dir=
stage_file=
cleanup() {
  code=$?
  trap - EXIT
  if [ "$code" -ne 0 ] && [ "$monitoring_ready" = true ]; then ping /fail || true; fi
  if [ -n "$stage_file" ]; then rm -f -- "$stage_file" || true; fi
  if [ -n "$stage_dir" ]; then rmdir -- "$stage_dir" || true; fi
  if [ -n "$result_file" ]; then rm -f -- "$result_file" || true; fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$monitoring_ready" = true ]; then ping /start || true; fi
mkdir -p "$dump_dir"
result_file=$(mktemp "$dump_dir/.backup-result.XXXXXXXX")
LIQUIDO_BACKUP_RESULT_FILE="$result_file" "$script_dir/backup.sh"
dump_file=$(cat "$result_file")
case "$dump_file" in
  "$dump_dir"/liquido-*.dump) ;;
  *) echo "Backup returned an unexpected path." >&2; exit 1 ;;
esac
if [ ! -f "$dump_file" ] || [ -L "$dump_file" ]; then
  echo "Backup file is unavailable." >&2
  exit 1
fi
if ! command -v hostinger-backup-upload >/dev/null 2>&1 ||
  ! command -v rclone >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo "Backup shipping dependencies are missing." >&2
  exit 1
fi

stage_dir=$(mktemp -d "$dump_dir/.upload.XXXXXXXX")
stage_file="$stage_dir/$(basename -- "$dump_file")"
ln -- "$dump_file" "$stage_file"
prefix="daily/liquido-pilot/$(basename -- "$dump_file" .dump)"
hostinger-backup-upload "$stage_dir" "$prefix"
rclone check --download --one-way --retries 5 --low-level-retries 20 \
  "$stage_dir" "$remote_base/$(basename -- "$dump_file" .dump)"
if [ "$monitoring_ready" != true ]; then
  echo "Off-host copy passed but monitoring is unavailable." >&2
  exit 1
fi
ping ''
echo "Off-host backup verified: $prefix"
