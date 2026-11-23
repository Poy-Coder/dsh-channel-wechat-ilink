/**
 * Feishu (Lark) app setup by scanning a QR code — no trip to the developer console.
 *
 * Two modes, one protocol (RFC 8628 device authorization against
 * `https://accounts.feishu.cn/oauth/v1/app/registration`):
 *
 *   node scripts/feishu-login.mjs          create a new app with every scope and event
 *                                          this channel needs, then save its credentials
 *   node scripts/feishu-login.mjs --fix    add the missing scopes/events to the app that
 *                                          is already configured (after an upgrade that
 *                                          needs a new permission)
 *   node scripts/feishu-login.mjs --status just show what is configured
 *
 * The `addons` parameter is what makes this "configure once": the scopes and events are
 * submitted with the registration, so the created app arrives with the permissions the
 * plugin actually uses instead of the user clicking them one by one in the console.
 *
 * Scopes are derived from the endpoints this plugin calls — see REQUIRED_SCOPES below.
 */
import { gzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { renderQr } from './wechat-qr.mjs'

/**
 * Windows consoles still default to the OEM code page (936 in zh-CN), so UTF-8 output
 * — including the QR block characters — arrives as mojibake. Switching the console to
 * UTF-8 for this process is the difference between a scannable QR and a wall of garbage.
 */
const ensureUtf8Console = () => {
  if (process.platform !== 'win32' || !process.stdout.isTTY) return
  try {
    spawnSync('chcp.com', ['65001'], { stdio: 'ignore', windowsHide: true })
  } catch { /* best effort: the link below still works without the QR */ }
}
ensureUtf8Console()

const STATE_PATH = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'feishu-channel.json')
const ENDPOINT = '/oauth/v1/app/registration'
const ORIGINS = {
  feishu: 'https://accounts.feishu.cn',
  lark: 'https://accounts.larksuite.com',
}

/**
 * What this channel calls, and the scope each call needs.
 *
 * Deliberately the *minimal* set for a single-chat bot: group scopes are omitted
 * because the plugin does not support group chat, and every scope a user cannot use is
 * a permission they have to justify to their admin.
 */
export const REQUIRED_SCOPES = Object.freeze([
  'im:message.p2p_msg:readonly', // read the chat's messages (inbound + catch-up)
  'im:message:send_as_bot', // send replies, cards' text, and the thinking process
  'im:resource', // upload/download images and files
  'cardkit:card:write', // streaming card, question card, approval card
  'im:message.react', // acknowledgement reaction (reactions: true)
])

/**
 * Events the long connection subscribes to.
 *
 * `card.action.trigger` is not optional: without it the question and approval cards
 * render but their buttons do nothing.
 */
export const REQUIRED_EVENTS = Object.freeze([
  'im.message.receive_v1',
  'card.action.trigger',
])

const log = (message) => process.stdout.write(`${message}\n`)
const fail = (message) => {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}

/** Package the scopes/events the way the registration endpoint expects them. */
export function encodeAddons({ scopes = REQUIRED_SCOPES, events = REQUIRED_EVENTS } = {}) {
  const payload = {
    scopes: { tenant: [...scopes] },
    events: { items: { tenant: [...events] } },
  }
  return gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64url')
}

const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Ask the platform to start a registration run.
 *
 * @param {{ origin?: string, createOnly?: boolean, appId?: string }} options
 */
async function begin({ origin = ORIGINS.feishu, createOnly = true, appId } = {}) {
  const url = new URL(`${origin}${ENDPOINT}`)
  url.searchParams.set('addons', encodeAddons())
  if (createOnly) url.searchParams.set('createOnly', 'true')
  else if (appId) url.searchParams.set('appId', appId)

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    // `auth_method` is mandatory: without it the endpoint answers
    // `invalid_request: The app registration request auth method is unsupported`.
    // `archetype` picks the app template (a personal agent, not an enterprise app),
    // and `request_user_info` asks the response to carry the scanner's open_id.
    body: new URLSearchParams({
      action: 'begin',
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      request_user_info: 'open_id',
    }).toString(),
    signal: AbortSignal.timeout(20_000),
  })
  const payload = await response.json().catch(() => undefined)
  if (!response.ok || !payload?.device_code) {
    throw new Error(`发起扫码失败：HTTP ${response.status} ${payload?.error ?? payload?.msg ?? ''}`.trim())
  }
  return {
    deviceCode: String(payload.device_code),
    userCode: String(payload.user_code ?? ''),
    // The complete URI opens straight on the confirmation screen, so it can be printed
    // as a link *and* rendered as a QR — no second step for the user.
    verifyUri: String(payload.verification_uri_complete ?? payload.verification_uri ?? ''),
    intervalMs: Math.max(2_000, Number(payload.interval ?? 5) * 1_000),
    expiresInMs: Math.max(60_000, Number(payload.expires_in ?? 600) * 1_000),
  }
}

/**
 * One poll. Returns the terminal state, or `pending` to keep waiting.
 * @param {{ origin?: string, deviceCode: string }} input
 */
