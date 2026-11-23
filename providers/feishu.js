/**
 * Feishu / Lark transport adapter for the DSH channel framework.
 *
 * Everything that knows about Feishu Open API lives here; `index.js` only owns
 * channel behavior (sessions, workspaces, permissions, titles, turn replies).
 * Adding another IM means adding a sibling file that satisfies the same contract:
 *
 *   create<Provider>Provider(config) -> {
 *     id, label,
 *     settings()                      -> { appId, appSecret, region, baseUrl, defaultChatId }
 *     checkStatus(signal)             -> { configured, tokenOk, ... }
 *     sendText({ chatId, text }, s)   -> { ok, messageId, chatId }
 *     sendAttachment({ chatId, path, name }, s) -> { ok, kind, key, messageId, bytes }
 *     parseInbound(event)             -> { dedupeKey, chatId, senderId, messageId,
 *                                          text, imageKeys, unsupported }
 *     downloadImage({ messageId, imageKey }, s) -> localPath
 *     card.create({ text, summary }, s) / card.attach(...) / card.update(...) / card.close(...)
 *     connect({ onEvent, onState })   -> dispose
 *   }
 *
 * Settings precedence, highest first:
 *   1. the row `config` in cordis.patch.yml (non-empty fields only)
 *   2. the environment (FEISHU_APP_ID / FEISHU_APP_SECRET)
 *   3. the credentials file <DSH_HOME>/feishu-channel.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const REGION_BASE = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
}

const TOKEN_SKEW_MS = 60_000
const FILE_TTL_MS = 5_000
/**
 * How long a reconnected socket may stay silent before the client is rebuilt.
 *
 * `onReconnected` reports a socket that answers pings but no longer receives
 * events; it cannot be detected from the transport, only from the absence of
 * real events. Three minutes is long enough for a normal message burst to prove
 * the channel alive, short enough that a dead one is rebuilt before it matters.
 */
const RECONNECT_SILENCE_MS = 180_000
const tokenCache = new Map()
let fileCache = { path: '', readAt: 0, value: {} }

export function credentialsFilePath() {
  const home = String(globalThis.process?.env?.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  return join(home, 'feishu-channel.json')
}

function fileSettings() {
  const path = credentialsFilePath()
  const now = Date.now()
  if (fileCache.path === path && now - fileCache.readAt < FILE_TTL_MS) return fileCache.value
  let value = {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed
  } catch {
    value = {}
  }
  fileCache = { path, readAt: now, value }
  return value
}

const firstNonEmpty = (...values) => {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return ''
}

/** Merge row config, environment, and the credentials file into one settings view. */
export function resolveSettings(config = {}) {
  const env = globalThis.process?.env ?? {}
  const file = fileSettings()
  const region = firstNonEmpty(config.region, file.region, 'feishu').toLowerCase()
  return {
    appId: firstNonEmpty(config.appId, env.FEISHU_APP_ID, file.appId),
    appSecret: firstNonEmpty(config.appSecret, env.FEISHU_APP_SECRET, file.appSecret),
    defaultChatId: firstNonEmpty(config.defaultChatId, file.defaultChatId),
    region,
    baseUrl: REGION_BASE[region] ?? REGION_BASE.feishu,
  }
}

/**
 * Settings plus the credential-store layer.
 *
 * `ctx.credentials` can hold `FEISHU_APP_ID` / `FEISHU_APP_SECRET` as reference
 * keys, which keeps the secret out of every file; it ranks between the row
 * config and the environment. Resolution is per call, so a rotated stored value
 * applies to the next request without a restart.
 */
export async function resolveSettingsWithCredentials(config = {}, credentials) {
  const base = resolveSettings(config)
  let appId = base.appId
  let appSecret = base.appSecret
  let source = appId || appSecret ? 'config-or-file' : ''
  const resolveKey = async (name) => {
    try {
      const hit = await credentials?.resolve?.(name)
      return String(hit?.value ?? '').trim()
    } catch {
      return ''
    }
  }
  if (!appId) {
    const stored = await resolveKey('FEISHU_APP_ID')
    if (stored) {
      appId = stored
      source = 'credentials'
    }
  }
  if (!appSecret) {
    const stored = await resolveKey('FEISHU_APP_SECRET')
    if (stored) {
      appSecret = stored
      source = 'credentials'
    }
  }
  return { ...base, appId, appSecret, credentialSource: source }
}

function feishuError(payload, fallback) {  const code = payload?.code
  const msg = payload?.msg ?? payload?.message
  if (code === undefined || code === 0) return fallback
  return `Feishu API error ${code}${msg ? `: ${msg}` : ''}`
}

export async function tenantToken(base, appId, appSecret, signal) {
  const cacheKey = `${base}|${appId}`
  const cached = tokenCache.get(cacheKey)
  if (cached && cached.expiresAt - TOKEN_SKEW_MS > Date.now()) return cached.token

  const response = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  const token = payload?.tenant_access_token
  if (!response.ok || !token) {
    throw new Error(`Feishu tenant token request failed (HTTP ${response.status})`
      + `${payload?.msg ? `: ${payload.msg}` : ''}`)
  }
  const expireSec = Number(payload?.expire ?? 7200)
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + expireSec * 1000 })
  return token
}

