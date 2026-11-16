/**
 * WeChat (iLink / 微信 ClawBot) transport adapter for the DSH channel framework.
 *
 * Protocol facts are taken from Tencent's official client
 * (`@tencent-weixin/openclaw-weixin`, MIT) and verified live with
 * `scripts/wechat-e2e.mjs`:
 *
 *   - login:  QR scan → `bot_token` + `ilink_bot_id` (+ `baseurl`)
 *   - inbound: long-poll `ilink/bot/getupdates` with a `get_updates_buf` cursor
 *   - outbound: `ilink/bot/sendmessage`, echoing the inbound `context_token`
 *   - typing: `ilink/bot/getconfig` → `typing_ticket`, then `ilink/bot/sendtyping`
 *   - media: CDN, AES-128-ECB; inbound payloads may arrive *without* PKCS#7
 *     padding, so decryption runs with `setAutoPadding(false)`
 *
 * There is no editable message and no card, so `card.*` is implemented on top of
 * `text-stream.js`: a turn is delivered as ONE plain-text message (progress notes
 * while it runs, then the whole answer), and only an answer over the size cap is
 * continued in a second message.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'

import { createTextStream, streamLimitsFromConfig } from './text-stream.js'

const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com'
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c'
const CLIENT_VERSION = '2.4.10'
const APP_ID = 'bot'
const POLL_TIMEOUT_MS = 35_000
const API_TIMEOUT_MS = 15_000
const FILE_TTL_MS = 10_000
const MAX_INBOUND_BYTES = 100 * 1024 * 1024
// A long poll that never completes looks exactly like a quiet chat, and iLink has
// no history endpoint to catch up from afterwards. Two timers are the only way to
// tell the difference: one rebuilds a loop that stopped completing polls, the
// other re-primes a cursor that looks stuck.
const POLL_STALL_MS = 120_000
const IDLE_CURSOR_RESET_MS = 20 * 60_000
const CURSOR_RESET_LOOKBACK_MS = 30 * 60_000
const POLL_WATCHDOG_MS = 30_000

const UPLOAD_IMAGE = 1
const UPLOAD_FILE = 3
const ITEM_TEXT = 1
const ITEM_IMAGE = 2
const ITEM_FILE = 4
const MSG_TYPE_BOT = 2
const MSG_STATE_FINISH = 2
const TYPING_ON = 1
const TYPING_OFF = 2

const homeDir = () => String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
export const wechatCredentialsFilePath = () => join(homeDir(), 'wechat-channel.json')
const contextTokenPath = () => join(homeDir(), 'wechat-context-tokens.json')
const mediaDir = () => join(homeDir(), 'wechat-inbound-files')

const firstNonEmpty = (...values) => {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return ''
}

let credentialCache = { path: '', readAt: 0, value: {} }
function readCredentials() {
  const path = wechatCredentialsFilePath()
  const now = Date.now()
  if (credentialCache.path === path && now - credentialCache.readAt < FILE_TTL_MS) return credentialCache.value
  let value = {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed
  } catch { value = {} }
  credentialCache = { path, readAt: now, value }
  return value
}

/** Row config > environment > `~/.dsh/wechat-channel.json`. */
export function resolveWechatSettings(config = {}) {
  const file = readCredentials()
  const accountId = firstNonEmpty(config.accountId, process.env.WECHAT_ACCOUNT_ID, file.accountId)
  const botToken = firstNonEmpty(config.botToken, process.env.WECHAT_BOT_TOKEN, file.botToken)
  const userId = firstNonEmpty(config.defaultChatId, file.userId)
  const baseUrl = firstNonEmpty(config.baseUrl, file.baseUrl, DEFAULT_BASE).replace(/\/$/, '')
  return {
    configured: Boolean(accountId && botToken),
    accountId,
    botToken,
    defaultChatId: userId,
    userId,
    baseUrl,
    // The framework's readiness check reads appId/appSecret; map them so the
    // shared tool plumbing keeps working without a WeChat special case.
    appId: accountId,
    appSecret: botToken,
    region: '',
  }
}

const TYPING_TICKET_TTL_MS = 24 * 60 * 60 * 1000
const STALE_TOKEN_ERRCODE = -14
const SESSION_PAUSE_MS = 60 * 60 * 1000
const SYNC_TIMEOUT_MIN_MS = 5_000
const SYNC_TIMEOUT_MAX_MS = 120_000

