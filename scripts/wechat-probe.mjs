/**
 * WeChat (iLink) probe: receive → typing → reply → media in/out.
 *
 * Uses the token saved by `scripts/wechat-login.mjs`. It is intentionally a
 * separate script (not a plugin provider): the point is to learn the live
 * behaviour — message shapes, typing, tool-call items, CDN round trips — before
 * `providers/wechat.js` is written against it.
 *
 * Commands the phone can send:
 *   anything        → typing on, echo "收到：<text>", a native tool-call pair
 *                     (start + result), typing off
 *   "img"           → reply with a generated PNG (outbound media test)
 *   an image/file   → download + AES decrypt, then echo it straight back
 *
 * Usage: node scripts/wechat-probe.mjs
 */
import { createDecipheriv, createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CRED_PATH = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'wechat-channel.json')
const MEDIA_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'wechat-probe-media')
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c'
const CLIENT_VERSION = '2.4.10'
const APP_ID = 'bot'
const POLL_MS = 35_000

const cred = JSON.parse(readFileSync(CRED_PATH, 'utf8'))
const BASE = String(cred.baseUrl || 'https://ilinkai.weixin.qq.com').replace(/\/$/, '')
mkdirSync(MEDIA_DIR, { recursive: true })

const encodeVersion = (version) => {
  const [major = 0, minor = 0, patch = 0] = String(version).split('.').map((part) => parseInt(part, 10) || 0)
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}
const baseInfo = () => ({ channel_version: CLIENT_VERSION, bot_agent: 'DSH/0.1' })
const headers = () => ({
  'Content-Type': 'application/json',
  AuthorizationType: 'ilink_bot_token',
  'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
  'iLink-App-Id': APP_ID,
  'iLink-App-ClientVersion': String(encodeVersion(CLIENT_VERSION)),
  Authorization: `Bearer ${cred.botToken}`,
})
const log = (...args) => console.log(...args)
const short = (text, size = 60) => {
  const value = String(text ?? '')
  return value.length > size ? `${value.slice(0, size)}…` : value
}
const clientId = () => `dsh-wechat-${randomUUID()}`

async function api(path, body, timeoutMs = 15_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE}/${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: controller.signal })
    const text = await res.text()
    if (!res.ok) throw new Error(`${path} ${res.status}: ${short(text, 200)}`)
    return text ? JSON.parse(text) : {}
  } finally {
    clearTimeout(timer)
  }
}

const itemOf = (message, type) => (message.item_list ?? []).find((item) => item?.type === type)

async function sendItems(to, contextToken, items, runId) {
  const response = await api('ilink/bot/sendmessage', {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: clientId(),
      message_type: 2,
      message_state: 2,
      item_list: items,
      context_token: contextToken,
      run_id: runId,
    },
    base_info: baseInfo(),
  })
  if (response.ret && response.ret !== 0) throw new Error(`send ret=${response.ret} ${response.errmsg ?? ''}`)
  return response
}

const textItem = (text) => ({ type: 1, text_item: { text } })
const toolStart = (name, id) => ({
  type: 11, create_time_ms: Date.now(), is_completed: false,
  tool_call_start_item: { tool_name: name, tool_call_id: id },
})
const toolResult = (name, id, status = 'completed') => ({
  type: 12, create_time_ms: Date.now(), is_completed: true,
  tool_call_result_item: { tool_name: name, tool_call_id: id, status },
})

let typingTicketCache = new Map()
async function typingTicket(userId, contextToken) {
  if (typingTicketCache.has(userId)) return typingTicketCache.get(userId)
  const response = await api('ilink/bot/getconfig', { ilink_user_id: userId, context_token: contextToken, base_info: baseInfo() }, 10_000)
  const ticket = response?.typing_ticket
  if (ticket) typingTicketCache.set(userId, ticket)
  return ticket
}
async function typing(userId, contextToken, status) {
  try {
    const ticket = await typingTicket(userId, contextToken)
    if (!ticket) return { ok: false, reason: 'no typing_ticket' }
    await api('ilink/bot/sendtyping', { ilink_user_id: userId, typing_ticket: ticket, status, base_info: baseInfo() }, 10_000)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String(error).slice(0, 120) }
  }
}

