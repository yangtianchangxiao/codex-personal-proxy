/**
 * Codex Relay Service - 独立版本
 * 转发请求到 OpenAI API
 */

const axios = require('axios')
const WebSocket = require('ws')
const codexAccountService = require('./codexAccountService')
const apiKeyService = require('./apiKeyService')
const { getProxyAgent } = require('../utils/proxyAgent')

let logger = console

const CLAUDE_COMPAT_BASE_MODEL = String(
  process.env.CODEX_CLAUDE_COMPAT_BASE_MODEL || 'gpt-5.4'
).trim() || 'gpt-5.4'

const CLAUDE_COMPAT_REASONING_MAP = {
  default: String(process.env.CODEX_CLAUDE_COMPAT_EFFORT_DEFAULT || 'xhigh').trim().toLowerCase() || 'xhigh',
  opus: String(process.env.CODEX_CLAUDE_COMPAT_EFFORT_OPUS || 'xhigh').trim().toLowerCase() || 'xhigh',
  sonnet: String(process.env.CODEX_CLAUDE_COMPAT_EFFORT_SONNET || 'high').trim().toLowerCase() || 'high',
  haiku: String(process.env.CODEX_CLAUDE_COMPAT_EFFORT_HAIKU || 'medium').trim().toLowerCase() || 'medium'
}

// 统计数据（内存）
const stats = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  totalTokens: 0
}

function extractTextContent(content) {
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    const parts = []
    for (const part of content) {
      if (!part) continue
      if (typeof part === 'string') {
        parts.push(part)
        continue
      }

      if (typeof part.text === 'string') {
        parts.push(part.text)
        continue
      }

      if (part.type === 'text' && typeof part.text === 'string') {
        parts.push(part.text)
        continue
      }

      if (part.type === 'input_text' && typeof part.text === 'string') {
        parts.push(part.text)
        continue
      }

      if (part.type === 'output_text' && typeof part.text === 'string') {
        parts.push(part.text)
        continue
      }

      if (part.type === 'refusal' && typeof part.refusal === 'string') {
        parts.push(part.refusal)
      }
    }
    return parts.join('\n').trim()
  }

  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text
  }

  return ''
}

function normalizeClaudeCompatModel(rawModel, fallbackModel = 'default') {
  const requestedModel = String(rawModel || '').trim()
  const normalizedModel = requestedModel.toLowerCase()
  const strippedModel = normalizedModel.replace(/\[(?:1m)\]$/i, '')

  if (!requestedModel || strippedModel === 'default') {
    return {
      requestedModel: requestedModel || 'default',
      exposedModel: 'default',
      upstreamModel: CLAUDE_COMPAT_BASE_MODEL,
      reasoningEffort: CLAUDE_COMPAT_REASONING_MAP.default,
      isAlias: true
    }
  }

  if (strippedModel === 'opus' || strippedModel === 'opusplan' || strippedModel.startsWith('claude-opus')) {
    return {
      requestedModel,
      exposedModel: requestedModel,
      upstreamModel: CLAUDE_COMPAT_BASE_MODEL,
      reasoningEffort: CLAUDE_COMPAT_REASONING_MAP.opus,
      isAlias: true
    }
  }

  if (strippedModel === 'sonnet' || strippedModel.startsWith('claude-sonnet')) {
    return {
      requestedModel,
      exposedModel: requestedModel,
      upstreamModel: CLAUDE_COMPAT_BASE_MODEL,
      reasoningEffort: CLAUDE_COMPAT_REASONING_MAP.sonnet,
      isAlias: true
    }
  }

  if (strippedModel === 'haiku' || strippedModel.startsWith('claude-haiku')) {
    return {
      requestedModel,
      exposedModel: requestedModel,
      upstreamModel: CLAUDE_COMPAT_BASE_MODEL,
      reasoningEffort: CLAUDE_COMPAT_REASONING_MAP.haiku,
      isAlias: true
    }
  }

  return {
    requestedModel: requestedModel || fallbackModel,
    exposedModel: requestedModel || fallbackModel,
    upstreamModel: requestedModel || fallbackModel,
    reasoningEffort: '',
    isAlias: false
  }
}

function normalizeUsageMetrics(usage) {
  if (!usage || typeof usage !== 'object') {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  }

  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? 0) || 0
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? 0) || 0
  const totalTokens = Number(usage.total_tokens ?? usage.totalTokens ?? (inputTokens + outputTokens)) || 0

  return { inputTokens, outputTokens, totalTokens }
}

function convertChatMessagesToResponsesInput(messages) {
  const instructions = []
  const input = []

  for (const message of messages || []) {
    if (!message || typeof message !== 'object') continue

    const role = String(message.role || 'user').toLowerCase()
    const text = extractTextContent(message.content)

    if (role === 'system') {
      if (text) instructions.push(text)
      continue
    }

    if (role === 'tool') {
      const toolName = message.name || message.tool_call_id || 'tool'
      const toolText = text || ''
      input.push({
        role: 'user',
        content: [{ type: 'input_text', text: `Tool result (${toolName}):\n${toolText}` }]
      })
      continue
    }

    const normalizedRole = role === 'assistant' ? 'assistant' : 'user'
    let normalizedText = text

    if (normalizedRole === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const serializedCalls = message.tool_calls
        .map((call) => {
          const name = call?.function?.name || 'tool'
          const args = call?.function?.arguments || '{}'
          return `[tool_call] ${name}: ${args}`
        })
        .join('\n')
      normalizedText = [normalizedText, serializedCalls].filter(Boolean).join('\n')
    }

    if (!normalizedText) continue
    const contentType = normalizedRole === 'assistant' ? 'output_text' : 'input_text'
    input.push({
      role: normalizedRole,
      content: [{ type: contentType, text: normalizedText }]
    })
  }

  return { instructions, input }
}

function buildResponsesPayloadFromChatRequest(chatRequest, modelConfig = normalizeClaudeCompatModel(chatRequest?.model, 'gpt-5')) {
  const request = chatRequest || {}
  const { instructions, input } = convertChatMessagesToResponsesInput(request.messages)

  const payload = {
    model: modelConfig.upstreamModel,
    instructions: instructions.join('\n\n') || 'You are a helpful assistant.',
    input: input.length > 0 ? input : [{ role: 'user', content: [{ type: 'input_text', text: '' }] }],
    stream: true,
    store: false
  }

  if (modelConfig.reasoningEffort) {
    payload.reasoning = { effort: modelConfig.reasoningEffort }
  }

  // chatgpt.com codex responses rejects several OpenAI chat params
  // (e.g. temperature, max_output_tokens), so keep only minimal safe fields.
  // Keep this bridge conservative and only forward known-safe fields.

  return payload
}

