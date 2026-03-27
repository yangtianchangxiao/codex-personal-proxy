#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

PORT="${CODEX_PORT:-3101}"
DOMAIN="${CODEX_PUBLIC_DOMAIN:-}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
ADMIN_USER="${CODEX_ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${CODEX_ADMIN_PASSWORD:-}"
CODEX_PROXY_URL="${CODEX_PROXY_URL:-}"
INSTALL_NGINX=0
INSTALL_SYSTEMD=0
INSTALL_PACKAGES=1
AUTO_START=1

usage() {
  cat <<USAGE
Usage: ./install.sh [options]

Options:
  --domain <domain>            Optional public domain, e.g. codex.example.com
  --public-base-url <url>      Optional public base URL, e.g. https://codex.example.com
  --admin-user <user>          Admin username, default: admin
  --admin-password <password>  Admin password. If omitted, one will be generated.
  --port <port>                Service port, default: 3101
  --proxy-url <url>            Optional outbound proxy, e.g. http://127.0.0.1:18444
  --with-nginx                 Install nginx config template into /etc/nginx
  --with-systemd               Install systemd unit
  --skip-packages              Skip apt package installation
  --no-start                   Do not start service after installation
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --public-base-url) PUBLIC_BASE_URL="$2"; shift 2 ;;
    --admin-user) ADMIN_USER="$2"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --proxy-url) CODEX_PROXY_URL="$2"; shift 2 ;;
    --with-nginx) INSTALL_NGINX=1; shift ;;
    --with-systemd) INSTALL_SYSTEMD=1; shift ;;
    --skip-packages) INSTALL_PACKAGES=0; shift ;;
    --no-start) AUTO_START=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [ -z "$ADMIN_PASSWORD" ]; then
  ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '=+/' | cut -c1-20)"
fi

ensure_sudo() {
  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    "$@"
  fi
}

install_node_if_needed() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$major" -ge 20 ]; then
      return
    fi
  fi

  curl -fsSL https://deb.nodesource.com/setup_22.x | ensure_sudo -E bash -
  ensure_sudo apt-get install -y nodejs
}

write_env_key() {
  local key="$1"
  local value="$2"
  local file="$ROOT_DIR/.env"
  local rendered="$value"
  if [[ "$value" =~ [[:space:]\'\"\\\$\#\`] ]]; then
    rendered="'${value//\'/\'\"\'\"\'}'"
  fi
  touch "$file"
  local tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v line="$key=$rendered" '
    BEGIN { done = 0 }
    index($0, k "=") == 1 { if (!done) print line; done = 1; next }
    { print }
    END { if (!done) print line }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

if [ "$INSTALL_PACKAGES" = "1" ] && command -v apt-get >/dev/null 2>&1; then
  ensure_sudo apt-get update
  ensure_sudo apt-get install -y curl ca-certificates git redis-server nginx zstd lsof build-essential
  install_node_if_needed
fi

mkdir -p logs data deploy/generated
[ -f .env ] || cp .env.example .env

ENCRYPTION_SECRET_VALUE="${ENCRYPTION_SECRET:-$(openssl rand -hex 32)}"
write_env_key CODEX_PORT "$PORT"
write_env_key REDIS_URL "${REDIS_URL:-redis://127.0.0.1:6379}"
write_env_key ENCRYPTION_SECRET "$ENCRYPTION_SECRET_VALUE"
write_env_key CODEX_DIRECT_HOSTS "${CODEX_DIRECT_HOSTS:-api.openai.com,chatgpt.com}"
write_env_key CODEX_PUBLIC_DOMAIN "$DOMAIN"
write_env_key PUBLIC_BASE_URL "$PUBLIC_BASE_URL"
write_env_key CODEX_PROXY_URL "$CODEX_PROXY_URL"
write_env_key AUTO_START_REDIS "1"
if [ -n "$PUBLIC_BASE_URL" ]; then
  write_env_key CODEX_OAUTH_REDIRECT_URI "${PUBLIC_BASE_URL%/}/codex/oauth/callback"
fi

npm install

PASSWORD_HASH="$(node - <<'NODE' "$ADMIN_PASSWORD"
const bcrypt = require('bcryptjs');
const password = process.argv[2];
process.stdout.write(bcrypt.hashSync(password, 10));
NODE
)"

cat > data/init.json <<JSON
{
  "adminUsername": "${ADMIN_USER}",
  "passwordHash": "${PASSWORD_HASH}",
  "initializedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

if [ "$INSTALL_NGINX" = "1" ]; then
  if [ -z "$DOMAIN" ]; then
    echo "--with-nginx requires --domain" >&2
    exit 1
  fi
  sed \
    -e "s/__SERVER_NAME__/${DOMAIN}/g" \
    -e "s/__UPSTREAM_PORT__/${PORT}/g" \
    deploy/nginx/codex-personal-proxy.http.conf.template > deploy/generated/codex-personal-proxy.conf
  ensure_sudo cp deploy/generated/codex-personal-proxy.conf /etc/nginx/sites-available/codex-personal-proxy.conf
  ensure_sudo ln -sf /etc/nginx/sites-available/codex-personal-proxy.conf /etc/nginx/sites-enabled/codex-personal-proxy.conf
  ensure_sudo nginx -t
  ensure_sudo systemctl reload nginx
fi

if [ "$INSTALL_SYSTEMD" = "1" ]; then
  NODE_BIN="$(command -v node)"
  sed \
    -e "s#__SERVICE_USER__#${USER}#g" \
    -e "s#__APP_DIR__#${ROOT_DIR}#g" \
    -e "s#__NODE_BIN__#${NODE_BIN}#g" \
    deploy/systemd/codex-personal-proxy.service.template > deploy/generated/codex-personal-proxy.service
  ensure_sudo cp deploy/generated/codex-personal-proxy.service /etc/systemd/system/codex-personal-proxy.service
  ensure_sudo systemctl daemon-reload
  if [ "$AUTO_START" = "1" ]; then
    ensure_sudo systemctl enable --now codex-personal-proxy.service
  fi
fi

if [ "$AUTO_START" = "1" ] && [ "$INSTALL_SYSTEMD" = "0" ]; then
  ./start.sh restart
fi

echo
echo "Install complete."
echo "Admin username: ${ADMIN_USER}"
echo "Admin password: ${ADMIN_PASSWORD}"
echo "Health URL: http://127.0.0.1:${PORT}/health"
echo "Admin UI: http://127.0.0.1:${PORT}/"
echo "Docs: http://127.0.0.1:${PORT}/docs/claude-codex-usage.html"
echo "OpenAI Responses: http://127.0.0.1:${PORT}/v1"
echo "Claude Code: http://127.0.0.1:${PORT}/anthropic"
if [ -n "$DOMAIN" ]; then
  echo "Public docs: http://${DOMAIN}/codex-admin/docs/claude-codex-usage.html"
fi
