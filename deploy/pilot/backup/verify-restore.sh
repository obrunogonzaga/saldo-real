#!/bin/sh
set -eu

if [ "$#" -ne 1 ] || [ ! -f "$1" ] || [ -L "$1" ]; then
  echo "Usage: $0 /path/to/liquido-YYYYMMDDTHHMMSSZ.dump" >&2
  exit 2
fi

dump_file=$(CDPATH= cd -- "$(dirname -- "$1")" && pwd)/$(basename -- "$1")
backup_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
started_at=$(date -u +%s)
if dump_modified_at=$(stat -c %Y -- "$dump_file" 2>/dev/null); then
  :
else
  dump_modified_at=$(stat -f %m -- "$dump_file")
fi
dump_age_seconds=$((started_at - dump_modified_at))
if [ "$dump_age_seconds" -lt 0 ]; then
  echo "Dump modification time is in the future; cannot report its age." >&2
  exit 1
fi
umask 077
RESTORE_TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/liquido-restore.XXXXXXXX")
export RESTORE_TEST_DIR
project="liquido-restore-$(basename "$RESTORE_TEST_DIR" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"

cleanup() {
  docker compose --project-directory "$backup_dir" -f "$backup_dir/compose.restore.yaml" \
    -p "$project" down >/dev/null 2>&1 || true
  rm -f -- "$RESTORE_TEST_DIR/password"
  rmdir -- "$RESTORE_TEST_DIR"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

openssl rand -hex 32 > "$RESTORE_TEST_DIR/password"
chmod 644 "$RESTORE_TEST_DIR/password"
docker compose --project-directory "$backup_dir" -f "$backup_dir/compose.restore.yaml" \
  -p "$project" up --detach --wait --no-build

docker compose --project-directory "$backup_dir" -f "$backup_dir/compose.restore.yaml" \
  -p "$project" exec -T restore-db \
  pg_restore --username=postgres --dbname=restore_test --no-owner --no-acl --exit-on-error \
  < "$dump_file"

table_count=$(docker compose --project-directory "$backup_dir" -f "$backup_dir/compose.restore.yaml" \
  -p "$project" exec -T restore-db \
  psql --username=postgres --dbname=restore_test --tuples-only --no-align \
  --command="SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")
if [ "$table_count" -lt 1 ]; then
  echo "Restore completed without application tables." >&2
  exit 1
fi

# Query representative account, simulation, catalog and billing data without printing rows.
docker compose --project-directory "$backup_dir" -f "$backup_dir/compose.restore.yaml" \
  -p "$project" exec -T restore-db \
  psql --username=postgres --dbname=restore_test --set=ON_ERROR_STOP=1 \
  --tuples-only --no-align --command='SELECT (SELECT count(*) FROM "user"), (SELECT count(*) FROM saved_simulation), (SELECT count(*) FROM catalog_product), (SELECT count(*) FROM billing_order)' \
  > /dev/null

completed_at=$(date -u +%s)
echo "Disposable restore verified: $table_count public tables; representative account, simulation, catalog and billing queries passed."
echo "Dump age at restore start (RPO proxy from file modification time): $dump_age_seconds seconds; restore verification duration: $((completed_at - started_at)) seconds."
