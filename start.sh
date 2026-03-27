#!/bin/bash

set -euo pipefail

cd "$(dirname "$0")"

if [ -f .env ]; then
    set -a
    . ./.env
    set +a
fi

SERVICE_NAME="codex-personal-proxy"
PID_FILE="codex-relay.pid"
LOG_FILE="logs/service.log"
PORT="${CODEX_PORT:-${PORT:-3101}}"
CODEX_PUBLIC_DOMAIN="${CODEX_PUBLIC_DOMAIN:-}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
CODEX_PROXY_URL="${CODEX_PROXY_URL:-}"
AUTO_START_REDIS="${AUTO_START_REDIS:-1}"

# 选择 Node 运行时（可通过 NODE_BIN 显式覆盖）
resolve_node_bin() {
    if [ -n "${NODE_BIN:-}" ] && [ -x "${NODE_BIN}" ]; then
        echo "${NODE_BIN}"
        return
    fi

    if [ -x "$HOME/.nvm/versions/node/v22.16.0/bin/node" ]; then
        echo "$HOME/.nvm/versions/node/v22.16.0/bin/node"
        return
    fi

    if command -v node >/dev/null 2>&1; then
        command -v node
        return
    fi

    echo "/usr/bin/node"
}

NODE_BIN="$(resolve_node_bin)"
NODE_DIR="$(dirname "$NODE_BIN")"
if [ -x "$NODE_DIR/npm" ]; then
    NPM_BIN="$NODE_DIR/npm"
else
    NPM_BIN="$(command -v npm)"
fi
NODE_VERSION="$("$NODE_BIN" -v 2>/dev/null || echo unknown)"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}🤖 Codex Personal Proxy 管理脚本${NC}"
echo "================================"
echo "🧩 Node: ${NODE_BIN} (${NODE_VERSION})"

# 通过 pid 文件和监听端口双重判断
find_listener_pid() {
    if command -v lsof >/dev/null 2>&1; then
        lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true
        return
    fi
    echo ""
}

check_running() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            return 0
        fi
        rm -f "$PID_FILE"
    fi
    LISTENER_PID="$(find_listener_pid)"
    if [ -n "$LISTENER_PID" ]; then
        echo "$LISTENER_PID" > "$PID_FILE"
        return 0
    fi
    return 1
}