/** `get_updates_buf` cursor, persisted per account so a restart resumes cleanly. */
export const wechatSyncFilePath = () => join(homeDir(), 'wechat-sync.json')
export function loadWechatCursor(accountId) {
  try {
    const parsed = JSON.parse(readFileSync(wechatSyncFilePath(), 'utf8'))
    if (parsed?.accountId && parsed.accountId !== accountId) return ''
    return typeof parsed?.cursor === 'string' ? parsed.cursor : ''
  } catch { return '' }
}
export function saveWechatCursor(accountId, cursor) {
  if (!accountId) return
  try {
    writeFileSync(wechatSyncFilePath(), JSON.stringify({ accountId, cursor, savedAt: Date.now() }), { mode: 0o600 })
  } catch { /* best effort */ }
}

/**
 * errcode -14 means the bot token is stale: WeChat asks clients to stop calling
 * for a while instead of hammering the API. One hour matches the official
 * client; every send reports it clearly rather than failing silently.
 */
const pause = { accountId: '', until: 0 }
function pauseSession(accountId) {
  pause.accountId = accountId
  pause.until = Date.now() + SESSION_PAUSE_MS
}
export function wechatSessionPaused(accountId) {
  if (!pause.until) return 0
  if (pause.until <= Date.now()) { pause.until = 0; pause.accountId = ''; return 0 }
  if (accountId && pause.accountId && pause.accountId !== accountId) return 0
  return pause.until
}
export const _resetWechatPauseForTest = () => { pause.accountId = ''; pause.until = 0 }

/**
 * Live long-poll health, exposed by `checkStatus` and `/status`.
 *
 * `lastOkAt` is the last completed `getupdates`; `rebuilds` counts the times the
 * watchdog had to abort a poll that never returned; `cursorResets` counts the
 * idle re-primes of `get_updates_buf`.
 */
const pollHealth = { lastOkAt: 0, rebuilds: 0, cursorResets: 0 }
export function wechatPollHealth() {
  return { ...pollHealth, stalled: pollHealth.lastOkAt > 0 && Date.now() - pollHealth.lastOkAt > POLL_STALL_MS }
}
export const _resetWechatPollHealthForTest = () => { pollHealth.lastOkAt = 0; pollHealth.rebuilds = 0; pollHealth.cursorResets = 0 }

const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  const onAbort = () => { clearTimeout(timer); resolve() }
  try { signal?.addEventListener?.('abort', onAbort, { once: true }) } catch { /* ignore */ }
})

const encodeVersion = (version) => {
  const [major = 0, minor = 0, patch = 0] = String(version).split('.').map((part) => parseInt(part, 10) || 0)
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}
const baseInfo = () => ({ channel_version: CLIENT_VERSION, bot_agent: 'DSH/0.1' })
const authHeaders = (token) => ({
  'Content-Type': 'application/json',
  AuthorizationType: 'ilink_bot_token',
  'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
  'iLink-App-Id': APP_ID,
  'iLink-App-ClientVersion': String(encodeVersion(CLIENT_VERSION)),
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
})

const ID_KEYS = new Set(['message_id', 'msg_id', 'svr_id'])

/**
 * Parse an iLink response without losing 64-bit message ids.
 *
 * The protocol sends message_id as a JSON number; a 19-digit id exceeds
 * Number.MAX_SAFE_INTEGER, so JSON.parse would round it and two messages could
 * share one dedupe key. The official client quotes these fields before parsing.
 */
