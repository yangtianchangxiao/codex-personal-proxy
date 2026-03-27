# codex-personal-proxy

<p align="right">
  <a href="./README.md">English</a> |
  <a href="./README.zh-CN.md">简体中文</a> |
  <a href="./GUIDE.zh-CN.md">中文部署指南</a>
</p>

把你自己的 Codex 账户放到一台你自己控制的服务器后面，然后通过你自己的 `cx_...` API Key，让 Claude Code、Codex CLI 和 OpenAI 兼容工具都能接入它。

## 这个项目是什么

`codex-personal-proxy` 是一个面向个人使用的 Codex 中转服务，定位是：

- 一个用户
- 一个上游账户
- 一台服务器或一台个人虚拟机
- 通过 localhost、局域网、SSH 隧道，或者一个简单的个人域名来访问

它内置了兼容层，所以可以同时暴露：

- 给 Codex CLI / OpenAI 工具使用的 OpenAI Responses 接口
- 给旧工具使用的 `chat.completions` 接口
- 给 Claude Code 使用的 Anthropic 兼容接口

## 你可以拿它做什么

适合这些场景：

- 把你自己的 Codex 账户放到你自己的统一入口后面
- 给自己生成一条 `cx_...` key，在自己的多台设备上使用
- 让 Claude Code 通过 Anthropic 兼容层接到 Codex/OpenAI
- 让 Codex CLI 走你自己的中转，而不是完全依赖本机直连
- 通过 localhost、SSH 隧道或你自己的域名来访问它

## 这个项目不是什么

它不适用于：

- 公共中转站
- 共享账号池
- 商业转售
- 多租户路由
- 团队计费或额度转卖

## 一个重要约束

这个 public 仓库已经主动移除了 OAuth 登录能力。

推荐流程是：

1. 先在你自己的本机上登录 Codex
2. 再把本机的 `~/.codex/auth.json` 导入到这个中转服务里
3. 最后在管理后台生成你自己的 `cx_...` API Key

## 它提供什么

- OpenAI Responses 兼容接口
- 给旧工具用的 `chat.completions` 兼容接口
- 给 Claude Code 用的 Anthropic 兼容接口
- 内置管理后台
- 从本机 `~/.codex/auth.json` 导入账号
- 手动录入账户

## 部署模式

### 1. 直连端口模式

最适合个人使用和无域名场景。

基础地址示例：

- `http://127.0.0.1:3101`

路径：

- 管理后台：`/`
- 文档：`/docs/claude-codex-usage.html`
- OpenAI Responses：`/v1`
- `chat.completions`：`/compat/v1`
- Claude Code：`/anthropic`

### 2. 域名 + Nginx 模式

可选。只在你本来就有个人域名时使用。

基础地址示例：

- `https://codex.example.com/codex`

路径：

- 管理后台：`/codex-admin`
- 文档：`/codex-admin/docs/claude-codex-usage.html`
- OpenAI Responses：`/codex/v1`
- `chat.completions`：`/codex/compat/v1`
- Claude Code：`/codex/anthropic`

## 实际配置来源

这里不存在什么腾讯云专属的 `app.setting.json`。

服务端配置来源：

- `.env`
- `data/init.json`
- `Redis`

客户端配置来源：

- `~/.codex/config.toml`
- `~/.codex/auth.json`，仅在“从本机导入账号”时读取

## 管理员账号密码是干什么的

管理员账号密码只用于登录 Web 管理后台。

它们用于：

- 登录管理页面
- 导入本机 `~/.codex/auth.json`
- 创建或删除 `cx_...` API Key
- 管理账户

它们不用于 Claude Code、Codex CLI 或 OpenAI 兼容客户端。

客户端真正需要的只有：

1. 正确的 URL
2. 你在管理后台生成的 `cx_...` API Key

设置方式：

- 安装脚本：`./install.sh --admin-user ... --admin-password ...`
- Docker 环境变量：`CODEX_ADMIN_USERNAME` + `CODEX_ADMIN_PASSWORD`

后续修改方式：

```bash
./scripts/reset-admin.sh --username admin --password '你的新密码'
```

这个脚本会同时更新 `data/init.json`、刷新 Redis 里的管理员凭据，并清掉旧的后台登录会话。

## 快速开始：个人使用 / 无域名

```bash
git clone git@github.com:yangtianchangxiao/codex-personal-proxy.git
cd codex-personal-proxy
./install.sh --skip-packages --admin-user admin --admin-password 'change-this-now'
./start.sh start
```

验证：

```bash
curl -sS http://127.0.0.1:3101/health
```

管理后台：

- `http://127.0.0.1:3101/`

文档：

- `http://127.0.0.1:3101/docs/claude-codex-usage.html`

当你登录后台、导入本机 `~/.codex/auth.json` 并创建 `cx_...` key 之后，建议再用真实 Codex 接口验证一次：

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

如果服务跑在腾讯云或其他远程机器上，但你不想直接暴露公网端口，建议用 SSH 隧道：

```bash
ssh -L 3101:127.0.0.1:3101 ubuntu@YOUR_SERVER_IP
```

然后你本地继续使用：

- `http://127.0.0.1:3101/v1`
- `http://127.0.0.1:3101/anthropic`

## 快速开始：Docker Compose

