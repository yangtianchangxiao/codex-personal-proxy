const { HttpsProxyAgent } = require('https-proxy-agent')

let cachedAgent = null
let cachedProxyUrl = null

function getDirectHosts() {
  const raw = String(
    process.env.CODEX_DIRECT_HOSTS || 'api.openai.com,chatgpt.com'
  )

  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

function getProxyUrl() {
  return process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''
}

function shouldBypassProxy(targetUrl) {
  try {
    const { hostname } = new URL(targetUrl)
    const normalizedHostname = String(hostname || '').trim().toLowerCase()
    if (normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1') return true

    const directHosts = getDirectHosts()
    if (directHosts.some((entry) => normalizedHostname === entry || normalizedHostname.endsWith(`.${entry}`))) {
      return true
    }

    const noProxyRaw = process.env.NO_PROXY || process.env.no_proxy || ''
    if (!noProxyRaw) return false

    const noProxy = noProxyRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    if (noProxy.includes('*')) return true
    return noProxy.some((entry) => entry === normalizedHostname || (entry.startsWith('.') && normalizedHostname.endsWith(entry)))
  } catch {
    return false
  }
}

function getProxyAgent(targetUrl) {
  const proxyUrl = getProxyUrl()
  if (!proxyUrl) return null
  if (targetUrl && shouldBypassProxy(targetUrl)) return null

  if (cachedAgent && cachedProxyUrl === proxyUrl) return cachedAgent
  cachedProxyUrl = proxyUrl
  cachedAgent = new HttpsProxyAgent(proxyUrl)
  return cachedAgent
}

module.exports = {
  getProxyAgent
}
