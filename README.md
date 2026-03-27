# codex-personal-proxy

`codex-personal-proxy` is a personal Codex relay for one account on one server.

It is intended only to solve individual usage:

- one person
- one upstream account
- one server or one personal VM
- localhost, LAN, SSH tunnel, or a simple personal domain

It is not intended for:

- public relay services
- shared account pools
- commercial resale
- multi-tenant routing
- team billing or quota resale

This public repo removes OAuth login on purpose. The recommended path is to log in with Codex locally, then import local `~/.codex/auth.json` into the relay.

## What It Provides

- OpenAI Responses compatible API
- `chat.completions` compatibility for older tools
- Anthropic-compatible endpoint for Claude Code
- built-in admin UI
- local `~/.codex/auth.json` import
- manual account entry

## Deployment Modes

### Direct Port Mode

Best for personal use and no-domain setups.

Base URL example:

- `http://127.0.0.1:3101`

Paths:

- Admin UI: `/`
- Docs: `/docs/claude-codex-usage.html`
- OpenAI Responses: `/v1`
- `chat.completions`: `/compat/v1`
- Claude Code: `/anthropic`

### Domain + Nginx Mode

Optional. Only use this if you already have a personal domain.

Base URL example:

- `https://codex.example.com/codex`

Paths:

- Admin UI: `/codex-admin`
- Docs: `/codex-admin/docs/claude-codex-usage.html`
- OpenAI Responses: `/codex/v1`
- `chat.completions`: `/codex/compat/v1`
- Claude Code: `/codex/anthropic`

## Actual Config Sources

There is no hidden Tencent Cloud `app.setting.json`.

Server-side:

- `.env`
- `data/init.json`
- `Redis`

Client-side:

- `~/.codex/config.toml`
- `~/.codex/auth.json` when importing a local account

## Quick Start: Personal / No Domain

```bash
git clone git@github.com:yangtianchangxiao/codex-personal-proxy.git
cd codex-personal-proxy
./install.sh --skip-packages --admin-user admin --admin-password 'change-this-now'
./start.sh start
```

Verify:

```bash
curl -sS http://127.0.0.1:3101/health
curl -sS http://127.0.0.1:3101/v1/models \
  -H "Authorization: Bearer cx_your_key"
```

Admin UI:

- `http://127.0.0.1:3101/`

Docs:

- `http://127.0.0.1:3101/docs/claude-codex-usage.html`

If the relay runs on Tencent Cloud and you do not want a public port, use SSH tunnel:

```bash
ssh -L 3101:127.0.0.1:3101 ubuntu@YOUR_TENCENT_CLOUD_IP
```

Then use locally:

- `http://127.0.0.1:3101/v1`
- `http://127.0.0.1:3101/anthropic`

## Quick Start: Personal Domain + Nginx

```bash
git clone git@github.com:yangtianchangxiao/codex-personal-proxy.git
cd codex-personal-proxy
./install.sh \
  --admin-user admin \
  --admin-password 'change-this-now' \
  --domain codex.example.com \
  --public-base-url https://codex.example.com \
  --with-nginx \
  --with-systemd
```

Verify:

```bash
systemctl status codex-personal-proxy
curl -sS http://127.0.0.1:3101/health
curl -sS https://codex.example.com/codex-admin/health
```

## Recommended Account Flow

1. Log in with Codex locally on your own machine
2. Open the relay admin UI
3. Import local `~/.codex/auth.json`
4. Create your own `cx_...` API key
5. Point Claude Code or Codex CLI at this relay

## Client Configuration

### Claude Code

Direct port mode:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3101/anthropic"
export ANTHROPIC_AUTH_TOKEN="cx_your_key"
export ANTHROPIC_MODEL="default"
npx @anthropic-ai/claude-code
```

Domain + nginx mode:

```bash
export ANTHROPIC_BASE_URL="https://YOUR_DOMAIN/codex/anthropic"
export ANTHROPIC_AUTH_TOKEN="cx_your_key"
export ANTHROPIC_MODEL="default"
npx @anthropic-ai/claude-code
```

### OpenAI Responses / SDK

Direct port mode:

```bash
export OPENAI_BASE_URL="http://127.0.0.1:3101/v1"
export OPENAI_API_KEY="cx_your_key"
```

Domain + nginx mode:

```bash
export OPENAI_BASE_URL="https://YOUR_DOMAIN/codex/v1"
export OPENAI_API_KEY="cx_your_key"
```

### Codex CLI Provider Snippet

See [examples/codex-config.toml](/home/ubuntu/codex-personal-proxy/examples/codex-config.toml).

### More Env Examples

See [examples/client-env.sh](/home/ubuntu/codex-personal-proxy/examples/client-env.sh).

## Important Environment Variables

- `CODEX_PORT`: local listen port, default `3101`
- `REDIS_URL`: Redis connection, default `redis://127.0.0.1:6379`
- `ENCRYPTION_SECRET`: required; used to encrypt stored tokens
- `CODEX_PUBLIC_DOMAIN`: optional public domain
- `PUBLIC_BASE_URL`: optional public origin
- `CODEX_PROXY_URL`: optional outbound proxy
- `CODEX_DIRECT_HOSTS`: hosts that should bypass the proxy

## Deployment Files

- nginx template: [deploy/nginx/codex-personal-proxy.http.conf.template](/home/ubuntu/codex-personal-proxy/deploy/nginx/codex-personal-proxy.http.conf.template)
- systemd template: [deploy/systemd/codex-personal-proxy.service.template](/home/ubuntu/codex-personal-proxy/deploy/systemd/codex-personal-proxy.service.template)
- environment example: [.env.example](/home/ubuntu/codex-personal-proxy/.env.example)
- smoke test: [scripts/smoke-test.sh](/home/ubuntu/codex-personal-proxy/scripts/smoke-test.sh)

## Verification Checklist

Direct port mode:

```bash
curl -sS http://127.0.0.1:3101/health
curl -sS http://127.0.0.1:3101/v1/models -H "Authorization: Bearer cx_your_key"
curl -sS http://127.0.0.1:3101/anthropic/v1/models \
  -H "x-api-key: cx_your_key" \
  -H "anthropic-version: 2023-06-01"
```

Domain + nginx mode:

```bash
curl -sS https://YOUR_DOMAIN/codex-admin/health
curl -sS https://YOUR_DOMAIN/codex/v1/models -H "Authorization: Bearer cx_your_key"
curl -sS https://YOUR_DOMAIN/codex/anthropic/v1/models \
  -H "x-api-key: cx_your_key" \
  -H "anthropic-version: 2023-06-01"
```