export function parseWeixinJson(raw) {
  const text = String(raw ?? '')
  if (!text) return {}
  const quoted = text.replace(
    /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*(-?\d{16,})/g,
    (match, key, digits) => (ID_KEYS.has(key) ? `"${key}": "${digits}"` : match),
  )
  return JSON.parse(quoted)
}
async function post(settings, path, body, timeoutMs = API_TIMEOUT_MS, externalSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onExternalAbort = () => controller.abort()
  try { externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true }) } catch { /* ignore */ }
  try {
    const res = await fetch(`${settings.baseUrl}/${path}`, {
      method: 'POST',
      headers: authHeaders(settings.botToken),
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`)
    return text ? parseWeixinJson(text) : {}
  } finally {
    clearTimeout(timer)
    try { externalSignal?.removeEventListener?.('abort', onExternalAbort) } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// context tokens + typing tickets (per user, persisted)
// ---------------------------------------------------------------------------

const contextTokens = new Map()
let contextTokensLoaded = false
function loadContextTokens() {
  if (contextTokensLoaded) return
  contextTokensLoaded = true
  try {
    const parsed = JSON.parse(readFileSync(contextTokenPath(), 'utf8'))
    for (const [userId, token] of Object.entries(parsed ?? {})) {
      if (typeof token === 'string' && token) contextTokens.set(userId, token)
    }
  } catch { /* first run */ }
}
/**
 * Text of the message the user quoted, if any.
 *
 * iLink puts the reference on the item itself (`item.ref_msg`): a title plus the
 * quoted message's items. There is no quote store on our side, so only what the
 * protocol carries is restored — which is what a "回复" bubble shows on the
 * phone anyway.
 */
export function quoteTextOf(items) {
  const item = (Array.isArray(items) ? items : []).find((entry) => entry?.ref_msg)
  const ref = item?.ref_msg
  if (!ref) return ''
  const parts = []
  if (typeof ref.title === 'string' && ref.title.trim()) parts.push(ref.title.trim())
  const refItems = Array.isArray(ref.message_item?.item_list) ? ref.message_item.item_list : []
  const refText = refItems
    .filter((entry) => entry?.type === ITEM_TEXT)
    .map((entry) => String(entry.text_item?.text ?? ''))
    .join('\n')
    .trim()
  if (refText) parts.push(refText)
  if (parts.length === 0) {
    const kinds = refItems.map((entry) => entry?.type)
    if (kinds.includes(ITEM_IMAGE)) parts.push('[图片]')
    else if (kinds.includes(ITEM_FILE)) parts.push('[文件]')
    else parts.push('[引用消息]')
  }
  return parts.join(' | ')
}

function rememberContextToken(userId, token) {
  if (!userId || !token) return
  loadContextTokens()
  contextTokens.set(userId, token)
  persistContextTokens()
}
function persistContextTokens() {
  try {
    mkdirSync(join(homeDir()), { recursive: true })
    writeFileSync(contextTokenPath(), JSON.stringify(Object.fromEntries(contextTokens), null, 2), { mode: 0o600 })
  } catch { /* best effort */ }
}
const contextTokenOf = (userId) => {
  loadContextTokens()
  return contextTokens.get(userId) ?? ''
}
function forgetContextToken(userId) {
  loadContextTokens()
  contextTokens.delete(userId)
  persistContextTokens()
}

/**
 * WeChat's own text limit is undocumented; the client shows one bubble per
 * message, so keep each one under a comfortable reading size and split on a
 * paragraph/sentence boundary when the text is longer.
 */
export function splitForWechat(text, limit = 1800) {
  const value = String(text ?? '')
  if (value.length <= limit) return [value]
  const parts = []
  let rest = value
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit)
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.4) {
      const sentence = rest.lastIndexOf('。', limit)
      if (sentence >= 0) cut = sentence + 1
    }
    if (cut < limit * 0.3) cut = limit
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) parts.push(rest)
  return parts
}

const typingTickets = new Map()
async function typing(settings, userId, contextToken, status) {
  try {
    const cached = typingTickets.get(userId)
    let ticket = cached && Date.now() - cached.at < TYPING_TICKET_TTL_MS ? cached.ticket : ''
    const token = contextToken || contextTokenOf(userId)
    if (!ticket && token) {
      const response = await post(settings, 'ilink/bot/getconfig', {
        ilink_user_id: userId, context_token: token, base_info: baseInfo(),
      }, 10_000)
      ticket = response?.typing_ticket
      // The official client refreshes this within 24 h; a stale ticket only
      // breaks the indicator, never delivery, so failures stay quiet.
      if (ticket) typingTickets.set(userId, { ticket, at: Date.now() })
    }
    if (!ticket) return { ok: false, reason: 'no typing_ticket' }
    await post(settings, 'ilink/bot/sendtyping', {
      ilink_user_id: userId, typing_ticket: ticket, status, base_info: baseInfo(),
    }, 10_000)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String(error).slice(0, 120) }
  }
}

// ---------------------------------------------------------------------------
// media: AES-128-ECB, tolerant of unpadded inbound payloads
// ---------------------------------------------------------------------------

export function parseAesKey(value) {
  const text = String(value ?? '').trim()
  if (!text) return undefined
  if (/^[0-9a-fA-F]{32}$/.test(text)) return Buffer.from(text, 'hex')
  const decoded = Buffer.from(text, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  return undefined
}

export function decryptMedia(cipher, key, { encrypted = true } = {}) {
  if (!encrypted || !key) return cipher
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  decipher.setAutoPadding(false)
  const raw = Buffer.concat([decipher.update(cipher), decipher.final()])
  const pad = raw[raw.length - 1]
  if (pad > 0 && pad <= 16 && raw.length % 16 === 0) {
    let valid = true
    for (let at = raw.length - pad; at < raw.length; at += 1) {
      if (raw[at] !== pad) { valid = false; break }
    }
    if (valid) return raw.subarray(0, raw.length - pad)
  }
  return raw
}

const aesEncrypt = (plain, key) => Buffer.concat([createCipheriv('aes-128-ecb', key, null).update(plain), createCipheriv('aes-128-ecb', key, null).final()])
const paddedSize = (size) => Math.ceil((size + 1) / 16) * 16

// Inbound media is referenced by a short key the framework passes back to
// `downloadImage`/`downloadFile`; remember the CDN reference per key.
const pendingMedia = new Map()

async function downloadToFile(media, key, fallbackName) {
  const url = media.full_url?.trim()
    || `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param ?? '')}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`media download ${res.status}`)
  const cipher = Buffer.from(await res.arrayBuffer())
  if (cipher.length > MAX_INBOUND_BYTES) throw new Error('media too large')
  const plain = decryptMedia(cipher, key)
  mkdirSync(mediaDir(), { recursive: true })
  const target = join(mediaDir(), fallbackName || `${Date.now()}-${randomUUID().slice(0, 8)}.bin`)
  writeFileSync(target, plain)
  return target
}

