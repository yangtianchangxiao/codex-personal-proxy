#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${CODEX_PORT:-3311}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379/15}"
ENCRYPTION_SECRET="${ENCRYPTION_SECRET:-smoke-test-encryption-secret}"
TMP_DIR="$(mktemp -d)"
APP_LOG="$TMP_DIR/app.log"
INIT_FILE="data/init.json"
INIT_BACKUP="$TMP_DIR/init.json.backup"
APP_PID=""

export CODEX_PORT="$PORT"
export REDIS_URL
export ENCRYPTION_SECRET
export AUTO_START_REDIS=0
export CODEX_PROXY_URL=""

cleanup() {
  local exit_code=$?

  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
    kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi

  if [ -f "$INIT_BACKUP" ]; then
    mv "$INIT_BACKUP" "$INIT_FILE"
  else
    rm -f "$INIT_FILE"
  fi

  rm -rf "$TMP_DIR"
  exit "$exit_code"
}

trap cleanup EXIT

mkdir -p data logs

if [ -f "$INIT_FILE" ]; then
  cp "$INIT_FILE" "$INIT_BACKUP"
fi

node - <<'NODE' > "$INIT_FILE"
const bcrypt = require('bcryptjs')

const payload = {
  adminUsername: 'smoke-admin',
  passwordHash: bcrypt.hashSync('smoke-password', 10),
  initializedAt: new Date().toISOString()
}

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
NODE

node - <<'NODE'
const redis = require('redis')

;(async () => {
  const client = redis.createClient({ url: process.env.REDIS_URL })
  await client.connect()
  await client.flushDb()
  await client.quit()
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
NODE

node src/app.js > "$APP_LOG" 2>&1 &
APP_PID=$!

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

curl -fsS "http://127.0.0.1:${PORT}/health" > /dev/null

LOGIN_JSON="$(curl -fsS "http://127.0.0.1:${PORT}/api/auth/login" \
  -c "$TMP_DIR/cookies.txt" \
  -H "content-type: application/json" \
  -d '{"username":"smoke-admin","password":"smoke-password"}')"

CREATE_KEY_JSON="$(curl -fsS "http://127.0.0.1:${PORT}/api/keys" \
  -b "$TMP_DIR/cookies.txt" \
  -c "$TMP_DIR/cookies.txt" \
  -H "content-type: application/json" \
  -d '{"name":"smoke-test","routingMode":"shared"}')"

LIST_KEYS_JSON="$(curl -fsS "http://127.0.0.1:${PORT}/api/keys" \
  -b "$TMP_DIR/cookies.txt")"

API_KEY="$(
  LOGIN_JSON="$LOGIN_JSON" \
  CREATE_KEY_JSON="$CREATE_KEY_JSON" \
  LIST_KEYS_JSON="$LIST_KEYS_JSON" \
  node - <<'NODE'
function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseJson(name, raw) {
  try {
    return JSON.parse(raw)
  } catch (error) {
    fail(`${name} is not valid JSON: ${error.message}`)
  }
}

const login = parseJson('login response', process.env.LOGIN_JSON || '')
const created = parseJson('create key response', process.env.CREATE_KEY_JSON || '')
const listed = parseJson('list keys response', process.env.LIST_KEYS_JSON || '')

if (!login.success) fail('admin login failed')
if (!created.success || !created.key || !created.key.apiKey) fail('API key creation failed')
if (!listed.success || !Array.isArray(listed.keys)) fail('API key listing failed')

const createdId = created.key.id
const listedIds = listed.keys.map((item) => item.id)
if (!listedIds.includes(createdId)) fail('created API key was not returned by GET /api/keys')

process.stdout.write(`${created.key.apiKey}\n`)
NODE
)"

ALIAS_MODELS="$(curl -fsS "http://127.0.0.1:${PORT}/anthropic/v1/models" \
  -H "x-api-key: ${API_KEY}" \
  -H "anthropic-version: 2023-06-01")"

COMPAT_MODELS="$(curl -fsS "http://127.0.0.1:${PORT}/compat/anthropic/v1/models" \
  -H "x-api-key: ${API_KEY}" \
  -H "anthropic-version: 2023-06-01")"

ALIAS_COUNT="$(curl -fsS "http://127.0.0.1:${PORT}/anthropic/v1/messages/count_tokens" \
  -H "x-api-key: ${API_KEY}" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"hello"}]}')"

COMPAT_COUNT="$(curl -fsS "http://127.0.0.1:${PORT}/compat/anthropic/v1/messages/count_tokens" \
  -H "x-api-key: ${API_KEY}" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"hello"}]}')"

MODELS_ALIAS_JSON="$ALIAS_MODELS" \
MODELS_COMPAT_JSON="$COMPAT_MODELS" \
COUNT_ALIAS_JSON="$ALIAS_COUNT" \
COUNT_COMPAT_JSON="$COMPAT_COUNT" \
node - <<'NODE'
function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseJson(name, raw) {
  try {
    return JSON.parse(raw)
  } catch (error) {
    fail(`${name} is not valid JSON: ${error.message}`)
  }
}

const aliasModels = parseJson('alias models', process.env.MODELS_ALIAS_JSON || '')
const compatModels = parseJson('compat models', process.env.MODELS_COMPAT_JSON || '')
const aliasCount = parseJson('alias count_tokens', process.env.COUNT_ALIAS_JSON || '')
const compatCount = parseJson('compat count_tokens', process.env.COUNT_COMPAT_JSON || '')

const expectedIds = ['default', 'opus', 'sonnet', 'haiku']
const aliasIds = (aliasModels.data || []).map((item) => item.id)
const compatIds = (compatModels.data || []).map((item) => item.id)

for (const id of expectedIds) {
  if (!aliasIds.includes(id)) fail(`alias models missing ${id}`)
  if (!compatIds.includes(id)) fail(`compat models missing ${id}`)
}

if (JSON.stringify(aliasIds) !== JSON.stringify(compatIds)) {
  fail('alias and compat model lists differ')
}

if (!Number.isFinite(aliasCount.input_tokens) || aliasCount.input_tokens <= 0) {
  fail('alias count_tokens did not return a positive input_tokens value')
}

if (aliasCount.input_tokens !== compatCount.input_tokens) {
  fail('alias and compat count_tokens differ')
}

console.log('Smoke test passed')
NODE
