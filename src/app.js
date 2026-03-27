/**
 * Codex Relay Service - 独立服务
 * 端口: 3101
 * 完全独立于 Claude Code 中继服务
 */

const express = require('express')
const http = require('http')
const cors = require('cors')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const zlib = require('zlib')
const querystring = require('querystring')
const { spawn } = require('child_process')

// 简单的日志工具
const logger = {
  info: (msg, data) => console.log(`[${new Date().toISOString()}] INFO: ${msg}`, data || ''),
  warn: (msg, data) => console.log(`[${new Date().toISOString()}] WARN: ${msg}`, data || ''),
  error: (msg, data) => console.error(`[${new Date().toISOString()}] ERROR: ${msg}`, data || ''),
  success: (msg, data) => console.log(`[${new Date().toISOString()}] SUCCESS: ${msg}`, data || '')
}

// Redis 连接
const redis = require('redis')
let redisClient = null

async function connectRedis() {
  redisClient = redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    legacyMode: false
  })

  redisClient.on('error', (err) => logger.error('Redis error:', err))
  redisClient.on('connect', () => logger.info('Redis connected'))

  await redisClient.connect()

  // 包装方法
  const wrappedClient = {
    hset: (key, obj) => redisClient.hSet(key, obj),
    hgetall: (key) => redisClient.hGetAll(key),
    sadd: (key, val) => redisClient.sAdd(key, val),
    smembers: (key) => redisClient.sMembers(key),
    srem: (key, val) => redisClient.sRem(key, val),
    del: (key) => redisClient.del(key),
    get: (key) => redisClient.get(key),
    set: (key, val, ...args) => redisClient.set(key, val, ...args),
    expire: (key, seconds) => redisClient.expire(key, seconds)
  }

  return wrappedClient
}

let wrappedRedisClient = null
const redisWrapper = {
  getClient: () => wrappedRedisClient
}
let wsUpgradeHandler = null

function writeUpgradeJson(socket, status, payload) {
  if (!socket || socket.destroyed) return
  const statusText = {
    400: 'Bad Request',
    401: 'Unauthorized',
    404: 'Not Found',
    405: 'Method Not Allowed',
    426: 'Upgrade Required',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable'
  }[status] || 'Error'
  const body = JSON.stringify(payload || { error: 'Upgrade failed', status })

  try {
    socket.write(
      `HTTP/1.1 ${status} ${statusText}\r\n` +
      'Content-Type: application/json; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n' +
      '\r\n' +
      body
    )
  } catch {
    // ignore socket write failures
  }

  try {
    socket.destroy()
  } catch {
    // ignore destroy failures
  }
}

function isWebSocketUpgradeRequest(req) {
  return /websocket/i.test(String(req?.headers?.upgrade || ''))
}

function isResponsesWebSocketPath(url) {
  try {
    const pathname = new URL(String(url || ''), 'http://localhost').pathname
    return pathname === '/v1/responses'
  } catch {
    return false
  }
}

function getAdminInitFileCandidates() {
  const candidates = []
  const addCandidate = (filePath) => {
    const normalized = String(filePath || '').trim()
    if (!normalized || candidates.includes(normalized)) return
    candidates.push(normalized)
  }

  addCandidate(process.env.CODEX_ADMIN_INIT_FILE)
  addCandidate(path.join(__dirname, '..', 'data', 'init.json'))

  return candidates
}

function loadAdminCredentialsFromEnv() {
  const username = String(process.env.CODEX_ADMIN_USERNAME || '').trim()
  const passwordHash = String(process.env.CODEX_ADMIN_PASSWORD_HASH || '').trim()
  if (!username || !passwordHash) return null

  return {
    source: 'environment variables',
    credentials: {
      username,
      passwordHash,
      createdAt: new Date().toISOString(),
      lastLogin: '',
      updatedAt: ''
    }
  }
}