async function poll({ origin = ORIGINS.feishu, deviceCode }) {
  const response = await fetch(`${origin}${ENDPOINT}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ action: 'poll', device_code: deviceCode }).toString(),
    signal: AbortSignal.timeout(20_000),
  })
  const payload = await response.json().catch(() => undefined)
  // A pending poll answers HTTP 400 with `error=authorization_pending` — that is the
  // normal waiting state, not a failure. Only a response we cannot parse is an error.
  if (!payload) throw new Error(`轮询失败：HTTP ${response.status}（无法解析响应）`)

  // A Lark tenant must continue against the international accounts host.
  const brand = payload?.user_info?.tenant_brand
  const nextOrigin = brand === 'lark' ? ORIGINS.lark : undefined

  if (payload?.client_id && payload?.client_secret) {
    return {
      state: 'success',
      appId: String(payload.client_id),
      appSecret: String(payload.client_secret),
      tenantBrand: brand,
      origin: nextOrigin,
    }
  }
  const error = String(payload?.error ?? '')
  if (error === 'authorization_pending' || !error) return { state: 'pending', origin: nextOrigin }
  if (error === 'slow_down') return { state: 'slow_down', origin: nextOrigin }
  if (error === 'access_denied') return { state: 'denied', origin: nextOrigin }
  if (error === 'expired_token') return { state: 'expired', origin: nextOrigin }
  return { state: 'error', detail: String(payload?.error_description ?? error), origin: nextOrigin }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Drive begin → QR → poll until the phone confirms or the run ends. */
async function scan({ mode }) {
  const existing = readState()
  const createOnly = mode === 'create'
  const start = await begin({
    createOnly,
    appId: createOnly ? undefined : existing?.appId,
  })

  log('')
  log('用飞书扫描下面的二维码，或在手机飞书里打开链接确认：')
  log(`  ${start.verifyUri}`)
  if (start.userCode) log(`  配对码：${start.userCode}`)
  log('')
  try {
    const png = await renderQr(start.verifyUri, { out: join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'feishu-login-qr.png') })
    if (png) log(`  （终端二维码已渲染；图片：${png}）`)
  } catch { /* the link alone is enough */ }

  const deadline = Date.now() + start.expiresInMs
  let origin = ORIGINS.feishu
  let interval = start.intervalMs

  while (Date.now() < deadline) {
    await sleep(interval)
    const result = await poll({ origin, deviceCode: start.deviceCode })
    if (result.origin) origin = result.origin
    if (result.state === 'pending') { log('  等待手机确认…'); continue }
    if (result.state === 'slow_down') { interval += 5_000; log('  平台要求放慢轮询…'); continue }
    if (result.state === 'denied') { fail('已取消：手机端拒绝了授权。'); return }
    if (result.state === 'expired') { fail('二维码已过期，请重新运行本脚本。'); return }
    if (result.state === 'error') { fail(`授权失败：${result.detail}`); return }

    // success
    const state = {
      appId: result.appId,
      appSecret: result.appSecret,
      region: result.tenantBrand === 'lark' ? 'lark' : 'feishu',
      ...(existing?.defaultChatId ? { defaultChatId: existing.defaultChatId } : {}),
    }
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    log('')
    log(mode === 'create' ? '✅ 应用已创建，权限和事件已一并配置' : '✅ 缺失的权限已补齐')
    log(`   appId:  ${state.appId}`)
    log(`   region: ${state.region}`)
    log(`   凭据：  ${STATE_PATH}（0600）`)
    log('')
    log('下一步：在 profile 里打开 inboundEnabled，然后发一条飞书消息。')
    return
  }
  fail('等待超时，请重新运行本脚本。')
}

const status = () => {
  const state = readState()
  if (!state?.appId) { log('未配置：' + STATE_PATH); return }
  log(`appId:  ${state.appId}`)
  log(`region: ${state.region ?? 'feishu'}`)
  log(`secret: ${state.appSecret ? '已保存（0600）' : '缺失'}`)
  log(`默认群: ${state.defaultChatId || '(未记录)'}`)
}

const main = async () => {
  const args = process.argv.slice(2)
  if (args.includes('--status')) { status(); return }
  if (args.includes('--help') || args.includes('-h')) {
    log('用法：')
    log('  node scripts/feishu-login.mjs           扫码创建应用（自动带上所需权限与事件）')
    log('  node scripts/feishu-login.mjs --fix     给已配置的应用补齐缺失权限')
    log('  node scripts/feishu-login.mjs --status  查看已保存的凭据')
    return
  }
  if (args.includes('--fix')) {
    if (!readState()?.appId) { fail('还没有配置应用，先运行不带参数的版本创建。'); return }
    await scan({ mode: 'fix' })
    return
  }
  await scan({ mode: 'create' })
}

// Only run when this file is the entry point. Matching on the bare filename is wrong:
// `test/feishu-login.mjs` also ends with that name, and importing it would start a real
// registration run that waits an hour. Every exported function must stay importable.
const invokedDirectly = (() => {
  const entry = process.argv[1] ?? ''
  return /[\\/]scripts[\\/]feishu-login\.mjs$/i.test(entry)
})()

if (invokedDirectly) {
  main().catch((error) => fail(`失败：${error.message}`))
}
