/**
 * Reading the live conversation surface.
 *
 * `ctx.sessionQuery.readSurface(sessionId)` is the supported way to see what
 * the model actually has in front of it, live sessions preferred. Everything
 * here is defensive: a host that cannot answer returns empty lists rather
 * than failing the turn being judged.
 */
import { contentText } from '../shared/analyze.js'
import { log } from '../shared/log.js'

/** Map a surface event to a simple transcript message, or null. */
function toMessage(event) {
  if (!event || typeof event !== 'object') return null
  const data = event.data ?? {}
  // The event's own turn number is carried through: it is what lets the manual
  // tool avoid judging a turn that is still streaming.
  const turn = typeof data.turn === 'number' ? data.turn : undefined
  if (event.type === 'user/message') {
    const message = data.message ?? data
    const text = contentText(message?.content ?? data.content)
    return text.trim() === '' ? null : { role: 'user', text, seq: event.seq, turn }
  }
  if (event.type === 'assistant/message') {
    const message = data.message ?? data
    const text = contentText(message?.content ?? data.content)
    return text.trim() === '' ? null : { role: 'assistant', text, seq: event.seq, turn }
  }
  return null
}

/** Read one session surface into a plain transcript. */
export async function readTranscript(ctx, sessionId, limit = 12) {
  const sessionQuery = ctx.get('sessionQuery')
  if (!sessionQuery) {
    log('transcript: the sessionQuery service is unavailable')
    return []
  }
  if (!sessionId) {
    log('transcript: no session id supplied')
    return []
  }
  let snapshot
  try {
    snapshot = await sessionQuery.readSurface(sessionId)
  } catch (error) {
    // console.error is invisible inside the host process; a surface read that
    // throws left zero evidence, so it goes to the file log instead.
    log(`transcript: readSurface failed for ${sessionId}: ${error?.message ?? error}`)
    return []
  }
  const messages = []
  for (const event of snapshot?.events ?? []) {
    const message = toMessage(event)
    if (message) messages.push(message)
  }
  log(
    `transcript: ${snapshot?.events?.length ?? 0} surface events -> ${messages.length} messages ` +
    `(${messages.filter(m => m.role === 'user').length} user / ${messages.filter(m => m.role === 'assistant').length} assistant)`,
  )
  return limit > 0 ? messages.slice(-limit) : messages
}

/**
 * Read the session's complete durable log instead of the live surface.
 *
 * `readSurface` returns what is *currently in context*. Once a turn is older
 * than the live window its answer is simply absent — a measured run asked this
 * reader for the previous turn and got `answer 0 chars`, which is a dead end
 * no amount of window widening can fix. The log keeps every event, so the
 * manual tool uses this and only falls back to the surface when it must.
 */
export async function readSessionLog(ctx, sessionId, limit = 0) {
  const sessionQuery = ctx.get('sessionQuery')
  if (!sessionQuery || !sessionId) return { messages: [], source: 'unavailable' }
  try {
    const snapshot = await sessionQuery.readSession(sessionId)
    // The return shape is not documented beyond its type name, and guessing it
    // wrong silently falls back to the surface — which is exactly the "answer
    // 2989 chars" failure. So every shape that can hold events is tried, the
    // pre-filter count is reported, and the snapshot's own keys are logged.
    const events = findEventArray(snapshot)
    if (events === undefined) {
      log(
        `transcript: readSession returned no event array; snapshot keys = ` +
        `${snapshot && typeof snapshot === 'object' ? Object.keys(snapshot).join(',') : typeof snapshot}`,
      )
      return { messages: [], source: 'log-shape-unknown' }
    }
    const messages = []
    for (const event of events) {
      const message = toMessage(event)
      if (message) messages.push(message)
    }
    log(
      `transcript: log ${events.length} events -> ${messages.length} messages ` +
      `(${messages.filter(m => m.role === 'user').length} user / ${messages.filter(m => m.role === 'assistant').length} assistant) ` +
      `turn-tagged ${messages.filter(m => typeof m.turn === 'number').length}`,
    )
    return { messages: limit > 0 ? messages.slice(-limit) : messages, source: 'log' }
  } catch (error) {
    log(`transcript: readSession failed for ${sessionId}: ${error?.message ?? error}`)
    return { messages: [], source: 'log-failed' }
  }
}

/** The first array of events inside a session snapshot, whatever it is called. */
function findEventArray(snapshot) {
  if (Array.isArray(snapshot)) return snapshot
  if (!snapshot || typeof snapshot !== 'object') return undefined
  if (Array.isArray(snapshot.events)) return snapshot.events
  for (const key of ['log', 'snapshot', 'session', 'data']) {
    const nested = snapshot[key]
    if (Array.isArray(nested)) return nested
    if (nested && typeof nested === 'object' && Array.isArray(nested.events)) return nested.events
  }
  return undefined
}

