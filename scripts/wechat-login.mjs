/**
 * WeChat (iLink / ClawBot) QR login probe.
 *
 * Prints the QR payload URL, then long-polls the QR status until the phone
 * confirms, and stores the bot token in `~/.dsh/wechat-channel.json` (0600).
 *
 * Usage:
 *   node scripts/wechat-login.mjs            # print the QR URL and wait
 *   node scripts/wechat-login.mjs --qr       # also render a scannable QR (terminal + PNG)
 *   node scripts/wechat-login.mjs --status   # read the saved credential
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { renderQr } from './wechat-qr.mjs'

const BASE = 'https://ilinkai.weixin.qq.com'
const APP_ID = 'bot'
const CLIENT_VERSION = '2.4.10'
const BOT_TYPE = '3'
const POLL_TIMEOUT_MS = 35_000
const STATE_PATH = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'wechat-channel.json')

const encodeVersion = (version) => {
  const [major = 0, minor = 0, patch = 0] = String(version).split('.').map((part) => parseInt(part, 10) || 0)
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}
const baseInfo = () => ({ channel_version: CLIENT_VERSION, bot_agent: 'DSH/0.1' })
const commonHeaders = () => ({
  'iLink-App-Id': APP_ID,
  'iLink-App-ClientVersion': String(encodeVersion(CLIENT_VERSION)),
})
const authHeaders = (token) => ({
  'Content-Type': 'application/json',
  AuthorizationType: 'ilink_bot_token',
  'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
  ...commonHeaders(),
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
})

async function post(path, body, { token, timeoutMs = 15_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE}/${path}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : {}
  } finally {
    clearTimeout(timer)
  }
}

async function get(path, { timeoutMs = POLL_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE}/${path}`, { method: 'GET', headers: commonHeaders(), signal: controller.signal })
    const text = await res.text()
    if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : {}
  } finally {
    clearTimeout(timer)
  }
}

function saveCredential(payload) {
  mkdirSync(dirname(STATE_PATH), { recursive: true })
  writeFileSync(STATE_PATH, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
}

function readCredential() {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')) } catch { return undefined }
}

if (process.argv.includes('--status')) {
  const saved = readCredential()
  if (!saved?.botToken) {
    console.log('NOT_LOGGED_IN')
    process.exit(1)
  }
  console.log(JSON.stringify({ loggedIn: true, accountId: saved.accountId, userId: saved.userId, baseUrl: saved.baseUrl, savedAt: saved.savedAt }))
  process.exit(0)
}

async function fetchQr() {
  const response = await post(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`, { local_token_list: [] })
  return { qrcode: response.qrcode, url: response.qrcode_img_content }
}

const WANT_QR = process.argv.includes('--qr')

async function showQr(qr) {
  console.log(`QR_URL:${qr.url}`)
  console.log(`QR_ID:${qr.qrcode}`)
  if (!WANT_QR) return
  // The PNG is the only form a phone can scan; it lands next to the credential.
  const rendered = await renderQr(qr.url, { out: join(dirname(STATE_PATH), 'wechat-qr.png') })
  console.log(rendered ? `PNG:${rendered.png}` : 'QR_PNG:skipped')
}

async function main() {
  let qr = await fetchQr()
  await showQr(qr)
  console.log('WAITING_FOR_SCAN')

  const deadline = Date.now() + 5 * 60_000
  let refreshes = 0
  while (Date.now() < deadline) {
    let status
    try {
      status = await get(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`)
    } catch (error) {
      if (error?.name === 'AbortError') { status = { status: 'wait' } } else { console.log(`POLL_ERROR:${String(error).slice(0, 200)}`); status = { status: 'wait' } }
    }
    const kind = String(status?.status ?? 'wait')
    if (kind !== 'wait') console.log(`STATUS:${kind}`)
    if (kind === 'confirmed') {
      if (!status.ilink_bot_id || !status.bot_token) {
        console.log('LOGIN_FAILED:missing bot id/token')
        process.exit(1)
      }
      const saved = {
        botToken: status.bot_token,
        accountId: status.ilink_bot_id,
        userId: status.ilink_user_id ?? '',
        baseUrl: String(status.baseurl ?? BASE).trim() || BASE,
        savedAt: new Date().toISOString(),
      }
      saveCredential(saved)
      console.log(`LOGIN_OK account=${saved.accountId} user=${saved.userId} base=${saved.baseUrl}`)
      process.exit(0)
    }
    if (kind === 'expired') {
      refreshes += 1
      if (refreshes > 3) { console.log('LOGIN_FAILED:qr expired too many times'); process.exit(1) }
      qr = await fetchQr()
      await showQr(qr)
      console.log('QR_REFRESHED')
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  console.log('LOGIN_FAILED:timeout')
  process.exit(1)
}

main().catch((error) => {
  console.log(`LOGIN_FAILED:${String(error).slice(0, 300)}`)
  process.exit(1)
})
