#!/usr/bin/env sh
# Home Assistant add-on entrypoint for Dime Dinner.
set -e

# Add-on options are mounted at /data/options.json; the app reads them directly.
export DIME_DINNER_OPTIONS="${DIME_DINNER_OPTIONS:-/data/options.json}"
export DIME_DINNER_DB="${DIME_DINNER_DB:-/data/dime-dinner.db}"
export NODE_ENV=production
export PORT="${PORT:-5000}"

echo "[dime-dinner] starting on port ${PORT} (database: ${DIME_DINNER_DB})"
exec node /app/dist/index.cjs
