#!/bin/sh
set -eu

pilot_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
backup_dir=/opt/stacks/liquido-pilot/backups
umask 077
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

lock_dir="$backup_dir/.backup.lock"
if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "A pilot database backup is already running." >&2
  exit 1
fi

temp_file=
cleanup() {
  if [ -n "$temp_file" ]; then
    rm -f -- "$temp_file"
  fi
  rmdir -- "$lock_dir"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

stamp=$(date -u '+%Y%m%dT%H%M%SZ')
started_at=$(date -u +%s)
temp_file=$(mktemp "$backup_dir/.liquido-$stamp.XXXXXX")
dump_file="$backup_dir/liquido-$stamp-$$.dump"

docker compose --project-directory "$pilot_dir" \
  -f "$pilot_dir/compose.yaml" -f "$pilot_dir/compose.database.yaml" \
  exec -T db sh -eu -c \
  'PGPASSWORD="$(cat /run/secrets/pilot_db_password)" exec pg_dump --host=127.0.0.1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --no-password' \
  > "$temp_file"

if [ ! -s "$temp_file" ]; then
  echo "The pilot database dump is empty." >&2
  exit 1
fi

docker compose --project-directory "$pilot_dir" \
  -f "$pilot_dir/compose.yaml" -f "$pilot_dir/compose.database.yaml" \
  exec -T db pg_restore --list < "$temp_file" > /dev/null

mv -- "$temp_file" "$dump_file"
temp_file=
if [ -n "${LIQUIDO_BACKUP_RESULT_FILE:-}" ]; then
  printf '%s\n' "$dump_file" > "$LIQUIDO_BACKUP_RESULT_FILE"
fi
completed_at=$(date -u +%s)
echo "Pilot database backup saved: $dump_file"
echo "Backup duration: $((completed_at - started_at)) seconds; completed at $(date -u '+%Y-%m-%dT%H:%M:%SZ')."
