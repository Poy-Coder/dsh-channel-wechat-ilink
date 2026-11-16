/**
 * WeChat channel end-to-end check: receive one message, answer it in two parts.
 *
 * The bot cannot start a conversation — iLink signs a `context_token` per inbound
 * message — so this script waits for you to send one from WeChat, replies "第 1/2
 * 段" and "第 2/2 段", then reports the round trip. It replaces the three ad-hoc
 * `wechat-*-probe.mjs` scripts for smoke testing.
 *
 * Usage:
 *   node scripts/wechat-e2e.mjs                 # wait up to 120 s
 *   node scripts/wechat-e2e.mjs --timeout 300   # longer
 *   node scripts/wechat-e2e.mjs --dry-run       # only verify credentials + status
 *
 * Requires a saved login (`node scripts/wechat-login.mjs --qr`).
 */
import { createWechatProvider } from '../providers/wechat.js'

const argValue = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}
const timeoutSeconds = Number(argValue('--timeout', '120')) || 120
const dryRun = process.argv.includes('--dry-run')

const provider = createWechatProvider({})

const preview = (message) => {
  const items = Array.isArray(message?.item_list) ? message.item_list : []
  const text = items.find((item) => item?.type === 1)?.text_item?.text ?? ''
  const kinds = items.map((item) => (item?.type === 1 ? 'text' : item?.type === 2 ? 'image' : item?.type === 4 ? 'file' : `type${item?.type}`))
  return { text: String(text).slice(0, 40), kinds: kinds.join('+') || 'empty' }
}

async function main() {
  const status = await provider.checkStatus()
  console.log(`status: configured=${status.configured} tokenOk=${status.tokenOk} account=${status.accountId ?? ''}`)
  if (status.poll) console.log(`poll: lastOkAt=${status.poll.lastOkAt} rebuilds=${status.poll.rebuilds} stalled=${status.poll.stalled}`)
  if (!status.configured || !status.tokenOk) {
    console.log('FAIL: not logged in (run node scripts/wechat-login.mjs --qr)')
    process.exit(1)
  }
  if (dryRun) {
    console.log('dry-run: credentials and status look fine')
    return
  }

  console.log(`waiting for one WeChat message (up to ${timeoutSeconds}s)…`)
  const startedAt = Date.now()
  const received = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no inbound message within ${timeoutSeconds}s`)), timeoutSeconds * 1000)
    let cleanup = () => {}
    provider.connect({
      onEvent: (message) => {
        clearTimeout(timer)
        cleanup()
        resolve(message)
      },
      onState: (state) => { if (!state.ready) console.log(`transport: ${state.error ?? 'down'}`) },
    }).then((close) => { cleanup = close }).catch((error) => { clearTimeout(timer); reject(error) })
  })
  const roundTripMs = Date.now() - startedAt
  const seen = preview(received)
  console.log(`received in ${roundTripMs}ms: kinds=${seen.kinds} text="${seen.text}"`)

  const chatId = String(received?.from_user_id ?? '')
  if (!chatId) throw new Error('inbound message has no from_user_id')
  const first = await provider.sendText({ chatId, text: `E2E 收到（${seen.kinds}）：${seen.text || '（无文本）'}\n\n第 1/2 段` })
  const second = await provider.sendText({ chatId, text: '第 2/2 段：收发改道正常。' })
  console.log(`sent: ${first?.messageId ?? '?'} / ${second?.messageId ?? '?'}`)
  console.log('E2E_OK')
}

main().catch((error) => {
  console.log(`E2E_FAILED:${String(error?.message ?? error).slice(0, 300)}`)
  process.exit(1)
})
