/**
 * Deterministic text first pass over the user's own messages.
 *
 * This file answers "what does this person literally type, over and over"
 * with counting, not with a model: repeated n-grams, punctuation habits,
 * openings, length and imperative ratio. The model pass (extract.js) only
 * interprets this evidence, so a bad model reply can never invent a habit
 * that is not in the numbers.
 */

/**
 * Text of one content part, or '' when it is not delivery text.
 *
 * A reasoning block is `{type:'reasoning', text}`, so the obvious "any part with
 * a text string" reading silently returns the model's private thinking as if it
 * were the answer. A measured run judged that thinking (the judge quoted the
 * phrase "watch for the answer-too-short guard") and scored a real delivery
 * 11/100. Only an explicit text block is delivery text.
 */
function partText(part) {
  if (typeof part === 'string') return part
  if (part && typeof part === 'object') {
    if (part.type === 'text') return typeof part.text === 'string' ? part.text : ''
    if (part.type === 'image') return '[图片]'
    if (part.type === 'file') return '[文件]'
    // reasoning, tool-call, tool-addition, tool-removal: never delivery text
    return ''
  }
  return ''
}

/** Flatten a message's content into plain text. */
export function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(partText).filter(Boolean).join('\n')
}

/** Remove fenced code and inline code so counts reflect prose habits. */
export function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
}

/** Remove URLs, which would otherwise dominate every n-gram. */
export function stripUrls(text) {
  return text.replace(/https?:\/\/\S+/g, ' ').replace(/www\.\S+/g, ' ')
}

/**
 * Does this message look like a person talking?
 *
 * A "user message" is not always human: pasted transcripts, agent progress
 * reports and tool dumps all arrive with the user role. Those blobs wreck a
 * style profile — real runs produced phrases like `no-default-browser-check`
 * and `remote-debugging-port` — so the corpus is filtered before any counting
 * happens. The thresholds are deliberately loose: they must keep a genuinely
 * verbose person, and only drop machine output.
 */
