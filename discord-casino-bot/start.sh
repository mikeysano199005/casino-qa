#!/bin/sh
set -e
echo "[start] Running migrations..."
node src/db/migrate.js
echo "[start] Starting bot..."
exec node src/index.js
