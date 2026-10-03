#!/bin/sh
set -eu

if [ "$#" -ne 1 ] || ! printf '%s\n' "$1" |
  LC_ALL=C grep -Eq '^liquido-[0-9]{8}T[0-9]{6}Z-[0-9]+$'; then
  echo "Use a reviewed backup id: liquido-YYYYMMDDTHHMMSSZ-PID." >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
backup_id=$1
remote="r2-hostinger:hostinger-backups/daily/liquido-pilot/$backup_id/$backup_id.dump"
umask 077
restore_dir=$(mktemp -d "${TMPDIR:-/tmp}/liquido-offsite-restore.XXXXXXXX")
dump_file="$restore_dir/$backup_id.dump"
cleanup() {
  rm -f -- "$dump_file" || true
  rmdir -- "$restore_dir" || true
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

started_at=$(date -u +%s)
rclone copyto "$remote" "$dump_file"
if [ ! -s "$dump_file" ]; then
  echo "Off-host dump is empty." >&2
  exit 1
fi
downloaded_at=$(date -u +%s)
"$script_dir/verify-restore.sh" "$dump_file"
completed_at=$(date -u +%s)
echo "Off-host retrieval duration: $((downloaded_at - started_at)) seconds; retrieval plus isolated database verification: $((completed_at - started_at)) seconds."
