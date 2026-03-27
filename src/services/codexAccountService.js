/**
 * Codex Account Service - 独立版本
 * 管理 OpenAI Codex CLI 的 OAuth 认证
 */

const { v4: uuidv4 } = require('uuid')
const crypto = require('crypto')
const axios = require('axios')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { getProxyAgent } = require('../utils/proxyAgent')

// 将由 app.js 注入
let redis = null
let logger = console

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 简单的 LRU Cache 实现
class SimpleLRUCache {
  constructor(maxSize = 100) {
    this.cache = new Map()
    this.maxSize = maxSize
  }
  get(key) {
    if (!this.cache.has(key)) return null
    const value = this.cache.get(key)
    this.cache.delete(key)
    this.cache.set(key, value)
    return value
  }
  set(key, value) {
    if (this.cache.has(key)) this.cache.delete(key)
    else if (this.cache.size >= this.maxSize) {
      this.cache.delete(this.cache.keys().next().value)
    }
    this.cache.set(key, value)
  }
  cleanup() { /* no-op for simple version */ }
  getStats() { return { size: this.cache.size } }
}

class CodexAccountService {
  constructor() {
    // OpenAI OAuth 配置
    this.OPENAI_AUTH_URL = 'https://auth.openai.com'
    // 默认对齐 Codex CLI（可通过环境变量覆盖）
    this.OPENAI_CLIENT_ID = process.env.CODEX_OAUTH_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann'
    this.OPENAI_AUDIENCE = 'https://api.openai.com/v1'

    this.codexAuthUrl = 'https://auth.openai.com/oauth/token'
    // Codex CLI 的设备码流程使用 /deviceauth/* + /codex/device（而非标准 OAuth 的 /oauth/device/code）
    this.codexDeviceUserCodeUrl = 'https://auth.openai.com/deviceauth/usercode'
    this.codexDeviceTokenUrl = 'https://auth.openai.com/deviceauth/token'
    this.codexVerificationUrl = 'https://auth.openai.com/codex/device'
    // 兼容：部分环境/旧实现可能仍可用标准 OAuth device code 端点
    this.codexOauthDeviceAuthUrl = 'https://auth.openai.com/oauth/device/code'
    this.codexApiUrl = 'https://api.openai.com/v1/responses'
    this.chatgptBackendUrl = 'https://chatgpt.com/backend-api'

    this.ENCRYPTION_ALGORITHM = 'aes-256-cbc'
    this.ENCRYPTION_SALT = 'codex-relay-salt'
    this.REDIS_PREFIX = 'codex:account:'
    this.REDIS_LIST_KEY = 'codex:accounts'
    this.OAUTH_SESSION_PREFIX = 'codex:oauth_session:'
    this.DEFAULT_ACCOUNT_COOLDOWN_SECONDS = Number.parseInt(
      process.env.CODEX_ACCOUNT_COOLDOWN_SECONDS || '',
      10
    ) || 3600

    this._encryptionKeyCache = null
    this._decryptCache = new SimpleLRUCache(200)
  }

  _extractClientIdFromJwtPayload(payload) {
    if (!payload || typeof payload !== 'object') return ''
    if (typeof payload.client_id === 'string' && payload.client_id) return payload.client_id
    if (Array.isArray(payload.aud)) {
      const aud = payload.aud.find((a) => typeof a === 'string' && a.startsWith('app_'))
      if (aud) return aud
    }
    if (typeof payload.aud === 'string' && payload.aud.startsWith('app_')) return payload.aud
    return ''
  }

  _extractChatGPTAccountIdFromJwtPayload(payload) {
    if (!payload || typeof payload !== 'object') return ''
    const auth = payload['https://api.openai.com/auth']
    if (auth && typeof auth === 'object' && typeof auth.chatgpt_account_id === 'string') {
      return auth.chatgpt_account_id
    }
    return ''
  }

  _toBase64Url(buffer) {
    if (!buffer) return ''
    return Buffer.from(buffer)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
  }

  _generateCodeVerifier() {
    return this._toBase64Url(crypto.randomBytes(32))
  }

  _generateCodeChallenge(codeVerifier) {
    return this._toBase64Url(crypto.createHash('sha256').update(String(codeVerifier || ''), 'utf8').digest())
  }

  async _postOAuthForm(url, formData, { timeoutMs = 15000 } = {}) {
    const body = new URLSearchParams()
    for (const [key, value] of Object.entries(formData || {})) {
      if (value === undefined || value === null) continue
      body.set(key, String(value))
    }

    let response
    try {
      const proxyAgent = getProxyAgent(url)
      response = await axios.post(url, body, {
        timeout: timeoutMs,
        maxRedirects: 0,
        proxy: false,
        httpAgent: proxyAgent || undefined,
        httpsAgent: proxyAgent || undefined,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'User-Agent': 'codex-cli/1.0'
        },
        validateStatus: (status) => status >= 200 && status < 400
      })
    } catch (error) {
      if (error?.response) {
        const status = error.response.status
        const location = error.response.headers?.location
        const rawData = error.response.data
        const dataPreview =
          typeof rawData === 'string'
            ? rawData.replace(/\s+/g, ' ').slice(0, 180)
            : JSON.stringify(rawData).slice(0, 180)

        const cloudflareHint =
          status === 403 && typeof rawData === 'string' && /Just a moment|cloudflare/i.test(rawData)
            ? ' (可能被 Cloudflare 拦截：请更换出口 IP/使用代理/VPN)'
            : ''

        error.message =
          `OAuth request failed: HTTP ${status}${location ? ` redirect=${location}` : ''}${cloudflareHint}; body=${dataPreview}`
      }
      throw error
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.location || ''
      throw new Error(`Unexpected redirect (${response.status}) ${location ? `to ${location}` : ''}`.trim())
    }