export function isChatLike(text, options = {}) {
  const maxChars = options.maxChars ?? 1200
  const minMachineHits = options.minMachineHits ?? 3
  const source = String(text ?? '')
  const trimmed = source.trim()
  if (trimmed.length < 2) return false
  if (trimmed.length > maxChars) return false
  // a diagnostic corpus marker (subagent transcript markers, ANSI escapes)
  if (/\[Tool:|\[tool_use|\[\d{2}:\d{2}:\d{2}\]|<\/?antml:|\u001b\[/.test(source)) return false

  // Machine-shaped density. Measured against real pollution: a single Windows
  // drive letter is not enough (`C:\` is one hit), while a real path or a flag
  // list produces several. A lone path in an otherwise human sentence survives.
  const hits = source.match(/[A-Za-z]:\\|\\[\w.-]+|(?:^|\s)--?[a-z][\w-]{2,}|[\w.-]+@[\w.-]+/g) ?? []
  if (hits.length >= minMachineHits) return false

  // brace/equals soup with a path or a flag in it is code or tool output
  const symbols = (source.match(/[{}[\]<>|=;]/g) ?? []).length
  if (symbols / Math.max(1, trimmed.length) > 0.12 && /[\\]|--/.test(source)) return false

  return true
}

/**
 * Keep only the messages that read as human prose, and bound the corpus size.
 * @returns {{ texts: string[], dropped: number, scanned: number }}
 */
export function filterChatLike(texts, options = {}) {
  const all = (texts ?? []).map(t => String(t ?? ''))
  const kept = all.filter(t => isChatLike(t, options))
  return { texts: kept, dropped: all.length - kept.length, scanned: all.length }
}

/** Characters that carry no habit signal on their own. */
const NOISE = /[\s\u3000]+/g

/** Chinese function words and fillers that repeat without meaning much. */
const ZH_STOP = new Set([
  '这个', '那个', '我们', '你们', '他们', '什么', '怎么', '可以', '然后', '就是',
  '因为', '所以', '但是', '如果', '还有', '已经', '现在', '一下', '一个', '这样',
  '那样', '时候', '问题', '东西', '地方', '觉得', '应该', '可能', '不是', '没有',
  '需要', '进行', '而且', '并且', '以及', '或者', '对于', '关于', '为了', '通过',
])

/** English function words. */
const EN_STOP = new Set([
  'the', 'and', 'that', 'this', 'with', 'have', 'from', 'they', 'will', 'would',
  'there', 'their', 'about', 'which', 'when', 'what', 'your', 'you', 'for', 'not',
  'but', 'are', 'was', 'were', 'can', 'could', 'should', 'just', 'like', 'into',
])

/** Collapse whitespace and trim. */
function tidy(text) {
  return text.replace(NOISE, ' ').trim()
}

/** Split prose into candidate n-gram units (CJK runs and latin words). */
function units(text) {
  const out = []
  const re = /[\u4e00-\u9fff]+|[A-Za-z][A-Za-z'’-]*/g
  let m
  while ((m = re.exec(text)) !== null) out.push(m[0])
  return out
}

/** Every 2..4-gram of consecutive CJK characters inside one run. */
function cjkGrams(run, min, max) {
  const grams = []
  for (let n = min; n <= max; n += 1) {
    for (let i = 0; i + n <= run.length; i += 1) grams.push(run.slice(i, i + n))
  }
  return grams
}

/** True when a candidate n-gram is pure filler. */
function isStop(gram) {
  if (ZH_STOP.has(gram) || EN_STOP.has(gram.toLowerCase())) return true
  // a gram made only of stop-word characters (e.g. 的了呢吧啊) is noise
  if (/^[\u4e00-\u9fff]+$/.test(gram) && /^[的了呢吧啊嘛哦噢嗯呀哈么什]+$/.test(gram)) return true
  return false
}

/**
 * Count repeated phrases across the user's messages.
 *
 * The unit of repetition is the MESSAGE, not the occurrence: a catchphrase
 * like「插件呢」appears once in each of many messages, so counting raw
 * occurrences inside one message would never surface it.
 *
 * @returns {Array<{phrase: string, count: number, messages: number}>} ranked
 */
export function topPhrases(texts, options = {}) {
  const maxPhrases = options.maxPhrases ?? 40
  const list = (texts ?? []).map(t => String(t ?? ''))
  // Repetition is relative to how much the person actually said: a fixed bar
  // either misses catchphrases in a small corpus or floods a large one.
  const minMessages = options.minMessages ?? Math.max(2, Math.ceil(list.length * 0.1))
  /** phrase -> { messages: distinct messages, count: total occurrences } */
  const counts = new Map()
  for (const raw of list) {
    const text = tidy(stripUrls(stripCode(String(raw ?? ''))))
    const here = new Map()
    for (const unit of units(text)) {
      const candidates = /^[\u4e00-\u9fff]/.test(unit)
        ? cjkGrams(unit, 2, 4)
        : (unit.length >= 3 ? [unit.toLowerCase()] : [])
      for (const gram of candidates) {
        if (gram.length < 2 || isStop(gram)) continue
        here.set(gram, (here.get(gram) ?? 0) + 1)
      }
    }
    for (const [gram, occurrences] of here) {
      const prev = counts.get(gram) ?? { messages: 0, count: 0 }
      counts.set(gram, { messages: prev.messages + 1, count: prev.count + occurrences })
    }
  }
  return [...counts.entries()]
    .filter(([, stat]) => stat.messages >= minMessages)
    // more messages first; then longer phrases, which carry more signal
    .sort((a, b) => (b[1].messages - a[1].messages) || (b[0].length - a[0].length))
    .map(([phrase, stat]) => ({ phrase, count: stat.messages, messages: stat.messages }))
    // A long n-gram and its own sub-grams are the same habit reported three
    // times; keep the longest and drop the pieces it already contains.
    .filter((entry, _index, all) => !all.some(
      other => other !== entry
        && other.count >= entry.count
        && other.phrase.length > entry.phrase.length
        && other.phrase.includes(entry.phrase),
    ))
    .slice(0, maxPhrases)
}

/** Punctuation and formatting habits, as raw counts plus a human note. */
export function styleHabits(texts) {
  const habits = {
    ellipsis: 0,
    exclaim: 0,
    question: 0,
    tilde: 0,
    emojiTic: 0,
    noPunctuation: 0,
    bulletLists: 0,
    avgChars: 0,
    total: 0,
  }
  let chars = 0
  for (const raw of texts) {
    const text = String(raw ?? '')
    if (!text.trim()) continue
    habits.total += 1
    chars += text.length
    if (/……|\.\.\.|。。。/.test(text)) habits.ellipsis += 1
    if (/[!！]/.test(text)) habits.exclaim += 1
    if (/[?？]/.test(text)) habits.question += 1
    if (/~|～/.test(text)) habits.tilde += 1
    if (/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(text)) habits.emojiTic += 1
    if (/^[\u4e00-\u9fffA-Za-z0-9 ,，。、]+$/.test(text.trim()) && !/[，。！？,!.?]/.test(text)) habits.noPunctuation += 1
    if (/^[\s]*([-*+]|\d+[.)])\s/m.test(text)) habits.bulletLists += 1
  }
  habits.avgChars = habits.total === 0 ? 0 : Math.round(chars / habits.total)
  return habits
}

/** Opening words the user reaches for, ranked. */
export function openings(texts, limit = 12) {
  const counts = new Map()
  for (const raw of texts) {
    const text = tidy(stripUrls(stripCode(String(raw ?? ''))))
    if (text.length < 2) continue
    const head = text.slice(0, 8)
    counts.set(head, (counts.get(head) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([opening, count]) => ({ opening, count }))
}

/** How often the user issues an instruction versus asks a question. */
export function toneStats(texts) {
  let imperative = 0
  let question = 0
  let evaluative = 0
  let considered = 0
  for (const raw of texts) {
    const text = String(raw ?? '').trim()
    if (text.length < 2) continue
    considered += 1
    if (/[?？]\s*$/.test(text)) question += 1
    if (/(^|[\s，。])(请|帮我|把|给我|需要|改|加|做|写|跑|查|删|换|整理|实现|修复)/.test(text)) imperative += 1
    if (/(不对|不行|还是|不好|重来|错了|别|不要|算了|再试)/.test(text)) evaluative += 1
  }
  const ratio = (n) => (considered === 0 ? 0 : Number((n / considered).toFixed(3)))
  return {
    considered,
    imperative: ratio(imperative),
    question: ratio(question),
    evaluative: ratio(evaluative),
  }
}

/**
 * Whole deterministic pass over a batch of user texts.
 * @returns a compact evidence object handed to the model and stored raw.
 */
export function analyzeUserTexts(texts, options = {}) {
  const filtered = filterChatLike(texts, options)
  const cleaned = filtered.texts.filter(t => t.trim().length >= 2)
  return {
    messageCount: cleaned.length,
    scannedCount: filtered.scanned,
    droppedCount: filtered.dropped,
    phrases: topPhrases(cleaned, options),
    habits: styleHabits(cleaned),
    openings: openings(cleaned),
    tone: toneStats(cleaned),
  }
}

/**
 * How much clean material an extraction had. Short turns are honest data, but
 * a handful of them cannot support a confident catchphrase list, and claiming
 * otherwise would dress up noise as a habit — so the caller is told.
 */
export function confidenceOf(evidence) {
  const messages = Number(evidence?.messageCount) || 0
  if (messages >= 30) return 'normal'
  if (messages >= 12) return 'limited'
  return 'low'
}

/** One-line disclosure for the small-corpus case, or '' when it does not apply. */
export function confidenceNote(evidence) {
  const messages = Number(evidence?.messageCount) || 0
  const confidence = confidenceOf(evidence)
  if (confidence === 'normal') return ''
  const dropped = Number(evidence?.droppedCount) || 0
  const filtered = dropped > 0 ? `（另有 ${dropped} 条机器生成的消息被过滤）` : ''
  return `语料偏小：仅 ${messages} 条像人话的消息${filtered}，下面的短语只是线索，不是稳定口头禅。`
}

/**
 * Render the evidence object as prompt text for the model pass.
 */
export function evidenceToPrompt(evidence) {
  const lines = []
  lines.push(`消息数: ${evidence.messageCount}`)
  lines.push(`平均字数: ${evidence.habits.avgChars}`)
  lines.push(
    `标点习惯: 省略号 ${evidence.habits.ellipsis} 次 / 感叹号 ${evidence.habits.exclaim} 次 /` +
    ` 问号 ${evidence.habits.question} 次 / 波浪号 ${evidence.habits.tilde} 次 /` +
    ` emoji ${evidence.habits.emojiTic} 次 / 无标点 ${evidence.habits.noPunctuation} 次 /` +
    ` 列表 ${evidence.habits.bulletLists} 次`,
  )
  lines.push(`语气比例: 祈使 ${evidence.tone.imperative} / 提问 ${evidence.tone.question} / 否定评价 ${evidence.tone.evaluative}`)
  if (evidence.phrases.length) {
    // The number is the count of MESSAGES carrying the phrase, not a raw
    // occurrence count — calling it a frequency made the model describe common
    // words as "高频词" when they were merely mentioned once or twice.
    lines.push('重复短语（数字 = 提到它的消息条数，不是出现次数）:')
    for (const p of evidence.phrases.slice(0, 30)) lines.push(`  ${p.phrase} —— 出现在 ${p.count} 条消息里`)
  }
  if (evidence.openings.length) {
    lines.push('常见开头（同样按消息条数）:')
    for (const o of evidence.openings) lines.push(`  ${o.opening} —— ${o.count} 条消息以它开头`)
  }
  const note = confidenceNote(evidence)
  if (note) lines.push(`注意：${note} 请据此降低措辞的确定性，不要把它当成稳定习惯。`)
  return lines.join('\n')
}

/**
 * Build a persona profile from the counted evidence alone, with no model.
 *
 * This is the floor the feature stands on: a model that returns prose, empty
 * text, or nothing at all must still leave the user with a真实 profile built
 * from what they actually typed. Everything here is derived from counts, so
 * nothing can be invented.
 *
 * @returns {{summary: string, traits: string[], styleRules: string[],
 *            phrases: Array<{phrase: string, count: number, note: string}>,
 *            antiPatterns: string[]}}
 */
export function deriveProfile(evidence) {
  const habits = evidence.habits
  const tone = evidence.tone
  const total = Math.max(1, evidence.messageCount)

  // Phrases: the counted n-grams first, then repeated openings, deduplicated.
  const phrases = []
  const seen = new Set()
  for (const entry of evidence.phrases ?? []) {
    if (seen.has(entry.phrase)) continue
    seen.add(entry.phrase)
    phrases.push({ phrase: entry.phrase, count: entry.count, note: '统计得到的重复短语' })
  }
  for (const entry of evidence.openings ?? []) {
    if (seen.has(entry.opening)) continue
    seen.add(entry.opening)
    phrases.push({ phrase: entry.opening, count: entry.count, note: '反复使用的开场' })
  }

  const traits = []
  if (tone.imperative >= 0.4) traits.push('直给指令，少铺垫')
  if (tone.evaluative >= 0.15) traits.push('不满会立刻指出')
  if (tone.question >= 0.25) traits.push('先问清再动手')
  if (habits.avgChars > 0 && habits.avgChars <= 20) traits.push('说话短，惜字')
  if (habits.avgChars >= 80) traits.push('交代背景充分')
  if (habits.ellipsis >= Math.max(2, total * 0.15)) traits.push('话尾常留省略号')
  if (habits.noPunctuation >= Math.max(2, total * 0.2)) traits.push('常不打标点')
  if (habits.bulletLists >= Math.max(2, total * 0.2)) traits.push('习惯用列表说事')

  const styleRules = []
  if (tone.imperative >= 0.4) styleRules.push('结论先行，不要客套开场')
  if (habits.avgChars > 0 && habits.avgChars <= 20) styleRules.push('回答尽量短')
  if (tone.evaluative >= 0.15) styleRules.push('发现问题直接说，不要委婉')
  if (habits.bulletLists >= Math.max(2, total * 0.2)) styleRules.push('需要并列时用列表')

  const antiPatterns = []
  if (tone.imperative >= 0.4) antiPatterns.push('先来一段铺垫再给结论')
  if (tone.evaluative >= 0.15) antiPatterns.push('把明显的问题说成"可能可以优化"')
  if (habits.avgChars > 0 && habits.avgChars <= 20) antiPatterns.push('长篇复述我已经知道的东西')

  const summaryBits = [
    `共统计 ${evidence.messageCount} 条发言，平均 ${habits.avgChars} 字`,
    tone.imperative >= 0.4 ? '以祈使指令为主' : tone.question >= 0.25 ? '以提问为主' : '陈述与指令混合',
    phrases.length > 0
      ? `出现过的词：${phrases.slice(0, 3).map(p => `「${p.phrase}」`).join('、')}`
      : '未发现重复出现的短语',
  ]

  return {
    summary: `（由统计直接得出，未经模型解释）${summaryBits.join('，')}。`,
    confidence: confidenceOf(evidence),
    confidenceNote: confidenceNote(evidence),
    traits: traits.slice(0, 8),
    styleRules: styleRules.slice(0, 8),
    phrases: phrases.slice(0, 40),
    antiPatterns: antiPatterns.slice(0, 6),
  }
}