function extractAnthropicBlockText(block) {
  if (!block) return ''
  if (typeof block === 'string') return block

  if (typeof block.text === 'string') {
    return block.text
  }

  if (block.type === 'tool_use') {
    const name = block.name || 'tool'
    let inputText = '{}'
    try {
      inputText = JSON.stringify(block.input || {})
    } catch (error) {
      inputText = '{}'
    }
    return `[tool_use] ${name}: ${inputText}`
  }

  if (block.type === 'tool_result') {
    const toolName = block.tool_use_id || block.name || 'tool'
    const toolContent = extractAnthropicContentText(block.content)
    return `Tool result (${toolName}):\n${toolContent}`.trim()
  }

  if (typeof block.content !== 'undefined') {
    return extractAnthropicContentText(block.content)
  }

  return ''
}

function extractAnthropicContentText(content) {
  if (typeof content === 'string') return content.trim()

  if (Array.isArray(content)) {
    return content
      .map((part) => extractAnthropicBlockText(part))
      .filter(Boolean)
      .join('\n')
      .trim()
  }

  if (content && typeof content === 'object') {
    return extractAnthropicBlockText(content).trim()
  }

  return ''
}

function extractAnthropicSystemText(system) {
  return extractAnthropicContentText(system)
}

function buildResponsesPayloadFromAnthropicRequest(
  anthropicRequest,
  modelConfig = normalizeClaudeCompatModel(anthropicRequest?.model, 'default')
) {
  const request = anthropicRequest || {}
  const input = []

  for (const message of request.messages || []) {
    if (!message || typeof message !== 'object') continue
    const role = String(message.role || 'user').toLowerCase()
    const normalizedRole = role === 'assistant' ? 'assistant' : 'user'
    const text = extractAnthropicContentText(message.content)
    if (!text) continue
    const contentType = normalizedRole === 'assistant' ? 'output_text' : 'input_text'
    input.push({
      role: normalizedRole,
      content: [{ type: contentType, text }]
    })
  }

  return {
    model: modelConfig.upstreamModel,
    instructions: extractAnthropicSystemText(request.system) || 'You are a helpful assistant.',
    input: input.length > 0 ? input : [{ role: 'user', content: [{ type: 'input_text', text: '' }] }],
    stream: true,
    store: false,
    ...(modelConfig.reasoningEffort ? { reasoning: { effort: modelConfig.reasoningEffort } } : {})
  }
}

function estimateAnthropicInputTokens(request) {
  const modelConfig = normalizeClaudeCompatModel(request?.model, 'default')
  const payload = buildResponsesPayloadFromAnthropicRequest(request, modelConfig)
  let text = payload.instructions || ''
  for (const item of payload.input || []) {
    for (const part of item.content || []) {
      if (part?.type === 'input_text' && typeof part.text === 'string') {
        text += `\n${part.text}`
      } else if (part?.type === 'output_text' && typeof part.text === 'string') {
        text += `\n${part.text}`
      } else if (part?.type === 'refusal' && typeof part.refusal === 'string') {
        text += `\n${part.refusal}`
      }
    }
  }
  const chars = text.length
  return Math.max(1, Math.ceil(chars / 4))
}

function createSseParser(onEvent) {
  let buffer = ''

  return {
    push(chunk) {
      buffer += chunk.toString('utf8')
      let separatorIndex = buffer.indexOf('\n\n')

      while (separatorIndex !== -1) {
        const rawBlock = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)
        separatorIndex = buffer.indexOf('\n\n')

        const lines = rawBlock.split(/\r?\n/)
        let eventName = ''
        const dataLines = []

        for (const line of lines) {
          if (!line) continue
          if (line.startsWith('event:')) {
            eventName = line.slice('event:'.length).trim()
            continue
          }
          if (line.startsWith('data:')) {
            dataLines.push(line.slice('data:'.length).trim())
          }
        }

        if (dataLines.length > 0) {
          onEvent(eventName, dataLines.join('\n'))
        }
      }
    },
    flush() {
      if (!buffer.trim()) return
      const lines = buffer.split(/\r?\n/)
      let eventName = ''
      const dataLines = []
      for (const line of lines) {
        if (!line) continue
        if (line.startsWith('event:')) {
          eventName = line.slice('event:'.length).trim()
          continue
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).trim())
        }
      }
      if (dataLines.length > 0) {
        onEvent(eventName, dataLines.join('\n'))
      }
      buffer = ''
    }
  }
}

function toChatCompletionUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined

  return {
    prompt_tokens: Number(usage.input_tokens || 0),
    completion_tokens: Number(usage.output_tokens || 0),
    total_tokens: Number(usage.total_tokens || 0)
  }
}

function toAnthropicUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return { input_tokens: 0, output_tokens: 0 }
  }

  return {
    input_tokens: Number(usage.input_tokens || 0),
    output_tokens: Number(usage.output_tokens || 0)
  }
}

function createCompatId(prefix) {
  const rand = Math.random().toString(16).slice(2, 18)
  return `${prefix}_${Date.now().toString(16)}${rand}`
}

class CodexRelayService {
  constructor() {
    this.openaiApiUrl = 'https://api.openai.com'
    this.chatgptBackendUrl = 'https://chatgpt.com/backend-api'
    this.chatgptCodexResponsesUrl = 'https://chatgpt.com/backend-api/codex/responses'
    this.localWebSocketServer = new WebSocket.Server({ noServer: true })
  }

  init(redisWrapper, loggerInstance) {
    logger = loggerInstance || console
    logger.info('CodexRelayService initialized')
  }

  _createRelayError(status, data, fallbackMessage) {
    const error = new Error(fallbackMessage || `Request failed with status ${status}`)
    error.response = {
      status,
      data: data || { error: fallbackMessage || 'Upstream error', status }
    }
    return error
  }