    return response
  }

  async _postJson(url, jsonBody, { timeoutMs = 15000 } = {}) {
    let response
    try {
      const proxyAgent = getProxyAgent(url)
      response = await axios.post(url, jsonBody, {
        timeout: timeoutMs,
        maxRedirects: 0,
        proxy: false,
        httpAgent: proxyAgent || undefined,
        httpsAgent: proxyAgent || undefined,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'codex-cli/1.0'
        },
        validateStatus: (status) => status >= 200 && status < 400
      })
    } catch (error) {
      if (error?.response) {
        const status = error.response.status
        const location = error.response.headers?.location
        const rawData = error.response.data
        const dataPreview =
          typeof rawData === 'string'
            ? rawData.replace(/\s+/g, ' ').slice(0, 180)
            : JSON.stringify(rawData).slice(0, 180)

        const cloudflareHint =
          status === 403 && typeof rawData === 'string' && /Just a moment|cloudflare/i.test(rawData)
            ? ' (可能被 Cloudflare 拦截：请更换出口 IP/使用代理/VPN)'
            : ''

        error.message =
          `OAuth request failed: HTTP ${status}${location ? ` redirect=${location}` : ''}${cloudflareHint}; body=${dataPreview}`
      }
      throw error
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.location || ''
      throw new Error(`Unexpected redirect (${response.status}) ${location ? `to ${location}` : ''}`.trim())
    }

    return response
  }

  async _postJsonOrForm(url, payload, opts) {
    try {
      return await this._postJson(url, payload, opts)
    } catch (jsonError) {
      try {
        return await this._postOAuthForm(url, payload, opts)
      } catch (formError) {
        // 选择更具体的错误（优先带 response 的）
        if (formError?.response) throw formError
        if (jsonError?.response) throw jsonError
        throw formError
      }
    }
  }

  _decodeJwtPayload(token) {
    if (!token || typeof token !== 'string') return null
    const parts = token.split('.')
    if (parts.length < 2) return null
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    try {
      const json = Buffer.from(padded, 'base64').toString('utf8')
      return JSON.parse(json)
    } catch {
      return null
    }
  }

  _extractPlanTypeFromJwtPayload(payload) {
    if (!payload || typeof payload !== 'object') return ''
    const auth = payload['https://api.openai.com/auth']
    if (auth && typeof auth === 'object' && typeof auth.chatgpt_plan_type === 'string') {
      return auth.chatgpt_plan_type
    }
    return ''
  }

  _toInt(value) {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : 0
  }

  _formatDatePart(date) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  _getUsageWindowMeta(nowInput = new Date()) {
    const now = new Date(nowInput)

    const dayResetAt = new Date(now)
    dayResetAt.setHours(24, 0, 0, 0)

    const weekStart = new Date(now)
    const dayOfWeek = weekStart.getDay()
    const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1
    weekStart.setDate(weekStart.getDate() - diffToMonday)
    weekStart.setHours(0, 0, 0, 0)

    const weekResetAt = new Date(weekStart)
    weekResetAt.setDate(weekResetAt.getDate() + 7)

    const monthResetAt = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0)

    return {
      dayKey: this._formatDatePart(now),
      weekKey: this._formatDatePart(weekStart),
      monthKey: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
      dayResetAt: dayResetAt.toISOString(),
      weekResetAt: weekResetAt.toISOString(),
      monthResetAt: monthResetAt.toISOString()
    }
  }

  _applyUsageWindows(existing, metrics, nowInput = new Date()) {
    const meta = this._getUsageWindowMeta(nowInput)
    const inputTokens = this._toInt(metrics.inputTokens)
    const outputTokens = this._toInt(metrics.outputTokens)
    const totalTokens = this._toInt(metrics.totalTokens || (inputTokens + outputTokens))

    const updateWindow = (prefix, bucketKey, resetAt) => {
      const bucketField = `${prefix}Bucket`
      const requestsField = `${prefix}Requests`
      const tokensField = `${prefix}Tokens`
      const inputField = `${prefix}InputTokens`
      const outputField = `${prefix}OutputTokens`
      const currentBucket = String(existing[bucketField] || '')
      const sameBucket = currentBucket === bucketKey

      return {
        [bucketField]: bucketKey,
        [requestsField]: String((sameBucket ? this._toInt(existing[requestsField]) : 0) + 1),
        [tokensField]: String((sameBucket ? this._toInt(existing[tokensField]) : 0) + totalTokens),
        [inputField]: String((sameBucket ? this._toInt(existing[inputField]) : 0) + inputTokens),
        [outputField]: String((sameBucket ? this._toInt(existing[outputField]) : 0) + outputTokens),
        [`${prefix}ResetAt`]: resetAt
      }
    }

    return {
      ...updateWindow('daily', meta.dayKey, meta.dayResetAt),
      ...updateWindow('weekly', meta.weekKey, meta.weekResetAt),
      ...updateWindow('monthly', meta.monthKey, meta.monthResetAt)
    }
  }

  /**
   * 从本机 Codex CLI 的 auth.json 导入 token
   * 默认读取: ~/.codex/auth.json
   */
  async importFromLocalCodexAuthFile({
    filePath,
    name,
    description,
    priority = 50,
    accountType = 'shared',
    poolType
  } = {}) {
    const resolvedPath =
      filePath ||
      process.env.CODEX_AUTH_FILE ||
      path.join(os.homedir(), '.codex', 'auth.json')

    let raw
    try {
      raw = fs.readFileSync(resolvedPath, 'utf8')
    } catch (error) {
      throw new Error(`Failed to read ${resolvedPath}: ${error.message}`)
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`Invalid JSON in ${resolvedPath}: ${error.message}`)
    }

    const tokens = parsed?.tokens || {}
    const accessToken = tokens.access_token || ''
    const refreshToken = tokens.refresh_token || ''
    const chatgptAccountId = tokens.account_id || ''

    if (!accessToken) {
      throw new Error(`No access_token found in ${resolvedPath}`)
    }

    const planType =
      this._extractPlanTypeFromJwtPayload(this._decodeJwtPayload(tokens.id_token)) ||
      this._extractPlanTypeFromJwtPayload(this._decodeJwtPayload(accessToken)) ||
      ''

    const derivedChatGPTAccountId =
      this._extractChatGPTAccountIdFromJwtPayload(this._decodeJwtPayload(tokens.id_token)) ||
      this._extractChatGPTAccountIdFromJwtPayload(this._decodeJwtPayload(accessToken)) ||
      chatgptAccountId ||
      ''

    const oauthClientId =
      this._extractClientIdFromJwtPayload(this._decodeJwtPayload(accessToken)) ||
      this._extractClientIdFromJwtPayload(this._decodeJwtPayload(tokens.id_token)) ||
      ''

    const accountName =
      name ||
      `${planType ? `Codex (${planType})` : 'Codex (imported)'}${chatgptAccountId ? ` ${chatgptAccountId.slice(0, 8)}` : ''}`

    const account = await this.createAccount({
      name: accountName,
      description: description || `Imported from ${resolvedPath}`,
      accessToken,
      refreshToken,
      chatgptAccountId: derivedChatGPTAccountId,
      planType,
      oauthClientId,
      priority,
      accountType,
      poolType
    })

    return { importedFrom: resolvedPath, account }
  }

  // 初始化（由 app.js 调用）
  init(redisWrapper, loggerInstance) {
    redis = redisWrapper
    logger = loggerInstance || console
    logger.info('CodexAccountService initialized')
  }

  // ==================== 加密工具 ====================

  _getEncryptionKey() {
    if (this._encryptionKeyCache) return this._encryptionKeyCache
    const secret = String(process.env.ENCRYPTION_SECRET || '').trim()
    if (!secret) {
      throw new Error('ENCRYPTION_SECRET is required. Run ./install.sh or set it in .env before starting the service.')
    }
    this._encryptionKeyCache = crypto.scryptSync(secret, this.ENCRYPTION_SALT, 32)
    return this._encryptionKeyCache
  }

  _encrypt(text) {
    if (!text) return ''
    try {
      const iv = crypto.randomBytes(16)
      const key = this._getEncryptionKey()
      const cipher = crypto.createCipheriv(this.ENCRYPTION_ALGORITHM, key, iv)
      let encrypted = cipher.update(text, 'utf8', 'hex')
      encrypted += cipher.final('hex')
      return iv.toString('hex') + ':' + encrypted
    } catch (error) {
      logger.error('Encryption failed:', error.message)
      return ''
    }
  }

  _decrypt(encryptedText) {
    if (!encryptedText || !encryptedText.includes(':')) return encryptedText

    const cached = this._decryptCache.get(encryptedText)
    if (cached) return cached

    try {
      const [ivHex, encrypted] = encryptedText.split(':')
      const iv = Buffer.from(ivHex, 'hex')
      const key = this._getEncryptionKey()
      const decipher = crypto.createDecipheriv(this.ENCRYPTION_ALGORITHM, key, iv)
      let decrypted = decipher.update(encrypted, 'hex', 'utf8')
      decrypted += decipher.final('utf8')
      this._decryptCache.set(encryptedText, decrypted)
      return decrypted
    } catch (error) {
      logger.error('Decryption failed:', error.message)
      return encryptedText
    }
  }

  // ==================== 账户管理 ====================

  _normalizeAccountType(accountType, legacyPoolType = '') {
    const normalized = String(accountType || '').trim().toLowerCase()
    if (normalized === 'dedicated' || normalized === 'private') return 'dedicated'
    if (normalized === 'shared' || normalized === 'public') return 'shared'

    const legacy = String(legacyPoolType || '').trim().toLowerCase()
    if (legacy === 'private') return 'dedicated'
    return 'shared'
  }

  _toLegacyPoolType(accountType) {
    return this._normalizeAccountType(accountType) === 'dedicated' ? 'private' : 'public'
  }

  _isSchedulable(schedulable) {
    if (schedulable === undefined || schedulable === null || schedulable === '') {
      return true
    }
    return schedulable !== false && schedulable !== 'false'
  }

  _restoreAccountStatus(accountData) {
    return accountData.accessToken ? 'active' : 'created'
  }

  _getRateLimitRemainingMs(accountData) {
    if (!accountData || accountData.rateLimitStatus !== 'limited' || !accountData.rateLimitEndAt) {
      return 0
    }

    const endAtMs = new Date(accountData.rateLimitEndAt).getTime()
    if (!Number.isFinite(endAtMs)) return 0
    return Math.max(0, endAtMs - Date.now())
  }

  async _recoverExpiredRateLimit(accountId, accountData) {
    if (!accountData || accountData.rateLimitStatus !== 'limited') {
      return accountData
    }

    const remainingMs = this._getRateLimitRemainingMs(accountData)
    if (remainingMs > 0) {
      return accountData
    }

    const restoredStatus = this._restoreAccountStatus(accountData)
    const updateData = {
      status: restoredStatus,
      rateLimitStatus: '',
      rateLimitedAt: '',
      rateLimitEndAt: '',
      lastError: '',
      updatedAt: new Date().toISOString()
    }

    const client = redis.getClient()
    await client.hset(this.REDIS_PREFIX + accountId, updateData)

    logger.info(`Recovered Codex account from cooldown: ${accountId}`)
    return {
      ...accountData,
      ...updateData
    }
  }

  async _repairRateLimitFromLastError(accountId, accountData) {
    if (!accountData || accountData.rateLimitStatus !== 'limited' || !accountData.lastError) {
      return accountData
    }

    let payload = accountData.lastError
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload)
      } catch {
        return accountData
      }
    }

    if (!payload || typeof payload !== 'object') return accountData
    const errorPayload = payload.error && typeof payload.error === 'object' ? payload.error : payload
    const now = Date.now()

    let resetAtMs = 0
    const resetsAtRaw = errorPayload.resets_at ?? errorPayload.reset_at ?? errorPayload.resetAt
    if (resetsAtRaw !== undefined && resetsAtRaw !== null && resetsAtRaw !== '') {
      const numeric = Number.parseFloat(String(resetsAtRaw))
      if (Number.isFinite(numeric) && numeric > 0) {
        if (numeric > 1e12) resetAtMs = numeric
        else if (numeric > 1e9) resetAtMs = numeric * 1000
        else resetAtMs = now + Math.ceil(numeric) * 1000
      } else {
        resetAtMs = Date.parse(String(resetsAtRaw))
      }
    }

    if ((!Number.isFinite(resetAtMs) || resetAtMs <= now) && errorPayload.resets_in_seconds !== undefined) {
      const seconds = Number.parseFloat(String(errorPayload.resets_in_seconds))
      if (Number.isFinite(seconds) && seconds > 0) {
        resetAtMs = now + Math.ceil(seconds) * 1000
      }
    }

    if (!Number.isFinite(resetAtMs) || resetAtMs <= now) {
      return accountData
    }

    const currentResetAtMs = Date.parse(accountData.rateLimitEndAt || '')
    if (Number.isFinite(currentResetAtMs) && currentResetAtMs >= resetAtMs) {
      return accountData
    }

    const repaired = {
      ...accountData,
      rateLimitEndAt: new Date(resetAtMs).toISOString()
    }

    try {
      const client = redis.getClient()
      await client.hset(this.REDIS_PREFIX + accountId, { rateLimitEndAt: repaired.rateLimitEndAt })
    } catch {
      // ignore persistence failures
    }

    return repaired
  }

  async markAccountRateLimited(accountId, { resetAt = null, cooldownSeconds = null, reason = '' } = {}) {
    const client = redis.getClient()
    const accountData = await client.hgetall(this.REDIS_PREFIX + accountId)

    if (!accountData || Object.keys(accountData).length === 0) {
      throw new Error('Account not found')
    }

    const now = Date.now()
    const requestedResetAtMs = resetAt ? new Date(resetAt).getTime() : NaN
    const normalizedCooldownSeconds = Number.isFinite(cooldownSeconds) && cooldownSeconds > 0
      ? Math.ceil(cooldownSeconds)
      : this.DEFAULT_ACCOUNT_COOLDOWN_SECONDS
    const endAtMs = Number.isFinite(requestedResetAtMs) && requestedResetAtMs > now
      ? requestedResetAtMs
      : now + normalizedCooldownSeconds * 1000
    const endAtIso = new Date(endAtMs).toISOString()

    await client.hset(this.REDIS_PREFIX + accountId, {
      status: 'rate_limited',
      rateLimitStatus: 'limited',
      rateLimitedAt: new Date(now).toISOString(),
      rateLimitEndAt: endAtIso,
      lastError: reason || 'Account temporarily unavailable (429)',
      updatedAt: new Date().toISOString()
    })

    logger.warn(`Codex account marked rate limited: ${accountId}`, {
      rateLimitEndAt: endAtIso,
      reason: reason || 'Account temporarily unavailable (429)'
    })

    return {
      success: true,
      rateLimitEndAt: endAtIso
    }
  }

  async removeAccountRateLimit(accountId) {
    const client = redis.getClient()
    const accountData = await client.hgetall(this.REDIS_PREFIX + accountId)

    if (!accountData || Object.keys(accountData).length === 0) {
      throw new Error('Account not found')
    }

    await client.hset(this.REDIS_PREFIX + accountId, {
      status: this._restoreAccountStatus(accountData),
      rateLimitStatus: '',
      rateLimitedAt: '',
      rateLimitEndAt: '',
      lastError: '',
      updatedAt: new Date().toISOString()
    })

    logger.info(`Removed Codex account rate limit: ${accountId}`)
    return { success: true }
  }

  async resetAccountStatus(accountId) {
    const client = redis.getClient()
    const accountData = await client.hgetall(this.REDIS_PREFIX + accountId)

    if (!accountData || Object.keys(accountData).length === 0) {
      throw new Error('Account not found')
    }

    const updateData = {
      status: this._restoreAccountStatus(accountData),
      schedulable: 'true',
      rateLimitStatus: '',
      rateLimitedAt: '',
      rateLimitEndAt: '',
      lastError: '',
      updatedAt: new Date().toISOString()
    }

    await client.hset(this.REDIS_PREFIX + accountId, updateData)
    logger.info(`Reset Codex account status: ${accountId}`)
    return { success: true }
  }

  async createAccount({
    name,
    description,
    accessToken,
    refreshToken,
    chatgptAccountId,
    planType,
    oauthClientId,
    priority = 50,
    accountType = 'shared',
    poolType
  }) {
    const accountId = uuidv4()
    const now = new Date().toISOString()
    const normalizedAccountType = this._normalizeAccountType(accountType, poolType)

    const derivedClientId =
      oauthClientId ||
      this._extractClientIdFromJwtPayload(this._decodeJwtPayload(accessToken)) ||
      ''

    const accountData = {
      id: accountId,
      name: name || 'Codex Account',
      description: description || '',
      accessToken: this._encrypt(accessToken || ''),
      refreshToken: this._encrypt(refreshToken || ''),
      chatgptAccountId: chatgptAccountId || '',
      planType: planType || '',
      oauthClientId: derivedClientId,
      priority: String(priority),
      accountType: normalizedAccountType,
      poolType: this._toLegacyPoolType(normalizedAccountType),
      status: 'created',
      schedulable: 'true',
      rateLimitStatus: '',
      rateLimitedAt: '',
      rateLimitEndAt: '',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: '',
      totalRequests: '0',
      totalTokens: '0',
      totalInputTokens: '0',
      totalOutputTokens: '0',
      dailyBucket: '',
      dailyRequests: '0',
      dailyTokens: '0',
      dailyInputTokens: '0',
      dailyOutputTokens: '0',
      dailyResetAt: '',
      weeklyBucket: '',
      weeklyRequests: '0',
      weeklyTokens: '0',
      weeklyInputTokens: '0',
      weeklyOutputTokens: '0',
      weeklyResetAt: '',
      monthlyBucket: '',
      monthlyRequests: '0',
      monthlyTokens: '0',
      monthlyInputTokens: '0',
      monthlyOutputTokens: '0',
      monthlyResetAt: '',
      lastRequestAt: '',
      quotaRemainingRequests: '',
      quotaLimitRequests: '',
      quotaRemainingTokens: '',
      quotaLimitTokens: '',
      quotaResetAt: '',
      quotaObservedAt: '',
      quotaSource: '',
      lastError: ''
    }

    const client = redis.getClient()
    await client.hset(this.REDIS_PREFIX + accountId, accountData)
    await client.sadd(this.REDIS_LIST_KEY, accountId)

    logger.success(`Created Codex account: ${name} (${accountId})`)

    return {
      id: accountId,
      name,
      status: accountData.status,
      planType,
      accountType: accountData.accountType,
      poolType: accountData.poolType,
      createdAt: now
    }
  }

  async getAccount(accountId) {
    const client = redis.getClient()
    let accountData = await client.hgetall(this.REDIS_PREFIX + accountId)

    if (!accountData || Object.keys(accountData).length === 0) {
      return null
    }

    accountData = await this._repairRateLimitFromLastError(accountId, accountData)
    accountData = await this._recoverExpiredRateLimit(accountId, accountData)
    return this._formatAccountForResponse(accountData)
  }

  async getAllAccounts() {
    const client = redis.getClient()
    const accountIds = await client.smembers(this.REDIS_LIST_KEY)

    const accounts = []
    for (const accountId of accountIds) {
      const account = await this.getAccount(accountId)
      if (account) {
        accounts.push(account)
      }
    }

    return accounts
  }

  async getAvailableAccount({
    preferredAccountId = '',
    excludeAccountIds = [],
    excludeChatgptAccountIds = []
  } = {}) {
    const accounts = await this.getAllAccounts()
    const isAvailable = (acc) => (acc.status === 'active' || acc.status === 'created') && acc.rateLimitStatus !== 'limited'
    const isSharedPool = (acc) => this._normalizeAccountType(acc.accountType, acc.poolType) === 'shared'
    const preferredId = String(preferredAccountId || '').trim()
    const excludedAccountIds = new Set((Array.isArray(excludeAccountIds) ? excludeAccountIds : []).map((id) => String(id || '').trim()).filter(Boolean))
    const excludedChatgptAccountIds = new Set((Array.isArray(excludeChatgptAccountIds) ? excludeChatgptAccountIds : []).map((id) => String(id || '').trim()).filter(Boolean))

    if (preferredId) {
      const bound = accounts.find((acc) => acc.id === preferredId)
      if (!bound) return null
      return isAvailable(bound) && this._isSchedulable(bound.schedulable) ? bound : null
    }

    const available = accounts
      .filter((acc) => {
        if (!isAvailable(acc) || !isSharedPool(acc)) return false
        if (!this._isSchedulable(acc.schedulable)) return false
        if (excludedAccountIds.has(acc.id)) return false
        if (acc.chatgptAccountId && excludedChatgptAccountIds.has(acc.chatgptAccountId)) return false
        return true
      })
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority
        const aLastUsed = new Date(a.lastUsedAt || 0).getTime()
        const bLastUsed = new Date(b.lastUsedAt || 0).getTime()
        return aLastUsed - bLastUsed
      })

    return available[0] || null
  }

  async updateAccount(accountId, updates) {
    const client = redis.getClient()
    const existingData = await client.hgetall(this.REDIS_PREFIX + accountId)

    if (!existingData || Object.keys(existingData).length === 0) {
      throw new Error('Account not found')
    }

    const updateData = { updatedAt: new Date().toISOString() }

    if (updates.name !== undefined) updateData.name = updates.name
    if (updates.description !== undefined) updateData.description = updates.description
    if (updates.accessToken) updateData.accessToken = this._encrypt(updates.accessToken)
    if (updates.refreshToken) updateData.refreshToken = this._encrypt(updates.refreshToken)
    if (updates.chatgptAccountId !== undefined) updateData.chatgptAccountId = updates.chatgptAccountId
    if (updates.planType !== undefined) updateData.planType = updates.planType
    if (updates.priority !== undefined) updateData.priority = String(updates.priority)
    if (updates.schedulable !== undefined) updateData.schedulable = this._isSchedulable(updates.schedulable) ? 'true' : 'false'
    if (updates.accountType !== undefined || updates.poolType !== undefined) {
      const normalizedAccountType = this._normalizeAccountType(updates.accountType, updates.poolType)
      updateData.accountType = normalizedAccountType
      updateData.poolType = this._toLegacyPoolType(normalizedAccountType)
    }
    if (updates.status !== undefined) updateData.status = updates.status

    await client.hset(this.REDIS_PREFIX + accountId, updateData)
    logger.info(`Updated Codex account: ${accountId}`)
  }

  async deleteAccount(accountId) {
    const client = redis.getClient()
    await client.del(this.REDIS_PREFIX + accountId)
    await client.srem(this.REDIS_LIST_KEY, accountId)
    logger.info(`Deleted Codex account: ${accountId}`)
  }

  async refreshToken(accountId) {
    const client = redis.getClient()
    const accountKey = this.REDIS_PREFIX + accountId
    const lockKey = `${accountKey}:refresh_lock`
    const lockValue = crypto.randomUUID()
    const lockTtlMs = 30000

    const snapshot = await client.hgetall(accountKey)

    if (!snapshot || Object.keys(snapshot).length === 0) {
      throw new Error('Account not found')
    }

    // 防止并发 refresh（refresh_token 轮换时可能导致 "already used" 并把账号打成 error）
    const acquired = await client.set(lockKey, lockValue, { NX: true, PX: lockTtlMs })
    if (!acquired) {
      const start = Date.now()
      const deadline = start + 12000
      const baselineUpdatedAt = snapshot.updatedAt || ''

      while (Date.now() < deadline) {
        await delay(500)
        const current = await client.hgetall(accountKey)
        if (!current || Object.keys(current).length === 0) break
        const currentUpdatedAt = current.updatedAt || ''
        if (currentUpdatedAt && currentUpdatedAt !== baselineUpdatedAt) {
          if ((current.status || '') === 'active') return { success: true, waited: true }
          if ((current.status || '') === 'error') {
            throw new Error(current.lastError || 'Token refresh failed')
          }
          // 其他状态继续等待
        }
      }

      throw new Error('Token refresh already in progress')
    }

    let accountData = snapshot
    try {
      // 获取最新账号数据（避免拿到并发更新前的 refresh token）
      accountData = await client.hgetall(accountKey)
      if (!accountData || Object.keys(accountData).length === 0) {
        throw new Error('Account not found')
      }

      const refreshToken = this._decrypt(accountData.refreshToken)
      if (!refreshToken) {
        throw new Error('No refresh token available')
      }

      const oauthClientId = accountData.oauthClientId || this.OPENAI_CLIENT_ID

      const response = await this._postOAuthForm(this.codexAuthUrl, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: oauthClientId
      })

      const { access_token, refresh_token: newRefreshToken } = response.data
      const decodedAccessToken = this._decodeJwtPayload(access_token)
      const refreshedPlanType = this._extractPlanTypeFromJwtPayload(decodedAccessToken)
      const refreshedChatgptAccountId = this._extractChatGPTAccountIdFromJwtPayload(decodedAccessToken)
      const refreshedOauthClientId = this._extractClientIdFromJwtPayload(decodedAccessToken)

      const updates = {
        accessToken: this._encrypt(access_token),
        status: 'active',
        lastError: '',
        updatedAt: new Date().toISOString()
      }

      if (refreshedPlanType) {
        updates.planType = refreshedPlanType
      }

      if (refreshedChatgptAccountId) {
        updates.chatgptAccountId = refreshedChatgptAccountId
      }

      if (refreshedOauthClientId) {
        updates.oauthClientId = refreshedOauthClientId
      }

      if (newRefreshToken) {
        updates.refreshToken = this._encrypt(newRefreshToken)
      }

      await client.hset(accountKey, updates)
      logger.success(`Refreshed token for account: ${accountId}`)

      return { success: true }
    } catch (error) {
      // 兼容并发：如果另一个请求已经刷新成功（token 被轮换），避免把账号错误标记为 error
      try {
        const latest = await client.hgetall(accountKey)
        const accessTokenChanged =
          latest &&
          latest.accessToken &&
          accountData &&
          latest.accessToken !== accountData.accessToken &&
          (latest.status || '') === 'active'

        if (accessTokenChanged) {
          return { success: true, concurrent: true }
        }
      } catch {
        // ignore, fallback to marking error
      }

      await client.hset(accountKey, {
        status: 'error',
        lastError: error.message,
        updatedAt: new Date().toISOString()
      })
      throw error
    } finally {
      try {
        const currentLock = await client.get(lockKey)
        if (currentLock === lockValue) {
          await client.del(lockKey)
        }
      } catch {
        // ignore
      }
    }
  }

  async recordUsage(accountId, metrics = {}) {
    const client = redis.getClient()
    const accountData = await client.hgetall(this.REDIS_PREFIX + accountId)

    if (accountData) {
      const inputTokens = this._toInt(metrics.inputTokens)
      const outputTokens = this._toInt(metrics.outputTokens)
      const totalTokens = this._toInt(metrics.totalTokens || (inputTokens + outputTokens))
      const totalRequests = this._toInt(accountData.totalRequests) + 1

      await client.hset(this.REDIS_PREFIX + accountId, {
        totalRequests: String(totalRequests),
        totalTokens: String(this._toInt(accountData.totalTokens) + totalTokens),
        totalInputTokens: String(this._toInt(accountData.totalInputTokens) + inputTokens),
        totalOutputTokens: String(this._toInt(accountData.totalOutputTokens) + outputTokens),
        ...this._applyUsageWindows(accountData, metrics),
        lastRequestAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
        status: 'active',
        rateLimitStatus: '',
        rateLimitedAt: '',
        rateLimitEndAt: '',
        lastError: ''
      })
    }
  }

  async updateQuotaSnapshot(accountId, snapshot = {}) {
    if (!accountId || !snapshot || typeof snapshot !== 'object') return

    const updateData = { quotaObservedAt: new Date().toISOString() }
    let hasMeaningfulUpdate = false

    if (snapshot.remainingRequests !== undefined && snapshot.remainingRequests !== null) {
      updateData.quotaRemainingRequests = String(snapshot.remainingRequests)
      hasMeaningfulUpdate = true
    }
    if (snapshot.limitRequests !== undefined && snapshot.limitRequests !== null) {
      updateData.quotaLimitRequests = String(snapshot.limitRequests)
      hasMeaningfulUpdate = true
    }
    if (snapshot.remainingTokens !== undefined && snapshot.remainingTokens !== null) {
      updateData.quotaRemainingTokens = String(snapshot.remainingTokens)
      hasMeaningfulUpdate = true
    }
    if (snapshot.limitTokens !== undefined && snapshot.limitTokens !== null) {
      updateData.quotaLimitTokens = String(snapshot.limitTokens)
      hasMeaningfulUpdate = true
    }
    if (snapshot.resetAt) {
      updateData.quotaResetAt = String(snapshot.resetAt)
      hasMeaningfulUpdate = true
    }
    if (snapshot.source) {
      updateData.quotaSource = String(snapshot.source)
      hasMeaningfulUpdate = true
    }

    if (!hasMeaningfulUpdate) return

    const client = redis.getClient()
    await client.hset(this.REDIS_PREFIX + accountId, updateData)
  }

  async getDecryptedToken(accountId) {
    const client = redis.getClient()
    const accountData = await client.hgetall(this.REDIS_PREFIX + accountId)

    if (!accountData || !accountData.accessToken) {
      return null
    }

    return this._decrypt(accountData.accessToken)
  }

  async getStats() {
    const accounts = await this.getAllAccounts()
    return {
      total: accounts.length,
      active: accounts.filter(a => a.status === 'active').length,
      error: accounts.filter(a => a.status === 'error').length,
      temporarilyUnavailable: accounts.filter(a => a.rateLimitStatus === 'limited').length
    }
  }

  _formatAccountForResponse(accountData) {
    const accountType = this._normalizeAccountType(accountData.accountType, accountData.poolType)
    const cooldownRemainingSeconds = Math.ceil(this._getRateLimitRemainingMs(accountData) / 1000)
    const isRateLimited = accountData.rateLimitStatus === 'limited' && cooldownRemainingSeconds > 0
    const parseNullableInt = (value) => (value === undefined || value === null || value === '' ? null : this._toInt(value))
    return {
      id: accountData.id,
      name: accountData.name,
      description: accountData.description || '',
      chatgptAccountId: accountData.chatgptAccountId || '',
      planType: accountData.planType || '',
      accountType,
      poolType: this._toLegacyPoolType(accountType),
      priority: parseInt(accountData.priority || '50'),
      status: isRateLimited ? 'rate_limited' : (accountData.status || 'created'),
      schedulable: this._isSchedulable(accountData.schedulable),
      rateLimitStatus: isRateLimited ? 'limited' : '',
      rateLimitedAt: accountData.rateLimitedAt || null,
      rateLimitEndAt: isRateLimited ? accountData.rateLimitEndAt : null,
      cooldownRemainingSeconds: isRateLimited ? cooldownRemainingSeconds : 0,
      lastError: accountData.lastError || '',
      createdAt: accountData.createdAt,
      updatedAt: accountData.updatedAt,
      lastUsedAt: accountData.lastUsedAt || null,
      usageStats: {
        totalRequests: this._toInt(accountData.totalRequests),
        totalTokens: this._toInt(accountData.totalTokens),
        totalInputTokens: this._toInt(accountData.totalInputTokens),
        totalOutputTokens: this._toInt(accountData.totalOutputTokens),
        lastRequestAt: accountData.lastRequestAt || null,
        daily: {
          requests: this._toInt(accountData.dailyRequests),
          tokens: this._toInt(accountData.dailyTokens),
          inputTokens: this._toInt(accountData.dailyInputTokens),
          outputTokens: this._toInt(accountData.dailyOutputTokens),
          resetAt: accountData.dailyResetAt || null
        },
        weekly: {
          requests: this._toInt(accountData.weeklyRequests),
          tokens: this._toInt(accountData.weeklyTokens),
          inputTokens: this._toInt(accountData.weeklyInputTokens),
          outputTokens: this._toInt(accountData.weeklyOutputTokens),
          resetAt: accountData.weeklyResetAt || null
        },
        monthly: {
          requests: this._toInt(accountData.monthlyRequests),
          tokens: this._toInt(accountData.monthlyTokens),
          inputTokens: this._toInt(accountData.monthlyInputTokens),
          outputTokens: this._toInt(accountData.monthlyOutputTokens),
          resetAt: accountData.monthlyResetAt || null
        }
      },
      quotaInfo: {
        remainingRequests: parseNullableInt(accountData.quotaRemainingRequests),
        limitRequests: parseNullableInt(accountData.quotaLimitRequests),
        remainingTokens: parseNullableInt(accountData.quotaRemainingTokens),
        limitTokens: parseNullableInt(accountData.quotaLimitTokens),
        resetAt: accountData.quotaResetAt || null,
        observedAt: accountData.quotaObservedAt || null,
        source: accountData.quotaSource || ''
      }
    }
  }

  // ==================== OAuth Device Flow ====================

  /**
   * 启动 OAuth Device Authorization Flow
   * 返回 device_code, user_code, verification_uri 等
   */
  async startDeviceAuthorization() {
    const sessionId = crypto.randomUUID()
    const now = new Date()
    const client = redis.getClient()

    const payload = {
      client_id: this.OPENAI_CLIENT_ID,
      scope: 'openid profile email offline_access',
      audience: this.OPENAI_AUDIENCE
    }

    const attempts = []

    // 1) 优先：Codex CLI 的 deviceauth 流程
    try {
      const response = await this._postJsonOrForm(this.codexDeviceUserCodeUrl, payload, { timeoutMs: 15000 })
      const data = response.data || {}

      const deviceAuthId = data.device_auth_id || data.deviceAuthId || ''
      const userCode = data.user_code || data.userCode || ''
      const expiresIn = Number(data.expires_in || data.expiresIn || 900)
      const interval = Number(data.interval || 5)

      const verificationUri =
        data.verification_uri ||
        data.verificationUri ||
        this.codexVerificationUrl

      const verificationUriComplete =
        data.verification_uri_complete ||
        data.verificationUriComplete ||
        (userCode ? `${this.codexVerificationUrl}?user_code=${encodeURIComponent(userCode)}` : this.codexVerificationUrl)

      if (!deviceAuthId || !userCode) {
        throw new Error(`Unexpected deviceauth response: ${JSON.stringify(Object.keys(data)).slice(0, 180)}`)
      }

      const sessionData = {
        flow: 'deviceauth',
        deviceAuthId,
        deviceCode: '',
        userCode,
        verificationUri,
        verificationUriComplete,
        expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
        interval: String(interval || 5),
        status: 'pending',
        createdAt: now.toISOString()
      }

      await client.hset(this.OAUTH_SESSION_PREFIX + sessionId, sessionData)
      await client.expire(this.OAUTH_SESSION_PREFIX + sessionId, expiresIn)

      logger.info(`Started OAuth device flow (deviceauth), session: ${sessionId}, user_code: ${userCode}`)

      return {
        sessionId,
        userCode,
        verificationUri,
        verificationUriComplete,
        expiresIn,
        interval: interval || 5
      }
    } catch (error) {
      attempts.push(`deviceauth: ${error.message}`)
    }

    // 2) 兼容：标准 OAuth device code 流程
    try {
      const response = await this._postOAuthForm(this.codexOauthDeviceAuthUrl, payload, { timeoutMs: 15000 })
      const data = response.data || {}

      const deviceCode = data.device_code || ''
      const userCode = data.user_code || ''
      const verificationUri = data.verification_uri || this.codexVerificationUrl
      const verificationUriComplete = data.verification_uri_complete || ''
      const expiresIn = Number(data.expires_in || 900)
      const interval = Number(data.interval || 5)

      if (!deviceCode || !userCode) {
        throw new Error(`Unexpected oauth/device/code response: ${JSON.stringify(Object.keys(data)).slice(0, 180)}`)
      }

      const sessionData = {
        flow: 'oauth_device_code',
        deviceAuthId: '',
        deviceCode,
        userCode,
        verificationUri,
        verificationUriComplete,
        expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
        interval: String(interval || 5),
        status: 'pending',
        createdAt: now.toISOString()
      }

      await client.hset(this.OAUTH_SESSION_PREFIX + sessionId, sessionData)
      await client.expire(this.OAUTH_SESSION_PREFIX + sessionId, expiresIn)

      logger.info(`Started OAuth device flow (oauth/device/code), session: ${sessionId}, user_code: ${userCode}`)

      return {
        sessionId,
        userCode,
        verificationUri,
        verificationUriComplete,
        expiresIn,
        interval: interval || 5
      }
    } catch (error) {
      attempts.push(`oauth/device/code: ${error.message}`)
      logger.error('Failed to start device authorization:', attempts.join(' | '))
      throw new Error(`Failed to start device authorization: ${attempts.join(' | ')}`)
    }
  }

  /**
   * 轮询检查用户是否已完成授权
   */
  async pollDeviceAuthorization(sessionId) {
    const client = redis.getClient()
    const sessionData = await client.hgetall(this.OAUTH_SESSION_PREFIX + sessionId)

    if (!sessionData || Object.keys(sessionData).length === 0) {
      throw new Error('OAuth session not found or expired')
    }

    // 检查是否已过期
    if (new Date() > new Date(sessionData.expiresAt)) {
      await client.del(this.OAUTH_SESSION_PREFIX + sessionId)
      throw new Error('OAuth session expired')
    }

    // 检查是否已经获取到 token
    if (sessionData.status === 'completed') {
      return {
        status: 'completed',
        accessToken: sessionData.accessToken ? this._decrypt(sessionData.accessToken) : null,
        refreshToken: sessionData.refreshToken ? this._decrypt(sessionData.refreshToken) : null
      }
    }

    try {
      let response
      const flow = sessionData.flow || 'oauth_device_code'

      if (flow === 'deviceauth') {
        response = await this._postJsonOrForm(this.codexDeviceTokenUrl, {
          device_auth_id: sessionData.deviceAuthId,
          client_id: this.OPENAI_CLIENT_ID
        }, { timeoutMs: 15000 })
      } else {
        response = await this._postOAuthForm(this.codexAuthUrl, {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: sessionData.deviceCode,
          client_id: this.OPENAI_CLIENT_ID
        }, { timeoutMs: 15000 })
      }

      // 授权成功
      const { access_token, refresh_token, expires_in } = response.data || {}
      if (!access_token) {
        throw new Error(`Token response missing access_token (flow=${flow})`)
      }

      // 更新 session 状态
      await client.hset(this.OAUTH_SESSION_PREFIX + sessionId, {
        status: 'completed',
        accessToken: this._encrypt(access_token),
        refreshToken: refresh_token ? this._encrypt(refresh_token) : '',
        tokenExpiresAt: new Date(Date.now() + expires_in * 1000).toISOString()
      })

      logger.success(`OAuth device flow completed for session: ${sessionId}`)

      return {
        status: 'completed',
        accessToken: access_token,
        refreshToken: refresh_token || null,
        expiresIn: expires_in
      }
    } catch (error) {
      // 处理特定错误
      const errorCode =
        error?.response?.data?.error ||
        error?.response?.data?.code ||
        error?.response?.data?.status ||
        ''

      if (errorCode === 'authorization_pending') {
        return { status: 'pending', message: '等待用户授权...' }
      }
      if (errorCode === 'slow_down') {
        return { status: 'slow_down', message: '请求过于频繁，请稍后重试' }
      }
      if (errorCode === 'expired_token' || errorCode === 'expired') {
        await client.del(this.OAUTH_SESSION_PREFIX + sessionId)
        return { status: 'expired', message: '授权已过期，请重新开始' }
      }
      if (errorCode === 'access_denied' || errorCode === 'denied') {
        await client.del(this.OAUTH_SESSION_PREFIX + sessionId)
        return { status: 'denied', message: '用户拒绝了授权' }
      }

      logger.error('OAuth poll error:', error.message)
      throw error
    }
  }

  /**
   * 使用 OAuth session 创建账户
   */
  async createAccountFromOAuthSession(
    sessionId,
    { name, description, priority, accountType = 'shared', poolType } = {}
  ) {
    const client = redis.getClient()
    const sessionData = await client.hgetall(this.OAUTH_SESSION_PREFIX + sessionId)

    if (!sessionData || sessionData.status !== 'completed') {
      throw new Error('OAuth session not found or not completed')
    }

    const accessToken = this._decrypt(sessionData.accessToken)
    const refreshToken = sessionData.refreshToken ? this._decrypt(sessionData.refreshToken) : ''

    const planType =
      sessionData.planType ||
      this._extractPlanTypeFromJwtPayload(this._decodeJwtPayload(accessToken)) ||
      ''

    const chatgptAccountId =
      sessionData.chatgptAccountId ||
      this._extractChatGPTAccountIdFromJwtPayload(this._decodeJwtPayload(accessToken)) ||
      ''

    const oauthClientId =
      sessionData.oauthClientId ||
      this._extractClientIdFromJwtPayload(this._decodeJwtPayload(accessToken)) ||
      ''

    // 创建账户
    const account = await this.createAccount({
      name,
      description,
      accessToken,
      refreshToken,
      chatgptAccountId,
      planType,
      oauthClientId,
      priority,
      accountType,
      poolType
    })

    // 更新账户状态为 active
    await this.updateAccount(account.id, { status: 'active' })

    // 清理 OAuth session
    await client.del(this.OAUTH_SESSION_PREFIX + sessionId)

    logger.success(`Created account from OAuth session: ${account.id}`)

    return account
  }

  /**
   * 获取 OAuth session 状态
   */
  async getOAuthSessionStatus(sessionId) {
    const client = redis.getClient()
    const sessionData = await client.hgetall(this.OAUTH_SESSION_PREFIX + sessionId)

    if (!sessionData || Object.keys(sessionData).length === 0) {
      return null
    }

    return {
      sessionId,
      status: sessionData.status,
      userCode: sessionData.userCode,
      verificationUri: sessionData.verificationUri,
      verificationUriComplete: sessionData.verificationUriComplete,
      expiresAt: sessionData.expiresAt,
      createdAt: sessionData.createdAt
    }
  }

  // ==================== OAuth Authorization Code (Browser) Flow ====================

  async startBrowserAuthorization({ redirectUri } = {}) {
    if (!redirectUri || typeof redirectUri !== 'string') {
      throw new Error('redirectUri is required')
    }

    const sessionId = crypto.randomUUID()
    const codeVerifier = this._generateCodeVerifier()
    const codeChallenge = this._generateCodeChallenge(codeVerifier)

    const url = new URL(`${this.OPENAI_AUTH_URL}/oauth/authorize`)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.OPENAI_CLIENT_ID)
    url.searchParams.set('redirect_uri', redirectUri)
    // 对齐 codex-cli 授权 URL 形态，避免授权页兼容性问题
    url.searchParams.set('scope', 'openid profile email offline_access')
    url.searchParams.set('state', sessionId)
    url.searchParams.set('code_challenge', codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('id_token_add_organizations', 'true')
    url.searchParams.set('codex_cli_simplified_flow', 'true')
    url.searchParams.set('originator', 'codex_cli_rs')

    const expiresIn = 15 * 60 // 15 minutes
    const now = new Date()

    const client = redis.getClient()
    const sessionData = {
      flow: 'oauth_authorize',
      status: 'pending',
      redirectUri,
      authorizationUrl: url.toString(),
      codeVerifier: this._encrypt(codeVerifier),
      expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
      createdAt: now.toISOString()
    }

    await client.hset(this.OAUTH_SESSION_PREFIX + sessionId, sessionData)
    await client.expire(this.OAUTH_SESSION_PREFIX + sessionId, expiresIn)

    logger.info(`Started OAuth browser flow, session: ${sessionId}, redirect_uri: ${redirectUri}`)

    return {
      sessionId,
      authorizationUrl: url.toString(),
      expiresIn,
      interval: 2
    }
  }

  async completeBrowserAuthorization(sessionId, { code } = {}) {
    if (!sessionId) throw new Error('Session ID required')
    if (!code) throw new Error('Authorization code required')

    const client = redis.getClient()
    const key = this.OAUTH_SESSION_PREFIX + sessionId
    const sessionData = await client.hgetall(key)

    if (!sessionData || Object.keys(sessionData).length === 0) {
      throw new Error('OAuth session not found or expired')
    }

    if (sessionData.status === 'completed') {
      return { status: 'completed' }
    }

    if (sessionData.flow !== 'oauth_authorize') {
      throw new Error('OAuth session flow mismatch')
    }

    const redirectUri = sessionData.redirectUri || ''
    const codeVerifier = this._decrypt(sessionData.codeVerifier || '')
    if (!redirectUri || !codeVerifier) {
      throw new Error('OAuth session missing redirectUri/codeVerifier')
    }

    try {
      const response = await this._postOAuthForm(this.codexAuthUrl, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: this.OPENAI_CLIENT_ID,
        code_verifier: codeVerifier
      }, { timeoutMs: 20000 })

      const { access_token, refresh_token, id_token, expires_in } = response.data || {}
      if (!access_token) {
        throw new Error('Token response missing access_token')
      }

      const planType =
        this._extractPlanTypeFromJwtPayload(this._decodeJwtPayload(id_token)) ||
        this._extractPlanTypeFromJwtPayload(this._decodeJwtPayload(access_token)) ||
        ''

      const chatgptAccountId =
        this._extractChatGPTAccountIdFromJwtPayload(this._decodeJwtPayload(id_token)) ||
        this._extractChatGPTAccountIdFromJwtPayload(this._decodeJwtPayload(access_token)) ||
        ''

      const oauthClientId =
        this._extractClientIdFromJwtPayload(this._decodeJwtPayload(access_token)) ||
        ''

      await client.hset(key, {
        status: 'completed',
        accessToken: this._encrypt(access_token),
        refreshToken: refresh_token ? this._encrypt(refresh_token) : '',
        planType,
        chatgptAccountId,
        oauthClientId,
        tokenExpiresAt: new Date(Date.now() + (Number(expires_in || 0) * 1000)).toISOString(),
        completedAt: new Date().toISOString()
      })

      return { status: 'completed' }
    } catch (error) {
      await client.hset(key, {
        status: 'error',
        lastError: error.message,
        updatedAt: new Date().toISOString()
      })
      throw error
    }
  }

  async getOAuthSessionProgress(sessionId) {
    const client = redis.getClient()
    const sessionData = await client.hgetall(this.OAUTH_SESSION_PREFIX + sessionId)
    if (!sessionData || Object.keys(sessionData).length === 0) return null
    return {
      sessionId,
      flow: sessionData.flow || '',
      status: sessionData.status || 'pending',
      message: sessionData.lastError || '',
      expiresAt: sessionData.expiresAt || '',
      createdAt: sessionData.createdAt || ''
    }
  }

  async setOAuthSessionError(sessionId, message) {
    if (!sessionId) return false
    const client = redis.getClient()
    const key = this.OAUTH_SESSION_PREFIX + sessionId
    const existing = await client.hgetall(key)
    if (!existing || Object.keys(existing).length === 0) return false

    await client.hset(key, {
      status: 'error',
      lastError: String(message || 'OAuth failed'),
      updatedAt: new Date().toISOString()
    })
    return true
  }
}

module.exports = new CodexAccountService()
