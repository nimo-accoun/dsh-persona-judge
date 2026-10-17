/**
 * Persona extraction and judge calibration.
 *
 * Two model passes, both grounded in deterministic evidence:
 *   1. extractProfile  — the user's catchphrases, traits, style rules.
 *   2. calibrateJudge  — "how would this person grade work", as dimensions.
 *
 * Neither pass is allowed to invent a phrase: the prompt carries the counted
 * n-grams and instructs the model to select from them.
 */
import { analyzeUserTexts, confidenceNote, confidenceOf, deriveProfile, evidenceToPrompt } from '../shared/analyze.js'
import { DEFAULT_DIMENSIONS } from '../shared/model.js'
import { callModel, clip, describe, parseJsonReply } from './llm.js'
import { listRootSessions, readUserTexts } from './transcript.js'
import { log } from '../shared/log.js'

const EXTRACT_SYSTEM = `你是一个语言习惯分析器。你会收到对某位用户历史发言的**统计证据**（短语计数、标点习惯、语气比例、常见开头）。
你的任务是从这些证据中还原出这个人是谁、他怎样说话、他期待什么样的回答。

硬性规则：
1. 只能使用证据中出现的短语，绝不编造。phrases 必须逐一来自证据里的"重复短语"列表。
2. 证据里的数字是**提到该短语的消息条数**，不是出现次数。写 note 时必须按这个含义描述，不许说成"高频词""出现很多次"。
3. 短语列表是**候选**，不是结论。若大多数条目只是话题名词（例如"插件""结果""内容"这类谁都会说的词），就少写甚至不写 phrases，宁可留空也不要把它包装成口头禅。
4. 只有单独出现时也明显是这个人说话习惯的短语，才算口头禅。
5. summary 用第三人称中文，60-120 字，说清这个人关心的东西和表达风格。
6. traits 是稳定的性格/工作方式特征，每条不超过 20 字，最多 8 条。
7. styleRules 是可以直接约束助手输出的规则（例如"结论先行""不要客套开场"），每条不超过 25 字，最多 8 条。
8. antiPatterns 是这个人明确反感的写法，每条不超过 25 字，最多 6 条。
9. 证据不足时宁可少写，也不要写通用套话。措辞的确定程度要和证据强度相称。

只输出一个 JSON 对象，不要任何解释文字：
{"summary":"","traits":[""],"styleRules":[""],"phrases":[{"phrase":"","count":0,"note":""}],"antiPatterns":[""]}`

const CALIBRATE_SYSTEM = `你要扮演这位用户本人，写下"我用来给助手交付物打分"的标准。
输入是他的语言习惯画像，可能还有历次评分反馈。

规则：
1. 输出 3-6 个评分维度，是**他真正在意**的东西，而不是通用质量清单。
2. 每个维度的 weight 之和必须等于 100，取整数；越在意的给越高。
3. 每个维度 description 说明"怎样算好、怎样算差"，不超过 40 字。
4. 维度 id 用简短英文小写，稳定、可复用。
5. passScore 是他大概会给的及格线（0-100 的整数），要偏严格。
6. 只输出 JSON，不要解释：
{"passScore":80,"dimensions":[{"id":"","label":"","description":"","weight":0}]}`

/** Run one extraction round over the user's own messages. */
export async function extractProfile(ctx, { route, config, sessionId, signal, extraSessions = 0, sessionQuery }) {
  const texts = []
  const seenSessions = []

  if (sessionQuery) {
    const current = await readUserTexts(ctx, sessionId)
    if (current.length > 0) {
      texts.push(...current)
      seenSessions.push(String(sessionId))
    }
    if (extraSessions > 0) {
      const roots = await listRootSessions(ctx, extraSessions + 1)
      for (const id of roots) {
        if (String(id) === String(sessionId)) continue
        if (seenSessions.length > extraSessions) break
        const more = await readUserTexts(ctx, id)
        if (more.length === 0) continue
        texts.push(...more)
        seenSessions.push(String(id))
      }
    }
  }

  const evidence = texts.length > 0 ? analyzeUserTexts(texts) : null
  const messageCount = evidence?.messageCount ?? 0
  if (messageCount < config.extractMinMessages) {
    return {
      ok: false,
      reason: 'not-enough-user-messages',
      messageCount,
      needed: config.extractMinMessages,
      evidence,
    }
  }

  // The evidence section is what the model must interpret. It used to be
  // followed by up to 40 raw messages, and a measured run showed why that was a
  // mistake: the extraction call came back `out=2500` — exactly maxTokens — with
  // `reply 0c`. The reasoning phase consumed the entire output budget before any
  // text was produced. The counts already carry the signal, so the prompt is
  // kept to the evidence and the budget is left for the answer.
  const reply = await callModel(ctx, { ...route, reasoningEffort: undefined }, {
    system: EXTRACT_SYSTEM,
    user: `以下是统计证据：\n\n${clip(evidenceToPrompt(evidence), config.maxTranscriptChars)}`,
    maxTokens: 4000,
    signal,
    sessionId,
    purpose: 'extract',
  })
  if (!reply.ok) {
    log(`extract: model call failed (${reply.error}); falling back to statistics`)
    return {
      ok: true,
      profile: deriveProfile(evidence),
      profileSource: 'stats',
      profileNote: `判分模型调用失败（${reply.error}），画像改由统计直接得出。`,
      confidence: confidenceOf(evidence),
      confidenceNote: confidenceNote(evidence),
      candidates: candidatesOf(evidence),
      evidence,
      messageCount,
      sessionsSeen: seenSessions,
      route,
    }
  }

  const parsed = parseJsonReply(reply.text)
  const parsedTraits = list(parsed?.traits)
  const parsedEmpty = !parsed
    || (parsedTraits.length === 0 && !parsed.summary && !Array.isArray(parsed.phrases))
  if (parsedEmpty) {
    // A model that answers in prose, truncates, or returns nothing must not
    // cost the user their profile: fall back to the counted evidence, which is
    // real data rather than a model's impression of it.
    log(`extract: unusable reply (${String(reply.text ?? '').length} chars): ${String(reply.text ?? '').slice(0, 1500)}`)
    return {
      ok: true,
      profile: deriveProfile(evidence),
      profileSource: 'stats',
      profileNote: `模型回复无法解析为可用 JSON（收到 ${String(reply.text ?? '').length} 字），画像改由统计直接得出。`,
      confidence: confidenceOf(evidence),
      confidenceNote: confidenceNote(evidence),
      candidates: candidatesOf(evidence),
      evidence,
      messageCount,
      sessionsSeen: seenSessions,
      route,
    }
  }

  // Ground the phrases in what was actually counted: keep the higher count and
  // drop anything the evidence never saw.
  const counted = new Map((evidence.phrases ?? []).map(p => [p.phrase, p.count]))
  const phrases = []
  for (const entry of Array.isArray(parsed.phrases) ? parsed.phrases : []) {
    const phrase = typeof entry === 'string' ? entry : entry?.phrase
    if (typeof phrase !== 'string' || phrase.trim() === '') continue
    const key = phrase.trim()
    const observed = counted.get(key)
    if (observed === undefined) continue
    phrases.push({
      phrase: key,
      count: observed,
      note: typeof entry?.note === 'string' ? entry.note : '',
    })
  }

  return {
    ok: true,
    profile: {
      summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
      traits: list(parsed.traits),
      styleRules: list(parsed.styleRules),
      phrases,
      antiPatterns: list(parsed.antiPatterns),
    },
    profileSource: 'model',
    confidence: confidenceOf(evidence),
    confidenceNote: confidenceNote(evidence),
    candidates: candidatesOf(evidence),
    evidence,
    messageCount,
    sessionsSeen: seenSessions,
    route,
    parse: 'ok',
  }
}