function loadAdminCredentialsFromInitFile() {
  for (const initFilePath of getAdminInitFileCandidates()) {
    if (!fs.existsSync(initFilePath)) continue

    try {
      const initData = JSON.parse(fs.readFileSync(initFilePath, 'utf8'))
      if (!initData.adminUsername || !initData.passwordHash) {
        logger.warn(`Admin init file is missing required fields: ${initFilePath}`)
        continue
      }

      return {
        source: initFilePath,
        credentials: {
          username: initData.adminUsername,
          passwordHash: initData.passwordHash,
          createdAt: initData.initializedAt || new Date().toISOString(),
          lastLogin: '',
          updatedAt: initData.updatedAt || ''
        }
      }
    } catch (error) {
      logger.error(`Failed to parse admin init file: ${initFilePath}`, error.message)
    }
  }

  return null
}

async function ensureAdminCredentials() {
  const client = redisWrapper.getClient()
  if (!client) {
    throw new Error('Redis client is not ready')
  }

  const adminData = await client.hgetall('session:admin_credentials')
  if (adminData && adminData.username && adminData.passwordHash) {
    return adminData
  }

  const loaded = loadAdminCredentialsFromEnv() || loadAdminCredentialsFromInitFile()
  if (!loaded) {
    return null
  }

  await client.hset('session:admin_credentials', loaded.credentials)
  logger.success(`Admin credentials loaded into Redis from ${loaded.source}`)
  return loaded.credentials
}

// 创建 Express 应用
const app = express()
const PORT = process.env.CODEX_PORT || 3101
const BODY_LIMIT_BYTES = 50 * 1024 * 1024

// 中间件
app.use(cors({ origin: true, credentials: true }))

// Codex 客户端可能发送 zstd 压缩请求体，Express 4 的 body-parser 默认不支持。
async function decompressZstdBuffer(compressedBuffer) {
  if (typeof zlib.zstdDecompressSync === 'function') {
    return zlib.zstdDecompressSync(compressedBuffer)
  }

  return new Promise((resolve, reject) => {
    const zstd = spawn('zstd', ['-d', '-q', '-c'])
    const outChunks = []
    const errChunks = []
    let outSize = 0
    let settled = false

    const done = (err, value) => {
      if (settled) return
      settled = true
      if (err) return reject(err)
      return resolve(value)
    }

    zstd.stdout.on('data', (chunk) => {
      outSize += chunk.length
      if (outSize > BODY_LIMIT_BYTES) {
        zstd.kill('SIGKILL')
        return done(new Error('Decoded body exceeds 50MB limit'))
      }
      outChunks.push(chunk)
    })

    zstd.stderr.on('data', (chunk) => errChunks.push(chunk))
    zstd.on('error', (err) => done(err))
    zstd.on('close', (code) => {
      if (code !== 0) {
        const stderrText = Buffer.concat(errChunks).toString('utf8').trim()
        return done(new Error(`zstd exited with code ${code}${stderrText ? `: ${stderrText}` : ''}`))
      }
      return done(null, Buffer.concat(outChunks))
    })

    zstd.stdin.on('error', (err) => done(err))
    zstd.stdin.end(compressedBuffer)
  })
}

function decodeZstdBody(req, res, next) {
  const contentEncoding = String(req.headers['content-encoding'] || '').toLowerCase().trim()
  if (contentEncoding !== 'zstd' && contentEncoding !== 'zstandard') {
    return next()
  }

  const method = (req.method || 'GET').toUpperCase()
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    delete req.headers['content-encoding']
    return next()
  }

  const chunks = []
  let compressedSize = 0
  let finished = false

  const fail = (status, error, message) => {
    if (finished) return
    finished = true
    return res.status(status).json({ error, message })
  }

  req.on('data', (chunk) => {
    if (finished) return
    compressedSize += chunk.length
    if (compressedSize > BODY_LIMIT_BYTES) {
      req.destroy()
      return fail(413, 'Payload Too Large', 'Request body exceeds 50MB limit')
    }
    chunks.push(chunk)
  })

  req.on('error', (err) => {
    logger.error('Read zstd request body failed:', err.message)
    return fail(400, 'Bad Request', 'Invalid compressed request body')
  })

  req.on('end', async () => {
    if (finished) return
    try {
      const compressed = Buffer.concat(chunks)
      const decoded = await decompressZstdBuffer(compressed)
      const contentType = String(req.headers['content-type'] || '').toLowerCase()
      const text = decoded.toString('utf8')

      if (!contentType || contentType.includes('application/json')) {
        req.body = text ? JSON.parse(text) : {}
      } else if (contentType.includes('application/x-www-form-urlencoded')) {
        req.body = querystring.parse(text)
      } else {
        return fail(
          415,
          'Unsupported Media Type',
          `Unsupported Content-Type for zstd payload: ${req.headers['content-type'] || 'unknown'}`
        )
      }

      req._body = true
      delete req.headers['content-encoding']
      req.headers['content-length'] = String(decoded.length)
      finished = true
      return next()
    } catch (err) {
      logger.warn('Decode zstd request body failed:', err.message)
      return fail(400, 'Bad Request', 'Invalid zstd-compressed request body')
    }
  })
}