/** All user-authored texts in one session surface. */
export async function readUserTexts(ctx, sessionId) {
  const messages = await readTranscript(ctx, sessionId, 0)
  return messages.filter(m => m.role === 'user').map(m => m.text)
}

/** Session ids worth scanning, newest first, excluding subagent children. */
export async function listRootSessions(ctx, limit = 20) {
  const sessionQuery = ctx.get('sessionQuery')
  if (!sessionQuery) return []
  try {
    const records = await sessionQuery.listSessions()
    return records
      .filter(r => !r.header?.parentSession)
      .sort((a, b) => (b.header?.createdAt ?? 0) - (a.header?.createdAt ?? 0))
      .slice(0, limit)
      .map(r => r.header.id)
  } catch (error) {
    console.error('[persona-judge] listSessions failed:', error?.message ?? error)
    return []
  }
}

/** The most recent user text in a transcript. */
export function lastUserText(transcript) {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    if (transcript[i].role === 'user') return transcript[i].text
  }
  return ''
}

/**
 * Is this user message a hand-off rather than a request?
 *
 * "重启完成，可以跑了" is nine characters, so a length threshold alone cannot
 * tell it apart from a real instruction — a measured run scored such a turn
 * 3/100 because the hand-off was treated as the question. These are the shapes
 * that actually occur: a short completion report, or a short "keep going".
 * The continuation pattern only applies to short messages so that a genuine
 * long instruction containing "继续" is never discarded.
 */
// A completion report: "重启完成", "重启完成，可以跑了", "装好了". The tail may
// contain a comma (the go-ahead usually rides along after one), but it is capped
// at four characters so a sentence continuing into real content is not swallowed.
const HANDOFF_COMPLETION = /^\s*(已|我)?(重启|重启好|装好|安装好|弄好|做|改|跑|试|看|查|处理|配置|升级)[^。！？.!?]{0,4}(了|完了|好了|完成|完毕|成功)[^。！？.!?]{0,8}\s*$/
// A bare go-ahead. "请" is deliberately NOT a trigger: 请-sentences are the most
// common real request shape this user uses ("请把判分链路的日志读出来"), and an
// earlier draft of this pattern misclassified one as a hand-off.
const HANDOFF_CONTINUE = /^\s*(可以|继续|接着|那就|现在|开始|go|ok)\s*[^。！？.!?]{0,8}\s*$/i

/** True when a user message carries no request of its own. */
export function isHandoff(text) {
  const value = String(text ?? '').trim()
  if (value === '') return true
  if (value.length > 18) return false // a real request can be short, but not this long
  if (HANDOFF_COMPLETION.test(value)) return true
  if (HANDOFF_CONTINUE.test(value)) return true
  // a bare acknowledgement
  return /^(好|好的|嗯|行|收到|ok|OK|谢谢|没问题|对|是的)\s*[。！!.,，]?$/.test(value)
}

/**
 * The request that should be judged, and the delivery that answers it.
 *
 * A finished turn is not "everything after the newest user message". Two real
 * failures came from that reading:
 *
 *   1. The newest user message is often a hand-off ("重启完成，可以跑了").
 *      Treating it as the question paired it with assistant messages that were
 *      the NEXT turn's tool activity, and a measured run scored 3/100 on what
 *      was actually a complete answer delivered one turn earlier.
 *   2. Tool-call-only assistant messages carry no text, so they must never
 *      join the delivery as filler.
 *
 * So: find the newest user message that is a real request, and answer it with
 * everything the assistant said up to the next real request.
 */
export function lastExchange(transcript, options = {}) {
  const messages = Array.isArray(transcript) ? transcript : []
  if (options.dropNewestTurn !== true) {
    return pickExchange(messages, { ...options, upperBound: messages.length - 1 })
  }

  // Which turn is the caller living in? The host does not always supply a turn
  // number to a tool, and without a reference "the newest assistant turn" is
  // usually the live one — judging it produced a 2989-character answer built
  // from work still in progress. So when no reference is available, the newest
  // turn is treated as live and the one before it is judged.
  const liveTurn = typeof options.liveTurn === 'number'
    ? options.liveTurn
    : (options.skipNewestTurn === true ? newestAssistantTurn(messages) : undefined)
  const completedTurn = liveTurn === undefined
    ? newestAssistantTurn(messages)
    : newestTurnBefore(messages, liveTurn)

  if (typeof completedTurn === 'number') {
    const found = exchangeOfTurn(messages, completedTurn, options)
    if (found.answer.trim() !== '') return { ...found, turn: completedTurn }
  }

  // A completed turn exists but carries no deliverable text: fall back to
  // whatever the live turn has so far, and say so, because a score on unfinished
  // work must be explainable.
  const live = pickExchange(messages, {
    ...options,
    upperBound: messages.length - 1,
    liveTurn: newestAssistantTurn(messages),
  })
  return { ...live, judgedLiveTurn: true }
}

