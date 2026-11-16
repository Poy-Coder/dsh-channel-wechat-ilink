/**
 * Text-channel stream engine.
 *
 * Feishu answers inside one card that can be patched; WeChat has no editable
 * message, so the same turn has to become a **sequence of plain messages**. This
 * module owns that policy and nothing else: it turns the channel's cumulative
 * turn text into a list of actions (`typing`, `send`), so the transport stays a
 * dumb sender and the rules are testable without any network.
 *
 * The rules, in one place:
 *
 *   - While the model has no answer yet the framework feeds `progressText()`
 *     ("思考中… · 正在执行 pwsh · 已调用 3 个工具 · 已用时 75s"). The engine keeps
 *     the "typing…" indicator on and pushes at most one progress message after
 *     `progressFirstMs`, then one per `progressGapMs` and at most `progressMax`
 *     times — a WeChat chat must not be filled with status bubbles.
 *   - Once answer text arrives it is cut at paragraph and sentence boundaries so
 *     every message is a readable unit (a WeChat bubble with half a sentence
 *     looks like a bug). The first slice goes out early so the user sees the
 *     answer start instead of waiting for the whole thing.
 *   - A fenced code block is never cut while it is open.
 *   - `finish()` flushes the remainder, splits anything over `maxSegmentChars`
 *     and turns the typing indicator off.
 *   - Everything sent is plain text: WeChat renders no Markdown and no HTML.
 */

/**
 * The default policy. Tuned for a phone chat, not for a log viewer:
 * 30 s before the first progress bubble (shorter turns only show "typing…"),
 * then one per 3 minutes, at most 3 per turn.
 */
export const TEXT_STREAM_LIMITS = {
  progressFirstMs: 30_000,
  progressGapMs: 180_000,
  progressMax: 3,
  /** A paragraph break ends a message once it holds this much text. */
  minParagraphChars: 40,
  /** A sentence end ends a message once it holds this much text. */
  minSentenceChars: 120,
  /** With nothing sent yet, the first slice may go out at this length. */
  firstSegmentChars: 24,
  maxSegmentChars: 1500,
  /** Hard cap on answer bubbles per turn; the rest is handed over as a file. */
  maxAnswerMessages: 12,
  /** Hard cap on answer characters in the chat; a long report becomes a file. */
  maxChatChars: 3000,
}

/**
 * WeChat renders plain text only: strip the card HTML and the inline Markdown
 * that would read as noise, but keep what a plain-text reader still needs —
 * fenced code blocks and their content stay byte-for-byte, inline `code` keeps
 * its backticks, tables stay untouched. The official client's filter makes the
 * same trade-off.
 */
