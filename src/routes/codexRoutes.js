/**
 * Codex Routes - 独立版本
 * 处理 OpenAI Codex CLI 的所有请求
 */

const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const codexAccountService = require('../services/codexAccountService')
const codexRelayService = require('../services/codexRelayService')
const apiKeyService = require('../services/apiKeyService')

function normalizeAccountType(account) {
  const normalized = String(account?.accountType || '').trim().toLowerCase()
  if (normalized === 'dedicated' || normalized === 'shared') {
    return normalized
  }

  const legacy = String(account?.poolType || '').trim().toLowerCase()
  if (legacy === 'private') return 'dedicated'
  return 'shared'
}

// ==================== OAuth 代理 ====================

router.post('/oauth/token', async (req, res) => {
  await codexRelayService.proxyOAuthToken(req, res)
})

// ==================== API 转发 ====================

router.all('/v1/*', async (req, res) => {
  await codexRelayService.relayRequest(req, res)
})

router.all('/backend-api/*', async (req, res) => {
  await codexRelayService.relayChatGPTBackend(req, res)
})

// ==================== OAuth Device Flow ====================

// 启动设备授权流程
router.post('/oauth/device/start', async (req, res) => {
  try {
    const result = await codexAccountService.startDeviceAuthorization()
    res.json({ success: true, ...result })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// 轮询授权状态
router.post('/oauth/device/poll', async (req, res) => {
  try {
    const { sessionId } = req.body
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'Session ID required' })
    }
    const result = await codexAccountService.pollDeviceAuthorization(sessionId)
    res.json({ success: true, ...result })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// 获取 OAuth session 状态
router.get('/oauth/device/status/:sessionId', async (req, res) => {
  try {
    const result = await codexAccountService.getOAuthSessionStatus(req.params.sessionId)
    if (!result) {
      return res.status(404).json({ success: false, error: 'Session not found' })
    }
    res.json({ success: true, ...result })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// 使用 OAuth session 创建账户
router.post('/oauth/device/complete', async (req, res) => {
  try {
    const { sessionId, name, description, priority, accountType, poolType } = req.body
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'Session ID required' })
    }
    const account = await codexAccountService.createAccountFromOAuthSession(sessionId, {
      name: name || 'Codex Account',
      description: description || '',
      priority: priority || 50,
      accountType: accountType || 'shared',
      poolType
    })
    res.json({ success: true, account })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// ==================== OAuth Browser Flow (Authorization Code) ====================

function buildRedirectUri(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0].trim()
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim()
  if (!host) return ''

  const isLocal =
    host === 'localhost' ||
    host.startsWith('localhost:') ||
    host === '127.0.0.1' ||
    host.startsWith('127.0.0.1:')

  const path = isLocal ? '/api/oauth/callback' : '/codex/oauth/callback'
  return `${proto}://${host}${path}`
}

function buildLoopbackRedirectUri() {
  const hostRaw = (process.env.CODEX_OAUTH_LOOPBACK_HOST || 'localhost').toString().trim().toLowerCase()
  const host = hostRaw === '127.0.0.1' ? '127.0.0.1' : 'localhost'
  const portRaw = (process.env.CODEX_OAUTH_LOOPBACK_PORT || '').toString().trim()
  let port = Number.parseInt(portRaw, 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) port = 1455 // 与 codex-cli 默认一致
  return `http://${host}:${port}/auth/callback`
}

function escapeHtml(input) {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// 启动浏览器 OAuth 授权（避免 deviceauth 被 Cloudflare 拦截）
router.post('/oauth/browser/start', async (req, res) => {
  try {
    const { mode } = req.body || {}
    const normalizedMode = String(mode || '').trim().toLowerCase()
    const isLoopbackMode =
      !normalizedMode ||
      normalizedMode === 'loopback' ||
      normalizedMode === 'localhost' ||
      normalizedMode === 'local'

    const redirectUri =
      (isLoopbackMode
        ? (process.env.CODEX_OAUTH_LOOPBACK_REDIRECT_URI || buildLoopbackRedirectUri())
        : (process.env.CODEX_OAUTH_REDIRECT_URI || buildRedirectUri(req)))

    if (!redirectUri) {
      return res.status(500).json({ success: false, error: 'Unable to determine redirectUri' })
    }

    const result = await codexAccountService.startBrowserAuthorization({ redirectUri })
    res.json({ success: true, mode: isLoopbackMode ? 'loopback' : 'server', redirectUri, ...result })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// 手动完成浏览器 OAuth（适用于 loopback/localhost redirect：用户复制 code 粘贴回来）
router.post('/oauth/browser/complete', async (req, res) => {
  try {
    const { sessionId, code, callbackUrl } = req.body || {}
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'Session ID required' })
    }

    let authCode = (code || '').toString().trim()
    let urlState = ''

    if (!authCode && callbackUrl) {
      const raw = String(callbackUrl || '').trim()
      if (raw) {
        try {
          const url = raw.startsWith('http://') || raw.startsWith('https://')
            ? new URL(raw)
            : new URL(raw.startsWith('?') ? `http://localhost/${raw}` : `http://localhost/?${raw}`)
          authCode = (url.searchParams.get('code') || '').trim()
          urlState = (url.searchParams.get('state') || '').trim()
        } catch {
          // ignore
        }
      }
    }

    if (urlState && urlState !== String(sessionId)) {
      return res.status(400).json({ success: false, error: 'State mismatch' })
    }

    if (!authCode) {
      return res.status(400).json({ success: false, error: 'Authorization code required' })
    }

    await codexAccountService.completeBrowserAuthorization(sessionId, { code: authCode })
    res.json({ success: true, status: 'completed' })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// 查询浏览器 OAuth session 状态
router.get('/oauth/browser/status/:sessionId', async (req, res) => {
  try {
    const result = await codexAccountService.getOAuthSessionProgress(req.params.sessionId)
    if (!result) return res.status(404).json({ success: false, error: 'Session not found' })
    res.json({ success: true, ...result })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// OAuth 回调（redirect_uri 指向这里）
router.get('/oauth/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query || {}
    const codeValue = Array.isArray(code) ? code[0] : code
    const stateValue = Array.isArray(state) ? state[0] : state
    const errorValue = Array.isArray(error) ? error[0] : error
    const errorDescriptionValue = Array.isArray(error_description) ? error_description[0] : error_description

    if (errorValue) {
      const msg = `${errorValue}${errorDescriptionValue ? `: ${errorDescriptionValue}` : ''}`
      if (stateValue) await codexAccountService.setOAuthSessionError(stateValue, msg)
      return res
        .status(400)
        .send(`<html><body><h3>OAuth 登录失败</h3><pre>${escapeHtml(msg)}</pre></body></html>`)
    }

    if (!stateValue) {
      return res.status(400).send('<html><body><h3>OAuth 回调缺少参数: state</h3></body></html>')
    }

    if (!codeValue) {
      await codexAccountService.setOAuthSessionError(stateValue, 'OAuth 回调缺少参数: code')
      return res.status(400).send('<html><body><h3>OAuth 回调缺少参数: code</h3></body></html>')
    }

    await codexAccountService.completeBrowserAuthorization(stateValue, { code: String(codeValue) })
    res.send('<html><body><h3>OAuth 授权成功</h3><p>你可以关闭此页面，回到管理界面继续创建账户。</p></body></html>')
  } catch (e) {
    res.status(500).send(`<html><body><h3>OAuth 回调处理失败</h3><pre>${String(e.message || e)}</pre></body></html>`)
  }
})

// ==================== 账户管理 API ====================

router.get('/accounts', async (req, res) => {
  try {
    const accounts = await codexAccountService.getAllAccounts()
    res.json({ success: true, accounts })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

router.post('/accounts', async (req, res) => {
  try {
    const account = await codexAccountService.createAccount(req.body)
    res.json({ success: true, account })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// ==================== API Key 管理（管理员） ====================

router.get('/keys', async (req, res) => {
  try {
    const keys = await apiKeyService.getAllApiKeys()
    res.json({ success: true, keys })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

router.post('/keys', async (req, res) => {
  try {
    const { name, permissions, enabled, accountId, routingMode } = req.body || {}
    const normalizedRoutingMode = String(routingMode || '').trim().toLowerCase() === 'dedicated'
      ? 'dedicated'
      : 'shared'
    const normalizedAccountId = normalizedRoutingMode === 'dedicated'
      ? String(accountId || '').trim()
      : ''

    if (normalizedRoutingMode === 'dedicated') {
      if (!normalizedAccountId) {
        return res.status(400).json({ success: false, error: 'Dedicated keys require a dedicated account' })
      }

      const account = await codexAccountService.getAccount(normalizedAccountId)
      if (!account) {
        return res.status(400).json({ success: false, error: `Account not found: ${normalizedAccountId}` })
      }

      if (normalizeAccountType(account) !== 'dedicated') {
        return res.status(400).json({ success: false, error: 'Dedicated keys can only bind dedicated accounts' })
      }
    }

    const key = await apiKeyService.createApiKey({
      name,
      permissions,
      enabled,
      routingMode: normalizedRoutingMode,
      accountId: normalizedAccountId
    })
    res.json({ success: true, key })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

router.delete('/keys/:keyId', async (req, res) => {
  try {
    const ok = await apiKeyService.deleteApiKey(req.params.keyId)
    if (!ok) return res.status(404).json({ success: false, error: 'Key not found' })
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// 从本机 Codex CLI 导入 ~/.codex/auth.json
router.post('/accounts/import/local', async (req, res) => {
  try {
    const { filePath, name, description, priority, accountType, poolType } = req.body || {}
    const result = await codexAccountService.importFromLocalCodexAuthFile({
      filePath,
      name,
      description,
      priority,
      accountType: accountType || 'shared',
      poolType
    })
    res.json({ success: true, ...result })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

router.get('/accounts/:accountId', async (req, res) => {
  try {
    const account = await codexAccountService.getAccount(req.params.accountId)
    if (!account) {
      return res.status(404).json({ success: false, error: 'Account not found' })
    }
    res.json({ success: true, account })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

router.put('/accounts/:accountId', async (req, res) => {
  try {
    await codexAccountService.updateAccount(req.params.accountId, req.body)
    res.json({ success: true, message: 'Account updated' })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

router.delete('/accounts/:accountId', async (req, res) => {
  try {
    await codexAccountService.deleteAccount(req.params.accountId)
    res.json({ success: true, message: 'Account deleted' })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

router.post('/accounts/:accountId/refresh', async (req, res) => {
  try {
    await codexAccountService.refreshToken(req.params.accountId)
    res.json({ success: true, message: 'Token refreshed' })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

router.post('/accounts/:accountId/reset-status', async (req, res) => {
  try {
    await codexAccountService.resetAccountStatus(req.params.accountId)
    res.json({ success: true, message: 'Account status reset' })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// ==================== 统计 API ====================

router.get('/stats', async (req, res) => {
  try {
    const relayStats = codexRelayService.getStats()
    const accountStats = await codexAccountService.getStats()
    res.json({
      success: true,
      stats: {
        relay: relayStats,
        accounts: accountStats
      }
    })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'codex-relay',
    timestamp: new Date().toISOString()
  })
})

module.exports = router