export async function sendTextMessage(base, token, { receiveId, receiveIdType, text }, signal) {
  const query = new URLSearchParams({ receive_id_type: receiveIdType })
  const response = await fetch(`${base}/open-apis/im/v1/messages?${query.toString()}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
    throw new Error(feishuError(payload, `Feishu send failed (HTTP ${response.status})`))
  }
  return {
    ok: true,
    messageId: String(payload?.data?.message_id ?? ''),
    chatId: String(payload?.data?.chat_id ?? (receiveIdType === 'chat_id' ? receiveId : '')),
  }
}

/**
 * Send a rich-text (`post`) message.
 *
 * Used when the answer travels as a native message instead of a card: `post` is the
 * only native type that renders bold, links and code blocks, and unlike a card it can
 * be forwarded, quoted and searched like any other message.
 *
 * @param {string} base API base URL
 * @param {string} token tenant access token
 * @param {{ receiveId: string, receiveIdType: string, post: object }} input
 */
export async function sendPostMessage(base, token, { receiveId, receiveIdType, post }, signal) {
  const query = new URLSearchParams({ receive_id_type: receiveIdType })
  const response = await fetch(`${base}/open-apis/im/v1/messages?${query.toString()}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'post',
      content: JSON.stringify(post),
    }),
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
    throw new Error(feishuError(payload, `Feishu post send failed (HTTP ${response.status})`))
  }
  return {
    ok: true,
    messageId: String(payload?.data?.message_id ?? ''),
    chatId: String(payload?.data?.chat_id ?? (receiveIdType === 'chat_id' ? receiveId : '')),
  }
}

// ---------------------------------------------------------------------------
// Attachments
//
// Feishu wants an upload first — `im/v1/images` for pictures, `im/v1/files` for
// everything else — and then a message that references the returned key. Both
// endpoints take multipart, so the platform FormData/Blob do the encoding.
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])
const IMAGE_MAX_BYTES = 10 * 1024 * 1024
const FILE_MAX_BYTES = 30 * 1024 * 1024
const MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  zip: 'application/zip',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
}

const extensionOf = (name) => {
  const dot = String(name ?? '').lastIndexOf('.')
  return dot >= 0 ? String(name).slice(dot + 1).toLowerCase() : ''
}

/** Classify an outgoing file: pictures take the image endpoint, the rest the file one. */
export function attachmentKind(path) {
  return IMAGE_EXTENSIONS.has(extensionOf(path)) ? 'image' : 'file'
}

async function sendByKey(base, token, { receiveId, receiveIdType, msgType, content }, signal) {
  const query = new URLSearchParams({ receive_id_type: receiveIdType })
  const response = await fetch(`${base}/open-apis/im/v1/messages?${query.toString()}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ receive_id: receiveId, msg_type: msgType, content: JSON.stringify(content) }),
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
    throw new Error(feishuError(payload, `Feishu ${msgType} send failed (HTTP ${response.status})`))
  }
  return String(payload?.data?.message_id ?? '')
}

async function uploadImage(base, token, { buffer, name }, signal) {
  if (buffer.length > IMAGE_MAX_BYTES) {
    throw new Error(`image too large: ${buffer.length} bytes (limit ${IMAGE_MAX_BYTES})`)
  }
  const form = new FormData()
  form.append('image_type', 'message')
  form.append('image', new Blob([buffer], { type: MIME_BY_EXTENSION[extensionOf(name)] ?? 'application/octet-stream' }), name)
  const response = await fetch(`${base}/open-apis/im/v1/images`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  const key = payload?.data?.image_key
  if (!response.ok || !key) throw new Error(feishuError(payload, `Feishu image upload failed (HTTP ${response.status})`))
  return String(key)
}

async function uploadFile(base, token, { buffer, name }, signal) {
  if (buffer.length > FILE_MAX_BYTES) {
    throw new Error(`file too large: ${buffer.length} bytes (limit ${FILE_MAX_BYTES})`)
  }
  const form = new FormData()
  form.append('file_type', 'stream')
  form.append('file_name', name)
  form.append('file', new Blob([buffer], { type: MIME_BY_EXTENSION[extensionOf(name)] ?? 'application/octet-stream' }), name)
  const response = await fetch(`${base}/open-apis/im/v1/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  const key = payload?.data?.file_key
  if (!response.ok || !key) throw new Error(feishuError(payload, `Feishu file upload failed (HTTP ${response.status})`))
  return String(key)
}

/** Upload one local file and send it as an image or file message. */
export async function sendAttachment(base, token, { path, name }, target, signal) {
  const fileName = String(name ?? '').trim() || basename(String(path ?? ''))
  if (!path) throw new Error('attachment path is required')
  const buffer = readFileSync(String(path))
  if (attachmentKind(fileName) === 'image') {
    const imageKey = await uploadImage(base, token, { buffer, name: fileName }, signal)
    const messageId = await sendByKey(base, token, {
      ...target, msgType: 'image', content: { image_key: imageKey },
    }, signal)
    return { ok: true, kind: 'image', name: fileName, bytes: buffer.length, key: imageKey, messageId }
  }
  const fileKey = await uploadFile(base, token, { buffer, name: fileName }, signal)
  const messageId = await sendByKey(base, token, {
    ...target, msgType: 'file', content: { file_key: fileKey },
  }, signal)
  return { ok: true, kind: 'file', name: fileName, bytes: buffer.length, key: fileKey, messageId }
}

// ---------------------------------------------------------------------------
// Cards (streaming markdown)
// ---------------------------------------------------------------------------

export const CARD_ELEMENT_ID = 'md_1'

function cardJson(text, summary) {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      // The Feishu client animates the text itself, so cumulative PATCHes read
      // as continuous typing instead of one jump per write.
      streaming_config: {
        print_frequency_ms: { default: 40, android: 40, ios: 40, pc: 40 },
        print_step: { default: 1, android: 1, ios: 1, pc: 1 },
        print_strategy: 'fast',
      },
      update_multi: true,
      width_mode: 'fill',
      summary: { content: summary },
    },
    body: {
      elements: [
        { tag: 'markdown', element_id: CARD_ELEMENT_ID, content: text || ' ' },
        { tag: 'hr' },
        {
          tag: 'markdown',
          element_id: 'note_1',
          // The card opens before the model has produced anything, so the footer
          // starts as a wait notice; flushCard flips it once the answer streams.
          content: '<font color="grey">等待回答</font>',
          text_size: 'notation',
        },
      ],
    },
  }
}

