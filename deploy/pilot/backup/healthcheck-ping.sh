#!/bin/sh
set -eu

if [ "$#" -ne 2 ] || [ ! -f "$1" ] || [ -L "$1" ]; then
  echo "Backup monitoring is not configured." >&2
  exit 1
fi
if file_mode=$(stat -c %a -- "$1" 2>/dev/null); then
  :
else
  file_mode=$(stat -f %Lp -- "$1")
fi
if [ "$file_mode" != 600 ]; then
  echo "Backup monitoring file must have mode 600." >&2
  exit 1
fi
healthcheck_url=$(cat "$1")
if ! printf '%s\n' "$healthcheck_url" |
  LC_ALL=C grep -Eq '^https://hc-ping\.com/[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'; then
  echo "Backup monitoring URL is invalid." >&2
  exit 1
fi
case "$2" in
  /start|/fail|'') ;;
  *) echo "Backup monitoring signal is invalid." >&2; exit 1 ;;
esac
printf 'url = "%s%s"\n' "$healthcheck_url" "$2" |
  curl --config - --fail --silent --show-error --max-time 10 --retry 3 --output /dev/null
