/**
 * The judge itself: one model call that grades a finished turn against the
 * user's own derived standard, then — only when the user says the guess was
 * right — records that verdict as calibration data.
 *
 * Localized failure policy (chosen by the user): a failing grade is shown and
 * offered as a suggestion; the plugin never re-runs the turn on its own.
 */
import { recordId } from '../shared/model.js'
import { callModel, clip, describe, parseJsonReply } from './llm.js'
import { lastExchange, readTranscript, renderTranscript } from './transcript.js'
import { log } from '../shared/log.js'

const JUDGE_SYSTEM = `你在替一位具体的人审稿。你会看到：他的语言习惯画像、他为我定下的评分维度、他刚才提的要求、以及助手的交付。

你的任务：**先判断这次交付值不值得他打分**，值得的话再猜他会怎么打。

规则：
1. 先给 difficulty：
   - "too_simple"：这次的交付没有可评的东西（闲聊、确认、一句问答、算术）。此时 dimensions 可以为空，overall 忽略，summary 写清为什么不值得评。
   - "normal"：有明确交付，正常评分。
   - "unsure"：你拿不准他会不会在意这次交付。只在真的两可时用，不要为了省事而用。
2. difficulty 为 normal 或 unsure 时，每个维度给 0-100 的整数分，并写一句他大概会说的理由（不超过 30 字）。
3. overall 是各维度按 weight 加权的总分，取整数。
4. 只报"他会不满意"的问题，最多 4 条；每条必须指出具体位置或具体缺失，不许写"可以更详细"这类空话。
5. verdict 只允许 "pass" 或 "fail"。
6. 只输出 JSON：
{"difficulty":"normal","dimensions":[{"id":"","score":0,"comment":""}],"overall":0,"verdict":"pass","issues":[{"what":"","fix":""}],"summary":""}`

/** Build the judge's user prompt from the persona library and the turn. */
export function buildJudgePrompt({ profile, calibration, config, transcript }) {
  const dimensions = (calibration?.dimensions ?? [])
    .map(d => `- ${d.id} (${d.label}, 权重 ${d.weight}): ${d.description}`)
    .join('\n')

  const styleLines = [
    profile?.summary ? `画像摘要：${profile.summary}` : '',
    profile?.traits?.length ? `性格/工作方式：${profile.traits.join('；')}` : '',
    profile?.styleRules?.length ? `输出风格要求：${profile.styleRules.join('；')}` : '',
    profile?.antiPatterns?.length ? `明确反感：${profile.antiPatterns.join('；')}` : '',
    profile?.phrases?.length
      ? `口头禅（出现这些说明像他本人）：${profile.phrases.slice(0, 20).map(p => p.phrase).join('、')}`
      : '',
  ].filter(Boolean).join('\n')

  const exchange = lastExchange(transcript)
  return [
    '## 这个人的画像',
    styleLines || '（尚未提取；按通用交付质量标准评分，并在 summary 中说明画像缺失）',
    '',
    '## 他定下的评分维度',
    dimensions || '（尚未校准；使用 correctness/intent/completeness/concision/style，权重 30/25/20/15/10）',
    `及格线：${config.passScore}`,
    '',
    '## 他提的要求',
    clip(exchange.question, Math.floor(config.maxTranscriptChars * 0.3)) || '（未取到）',
    '',
    '## 助手交付的内容',
    clip(exchange.answer || renderTranscript(transcript), config.maxTranscriptChars),
  ].join('\n')
}

/** Normalize whatever the model returned into a stable judgement shape. */
export function normalizeJudgement(parsed, calibration, passScore) {
  const known = new Map((calibration?.dimensions ?? []).map(d => [d.id, d]))
  const dimensions = []
  for (const entry of Array.isArray(parsed?.dimensions) ? parsed.dimensions : []) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : ''
    if (!id) continue
    const score = clampScore(entry?.score)
    const meta = known.get(id)
    dimensions.push({
      id,
      label: meta?.label ?? id,
      weight: Number(meta?.weight) || 0,
      score,
      comment: typeof entry?.comment === 'string' ? entry.comment.trim().slice(0, 200) : '',
    })
  }
  if (dimensions.length === 0) return undefined

  // Recompute the weighted total rather than trusting the model's arithmetic.
  const weightSum = dimensions.reduce((sum, d) => sum + d.weight, 0)
  const overall = weightSum > 0
    ? Math.round(dimensions.reduce((sum, d) => sum + d.score * d.weight, 0) / weightSum)
    : Math.round(dimensions.reduce((sum, d) => sum + d.score, 0) / dimensions.length)

  const issues = (Array.isArray(parsed?.issues) ? parsed.issues : [])
    .map(item => ({
      what: typeof item?.what === 'string' ? item.what.trim().slice(0, 240) : '',
      fix: typeof item?.fix === 'string' ? item.fix.trim().slice(0, 240) : '',
    }))
    .filter(item => item.what !== '')
    .slice(0, 4)

  const verdict = typeof parsed?.verdict === 'string' ? parsed.verdict : ''
  return {
    dimensions,
    overall,
    pass: verdict === 'fail' ? false : (verdict === 'pass' ? true : overall >= passScore),
    issues,
    summary: typeof parsed?.summary === 'string' ? parsed.summary.trim().slice(0, 400) : '',
  }
}

