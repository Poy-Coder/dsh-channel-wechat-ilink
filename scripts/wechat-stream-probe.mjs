/**
 * Streaming probe v2: does the WeChat client repaint one bubble when several
 * `sendmessage` frames share a `client_id` and move GENERATING(1) → FINISH(2)?
 *
 * The probe waits for a fresh context token: iLink rejects a send without one
 * ("prepare failed"), and only an inbound message issues a token.
 *
 * Run: node scripts/wechat-stream-probe.mjs
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const cred = JSON.parse(readFileSync(join(HOME, 'wechat-channel.json'), 'utf8'))
const BASE = String(cred.baseUrl || 'https://ilinkai.weixin.qq.com').replace(/\/$/, '')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const readTokens = () => {
  try { return JSON.parse(readFileSync(join(HOME, 'wechat-context-tokens.json'), 'utf8')) } catch { return {} }
}

let [userId, contextToken] = Object.entries(readTokens()).at(-1) ?? []
if (!userId || !contextToken) {
  console.log('WAITING_FOR_TOKEN: 请在微信里给机器人发一条消息（任意内容），探针会自动继续…')
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    await sleep(1_000)
    ;[userId, contextToken] = Object.entries(readTokens()).at(-1) ?? []
    if (userId && contextToken) break
  }
}
if (!userId || !contextToken) {
  console.log('NO_TOKEN: 5 分钟内没有收到新消息，探针退出')
  process.exit(1)
}
console.log('token ready for', userId)

const encodeVersion = (version) => {
  const [major = 0, minor = 0, patch = 0] = String(version).split('.').map((part) => parseInt(part, 10) || 0)
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}
const headers = {
  'Content-Type': 'application/json',
  AuthorizationType: 'ilink_bot_token',
  'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
  'iLink-App-Id': 'bot',
  'iLink-App-ClientVersion': String(encodeVersion('2.4.10')),
  Authorization: `Bearer ${cred.botToken}`,
}

async function send(clientId, state, text) {
  const res = await fetch(`${BASE}/ilink/bot/sendmessage`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      msg: {
        from_user_id: '',
        to_user_id: userId,
        client_id: clientId,
        message_type: 2,
        message_state: state,
        item_list: [{ type: 1, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: { channel_version: '2.4.10', bot_agent: 'DSH/0.1' },
    }),
  })
  const body = await res.text()
  console.log(`state=${state} chars=${text.length} http=${res.status} ${body.slice(0, 120)}`)
  return body
}

const clientId = `dsh-stream-probe-${randomUUID()}`
console.log('开始：先发【第 1 版】，5 秒后发【第 2 版】… 请盯着那条气泡看 15 秒')
await send(clientId, 1, '【第 1 版】请盯着这条气泡看 15 秒。')
await sleep(5_000)
await send(clientId, 1, '【第 1 版】请盯着这条气泡看 15 秒。\n【第 2 版】现在应该多出这一行。')
await sleep(5_000)
await send(clientId, 1, '【第 1 版】请盯着这条气泡看 15 秒。\n【第 2 版】现在应该多出这一行。\n【第 3 版】又多了这一行。')
await sleep(5_000)
await send(clientId, 2, '【完成】如果第 1→2→3 版是在同一条气泡里依次出现的，说明支持真流式；如果直到这一帧才一起出现，说明客户端只在 FINISH 时渲染。')
console.log('probe done; clientId =', clientId)