const parseAesKey = (aesKeyBase64) => {
  const decoded = Buffer.from(aesKeyBase64, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(`bad aes_key (${decoded.length} bytes)`)
}
/**
 * AES-128-ECB decrypt that survives an unpadded (or oddly padded) tail.
 *
 * WeChat pads outbound CDN uploads, but the inbound payload can end on an exact
 * block boundary without PKCS#7 padding — `final()` then throws
 * "wrong final block length". Decrypt without auto-padding and strip the pad
 * only when it is genuinely there.
 */
const aesDecrypt = (cipher, key) => {
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
const AES_KEY_NAMES = ['aes_key', 'aeskey', 'aesKey', 'AESKey']
const mediaKeyOf = (item, media) => {
  // WeChat sends the image key twice: `image_item.aeskey` is raw hex and is the
  // one its own client decrypts with; `media.aes_key` is base64.
  for (const name of AES_KEY_NAMES) {
    const raw = item?.[name]
    if (typeof raw === 'string' && raw.trim()) {
      const value = raw.trim()
      const key = /^[0-9a-fA-F]{32}$/.test(value)
        ? Buffer.from(value, 'hex')
        : (() => { try { return parseAesKey(value) } catch { return undefined } })()
      if (key) return { key, source: name }
    }
  }
  for (const name of AES_KEY_NAMES) {
    const raw = media?.[name]
    if (typeof raw === 'string' && raw.trim()) {
      try { return { key: parseAesKey(raw.trim()), source: `media.${name}` } } catch { /* try next */ }
    }
  }
  return undefined
}

const looksLikeImage = (buf) => {
  if (!buf || buf.length < 4) return false
  const hex = buf.subarray(0, 8).toString('hex')
  return hex.startsWith('89504e47') || hex.startsWith('ffd8') || hex.startsWith('52494646') || hex.startsWith('47494638')
}
const looksLikeArchive = (buf) => {
  if (!buf || buf.length < 4) return false
  const hex = buf.subarray(0, 4).toString('hex')
  return hex.startsWith('1f8b') || hex.startsWith('504b0304') || hex.startsWith('25504446')
}
const aesDecryptCbc = (cipher, key, iv) => Buffer.concat([createDecipheriv('aes-128-cbc', key, iv).update(cipher), createDecipheriv('aes-128-cbc', key, iv).final()])

/**
 * Image payloads show up in a few shapes in the wild (ECB is the documented one,
 * but the CDN has also served CBC with a zero IV, and occasionally plain bytes).
 * Try them in order and keep the first result that is recognisably an image.
 */
async function downloadMedia(item, media, label) {
  const url = media.full_url?.trim() || `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param ?? '')}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${label} download ${res.status}`)
  const cipher = Buffer.from(await res.arrayBuffer())
  const rawPath = join(MEDIA_DIR, `${label}-${Date.now()}-cipher.bin`)
  writeFileSync(rawPath, cipher)
  const found = mediaKeyOf(item, media)
  log(`${label}: bytes=${cipher.length} key=${found?.source ?? 'none'} media.aes_key=${media.aes_key ? 'yes' : 'no'} head=${cipher.subarray(0, 16).toString('hex')}`)
  log(`${label} item=${short(JSON.stringify(item), 700)}`)
  const candidates = []
  if (found) {
    candidates.push({ name: 'ecb', run: () => aesDecrypt(cipher, found.key) })
    candidates.push({ name: 'cbc0', run: () => aesDecryptCbc(cipher, found.key, Buffer.alloc(16)) })
    if (cipher.length > 32) {
      candidates.push({ name: 'cbc-iv1', run: () => aesDecryptCbc(cipher.subarray(16), found.key, cipher.subarray(0, 16)) })
    }
  }
  candidates.push({ name: 'plain', run: () => cipher })
  for (const candidate of candidates) {
    try {
      const produced = candidate.run()
      // Some CDN responses are gzipped before encryption; unwrap before judging.
      const plain = produced[0] === 0x1f && produced[1] === 0x8b
        ? gunzipSync(produced)
        : produced
      if (looksLikeImage(plain) || looksLikeArchive(plain)) {
        const file = join(MEDIA_DIR, `${label}-${Date.now()}-${candidate.name}.bin`)
        writeFileSync(file, plain)
        log(`${label}: decoded via ${candidate.name} -> ${plain.length} bytes head=${plain.subarray(0, 8).toString('hex')}`)
        return { file, size: plain.length, cipherSize: cipher.length, via: candidate.name }
      }
      log(`${label}: ${candidate.name} -> ${plain.length} bytes, head=${plain.subarray(0, 8).toString('hex')} (not an image)`)
    } catch (error) {
      log(`${label}: ${candidate.name} failed: ${short(error.message, 90)}`)
    }
  }
  throw new Error(`${label}: no decode path produced an image (bytes=${cipher.length} head=${cipher.subarray(0, 16).toString('hex')}, raw saved ${rawPath})`)
}

async function uploadMedia(plain, { mediaType, fileName, toUserId }) {
  const rawsize = plain.length
  const rawfilemd5 = createHash('md5').update(plain).digest('hex')
  const filesize = paddedSize(rawsize)
  const filekey = randomBytes(16).toString('hex')
  const aeskey = randomBytes(16)
  const urlResponse = await api('ilink/bot/getuploadurl', {
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
  const uploadUrl = urlResponse.upload_full_url?.trim()
    || `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(urlResponse.upload_param)}&filekey=${encodeURIComponent(filekey)}`
  const cipher = aesEncrypt(plain, aeskey)
  const res = await fetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(cipher) })
  if (res.status !== 200) {
    const detail = res.headers.get('x-error-message') ?? (await res.text().catch(() => ''))
    throw new Error(`upload ${res.status}: ${short(detail, 160)}`)
  }
  const downloadParam = res.headers.get('x-encrypted-param')
  if (!downloadParam) throw new Error('upload missing x-encrypted-param')
  return {
    filekey,
    aesKeyBase64: Buffer.from(aeskey.toString('hex')).toString('base64'),
    encryptQueryParam: downloadParam,
    cipherSize: filesize,
    size: rawsize,
    fileName,
  }
}

async function handleMessage(message) {
  const from = String(message.from_user_id ?? '')
  const contextToken = String(message.context_token ?? '')
  const runId = randomUUID()
  log(`MSG from=${from} id=${message.message_id ?? '?'} token=${contextToken ? 'yes' : 'no'} items=${(message.item_list ?? []).map((i) => i.type).join(',') || 'none'} session=${message.session_id ?? '?'}`)
  if (message.item_list?.length) log(`RAW items=${short(JSON.stringify(message.item_list), 400)}`)

  const typingStart = await typing(from, contextToken, 1)
  log(`TYPING start: ${typingStart.ok ? 'ok' : `failed (${typingStart.reason})`}`)

  try {
    const text = itemOf(message, 1)?.text_item?.text
    if (typeof text === 'string' && text.trim()) {
      log(`TEXT: ${short(text, 80)}`)
      const toolId = `probe-${Date.now()}`
      // Give the client a moment to render the tool chip before the answer
      // lands: everything in one burst is easy to miss.
      await sendItems(from, contextToken, [toolStart('probe_echo', toolId)], runId)
      await new Promise((resolve) => setTimeout(resolve, 900))
      await sendItems(from, contextToken, [textItem(`收到：${text.trim().slice(0, 500)}`)], runId)
      await new Promise((resolve) => setTimeout(resolve, 400))
      await sendItems(from, contextToken, [toolResult('probe_echo', toolId, 'completed')], runId)
      log('REPLY sent (tool start + text + tool result)')
      if (/img|图片/i.test(text)) {
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
        const uploaded = await uploadMedia(png, { mediaType: 1, fileName: 'probe.png', toUserId: from })
        await sendItems(from, contextToken, [{
          type: 2,
          image_item: {
            media: { encrypt_query_param: uploaded.encryptQueryParam, aes_key: uploaded.aesKeyBase64, encrypt_type: 1 },
            mid_size: uploaded.cipherSize,
          },
        }], runId)
        log(`IMAGE sent filekey=${uploaded.filekey} size=${uploaded.size}`)
      }
    }

    const image = itemOf(message, 2)?.image_item
    if (image?.media) {
      try {
        const got = await downloadMedia(image, image.media, 'image')
        log(`IMAGE received ${got.size} bytes (cipher ${got.cipherSize}) -> ${got.file}`)
        await sendItems(from, contextToken, [textItem(`收到图片：${got.size} 字节（密文 ${got.cipherSize} 字节）`)], runId)
        const uploaded = await uploadMedia(readFileSync(got.file), { mediaType: 1, fileName: 'echo.bin', toUserId: from })
        await sendItems(from, contextToken, [{
          type: 2,
          image_item: {
            media: { encrypt_query_param: uploaded.encryptQueryParam, aes_key: uploaded.aesKeyBase64, encrypt_type: 1 },
            mid_size: uploaded.cipherSize,
          },
        }], runId)
        log(`IMAGE echoed back filekey=${uploaded.filekey}`)
      } catch (error) {
        log(`IMAGE failed: ${short(error, 240)}`)
        await sendItems(from, contextToken, [textItem(`图片处理失败：${String(error).slice(0, 150)}`)], runId)
      }
    }

    const fileItem = itemOf(message, 4)?.file_item
    if (fileItem?.media) {
      try {
        const got = await downloadMedia(fileItem, fileItem.media, 'file')
        log(`FILE received name=${fileItem.file_name ?? '?'} ${got.size} bytes (cipher ${got.cipherSize}) -> ${got.file}`)
        await sendItems(from, contextToken, [textItem(`收到文件：${fileItem.file_name ?? 'file'}，${got.size} 字节`)], runId)
        const uploaded = await uploadMedia(readFileSync(got.file), { mediaType: 3, fileName: fileItem.file_name || 'echo.bin', toUserId: from })
        await sendItems(from, contextToken, [{
          type: 4,
          file_item: {
            media: { encrypt_query_param: uploaded.encryptQueryParam, aes_key: uploaded.aesKeyBase64, encrypt_type: 1 },
            file_name: fileItem.file_name || 'echo.bin',
            len: String(uploaded.size),
          },
        }], runId)
        log(`FILE echoed back filekey=${uploaded.filekey}`)
      } catch (error) {
        log(`FILE failed: ${short(error, 240)}`)
        await sendItems(from, contextToken, [textItem(`文件处理失败：${String(error).slice(0, 150)}`)], runId)
      }
    }
  } finally {
    const typingStop = await typing(from, contextToken, 2)
    log(`TYPING stop: ${typingStop.ok ? 'ok' : `failed (${typingStop.reason})`}`)
  }
}

async function main() {
  log(`probe start account=${cred.accountId} base=${BASE}`)
  let cursor = ''
  for (;;) {
    let response
    try {
      response = await api('ilink/bot/getupdates', { get_updates_buf: cursor ?? '', base_info: baseInfo() }, POLL_MS)
    } catch (error) {
      if (error?.name === 'AbortError') continue
      log(`POLL error: ${short(error, 200)}`)
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      continue
    }
    if (response.ret && response.ret !== 0) {
      log(`POLL ret=${response.ret} ${short(response.errmsg ?? '', 120)}`)
      if (response.ret === -14) { log('SESSION_TIMEOUT: run scripts/wechat-login.mjs again'); return }
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      continue
    }
    if (response.get_updates_buf) cursor = response.get_updates_buf
    const messages = Array.isArray(response.msgs) ? response.msgs : []
    if (messages.length === 0) continue
    log(`BATCH ${messages.length} message(s)`)
    for (const message of messages) {
      try {
        await handleMessage(message)
      } catch (error) {
        log(`HANDLE error: ${short(error, 300)}`)
      }
    }
  }
}

main().catch((error) => {
  log(`FATAL ${short(error, 400)}`)
  process.exitCode = 1
})