export async function createCard(base, token, { text, summary }, signal) {
  const response = await fetch(`${base}/open-apis/cardkit/v1/cards`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ type: 'card_json', data: JSON.stringify(cardJson(text, summary)) }),
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  const cardId = payload?.data?.card_id
  if (!response.ok || !cardId) {
    throw new Error(feishuError(payload, `Feishu card create failed (HTTP ${response.status})`))
  }
  return String(cardId)
}

export async function sendCard(base, token, { receiveId, receiveIdType, cardId }, signal) {
  const query = new URLSearchParams({ receive_id_type: receiveIdType })
  const response = await fetch(`${base}/open-apis/im/v1/messages?${query.toString()}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
    }),
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
    throw new Error(feishuError(payload, `Feishu card send failed (HTTP ${response.status})`))
  }
  return String(payload?.data?.message_id ?? '')
}

/**
 * Replace a whole card in place.
 *
 * Updating one element only changes its text, which left a settled approval card
 * looking identical to a pending one — same orange header, same two buttons. A
 * decision is a state change, so the card itself is rebuilt: green/red header, no
 * buttons, and the outcome as the card's own status.
 */
export async function updateCardJson(base, token, { cardId, card, sequence }, signal) {
  const response = await fetch(`${base}/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      card: { type: 'card_json', data: JSON.stringify(card) },
      sequence,
    }),
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
    throw new Error(feishuError(payload, `Feishu card replace failed (HTTP ${response.status})`))
  }
}

/**
 * Create one CardKit entity from arbitrary card JSON.
 *
 * The streaming reply card is built by `createCard`; interactive question cards
 * need their own layout (buttons, header, status line), so they come through
 * here and reuse `sendCard` for delivery.
 */
export async function createCardFromJson(base, token, { card }, signal) {
  const response = await fetch(`${base}/open-apis/cardkit/v1/cards`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ type: 'card_json', data: JSON.stringify(card) }),
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  const cardId = payload?.data?.card_id
  if (!response.ok || !cardId) {
    throw new Error(feishuError(payload, `Feishu card create failed (HTTP ${response.status})`))
  }
  return String(cardId)
}

export async function updateCardText(base, token, { cardId, content, sequence, elementId = CARD_ELEMENT_ID }, signal) {
  const response = await fetch(
    `${base}/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/${encodeURIComponent(elementId)}/content`,
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ content, sequence }),
      signal,
    },
  )
  const payload = await response.json().catch(() => undefined)
  if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
    throw new Error(feishuError(payload, `Feishu card update failed (HTTP ${response.status})`))
  }
}

export async function closeCard(base, token, { cardId, sequence, summary }, signal) {
  const response = await fetch(`${base}/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/settings`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: summary } } }),
      sequence,
    }),
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
    throw new Error(feishuError(payload, `Feishu card finalize failed (HTTP ${response.status})`))
  }
}

// ---------------------------------------------------------------------------
// Inbound parsing
// ---------------------------------------------------------------------------

/** Parse a Feishu text message body (`message.content` is a JSON string). */
export function parseTextContent(content) {
  try {
    const parsed = JSON.parse(content ?? '{}')
    return typeof parsed?.text === 'string' ? parsed.text : ''
  } catch {
    return ''
  }
}