这是不用 systemd、不用 nginx 的最简单启动方式。

1. 准备 `.env`：

```bash
cp .env.example .env
```

至少要设置：

- `HOST_PORT`
- `ENCRYPTION_SECRET`
- `CODEX_ADMIN_USERNAME`
- `CODEX_ADMIN_PASSWORD`

2. 启动：

```bash
docker compose up -d --build
```

3. 验证：

```bash
docker compose ps
curl -sS http://127.0.0.1:${HOST_PORT:-3101}/health
```

如果你提供了 `CODEX_ADMIN_USERNAME` 和 `CODEX_ADMIN_PASSWORD`，容器第一次启动时会自动生成 `data/init.json`。

## 快速开始：个人域名 + Nginx

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

验证：

```bash
systemctl status codex-personal-proxy
curl -sS http://127.0.0.1:3101/health
curl -sS https://codex.example.com/codex-admin/health
```

## 受限网络 GPU 服务器说明

这里说的 “AutoDL 类场景”，指的是：

- 对 `Codex/OpenAI/ChatGPT` 相关域名访问受限制
- 出口网络不稳定
- 容易遇到风控、挑战页或链路超时
- 常见于某些 GPU 租用平台、云服务器、海外/国内混杂网络环境

它不是单指某一个品牌或某一家平台。

在这类服务器上，更稳的做法通常是：

1. 保持服务私有，用 SSH 隧道
2. 或注册一个便宜的海外域名，再用 nginx 做反向代理

对个人使用来说，`个人域名 + nginx` 往往比长期裸露随机端口更干净，也更容易维护。

如果你不想折腾域名，也完全可以继续用：

- 直连端口模式
- SSH 隧道模式

重点是保持服务私有，不要把它变成公共中转站。

## 推荐的账户使用流程

1. 在你自己的本机先登录 Codex
2. 打开中转服务管理后台
3. 导入本机 `~/.codex/auth.json`
4. 创建你自己的 `cx_...` API Key
5. 让 Claude Code 或 Codex CLI 指向这个中转服务

## 客户端配置

### Claude Code

直连端口模式：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3101/anthropic"
export ANTHROPIC_AUTH_TOKEN="cx_your_key"
export ANTHROPIC_MODEL="default"
npx @anthropic-ai/claude-code
```

域名 + nginx 模式：

```bash
export ANTHROPIC_BASE_URL="https://YOUR_DOMAIN/codex/anthropic"
export ANTHROPIC_AUTH_TOKEN="cx_your_key"
export ANTHROPIC_MODEL="default"
npx @anthropic-ai/claude-code
```

### OpenAI Responses / SDK

直连端口模式：

```bash
export OPENAI_BASE_URL="http://127.0.0.1:3101/v1"
export OPENAI_API_KEY="cx_your_key"
```

域名 + nginx 模式：

```bash
export OPENAI_BASE_URL="https://YOUR_DOMAIN/codex/v1"
export OPENAI_API_KEY="cx_your_key"
```

### Codex CLI Provider 配置片段

见 [examples/codex-config.toml](./examples/codex-config.toml)。

### 更多环境变量示例

见 [examples/client-env.sh](./examples/client-env.sh)。

## 重要环境变量

- `CODEX_PORT`：容器/服务内部监听端口，默认 `3101`
- `HOST_PORT`：Docker 映射到宿主机的端口，默认 `3101`
- `REDIS_URL`：Redis 连接地址，默认 `redis://127.0.0.1:6379`
- `ENCRYPTION_SECRET`：必填，用于加密保存 token
- `CODEX_PUBLIC_DOMAIN`：可选，公网域名
- `PUBLIC_BASE_URL`：可选，公网访问地址
- `CODEX_PROXY_URL`：可选，出站代理
- `CODEX_DIRECT_HOSTS`：哪些域名绕过代理直连

## 部署相关文件

- nginx 模板：[deploy/nginx/codex-personal-proxy.http.conf.template](./deploy/nginx/codex-personal-proxy.http.conf.template)
- systemd 模板：[deploy/systemd/codex-personal-proxy.service.template](./deploy/systemd/codex-personal-proxy.service.template)
- Dockerfile：[Dockerfile](./Dockerfile)
- docker compose：[docker-compose.yml](./docker-compose.yml)
- 环境变量示例：[.env.example](./.env.example)
- docker 启动入口：[scripts/docker-entrypoint.sh](./scripts/docker-entrypoint.sh)
- smoke test：[scripts/smoke-test.sh](./scripts/smoke-test.sh)

## 验证清单

直连端口模式：

```bash
curl -sS http://127.0.0.1:3101/health
curl -sS http://127.0.0.1:3101/v1/models -H "Authorization: Bearer cx_your_key"
curl -sS http://127.0.0.1:3101/anthropic/v1/models \
  -H "x-api-key: cx_your_key" \
  -H "anthropic-version: 2023-06-01"
```

域名 + nginx 模式：

```bash
curl -sS https://YOUR_DOMAIN/codex-admin/health
curl -sS https://YOUR_DOMAIN/codex/v1/models -H "Authorization: Bearer cx_your_key"
curl -sS https://YOUR_DOMAIN/codex/anthropic/v1/models \
  -H "x-api-key: cx_your_key" \
  -H "anthropic-version: 2023-06-01"
```
