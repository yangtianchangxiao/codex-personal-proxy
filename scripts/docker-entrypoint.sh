#!/usr/bin/env bash
set -euo pipefail

cd /app

mkdir -p data logs

if [ ! -f "data/init.json" ]; then
  if [ -n "${CODEX_ADMIN_PASSWORD_HASH:-}" ] && [ -n "${CODEX_ADMIN_USERNAME:-}" ]; then
    cat > data/init.json <<JSON
{
  "adminUsername": "${CODEX_ADMIN_USERNAME}",
  "passwordHash": "${CODEX_ADMIN_PASSWORD_HASH}",
  "initializedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
  elif [ -n "${CODEX_ADMIN_PASSWORD:-}" ] && [ -n "${CODEX_ADMIN_USERNAME:-}" ]; then
    PASSWORD_HASH="$(node - <<'NODE' "${CODEX_ADMIN_PASSWORD}"
const bcrypt = require('bcryptjs');
const password = process.argv[2];
process.stdout.write(bcrypt.hashSync(password, 10));
NODE
)"
    cat > data/init.json <<JSON
{
  "adminUsername": "${CODEX_ADMIN_USERNAME}",
  "passwordHash": "${PASSWORD_HASH}",
  "initializedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
  else
    echo "Missing admin bootstrap settings. Set CODEX_ADMIN_USERNAME + CODEX_ADMIN_PASSWORD (or CODEX_ADMIN_PASSWORD_HASH)." >&2
    exit 1
  fi
fi

if [ -z "${ENCRYPTION_SECRET:-}" ]; then
  echo "ENCRYPTION_SECRET is required." >&2
  exit 1
fi

exec node src/app.js