/** Remove @mention placeholders (`@_user_1`) that Feishu puts in text bodies. */
export function stripMentions(text, mentions) {
  let out = String(text ?? '')
  for (const mention of Array.isArray(mentions) ? mentions : []) {
    const key = mention?.key
    if (typeof key === 'string' && key) out = out.split(key).join(' ')
  }
  return out.replace(/\s+/g, ' ').trim()
}

const POST_MAX_CHARS = 8000

/**
 * Parse a Feishu rich-text (`post`) body into plain text plus image keys.
 *
 * Shape: `{ title, content: [[{ tag: 'text'|'a'|'img'|..., ... }]] }`, sometimes
 * wrapped per locale (`{ zh_cn: { title, content } }`). Only text is kept; an
 * `img` node contributes its `image_key` so the caller can download it.
 */
export function parsePostContent(content) {
  let parsed
  try {
    parsed = JSON.parse(content ?? '{}')
  } catch {
    return { text: '', imageKeys: [], files: [] }
  }
  if (!parsed || typeof parsed !== 'object') return { text: '', imageKeys: [], files: [] }
  const body = Array.isArray(parsed.content)
    ? parsed
    : (Object.values(parsed).find((value) => value && Array.isArray(value.content)) ?? parsed)
  const title = typeof body?.title === 'string' ? body.title.trim() : ''
  const lines = []
  const imageKeys = []
  const files = []
  for (const paragraph of Array.isArray(body?.content) ? body.content : []) {
    if (!Array.isArray(paragraph)) continue
    let line = ''
    for (const node of paragraph) {
      const tag = String(node?.tag ?? '')
      if (tag === 'img') {
        const key = typeof node?.image_key === 'string' ? node.image_key : ''
        if (key) imageKeys.push(key)
        continue
      }
      // A file dragged into the box arrives as a post element (media/ile);
      // treating it as plain text silently dropped the attachment.
      if (tag === 'media' || tag === 'file' || typeof node?.file_key === 'string') {
        const fileKey = typeof node?.file_key === 'string' ? node.file_key : ''
        if (fileKey) files.push({ fileKey, fileName: typeof node?.file_name === 'string' ? node.file_name : '' })
        continue
      }
      if (typeof node?.text === 'string') line += node.text
    }
    if (line.trim()) lines.push(line.trim())
  }
  return { text: [title, ...lines].filter(Boolean).join('\n').slice(0, POST_MAX_CHARS), imageKeys, files }
}

/** Parse a single-image message body (`{"image_key":"img_..."}`). */
export function parseImageContent(content) {
  try {
    const parsed = JSON.parse(content ?? '{}')
    return typeof parsed?.image_key === 'string' ? parsed.image_key : ''
  } catch {
    return ''
  }
}

/** Where inbound attachments land; override with `inboundFilesDir` in the row config. */
export function inboundFilesDir(config) {
  const configured = String(config?.inboundFilesDir ?? '').trim()
  if (configured) return configured
  // Attachments belong with the work they feed: put them inside the channel
  // workspace so the agent can open them by a workspace-relative path.
  const workspace = String(config?.workspacePath ?? '').trim()
  if (workspace) return join(workspace, 'attachments')
  return join(dirname(credentialsFilePath()), 'feishu-inbound-files')
}

/** Sniff the container format so the agent can open the file by extension. */
export function imageExtension(buffer) {
  if (buffer.length >= 12
    && buffer.toString('latin1', 0, 4) === 'RIFF'
    && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer.toString('latin1', 1, 4) === 'PNG') return 'png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
  if (buffer.length >= 6 && buffer.toString('latin1', 0, 3) === 'GIF') return 'gif'
  return 'bin'
}

/**
 * Download one message image through the message-resource endpoint.
 *
 * The plain `/im/v1/images/:image_key` endpoint rejects keys that belong to a
 * chat message ("Invalid request param", code 234001); the message-resource
 * route is the one that works with `im:message` scope.
 */
export async function downloadMessageImage(base, token, messageId, imageKey, config, signal) {
  const resource = `${base}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`
    + `/resources/${encodeURIComponent(imageKey)}?type=image`
  const response = await fetch(resource, { headers: { authorization: `Bearer ${token}` }, signal })
  if (!response.ok) throw new Error(`Feishu image download failed (HTTP ${response.status})`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const dir = inboundFilesDir(config)
  mkdirSync(dir, { recursive: true })
  const name = `${messageId}-${imageKey.slice(-10)}.${imageExtension(buffer)}`
  const path = join(dir, name)
  writeFileSync(path, buffer)
  return path
}

/** Keep an attachment name usable as a Windows path segment. */
function safeFileName(fileName, fileKey) {
  const base = String(fileName ?? '').split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '').trim()
  if (cleaned) return cleaned.slice(0, 120)
  return `${String(fileKey ?? 'file').slice(-12) || 'file'}.bin`
}

