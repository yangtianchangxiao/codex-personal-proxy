/**
 * Codex Routes - 独立版本
 * 处理 OpenAI Codex CLI 的所有请求
 */

const express = require('express')
const router = express.Router()
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

// ==================== API 转发 ====================

router.all('/v1/*', async (req, res) => {
  await codexRelayService.relayRequest(req, res)
})

router.all('/backend-api/*', async (req, res) => {
  await codexRelayService.relayChatGPTBackend(req, res)
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
