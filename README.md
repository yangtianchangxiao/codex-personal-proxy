# codex-personal-proxy

<p align="right">
  <a href="./README.md">English</a> |
  <a href="./README.zh-CN.md">简体中文</a> |
  <a href="./GUIDE.zh-CN.md">中文部署指南</a>
</p>

Run your own personal Codex endpoint on one server, then access it from Claude Code, Codex CLI, or OpenAI-compatible tools using your own `cx_...` API key.

## What This Project Is

`codex-personal-proxy` is a personal relay for:

- one person
- one upstream account
- one server or one personal VM
- localhost, LAN, SSH tunnel, or a simple personal domain

It includes a built-in compatibility bridge so you can expose:

- an OpenAI Responses endpoint for Codex CLI and OpenAI-compatible tools
- a `chat.completions` endpoint for older adapters
- an Anthropic-compatible endpoint for Claude Code

## What You Can Use It For

Use this repo when you want to:

- keep your own Codex account behind your own endpoint
- generate your own `cx_...` key and use it across your own devices
- use Claude Code against a Codex/OpenAI-backed endpoint
- use Codex CLI against a self-hosted relay instead of direct local setup
- run the relay privately through localhost, SSH tunnel, or your own domain

## What This Project Is Not

It is not intended for:

- public relay services
- shared account pools
- commercial resale
- multi-tenant routing
- team billing or quota resale

## Important Constraint

This public repo intentionally removes OAuth login.

The recommended flow is:

1. log in with Codex on your own machine
2. import local `~/.codex/auth.json` into the relay
3. generate your own `cx_...` key in the admin UI

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

## Admin Credentials

The admin username/password are only for the web admin UI.

They are used to:

- sign in to the admin page
- import local `~/.codex/auth.json`
- create or delete `cx_...` API keys
- manage accounts

They are not used by Claude Code, Codex CLI, or OpenAI-compatible clients.

Clients only need:

1. the correct base URL
2. a `cx_...` API key created in the admin UI

How to set them:

- `./install.sh --admin-user ... --admin-password ...`
- or Docker env vars: `CODEX_ADMIN_USERNAME` + `CODEX_ADMIN_PASSWORD`

How to change them later:

```bash
./scripts/reset-admin.sh --username admin --password 'your-new-password'
```

This updates `data/init.json`, refreshes the Redis admin credentials, and clears old admin login sessions.

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
```

Admin UI:

- `http://127.0.0.1:3101/`

Docs:

- `http://127.0.0.1:3101/docs/claude-codex-usage.html`

After you log into the admin UI, import local `~/.codex/auth.json`, and create a `cx_...` key, test the actual Codex endpoint with:

```bash
curl -sN http://127.0.0.1:3101/v1/responses \
  -H "Authorization: Bearer cx_your_key" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"gpt-5.4",
    "instructions":"Reply exactly: OK",
    "input":[
      {
        "role":"user",
        "content":[
          { "type":"input_text", "text":"Reply exactly: OK" }
        ]
      }
    ]
  }'
```

If the relay runs on Tencent Cloud and you do not want a public port, use SSH tunnel:

```bash
ssh -L 3101:127.0.0.1:3101 ubuntu@YOUR_TENCENT_CLOUD_IP
```

Then use locally:

- `http://127.0.0.1:3101/v1`
- `http://127.0.0.1:3101/anthropic`

## Quick Start: Docker Compose

This is the simplest way to run the personal proxy without systemd or nginx.

1. Prepare `.env`:

```bash
cp .env.example .env
```

Set at least:

- `HOST_PORT`
- `ENCRYPTION_SECRET`
- `CODEX_ADMIN_USERNAME`
- `CODEX_ADMIN_PASSWORD`

2. Start:

```bash
docker compose up -d --build
```

3. Verify:

```bash
docker compose ps
curl -sS http://127.0.0.1:${HOST_PORT:-3101}/health
```

The container entrypoint will create `data/init.json` automatically on first boot if you provide `CODEX_ADMIN_USERNAME` and `CODEX_ADMIN_PASSWORD`.

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

## Restricted-Network GPU Server Note

Here "AutoDL-like" means GPU or cloud servers whose outbound access to Codex/OpenAI/ChatGPT-related endpoints is restricted or unstable. It does not mean only one specific provider.

If you use this on AutoDL-like or otherwise restricted-network GPU servers, the cleanest options are:

1. keep it private and use SSH tunnel
2. or register a cheap overseas domain and reverse-proxy it with nginx

For personal use, a simple domain + nginx setup is usually easier to manage than trying to expose random raw ports long-term.

If you do not want a domain, that is still fine. Use direct port mode or SSH tunnel and keep the relay private.

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

See [examples/codex-config.toml](./examples/codex-config.toml).

### More Env Examples

See [examples/client-env.sh](./examples/client-env.sh).

## Important Environment Variables

- `CODEX_PORT`: local listen port, default `3101`
- `HOST_PORT`: host-published Docker port, default `3101`
- `REDIS_URL`: Redis connection, default `redis://127.0.0.1:6379`
- `ENCRYPTION_SECRET`: required; used to encrypt stored tokens
- `CODEX_PUBLIC_DOMAIN`: optional public domain
- `PUBLIC_BASE_URL`: optional public origin
- `CODEX_PROXY_URL`: optional outbound proxy
- `CODEX_DIRECT_HOSTS`: hosts that should bypass the proxy

## Deployment Files

- nginx template: [deploy/nginx/codex-personal-proxy.http.conf.template](./deploy/nginx/codex-personal-proxy.http.conf.template)
- systemd template: [deploy/systemd/codex-personal-proxy.service.template](./deploy/systemd/codex-personal-proxy.service.template)
- Dockerfile: [Dockerfile](./Dockerfile)
- docker compose: [docker-compose.yml](./docker-compose.yml)
- environment example: [.env.example](./.env.example)
- docker entrypoint: [scripts/docker-entrypoint.sh](./scripts/docker-entrypoint.sh)
- smoke test: [scripts/smoke-test.sh](./scripts/smoke-test.sh)

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
