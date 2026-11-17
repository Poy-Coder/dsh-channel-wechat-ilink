#!/usr/bin/env node
/**
 * Does iLink still know about messages before the current cursor?
 *
 * `getUpdates` takes an opaque cursor and returns what came after it. Whether an
 * OLD cursor still returns the messages it already passed decides if the channel
 * can recover a missed message by re-reading — a read-only alternative to sending
 * probe messages into the user's chat.
 *
 *   node scripts/wechat-history-probe.mjs                 # current cursor (no-op read)
 *   node scripts/wechat-history-probe.mjs --empty         # empty cursor: does it replay?
 *   node scripts/wechat-history-probe.mjs --cursor=<c>    # an older cursor you saved
 *   node scripts/wechat-history-probe.mjs --timeout=5000
 *
 * The probe never writes the cursor back, so the running channel keeps its own.
 * It DOES consume whatever the server hands it, so do not run it while you expect
 * an important message to arrive.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const empty = args.includes('--empty')
const timeoutMs = Number(flag('timeout') ?? 8000)
const explicitCursor = flag('cursor')

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const credsPath = join(home, 'wechat-channel.json')
const syncPath = join(home, 'wechat-sync.json')

const creds = JSON.parse(readFileSync(credsPath, 'utf8'))
const baseUrl = String(creds.baseUrl ?? 'https://ilinkai.weixin.qq.com').replace(/\/+$/, '')
const token = String(creds.botToken ?? '')
const accountId = String(creds.accountId ?? '')
if (!token) throw new Error(`no botToken in ${credsPath}`)

let stored = {}
try { stored = JSON.parse(readFileSync(syncPath, 'utf8')) } catch { /* first run */ }
const currentCursor = String(stored.cursor ?? '')

const cursor = empty ? '' : (explicitCursor ?? currentCursor)
const label = empty ? '(empty)' : (explicitCursor ? `(given, ${explicitCursor.length} chars)` : `(current, ${currentCursor.length} chars)`)

const headers = {
  'Content-Type': 'application/json',
  AuthorizationType: 'ilink_bot_token',
  'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
  'iLink-App-Id': 'bot',
  'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 10),
  Authorization: `Bearer ${token}`,
}

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), timeoutMs)
let response
try {
  const res = await fetch(`${baseUrl}/ilink/bot/getupdates`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ get_updates_buf: cursor, base_info: { channel_version: '2.4.10', bot_agent: 'DSH/0.1' } }),
    signal: controller.signal,
  })
  const text = await res.text()
  console.log(`HTTP ${res.status}  cursor=${label}`)
  response = text ? JSON.parse(text) : {}
} catch (error) {
  console.log(`request failed (or timed out after ${timeoutMs} ms): ${error?.message ?? error}`)
  process.exit(1)
} finally {
  clearTimeout(timer)
}

const messages = Array.isArray(response.msgs) ? response.msgs : []
console.log(`ret=${response.ret} errcode=${response.errcode ?? '-'} msgs=${messages.length}`)
console.log(`next cursor: ${String(response.get_updates_buf ?? '').length} chars`)

let seenIds = []
try {
  const state = JSON.parse(readFileSync(join(home, 'wechat-channel-state.json'), 'utf8'))
  seenIds = Array.isArray(state.seenEvents) ? state.seenEvents : []
} catch { /* no state yet */ }

for (const message of messages) {
  const id = String(message?.message_id ?? message?.msg_id ?? '')
  const from = String(message?.from_user_id ?? '')
  const kind = String(message?.message_type ?? '?')
  const text = String(message?.item_list?.find?.((item) => item?.text_item)?.text_item?.text ?? '').slice(0, 40)
  const known = seenIds.includes(id) ? 'already-seen' : 'NEW'
  console.log(`  ${id} [${known}] from=${from} type=${kind} ${text}`)
}
if (messages.length === 0) {
  console.log('empty response: either nothing new, or this server does not replay history for this cursor')
}
