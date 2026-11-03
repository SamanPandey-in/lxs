#!/bin/sh
set -eu
# PostgreSQL rotates JSON logs at 10 MiB. Keep only the active log and three
# rotated files so repeated connection attempts cannot fill the decoy volume.
(while sleep 5; do
  ls -1t /var/log/lxs/postgres.json.* 2>/dev/null | tail -n +4 | xargs -r rm -f
done) &
exec /usr/local/bin/docker-entrypoint.sh "$@"
