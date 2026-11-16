/**
 * Render the WeChat login QR into something a phone can actually scan.
 *
 * `scripts/wechat-login.mjs` can only print the QR payload URL — turning that
 * URL into an image is what makes the login usable without a third-party QR
 * service (which would leak the one-time login token to that service).
 *
 * Usage:
 *   node scripts/wechat-login.mjs --qr     # login, rendering the QR in place
 *   node scripts/wechat-qr.mjs <qr-url> [out.png]
 *
 * Output: the QR in the terminal (block characters) plus `PNG:<absolute path>` —
 * attach that file where a phone can see it (e.g. send it to the Feishu chat).
 *
 * `qrcode` is a devDependency: without it the script still prints the URL and the
 * install hint instead of failing obscurely.
 */
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_OUT = resolve(process.cwd(), 'wechat-qr.png')

async function loadQr() {
  try {
    const module = await import('qrcode')
    return module.default ?? module
  } catch {
    return undefined
  }
}

/**
 * Render `url` as a terminal QR and a PNG file.
 *
 * @returns {Promise<{ png: string, width: number } | undefined>} undefined when
 * the optional `qrcode` dependency is absent.
 */
export async function renderQr(url, { out = DEFAULT_OUT, width = 480 } = {}) {
  if (!url) throw new Error('renderQr needs the QR payload URL')
  const QR = await loadQr()
  if (!QR) return undefined
  const terminal = await QR.toString(url, { type: 'terminal', small: true, errorCorrectionLevel: 'M' })
  process.stdout.write(`${terminal}\n`)
  mkdirSync(dirname(out), { recursive: true })
  await QR.toFile(out, url, { width, margin: 2, errorCorrectionLevel: 'M' })
  return { png: out, width }
}

async function main() {
  const url = String(process.argv[2] ?? '').trim()
  if (!url) {
    console.error('usage: node scripts/wechat-qr.mjs <qr-url> [out.png]')
    console.error('get <qr-url> from `node scripts/wechat-login.mjs` (it prints QR_URL:…)')
    process.exit(1)
  }
  const out = resolve(process.argv[3] ?? DEFAULT_OUT)
  const rendered = await renderQr(url, { out })
  if (!rendered) {
    console.log('QR_PNG:skipped (qrcode is not installed — run `npm i -D qrcode`, then retry)')
    process.exit(2)
  }
  console.log(`PNG:${rendered.png}`)
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`QR_FAILED:${String(error?.message ?? error).slice(0, 300)}`)
    process.exit(1)
  })
}
