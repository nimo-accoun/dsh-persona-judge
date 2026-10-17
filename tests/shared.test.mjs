/**
 * Validation for the pure pieces: phrase counting, style habits, the tolerant
 * JSON reader, and judgement normalization. No host, no network, no model.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  analyzeUserTexts,
  confidenceNote,
  confidenceOf,
  contentText,
  deriveProfile,
  evidenceToPrompt,
  filterChatLike,
  isChatLike,
  openings,
  stripCode,
  stripUrls,
  styleHabits,
  topPhrases,
} from '../lib/shared/analyze.js'
import { hasArtifact, normalizeJudgement, buildJudgePrompt, trivialReason } from '../lib/host/judge.js'
import { isHandoff, lastExchange } from '../lib/host/transcript.js'
import { clip, parseJsonReply } from '../lib/host/llm.js'
import { classifyAnswer } from '../lib/host/confirm.js'
import { clamp, resolveConfig, emptyLibrary } from '../lib/shared/model.js'

test('contentText flattens blocks and marks non-text parts', () => {
  assert.equal(contentText('hello'), 'hello')
  assert.equal(
    contentText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]),
    'a\n[图片]\nb',
  )
  assert.equal(contentText(undefined), '')
})

test('contentText never returns private reasoning as delivery text', () => {
  // A reasoning block also carries a `text` property, so the loose reading
  // "any part with text" leaked the model's thinking into judged content and
  // scored a real delivery 11/100 on what it found there.
  const mixed = [
    { type: 'reasoning', text: 'Let me think about the answer-too-short guard...' },
    { type: 'text', text: '已修好，测试 59 个通过。' },
    { type: 'tool-call', id: 'x', name: 'read', arguments: '{}' },
    { type: 'reasoning', text: 'watch for the answer-too-short guard' },
  ]
  const text = contentText(mixed)
  assert.equal(text, '已修好，测试 59 个通过。')
  assert.ok(!text.includes('answer-too-short'), 'thinking must not leak into the delivery')
  assert.ok(!text.includes('Let me think'))
})

test('stripCode and stripUrls remove the loudest noise', () => {
  assert.equal(stripCode('前 `code` 后 ```block```').replace(/\s+/g, ' ').trim(), '前 后')
  assert.equal(stripUrls('看 https://example.com/a 和 www.x.com'), '看   和  ')
})

test('topPhrases finds a repeated catchphrase and drops stop words', () => {
  const texts = [
    '先别动，我觉得这个方案有问题，我们需要先确认口径',
    '先别动，我觉得这里有问题，先确认一下口径再改',
    '先别动，我觉得不对，先确认口径',
    '随便聊聊天气吧今天不错',
  ]
  const phrases = topPhrases(texts)
  const found = phrases.map(p => p.phrase)
  assert.ok(found.includes('先别动'), `expected 先别动 in ${found.join(',')}`)
  assert.ok(found.includes('我觉得'), `expected 我觉得 in ${found.join(',')}`)
  assert.ok(!found.includes('这个'), 'stop word 这个 must not be reported')
  // the count is the number of MESSAGES carrying the phrase
  assert.equal(phrases.find(p => p.phrase === '先别动').count, 3)
})

test('topPhrases counts cross-message repetition, not repetitions inside one message', () => {
  // The real-world catchphrase shape: once per message, across many messages.
  const texts = ['插件呢', '插件呢', '插件呢', '插件呢']
  const phrases = topPhrases(texts)
  const hit = phrases.find(p => p.phrase === '插件呢')
  assert.ok(hit, `expected 插件呢 in ${phrases.map(p => p.phrase).join(',')}`)
  assert.equal(hit.count, 4)

  // A phrase repeated only inside a single message is not a habit.
  const single = topPhrases(['先别动先别动先别动先别动先别动'])
  assert.equal(single.length, 0, 'one message is not repetition across messages')
})

test('styleHabits counts punctuation habits deterministically', () => {
  const habits = styleHabits(['这样不行……', '真的吗！', '好吧~', '再来一次'])
  assert.equal(habits.total, 4)
  assert.equal(habits.ellipsis, 1)
  assert.equal(habits.exclaim, 1)
  assert.equal(habits.tilde, 1)
  assert.equal(habits.noPunctuation, 1)
})

test('openings surfaces repeated starts only', () => {
  const result = openings(['先看这个文件', '先看那个文件', '只看一次'])
  assert.equal(result.length, 0, 'a single occurrence is not a habit')

  const repeated = openings(['先看这个文件', '先看这个文件', '先看这个文件'])
  assert.deepEqual(repeated, [{ opening: '先看这个文件', count: 3 }])
})

test('analyzeUserTexts returns the whole evidence object', () => {
  const evidence = analyzeUserTexts([
    '先别动，这里有问题',
    '先别动，那里也有问题',
    '先别动',
  ])
  assert.equal(evidence.messageCount, 3)
  assert.ok(evidence.phrases.length > 0)
  assert.ok(evidence.habits.total === 3)
  assert.ok(evidence.tone.considered === 3)
})

test('parseJsonReply survives fences, prose and trailing commas-free shapes', () => {
  assert.deepEqual(parseJsonReply('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(parseJsonReply('好的，结果如下：{"a":{"b":2}} 以上。'), { a: { b: 2 } })
  assert.equal(parseJsonReply('不是 JSON'), undefined)
  assert.equal(parseJsonReply(''), undefined)
  assert.equal(parseJsonReply('[1,2,3]'), undefined, 'arrays are not judgements')
})

test('clip keeps both ends of a long transcript', () => {
  const text = 'A'.repeat(100) + 'B'.repeat(100)
  const out = clip(text, 50)
  assert.ok(out.length < 120)
  assert.ok(out.startsWith('A'))
  assert.ok(out.endsWith('B'))
  assert.ok(out.includes('中略'))
})

test('normalizeJudgement recomputes the weighted total', () => {
  const calibration = {
    dimensions: [
      { id: 'a', label: 'A', weight: 75 },
      { id: 'b', label: 'B', weight: 25 },
    ],
  }
  const judgement = normalizeJudgement({
    dimensions: [{ id: 'a', score: 100 }, { id: 'b', score: 0 }],
    overall: 10, // a wrong number the model might return
    verdict: 'pass',
    issues: [{ what: '少了边界情况', fix: '补一行' }, { what: '' }],
    summary: '还行',
  }, calibration, 80)
  assert.equal(judgement.overall, 75)
  assert.equal(judgement.pass, true)
  assert.equal(judgement.issues.length, 1)
  assert.equal(judgement.dimensions[0].label, 'A')
})

test('normalizeJudgement fails on an explicit fail verdict and clamps scores', () => {
  const calibration = { dimensions: [{ id: 'a', label: 'A', weight: 100 }] }
  const judgement = normalizeJudgement({
    dimensions: [{ id: 'a', score: 999 }],
    verdict: 'fail',
  }, calibration, 80)
  assert.equal(judgement.dimensions[0].score, 100)
  assert.equal(judgement.pass, false)
})

test('normalizeJudgement falls back to the pass line without a verdict', () => {
  const calibration = { dimensions: [{ id: 'a', label: 'A', weight: 100 }] }
  const judgement = normalizeJudgement({ dimensions: [{ id: 'a', score: 60 }] }, calibration, 80)
  assert.equal(judgement.pass, false)
  const high = normalizeJudgement({ dimensions: [{ id: 'a', score: 90 }] }, calibration, 80)
  assert.equal(high.pass, true)
})

test('normalizeJudgement rejects a reply with no usable dimensions', () => {
  assert.equal(normalizeJudgement({ dimensions: [] }, { dimensions: [] }, 80), undefined)
})

test('buildJudgePrompt carries the profile, dimensions and the work', () => {
  const prompt = buildJudgePrompt({
    profile: { summary: '结论先行', traits: ['不耐烦'], phrases: [{ phrase: '先别动' }] },
    calibration: { dimensions: [{ id: 'a', label: '正确性', weight: 100, description: '别错' }] },
    config: { passScore: 80, maxTranscriptChars: 2000 },
    transcript: [
      { role: 'user', text: '把首页改一下' },
      { role: 'assistant', text: '改好了' },
    ],
  })
  assert.ok(prompt.includes('结论先行'))
  assert.ok(prompt.includes('先别动'))
  assert.ok(prompt.includes('正确性'))
  assert.ok(prompt.includes('把首页改一下'))
  assert.ok(prompt.includes('改好了'))
})

test('classifyAnswer maps the card choices without guessing free text', () => {
  assert.equal(classifyAnswer({ answers: [{ selected: ['一致，按这个标准记录'] }] }).choice, 'confirm')
  assert.equal(classifyAnswer({ answers: [{ selected: ['不一致，我实际的标准不同'] }] }).choice, 'reject')
  assert.equal(classifyAnswer({ answers: [{ selected: ['不一致，这次我本来就满意'] }] }).choice, 'not-unhappy')
  assert.equal(classifyAnswer({ answers: [{ selected: [], custom: '嗯' }] }).choice, 'unrecognized')
  assert.equal(classifyAnswer(undefined).choice, 'unrecognized')
})

test('resolveConfig clamps and defaults every setting', () => {
  const config = resolveConfig({ passScore: 999, judge: 'nonsense', maxContextMessages: -5 })
  assert.equal(config.passScore, 100)
  assert.equal(config.judge, 'turn')
  assert.equal(config.maxContextMessages, 1)
  assert.equal(config.enabled, true)
  assert.equal(clamp(undefined, 3, 9), 3)
})

test('parseJsonReply repairs a trailing comma and a truncated object', () => {
  // trailing comma before the closer
  assert.deepEqual(parseJsonReply('{"a":1,"b":2,}'), { a: 1, b: 2 })
  // cut off mid-object by the token budget: the complete prefix is recovered
  const truncated = '{"summary":"很直接","traits":["惜字","不铺垫"],"phrases":[{"phrase":"先别动","count":"x'
  const repaired = parseJsonReply(truncated)
  assert.ok(repaired, 'a truncated object should still parse')
  assert.equal(repaired.summary, '很直接')
  assert.deepEqual(repaired.traits, ['惜字', '不铺垫'])
})

test('parseJsonReply still returns undefined for prose with no JSON', () => {
  assert.equal(parseJsonReply('我认为这个人很直接，说话简短。'), undefined)
})

test('deriveProfile builds a real profile from counts alone, inventing nothing', () => {
  const texts = [
    '先别动，我觉得这里有问题',
    '先别动，我觉得那里也有问题',
    '先别动，先确认口径',
    '把首页改成深色，先别动导航栏',
    '先别动，我觉得不对',
  ]
  const evidence = analyzeUserTexts(texts)
  const profile = deriveProfile(evidence)

  assert.ok(profile.summary.includes('统计'))
  assert.ok(profile.phrases.length > 0)
  // every phrase must come from the counted evidence, never from a model
  const counted = new Set(evidence.phrases.map(p => p.phrase))
  for (const entry of profile.phrases) {
    assert.ok(
      counted.has(entry.phrase) || evidence.openings.some(o => o.opening === entry.phrase),
      `derived phrase not grounded in evidence: ${entry.phrase}`,
    )
  }
  assert.ok(profile.phrases.some(p => p.phrase === '先别动'))
  assert.ok(profile.traits.length > 0)
  assert.ok(profile.styleRules.length > 0)
  // counts are carried through, not invented
  const first = profile.phrases.find(p => p.phrase === '先别动')
  assert.ok(first.count >= 4, `expected the counted frequency, got ${first?.count}`)
})

test('deriveProfile keeps every list bounded and coherent', () => {
  const evidence = analyzeUserTexts(Array.from({ length: 40 }, (_, i) => `先别动，这里有问题，第 ${i} 次`))
  const profile = deriveProfile(evidence)
  assert.ok(profile.traits.length <= 8)
  assert.ok(profile.styleRules.length <= 8)
  assert.ok(profile.antiPatterns.length <= 6)
  assert.ok(profile.phrases.length <= 40)
  assert.equal(typeof profile.summary, 'string')
})

test('isChatLike keeps prose and rejects machine-generated messages', () => {
  // real human messages from this user
  assert.equal(isChatLike('插件呢'), true)
  assert.equal(isChatLike('可以装进来了'), true)
  assert.equal(isChatLike('先别动，我觉得这里有问题，先确认口径再改'), true)
  assert.equal(isChatLike('把首页改成深色，先别动导航栏，改完给我看'), true)
  // a long but genuinely human paragraph must survive
  assert.equal(isChatLike('这段话有点长。'.repeat(40)), true)

  // machine output that actually polluted a real run
  assert.equal(
    isChatLike('chrome.exe --headless --disable-gpu --no-first-run --disable-extensions --remote-debugging-port=9222'),
    false,
    'a flag list is not speech',
  )
  assert.equal(
    isChatLike('Read C:\\Users\\nimo1\\Documents\\deepseek-harness\\default-workspace\\files\\read.md and its output'),
    false,
    'a path-heavy line is not speech',
  )
  assert.equal(isChatLike('[Tool: read] files documents read its default-workspace'), false)
  // Plain English prose repeating common words is still speech: repeated
  // function words are the stop-word filter's business, not this one's.
  assert.equal(isChatLike('progress: documents files read its users nimo background finished'), true)
  assert.equal(isChatLike('please read the documents and files, then read its output again'), true)
  // a pasted blob is rejected by length alone
  assert.equal(isChatLike('字'.repeat(2000)), false)
})

test('filterChatLike reports what it dropped and keeps the ratio honest', () => {
  const mixed = [
    '插件呢',
    '可以装进来了',
    'chrome.exe --headless --disable-gpu --no-first-run --disable-extensions',
    'Read C:\\Users\\nimo1\\Documents\\deepseek-harness\\default-workspace\\files\\read.md and its output',
    '先别动，我觉得有问题',
  ]
  const result = filterChatLike(mixed)
  assert.equal(result.scanned, 5)
  assert.equal(result.dropped, 2)
  assert.deepEqual(result.texts, ['插件呢', '可以装进来了', '先别动，我觉得有问题'])
})

test('analyzeUserTexts exposes how much was scanned versus kept', () => {
  const evidence = analyzeUserTexts([
    '插件呢',
    '插件呢',
    'chrome.exe --headless --disable-gpu --no-first-run --disable-extensions',
  ])
  assert.equal(evidence.scannedCount, 3)
  assert.equal(evidence.droppedCount, 1)
  assert.equal(evidence.messageCount, 2)
  assert.ok(evidence.phrases.some(p => p.phrase === '插件呢'))
})

test('confidence scales with how much clean material there was', () => {
  const make = (messageCount, droppedCount = 0) => ({ messageCount, droppedCount })
  assert.equal(confidenceOf(make(3)), 'low')
  assert.equal(confidenceOf(make(11)), 'low')
  assert.equal(confidenceOf(make(12)), 'limited')
  assert.equal(confidenceOf(make(29)), 'limited')
  assert.equal(confidenceOf(make(30)), 'normal')
  assert.equal(confidenceOf({}), 'low', 'no evidence at all is the weakest case')
})

test('confidenceNote discloses small corpora and stays silent when confident', () => {
  assert.equal(confidenceNote({ messageCount: 40, droppedCount: 5 }), '', 'a healthy corpus needs no caveat')

  const thin = confidenceNote({ messageCount: 20, droppedCount: 15 })
  assert.ok(thin.includes('20'), `expected the count in: ${thin}`)
  assert.ok(thin.includes('15'), 'the filtered machine messages are disclosed too')
  assert.ok(thin.includes('不是稳定口头禅'), 'the caveat says what it is not')

  const noFilter = confidenceNote({ messageCount: 5, droppedCount: 0 })
  assert.ok(noFilter.includes('5'))
  assert.ok(!noFilter.includes('被过滤'), 'nothing filtered, nothing to report')
})

test('evidenceToPrompt labels the number as messages, not a frequency', () => {
  const evidence = analyzeUserTexts(['插件呢', '插件呢', '插件呢'])
  const prompt = evidenceToPrompt(evidence)
  assert.ok(prompt.includes('消息条数'), `expected the honest label in: ${prompt}`)
  assert.ok(!prompt.includes('词频'), 'the misleading word must be gone')
  assert.ok(prompt.includes('插件呢'))
  // a thin corpus must carry the caveat into the model prompt
  assert.ok(prompt.includes('注意：'), `expected a confidence caveat in: ${prompt}`)
})

test('isHandoff recognises completions and go-aheads, not real requests', () => {
  // the exact message that produced the bogus 3/100
  assert.equal(isHandoff('重启完成，可以跑了'), true)
  assert.equal(isHandoff('重启完成'), true)
  assert.equal(isHandoff('装好了'), true)
  assert.equal(isHandoff('可以跑了'), true)
  assert.equal(isHandoff('继续执行'), true)
  assert.equal(isHandoff('好的'), true)
  assert.equal(isHandoff('ok'), true)
  assert.equal(isHandoff(''), true)

  // real requests must survive, including ones containing 继续
  assert.equal(isHandoff('继续执行原结果，不要重复试错'), false, 'a long real instruction is not a hand-off')
  assert.equal(isHandoff('请把判分链路的日志读出来并确证根因'), false)
  assert.equal(isHandoff('帮我把首页改成深色，先别动导航栏'), false)
  assert.equal(isHandoff('现在呢？'), false, 'a question is a request')
})

test('lastExchange skips a hand-off back to the real request it follows', () => {
  // The real shape that produced a bogus 3/100: the newest user message is a
  // short hand-off ("重启完成，可以跑了") and everything after it is the next
  // turn's tool activity. The request worth judging is the one before it.
  const transcript = [
    { role: 'user', text: '请把判分链路的日志读出来并确证根因，不要猜' },
    { role: 'assistant', text: '根因是取对话时把工具调用当成了交付内容，已改为按一轮问答取。' },
    { role: 'user', text: '重启完成，可以跑了' },
    { role: 'assistant', text: '正在读取判分日志' },
  ]
  const exchange = lastExchange(transcript)
  assert.equal(exchange.question, '请把判分链路的日志读出来并确证根因，不要猜')
  assert.ok(exchange.answer.includes('根因是取对话时把工具调用当成了交付内容'))
  assert.ok(!exchange.question.includes('重启完成'), 'a hand-off is not the request')
  // the regression that produced 3/100: the next turn's chatter must not be judged
  assert.ok(!exchange.answer.includes('正在读取判分日志'), 'tool-turn chatter must not be judged')

  const oneTurn = lastExchange([
    { role: 'user', text: '把首页改成深色' },
    { role: 'assistant', text: '已改好，改了三个变量。' },
  ])
  assert.equal(oneTurn.question, '把首页改成深色')
  assert.equal(oneTurn.answer, '已改好，改了三个变量。')
})

test('lastExchange never leaks the previous turn into the answer', () => {
  const transcript = [
    { role: 'user', text: '第一问，这是一个足够长的真实请求' },
    { role: 'assistant', text: '第一答' },
    { role: 'user', text: '第二问，这也是一个足够长的真实请求' },
    { role: 'assistant', text: '第二答' },
  ]
  const exchange = lastExchange(transcript)
  assert.equal(exchange.question, '第二问，这也是一个足够长的真实请求')
  assert.equal(exchange.answer, '第二答')
  assert.ok(!exchange.answer.includes('第一答'))
})

test('lastExchange ignores empty assistant messages and degrades safely', () => {
  // tool-call-only assistant messages carry no text and must not join the answer
  const exchange = lastExchange([
    { role: 'user', text: '请做点实际的事情' },
    { role: 'assistant', text: '' },
    { role: 'assistant', text: '   ' },
    { role: 'assistant', text: '真正的内容' },
    { role: 'assistant', text: '' },
  ])
  assert.equal(exchange.answer, '真正的内容')

  // a transcript of only hand-offs has no judgeable request
  const onlyHandoffs = lastExchange([
    { role: 'user', text: '好的' },
    { role: 'assistant', text: '嗯' },
  ])
  assert.equal(onlyHandoffs.question, '')
  assert.equal(onlyHandoffs.answer, '')

  assert.deepEqual(lastExchange([]), { question: '', answer: '', askedAt: -1, answeredAt: -1 })
  assert.equal(lastExchange([{ role: 'assistant', text: 'x' }]).question, '')
  assert.equal(lastExchange(undefined).answer, '')
})

test('buildJudgePrompt uses the exchange, not the raw tail', () => {
  const prompt = buildJudgePrompt({
    profile: {},
    calibration: { dimensions: [] },
    config: { passScore: 80, maxTranscriptChars: 2000 },
    transcript: [
      { role: 'user', text: '把首页改成深色，先别动导航栏' },
      { role: 'assistant', text: '已把首页换成深色，导航栏未改。' },
      { role: 'user', text: '好的' },
      { role: 'assistant', text: '工具噪音一' },
      { role: 'assistant', text: '工具噪音二' },
    ],
  })
  assert.ok(prompt.includes('把首页改成深色'))
  assert.ok(prompt.includes('已把首页换成深色'))
})

test('lastExchange judges the newest completed turn, not the in-flight one', () => {
  // The manual tool runs mid-turn, so the newest turn's answer is a partial
  // snapshot: it once judged 679 characters of unfinished output. With
  // dropNewestTurn and the live turn number it judges the newest delivery that
  // actually finished — T5 here, even though its request reads like a hand-off.
  const transcript = [
    { role: 'user', text: '请修掉判分取错内容的 bug 并给出证据', turn: 4 },
    { role: 'assistant', text: '已修好 contentText：只取 text 块，测试 60 个通过。', turn: 4 },
    { role: 'user', text: '已重启，允许执行' },
    { role: 'assistant', text: '已执行并附上日志与路径。', turn: 5 },
    { role: 'user', text: '继续' },
    { role: 'assistant', text: '正在准备执行（尚未完成）', turn: 6 },
  ]
  const completed = lastExchange(transcript, { dropNewestTurn: true, liveTurn: 6 })
  assert.equal(completed.turn, 5)
  assert.equal(completed.question, '已重启，允许执行', 'a terse request is still the request')
  assert.equal(completed.answer, '已执行并附上日志与路径。')
  assert.ok(!completed.answer.includes('尚未完成'), 'in-flight work must not be judged')

  // The automatic path runs after the turn closed, so it judges the newest
  // real request — skipping the "继续" hand-off that precedes the live answer.
  const live = lastExchange(transcript)
  assert.equal(live.question, '已重启，允许执行')
  assert.equal(live.answer, '已执行并附上日志与路径。')
  assert.ok(!live.answer.includes('尚未完成'), 'the unfinished turn is not bundled in')

  // Without turn metadata the option cannot locate a completed turn: it says so
  // rather than passing off live work as finished.
  const untagged = lastExchange([
    { role: 'user', text: '请做点实际的事情' },
    { role: 'assistant', text: '做完了' },
  ], { dropNewestTurn: true })
  assert.equal(untagged.answer, '做完了')
  assert.equal(untagged.judgedLiveTurn, true)
})

test('lastExchange falls back to the live turn instead of reporting no answer', () => {
  // With only the live turn present there is no completed delivery to judge, so
  // the tool judges what exists and says so — reporting "no answer" was a dead end.
  const liveOnly = [
    { role: 'user', text: '我已经重启了' },
    { role: 'assistant', text: '正在验证，尚未收尾', turn: 6 },
  ]
  const fallback = lastExchange(liveOnly, { dropNewestTurn: true, liveTurn: 6 })
  assert.equal(fallback.answer, '正在验证，尚未收尾')
  assert.equal(fallback.judgedLiveTurn, true, 'the caller must be able to disclose this')
})

test('lastExchange locates a completed turn by its answer turn number', () => {
  // The real shape that produced `judged question 2 chars, answer 0 chars`: the
  // live request is terse and carries no turn number, and the previous answer is
  // only reachable by knowing which turn it belongs to.
  const transcript = [
    { role: 'user', text: '我已经重启了' },
    { role: 'assistant', text: 'B'.repeat(93), turn: 19 },
    { role: 'assistant', text: 'C'.repeat(1470), turn: 19 },
    { role: 'user', text: '验证' },
    { role: 'assistant', text: '这轮还没产出', turn: 20 },
  ]
  const completed = lastExchange(transcript, { dropNewestTurn: true, liveTurn: 20 })
  assert.equal(completed.turn, 19, 'the completed turn is the one before the live turn')
  assert.equal(completed.question, '我已经重启了', 'a terse live request must not be mistaken for the question')
  assert.equal(completed.answer.length, 1565)
  assert.equal(completed.judgedLiveTurn, undefined, 'a completed turn is a real judgement')

  // Without a live turn number there is no reference to separate the two. The
  // newest turn is then judged plainly rather than assumed unfinished: assuming
  // it would refuse every call on a host that does not supply a turn number.
  const noReference = lastExchange(transcript, { dropNewestTurn: true })
  assert.equal(noReference.turn, 20, 'the newest turn is judged when nothing says it is live')
  assert.equal(noReference.judgedLiveTurn, undefined)
})

test('skipNewestTurn judges the turn before the live one without a turn number', () => {
  // The host does not always hand a tool its turn number (measured: exec.turn was
  // undefined while the log clearly carried T21). The newest turn is then assumed
  // to be the live one, and the turn before it is the newest completed delivery.
  const transcript = [
    { role: 'user', text: '那你重启吧，交给你了' },
    { role: 'assistant', text: 'D'.repeat(900), turn: 20 },
    { role: 'user', text: '重启了' },
    { role: 'assistant', text: 'E'.repeat(2102), turn: 21 },
    { role: 'user', text: '验证' },
  ]
  const completed = lastExchange(transcript, { dropNewestTurn: true, skipNewestTurn: true })
  assert.equal(completed.turn, 20, 'the newest turn is skipped, not judged mid-flight')
  assert.equal(completed.question, '那你重启吧，交给你了')
  assert.equal(completed.answer.length, 900)
  assert.equal(completed.judgedLiveTurn, undefined)

  // With nothing before the live turn there is no completed delivery to judge.
  const onlyLive = [
    { role: 'user', text: '验证' },
    { role: 'assistant', text: 'x'.repeat(100), turn: 21 },
  ]
  const fallback = lastExchange(onlyLive, { dropNewestTurn: true, skipNewestTurn: true })
  assert.equal(fallback.judgedLiveTurn, true, 'and it says so rather than pretending')
})

test('trivialReason skips simple replies but never a real delivery', () => {
  const config = { trivialMaxChars: 120, trivialMaxClauses: 2 }

  // Not worth a verdict: acknowledgements and conversational replies.
  assert.ok(trivialReason('好的，我这就去看一下你说的那个地方', config))
  assert.ok(trivialReason('已确认。', config))
  assert.ok(trivialReason('这个问题我需要再想想，先不动。', config))
  assert.equal(trivialReason('', config), 'empty answer')

  // Worth a verdict: anything with a concrete artifact, however short.
  assert.equal(trivialReason('改了 index.js 的 3 个变量。', config), '')
  assert.equal(trivialReason('跑 `node --test` 通过。', config), '')
  assert.equal(trivialReason('见 C:\\Users\\nimo1\\docs\\a.md', config), '')
  assert.equal(trivialReason('- 第一条\n- 第二条', config), '')
  // Long enough that it is a delivery by itself.
  assert.equal(trivialReason('说明'.repeat(70), config), '')
  // Several clauses is a real explanation even when short. This also has to stay
  // reachable: a clause rule stricter than minTurnLength can never fire.
  assert.equal(trivialReason('先读了日志。再对了两处。最后改了配置。', config), '')
})

test('the length floor and the clause rule agree about what is short', () => {
  // A three-clause reply of ~18 characters used to pass the clause rule and then
  // die on the length floor, which made the clause setting dead code. Any
  // configuration must keep a clause-passing reply above the floor.
  const config = resolveConfig({})
  assert.ok(
    config.minTurnLength <= config.trivialMaxChars,
    `minTurnLength (${config.minTurnLength}) must not exceed trivialMaxChars (${config.trivialMaxChars})`,
  )
  const clauses = '先读了日志。再对了两处。最后改了配置。'
  assert.equal(trivialReason(clauses, config), '', 'the clause rule passes it')
  assert.ok(clauses.length >= config.minTurnLength, 'and it clears the length floor too')
})

test('a bare number is not a deliverable', () => {
  // "1+1=2" contains a digit, and an earlier gate treated any digit as an
  // artifact — so arithmetic chatter was judged as if it were a delivery.
  const config = { trivialMaxChars: 120, trivialMaxClauses: 2, numericArtifactMinChars: 12 }
  assert.equal(hasArtifact('1+1=2', config), false)
  assert.equal(hasArtifact('2', config), false)
  assert.ok(trivialReason('1+1=2', config), 'arithmetic chatter is not worth a verdict')
  // A number inside a real reply still counts.
  assert.equal(hasArtifact('改了 index.css 的 3 个变量。', config), true)
  assert.equal(hasArtifact('跑 `node --test` 通过，74 个测试全绿。', config), true)
})

test('emptyLibrary is a complete, versioned document', () => {
  const library = emptyLibrary(1234)
  assert.equal(library.version, 1)
  assert.equal(library.createdAt, 1234)
  assert.equal(library.records.length, 0)
  assert.ok(library.calibration.dimensions.length >= 3)
  const sum = library.calibration.dimensions.reduce((n, d) => n + d.weight, 0)
  assert.equal(sum, 100, 'default weights must add up to 100')
})
