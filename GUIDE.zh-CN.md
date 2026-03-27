# codex-personal-proxy 保姆级部署指南

<p align="right">
  <a href="./README.md">English</a> |
  <a href="./README.zh-CN.md">简体中文</a> |
  <a href="./GUIDE.zh-CN.md">中文部署指南</a>
</p>

这份指南是给第一次接触这套仓库的人用的，目标是把整个流程讲清楚：

1. 服务器准备
2. 域名绑定
3. 安装启动
4. 导入本机 Codex 账号
5. 创建 API Key
6. 配置 Claude Code / Codex CLI
7. 常见问题排查

这份仓库的定位仍然不变：

- 只适合个人使用
- 一个账户
- 一台服务器
- 不适合做公共中转站或商业服务

## 0.1 管理员账号密码和 `cx_...` Key 的区别

这是最容易混淆的地方：

- 管理员账号密码：只给管理后台用
- `cx_...` API Key：只给客户端用

管理员账号密码用于：

- 登录后台
- 导入本机 `~/.codex/auth.json`
- 创建和删除 `cx_...` key
- 管理账户

Claude Code、Codex CLI、OpenAI SDK 这些客户端都不用管理员账号密码。

客户端只需要：

1. 正确的 URL
2. 一条 `cx_...` key

如果后面你想改管理员账号密码，可以直接执行：

```bash
./scripts/reset-admin.sh --username admin --password '你的新密码'
```

这个脚本会：

- 改写 `data/init.json`
- 更新 Redis 里的管理员凭据
- 清除旧的后台登录会话

## 0. 先理解两种使用方式

### 方式 A：无域名

适合：

- 你只是自己用
- 你不想折腾 DNS、证书、HTTPS
- 你可以接受用 SSH 隧道或内网访问

这种方式下，你访问的是：

- `http://127.0.0.1:3101/`
- `http://127.0.0.1:3101/v1`
- `http://127.0.0.1:3101/anthropic`

### 方式 B：有域名 + nginx

适合：

- 你希望它像一个“正常服务”一样可访问
- 你希望地址固定
- 你以后可能从多台自己的设备访问

这种方式下，你访问的是：

- `https://你的域名/codex-admin`
- `https://你的域名/codex/v1`
- `https://你的域名/codex/anthropic`

## 1. 服务器要求

建议环境：

- Ubuntu 22.04 / 24.04
- 1 核 2G 以上
- 能访问 GitHub / npm / OpenAI 相关域名

如果你用的是“AutoDL 类服务器”或其他受限网络 GPU 服务器，这里说的意思不是某一个品牌，而是：

- 对 `chatgpt.com`
- 对 `api.openai.com`
- 对相关上游域名

访问受限、容易超时、容易被风控或不稳定。

这种环境更建议：

1. 优先用 SSH 隧道私有访问
2. 如果你要公网访问，再配个人域名 + nginx
3. 如有需要，再额外配稳定出站代理

### 1.1 以腾讯云海外 CVM 为例

这里可以拿腾讯云海外 CVM 当一个具体例子来理解，但这不是腾讯云专属教程。大多数海外 VPS 都可以照着这个思路走。

建议配置：

- 优先地域：新加坡 / 东京 / 硅谷 / 法兰克福
- 香港：只作为备选，不作为默认推荐
- 系统：`Ubuntu 22.04 LTS`
- 规格：`1 核 2G` 起步就够

安全组建议：

- 只做 SSH 隧道：
  - 放行 `22`
- 做个人域名 + nginx：
  - 放行 `22`
  - 放行 `80`
  - 放行 `443`

不建议默认把 `3101` 直接开放到公网。

如果你只是自己在一台电脑上使用，最省事的路线是：

1. 买一台腾讯云海外 CVM
2. 只开 `22`
3. 按无域名方案安装
4. 用 SSH 隧道把远程 `3101` 映射回本地

如果你希望多台自己的设备稳定访问，再升级到：

1. 准备一个个人域名
2. 配 nginx
3. 配 HTTPS

## 2. 域名怎么绑定到现在这套系统

如果你要用域名，本质上是 4 步：

1. 买一个域名
2. 把域名解析到你的服务器公网 IP
3. 在服务器上让 nginx 监听这个域名
4. 再加 HTTPS 证书

### 第 1 步：准备一个域名

你可以用任意你控制的域名。

建议：

- 单独建一个二级域名，例如 `codex.example.com`
- 不要直接拿主站根域名乱改

### 第 2 步：DNS 解析

到你的域名 DNS 管理后台，添加一条 `A` 记录：

- 主机记录：`codex`
- 记录类型：`A`
- 记录值：你的服务器公网 IP

例如：

- `codex.example.com -> 123.123.123.123`

如果你用 Cloudflare，建议一开始先：

