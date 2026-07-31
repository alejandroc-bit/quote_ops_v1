#!/usr/bin/env sh
set -eu
umask 077

case "${QUOTEOPS_SERVICE:-api}" in
  api)
    exec node apps/api/dist/server.js
    ;;
  agent)
    exec node apps/agent/dist/server.js
    ;;
  onboard)
    exec node apps/api/dist/onboard/cli.js "$@"
    ;;
  *)
    echo "Unknown QUOTEOPS_SERVICE: ${QUOTEOPS_SERVICE}" >&2
    exit 64
    ;;
esac