/** Concrete evidence that a turn delivered something rather than just talking. */
const ARTIFACT = /[A-Za-z]:\\|\/[\w.-]+\/|```|`[^`]+`|(?:^|\s)--?[a-z][\w-]{2,}|\b[（(]\s*\d+\s*[)）]|：[^\n]*|[\w./\\-]+\.(?:js|mjs|ts|json|md|css|html|py|yaml|yml|toml|txt|log)\b|\n\s*[-*+\d]|[A-Za-z_][\w.]*\(/i

/**
 * Does this answer contain something the user could check?
 *
 * A bare number is NOT an artifact on its own: "1+1=2" is five characters with a
 * digit in it, and an earlier version of this gate therefore treated it as a
 * deliverable. A number only counts inside a reply long enough to mean
 * something, so a long report keeps its figures while arithmetic chatter is
 * still recognised as chatter.
 */
export function hasArtifact(answer, config = {}) {
  const value = String(answer ?? '').trim()
  if (value === '') return false
  if (ARTIFACT.test(value)) return true
  const numericFloor = config.numericArtifactMinChars ?? 12
  if (value.length >= numericFloor && /\d/.test(value)) return true
  return false
}

/**
 * Why this turn is not worth a verdict, or '' when it is.
 *
 * The user's own standard says it: a turn too simple does not need a score. This
 * is the cheapest possible gate — no model call, no record, no confirmation
 * card — and it only fires when the delivery is short and carries nothing
 * concrete, so a terse but real delivery (a path, a line of code, a count in a
 * sentence) still gets judged.
 */
export function trivialReason(answer, config = {}) {
  const value = String(answer ?? '').trim()
  if (value === '') return 'empty answer'
  if (hasArtifact(value, config)) return ''
  if (value.length >= (config.trivialMaxChars ?? 120)) return ''
  // Several clauses is a real explanation even when it is short.
  const clauses = value.split(/[。！？.!?\n]+/).filter(part => part.trim() !== '').length
  if (clauses >= (config.trivialMaxClauses ?? 2)) return ''
  return `short conversational reply (${value.length} chars, ${clauses} clause(s))`
}

/** The full scoring pipeline for one finished turn. */
export async function judgeTurn(ctx, {
  sessionId,
  turn,
  route,
  config,
  library,
  signal,
  transcript: provided,
  dropNewestTurn = false,
  // When the caller cannot name the live turn, the newest turn is assumed to be
  // it — the manual tool always runs inside a turn that is still going.
  skipNewestTurn = false,
  // When set, an exchange that could only be resolved to in-flight work is not
  // scored at all: a number computed on an unfinished answer is a wrong
  // conclusion, and it is written to the library as if it were a judgement.
  refuseLiveTurn = false,
}) {
  const transcript = provided ?? await readTranscript(ctx, sessionId, config.maxContextMessages)
  // The manual tool runs mid-turn, so the newest turn's answer is a partial
  // snapshot; the automatic path runs after the turn closed and keeps it. The
  // live turn number is what lets the manual path tell "completed" from "current".
  const exchange = lastExchange(transcript, { dropNewestTurn, liveTurn: turn, skipNewestTurn })
  const answer = exchange.answer
  log(
    `judge: ${transcript.length} transcript messages, judged turn ${exchange.turn ?? '(live)'} ` +
    `question ${exchange.question.length} chars, ` +
    `answer ${answer.trim().length} chars (threshold ${config.minTurnLength})`,
  )
  // A transcript tail of turns/roles/lengths, because "answer 0 chars" alone is
  // ambiguous: a missing answer, a dropped turn, and a shadowed surface all look
  // identical from the summary line.
  log(
    'judge tail: ' +
    transcript.slice(-10).map(m => `T${m.turn ?? '?'}${m.role === 'user' ? 'u' : 'a'}${String(m.text ?? '').length}`).join(' '),
  )
  if (refuseLiveTurn && exchange.judgedLiveTurn === true) {
    log('judge: refused to score an unfinished turn')
    return { skipped: 'no-completed-turn', answerLength: answer.trim().length }
  }
  const answerLength = answer.trim().length
  if (answerLength === 0) {
    log('judge: no answer text; skipped')
    return { skipped: 'answer-too-short', answerLength }
  }
  // Two tiers, because the two gates cost very different amounts.
  //
  // Tier 1 is this deterministic check: free, and it only rejects a reply that
  // is short AND carries nothing concrete. A model call to decide that would
  // cost more than the judgement it avoids.
  //
  // Tier 2 is the judge's own `difficulty` verdict, which handles exactly the
  // cases a threshold cannot: the near miss. That is the only tier that can cost
  // a call, so it is configurable and off by default.
  const artifact = hasArtifact(answer, config)
  const borderline = answerLength < config.minTurnLength
  if (borderline && !artifact) {
    log(`judge: answer ${answerLength} chars, nothing concrete in it; skipped without a model call`)
    return { skipped: 'answer-too-short', answerLength }
  }
  if (borderline && config.modelDifficulty !== true) {
    // A short reply with something concrete in it is a deliverable — it is judged
    // (and the judge may still call it too simple). Turning on modelDifficulty
    // merely routes it past the cheap gate so the judge decides instead.
    log(`judge: answer ${answerLength} chars with a concrete artifact; below the floor but judged`)
  }

  const data = library.data
  const calibration = data.calibration
  const passScore = Number(calibration?.passScore) || config.passScore

  const prompt = buildJudgePrompt({
    profile: data.profile,
    calibration,
    config,
    transcript,
  })

  const reply = await callModel(ctx, { ...route, reasoningEffort: undefined }, {
    system: JUDGE_SYSTEM,
    user: prompt,
    // Same failure the extract call had: a measured run came back
    // `out=900 finish=max-tokens` with a truncated reply, because the reasoning
    // phase ate the whole budget. Extraction was fixed and this was missed.
    maxTokens: 2500,
    signal,
    sessionId,
    purpose: 'judge',
  })
  if (!reply.ok) return { skipped: 'model-failed', error: reply.error }

  const parsed = parseJsonReply(reply.text)
  if (!parsed) return { skipped: 'unparseable', raw: clip(reply.text, 600) }

  // The judge's own difficulty call, which is what a threshold cannot do: it
  // recognises a near miss the user would not have wanted scored at all.
  const difficulty = typeof parsed.difficulty === 'string' ? parsed.difficulty.trim() : ''
  if (difficulty === 'too_simple') {
    log(`judge: the judge itself called this too simple; no record kept (${String(parsed.summary ?? '').slice(0, 80)})`)
    return { skipped: 'too-simple-per-judge', summary: String(parsed.summary ?? ''), answerLength }
  }

  const judgement = normalizeJudgement(parsed, calibration, passScore)
  if (!judgement) return { skipped: 'no-dimensions-in-reply', raw: clip(reply.text, 600) }

  const at = Date.now()
  const record = {
    id: recordId(sessionId, turn, at),
    sessionId: String(sessionId),
    turn,
    at,
    route: { provider: route.provider, model: route.model },
    overall: judgement.overall,
    pass: judgement.pass,
    passScore,
    dimensions: judgement.dimensions,
    issues: judgement.issues,
    summary: judgement.summary,
    // Set when the manual tool had to score a turn that has not finished.
    judgedLiveTurn: exchange.judgedLiveTurn === true,
    // Carried so the caller can ask the user only when the judge was genuinely
    // torn — asking on every score is what made the confirmation a chore.
    difficulty: difficulty === 'unsure' ? 'unsure' : 'normal',
    // The request this judgement is about — NOT the newest user message, which
    // may be a hand-off the exchange deliberately skipped past.
    excerpt: clip(exchange.question, 300),
  }
  await library.setPassScore(passScore)
  await library.addRecord(record, config.historyLimit)
  log(
    `judge: turn ${turn} scored ${record.overall} (${record.pass ? 'pass' : 'fail'}, line ${passScore})` +
    (record.difficulty === 'unsure' ? ' [裁判拿不准，需要你确认标准]' : '') +
    (record.judgedLiveTurn ? ' [评判的是尚未收尾的当前轮]' : ''),
  )
  return { record }
}

function clampScore(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.max(0, Math.min(100, Math.round(numeric)))
}

export { describe }
