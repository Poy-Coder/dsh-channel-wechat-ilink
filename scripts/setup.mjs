#!/usr/bin/env node
/**
 * One-command credential setup for dsh-channel-feishu.
 *
 * The only manual step left after `dsh plugin add` is teaching the plugin the
 * Feishu app credentials. Doing that by hand invites two mistakes: a UTF-8 BOM
 * in the JSON file (the plugin then fails to load) and a wrong region. This
 * script finds the credentials that another Feishu channel already uses, writes
 * the file correctly, and verifies them against the Feishu API.
 *
 * Usage:
 *   node scripts/setup.mjs                    # scan, write, verify
 *   node scripts/setup.mjs --dry-run          # scan and verify only
 *   node scripts/setup.mjs --region lark      # international tenant
 *   node scripts/setup.mjs --app-id X --app-secret Y
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const valueOf = (flag) => {
  const at = argv.indexOf(flag)
  return at >= 0 ? String(argv[at + 1] ?? '') : ''
}

const dryRun = has('--dry-run')
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const target = join(HOME, 'feishu-channel.json')
const say = (...args) => console.log(...args)

const mask = (value) => {
  const text = String(value ?? '')
  if (text.length <= 8) return text ? '****' : ''
  return `${text.slice(0, 6)}…${text.slice(-4)}（${text.length} 字符）`
}

/** Read every small text file under the DSH home, skipping noise. */
function candidateFiles() {
  const skip = new Set(['sessions', 'node_modules', 'attachments', 'feishu-inbound-files', '.git'])
  const found = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue
        walk(path, depth + 1)
        continue
      }
      if (!/\.(json|ya?ml|env)$/i.test(entry.name)) continue
      try {
        if (statSync(path).size > 512 * 1024) continue
      } catch { continue }
      found.push(path)
    }
  }
  walk(HOME, 0)
  return found
}

const pick = (text, key) => {
  const match = text.match(new RegExp(`["']?${key}["']?\\s*[:=]\\s*["']?([A-Za-z0-9_-]{6,})`, 'i'))
  return match ? match[1] : ''
}

function scan() {
  const fromEnv = {
    appId: String(process.env.FEISHU_APP_ID ?? '').trim(),
    appSecret: String(process.env.FEISHU_APP_SECRET ?? '').trim(),
    source: 'environment',
  }
  if (fromEnv.appId && fromEnv.appSecret) return fromEnv

  if (existsSync(target)) {
    try {
      const existing = JSON.parse(readFileSync(target, 'utf8'))
      if (existing.appId && existing.appSecret) {
        return { ...existing, source: target }
      }
    } catch { /* unreadable: fall through to the scan */ }
  }

  for (const path of candidateFiles()) {
    let text
    try { text = readFileSync(path, 'utf8') } catch { continue }
    const appId = pick(text, 'appId') || pick(text, 'FEISHU_APP_ID') || pick(text, 'app_id')
    const appSecret = pick(text, 'appSecret') || pick(text, 'FEISHU_APP_SECRET') || pick(text, 'app_secret')
    if (!appId || !appSecret) continue
    const region = /(?:region|lark)/i.test(text) && /lark/i.test(text) ? 'lark' : 'feishu'
    const chat = pick(text, 'defaultChatId') || pick(text, 'chat_id')
    return { appId, appSecret, region, defaultChatId: chat, source: path }
  }
  return undefined
}

async function verify({ appId, appSecret, region }) {
  const base = region === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
  try {
    const response = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    })
    const payload = await response.json().catch(() => undefined)
    if (payload?.code === 0 && payload?.tenant_access_token) return { ok: true }
    return { ok: false, reason: `code=${payload?.code ?? '?'} msg=${payload?.msg ?? response.status}` }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

const explicitId = valueOf('--app-id')
const explicitSecret = valueOf('--app-secret')
const found = explicitId && explicitSecret
  ? { appId: explicitId, appSecret: explicitSecret, source: 'command line' }
  : scan()

if (!found) {
  say('没找到飞书应用凭据。请二选一：')
  say(`  1. 写 ${target}：{"appId":"…","appSecret":"…","region":"feishu","defaultChatId":"oc_…"}`)
  say('  2. 设置环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET')
  say('提示：Windows 上用 PowerShell 5.1 的 Set-Content -Encoding UTF8 会写入 BOM，插件会加载失败。')
  process.exit(1)
}

const region = valueOf('--region') || String(found.region ?? '').trim() || 'feishu'
say(`来源: ${found.source}`)
say(`appId: ${mask(found.appId)}`)
say(`appSecret: ${mask(found.appSecret)}`)
say(`region: ${region}`)

const check = await verify({ appId: found.appId, appSecret: found.appSecret, region })
say(`凭据校验: ${check.ok ? '通过（tenant_access_token 获取成功）' : `失败（${check.reason}）`}`)

if (dryRun) {
  say('dry run：未写入任何文件。')
  process.exit(check.ok ? 0 : 1)
}
if (!check.ok) {
  say('凭据未通过校验，不写入。核对 appId / appSecret / region 后重试。')
  process.exit(1)
}

const payload = {
  appId: found.appId,
  appSecret: found.appSecret,
  region,
  ...(String(found.defaultChatId ?? '').trim() ? { defaultChatId: String(found.defaultChatId).trim() } : {}),
}
mkdirSync(dirname(target), { recursive: true })
// UTF-8 without BOM: a BOM makes the plugin's JSON.parse fail at load time.
writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
say(`已写入 ${target}（UTF-8 无 BOM，仅当前用户可读）`)
say('')
say('下一步：')
say('  1. 如有别的飞书插件用同一个 App，先在 profile 的 cordis.patch.yml 里给它加 disabled: true')
say('  2. 完全退出 DSH 再打开（关窗口只是隐藏）')
say('  3. 打开后机器人会发一条「飞书通道已就绪」，也可以调 feishu_channel_status 确认')
