/**
 * Streaming probe v3: is the update keyed by the SERVER message id?
 *
 * v2 showed the server returns a *different* message_id for every frame, even
 * with the same client_id. So the next hypothesis is `msg.message_id`: create
 * the bubble once, then keep sending with its id.
 *
 * Run: node scripts/wechat-stream-probe3.mjs
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const cred = JSON.parse(readFileSync(join(HOME, 'wechat-channel.json'), 'utf8'))
const BASE = String(cred.baseUrl || 'https://ilinkai.weixin.qq.com').replace(/\/$/, '')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tokens = JSON.parse(readFileSync(join(HOME, 'wechat-context-tokens.json'), 'utf8'))
const [userId, contextToken] = Object.entries(tokens).at(-1) ?? []
if (!userId || !contextToken) {
  console.log('NO_TOKEN: send the bot a message first')
  process.exit(1)
}

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

async function send({ clientId, state, text, messageId }) {
  const msg = {
    from_user_id: '',
    to_user_id: userId,
    client_id: clientId,
    message_type: 2,
    message_state: state,
    item_list: [{ type: 1, text_item: { text } }],
    context_token: contextToken,
  }
  if (messageId) msg.message_id = messageId
  const res = await fetch(`${BASE}/ilink/bot/sendmessage`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ msg, base_info: { channel_version: '2.4.10', bot_agent: 'DSH/0.1' } }),
  })
  const text2 = await res.text()
  let parsed = {}
  try { parsed = JSON.parse(text2) } catch { /* ignore */ }
  console.log(`state=${state} sentId=${messageId ?? '-'} -> http=${res.status} message_id=${parsed.message_id ?? '-'} ${text2.slice(0, 90)}`)
  return parsed.message_id
}

const clientId = `dsh-stream-probe-${randomUUID()}`
console.log('实验：第 1 帧创建气泡，拿到 message_id 后，第 2/3 帧带同一个 message_id 更新')
const firstId = await send({ clientId, state: 1, text: '【A】这是第一条。' })
await sleep(4_000)
const secondId = await send({ clientId, state: 1, text: '【A】这是第一条。\n【B】带 message_id 的第二次发送。', messageId: firstId })
await sleep(4_000)
await send({ clientId, state: 2, text: '【A】这是第一条。\n【B】带 message_id 的第二次发送。\n【C】完成。', messageId: secondId ?? firstId })
console.log('done. firstId=', firstId, 'secondId=', secondId)