/**
 * Download one message file (document, archive, audio…) through the
 * message-resource endpoint and land it in the inbound attachment directory.
 */
export async function downloadMessageFile(base, token, messageId, fileKey, fileName, config, signal) {
  const resource = `${base}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`
    + `/resources/${encodeURIComponent(fileKey)}?type=file`
  const response = await fetch(resource, { headers: { authorization: `Bearer ${token}` }, signal })
  if (!response.ok) throw new Error(`Feishu file download failed (HTTP ${response.status})`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const dir = inboundFilesDir(config)
  mkdirSync(dir, { recursive: true })
  let name = safeFileName(fileName, fileKey)
  let path = join(dir, name)
  if (existsSync(path)) {
    const at = name.lastIndexOf('.')
    const stem = at > 0 ? name.slice(0, at) : name
    const ext = at > 0 ? name.slice(at) : ''
    name = `${stem}-${String(fileKey ?? '').slice(-6)}${ext}`
    path = join(dir, name)
  }
  writeFileSync(path, buffer)
  return path
}

/** Normalize one `im.message.receive_v1` payload; null means "nothing usable". */export function parseInboundEvent(event) {
  const message = event?.message
  const sender = event?.sender
  if (!message || !sender) return null
  // The SDK dispatcher hands over the event body, not the envelope, so
  // `header.event_id` is usually absent. `message_id` is stable across
  // redeliveries and is what dedupe needs to survive a restart.
  const dedupeKey = String(event?.header?.event_id ?? event?.event_id ?? message.message_id ?? '')
  const messageType = String(message.message_type ?? '')
  const mentions = message.mentions
  let text = ''
  let imageKeys = []
  let files = []
  if (messageType === 'text') {
    text = stripMentions(parseTextContent(message.content), mentions)
  } else if (messageType === 'post') {
    const parsed = parsePostContent(message.content)
    text = stripMentions(parsed.text, mentions)
    imageKeys = parsed.imageKeys
    files = Array.isArray(parsed.files) ? parsed.files : []
  } else if (messageType === 'image') {
    const key = parseImageContent(message.content)
    if (key) imageKeys = [key]
  } else if (messageType === 'file') {
    const file = parseFileContent(message.content)
    if (file.fileKey) files = [file]
  } else {
    return {
      dedupeKey,
      chatId: String(message.chat_id ?? ''),
      chatType: String(message.chat_type ?? ''),
      senderId: String(sender.sender_id?.open_id ?? ''),
      senderType: String(sender.sender_type ?? ''),
      messageId: String(message.message_id ?? ''),
      text: '',
      imageKeys: [],
      files: [],
      unsupported: messageType,
    }
  }
  return {
    dedupeKey,
    chatId: String(message.chat_id ?? ''),
    chatType: String(message.chat_type ?? ''),
    senderId: String(sender.sender_id?.open_id ?? ''),
    senderType: String(sender.sender_type ?? ''),
    messageId: String(message.message_id ?? ''),
    text,
    imageKeys,
    files,
    unsupported: '',
  }
}

/** One `file` message body: `{ file_key, file_name }`. */
export function parseFileContent(content) {
  try {
    const parsed = JSON.parse(content ?? '{}')
    return {
      fileKey: typeof parsed?.file_key === 'string' ? parsed.file_key : '',
      fileName: typeof parsed?.file_name === 'string' ? parsed.file_name : '',
    }
  } catch {
    return { fileKey: '', fileName: '' }
  }
}

/**
 * Normalize one `card.action.trigger` payload.
 *
 * The dispatcher flattens schema-2.0 envelopes (`{ schema, header, event }`)
 * into `{ ...header, ...event }`, so `context`/`action`/`operator` sit at the
 * top level; tests and older callers may pass the nested `{ event }` shape.
 * The button value is user-defined, so it stays opaque here.
 */
export function normalizeCardAction(data) {
  const event = data?.event ?? data ?? {}
  const context = event?.context ?? data?.context ?? {}
  const messageId = String(context?.open_message_id ?? event?.open_message_id ?? '')
  const chatId = String(context?.open_chat_id ?? event?.open_chat_id ?? '')
  const operatorId = String(event?.operator?.open_id ?? event?.operator_id?.open_id ?? '')
  const value = event?.action?.value
  if (!messageId || !value || typeof value !== 'object') return null
  return { messageId, chatId, operatorId, value }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Build the Feishu adapter.
 * `log` receives `{ event, result, reason, ... }` records for feishu-inbound.log.
 */
export function createFeishuProvider(config = {}, deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const settings = () => resolveSettings(config)
  const settingsAsync = () => resolveSettingsWithCredentials(config, deps.credentials)
  const token = async (signal) => {
    const resolved = await settingsAsync()
    return tenantToken(resolved.baseUrl, resolved.appId, resolved.appSecret, signal)
  }

  return {
    id: 'feishu',
    label: 'Feishu / Lark',
    settings,
    settingsAsync,

    async checkStatus(signal) {
      const resolved = await settingsAsync()
      const result = {
        configured: Boolean(resolved.appId && resolved.appSecret),
        tokenOk: false,
        region: resolved.region,
        baseUrl: resolved.baseUrl,
        appId: resolved.appId,
        defaultChatId: resolved.defaultChatId,
        credentialSource: resolved.credentialSource ?? '',
        error: '',
      }
      if (!result.configured) {
        result.error = 'missing appId/appSecret (row config, credentials store, env, or credentials file)'
        return result
      }
      try {
        await tenantToken(resolved.baseUrl, resolved.appId, resolved.appSecret, signal)
        result.tokenOk = true
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error)
      }
      return result
    },

    /**
     * Recent messages of one chat, normalized to the event shape `parseInbound`
     * understands. The long connection is best-effort: this is the source of
     * truth used to catch up after a reconnect.
     */
    async listRecentMessages({ chatId, sinceMs, limit = 50 }, signal) {
      const resolved = await settingsAsync()
      if (!resolved.appId || !resolved.appSecret || !chatId) return []
      const token = await tenantToken(resolved.baseUrl, resolved.appId, resolved.appSecret, signal)
      const since = Math.max(0, Math.floor((Number(sinceMs) || 0) / 1000))
      const size = Math.min(50, Math.max(1, Number(limit) || 50))
      const url = `${resolved.baseUrl}/open-apis/im/v1/messages?container_id_type=chat`
        + `&container_id=${encodeURIComponent(chatId)}&start_time=${since}`
        + `&sort_type=ByCreateTimeAsc&page_size=${size}`
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok || (payload?.code ?? 0) !== 0) {
        throw new Error(feishuError(payload, `Feishu list messages failed (HTTP ${response.status})`))
      }
      return (Array.isArray(payload?.data?.items) ? payload.data.items : []).map((item) => ({
        header: { event_id: `catchup:${item.message_id}` },
        message: {
          message_id: String(item.message_id ?? ''),
          chat_id: String(item.chat_id ?? chatId),
          chat_type: 'p2p',
          message_type: String(item.msg_type ?? ''),
          content: String(item.body?.content ?? '{}'),
          mentions: [],
        },
        sender: {
          sender_id: { open_id: String(item.sender?.id ?? '') },
          sender_type: String(item.sender?.sender_type ?? 'user'),
        },
      }))
    },

    async sendText({ chatId, text }, signal) {
      const resolved = await settingsAsync()
      return await sendTextMessage(resolved.baseUrl, await token(signal), {
        receiveId: chatId, receiveIdType: 'chat_id', text,
      }, signal)
    },

    async sendRichText({ chatId, post }, signal) {
      const resolved = await settingsAsync()
      return await sendPostMessage(resolved.baseUrl, await token(signal), {
        receiveId: chatId, receiveIdType: 'chat_id', post,
      }, signal)
    },

    async sendAttachment({ chatId, path, name }, signal) {
      const resolved = await settingsAsync()
      return await sendAttachment(
        resolved.baseUrl,
        await token(signal),
        { path, name },
        { receiveId: chatId, receiveIdType: 'chat_id' },
        signal,
      )
    },

    parseInbound: parseInboundEvent,
    normalizeCardAction,

    async downloadImage({ messageId, imageKey }, signal) {
      const resolved = await settingsAsync()
      return await downloadMessageImage(
        resolved.baseUrl, await token(signal), messageId, imageKey, config, signal,
      )
    },

    async downloadFile({ messageId, fileKey, fileName }, signal) {
      const resolved = await settingsAsync()
      return await downloadMessageFile(
        resolved.baseUrl, await token(signal), messageId, fileKey, fileName, config, signal,
      )
    },

    card: {
      async create({ text, summary }, signal) {
        const resolved = await settingsAsync()
        return await createCard(resolved.baseUrl, await token(signal), { text, summary }, signal)
      },
      async createRaw({ card }, signal) {
        const resolved = await settingsAsync()
        return await createCardFromJson(resolved.baseUrl, await token(signal), { card }, signal)
      },
      async attach({ chatId, cardId }, signal) {
        const resolved = await settingsAsync()
        return await sendCard(resolved.baseUrl, await token(signal), {
          receiveId: chatId, receiveIdType: 'chat_id', cardId,
        }, signal)
      },
      async update({ cardId, content, sequence, elementId }, signal) {
        const resolved = await settingsAsync()
        await updateCardText(resolved.baseUrl, await token(signal), { cardId, content, sequence, elementId }, signal)
      },
      async close({ cardId, sequence, summary }, signal) {
        const resolved = await settingsAsync()
        await closeCard(resolved.baseUrl, await token(signal), { cardId, sequence, summary }, signal)
      },
      async updateRaw({ cardId, card, sequence }, signal) {
        const resolved = await settingsAsync()
        await updateCardJson(resolved.baseUrl, await token(signal), { cardId, card, sequence }, signal)
      },
    },

    // --- thinking process (native CoT) -------------------------------------
    // One POST opens the run, PUT appends AG-UI events, RUN_FINISHED closes it.
    async cotCreate({ chatId, replyTo, hidden = false }, signal) {
      const resolved = await settingsAsync()
      const response = await fetch(`${resolved.baseUrl}/open-apis/im/v1/message_cot?receive_id_type=chat_id`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${await token(signal)}`,
        },
        body: JSON.stringify({
          receive_id: chatId,
          ...(replyTo ? { origin_message_id: replyTo } : {}),
          cot_hidden: hidden,
          enable_badge: false,
          update_feed_rank: false,
        }),
        signal,
      })
      const payload = await response.json().catch(() => undefined)
      const cotId = payload?.data?.cot_id
      const messageId = payload?.data?.message_id
      if (!response.ok || !cotId || !messageId) {
        throw new Error(feishuError(payload, `Feishu CoT create failed (HTTP ${response.status})`))
      }
      return { cotId: String(cotId), messageId: String(messageId) }
    },

    async cotWrite({ cotId, messageId, events }, signal) {
      const resolved = await settingsAsync()
      const response = await fetch(`${resolved.baseUrl}/open-apis/im/v1/message_cot`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${await token(signal)}`,
        },
        body: JSON.stringify({ events, message_id: messageId, cot_id: cotId }),
        signal,
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
        throw new Error(feishuError(payload, `Feishu CoT write failed (HTTP ${response.status})`))
      }
    },

    // --- reactions ----------------------------------------------------------
    async addReaction({ messageId, emoji = 'THINKING' }, signal) {
      const resolved = await settingsAsync()
      const response = await fetch(
        `${resolved.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json; charset=utf-8',
            authorization: `Bearer ${await token(signal)}`,
          },
          body: JSON.stringify({ reaction_type: { emoji_type: emoji } }),
          signal,
        },
      )
      const payload = await response.json().catch(() => undefined)
      const reactionId = payload?.data?.reaction_id
      if (!response.ok || !reactionId) {
        throw new Error(feishuError(payload, `Feishu reaction add failed (HTTP ${response.status})`))
      }
      return String(reactionId)
    },

    async removeReaction({ messageId, reactionId }, signal) {
      const resolved = await settingsAsync()
      const response = await fetch(
        `${resolved.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
        {
          method: 'DELETE',
          headers: { authorization: `Bearer ${await token(signal)}` },
          signal,
        },
      )
      const payload = await response.json().catch(() => undefined)
      if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
        throw new Error(feishuError(payload, `Feishu reaction remove failed (HTTP ${response.status})`))
      }
    },

    /**
     * Long connection: the Feishu SDK owns reconnect, auth and decryption.
     * `onEvent(data)` receives one `im.message.receive_v1` payload;
     * `onCardAction(data)` receives one flattened `card.action.trigger`
     * payload; `onState({ ready, error })` publishes transport health.
     *
     * A half-open TCP socket is the failure this connection hides best: the
     * socket stays OPEN, no 'close' fires, and events simply stop. The SDK only
     * notices when `wsConfig.pingTimeout` is set — with it, every ping arms a
     * watchdog that terminates the socket when no pong/inbound frame arrives, so
     * the normal reconnect flow runs. Without it, `armLiveness()` is a no-op and
     * the channel goes deaf forever. Every SDK lifecycle callback is wired to
     * `onState` for the same reason: a silent reconnect is a silent outage.
     */
    async connect({ onEvent, onState, onCardAction }, signal) {
      const resolved = await settingsAsync()
      if (!resolved.appId || !resolved.appSecret) {
        onState?.({ ready: false, error: 'missing appId/appSecret' })
        return () => {}
      }
      let Lark
      try {
        const mod = await import('@larksuiteoapi/node-sdk')
        Lark = mod?.default?.WSClient ? mod.default : mod
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        onState?.({ ready: false, error: `cannot load @larksuiteoapi/node-sdk: ${reason}` })
        log({ event: 'channel', result: 'sdk-missing', reason })
        return () => {}
      }

      let client
      let clientLabel = ''
      let clientSeq = 0
      let disposed = false
      let restartTimer
      let readyFlag = false
      let published = ''
      // A reconnect can hand back a socket that keeps the pong loop alive but no
      // longer receives events: `onReconnected` then reports "ready" while the
      // channel is deaf, and outbound REST keeps working, so nothing else notices.
      // Track the last real event and rebuild once when a reconnect stays silent.
      let lastEntryAt = Date.now()
      let verifyTimer
      let verifiedRebuild = false
      // Set while an intentional rebuild closes the socket, so its own close does
      // not count as a fresh outage and re-arm the verification forever.
      let selfClosing = false
      const clearVerify = () => {
        if (verifyTimer) clearTimeout(verifyTimer)
        verifyTimer = undefined
      }
      const armInboundVerify = () => {
        if (disposed) return
        clearVerify()
        verifyTimer = setTimeout(() => {
          verifyTimer = undefined
          if (disposed || !readyFlag || verifiedRebuild) return
          if (Date.now() - lastEntryAt < RECONNECT_SILENCE_MS) return
          verifiedRebuild = true
          // A fresh client is the only reliable fix: the old socket's event
          // subscription is what went stale, and reusing it keeps it dead.
          log({ event: 'channel', result: 'rebuild', reason: 'no inbound after reconnect' })
          selfClosing = true
          void startClient().finally(() => { selfClosing = false })
        }, RECONNECT_SILENCE_MS)
        verifyTimer.unref?.()
      }
      const publish = (ready, error = '') => {
        const wasDown = published.startsWith('down:')
        readyFlag = ready
        // One ready line per transition: SDK onReady and onReconnected both fire
        // on the first connect, and duplicates made the log look like churn.
        const key = `${ready ? 'up' : 'down'}:${error}`
        if (key === published) return
        published = key
        onState?.({ ready, error })
        if (!ready) {
          clearVerify()
          if (!selfClosing) verifiedRebuild = false
        } else if (wasDown) {
          armInboundVerify()
        }
      }
      const dispatcher = new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          lastEntryAt = Date.now()
          // Prove the event reached the plugin. Without this line a message lost
          // before our filters is indistinguishable from one that never arrived —
          // exactly the situation that made the field report impossible to read.
          log({
            event: 'inbound',
            result: 'entry',
            messageId: String(data?.message?.message_id ?? ''),
            type: String(data?.message?.message_type ?? ''),
            chatId: String(data?.message?.chat_id ?? ''),
            eventId: String(data?.header?.event_id ?? data?.event_id ?? ''),
          })
          const startedAt = Date.now()
          try {
            await onEvent(data)
          } catch (error) {
            log({ event: 'channel', result: 'handler-failed', reason: error instanceof Error ? error.message : String(error) })
          } finally {
            // If the SDK acks only after this callback returns, the duration is
            // the ack delay. Measure it so a slow turn is visible in the log.
            log({ event: 'inbound', result: 'handled', messageId: String(data?.message?.message_id ?? ''), ms: Date.now() - startedAt })
          }
        },
        // Interactive card buttons: the answer travels back through the same
        // long connection as message events (no callback URL needed).
        'card.action.trigger': async (data) => {
          try {
            return await onCardAction?.(data)
          } catch (error) {
            log({ event: 'channel', result: 'card-handler-failed', reason: error instanceof Error ? error.message : String(error) })
            return undefined
          }
        },
      })

      const scheduleRestart = (reason) => {
        if (disposed || restartTimer) return
        restartTimer = setTimeout(async () => {
          restartTimer = undefined
          if (disposed) return
          // The SDK may have recovered on its own while the timer ran; a fresh
          // client would only drop the live connection.
          if (readyFlag) {
            log({ event: 'channel', result: 'restart-skipped', reason })
            return
          }
          log({ event: 'channel', result: 'restart', reason })
          try { client?.close?.() } catch { /* ignore */ }
          await startClient()
        }, 30_000)
        restartTimer.unref?.()
      }

      const startClient = async () => {
        if (disposed) return
        try {
          // Never let two clients live at once: Feishu spreads events across the
          // app's connections, and a second (dying) socket silently swallows the
          // messages it wins.
          if (client) {
            log({ event: 'channel', result: 'client-close', client: clientLabel })
            try { await client.close?.() } catch { /* ignore */ }
            client = undefined
          }
          clientLabel = `ws-${++clientSeq}`
          log({ event: 'channel', result: 'client-create', client: clientLabel })
          client = new Lark.WSClient({
            appId: resolved.appId,
            appSecret: resolved.appSecret,
            loggerLevel: Lark.LoggerLevel?.info,
            // 60 s without a pong (or any inbound frame) after a ping ⇒ the
            // socket is presumed dead and gets terminated to reconnect.
            wsConfig: { pingTimeout: Number(config.wsPingTimeoutSeconds ?? 60) },
            onReady: () => publish(true, ''),
            onReconnecting: () => publish(false, 'reconnecting'),
            onReconnected: () => publish(true, ''),
            onError: (error) => {
              const reason = error instanceof Error ? error.message : String(error)
              publish(false, reason)
              log({ event: 'channel', result: 'sdk-error', reason })
              // The SDK gives up on fatal errors; bring a fresh client back.
              scheduleRestart(reason)
            },
          })
          await client.start({ eventDispatcher: dispatcher })
          // onReady already published; a second ready line only adds noise.
          if (!disposed && !readyFlag) publish(true, '')
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          publish(false, reason)
          log({ event: 'channel', result: 'connect-failed', reason })
          scheduleRestart(reason)
        }
      }

      await startClient()

      return () => {
        disposed = true
        if (restartTimer) clearTimeout(restartTimer)
        clearVerify()
        if (client) log({ event: 'channel', result: 'client-close', client: clientLabel })
        try { client?.close?.() } catch { /* ignore */ }
        publish(false, 'closed')
      }
    },
  }
}