/** The highest assistant turn strictly below `before`, if any. */
function newestTurnBefore(messages, before) {
  if (typeof before !== 'number') return undefined
  let best
  for (const message of messages) {
    if (typeof message.turn !== 'number') continue
    if (message.turn >= before) continue
    if (best === undefined || message.turn > best) best = message.turn
  }
  return best
}

/**
 * The newest assistant turn, used as the "live" bound when the caller cannot
 * name it. `newestTurnBefore` then returns the turn strictly below it — the
 * newest turn with a completed delivery.
 */
function newestAssistantTurn(messages) {
  let newest
  for (const message of messages) {
    if (typeof message.turn !== 'number') continue
    if (newest === undefined || message.turn > newest) newest = message.turn
  }
  return newest
}

/**
 * The turn a user message belongs to: the turn its answer was produced in,
 * which is the first assistant message after it. User messages carry no turn
 * number of their own, so this is how one is attributed.
 */
function turnOf(messages, index) {
  for (let i = index + 1; i < messages.length; i += 1) {
    if (typeof messages[i].turn === 'number') return messages[i].turn
  }
  return undefined
}

/**
 * The question and answer of one exact turn.
 *
 * The question is the user message this turn answered — the last user message
 * at or before the turn's first assistant message — so a terse or hand-off-like
 * request is still judged as the request it was.
 */
function exchangeOfTurn(messages, turn, { minUserChars = 2 }) {
  let firstAnswer = -1
  let lastAnswer = -1
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role !== 'assistant' || messages[i].turn !== turn) continue
    if (firstAnswer === -1) firstAnswer = i
    lastAnswer = i
  }
  if (firstAnswer === -1) return { question: '', answer: '', askedAt: -1, answeredAt: -1 }

  let askedAt = -1
  for (let i = firstAnswer - 1; i >= 0; i -= 1) {
    if (messages[i].role !== 'user') continue
    if (String(messages[i].text ?? '').trim().length < minUserChars) continue
    askedAt = i
    break
  }

  const answer = messages
    .slice(firstAnswer, lastAnswer + 1)
    .filter(m => m.role === 'assistant')
    .map(m => String(m.text ?? '').trim())
    .filter(Boolean)
    .join('\n\n')

  return {
    question: askedAt === -1 ? '' : String(messages[askedAt].text ?? '').trim(),
    answer,
    askedAt,
    answeredAt: lastAnswer,
  }
}

/**
 * Choose one exchange inside messages[0..upperBound].
 *
 * `liveTurn` marks a user message that belongs to the turn being judged even
 * though it looks like a hand-off: the live turn's user message carries no turn
 * number of its own, so it cannot be recognised structurally.
 */
function pickExchange(messages, { minUserChars = 2, upperBound, liveTurn }) {
  let askedAt = -1
  for (let i = upperBound; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user') continue
    const text = String(message.text ?? '').trim()
    if (text.length < minUserChars) continue
    // The live turn's own request is never skipped, even when it is terse: it is
    // the thing the caller asked to judge. It is recognised by attribution, not
    // by its wording.
    const belongsToLive = typeof liveTurn === 'number' && turnOf(messages, i) === liveTurn
    if (!belongsToLive && isHandoff(text)) continue
    askedAt = i
    break
  }
  if (askedAt === -1) return { question: '', answer: '', askedAt: -1, answeredAt: -1 }

  const parts = []
  let answeredAt = -1
  for (let i = askedAt + 1; i <= upperBound; i += 1) {
    const message = messages[i]
    if (message.role === 'user') break // a later request starts a new turn
    if (message.role !== 'assistant') continue
    const text = String(message.text ?? '').trim()
    if (text === '') continue
    parts.push(text)
    answeredAt = i
  }

  return {
    question: String(messages[askedAt].text ?? '').trim(),
    answer: parts.join('\n\n'),
    askedAt,
    answeredAt,
  }
}

/**
 * Everything after the last user message.
 *
 * Kept as a thin alias of {@link lastExchange} rather than the raw tail slice:
 * the slice version is what fed 238 assistant fragments to the judge and scored
 * a complete answer 3/100. Nothing should reintroduce that shape.
 */
export function answerText(transcript) {
  return lastExchange(transcript).answer
}

/** Render a transcript block for a judge prompt. */
export function renderTranscript(transcript) {
  return transcript
    .map(m => `${m.role === 'user' ? '我' : '助手'}: ${m.text}`)
    .join('\n\n')
}