async function uploadMedia(settings, plain, { mediaType, fileName, toUserId }) {
  const rawsize = plain.length
  const rawfilemd5 = createHash('md5').update(plain).digest('hex')
  const filesize = paddedSize(rawsize)
  const filekey = randomBytes(16).toString('hex')
  const aeskey = randomBytes(16)
  const response = await post(settings, 'ilink/bot/getuploadurl', {
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString('hex'),
    base_info: baseInfo(),
  })
  const uploadUrl = response.upload_full_url?.trim()
    || `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(response.upload_param ?? '')}&filekey=${encodeURIComponent(filekey)}`
  const cipher = aesEncrypt(plain, aeskey)
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(cipher),
  })
  if (res.status !== 200) throw new Error(`cdn upload ${res.status}`)
  const downloadParam = res.headers.get('x-encrypted-param')
  if (!downloadParam) throw new Error('cdn upload missing x-encrypted-param')
  return {
    filekey,
    encryptQueryParam: downloadParam,
    aesKeyBase64: Buffer.from(aeskey.toString('hex')).toString('base64'),
    cipherSize: filesize,
    size: rawsize,
    fileName,
  }
}

// ---------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------

/**
 * Build the WeChat adapter.
 * `deps.log` receives `{ event, result, ... }` records for the diagnostics log.
 */