/** Derive the judge's scoring dimensions from the persona profile. */
export async function calibrateJudge(ctx, { route, config, profile, calibration, signal, sessionId }) {
  const feedbackLines = []
  if (calibration && calibration.rounds > 0) {
    feedbackLines.push(
      `历史：共 ${calibration.rounds} 轮，「我的判断与用户一致」${calibration.agreements} 次。`,
    )
  }
  const user = [
    '语言习惯画像：',
    profile?.summary ? `摘要：${profile.summary}` : '摘要：（尚未提取）',
    profile?.traits?.length ? `特征：${profile.traits.join('；')}` : '',
    profile?.styleRules?.length ? `风格要求：${profile.styleRules.join('；')}` : '',
    profile?.antiPatterns?.length ? `反感：${profile.antiPatterns.join('；')}` : '',
    feedbackLines.join('\n'),
  ].filter(Boolean).join('\n')

  const reply = await callModel(ctx, { ...route, reasoningEffort: undefined }, {
    system: CALIBRATE_SYSTEM,
    user,
    maxTokens: 2000,
    signal,
    sessionId,
    purpose: 'calibrate',
  })
  if (!reply.ok) {
    log(`calibrate: model call failed (${reply.error}); keeping the current dimensions`)
    return { ok: false, reason: 'model-call-failed', error: reply.error }
  }

  const parsed = parseJsonReply(reply.text)
  if (!parsed) {
    log(`calibrate: unusable reply (${String(reply.text ?? '').length} chars): ${String(reply.text ?? '').slice(0, 1500)}`)
    return { ok: false, reason: 'unparseable-model-reply', raw: clip(reply.text, 800) }
  }

  const dimensions = []
  for (const entry of Array.isArray(parsed.dimensions) ? parsed.dimensions : []) {
    const id = typeof entry?.id === 'string' ? entry.id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') : ''
    const label = typeof entry?.label === 'string' ? entry.label.trim() : ''
    if (!id || !label) continue
    dimensions.push({
      id,
      label,
      description: typeof entry?.description === 'string' ? entry.description.trim() : '',
      weight: Number(entry?.weight) || 0,
    })
  }
  if (dimensions.length === 0) {
    return { ok: false, reason: 'no-usable-dimensions', raw: clip(reply.text, 800) }
  }

  // weights must sum to 100; a model that ignores that gets normalized
  const total = dimensions.reduce((sum, d) => sum + d.weight, 0)
  if (total <= 0) {
    const even = Math.floor(100 / dimensions.length)
    for (const d of dimensions) d.weight = even
  } else if (Math.abs(total - 100) > 0.5) {
    for (const d of dimensions) d.weight = Math.round((d.weight / total) * 100)
  }

  const passScore = Number(parsed.passScore)
  return {
    ok: true,
    dimensions,
    passScore: Number.isFinite(passScore) && passScore > 0 && passScore <= 100
      ? Math.round(passScore)
      : DEFAULT_DIMENSIONS.length > 0 ? 80 : 80,
    route,
  }
}

function list(value) {
  if (!Array.isArray(value)) return []
  return value
    .map(v => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean)
    .slice(0, 10)
}

/**
 * The counted phrase candidates, kept whether or not the model confirmed them.
 *
 * The prompt tells the model to refuse declaring topic nouns as catchphrases,
 * so an honest run can return an empty list — but the raw counts still exist,
 * and the report shows them as candidates rather than hiding them or dressing
 * them up as a habit the evidence does not support.
 */
function candidatesOf(evidence) {
  return (evidence?.phrases ?? [])
    .map(p => ({ phrase: p.phrase, count: p.count }))
    .slice(0, 40)
}

export { describe }
