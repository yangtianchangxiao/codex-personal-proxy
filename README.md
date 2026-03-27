# codex-personal-proxy

A personal Codex relay with:

- OpenAI Responses compatibility
- `chat.completions` compatibility
- Anthropic-compatible endpoint for Claude Code
- built-in admin UI
- local `~/.codex/auth.json` import
- OAuth account import for ChatGPT-backed Codex accounts

This public repo is meant for direct personal use first. Domain and nginx are optional.

## Two Deployment Modes

### 1. Direct Port Mode

Use this when you:

- do not have a domain
- only need personal use
- want to access the server by `localhost`, LAN IP, SSH tunnel, or port mapping

Paths in this mode:

- Admin UI: `/`
- Docs: `/docs/claude-codex-usage.html`
- OpenAI Responses: `/v1`
- `chat.completions`: `/compat/v1`
- Claude Code / Anthropic: `/anthropic`

Example base URL:

- `http://127.0.0.1:3101`

### 2. Domain + Nginx Mode

Use this when you:

- have a public domain
- want cleaner external URLs
- want server callback OAuth under your own domain

Paths in this mode:

- Admin UI: `/codex-admin`
- Docs: `/codex-admin/docs/claude-codex-usage.html`
- OpenAI Responses: `/codex/v1`
- `chat.completions`: `/codex/compat/v1`
- Claude Code / Anthropic: `/codex/anthropic`

Example base URL:

- `https://codex.example.com/codex`

## What Config Actually Controls This

There is no hidden `app.setting`.

Server-side config:

- `.env`
- `data/init.json`

Client-side config:

- `~/.codex/config.toml`
- `~/.codex/auth.json` only when importing a local account into the relay

## Quick Start: Local Or Tencent Cloud Without Domain

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

If the relay runs on a remote Tencent Cloud machine and you do not want to open a public port, use SSH tunnel:

```bash
ssh -L 3101:127.0.0.1:3101 ubuntu@YOUR_TENCENT_CLOUD_IP
```

Then your local machine can still use:

- `http://127.0.0.1:3101/v1`
- `http://127.0.0.1:3101/anthropic`

## Quick Start: Tencent Cloud With Domain

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

This does:

- installs packages on Ubuntu if needed
- writes `.env`
- generates `data/init.json`
- installs nginx config template
- installs systemd service template

After that:

```bash
systemctl status codex-personal-proxy
curl -sS http://127.0.0.1:3101/health
curl -sS https://codex.example.com/codex-admin/health
```

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

## OAuth Modes

Supported modes:

- loopback OAuth: browser returns to `http://localhost:1455/auth/callback`
- server callback OAuth: browser returns to your public domain callback

For direct port / no-domain use, loopback OAuth is the correct default.

If you need server callback OAuth, set one of:

- `PUBLIC_BASE_URL=https://your-domain`
- `CODEX_OAUTH_REDIRECT_URI=https://your-domain/codex/oauth/callback`

## Important Environment Variables

- `CODEX_PORT`: local listen port, default `3101`
- `REDIS_URL`: Redis connection, default `redis://127.0.0.1:6379`
- `ENCRYPTION_SECRET`: required; used to encrypt stored tokens
- `CODEX_PUBLIC_DOMAIN`: optional public domain
- `PUBLIC_BASE_URL`: optional public origin, e.g. `https://codex.example.com`
- `CODEX_OAUTH_REDIRECT_URI`: explicit OAuth callback override
- `CODEX_PROXY_URL`: optional outbound proxy
- `CODEX_DIRECT_HOSTS`: hosts that should bypass the proxy

## Deployment Files

- nginx template: [deploy/nginx/codex-personal-proxy.http.conf.template](/home/ubuntu/codex-personal-proxy/deploy/nginx/codex-personal-proxy.http.conf.template)
- systemd template: [deploy/systemd/codex-personal-proxy.service.template](/home/ubuntu/codex-personal-proxy/deploy/systemd/codex-personal-proxy.service.template)
- environment example: [.env.example](/home/ubuntu/codex-personal-proxy/.env.example)
- smoke test: [scripts/smoke-test.sh](/home/ubuntu/codex-personal-proxy/scripts/smoke-test.sh)

## Security Notes

- `.env` and `data/init.json` are gitignored
- this repo does not ship real credentials
- `ENCRYPTION_SECRET` is required
- rotate keys if you have pasted real keys into shells or docs

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