# 启动服务
start() {
    if check_running; then
        echo -e "${YELLOW}⚠️  服务已在运行中 (PID: $(cat $PID_FILE))${NC}"
        return 1
    fi

    echo -e "${GREEN}🚀 启动 Codex Relay Service...${NC}"

    # 确保日志目录存在
    mkdir -p logs

    # 尝试确保 Redis 已启动（若无 sudo 权限可忽略）
    if [ "$AUTO_START_REDIS" = "1" ] && command -v systemctl >/dev/null 2>&1; then
        echo "🔌 检查 Redis..."
        if ! systemctl is-active --quiet redis-server 2>/dev/null; then
            echo "   启动 Redis..."
            sudo systemctl start redis-server 2>/dev/null || true
        fi
    fi

    # 安装依赖（如果需要）
    if [ ! -d "node_modules" ]; then
        echo "📦 安装依赖..."
        "$NPM_BIN" install
    fi

    if [ ! -f "data/init.json" ] && [ -z "${CODEX_ADMIN_PASSWORD_HASH:-}" ]; then
        echo -e "${YELLOW}⚠️  未发现 data/init.json 或 CODEX_ADMIN_PASSWORD_HASH。请先运行 ./install.sh 初始化管理员凭据。${NC}"
    fi

    if [ -z "${ENCRYPTION_SECRET:-}" ]; then
        echo -e "${RED}❌ ENCRYPTION_SECRET 未配置。请先运行 ./install.sh 或在 .env 中设置。${NC}"
        return 1
    fi

    # 仅在显式配置时启用代理，避免默认耦合到特定机器环境
    if [ -n "$CODEX_PROXY_URL" ]; then
        export HTTPS_PROXY="${HTTPS_PROXY:-$CODEX_PROXY_URL}"
        export HTTP_PROXY="${HTTP_PROXY:-$CODEX_PROXY_URL}"
    fi

    # 服务器回调模式建议使用 HTTPS 域名；未配置时仍可使用 loopback 模式 OAuth
    if [ -z "${CODEX_OAUTH_REDIRECT_URI:-}" ]; then
        if [ -n "$PUBLIC_BASE_URL" ]; then
            export CODEX_OAUTH_REDIRECT_URI="${PUBLIC_BASE_URL%/}/codex/oauth/callback"
        elif [ -n "$CODEX_PUBLIC_DOMAIN" ]; then
            export CODEX_OAUTH_REDIRECT_URI="https://${CODEX_PUBLIC_DOMAIN}/codex/oauth/callback"
        fi
    fi

    # 确保使用选定 Node 运行时（避免 systemd/non-login shell 落到旧版本 /usr/bin/node）
    nohup "$NODE_BIN" src/app.js > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"

    sleep 2

    if check_running; then
        echo -e "${GREEN}✅ 服务启动成功 (PID: $(cat $PID_FILE))${NC}"
        echo -e "   📊 管理界面: http://localhost:$PORT/"
        echo -e "   📘 使用说明: http://localhost:$PORT/docs/claude-codex-usage.html"
        echo -e "   🔗 OpenAI Responses: http://localhost:$PORT/v1"
        echo -e "   🤖 Claude Code: http://localhost:$PORT/anthropic"
        echo -e "   🏥 健康检查: http://localhost:$PORT/health"
    else
        echo -e "${RED}❌ 服务启动失败，请检查日志: $LOG_FILE${NC}"
        return 1
    fi
}

# 停止服务
stop() {
    if ! check_running; then
        echo -e "${YELLOW}⚠️  服务未运行${NC}"
        return 0
    fi

    PID=$(cat "$PID_FILE")
    echo -e "${YELLOW}🛑 停止服务 (PID: $PID)...${NC}"

    kill "$PID" 2>/dev/null
    sleep 2

    if ps -p "$PID" > /dev/null 2>&1; then
        echo -e "${YELLOW}⚠️  强制停止...${NC}"
        kill -9 "$PID" 2>/dev/null
    fi

    LISTENER_PID="$(find_listener_pid)"
    if [ -n "$LISTENER_PID" ] && [ "$LISTENER_PID" != "$PID" ]; then
        kill "$LISTENER_PID" 2>/dev/null || true
    fi

    rm -f "$PID_FILE"
    echo -e "${GREEN}✅ 服务已停止${NC}"
}

# 重启服务
restart() {
    echo -e "${GREEN}🔄 重启服务...${NC}"
    stop
    sleep 1
    start
}

# 状态检查
status() {
    if check_running; then
        PID=$(cat "$PID_FILE")
        echo -e "${GREEN}✅ 服务运行中 (PID: $PID)${NC}"

        # 检查健康状态
        if curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then
            echo -e "   ${GREEN}🏥 健康检查: OK${NC}"
        else
            echo -e "   ${RED}🏥 健康检查: FAILED${NC}"
        fi
    else
        echo -e "${RED}❌ 服务未运行${NC}"
    fi
}

# 查看日志
logs() {
    if [ -f "$LOG_FILE" ]; then
        tail -f "$LOG_FILE"
    else
        echo -e "${YELLOW}⚠️  日志文件不存在${NC}"
    fi
}

# 主入口
case "$1" in
    start)
        start
        ;;
    stop)
        stop
        ;;
    restart)
        restart
        ;;
    status)
        status
        ;;
    logs)
        logs
        ;;
    *)
        echo "用法: $0 {start|stop|restart|status|logs}"
        echo ""
        echo "命令说明:"
        echo "  start   - 启动服务"
        echo "  stop    - 停止服务"
        echo "  restart - 重启服务"
        echo "  status  - 查看状态"
        echo "  logs    - 查看日志"
        exit 1
        ;;
esac