- 只做 DNS 解析
- 先关闭代理小云朵，使用 `DNS only`

先保证最基础的访问链路没问题，再考虑是否接入 Cloudflare 代理层。

### 第 3 步：确认域名已经生效

在你本机执行：

```bash
dig +short codex.example.com
```

或者：

```bash
nslookup codex.example.com
```

如果返回的是你的服务器公网 IP，说明 DNS 已经生效。

### 第 4 步：把域名接到当前系统

这套仓库里，域名绑定不是靠什么神秘配置文件，而是靠：

- `install.sh` 里的 `--domain`
- `install.sh` 里的 `--public-base-url`
- nginx 模板 [codex-personal-proxy.http.conf.template](./deploy/nginx/codex-personal-proxy.http.conf.template)

你直接运行：

```bash
./install.sh \
  --admin-user admin \
  --admin-password '改成你自己的密码' \
  --domain codex.example.com \
  --public-base-url https://codex.example.com \
  --with-nginx \
  --with-systemd
```

这会做几件事：

- 写入 `.env`
- 生成 `data/init.json`
- 把 nginx 配置安装到 `/etc/nginx/sites-available/`
- 建 systemd 服务

### 第 5 步：给域名加 HTTPS

当前仓库自带的 nginx 模板是 HTTP 版。

如果你要正式用公网域名，建议再执行：

```bash
sudo apt-get update
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d codex.example.com
```

按提示完成后，certbot 会帮你把站点切到 HTTPS。

完成后你应该访问的是：

- `https://codex.example.com/codex-admin`
- `https://codex.example.com/codex/v1`
- `https://codex.example.com/codex/anthropic`

## 3. 从零开始安装：无域名方案

如果你只是个人使用，最简单就是无域名：

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

看到 `healthy` 就说明服务起来了。

管理后台地址：

- `http://127.0.0.1:3101/`

## 4. 从零开始安装：Docker 方案

如果你不想碰 systemd 和 nginx，最简单的是 Docker：

```bash
cp .env.example .env
```

然后至少填这些：

- `HOST_PORT`
- `ENCRYPTION_SECRET`
- `CODEX_ADMIN_USERNAME`
- `CODEX_ADMIN_PASSWORD`

再启动：

```bash
docker compose up -d --build
```

验证：

```bash
docker compose ps
curl -sS http://127.0.0.1:3101/health
```

如果你本机 `3101` 被占用，就把 `.env` 里的 `HOST_PORT` 改成别的，比如 `3112`。

## 5. 启动后怎么导入账户

这套 public 仓库不再提供 OAuth 登录。

标准做法是：

1. 在你自己的本机先登录 Codex
2. 确保本机有 `~/.codex/auth.json`
3. 打开管理后台
4. 点击“从本机导入”

这个动作只会在导入时读取一次：

- `~/.codex/auth.json`

导入后，账户会保存到：

- Redis

token 会通过：

- `ENCRYPTION_SECRET`

进行加密存储。

如果你只是想确认“这条链路到底能不能真的给 Codex 用”，建议在创建完 `cx_...` key 后，再跑一次真实请求：

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

## 6. 导入后怎么创建 API Key

进入管理后台后：

1. 确认账户已经出现在账户列表
2. 点击“创建 API Key”
3. 复制生成的 `cx_...` key

这个 key 就是你之后给 Claude Code 或 Codex CLI 用的。

### 6.1 API Key 是在哪里生成的

不是在终端里手工拼出来，也不是在本机 `auth.json` 里直接拿。

生成方式只有一个：

1. 打开管理后台
2. 点“创建 API Key”
3. 系统生成一条 `cx_...`
4. 这条 key 只显示一次，立刻保存

### 6.2 URL 到底填哪个

很多人不是不会部署，而是搞不清楚“客户端里应该填哪个 URL”。

你只需要记这个表：

#### 如果你是直连端口模式

- 管理后台：`http://127.0.0.1:3101/`
- Claude Code：`http://127.0.0.1:3101/anthropic`
- OpenAI Responses / Codex CLI：`http://127.0.0.1:3101/v1`
- 旧版 `chat.completions`：`http://127.0.0.1:3101/compat/v1`

#### 如果你是域名 + nginx 模式

- 管理后台：`https://YOUR_DOMAIN/codex-admin`
- Claude Code：`https://YOUR_DOMAIN/codex/anthropic`
- OpenAI Responses / Codex CLI：`https://YOUR_DOMAIN/codex/v1`
- 旧版 `chat.completions`：`https://YOUR_DOMAIN/codex/compat/v1`

### 6.3 你最终要准备好的两样东西

客户端真正需要的只有两样：

1. 一个 URL
2. 一条 `cx_...` API Key

只要这两样是对的，客户端就能接上。

## 7. Claude Code 怎么接