export function toWechatText(markdown) {
  const lines = String(markdown ?? '')
    .replace(/<\/?font[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
  const out = []
  let fence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      fence = !fence
      out.push(line)
      continue
    }
    // Inside a fenced block every character is the author's: no rewriting.
    if (fence) {
      out.push(line)
      continue
    }
    out.push(line
      .replace(/^#{1,6}\s+/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
      .replace(/^\s*[-*]\s+/, '· ')
      .replace(/^\s*>\s?/, ''))
  }
  return out.join('\n').trim()
}

/**
 * A progress bubble for a plain-text chat.
 *
 * The card version starts with "思考中…" because it is one continuously updated
 * card; a WeChat bubble is a moment in time, so it says what is happening right
 * now and drops the repeated header.
 */
export function progressBubble(markdown) {
  const body = toWechatText(markdown).replace(/^思考中…\s*/, '').trim()
  return body ? `还在跑 · ${body}` : '还在跑 · 思考中…'
}

/** The framework's placeholder: "思考中…" plus an optional grey meta line. */
function isProgressText(text) {
  return /^思考中…/.test(text) && text.length < 400
}

const SENTENCE_ENDS = ['。', '！', '？', '；', '\n']

function lastSentenceEnd(text) {
  let at = -1
  for (const mark of SENTENCE_ENDS) at = Math.max(at, text.lastIndexOf(mark))
  return at
}

/** True while a ``` fence is open, so a code block is never split. */
function fenceOpen(text) {
  return (text.match(/^```/gm)?.length ?? 0) % 2 === 1
}

/**
 * Turn the row config into this engine's limits.
 *
 * `textProgressSeconds` is the one knob a user is expected to touch: the default
 * 30 s is a compromise between "don't leave me staring at nothing" and "don't
 * send me a status bubble every half minute". 0 disables progress messages
 * entirely; the typing indicator still runs.
 */
export function streamLimitsFromConfig(config = {}) {
  const seconds = Number(config?.textProgressSeconds)
  if (!Number.isFinite(seconds) || seconds < 0) return { ...TEXT_STREAM_LIMITS }
  if (seconds === 0) return { ...TEXT_STREAM_LIMITS, progressFirstMs: Number.POSITIVE_INFINITY, progressMax: 0 }
  return { ...TEXT_STREAM_LIMITS, progressFirstMs: seconds * 1000 }
}

/**
 * Pick the next slice to send, or '' when the text should keep accumulating.
 * @param pending - answer text not yet sent
 * @param final - the turn is over: flush regardless of the size thresholds
 * @param first - nothing has been sent yet: prefer showing something early
 */
function takeSegment(pending, { final, first, limits }) {
  if (!pending) return ''
  if (final) return pending.length > limits.maxSegmentChars ? pending.slice(0, limits.maxSegmentChars) : pending
  if (fenceOpen(pending)) {
    const close = pending.indexOf('\n```', 1)
    if (close < 0) return pending.length >= limits.maxSegmentChars * 2 ? pending.slice(0, limits.maxSegmentChars * 2) : ''
    const end = close + 4
    return end >= limits.minSentenceChars ? pending.slice(0, end) : ''
  }
  const paragraph = pending.lastIndexOf('\n\n')
  if (paragraph >= 0 && paragraph + 2 >= limits.minParagraphChars) return pending.slice(0, paragraph + 2)
  const sentence = lastSentenceEnd(pending)
  if (sentence >= 0 && sentence + 1 >= limits.minSentenceChars) return pending.slice(0, sentence + 1)
  if (first && pending.length >= limits.firstSegmentChars) {
    return pending.slice(0, sentence >= 0 ? sentence + 1 : pending.length)
  }
  if (pending.length >= limits.maxSegmentChars) return pending.slice(0, limits.maxSegmentChars)
  return ''
}

/**
 * One turn's message policy. Feed it the channel's cumulative text; it answers
 * with the actions to run. A turn gets its own instance.
 *
 * @param now - injectable clock (tests use it to drive the progress cadence)
 */
export function createTextStream({ limits = TEXT_STREAM_LIMITS, now = () => Date.now() } = {}) {
  const startedAt = now()
  const state = {
    emitted: 0,
    typing: false,
    progressSent: 0,
    progressSentAt: 0,
    lastProgress: '',
    lastProgressKey: '',
    answerMessages: 0,
    charsSent: 0,
    done: false,
  }

  const begin = () => {
    if (state.typing) return []
    state.typing = true
    return [{ kind: 'typing', on: true }]
  }

  const progressActions = (text, actions) => {
    state.lastProgress = text
    if (state.done) return
    // Once the answer has started the user is reading text, not waiting in
    // silence; a status bubble on top of it is only noise.
    if (state.emitted > 0) return
    if (state.progressSent >= limits.progressMax) return
    if (now() - startedAt < limits.progressFirstMs) return
    // The gap only applies between bubbles; the first one is due as soon as the
    // turn has been silent long enough.
    if (state.progressSent > 0 && now() - state.progressSentAt < limits.progressGapMs) return
    // The same "思考中… · 已用时 Ns" ticker must not repeat: only a changed
    // status (a different tool, a new count) is worth a bubble.
    const key = text.replace(/已用时 \d+s?/g, '')
    if (key === state.lastProgressKey) return
    state.progressSent += 1
    state.progressSentAt = now()
    state.lastProgressKey = key
    actions.push({ kind: 'send', tag: 'progress', text: progressBubble(text) })
  }

  const push = (content) => {
    const actions = []
    if (state.done) return actions
    const text = String(content ?? '')
    if (!text) return actions
    if (isProgressText(text)) {
      progressActions(text, actions)
      return actions
    }
    if (text.length <= state.emitted) return actions
    let pending = text.slice(state.emitted)
    while (state.answerMessages < limits.maxAnswerMessages) {
      const segment = takeSegment(pending, { final: false, first: state.emitted === 0, limits })
      if (!segment) break
      // The chat is not a log viewer: past the character budget the rest is
      // delivered as a file (see finish) instead of forty bubbles.
      if (state.charsSent + segment.length > limits.maxChatChars) break
      actions.push({ kind: 'send', tag: 'answer', text: toWechatText(segment) })
      state.emitted += segment.length
      state.charsSent += segment.length
      state.answerMessages += 1
      pending = text.slice(state.emitted)
    }
    return actions
  }

  const finish = (content) => {
    const actions = []
    if (state.done) return actions
    state.done = true
    const text = String(content ?? '')
    if (text.length > state.emitted) {
      while (state.answerMessages < limits.maxAnswerMessages) {
        const pending = text.slice(state.emitted)
        if (!pending) break
        const segment = takeSegment(pending, { final: true, first: state.emitted === 0, limits })
        if (!segment) break
        if (state.charsSent + segment.length > limits.maxChatChars) break
        actions.push({ kind: 'send', tag: 'answer', text: toWechatText(segment) })
        state.emitted += segment.length
        state.charsSent += segment.length
        state.answerMessages += 1
      }
      const tail = text.slice(state.emitted)
      if (tail.trim()) {
        // The tail travels with the action so the transport can save it as a
        // file (or a note) instead of dropping what did not fit.
        actions.push({ kind: 'truncated', text: tail, remaining: tail.length })
      }
    }
    if (state.typing) {
      state.typing = false
      actions.push({ kind: 'typing', on: false })
    }
    return actions
  }

  return {
    begin,
    push,
    finish,
    state: () => ({
      emitted: state.emitted,
      answerMessages: state.answerMessages,
      progressSent: state.progressSent,
      typing: state.typing,
      done: state.done,
    }),
  }
}
