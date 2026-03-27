const crypto = require('crypto')

let redis = null
let logger = console

class ApiKeyService {
  constructor() {
    this.REDIS_KEY_PREFIX = 'codex:api_key:'
    this.REDIS_KEY_HASH_PREFIX = 'codex:api_key_hash:'
    this.REDIS_KEYS_SET = 'codex:api_keys'
  }

  init(redisWrapper, loggerInstance) {
    redis = redisWrapper
    logger = loggerInstance || console
    logger.info('ApiKeyService initialized')
  }

  _sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex')
  }

  _generateRawKey() {
    // 类似 cr_xxx 的格式，避免误认为 OpenAI key
    return `cx_${crypto.randomBytes(24).toString('hex')}`
  }

  _normalizeRoutingMode(routingMode, accountId = '') {
    const normalized = String(routingMode || '').trim().toLowerCase()
    if (normalized === 'dedicated') return 'dedicated'
    if (normalized === 'shared') return 'shared'
    return String(accountId || '').trim() ? 'dedicated' : 'shared'
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

  async createApiKey({ name, permissions = 'all', enabled = true, accountId = '', routingMode = '' } = {}) {
    const id = crypto.randomUUID()
    const apiKey = this._generateRawKey()
    const hash = this._sha256(apiKey)
    const now = new Date().toISOString()
    const requestedAccountId = String(accountId || '').trim()
    const normalizedRoutingMode = this._normalizeRoutingMode(routingMode, requestedAccountId)
    const boundAccountId = normalizedRoutingMode === 'dedicated' ? requestedAccountId : ''

    const data = {
      id,
      name: name || 'Codex API Key',
      permissions,
      enabled: enabled ? '1' : '0',
      routingMode: normalizedRoutingMode,
      accountId: boundAccountId,
      hash,
      last4: apiKey.slice(-4),
      createdAt: now,
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
      lastModel: '',
      lastAccountId: ''
    }

    const client = redis.getClient()
    await client.hset(this.REDIS_KEY_PREFIX + id, data)
    await client.set(this.REDIS_KEY_HASH_PREFIX + hash, id)
    await client.sadd(this.REDIS_KEYS_SET, id)

    return { id, apiKey, ...this._formatForResponse(data) }
  }

  async getAllApiKeys() {
    const client = redis.getClient()
    const ids = await client.smembers(this.REDIS_KEYS_SET)
    const keys = []
    for (const id of ids) {
      const data = await client.hgetall(this.REDIS_KEY_PREFIX + id)
      if (data && Object.keys(data).length > 0) keys.push(this._formatForResponse(data))
    }
    keys.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    return keys
  }

  async deleteApiKey(id) {
    const client = redis.getClient()
    const data = await client.hgetall(this.REDIS_KEY_PREFIX + id)
    if (!data || Object.keys(data).length === 0) return false
    if (data.hash) await client.del(this.REDIS_KEY_HASH_PREFIX + data.hash)
    await client.del(this.REDIS_KEY_PREFIX + id)
    await client.srem(this.REDIS_KEYS_SET, id)
    return true
  }

  async validateApiKey(rawKey) {
    if (!rawKey) return null
    const hash = this._sha256(rawKey)
    const client = redis.getClient()
    const id = await client.get(this.REDIS_KEY_HASH_PREFIX + hash)
    if (!id) return null
    const data = await client.hgetall(this.REDIS_KEY_PREFIX + id)
    if (!data || Object.keys(data).length === 0) return null
    if (data.enabled !== '1') return null
    return this._formatForResponse(data)
  }

  async recordUsage(id, metrics = null) {
    try {
      const client = redis.getClient()
      const now = new Date().toISOString()
      const updateData = { lastUsedAt: now }

      if (metrics && typeof metrics === 'object' && Object.keys(metrics).length > 0) {
        const existing = await client.hgetall(this.REDIS_KEY_PREFIX + id)
        if (!existing || Object.keys(existing).length === 0) return

        const inputTokens = this._toInt(metrics.inputTokens)
        const outputTokens = this._toInt(metrics.outputTokens)
        const totalTokens = this._toInt(metrics.totalTokens || (inputTokens + outputTokens))

        updateData.totalRequests = String(this._toInt(existing.totalRequests) + 1)
        updateData.totalTokens = String(this._toInt(existing.totalTokens) + totalTokens)
        updateData.totalInputTokens = String(this._toInt(existing.totalInputTokens) + inputTokens)
        updateData.totalOutputTokens = String(this._toInt(existing.totalOutputTokens) + outputTokens)
        Object.assign(updateData, this._applyUsageWindows(existing, metrics, now))
        updateData.lastModel = String(metrics.model || '')
        updateData.lastAccountId = String(metrics.accountId || '')
      }

      await client.hset(this.REDIS_KEY_PREFIX + id, updateData)
    } catch (error) {
      logger.warn('Failed to record API key usage:', error.message)
    }
  }

  _formatForResponse(data) {
    const routingMode = this._normalizeRoutingMode(data.routingMode, data.accountId)
    return {
      id: data.id,
      name: data.name || '',
      permissions: data.permissions || 'all',
      enabled: data.enabled === '1',
      routingMode,
      accountId: data.accountId || '',
      last4: data.last4 || '',
      createdAt: data.createdAt || '',
      lastUsedAt: data.lastUsedAt || '',
      lastModel: data.lastModel || '',
      lastAccountId: data.lastAccountId || '',
      usageStats: {
        totalRequests: this._toInt(data.totalRequests),
        totalTokens: this._toInt(data.totalTokens),
        totalInputTokens: this._toInt(data.totalInputTokens),
        totalOutputTokens: this._toInt(data.totalOutputTokens),
        daily: {
          requests: this._toInt(data.dailyRequests),
          tokens: this._toInt(data.dailyTokens),
          inputTokens: this._toInt(data.dailyInputTokens),
          outputTokens: this._toInt(data.dailyOutputTokens),
          resetAt: data.dailyResetAt || null
        },
        weekly: {
          requests: this._toInt(data.weeklyRequests),
          tokens: this._toInt(data.weeklyTokens),
          inputTokens: this._toInt(data.weeklyInputTokens),
          outputTokens: this._toInt(data.weeklyOutputTokens),
          resetAt: data.weeklyResetAt || null
        },
        monthly: {
          requests: this._toInt(data.monthlyRequests),
          tokens: this._toInt(data.monthlyTokens),
          inputTokens: this._toInt(data.monthlyInputTokens),
          outputTokens: this._toInt(data.monthlyOutputTokens),
          resetAt: data.monthlyResetAt || null
        }
      }
    }
  }
}

module.exports = new ApiKeyService()
