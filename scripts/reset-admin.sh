#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

USERNAME=""
PASSWORD=""
PASSWORD_HASH=""
REDIS_URL_VALUE="${REDIS_URL:-redis://127.0.0.1:6379}"
INIT_FILE="${CODEX_ADMIN_INIT_FILE:-$ROOT_DIR/data/init.json}"

usage() {
  cat <<'USAGE'
Usage: ./scripts/reset-admin.sh [options]

Options:
  --username <name>         Admin username. Defaults to existing value or "admin".
  --password <password>     New plain-text password.
  --password-hash <hash>    Precomputed bcrypt hash. Use instead of --password.
  --redis-url <url>         Redis URL. Defaults to REDIS_URL from .env or redis://127.0.0.1:6379
  --init-file <path>        Path to admin init file. Defaults to data/init.json
  -h, --help                Show this help.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --username) USERNAME="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --password-hash) PASSWORD_HASH="$2"; shift 2 ;;
    --redis-url) REDIS_URL_VALUE="$2"; shift 2 ;;
    --init-file) INIT_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [ -z "$PASSWORD" ] && [ -z "$PASSWORD_HASH" ]; then
  echo "Either --password or --password-hash is required." >&2
  exit 1
fi

if [ -n "$PASSWORD" ] && [ -n "$PASSWORD_HASH" ]; then
  echo "Use either --password or --password-hash, not both." >&2
  exit 1
fi

EXISTING_USERNAME=""
EXISTING_INITIALIZED_AT=""
if [ -f "$INIT_FILE" ]; then
  EXISTING_USERNAME="$(node -e "const fs=require('fs'); const p=process.argv[1]; try { const data=JSON.parse(fs.readFileSync(p,'utf8')); process.stdout.write(String(data.adminUsername || '')); } catch {}" "$INIT_FILE")"
  EXISTING_INITIALIZED_AT="$(node -e "const fs=require('fs'); const p=process.argv[1]; try { const data=JSON.parse(fs.readFileSync(p,'utf8')); process.stdout.write(String(data.initializedAt || '')); } catch {}" "$INIT_FILE")"
fi

USERNAME="${USERNAME:-${EXISTING_USERNAME:-admin}}"
UPDATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
INITIALIZED_AT="${EXISTING_INITIALIZED_AT:-$UPDATED_AT}"

if [ -n "$PASSWORD" ]; then
  PASSWORD_HASH="$(node - <<'NODE' "$PASSWORD"
const bcrypt = require('bcryptjs')
const password = process.argv[2]
process.stdout.write(bcrypt.hashSync(password, 10))
NODE
)"
fi

mkdir -p "$(dirname "$INIT_FILE")"
cat > "$INIT_FILE" <<JSON
{
  "adminUsername": "${USERNAME}",
  "passwordHash": "${PASSWORD_HASH}",
  "initializedAt": "${INITIALIZED_AT}",
  "updatedAt": "${UPDATED_AT}"
}
JSON

REDIS_URL="$REDIS_URL_VALUE" \
ADMIN_USERNAME="$USERNAME" \
ADMIN_PASSWORD_HASH="$PASSWORD_HASH" \
UPDATED_AT="$UPDATED_AT" \
INITIALIZED_AT="$INITIALIZED_AT" \
node - <<'NODE'
const redis = require('redis')

;(async () => {
  const client = redis.createClient({ url: process.env.REDIS_URL })
  await client.connect()

  await client.hSet('session:admin_credentials', 'username', process.env.ADMIN_USERNAME)
  await client.hSet('session:admin_credentials', 'passwordHash', process.env.ADMIN_PASSWORD_HASH)
  await client.hSet('session:admin_credentials', 'createdAt', process.env.INITIALIZED_AT)
  await client.hSet('session:admin_credentials', 'updatedAt', process.env.UPDATED_AT)
  await client.hSet('session:admin_credentials', 'lastLogin', '')

  let cursor = '0'
  do {
    const result = await client.scan(cursor, { MATCH: 'codex_admin_session:*', COUNT: 100 })
    cursor = result.cursor
    if (result.keys.length > 0) {
      await client.del(result.keys)
    }
  } while (String(cursor) !== '0')

  await client.quit()
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
NODE

echo "Admin credentials updated."
echo "Username: ${USERNAME}"
echo "Init file: ${INIT_FILE}"
echo "Redis URL: ${REDIS_URL_VALUE}"
echo "Existing web sessions were cleared. Log in again with the new credentials."