app.use(decodeZstdBody)
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))

const cookieParser = require('cookie-parser')
app.use(cookieParser())

// 请求日志
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`)
  next()
})

// ==================== API Key 认证（给 Codex CLI / 外部调用用） ====================

function extractBearerToken(req) {
  const auth = req.headers.authorization || ''
  const match = auth.match(/^Bearer\s+(.+)$/i)
  if (match) return match[1].trim()
  return (req.headers['x-api-key'] || req.query?.api_key || '').toString().trim()
}

function createAuthenticateApiKey(apiKeyService) {
  return async (req, res, next) => {
    try {
      const token = extractBearerToken(req)
      if (!token) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Missing API key' })
      }

      const keyData = await apiKeyService.validateApiKey(token)
      if (!keyData) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Invalid API key' })
      }

      req.apiKey = keyData
      await apiKeyService.recordUsage(keyData.id)
      next()
    } catch (error) {
      logger.error('API key auth error:', error.message)
      res.status(500).json({ error: 'Auth error' })
    }
  }
}

// 健康检查（不需要认证）
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'codex-relay',
    port: PORT,
    timestamp: new Date().toISOString()
  })
})

// ==================== 认证系统 ====================

// 生成 token
function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

// bcrypt 简单实现（复用 Claude 的凭证需要验证 bcrypt hash）
const bcrypt = require('bcryptjs')

// 登录 API
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body

    if (!username || !password) {
      return res.status(400).json({ success: false, message: '请输入用户名和密码' })
    }

    if (!redisWrapper.getClient()) {
      return res.status(503).json({ success: false, message: '服务暂时不可用' })
    }

    // 获取管理员凭证（必要时从 init.json 自动恢复）
    const adminData = await ensureAdminCredentials()

    if (!adminData || !adminData.username || !adminData.passwordHash) {
      logger.error('Admin credentials not found in Redis')
      return res.status(500).json({ success: false, message: '系统配置错误' })
    }

    // 验证用户名和密码
    const isValidUsername = adminData.username === username
    const isValidPassword = await bcrypt.compare(password, adminData.passwordHash)

    if (!isValidUsername || !isValidPassword) {
      logger.warn(`Failed login attempt for: ${username}`)
      return res.status(401).json({ success: false, message: '用户名或密码错误' })
    }

    // 生成会话 token
    const token = generateToken()
    const client = redisWrapper.getClient()
    const sessionData = {
      username: adminData.username,
      loginTime: new Date().toISOString(),
      lastActivity: new Date().toISOString()
    }

    // 存储会话（使用 Codex 独立的 session key）
    const sessionKey = `codex:session:${token}`
    await client.hset(sessionKey, sessionData)
    await client.expire(sessionKey, 86400) // 24小时过期

    // 设置 cookie
    res.cookie('codexToken', token, {
      httpOnly: true,
      secure: false, // 如果使用 HTTPS 设为 true
      maxAge: 24 * 60 * 60 * 1000, // 24小时
      sameSite: 'lax'
    })

    logger.success(`Login successful: ${username}`)
    res.json({ success: true, message: '登录成功', username: adminData.username })

  } catch (error) {
    logger.error('Login error:', error.message)
    res.status(500).json({ success: false, message: '登录失败' })
  }
})

// 登出 API
app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = req.cookies?.codexToken
    if (token) {
      const client = redisWrapper.getClient()
      if (client) {
        await client.del(`codex:session:${token}`)
      }
    }
    res.clearCookie('codexToken')
    res.json({ success: true, message: '已登出' })
  } catch (error) {
    res.json({ success: true, message: '已登出' })
  }
})

// 检查登录状态 API
app.get('/api/auth/check', async (req, res) => {
  try {
    const token = req.cookies?.codexToken
    if (!token) {
      return res.json({ authenticated: false })
    }

    const client = redisWrapper.getClient()
    if (!client) {
      return res.json({ authenticated: false })
    }

    const sessionData = await client.hgetall(`codex:session:${token}`)
    if (!sessionData || Object.keys(sessionData).length === 0) {
      res.clearCookie('codexToken')
      return res.json({ authenticated: false })
    }

    // 更新最后活动时间
    await client.hset(`codex:session:${token}`, { lastActivity: new Date().toISOString() })

    res.json({ authenticated: true, username: sessionData.username })
  } catch (error) {
    res.json({ authenticated: false })
  }
})

// 认证中间件
const authenticateAdmin = async (req, res, next) => {
  try {
    // OAuth 回调使用 state 关联 session，不强依赖管理员 cookie（避免 SameSite/跨站跳转导致 cookie 丢失）
    if (req.method === 'GET' && (req.originalUrl || '').startsWith('/api/oauth/callback')) {
      return next()
    }

    const token = req.cookies?.codexToken

    if (!token) {
      logger.warn('Unauthorized request: missing codexToken cookie')
      res.clearCookie('codexToken')
      return res.status(401).json({ success: false, error: 'Unauthorized', message: '请先登录' })
    }

    const client = redisWrapper.getClient()
    if (!client) {
      return res.status(503).json({ error: 'Service unavailable' })
    }

    const sessionKey = `codex:session:${token}`
    const sessionData = await client.hgetall(sessionKey)

    if (!sessionData || Object.keys(sessionData).length === 0) {
      logger.warn('Invalid session: missing Redis session, clearing cookie')
      res.clearCookie('codexToken')
      return res.status(401).json({ success: false, error: 'Invalid session', message: '会话已过期，请重新登录' })
    }

    // 更新最后活动时间
    await client.hset(sessionKey, { lastActivity: new Date().toISOString() })

    req.adminSession = sessionData
    next()
  } catch (error) {
    logger.error('Auth error:', error.message)
    return res.status(500).json({ error: 'Auth error' })
  }
}

// ==================== 静态文件 ====================

const webPath = path.join(__dirname, '..', 'web')

// 登录页面
app.get('/login', (req, res) => {
  res.sendFile(path.join(webPath, 'login.html'))
})

// 主页面（需要检查登录，但由前端处理跳转）
if (fs.existsSync(webPath)) {
  app.use('/', express.static(webPath, { index: 'index.html' }))
  logger.info('Codex Admin UI mounted at /')
}

// ==================== API 路由 ====================

async function setupRoutes() {
  const codexAccountService = require('./services/codexAccountService')
  const codexRelayService = require('./services/codexRelayService')
  const apiKeyService = require('./services/apiKeyService')

  codexAccountService.init && codexAccountService.init(redisWrapper, logger)
  codexRelayService.init && codexRelayService.init(redisWrapper, logger)
  apiKeyService.init && apiKeyService.init(redisWrapper, logger)

  // 公开 API（使用 API Key 鉴权，给 Codex CLI / 外部调用）
  const authenticateApiKey = createAuthenticateApiKey(apiKeyService)
  // 兼容路由：仅给 claude-adapter 使用，不影响现有 /v1/* 行为
  app.post('/compat/v1/chat/completions', authenticateApiKey, async (req, res) => {
    await codexRelayService.relayChatCompletionsCompat(req, res)
  })
  // 兼容路由：Anthropic 风格接口（给 Claude Code 直连使用）
  app.get('/compat/anthropic/v1/models', authenticateApiKey, async (req, res) => {
    await codexRelayService.relayAnthropicModelsCompat(req, res)
  })
  app.post('/compat/anthropic/v1/messages/count_tokens', authenticateApiKey, async (req, res) => {
    await codexRelayService.relayAnthropicCountTokensCompat(req, res)
  })
  app.post('/compat/anthropic/v1/messages', authenticateApiKey, async (req, res) => {
    await codexRelayService.relayAnthropicMessagesCompat(req, res)
  })
  app.all('/v1/*', authenticateApiKey, async (req, res) => {
    await codexRelayService.relayRequest(req, res)
  })
  app.all('/backend-api/*', authenticateApiKey, async (req, res) => {
    await codexRelayService.relayChatGPTBackend(req, res)
  })
  app.post('/oauth/token', authenticateApiKey, async (req, res) => {
    await codexRelayService.proxyOAuthToken(req, res)
  })

  wsUpgradeHandler = async (req, socket, head) => {
    if (!isWebSocketUpgradeRequest(req)) {
      return writeUpgradeJson(socket, 426, { error: 'WebSocket upgrade required', status: 426 })
    }

    if (!isResponsesWebSocketPath(req.url)) {
      return writeUpgradeJson(socket, 404, { error: 'Not found', status: 404 })
    }

    try {
      const token = extractBearerToken(req)
      if (!token) {
        return writeUpgradeJson(socket, 401, { error: 'Unauthorized', message: 'Missing API key' })
      }

      const keyData = await apiKeyService.validateApiKey(token)
      if (!keyData) {
        return writeUpgradeJson(socket, 401, { error: 'Unauthorized', message: 'Invalid API key' })
      }

      req.apiKey = keyData
      await apiKeyService.recordUsage(keyData.id)
      await codexRelayService.handleResponsesWebSocketUpgrade(req, socket, head)
    } catch (error) {
      logger.error('WebSocket upgrade auth error:', error.message)
      writeUpgradeJson(socket, 500, { error: 'Upgrade failed', message: error.message, status: 500 })
    }
  }

  // API 路由（需要认证）
  const codexRoutes = require('./routes/codexRoutes')
  app.use('/api', authenticateAdmin, codexRoutes)

  // 统一将 body-parser 等错误转为 JSON，避免返回默认 HTML 错误页
  app.use((err, req, res, next) => {
    if (!err) return next()

    if (err.type === 'encoding.unsupported' || err.status === 415) {
      const encoding = req.headers['content-encoding'] || err.encoding || 'unknown'
      logger.warn(`Unsupported media encoding: ${encoding}`)
      return res.status(415).json({
        error: 'Unsupported Media Type',
        message: `Unsupported content encoding "${encoding}"`
      })
    }

    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid JSON payload'
      })
    }

    return next(err)
  })
}

// ==================== 启动服务 ====================

async function start() {
  try {
    logger.info('Starting Codex Relay Service...')
    if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
      logger.info(`Proxy enabled: ${process.env.HTTPS_PROXY || process.env.HTTP_PROXY}`)
    } else {
      logger.warn('Proxy not set (HTTP_PROXY/HTTPS_PROXY), outbound OAuth may be blocked')
    }

    wrappedRedisClient = await connectRedis()
    logger.success('Redis connected successfully')

    await ensureAdminCredentials()
    logger.success('Admin credentials ready')

    await setupRoutes()
    logger.success('Routes configured')

    const server = http.createServer(app)

    server.on('upgrade', async (req, socket, head) => {
      if (!wsUpgradeHandler) {
        return writeUpgradeJson(socket, 503, { error: 'WebSocket handler unavailable', status: 503 })
      }
      await wsUpgradeHandler(req, socket, head)
    })

    server.listen(PORT, '0.0.0.0', () => {
      logger.success(`Codex Relay Service started on port ${PORT}`)
      logger.info(`Admin UI: http://localhost:${PORT}/`)
      logger.info(`Login: http://localhost:${PORT}/login`)
      logger.info(`API: http://localhost:${PORT}/api/`)
      logger.info(`Health: http://localhost:${PORT}/health`)
    })

  } catch (error) {
    logger.error('Failed to start service:', error)
    process.exit(1)
  }
}

// 优雅关闭
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down...')
  if (redisClient) {
    await redisClient.quit()
  }
  process.exit(0)
})

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down...')
  if (redisClient) {
    await redisClient.quit()
  }
  process.exit(0)
})

start()
