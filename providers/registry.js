/**
 * Channel provider registry.
 *
 * The framework in `index.js` never imports a transport directly: it asks for
 * `provider` in the row config (default `feishu`) and receives the adapter.
 * A new IM is a new module exporting `create<Name>Provider(config, deps)` plus
 * one entry here — the channel behavior needs no change.
 */

import { createFeishuProvider } from './feishu.js'
import { createWechatProvider } from './wechat.js'

const factories = new Map([
  ['feishu', createFeishuProvider],
  ['wechat', createWechatProvider],
])

export function registerProvider(id, factory) {
  factories.set(String(id).trim().toLowerCase(), factory)
}

export function providerIds() {
  return [...factories.keys()]
}

export function resolveProvider(config = {}, deps = {}) {
  const id = String(config?.provider ?? 'feishu').trim().toLowerCase() || 'feishu'
  const factory = factories.get(id)
  if (!factory) {
    throw new Error(`unknown channel provider "${id}" (known: ${providerIds().join(', ')})`)
  }
  return factory(config, deps)
}