  _writeRawUpgradeError(socket, status, payload) {
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
      // ignore socket destroy failures
    }
  }

  _safeCloseWebSocket(ws, code, reason) {
    if (!ws) return
    if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) return

    try {
      if (code) ws.close(code, reason)
      else ws.close()
    } catch {
      try {
        ws.terminate()
      } catch {
        // ignore terminate failures
      }
    }
  }

  async _openUpstreamWebSocket(targetUrl, headers) {
    const proxyAgent = getProxyAgent(targetUrl)

    return await new Promise((resolve, reject) => {
      const upstreamWs = new WebSocket(targetUrl, {
        headers,
        agent: proxyAgent || undefined,
        perMessageDeflate: false,
        handshakeTimeout: 30000
      })

      const cleanup = () => {
        upstreamWs.off('open', handleOpen)
        upstreamWs.off('error', handleError)
        upstreamWs.off('unexpected-response', handleUnexpectedResponse)
      }

      const handleOpen = () => {
        cleanup()
        resolve(upstreamWs)
      }

      const handleError = (error) => {
        cleanup()
        reject(error)
      }

      const handleUnexpectedResponse = (request, response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => {
          cleanup()
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 4000)
          const err = new Error(`WebSocket handshake failed with status ${response.statusCode || 502}`)
          err.response = {
            status: response.statusCode || 502,
            data: body,
            headers: response.headers || {}
          }
          reject(err)
        })
        response.on('error', (error) => {
          cleanup()
          reject(error)
        })
        response.resume()
      }

      upstreamWs.once('open', handleOpen)
      upstreamWs.once('error', handleError)
      upstreamWs.once('unexpected-response', handleUnexpectedResponse)
    })
  }

  _getHeaderValue(headers, candidates) {
    if (!headers || typeof headers !== 'object') return ''
    for (const candidate of candidates) {
      const direct = headers[candidate]
      const normalized = headers[String(candidate || '').toLowerCase()]
      const value = direct !== undefined ? direct : normalized
      if (value === undefined || value === null || value === '') continue
      if (Array.isArray(value)) {
        if (value[0] !== undefined && value[0] !== null && value[0] !== '') {
          return String(value[0]).trim()
        }
        continue
      }
      return String(value).trim()
    }
    return ''
  }

  _extractErrorText(error) {
    const data = error?.response?.data
    if (!data) return ''
    if (typeof data === 'string') return data
    try {
      return JSON.stringify(data)
    } catch {
      return ''
    }
  }

  _isTransientUpstreamError(error) {
    const status = Number(error?.response?.status || 0)
    const errorCode = String(error?.code || '').toUpperCase()
    const message = `${error?.message || ''} ${this._extractErrorText(error)}`.toLowerCase()

    if ([408, 409, 423, 425, 429, 500, 502, 503, 504, 520, 522, 524].includes(status)) {
      return true
    }

    if (['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(errorCode)) {
      return true
    }

    return /high demand|temporary errors|temporarily unavailable|overloaded|over capacity|please try again|timeout|timed out|server error|server had an error/.test(message)
  }

  _extractRateLimitHint(headers) {
    const retryAfterRaw = this._getHeaderValue(headers, ['retry-after'])
    const now = Date.now()

    if (retryAfterRaw) {
      const asSeconds = Number.parseFloat(retryAfterRaw)
      if (Number.isFinite(asSeconds) && asSeconds > 0) {
        return {
          cooldownSeconds: Math.ceil(asSeconds),
          resetAt: new Date(now + Math.ceil(asSeconds) * 1000).toISOString()
        }
      }

      const retryAtMs = Date.parse(retryAfterRaw)
      if (Number.isFinite(retryAtMs) && retryAtMs > now) {
        return {
          cooldownSeconds: Math.ceil((retryAtMs - now) / 1000),
          resetAt: new Date(retryAtMs).toISOString()
        }
      }
    }

    const resetRaw = this._getHeaderValue(headers, [
      'x-ratelimit-reset',
      'ratelimit-reset',
      'x-ratelimit-reset-requests',
      'openai-ratelimit-reset-requests'
    ])

    if (resetRaw) {
      const asNumber = Number.parseFloat(resetRaw)
      if (Number.isFinite(asNumber) && asNumber > 0) {
        let resetAtMs = 0
        if (asNumber > 1e12) {
          resetAtMs = asNumber
        } else if (asNumber > 1e9) {
          resetAtMs = asNumber * 1000
        } else {
          resetAtMs = now + Math.ceil(asNumber) * 1000
        }

        if (resetAtMs > now) {
          return {
            cooldownSeconds: Math.ceil((resetAtMs - now) / 1000),
            resetAt: new Date(resetAtMs).toISOString()
          }
        }
      }

      const resetAtMs = Date.parse(resetRaw)
      if (Number.isFinite(resetAtMs) && resetAtMs > now) {
        return {
          cooldownSeconds: Math.ceil((resetAtMs - now) / 1000),
          resetAt: new Date(resetAtMs).toISOString()
        }
      }
    }

    return { cooldownSeconds: null, resetAt: null }
  }

  _extractRateLimitHintFromBody(data) {
    if (!data) return { cooldownSeconds: null, resetAt: null }

    let payload = data
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload)
      } catch {
        payload = null
      }
    }

    if (!payload || typeof payload !== 'object') {
      return { cooldownSeconds: null, resetAt: null }
    }

    const errorPayload = payload.error && typeof payload.error === 'object' ? payload.error : payload
    const now = Date.now()

    const resetsAtRaw = errorPayload.resets_at ?? errorPayload.reset_at ?? errorPayload.resetAt
    if (resetsAtRaw !== undefined && resetsAtRaw !== null && resetsAtRaw !== '') {
      const asNumber = Number.parseFloat(String(resetsAtRaw))
      let resetAtMs = 0

      if (Number.isFinite(asNumber) && asNumber > 0) {
        if (asNumber > 1e12) resetAtMs = asNumber
        else if (asNumber > 1e9) resetAtMs = asNumber * 1000
        else resetAtMs = now + Math.ceil(asNumber) * 1000
      } else {
        resetAtMs = Date.parse(String(resetsAtRaw))
      }

      if (Number.isFinite(resetAtMs) && resetAtMs > now) {
        return {
          cooldownSeconds: Math.ceil((resetAtMs - now) / 1000),
          resetAt: new Date(resetAtMs).toISOString()
        }
      }
    }

    const resetInSecondsRaw = errorPayload.resets_in_seconds ?? errorPayload.retry_after ?? errorPayload.retryAfter
    const resetInSeconds = Number.parseFloat(String(resetInSecondsRaw ?? ''))
    if (Number.isFinite(resetInSeconds) && resetInSeconds > 0) {
      return {
        cooldownSeconds: Math.ceil(resetInSeconds),
        resetAt: new Date(now + Math.ceil(resetInSeconds) * 1000).toISOString()
      }
    }

    return { cooldownSeconds: null, resetAt: null }
  }

  _extractQuotaSnapshot(headers, status = 0, body = null) {
    const remainingRequestsRaw = this._getHeaderValue(headers, [
      'x-ratelimit-remaining',
      'ratelimit-remaining',
      'x-ratelimit-remaining-requests',
      'openai-ratelimit-remaining-requests'
    ])
    const limitRequestsRaw = this._getHeaderValue(headers, [
      'x-ratelimit-limit',
      'ratelimit-limit',
      'x-ratelimit-limit-requests',
      'openai-ratelimit-limit-requests'
    ])
    const remainingTokensRaw = this._getHeaderValue(headers, [
      'x-ratelimit-remaining-tokens',
      'openai-ratelimit-remaining-tokens'
    ])
    const limitTokensRaw = this._getHeaderValue(headers, [
      'x-ratelimit-limit-tokens',
      'openai-ratelimit-limit-tokens'
    ])

    const parseMaybeNumber = (value) => {
      if (value === undefined || value === null || value === '') return null
      const parsed = Number.parseFloat(String(value))
      return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : null
    }

    const headerHint = this._extractRateLimitHint(headers)
    const bodyHint = this._extractRateLimitHintFromBody(body)
    const resetAt = headerHint.resetAt || bodyHint.resetAt || null
    const remainingRequests = parseMaybeNumber(remainingRequestsRaw)
    const limitRequests = parseMaybeNumber(limitRequestsRaw)
    const remainingTokens = parseMaybeNumber(remainingTokensRaw)
    const limitTokens = parseMaybeNumber(limitTokensRaw)

    if (
      remainingRequests === null &&
      limitRequests === null &&
      remainingTokens === null &&
      limitTokens === null &&
      !resetAt &&
      status !== 429
    ) {
      return null
    }

    return {
      remainingRequests: status === 429 && remainingRequests === null ? 0 : remainingRequests,
      limitRequests,
      remainingTokens,
      limitTokens,
      resetAt,
      source: headerHint.resetAt ? 'upstream_headers' : (bodyHint.resetAt ? 'upstream_body' : 'upstream_headers')
    }
  }

  async _recordUsageAndQuota({ apiKeyId = '', accountId = '', usage = null, model = '', headers = {}, status = 200, body = null } = {}) {
    const usageMetrics = normalizeUsageMetrics(usage)
    if (usageMetrics.totalTokens > 0) {
      stats.totalTokens += usageMetrics.totalTokens
    }

    const tasks = []

    if (apiKeyId) {
      tasks.push(apiKeyService.recordUsage(apiKeyId, { ...usageMetrics, model, accountId }))
    }

    if (accountId) {
      tasks.push(codexAccountService.recordUsage(accountId, { ...usageMetrics, model }))
      const quotaSnapshot = this._extractQuotaSnapshot(headers, status, body)
      if (quotaSnapshot) {
        tasks.push(codexAccountService.updateQuotaSnapshot(accountId, quotaSnapshot))
      }
    }

    if (tasks.length > 0) {
      await Promise.allSettled(tasks)
    }
  }

  async _markAccountRateLimitedIfNeeded(account, error) {
    if (!account || error?.response?.status !== 429) return

    const headers = error.response?.headers || {}
    const headerHint = this._extractRateLimitHint(headers)
    const bodyHint = this._extractRateLimitHintFromBody(error.response?.data)
    const cooldownSeconds = headerHint.cooldownSeconds || bodyHint.cooldownSeconds || null
    const resetAt = headerHint.resetAt || bodyHint.resetAt || null
    const detail = typeof error.response?.data === 'string'
      ? error.response.data.slice(0, 240)
      : ''

    try {
      const quotaSnapshot = this._extractQuotaSnapshot(headers, 429, error.response?.data)
      if (quotaSnapshot) {
        await codexAccountService.updateQuotaSnapshot(account.id, quotaSnapshot)
      }
      await codexAccountService.markAccountRateLimited(account.id, {
        cooldownSeconds,
        resetAt,
        reason: detail || 'Account temporarily unavailable (429)'
      })
    } catch (markError) {
      logger.warn(`Failed to mark Codex account ${account.id} as rate limited:`, markError.message)
    }
  }

  async _executeAccountRequestWithRefresh(account, executeRequest) {
    let accessToken = await codexAccountService.getDecryptedToken(account.id)
    if (!accessToken) {
      throw this._createRelayError(
        503,
        { error: 'Account token not available', accountId: account.id },
        'Account token not available'
      )
    }

    try {
      return await executeRequest(account, accessToken)
    } catch (firstError) {
      if (firstError.response?.status === 401) {
        logger.info(`Token expired for account ${account.id}, attempting refresh...`)
        try {
          await codexAccountService.refreshToken(account.id)
          accessToken = await codexAccountService.getDecryptedToken(account.id)
          if (accessToken) {
            logger.info(`Token refreshed for account ${account.id}, retrying request...`)
            return await executeRequest(account, accessToken)
          }
        } catch (refreshError) {
          logger.error(`Token refresh failed for account ${account.id}:`, refreshError.message)
        }
      }

      throw firstError
    }
  }

  async _executeWithAccountFallback({ preferredAccountId = '', executeRequest, usageTokens = 0 } = {}) {
    const initialAccount = await codexAccountService.getAvailableAccount({ preferredAccountId })
    if (!initialAccount) {
      if (preferredAccountId) {
        throw this._createRelayError(
          503,
          { error: 'Bound Codex account unavailable', accountId: preferredAccountId },
          'Bound Codex account unavailable'
        )
      }

      throw this._createRelayError(
        503,
        { error: 'No available Codex account' },
        'No available Codex account'
      )
    }

    const triedAccountIds = new Set()
    const exhaustedChatgptAccountIds = new Set()
    let selectedAccount = initialAccount
    let lastError = null

    while (selectedAccount) {
      triedAccountIds.add(selectedAccount.id)

      try {
        const response = await this._executeAccountRequestWithRefresh(selectedAccount, executeRequest)
        return { account: selectedAccount, response }
      } catch (requestError) {
        lastError = requestError

        if (requestError.response?.status === 429) {
          await this._markAccountRateLimitedIfNeeded(selectedAccount, requestError)
        }

        if (!preferredAccountId && this._isTransientUpstreamError(requestError)) {
          if (selectedAccount.chatgptAccountId) {
            exhaustedChatgptAccountIds.add(selectedAccount.chatgptAccountId)
          }

          const fallbackAccount = await codexAccountService.getAvailableAccount({
            excludeAccountIds: [...triedAccountIds],
            excludeChatgptAccountIds: [...exhaustedChatgptAccountIds]
          })

          if (fallbackAccount) {
            const failureHint = requestError.response?.status || requestError.code || 'transient error'
            logger.warn(
              `Account ${selectedAccount.id} failed with ${failureHint}, falling back to shared account ${fallbackAccount.id}`
            )
            selectedAccount = fallbackAccount
            continue
          }
        }

        throw requestError
      }
    }

    throw lastError || new Error('No available account after retries')
  }

  async relayRequest(req, res) {
    stats.totalRequests++
    const upstreamPath = (req.originalUrl || req.url || '').replace(/^\/api/, '')
    const method = (req.method || 'GET').toUpperCase()
    let isStream = Boolean(req.body?.stream) || (req.headers?.accept || '').includes('text/event-stream')

    const isResponsesEndpoint = upstreamPath.startsWith('/v1/responses')
    const isCompactEndpoint = upstreamPath.startsWith('/v1/responses/compact')
    // /v1/responses/* -> chatgpt.com/backend-api/codex/responses/*
    const targetUrl = isResponsesEndpoint
      ? `${this.chatgptBackendUrl}/codex${upstreamPath.replace('/v1', '')}`
      : `${this.openaiApiUrl}${upstreamPath}`

    // chatgpt.com/backend-api/codex/responses 在创建 responses 时要求 stream: true，但 compact 不支持 stream
    if (isCompactEndpoint) {
      isStream = false
    } else if (isResponsesEndpoint && method === 'POST') {
      isStream = true
    }

    // API Key 可选绑定到指定账号（用于多租户托管）
    const preferredAccountId = String(req.apiKey?.accountId || '').trim()
    const shouldSendBody = !['GET', 'HEAD'].includes(method)

    // 内部执行函数，支持重试
    const executeRequest = async (selectedAccount, accessToken) => {
      const headers = { 'Authorization': `Bearer ${accessToken}` }
      if (isResponsesEndpoint) {
        headers['host'] = 'chatgpt.com'
        headers['accept'] = isStream ? 'text/event-stream' : 'application/json'
        headers['content-type'] = 'application/json'
        if (selectedAccount.chatgptAccountId) {
          headers['chatgpt-account-id'] = selectedAccount.chatgptAccountId
        }
      } else if (shouldSendBody) {
        headers['Content-Type'] = req.headers['content-type'] || 'application/json'
      }

      const bodyData = shouldSendBody ? { ...req.body } : undefined
      if (isResponsesEndpoint && bodyData) {
        if (isCompactEndpoint) {
          // /responses/compact 不接受 store/stream 参数
          delete bodyData.store
          delete bodyData.stream
        } else {
          bodyData.store = false
          bodyData.stream = true  // chatgpt.com API 在创建 responses 时要求 stream: true
        }
      }

      const proxyAgent = getProxyAgent(targetUrl)
      const resp = await axios({
        method,
        url: targetUrl,
        headers,
        data: bodyData,
        responseType: isStream ? 'stream' : 'json',
        proxy: false,
        httpAgent: proxyAgent || undefined,
        httpsAgent: proxyAgent || undefined,
        timeout: 120000,
        validateStatus: () => true  // 不自动抛错，手动检查状态
      })

      // 手动检查状态码
      if (resp.status >= 400) {
        // 记录详细错误
        let errorDetail = ''
        if (resp.data) {
          if (typeof resp.data === 'string') {
            errorDetail = resp.data.slice(0, 500)
          } else if (resp.data.pipe) {
            // 流式响应，尝试读取
            const chunks = []
            for await (const chunk of resp.data) {
              chunks.push(chunk)
              if (chunks.length > 10) break
            }
            errorDetail = Buffer.concat(chunks).toString('utf8').slice(0, 500)
          } else {
            errorDetail = JSON.stringify(resp.data).slice(0, 500)
          }
        }
        logger.error(`Upstream error ${resp.status} from ${targetUrl}: ${errorDetail}`)
        const err = new Error(`Request failed with status ${resp.status}`)
        err.response = { status: resp.status, data: errorDetail, headers: resp.headers || {} }
        throw err
      }

      return resp
    }

    try {
      const { account, response } = await this._executeWithAccountFallback({
        preferredAccountId,
        executeRequest,
        usageTokens: 0
      })
      stats.successfulRequests++

      // 流式响应
      if (isStream) {
        let parsedUsage = null
        let parsedModel = String(req.body?.model || '')
        let parser = null

        if (isResponsesEndpoint) {
          parser = createSseParser((eventName, rawData) => {
            if (!rawData || rawData === '[DONE]') return
            try {
              const payload = JSON.parse(rawData)
              const type = String(payload?.type || eventName || '')
              const upstreamResponse = payload?.response
              if (type === 'response.completed' && upstreamResponse) {
                parsedUsage = upstreamResponse.usage || null
                if (upstreamResponse.model) parsedModel = upstreamResponse.model
              } else if (type === 'response.created' && upstreamResponse?.model) {
                parsedModel = upstreamResponse.model
              }
            } catch {
              // ignore parse failures
            }
          })
        }

        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no')
        await new Promise((resolve, reject) => {
          response.data.on('data', (chunk) => {
            if (parser) parser.push(chunk)
            res.write(chunk)
          })
          response.data.on('end', async () => {
            try {
              if (parser) parser.flush()
              await this._recordUsageAndQuota({
                apiKeyId: req.apiKey?.id,
                accountId: account.id,
                usage: parsedUsage,
                model: parsedModel,
                headers: response.headers || {},
                status: response.status
              })
              resolve()
            } catch (recordError) {
              reject(recordError)
            }
          })
          response.data.on('error', reject)
        })
        return res.end()
      } else {
        await this._recordUsageAndQuota({
          apiKeyId: req.apiKey?.id,
          accountId: account.id,
          usage: response.data?.usage,
          model: response.data?.model || req.body?.model || '',
          headers: response.headers || {},
          status: response.status
        })
        res.status(response.status).json(response.data)
      }

    } catch (error) {
      stats.failedRequests++
      logger.error('Relay request failed:', error.message)

      const status = error.response?.status || 500
      let safeData = { error: 'Upstream error', status, message: error.message }

      if (error.response?.data) {
        try {
          if (typeof error.response.data === 'string') {
            safeData = { error: error.response.data, status }
          } else {
            JSON.stringify(error.response.data)
            safeData = error.response.data
          }
        } catch (e) {
          // 循环引用，保持默认 safeData
        }
      }

      res.status(status).json(safeData)
    }
  }

  async handleResponsesWebSocketUpgrade(req, socket, head) {
    stats.totalRequests++

    const upstreamPath = (req.url || '').replace(/^\/api/, '')
    const pathname = new URL(upstreamPath, 'http://localhost').pathname
    if (pathname !== '/v1/responses') {
      return this._writeRawUpgradeError(socket, 405, {
        error: '{"detail":"Method Not Allowed"}',
        status: 405
      })
    }

    const targetUrl = `${this.chatgptBackendUrl.replace(/^http/, 'ws')}/codex${upstreamPath.replace('/v1', '')}`
    const preferredAccountId = String(req.apiKey?.accountId || '').trim()

    const executeRequest = async (selectedAccount, accessToken) => {
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        host: 'chatgpt.com'
      }
      if (selectedAccount.chatgptAccountId) {
        headers['chatgpt-account-id'] = selectedAccount.chatgptAccountId
      }
      return await this._openUpstreamWebSocket(targetUrl, headers)
    }

    let account
    let upstreamWs
    try {
      const result = await this._executeWithAccountFallback({
        preferredAccountId,
        executeRequest,
        usageTokens: 0
      })
      account = result.account
      upstreamWs = result.response
      stats.successfulRequests++
    } catch (error) {
      stats.failedRequests++
      logger.error('Responses WebSocket upgrade failed:', error.message)
      const status = Number(error?.response?.status || 502)
      const data = error?.response?.data || { error: 'WebSocket upgrade failed', message: error.message }
      return this._writeRawUpgradeError(socket, status, {
        error: typeof data === 'string' ? data : JSON.stringify(data),
        status
      })
    }

    this.localWebSocketServer.handleUpgrade(req, socket, head, (clientWs) => {
      let usageRecorded = false
      let parsedUsage = null
      let parsedModel = ''

      const maybeRecordUsage = async (status = 200) => {
        if (usageRecorded) return
        usageRecorded = true
        try {
          await this._recordUsageAndQuota({
            apiKeyId: req.apiKey?.id,
            accountId: account.id,
            usage: parsedUsage,
            model: parsedModel,
            headers: {},
            status
          })
        } catch (error) {
          logger.warn('Failed to record WebSocket usage:', error.message)
        }
      }

      const parsePossiblePayload = (raw) => {
        try {
          const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
          if (!text || text[0] !== '{') return
          const payload = JSON.parse(text)
          if (payload?.response?.usage) parsedUsage = payload.response.usage
          if (payload?.response?.model) parsedModel = payload.response.model
          if (payload?.model && !parsedModel) parsedModel = String(payload.model)
        } catch {
          // ignore non-json websocket frames
        }
      }

      clientWs.on('message', (data, isBinary) => {
        if (upstreamWs.readyState === WebSocket.OPEN) {
          upstreamWs.send(data, { binary: isBinary })
        }
      })

      upstreamWs.on('message', (data, isBinary) => {
        parsePossiblePayload(data)
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data, { binary: isBinary })
        }
      })

      clientWs.on('close', () => {
        this._safeCloseWebSocket(upstreamWs, 1000, 'Client closed')
      })

      clientWs.on('error', (error) => {
        logger.warn('Client WebSocket error:', error.message)
        this._safeCloseWebSocket(upstreamWs, 1011, 'Client websocket error')
      })

      upstreamWs.on('close', async (code, reasonBuffer) => {
        const reason = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString('utf8') : String(reasonBuffer || '')
        await maybeRecordUsage(code === 1000 ? 200 : 502)
        this._safeCloseWebSocket(clientWs, code || 1000, reason || undefined)
      })

      upstreamWs.on('error', async (error) => {
        logger.warn('Upstream WebSocket error:', error.message)
        await maybeRecordUsage(502)
        this._safeCloseWebSocket(clientWs, 1011, 'Upstream websocket error')
      })
    })
  }

  async relayChatCompletionsCompat(req, res) {
    stats.totalRequests++

    const chatRequest = req.body || {}
    const modelConfig = normalizeClaudeCompatModel(chatRequest.model, 'gpt-5')
    const requestModel = modelConfig.exposedModel
    const shouldStream = Boolean(chatRequest.stream)
    const upstreamPayload = buildResponsesPayloadFromChatRequest(chatRequest, modelConfig)
    const targetUrl = `${this.chatgptBackendUrl}/codex/responses`

    const preferredAccountId = String(req.apiKey?.accountId || '').trim()
    const executeRequest = async (selectedAccount, accessToken) => {
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        host: 'chatgpt.com',
        accept: 'text/event-stream',
        'content-type': 'application/json'
      }
      if (selectedAccount.chatgptAccountId) {
        headers['chatgpt-account-id'] = selectedAccount.chatgptAccountId
      }

      const proxyAgent = getProxyAgent(targetUrl)
      const resp = await axios({
        method: 'POST',
        url: targetUrl,
        headers,
        data: upstreamPayload,
        responseType: 'stream',
        proxy: false,
        httpAgent: proxyAgent || undefined,
        httpsAgent: proxyAgent || undefined,
        timeout: 120000,
        validateStatus: () => true
      })

      if (resp.status >= 400) {
        let errorDetail = ''
        if (resp.data && resp.data.pipe) {
          const chunks = []
          for await (const chunk of resp.data) {
            chunks.push(chunk)
            if (chunks.length > 10) break
          }
          errorDetail = Buffer.concat(chunks).toString('utf8').slice(0, 600)
        }
        const err = new Error(`Request failed with status ${resp.status}`)
        err.response = { status: resp.status, data: errorDetail, headers: resp.headers || {} }
        throw err
      }

      return resp
    }

    try {
      const { account, response: upstreamResp } = await this._executeWithAccountFallback({
        preferredAccountId,
        executeRequest,
        usageTokens: 0
      })
      stats.successfulRequests++

      const parserState = {
        id: null,
        model: requestModel,
        created: Math.floor(Date.now() / 1000),
        text: '',
        usage: undefined,
        sentRoleChunk: false,
        completed: false
      }

      const parser = createSseParser((eventName, rawData) => {
        if (!rawData || rawData === '[DONE]') return

        let payload
        try {
          payload = JSON.parse(rawData)
        } catch (error) {
          return
        }

        const type = String(payload?.type || eventName || '')
        const response = payload?.response

        if (type === 'response.created' && response) {
          if (response.id) parserState.id = response.id
          if (response.model && !modelConfig.isAlias) parserState.model = response.model
          if (response.created_at) parserState.created = Number(response.created_at)
          return
        }

        if (type === 'response.output_text.delta') {
          const delta = String(payload?.delta || '')
          if (!delta) return
          parserState.text += delta

          if (shouldStream) {
            const chunkBase = {
              id: parserState.id || `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: parserState.created,
              model: parserState.model
            }

            if (!parserState.sentRoleChunk) {
              parserState.sentRoleChunk = true
              res.write(`data: ${JSON.stringify({
                ...chunkBase,
                choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
              })}\n\n`)
            }

            res.write(`data: ${JSON.stringify({
              ...chunkBase,
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
            })}\n\n`)
          }
          return
        }

        if (type === 'response.completed' && response) {
          parserState.completed = true
          if (response.id) parserState.id = response.id
          if (response.model && !modelConfig.isAlias) parserState.model = response.model
          if (response.created_at) parserState.created = Number(response.created_at)
          parserState.usage = toChatCompletionUsage(response.usage)

          if (!parserState.text && Array.isArray(response.output)) {
            for (const item of response.output) {
              if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue
              for (const contentPart of item.content) {
                if (contentPart?.type === 'output_text' && typeof contentPart.text === 'string') {
                  parserState.text += contentPart.text
                }
              }
            }
          }

          if (shouldStream) {
            const chunkBase = {
              id: parserState.id || `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: parserState.created,
              model: parserState.model
            }
            res.write(`data: ${JSON.stringify({
              ...chunkBase,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
            })}\n\n`)
            res.write('data: [DONE]\n\n')
          }
        }
      })

      if (shouldStream) {
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no')
      }

      await new Promise((resolve, reject) => {
        upstreamResp.data.on('data', (chunk) => parser.push(chunk))
        upstreamResp.data.on('end', () => {
          parser.flush()
          if (shouldStream && !parserState.completed) {
            const chunkBase = {
              id: parserState.id || `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: parserState.created,
              model: parserState.model
            }
            res.write(`data: ${JSON.stringify({
              ...chunkBase,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
            })}\n\n`)
            res.write('data: [DONE]\n\n')
          }
          resolve()
        })
        upstreamResp.data.on('error', reject)
      })

      await this._recordUsageAndQuota({
        apiKeyId: req.apiKey?.id,
        accountId: account.id,
        usage: parserState.usage,
        model: parserState.model,
        headers: upstreamResp.headers || {},
        status: upstreamResp.status
      })

      if (shouldStream) {
        return res.end()
      }

      return res.status(200).json({
        id: parserState.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: parserState.created,
        model: parserState.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: parserState.text || '' },
            finish_reason: 'stop'
          }
        ],
        usage: parserState.usage
      })
    } catch (error) {
      stats.failedRequests++
      logger.error('Chat completions compatibility relay failed:', error.message)
      const status = error.response?.status || 500
      return res.status(status).json({
        error: 'Upstream error',
        status,
        message: error.response?.data || error.message
      })
    }
  }

  async relayAnthropicModelsCompat(req, res) {
    const now = new Date().toISOString()
    const data = [
      {
        id: 'default',
        type: 'model',
        display_name: `default -> ${CLAUDE_COMPAT_BASE_MODEL} (${CLAUDE_COMPAT_REASONING_MAP.default})`,
        created_at: now
      },
      {
        id: 'opus',
        type: 'model',
        display_name: `opus -> ${CLAUDE_COMPAT_BASE_MODEL} (${CLAUDE_COMPAT_REASONING_MAP.opus})`,
        created_at: now
      },
      {
        id: 'sonnet',
        type: 'model',
        display_name: `sonnet -> ${CLAUDE_COMPAT_BASE_MODEL} (${CLAUDE_COMPAT_REASONING_MAP.sonnet})`,
        created_at: now
      },
      {
        id: 'haiku',
        type: 'model',
        display_name: `haiku -> ${CLAUDE_COMPAT_BASE_MODEL} (${CLAUDE_COMPAT_REASONING_MAP.haiku})`,
        created_at: now
      },
      {
        id: CLAUDE_COMPAT_BASE_MODEL,
        type: 'model',
        display_name: CLAUDE_COMPAT_BASE_MODEL,
        created_at: now
      }
    ]

    return res.status(200).json({
      data,
      first_id: data[0].id,
      last_id: data[data.length - 1].id,
      has_more: false
    })
  }

  async relayAnthropicCountTokensCompat(req, res) {
    try {
      const inputTokens = estimateAnthropicInputTokens(req.body || {})
      return res.status(200).json({ input_tokens: inputTokens })
    } catch (error) {
      logger.error('Anthropic count_tokens compatibility relay failed:', error.message)
      return res.status(500).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: 'Failed to estimate tokens'
        }
      })
    }
  }

  async relayAnthropicMessagesCompat(req, res) {
    stats.totalRequests++

    const anthropicRequest = req.body || {}
    const modelConfig = normalizeClaudeCompatModel(anthropicRequest.model, 'default')
    const requestModel = modelConfig.exposedModel
    const shouldStream = Boolean(anthropicRequest.stream)
    const upstreamPayload = buildResponsesPayloadFromAnthropicRequest(anthropicRequest, modelConfig)
    const targetUrl = `${this.chatgptBackendUrl}/codex/responses`

    const preferredAccountId = String(req.apiKey?.accountId || '').trim()

    const executeRequest = async (selectedAccount, accessToken) => {
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        host: 'chatgpt.com',
        accept: 'text/event-stream',
        'content-type': 'application/json'
      }
      if (selectedAccount.chatgptAccountId) {
        headers['chatgpt-account-id'] = selectedAccount.chatgptAccountId
      }

      const proxyAgent = getProxyAgent(targetUrl)
      const resp = await axios({
        method: 'POST',
        url: targetUrl,
        headers,
        data: upstreamPayload,
        responseType: 'stream',
        proxy: false,
        httpAgent: proxyAgent || undefined,
        httpsAgent: proxyAgent || undefined,
        timeout: 120000,
        validateStatus: () => true
      })

      if (resp.status >= 400) {
        let errorDetail = ''
        if (resp.data && resp.data.pipe) {
          const chunks = []
          for await (const chunk of resp.data) {
            chunks.push(chunk)
            if (chunks.length > 10) break
          }
          errorDetail = Buffer.concat(chunks).toString('utf8').slice(0, 600)
        }
        const err = new Error(`Request failed with status ${resp.status}`)
        err.response = { status: resp.status, data: errorDetail, headers: resp.headers || {} }
        throw err
      }

      return resp
    }

    try {
      const { account, response: upstreamResp } = await this._executeWithAccountFallback({
        preferredAccountId,
        executeRequest,
        usageTokens: 0
      })
      stats.successfulRequests++

      const parserState = {
        id: createCompatId('msg'),
        model: requestModel,
        created: Math.floor(Date.now() / 1000),
        text: '',
        usage: { input_tokens: 0, output_tokens: 0 },
        completed: false,
        streamStarted: false,
        contentStopped: false,
        messageDeltaSent: false,
        messageStopped: false
      }

      const writeAnthropicEvent = (eventName, payload) => {
        res.write(`event: ${eventName}\n`)
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      }

      const ensureAnthropicStreamStarted = () => {
        if (!shouldStream || parserState.streamStarted) return
        parserState.streamStarted = true
        writeAnthropicEvent('message_start', {
          type: 'message_start',
          message: {
            id: parserState.id,
            type: 'message',
            role: 'assistant',
            model: parserState.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: parserState.usage.input_tokens || 0, output_tokens: 0 }
          }
        })
        writeAnthropicEvent('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        })
      }

      const finalizeAnthropicStream = () => {
        if (!shouldStream) return
        ensureAnthropicStreamStarted()
        if (!parserState.contentStopped) {
          parserState.contentStopped = true
          writeAnthropicEvent('content_block_stop', { type: 'content_block_stop', index: 0 })
        }
        if (!parserState.messageDeltaSent) {
          parserState.messageDeltaSent = true
          writeAnthropicEvent('message_delta', {
            type: 'message_delta',
            delta: {
              stop_reason: 'end_turn',
              stop_sequence: null
            },
            usage: { output_tokens: parserState.usage.output_tokens || 0 }
          })
        }
        if (!parserState.messageStopped) {
          parserState.messageStopped = true
          writeAnthropicEvent('message_stop', { type: 'message_stop' })
        }
      }

      const parser = createSseParser((eventName, rawData) => {
        if (!rawData || rawData === '[DONE]') return

        let payload
        try {
          payload = JSON.parse(rawData)
        } catch (error) {
          return
        }

        const type = String(payload?.type || eventName || '')
        const response = payload?.response

        if (type === 'response.created' && response) {
          if (response.id && !parserState.streamStarted) parserState.id = response.id
          if (response.model && !modelConfig.isAlias) parserState.model = response.model
          if (response.created_at) parserState.created = Number(response.created_at)
          return
        }

        if (type === 'response.output_text.delta') {
          const delta = String(payload?.delta || '')
          if (!delta) return
          parserState.text += delta

          if (shouldStream) {
            ensureAnthropicStreamStarted()
            writeAnthropicEvent('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: delta }
            })
          }
          return
        }

        if (type === 'response.completed' && response) {
          parserState.completed = true
          if (response.id && !parserState.streamStarted) parserState.id = response.id
          if (response.model && !modelConfig.isAlias) parserState.model = response.model
          if (response.created_at) parserState.created = Number(response.created_at)
          parserState.usage = toAnthropicUsage(response.usage)

          if (!parserState.text && Array.isArray(response.output)) {
            for (const item of response.output) {
              if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue
              for (const contentPart of item.content) {
                if (contentPart?.type === 'output_text' && typeof contentPart.text === 'string') {
                  parserState.text += contentPart.text
                }
              }
            }
          }

          if (shouldStream) {
            finalizeAnthropicStream()
          }
        }
      })

      if (shouldStream) {
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no')
      }

      await new Promise((resolve, reject) => {
        upstreamResp.data.on('data', (chunk) => parser.push(chunk))
        upstreamResp.data.on('end', () => {
          parser.flush()
          if (shouldStream && !parserState.completed) {
            finalizeAnthropicStream()
          }
          resolve()
        })
        upstreamResp.data.on('error', reject)
      })

      await this._recordUsageAndQuota({
        apiKeyId: req.apiKey?.id,
        accountId: account.id,
        usage: parserState.usage,
        model: parserState.model,
        headers: upstreamResp.headers || {},
        status: upstreamResp.status
      })

      if (shouldStream) {
        return res.end()
      }

      return res.status(200).json({
        id: parserState.id,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: parserState.text || '' }],
        model: parserState.model,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: parserState.usage
      })
    } catch (error) {
      stats.failedRequests++
      logger.error('Anthropic messages compatibility relay failed:', error.message)
      const status = error.response?.status || 500
      const errorMessage = typeof error.response?.data === 'string'
        ? error.response.data
        : (error.message || 'Upstream error')
      return res.status(status).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: errorMessage
        }
      })
    }
  }

  async relayChatGPTBackend(req, res) {
    stats.totalRequests++
    // /backend-api/* 或 /api/backend-api/* -> https://chatgpt.com/backend-api/*
    const upstreamPathRaw = (req.originalUrl || req.url || '').replace(/^\/api/, '')
    const upstreamSubPath = upstreamPathRaw.replace(/^\/backend-api/, '')
    const targetUrl = `${this.chatgptBackendUrl}${upstreamSubPath.startsWith('/') ? upstreamSubPath : '/' + upstreamSubPath}`

    try {
      const preferredAccountId = String(req.apiKey?.accountId || '').trim()
      const method = (req.method || 'GET').toUpperCase()
      const shouldSendBody = !['GET', 'HEAD'].includes(method)

      const executeRequest = async (selectedAccount, accessToken) => {
        const headers = { 'Authorization': `Bearer ${accessToken}` }
        if (selectedAccount.chatgptAccountId) {
          headers['chatgpt-account-id'] = selectedAccount.chatgptAccountId
        }
        if (shouldSendBody) {
          headers['Content-Type'] = req.headers['content-type'] || 'application/json'
        }

        const proxyAgent = getProxyAgent(targetUrl)
        const response = await axios({
          method,
          url: targetUrl,
          headers,
          data: shouldSendBody ? req.body : undefined,
          proxy: false,
          httpAgent: proxyAgent || undefined,
          httpsAgent: proxyAgent || undefined,
          timeout: 120000,
          validateStatus: () => true
        })

        if (response.status >= 400) {
          const err = new Error(`Request failed with status ${response.status}`)
          err.response = {
            status: response.status,
            data: response.data,
            headers: response.headers || {}
          }
          throw err
        }

        return response
      }

      const { account, response } = await this._executeWithAccountFallback({
        preferredAccountId,
        executeRequest,
        usageTokens: 0
      })
      stats.successfulRequests++
      await this._recordUsageAndQuota({
        apiKeyId: req.apiKey?.id,
        accountId: account.id,
        usage: null,
        model: '',
        headers: response.headers || {},
        status: response.status
      })
      res.status(response.status).json(response.data)

    } catch (error) {
      stats.failedRequests++
      logger.error('ChatGPT backend relay failed:', error.message)

      const status = error.response?.status || 500
      let safeData = { error: 'Upstream error', status, message: error.message }

      if (error.response?.data) {
        try {
          if (typeof error.response.data === 'string') {
            safeData = { error: error.response.data, status }
          } else {
            JSON.stringify(error.response.data)
            safeData = error.response.data
          }
        } catch (e) {
          // 循环引用，保持默认 safeData
        }
      }

      res.status(status).json(safeData)
    }
  }

  async proxyOAuthToken(req, res) {
    try {
      const url = 'https://auth.openai.com/oauth/token'
      const proxyAgent = getProxyAgent(url)
      const response = await axios.post(url, req.body, {
        proxy: false,
        httpAgent: proxyAgent || undefined,
        httpsAgent: proxyAgent || undefined,
        headers: { 'Content-Type': 'application/json' }
      })
      res.json(response.data)
    } catch (error) {
      logger.error('OAuth proxy failed:', error.message)
      if (error.response) {
        res.status(error.response.status).json(error.response.data)
      } else {
        res.status(500).json({ error: 'OAuth proxy failed', message: error.message })
      }
    }
  }

  getStats() {
    return {
      ...stats,
      successRate: stats.totalRequests > 0
        ? ((stats.successfulRequests / stats.totalRequests) * 100).toFixed(2) + '%'
        : 'N/A'
    }
  }
}

module.exports = new CodexRelayService()
