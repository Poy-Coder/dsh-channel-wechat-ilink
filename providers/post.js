/**
 * Markdown → Feishu rich-text (`post`) payload.
 *
 * A card can render Markdown itself, but a card is not a message: it cannot be
 * forwarded, quoted, searched or copied as cleanly as a native one. When the answer
 * goes out as a native `post` message instead, the Markdown has to be turned into the
 * nested element structure the API expects.
 *
 * Supported, because the plugin's own answers use them: paragraphs, ATX headings,
 * bullet/ordered lists, fenced code blocks, bold, inline code and links. Anything else
 * degrades to plain text rather than being dropped.
 */

/** Feishu post limits: one message is capped, so callers split long answers first. */
export const POST_MAX_CHARS = 20_000

/** A table row: `| a | b |` — the separator row (`|---|---|`) is not data. */
const tableRow = (line) => /^\s*\|.*\|\s*$/.test(line)
const tableSeparator = (line) => /^\s*\|?[\s:-]*-[\s|:-]*$/.test(line) && line.includes('-')

/**
 * Render one table row as a single readable line.
 *
 * A `post` message has no table element (only cards do), so a markdown table would
 * otherwise arrive as a wall of pipes. Cells joined with `→` keep the reading order
 * and stay legible on a phone.
 * @param {string} line
 */
function tableLine(line) {
  const cells = String(line)
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell !== '')
  return cells.join(' → ')
}

/**
 * Strip the code fence marker and its language tag.
 * @param {string} line
 */
const fenceOpen = (line) => /^\s*```/.test(line)

/**
 * Inline Markdown → post elements for one line.
 * @param {string} line
 * @returns {Array<object>}
 */
export function inlineToPostElements(line) {
  const elements = []
  let rest = String(line ?? '')
  // Ordered by how specific they are: a link may contain bold, code never does.
  // `_x_` only counts as emphasis at a word boundary: `snake_case_name` in an answer
  // is an identifier, and italicising half of it would be worse than leaving it alone.
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|(?<![A-Za-z0-9_])_[^_\s][^_]*_(?![A-Za-z0-9_]))/g
  let last = 0
  let match
  while ((match = pattern.exec(rest)) !== null) {
    if (match.index > last) elements.push({ tag: 'text', text: rest.slice(last, match.index) })
    const token = match[0]
    if (token.startsWith('**')) {
      elements.push({ tag: 'text', text: token.slice(2, -2), style: ['bold'] })
    } else if (token.startsWith('`')) {
      elements.push({ tag: 'text', text: token.slice(1, -1), style: ['italic'] })
    } else if (token.startsWith('_')) {
      elements.push({ tag: 'text', text: token.slice(1, -1), style: ['italic'] })
    } else {
      const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(token)
      elements.push({ tag: 'a', text: link[1], href: link[2] })
    }
    last = match.index + token.length
  }
  if (last < rest.length) elements.push({ tag: 'text', text: rest.slice(last) })
  return elements.filter((item) => item.text !== '')
}

/**
 * Convert Markdown into the `post` message body.
 *
 * @param {string} markdown
 * @returns {{ zh_cn: { title: string, content: Array<Array<object>> } }}
 */
export function markdownToPost(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
  const content = []
  let inFence = false
  let fenceLines = []

  const flushFence = () => {
    if (fenceLines.length === 0) return
    content.push([{ tag: 'code_block', text: fenceLines.join('\n') }])
    fenceLines = []
  }

  let prevWasTableRow = false
  for (const line of lines) {
    if (fenceOpen(line)) {
      prevWasTableRow = false
      if (inFence) {
        flushFence()
        inFence = false
      } else {
        inFence = true
      }
      continue
    }
    if (inFence) {
      fenceLines.push(line)
      continue
    }
    if (line.trim() === '') {
      // A blank line separates paragraphs; `post` needs an explicit empty block.
      prevWasTableRow = false
      content.push([{ tag: 'text', text: '' }])
      continue
    }
    if (tableRow(line)) {
      // Cards can draw tables; messages cannot. Keep the reading order, drop the pipes,
      // and bold the first row so the header does not read as another data row.
      if (tableSeparator(line)) continue
      const isHeader = !prevWasTableRow
      prevWasTableRow = true
      const rendered = tableLine(line)
      if (rendered) {
        content.push(isHeader
          ? [{ tag: 'text', text: rendered, style: ['bold'] }]
          : [{ tag: 'text', text: rendered }])
      }
      continue
    }
    prevWasTableRow = false
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      content.push([{ tag: 'text', text: heading[2], style: ['bold'] }])
      continue
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      content.push([{ tag: 'text', text: `• ${bullet[2]}` }])
      continue
    }
    const ordered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line)
    if (ordered) {
      content.push([{ tag: 'text', text: `${ordered[2]}. ${ordered[3]}` }])
      continue
    }
    content.push(inlineToPostElements(line))
  }
  if (inFence) flushFence()

  // Trailing blank blocks carry no meaning; leading ones look like a layout bug.
  while (content.length > 0 && content[content.length - 1].every((item) => item.text === '')) content.pop()
  while (content.length > 0 && content[0].every((item) => item.text === '')) content.shift()
  if (content.length === 0) content.push([{ tag: 'text', text: ' ' }])

  return { zh_cn: { title: '', content } }
}

/**
 * Split a long answer into `post` payloads that each stay under the message limit.
 * Splitting happens on blank lines first, then on hard character cuts.
 *
 * @param {string} markdown
 * @param {number} [limit]
 * @returns {Array<{ zh_cn: { title: string, content: Array<Array<object>> } }>}
 */
export function splitForPost(markdown, limit = POST_MAX_CHARS) {
  const text = String(markdown ?? '')
  if (text.length <= limit) return [markdownToPost(text)]
  const chunks = []
  let buffer = ''
  for (const part of text.split(/(\n\n+)/)) {
    if (buffer.length + part.length <= limit) {
      buffer += part
      continue
    }
    if (buffer.trim()) chunks.push(buffer)
    buffer = part
    while (buffer.length > limit) {
      chunks.push(buffer.slice(0, limit))
      buffer = buffer.slice(limit)
    }
  }
  if (buffer.trim()) chunks.push(buffer)
  return chunks.map((chunk) => markdownToPost(chunk))
}