### 无域名 / 直连端口

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3101/anthropic"
export ANTHROPIC_AUTH_TOKEN="cx_your_key"
export ANTHROPIC_MODEL="default"
npx @anthropic-ai/claude-code
```

### 域名 + nginx

```bash
export ANTHROPIC_BASE_URL="https://YOUR_DOMAIN/codex/anthropic"
export ANTHROPIC_AUTH_TOKEN="cx_your_key"
export ANTHROPIC_MODEL="default"
npx @anthropic-ai/claude-code
```

## 8. 在你自己的电脑上怎么用

### 8.1 Ubuntu / Debian / 其他 Linux

#### Claude Code

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3101/anthropic"
export ANTHROPIC_AUTH_TOKEN="cx_your_key"
export ANTHROPIC_MODEL="default"
npx @anthropic-ai/claude-code
```

#### OpenAI SDK / Responses

```bash
export OPENAI_BASE_URL="http://127.0.0.1:3101/v1"
export OPENAI_API_KEY="cx_your_key"
```

### 8.2 macOS

macOS 和 Linux 基本一样，也是 `export`：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3101/anthropic"
export ANTHROPIC_AUTH_TOKEN="cx_your_key"
export ANTHROPIC_MODEL="default"

export OPENAI_BASE_URL="http://127.0.0.1:3101/v1"
export OPENAI_API_KEY="cx_your_key"
```

如果你希望每次开终端都自动生效，可以写进：

- `~/.zshrc`
- 或 `~/.bashrc`

### 8.3 Windows PowerShell

#### Claude Code

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:3101/anthropic"
$env:ANTHROPIC_AUTH_TOKEN="cx_your_key"
$env:ANTHROPIC_MODEL="default"
npx @anthropic-ai/claude-code
```

#### OpenAI SDK / Responses

```powershell
$env:OPENAI_BASE_URL="http://127.0.0.1:3101/v1"
$env:OPENAI_API_KEY="cx_your_key"
```

### 8.4 如果你的服务跑在远程服务器

那你本地电脑上不要再填 `服务器公网 IP:3101` 当成唯一方案。

你有三种选择：

1. 用 SSH 隧道，把远程服务映射到本地 `127.0.0.1:3101`
2. 直接用你的个人域名地址
3. 在局域网内直接用内网 IP

如果你是个人使用，最推荐的是：

- SSH 隧道
- 或个人域名 + nginx

## 9. Codex CLI 怎么接

在你的 `~/.codex/config.toml` 里增加 provider：

```toml
[model_providers.personal_proxy]
name = "OpenAI"
base_url = "http://127.0.0.1:3101/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
requires_openai_auth = true
```

然后：

```bash
export OPENAI_API_KEY="cx_your_key"
```

如果你走域名模式，就把 `base_url` 改成：

```toml
base_url = "https://YOUR_DOMAIN/codex/v1"
```

### 9.1 一句话理解 Codex CLI 要填什么

你最终只要保证两件事：

1. `base_url` 指向你的 `/v1`
2. `OPENAI_API_KEY` 是你在管理后台里生成的 `cx_...`

## 10. 常见问题

### 1. 没有域名能不能用

可以。

最简单的方式就是：

- 直连端口
- 或 SSH 隧道

### 2. 为什么我建议个人域名 + nginx

因为长期来看它比“裸露一个随机端口”更稳定：

- 地址更固定
- 访问路径更清晰
- 以后加 HTTPS 更顺
- 从多台自己的设备访问更方便

### 3. 服务器上访问上游不稳定怎么办

这通常不是仓库本身的问题，而是服务器出站网络问题。

优先排查：

1. 服务器能否正常访问外网
2. 服务器能否访问 `api.openai.com`
3. 服务器能否访问 `chatgpt.com`
4. 是否需要单独的出站代理

### 4. Docker 起来了但端口冲突

改 `.env` 里的：

- `HOST_PORT`

例如改成：

```env
HOST_PORT=3112
```

然后重新：

```bash
docker compose up -d --build
```

### 5. 管理后台打不开

先看健康检查：

```bash
curl -sS http://127.0.0.1:3101/health
```

如果健康检查都不通，先别看前端，直接先查服务是否启动。

非 Docker：

```bash
./start.sh status
./start.sh logs
```

Docker：

```bash
docker compose ps
docker compose logs -f app
```

## 11. 你最可能真正需要的推荐方案

### 方案 A：最省事

- 本机或远程机安装
- 不配域名
- 只用 SSH 隧道
- 只给自己用

### 方案 B：长期稳定一点

- 注册一个便宜海外域名
- 一台自己的服务器
- nginx 反向代理
- certbot 上 HTTPS
- 只给自己用

如果你只是想把它变成一个“自己随时能访问的 Codex 服务”，通常我更推荐方案 B。