export function createWechatProvider(config = {}, deps = {}) {
  const log = deps.log ?? (() => {})
  const streams = new Map()
  let lastContentByCard = new Map()

  // WeChat has no message editing: a turn is one bubble, not a paragraph feed.
  // Only the hard size cap still splits, so a very long answer survives the
  // client's per-message limit.
  const streamLimits = {
    ...streamLimitsFromConfig(config),
    minParagraphChars: Number.POSITIVE_INFINITY,
    minSentenceChars: Number.POSITIVE_INFINITY,
    firstSegmentChars: Number.POSITIVE_INFINITY,
  }
  const settingsOf = () => resolveWechatSettings(config)

  async function runActions(stream, actions) {
    for (const action of actions) {
      if (action.kind === 'typing') {
        const result = await typing(settingsOf(), stream.chatId, stream.contextToken, action.on ? TYPING_ON : TYPING_OFF)
        if (!result.ok) log({ event: 'typing', result: 'failed', reason: result.reason })
        continue
      }
      if (action.kind === 'send') {
        try {
          await sendText({ chatId: stream.chatId, text: action.text })
          log({ event: 'text-stream', result: 'sent', tag: action.tag, chars: action.text.length })
        } catch (error) {
          log({ event: 'text-stream', result: 'failed', tag: action.tag, reason: String(error).slice(0, 200) })
        }
        continue
      }
      if (action.kind === 'truncated') {
        // Long answers travel as a file instead of forty bubbles.
        try {
          const path = join(mediaDir(), `reply-${Date.now()}.md`)
          mkdirSync(mediaDir(), { recursive: true })
          writeFileSync(path, String(action.text ?? ''))
          await sendAttachment({ chatId: stream.chatId, path, name: basename(path) })
          await sendText({ chatId: stream.chatId, text: `内容太长，剩下的已作为文件发在上面（${action.remaining} 字）。` })
          log({ event: 'text-stream', result: 'file-sent', remaining: action.remaining })
        } catch (error) {
          log({ event: 'text-stream', result: 'file-failed', reason: String(error).slice(0, 200) })
        }
      }
    }
  }

  async function sendMessage(chatId, items, { omitContextToken = false, clientId, state = MSG_STATE_FINISH } = {}) {
    const settings = settingsOf()
    if (!settings.configured) throw new Error('微信通道未配置：缺少 botToken/accountId')
    const pausedUntil = wechatSessionPaused(settings.accountId)
    if (pausedUntil) {
      throw new Error(`微信会话已暂停（errcode -14），${Math.ceil((pausedUntil - Date.now()) / 60_000)} 分钟后重试；重新扫码登录可立即恢复`)
    }
    const response = await post(settings, 'ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: chatId,
        client_id: clientId || `dsh-wechat-${randomUUID()}`,
        message_type: MSG_TYPE_BOT,
        message_state: state,
        item_list: items,
        context_token: omitContextToken ? undefined : (contextTokenOf(chatId) || undefined),
      },
      base_info: baseInfo(),
    })
    if (response.ret && response.ret !== 0) throw new Error(`send ret=${response.ret} ${response.errmsg ?? ''}`)
    return response?.message_id ?? ''
  }

  async function sendText({ chatId, text }) {
    const body = String(text ?? '')
    if (!body.trim()) return { ok: true, messageId: '', chatId }
    let messageId = ''
    for (const chunk of splitForWechat(body)) {
      try {
        messageId = await sendMessage(chatId, [{ type: ITEM_TEXT, text_item: { text: chunk } }])
      } catch (error) {
        // A context token is issued per inbound message. A send without one is
        // rejected ("prepare failed"), but keep the token anyway: deleting it
        // would make every later reply impossible until the user speaks again.
        if (!contextTokenOf(chatId)) throw error
        log({ event: 'send', result: 'retry-without-context', reason: String(error).slice(0, 160) })
        messageId = await sendMessage(chatId, [{ type: ITEM_TEXT, text_item: { text: chunk } }], { omitContextToken: true })
      }
    }
    return { ok: true, messageId, chatId }
  }

  // -------------------------------------------------------------------------
  // Streaming: WeChat has no message edit, but a repeated `sendmessage` with the
  // same `client_id` and `message_state: GENERATING` updates the same bubble in
  // place (verified on the phone), so one answer can grow live instead of being
  // split into a feed of paragraphs. FINISH marks it done.
  // -------------------------------------------------------------------------
  const STREAM_INTERVAL_MS = Number(config.streamIntervalMs) >= 0 ? Number(config.streamIntervalMs) : 900
  const MAX_STREAM_CHARS = 4000
  const STREAMING_STATE = 1

  async function sendStreaming(stream, text, final) {
    const clipped = text.length > MAX_STREAM_CHARS ? text.slice(0, MAX_STREAM_CHARS) : text
    const messageId = await sendMessage(
      stream.chatId,
      [{ type: ITEM_TEXT, text_item: { text: clipped } }],
      { clientId: stream.clientId, state: final ? MSG_STATE_FINISH : STREAMING_STATE },
    )
    stream.lastSentAt = Date.now()
    stream.lastSentText = text
    stream.sentAny = true
    log({ event: 'stream', result: final ? 'finish' : 'update', chars: clipped.length })
    return messageId
  }

  async function flushStream(stream, final = false) {
    const text = String(stream.lastText ?? '')
    if (!text.trim()) return
    if (!final && text === stream.lastSentText) return
    await sendStreaming(stream, text, final)
  }

  function scheduleStreamFlush(stream, delay) {
    if (stream.timer) return
    stream.timer = setTimeout(() => {
      stream.timer = undefined
      // A failed update must not become an unhandled rejection: the final
      // FINISH still carries the whole answer.
      void flushStream(stream).catch((error) => {
        log({ event: 'stream', result: 'failed', reason: String(error).slice(0, 200) })
      })
    }, Math.max(0, delay))
    stream.timer.unref?.()
  }

  async function sendAttachment({ chatId, path, name }) {
    const plain = readFileSync(path)
    const ext = extname(name ?? path).toLowerCase()
    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)
    const uploaded = await uploadMedia(settingsOf(), plain, {
      mediaType: isImage ? UPLOAD_IMAGE : UPLOAD_FILE,
      fileName: name ?? basename(path),
      toUserId: chatId,
    })
    const media = {
      encrypt_query_param: uploaded.encryptQueryParam,
      aes_key: uploaded.aesKeyBase64,
      encrypt_type: 1,
    }
    const item = isImage
      ? { type: ITEM_IMAGE, image_item: { media, mid_size: uploaded.cipherSize } }
      : { type: ITEM_FILE, file_item: { media, file_name: uploaded.fileName, len: String(uploaded.size) } }
    const messageId = await sendMessage(chatId, [item])
    return { ok: true, kind: isImage ? 'image' : 'file', key: uploaded.filekey, messageId, bytes: uploaded.size, chatId }
  }

  return {
    id: 'wechat',
    label: '微信',
    // A plain-text channel accepts any message as a question's supplement.
    freeTextAnswers: true,
    credentialsFilePath: wechatCredentialsFilePath,

    settings: () => settingsOf(),
    async settingsAsync() { return settingsOf() },

    async checkStatus() {
      const settings = settingsOf()
      if (!settings.configured) {
        return { configured: false, tokenOk: false, defaultChatId: '', baseUrl: settings.baseUrl, error: '缺少 botToken/accountId' }
      }
      try {
        const response = await post(settings, 'ilink/bot/msg/notifystart', { base_info: baseInfo() }, 10_000)
        return {
          configured: true,
          tokenOk: (response.ret ?? 0) === 0,
          defaultChatId: settings.defaultChatId,
          baseUrl: settings.baseUrl,
          accountId: settings.accountId,
          // The long poll is the only inbound path and has no history API, so
          // this is the only honest answer to "is it still receiving?".
          poll: wechatPollHealth(),
        }
      } catch (error) {
        return {
          configured: true, tokenOk: false, defaultChatId: settings.defaultChatId,
          baseUrl: settings.baseUrl, error: String(error).slice(0, 200), poll: wechatPollHealth(),
        }
      }
    },

    sendText,
    sendAttachment,

    parseInbound(message) {
      const chatId = String(message?.from_user_id ?? '')
      const messageId = String(message?.message_id ?? '')
      const chatType = String(message?.chattype ?? message?.chat_type ?? 'single') || 'single'
      if (chatType !== 'single') {
        // v1 is one person ↔ one session, like the Feishu side. A group message
        // must be dropped loudly instead of answering the wrong chat.
        return {
          dedupeKey: messageId,
          chatId: String(message?.chatid ?? ''),
          chatType,
          senderId: chatId,
          senderType: 'user',
          messageId,
          text: '',
          imageKeys: [],
          files: [],
          unsupported: `chat:${chatType}`,
        }
      }
      const items = Array.isArray(message?.item_list) ? message.item_list : []
      const textItem = items.find((item) => item?.type === ITEM_TEXT)
      const imageKeys = []
      const files = []
      let unsupported = ''
      items.forEach((item, index) => {
        if (item?.type === ITEM_IMAGE && item.image_item?.media) {
          const key = `${messageId}:${index}`
          pendingMedia.set(key, { kind: 'image', media: item.image_item.media, aeskey: item.image_item.aeskey })
          imageKeys.push(key)
        } else if (item?.type === ITEM_FILE && item.file_item?.media) {
          const key = `${messageId}:${index}`
          pendingMedia.set(key, { kind: 'file', media: item.file_item.media, fileName: item.file_item.file_name })
          files.push({ fileKey: key, fileName: String(item.file_item.file_name ?? 'file.bin') })
        } else if (item?.type && ![ITEM_TEXT, ITEM_IMAGE, ITEM_FILE].includes(item.type)) {
          unsupported = unsupported || `type:${item.type}`
        }
      })
      if (message?.context_token) rememberContextToken(chatId, String(message.context_token))
      const quoted = quoteTextOf(items)
      const bodyText = String(textItem?.text_item?.text ?? '')
      return {
        dedupeKey: messageId,
        chatId,
        chatType: 'single',
        senderId: chatId,
        senderType: 'user',
        messageId,
        // A quoted message is context the agent must see; the protocol already
        // carries it, so fold it into the prompt verbatim.
        text: quoted ? `引用：${quoted}${bodyText ? `\n\n${bodyText}` : ''}` : bodyText,
        imageKeys,
        files,
        unsupported,
      }
    },

    async downloadImage({ imageKey }) {
      const entry = pendingMedia.get(imageKey)
      if (!entry) throw new Error('image reference expired')
      pendingMedia.delete(imageKey)
      const key = parseAesKey(entry.aeskey) ?? parseAesKey(entry.media?.aes_key)
      const path = await downloadToFile(entry.media, key, `image-${Date.now()}${key ? '' : ''}.bin`)
      return path
    },

    async downloadFile({ fileKey, fileName }) {
      const entry = pendingMedia.get(fileKey)
      if (!entry) throw new Error('file reference expired')
      pendingMedia.delete(fileKey)
      const key = parseAesKey(entry.aeskey) ?? parseAesKey(entry.media?.aes_key)
      const safeName = String(fileName || entry.fileName || 'file.bin').replace(/[\\/:*?"<>|]/g, '_')
      return await downloadToFile(entry.media, key, `${Date.now()}-${safeName}`)
    },

    card: {
      async create() {
        const cardId = `wx-${randomUUID()}`
        streams.set(cardId, {
          chatId: '',
          contextToken: '',
          engine: createTextStream({ limits: streamLimits }),
          // One bubble per turn: every GENERATING/FINISH frame below reuses it.
          clientId: `dsh-wechat-${randomUUID()}`,
          lastText: '',
          lastSentText: '',
          lastSentAt: 0,
          timer: undefined,
          sentAny: false,
        })
        lastContentByCard.set(cardId, '')
        return cardId
      },
      async attach({ chatId, cardId }) {
        const stream = streams.get(cardId)
        if (!stream) return ''
        stream.chatId = String(chatId ?? '')
        stream.contextToken = contextTokenOf(stream.chatId)
        await runActions(stream, stream.engine.begin())
        return ''
      },
      async update({ cardId, content, elementId }) {
        const stream = streams.get(cardId)
        if (!stream) return { ok: false }
        // Element writes are card chrome (the 等待回答/流式输出中 footer, tick
        // lines, status notes). A plain-text channel has no elements: treating
        // one as answer text injected "流式输出中" into the chat and shifted the
        // answer offset, so the reply lost its opening characters.
        if (elementId) return { ok: true, ignored: true }
        const text = String(content ?? '')
        // Until the first answer token the framework feeds progressText(): keep
        // that on the throttled progress-bubble path, never the answer bubble.
        if (/^思考中…/.test(text)) {
          await runActions(stream, stream.engine.push(text))
          return { ok: true }
        }
        // Measured on the phone: the client ignores GENERATING frames for a
        // bubble it already painted and only renders the FINISH one, so the
        // in-place "streaming" never showed. Keep the text and send it once at
        // the end instead of producing duplicate bubbles.
        stream.lastText = text
        lastContentByCard.set(cardId, text)
        return { ok: true }
      },
      async close({ cardId, summary }) {
        const stream = streams.get(cardId)
        if (!stream) return { ok: false }
        if (stream.timer) {
          clearTimeout(stream.timer)
          stream.timer = undefined
        }
        const text = String(stream.lastText ?? '')
        try {
          if (text.trim()) {
            // One turn = one message. Only the hard size cap splits, and the
            // overflow goes out as ordinary follow-up messages.
            await flushStream(stream, true)
            if (text.length > MAX_STREAM_CHARS) {
              await sendText({ chatId: stream.chatId, text: text.slice(MAX_STREAM_CHARS) })
            }
          }
        } catch (error) {
          log({ event: 'stream', result: 'finish-failed', reason: String(error).slice(0, 200) })
          // A failed final message is the one failure the user definitely sees:
          // retry once after a beat before giving up.
          await sleep(800)
          try { await flushStream(stream, true) } catch (again) {
            log({ event: 'stream', result: 'finish-failed-again', reason: String(again).slice(0, 200) })
          }
        }
        await runActions(stream, stream.engine.finish(''))
        streams.delete(cardId)
        lastContentByCard.delete(cardId)
        return { ok: true }
      },
      async createRaw() {
        // WeChat has no interactive cards: the framework falls back to text.
        throw new Error('wechat has no interactive card renderer')
      },
    },

    async cotCreate() { return { cotId: '', messageId: '' } },
    async cotWrite() { return { ok: true } },
    async addReaction() { return '' },
    async removeReaction() { return { ok: true } },

    normalizeCardAction() { return null },

    async connect({ onEvent, onState }, signal) {
      const settings = settingsOf()
      let stopped = false
      let ready = false
      // A dispose must also wake a pause/backoff sleep, not wait it out.
      const stopController = new AbortController()
      const wait = (ms) => sleep(ms, stopController.signal)
      const onAbort = () => { stopped = true; stopController.abort() }
      try { signal?.addEventListener?.('abort', onAbort, { once: true }) } catch { /* ignore */ }
      // Lifecycle ping: the official client announces start/stop so the server
      // can drop a dead bot connection sooner.
      void post(settings, 'ilink/bot/msg/notifystart', { base_info: baseInfo() }, 10_000).catch(() => {})
      let cursor = loadWechatCursor(settings.accountId)
      let pollTimeoutMs = POLL_TIMEOUT_MS
      let failures = 0
      // Health: when did a poll last complete, and when did a message last arrive.
      pollHealth.lastOkAt = Date.now()
      pollHealth.rebuilds = 0
      pollHealth.cursorResets = 0
      let lastMessageAt = Date.now()
      let pollController
      let cursorResetPending = false
      const loop = async () => {
        while (!stopped) {
          const pausedUntil = wechatSessionPaused(settings.accountId)
          if (pausedUntil) {
            ready = false
            onState?.({ ready: false, error: `errcode ${STALE_TOKEN_ERRCODE}: paused ${Math.ceil((pausedUntil - Date.now()) / 60_000)} min, re-login with scripts/wechat-login.mjs` })
            await wait(Math.min(60_000, pausedUntil - Date.now()))
            continue
          }
          // Idle re-prime: a cursor that the server no longer honours keeps the
          // poll "successful" and the chat silent forever. Starting from an empty
          // cursor is the documented reset; already answered messages are dropped
          // by message-id dedupe, and the age filter keeps a replay from waking
          // up ancient history.
          if (!cursorResetPending && cursor && Date.now() - lastMessageAt > IDLE_CURSOR_RESET_MS) {
            cursorResetPending = true
            pollHealth.cursorResets += 1
            log({ event: 'channel', result: 'cursor-reset', reason: `no message for ${Math.round((Date.now() - lastMessageAt) / 60_000)} min` })
          }
          const resetting = cursorResetPending
          pollController = new AbortController()
          const onStop = () => pollController.abort()
          try { stopController.signal.addEventListener('abort', onStop, { once: true }) } catch { /* ignore */ }
          try {
            const response = await post(settings, 'ilink/bot/getupdates', {
              get_updates_buf: resetting ? '' : cursor, base_info: baseInfo(),
            }, pollTimeoutMs, pollController.signal)
            const errcode = Number(response.errcode ?? response.ret ?? 0)
            if (errcode === STALE_TOKEN_ERRCODE) {
              // The server asked for a quiet period; pause all requests for an
              // hour instead of looping on the same error.
              pauseSession(settings.accountId)
              ready = false
              onState?.({ ready: false, error: `errcode ${STALE_TOKEN_ERRCODE}: session stale, paused 1h` })
              continue
            }
            if (errcode !== 0) throw new Error(`getupdates ret=${errcode} ${response.errmsg ?? ''}`)
            failures = 0
            pollHealth.lastOkAt = Date.now()
            // The server owns the long-poll window; follow its hint.
            const suggested = Number(response.longpolling_timeout_ms)
            if (Number.isFinite(suggested) && suggested > 0) {
              pollTimeoutMs = Math.min(SYNC_TIMEOUT_MAX_MS, Math.max(SYNC_TIMEOUT_MIN_MS, suggested))
            }
            if (response.get_updates_buf) {
              cursor = response.get_updates_buf
              saveWechatCursor(settings.accountId, cursor)
            }
            if (resetting) cursorResetPending = false
            if (!ready) {
              ready = true
              onState?.({ ready: true })
            }
            const messages = Array.isArray(response.msgs) ? response.msgs : []
            // Only after a reset: ignore anything older than the lookback so a
            // replayed backlog cannot turn into a pile of late answers.
            const cutoff = resetting ? Date.now() - CURSOR_RESET_LOOKBACK_MS : 0
            for (const message of messages) {
              const created = Number(message?.create_time_ms)
              if (cutoff && Number.isFinite(created) && created > 0 && created < cutoff) {
                log({ event: 'inbound', result: 'stale-skipped', messageId: String(message?.message_id ?? '') })
                continue
              }
              lastMessageAt = Date.now()
              try { await onEvent(message) } catch (error) {
                log({ event: 'inbound', result: 'handler-failed', reason: String(error).slice(0, 200) })
              }
            }
            // A server (or a stub) that answers immediately would otherwise spin
            // this loop without ever yielding to timers: an empty batch waits a
            // little so abort/dispose and other timers still run.
            await wait(messages.length > 0 ? 50 : 300)
          } catch (error) {
            if (stopped) return
            if (error?.name === 'AbortError') { await wait(300); continue }
            failures += 1
            ready = false
            onState?.({ ready: false, error: String(error).slice(0, 200) })
            // Same cadence as the official client: retry quickly twice, then
            // back off for 30 s so a broken network does not spin the loop.
            await wait(failures >= 3 ? 30_000 : 2_000)
            if (failures >= 3) failures = 0
          } finally {
            try { stopController.signal.removeEventListener('abort', onStop) } catch { /* ignore */ }
          }
        }
      }
      // Watchdog: a poll that stops completing is invisible in every other
      // signal (the socket looks fine, the process is alive, the chat is quiet).
      // Abort the stuck request so the loop starts a fresh one.
      const watchdog = setInterval(() => {
        if (stopped) return
        if (Date.now() - pollHealth.lastOkAt <= POLL_STALL_MS) return
        pollHealth.rebuilds += 1
        log({ event: 'channel', result: 'rebuild', reason: 'getupdates did not complete in time' })
        onState?.({ ready: false, error: 'getupdates stalled, rebuilding long poll' })
        pollHealth.lastOkAt = Date.now()
        try { pollController?.abort() } catch { /* ignore */ }
      }, POLL_WATCHDOG_MS)
      watchdog.unref?.()
      void loop()
      return () => {
        stopped = true
        clearInterval(watchdog)
        stopController.abort()
        void post(settings, 'ilink/bot/msg/notifystop', { base_info: baseInfo() }, 5_000).catch(() => {})
      }
    },
  }
}
