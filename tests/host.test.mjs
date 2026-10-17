/**
 * Host integration: mount the real plugin against a fake DSH context and check
 * that it registers what it promises, scores a finished turn, asks the
 * confirmation question, and records the answer.
 *
 * This drives the REAL PersonaLibrary (over a temp directory) and the REAL
 * tool definitions. Only the DSH services and the model are fakes, so the
 * assertions cover the plugin's own wiring and data flow end to end.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, name, inject, Config, settled } from '../lib/index.js'
import { PersonaLibrary } from '../lib/host/store.js'
import { DEFAULT_DIMENSIONS } from '../lib/shared/model.js'

const SESSION_ID = 'sess-test-1'

/** A scripted model: each queued reply answers the next call. */
function fakeLlm(replies) {
  const calls = []
  return {
    calls,
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: () => [{ id: 'deepseek-chat', name: 'chat' }],
    stream(options) {
      calls.push(options)
      const reply = replies.shift() ?? '{}'
      return (async function* generate() {
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

/** A real library rooted in a throwaway directory. */
async function tempLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-judge-test-'))
  const library = new PersonaLibrary(root)
  await library.load()
  await library.setProfile({
    summary: '结论先行、讨厌客套。',
    traits: ['不耐烦'],
    styleRules: ['直接给结论'],
    antiPatterns: ['先来一段铺垫'],
    phrases: [{ phrase: '先别动', count: 5, note: '进入正题前的前置声明' }],
  }, { messageCount: 12, sessionsSeen: [SESSION_ID] })
  await library.setCalibration({
    passScore: 80,
    dimensions: [
      { id: 'correctness', label: '正确性', description: '别错', weight: 70 },
      { id: 'concision', label: '简洁度', description: '别啰嗦', weight: 30 },
    ],
  })
  return { library, root }
}

/** The fake host's transcript, as the session events the reader consumes. */
function eventsOf(transcript) {
  return transcript.map((message, index) => ({
    type: message.role === 'user' ? 'user/message' : 'assistant/message',
    seq: index + 1,
    data: {
      // The host puts no turn number on a user event; assistant events carry one.
      ...(typeof message.turn === 'number' ? { turn: message.turn } : {}),
      message: { role: message.role, content: [{ type: 'text', text: message.text }] },
    },
  }))
}

/** The fake host context plus the observables the test asserts on. */
function fakeHost({ llm, transcript, answer }) {
  const tools = new Map()
  const listeners = new Map()
  const sections = []
  const asked = []

  const services = {
    llm,
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    sessionQuery: {
      // The surface and the durable log differ in the host (the surface is the
      // live context), but for these tests both carry the same events — and the
      // turn number rides along exactly as the host puts it on assistant events.
      async readSurface() {
        return { session: { id: SESSION_ID }, events: eventsOf(transcript) }
      },
      async readSession() {
        return { header: { id: SESSION_ID }, events: eventsOf(transcript) }
      },
      async listSessions() {
        return [{ header: { id: SESSION_ID, createdAt: Date.now() }, live: true, persisted: true }]
      },
    },
    userQuestions: {
      async ask(request) {
        asked.push(request)
        return { answers: [{ id: request.questions[0].id, selected: [answer] }] }
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    },
  }

  const host = {
    get: (key) => services[key],
    inject(keys, callback) {
      for (const key of keys) assert.ok(services[key], `inject asked for a missing service: ${key}`)
      callback(host)
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    effect(setup) {
      const dispose = typeof setup === 'function' ? setup() : undefined
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }

  return { host, tools, listeners, sections, asked }
}

// The user text must read as a real request: turn scoring deliberately skips
// hand-offs like「装好了」「可以跑了」, and an earlier fixture
// ('把首页改成深色，先别动导航栏') was itself classified as one because it ends
// in a bare instruction clause.
const TRANSCRIPT = [
  { role: 'user', text: '帮我把首页改成深色，先别动导航栏，改完把改动的变量列给我' },
  { role: 'assistant', text: '已把首页背景换成深色，导航栏保持原样。改了 index.css 的 3 个变量。' },
]

const JUDGE_FAIL_REPLY = JSON.stringify({
  // The judge itself is torn about whether this delivery deserved a verdict,
  // which is the condition for raising the confirmation card under the default
  // askWhen: 'unsure'.
  difficulty: 'unsure',
  dimensions: [
    { id: 'correctness', score: 90, comment: '改对了' },
    { id: 'concision', score: 30, comment: '又解释了一遍过程' },
  ],
  overall: 72,
  verdict: 'fail',
  issues: [{ what: '末尾复述了改动过程', fix: '只给结论和文件路径' }],
  summary: '结果对，但你不会喜欢这段复述。',
})

/** A confident verdict: no card under askWhen: 'unsure'. */
const JUDGE_CONFIDENT_REPLY = JSON.stringify({
  difficulty: 'normal',
  dimensions: [
    { id: 'correctness', score: 60, comment: '有遗漏' },
    { id: 'concision', score: 40, comment: '啰嗦' },
  ],
  overall: 54,
  verdict: 'fail',
  issues: [{ what: '漏了第二个要求', fix: '把要求逐条对一遍' }],
  summary: '按要求对照，漏了一条。',
})

/** Drive one finished turn through the real listener. */
async function finishTurn(listeners, library, turn) {
  await listeners.get('agent/turn-stopping')[0]({ agent: { id: SESSION_ID }, turn })
  await settled(library)
}

/**
 * Minimal check of a value against a declared output schema: the host rejects
 * an undeclared property outright ("is not a declared property"), so a tool
 * returning extra keys fails at runtime while every unit test still passes.
 */
function assertMatchesSchema(toolName, schema, value) {
  assert.ok(value && typeof value === 'object', `${toolName} returned a non-object`)
  for (const key of schema.required ?? []) {
    assert.ok(key in value, `${toolName} output is missing required "${key}"`)
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(schema.properties ?? {}, key),
        `${toolName} returned undeclared property "${key}" — the host rejects this`,
      )
    }
  }
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    if (!(key in value)) continue
    if (spec.type === 'string') {
      assert.equal(typeof value[key], 'string', `${toolName}.${key} must be a string`)
    }
  }
}

test('every tool output matches its declared schema and renders', async () => {
  const transcript = []
  for (let i = 0; i < 12; i += 1) {
    transcript.push({ role: 'user', text: `把插件装好并验证，第 ${i} 次说` })
    transcript.push({ role: 'assistant', text: `已装好并验证通过，第 ${i} 次。改了 index.js 的三处。` })
  }
  // replies cover persona_extract (profile + calibration) and persona_judge
  const llm = fakeLlm([
    JSON.stringify({
      summary: '说话短，直接要结果。',
      traits: ['直给'],
      styleRules: ['结论先行'],
      phrases: [],
      antiPatterns: ['铺垫'],
    }),
    JSON.stringify({
      passScore: 85,
      dimensions: [{ id: 'correctness', label: '正确性', description: '别错', weight: 100 }],
    }),
    JSON.stringify({
      dimensions: [{ id: 'correctness', score: 90, comment: '对了' }],
      verdict: 'pass',
      issues: [],
      summary: '合格。',
    }),
  ])
  const { library, root } = await tempLibrary()
  const { host, tools } = fakeHost({ llm, transcript, answer: '一致，按这个标准记录' })
  await apply(host, { askOnPass: false }, { library, storageRoot: root })

  const cases = [
    ['persona_report', {}],
    ['persona_extract', { extraSessions: 0 }],
    ['persona_judge', { ask: false }],
    ['persona_review', {}],
  ]
  for (const [toolName, args] of cases) {
    const definition = tools.get(toolName)
    assert.ok(definition, `${toolName} is not registered`)
    const value = await definition.execute(args, { agent: { id: SESSION_ID } })
    assertMatchesSchema(toolName, definition.output.schema, value)
    const blocks = definition.output.render(args, value)
    assert.ok(Array.isArray(blocks) && blocks.length > 0, `${toolName} rendered no content blocks`)
    assert.equal(blocks[0].type, 'text')
    assert.ok(blocks[0].text.length > 0, `${toolName} rendered empty text`)
  }
})

test('when the model declines to name catchphrases, the counts are still disclosed', async () => {
  // The real outcome of a thin corpus: the prompt makes the model return no
  // phrases rather than promote topic nouns, so the counted candidates must
  // still reach the report — otherwise the feature reports nothing at all.
  const transcript = []
  for (let i = 0; i < 12; i += 1) {
    transcript.push({ role: 'user', text: `插件呢，继续执行，第 ${i} 次说` })
    transcript.push({ role: 'assistant', text: `收到，第 ${i} 次。已核对。` })
  }
  const llm = fakeLlm([
    JSON.stringify({
      summary: '说话极短。',
      traits: ['极简'],
      styleRules: ['结论先行'],
      phrases: [], // the model refused to declare any catchphrase
      antiPatterns: [],
    }),
    JSON.stringify({
      passScore: 85,
      dimensions: [{ id: 'correctness', label: '正确性', description: '别错', weight: 100 }],
    }),
  ])
  const { library, root } = await tempLibrary()
  const { host, tools } = fakeHost({ llm, transcript, answer: '一致，按这个标准记录' })
  await apply(host, { askOnPass: false }, { library, storageRoot: root })

  const result = await tools.get('persona_extract').execute({ extraSessions: 0 }, { agent: { id: SESSION_ID } })
  assertMatchesSchema('persona_extract', tools.get('persona_extract').output.schema, result)

  assert.equal(library.data.profile.phrases.length, 0, 'the model declared none')
  assert.ok(library.data.profile.candidates.length > 0, 'the counted candidates are kept')
  assert.ok(
    library.data.profile.candidates.some(c => c.phrase === '插件呢'),
    `expected the real repeat among candidates: ${JSON.stringify(library.data.profile.candidates.slice(0, 5))}`,
  )
  assert.ok(result.text.includes('候选片段'), 'the report discloses them as unverified')
  assert.ok(result.text.includes('语料偏小'), 'and the thin-corpus caveat is present')
})

test('a judge-only dimension is graded but never injected', async () => {
  // The point of the flag: style standards shape the verdict without steering
  // the writing, so an injected weight cannot make the agent perform for it.
  // Membership comes from the CONFIG at render time, not from a stored flag.
  const { library, root } = await tempLibrary()
  await library.setCalibration({
    passScore: 82,
    dimensions: [
      { id: 'substance', label: '实质内容', description: '别空', weight: 80 },
      { id: 'no_fluff', label: '无客套', description: '别寒暄', weight: 20 },
    ],
  })
  const { host, sections } = fakeHost({ llm: fakeLlm([]), transcript: TRANSCRIPT, answer: '一致，按这个标准记录' })

  await apply(host, {}, { library, storageRoot: root })
  const text = sections[0].text({ turn: 1 })
  assert.ok(text.includes('实质内容'), 'an ordinary dimension is injected')
  assert.ok(!text.includes('无客套'), 'a judge-only dimension is not injected')
})

test('the judge-only list holds even when nothing stores it', async () => {
  // The flag once vanished from the stored dimensions between writes, which
  // silently re-injected the standard the user had excluded. Deriving membership
  // from the config at render time makes the stored shape irrelevant.
  const { library, root } = await tempLibrary()
  await library.setCalibration({
    passScore: 80,
    dimensions: [
      { id: 'no_fluff', label: '无客套', description: '别寒暄', weight: 40 },
      { id: 'substance', label: '实质', description: '别空', weight: 60 },
    ],
  })
  // Any round-trip that loses the per-dimension flag must not matter.
  const stripped = JSON.parse(JSON.stringify(library.data))
  for (const d of stripped.calibration.dimensions) delete d.judgeOnly

  const { host, sections } = fakeHost({ llm: fakeLlm([]), transcript: TRANSCRIPT, answer: '一致，按这个标准记录' })
  await apply(host, {}, {
    library: {
      data: stripped,
      stats: () => ({ records: 0, failed: 0, confirmed: 0, agreed: 0 }),
      load: async () => stripped,
    },
    storageRoot: root,
  })
  const text = sections[0].text({ turn: 1 })
  assert.ok(text.includes('实质'), 'the ordinary dimension is still injected')
  assert.ok(!text.includes('无客套'), 'the excluded one stays excluded with no stored flag at all')

  // An empty list excludes nothing, so the setting is the only source of truth.
  const none = fakeHost({ llm: fakeLlm([]), transcript: TRANSCRIPT, answer: '一致，按这个标准记录' })
  await apply(none.host, { judgeOnlyDimensions: '' }, { library, storageRoot: root })
  assert.ok(none.sections[0].text({ turn: 1 }).includes('无客套'))
})

test('an agreed judgement moves only the dimension that decided it', async () => {
  // The old rule bumped every dimension by a fixed step, so all of them drifted
  // together and nothing was learned about what the user actually cares about.
  const { library, root } = await tempLibrary()
  await library.setCalibration({
    passScore: 80,
    dimensions: [
      { id: 'a', label: 'A', description: '', weight: 25 },
      { id: 'b', label: 'B', description: '', weight: 25 },
      { id: 'c', label: 'C', description: '', weight: 25 },
      { id: 'd', label: 'D', description: '', weight: 25 },
    ],
  })
  await library.addRecord({
    id: 'r1',
    at: Date.now(),
    overall: 55,
    pass: false,
    passScore: 80,
    // 'd' is the dimension that actually cost the round: shortfalls are
    // a:2, b:60, c:-20, d:70. A dimension that scores near the line is the one
    // that was nearly satisfied — it is not what the round turned on.
    dimensions: [
      { id: 'a', label: 'A', weight: 25, score: 78 },
      { id: 'b', label: 'B', weight: 25, score: 20 },
      { id: 'c', label: 'C', weight: 25, score: 100 },
      { id: 'd', label: 'D', weight: 25, score: 10 },
    ],
  }, 10)

  await library.applyFeedback('r1', true)
  const byId = new Map(library.data.calibration.dimensions.map(d => [d.id, d.weight]))
  assert.ok(byId.get('d') > 25, `the dimension that cost the most gains weight (got ${byId.get('d')})`)
  assert.ok(
    byId.get('a') < 25 && byId.get('b') < 25 && byId.get('c') < 25,
    `the others give up the gain rather than all drifting up: ${JSON.stringify([...byId])}`,
  )
  assert.equal(Math.round([...byId.values()].reduce((x, y) => x + y, 0)), 100, 'weights stay normalized')
  assert.ok(byId.get('d') > byId.get('a'), 'and the ranking actually changed')
})

test('a simple turn is not scored and no card is raised', async () => {
  // The user's own standard: a turn too simple does not need a score. It must
  // cost nothing — no model call, no record, no confirmation card.
  const { library, root } = await tempLibrary()
  const llm = fakeLlm([])
  const { host, listeners, asked } = fakeHost({
    llm,
    transcript: [
      { role: 'user', text: '改好了吗' },
      { role: 'assistant', text: '好的，我这就去看一下。', turn: 6 },
    ],
    answer: '一致，按这个标准记录',
  })

  await apply(host, {}, { library, storageRoot: root })
  await finishTurn(listeners, library, 6)

  assert.equal(llm.calls.length, 0, 'no model call for a conversational reply')
  assert.equal(library.data.records.length, 0, 'and no record')
  assert.equal(asked.length, 0, 'and nothing to answer')
})

test('a terse but real delivery is still scored', async () => {
  // The gate must not swallow short work: a path or a number is a deliverable.
  const { library, root } = await tempLibrary()
  const llm = fakeLlm([JUDGE_FAIL_REPLY])
  const { host, listeners } = fakeHost({
    llm,
    transcript: [
      { role: 'user', text: '把首页改成深色并告诉我改了哪些变量' },
      { role: 'assistant', text: '改了 index.css 的 3 个变量。', turn: 6 },
    ],
    answer: '一致，按这个标准记录',
  })

  await apply(host, {}, { library, storageRoot: root })
  await finishTurn(listeners, library, 6)
  assert.equal(library.data.records.length, 1, 'a concrete short delivery is judged')
})

test('the judge can call a turn too simple, and then nothing is kept', async () => {
  // The judge sees what a threshold cannot: a reply that looks like a delivery
  // by length but has nothing to grade. Its verdict is respected — no record, no
  // card, and the library stays clean.
  const { library, root } = await tempLibrary()
  const llm = fakeLlm([JSON.stringify({
    difficulty: 'too_simple',
    dimensions: [],
    overall: 0,
    verdict: 'pass',
    issues: [],
    summary: '只是一句确认，没有可评的交付。',
  })])
  const { host, listeners, asked } = fakeHost({
    llm,
    transcript: [
      { role: 'user', text: '把首页改成深色并列出改动的变量' },
      { role: 'assistant', text: '好的，我这就去看一下你说的那个地方，稍等一下。', turn: 6 },
    ],
    answer: '一致，按这个标准记录',
  })

  await apply(host, {}, { library, storageRoot: root })
  await finishTurn(listeners, library, 6)

  assert.equal(llm.calls.length, 1, 'the judge was asked, so it could decide')
  assert.equal(library.data.records.length, 0, 'and its "too simple" verdict keeps nothing')
  assert.equal(asked.length, 0, 'and raises nothing for the user')
})

test('the confirmation card is raised only when the judge is unsure', async () => {
  const unsure = await tempLibrary()
  const unsureLlm = fakeLlm([JUDGE_FAIL_REPLY]) // difficulty: 'unsure'
  const unsureHost = fakeHost({ llm: unsureLlm, transcript: TRANSCRIPT, answer: '一致，按这个标准记录' })
  await apply(unsureHost.host, {}, { library: unsure.library, storageRoot: unsure.root })
  await finishTurn(unsureHost.listeners, unsure.library, 6)
  assert.equal(unsure.library.data.records.length, 1, 'an unsure verdict is still recorded')
  assert.equal(unsureHost.asked.length, 1, 'and the user is asked to confirm the standard')
  assert.equal(unsure.library.data.records[0].difficulty, 'unsure')

  const confident = await tempLibrary()
  const confidentLlm = fakeLlm([JUDGE_CONFIDENT_REPLY]) // difficulty: 'normal'
  const confidentHost = fakeHost({ llm: confidentLlm, transcript: TRANSCRIPT, answer: '一致，按这个标准记录' })
  await apply(confidentHost.host, {}, { library: confident.library, storageRoot: confident.root })
  await finishTurn(confidentHost.listeners, confident.library, 6)
  assert.equal(confident.library.data.records.length, 1, 'a confident verdict is recorded')
  assert.equal(confidentHost.asked.length, 0, 'but nothing is asked: a reflex answer adds noise')
})

test('askWhen: always restores the per-score confirmation', async () => {
  const { library, root } = await tempLibrary()
  const llm = fakeLlm([JUDGE_CONFIDENT_REPLY])
  const { host, listeners, asked } = fakeHost({ llm, transcript: TRANSCRIPT, answer: '一致，按这个标准记录' })
  await apply(host, { askWhen: 'always' }, { library, storageRoot: root })
  await finishTurn(listeners, library, 6)
  assert.equal(asked.length, 1, 'an explicit always still asks on a confident verdict')
})

test('a short reply with a concrete artifact is still judged', async () => {
  // The length floor must not swallow a terse deliverable; only a short reply
  // with nothing concrete in it is skipped for free.
  const { library, root } = await tempLibrary()
  const llm = fakeLlm([JUDGE_CONFIDENT_REPLY])
  const { host, listeners } = fakeHost({
    llm,
    transcript: [
      { role: 'user', text: '把首页改成深色并列出改动的变量' },
      { role: 'assistant', text: '改了 index.css 的 3 个变量。', turn: 6 },
    ],
    answer: '一致，按这个标准记录',
  })
  await apply(host, {}, { library, storageRoot: root })
  await finishTurn(listeners, library, 6)
  assert.equal(library.data.records.length, 1)
})

test('the plugin exports the loader contract', () => {
  assert.equal(name, 'persona-judge')
  assert.deepEqual(inject, ['llm'])
  assert.equal(typeof apply, 'function')
  // Config is a Standard Schema, not a field map; config.test.mjs covers it.
  const defaults = Config['~standard'].validate({}).value
  assert.equal(defaults.judge, 'turn')
  assert.equal(defaults.askOnPass, true)
  assert.equal(DEFAULT_DIMENSIONS.reduce((sum, d) => sum + d.weight, 0), 100)
})

test('mounting registers every tool, the judge listener and the prompt section', async () => {
  const { library, root } = await tempLibrary()
  const { host, tools, listeners, sections } = fakeHost({ llm: fakeLlm([]), transcript: TRANSCRIPT, answer: '一致，按这个标准记录' })

  await apply(host, {}, { library, storageRoot: root })

  assert.deepEqual(
    [...tools.keys()].sort(),
    ['persona_calibrate', 'persona_extract', 'persona_feedback', 'persona_judge', 'persona_report', 'persona_review'],
  )
  assert.ok(listeners.has('agent/turn-stopping'), 'the turn listener must be mounted')
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'persona-judge')

  const text = sections[0].text({ turn: 1 })
  assert.ok(text.includes('用户画像'))
  assert.ok(text.includes('结论先行、讨厌客套。'))
  assert.ok(text.includes('先别动'))
  assert.ok(text.includes('正确性'))
  assert.ok(text.includes('及格线 80'))
})

test('the injected block is full once per turn and compact on repeats', async () => {
  // A turn with tool calls issues many model requests; the standing block must
  // not be restated for each one or it dominates the context budget.
  const { library, root } = await tempLibrary()
  const { host, sections } = fakeHost({ llm: fakeLlm([]), transcript: TRANSCRIPT, answer: '一致，按这个标准记录' })
  await apply(host, {}, { library, storageRoot: root })

  const render = sections[0].text
  const first = render({ turn: 5 })
  const repeat = render({ turn: 5 })
  const nextTurn = render({ turn: 6 })

  assert.ok(first.includes('正确性'), 'the first request of a turn carries the dimensions')
  assert.ok(first.includes('结论先行、讨厌客套。'), 'and the portrait')
  assert.ok(repeat.length < first.length / 2, `a repeat must be much smaller (${repeat.length} vs ${first.length})`)
  assert.ok(repeat.includes('正确性'), 'the repeat still names the dimensions')
  assert.ok(!repeat.includes('结论先行、讨厌客套。') || repeat.length < first.length, 'the repeat is not the full portrait')
  assert.equal(nextTurn.length, first.length, 'a new turn pays for the full block again')
  // an unknown turn must never be treated as a repeat
  assert.equal(render({}).length, first.length)
})

test('the persona block still discloses thin evidence after slimming', async () => {
  const { library, root } = await tempLibrary()
  await library.setProfile(
    { summary: '话很短。', traits: ['直给'], styleRules: ['结论先行'], phrases: [], antiPatterns: [] },
    { messageCount: 5, confidence: 'low', confidenceNote: '语料偏小：仅 5 条像人话的消息。' },
  )
  const { host, sections } = fakeHost({ llm: fakeLlm([]), transcript: TRANSCRIPT, answer: '一致，按这个标准记录' })
  await apply(host, {}, { library, storageRoot: root })

  const text = sections[0].text({ turn: 1 })
  assert.ok(text.includes('语料偏小'), 'the caveat must survive the trim')
  assert.ok(text.includes('⚠️'))
})

test('a finished turn is scored, confirmed, and recorded as calibration', async () => {
  const { library, root } = await tempLibrary()
  const llm = fakeLlm([JUDGE_FAIL_REPLY])
  const { host, listeners, asked } = fakeHost({ llm, transcript: TRANSCRIPT, answer: '一致，按这个标准记录' })

  await apply(host, {}, { library, storageRoot: root })
  await finishTurn(listeners, library, 3)

  assert.equal(llm.calls.length, 1, 'exactly one judge call')
  const prompt = llm.calls[0].messages[0].content[0].text
  assert.ok(prompt.includes('帮我把首页改成深色'))
  assert.ok(prompt.includes('导航栏保持原样'))
  assert.ok(prompt.includes('先别动'), 'the profile reaches the judge prompt')

  assert.equal(library.data.records.length, 1)
  const record = library.data.records[0]
  assert.equal(record.overall, 72) // 90*0.7 + 30*0.3
  assert.equal(record.pass, false)
  assert.equal(record.passScore, 80)
  assert.equal(record.confirmed, true, 'an agreeing answer confirms the record')
  assert.equal(record.issues.length, 1)

  assert.equal(asked.length, 1, 'the confirmation question is asked')
  assert.ok(asked[0].questions[0].question.includes('72 分'))
  assert.equal(asked[0].questions[0].options.length, 3)
})

test('the record survives a process restart (real file, real reload)', async () => {
  const { library, root } = await tempLibrary()
  const llm = fakeLlm([JUDGE_FAIL_REPLY])
  const { host, listeners } = fakeHost({ llm, transcript: TRANSCRIPT, answer: '一致，按这个标准记录' })

  await apply(host, {}, { library, storageRoot: root })
  await finishTurn(listeners, library, 4)

  const reloaded = new PersonaLibrary(root)
  await reloaded.load()
  assert.equal(reloaded.data.records.length, 1)
  assert.equal(reloaded.data.records[0].overall, 72)
  assert.equal(reloaded.data.records[0].confirmed, true)
  assert.deepEqual(
    reloaded.data.calibration.dimensions.map(d => d.id),
    ['correctness', 'concision'],
  )
  // the append-only ledger is written too
  const audit = fs.readFileSync(path.join(root, 'judgements.jsonl'), 'utf8').trim().split('\n')
  assert.equal(audit.length, 2, 'one score line plus one feedback line')
})

test('a disagreeing answer records the disagreement and never re-runs the turn', async () => {
  const { library, root } = await tempLibrary()
  const llm = fakeLlm([JUDGE_FAIL_REPLY])
  const { host, listeners } = fakeHost({ llm, transcript: TRANSCRIPT, answer: '不一致，我实际的标准不同' })

  await apply(host, {}, { library, storageRoot: root })
  await finishTurn(listeners, library, 1)

  assert.equal(library.data.records.length, 1)
  assert.equal(library.data.records[0].confirmed, false)
  assert.equal(llm.calls.length, 1, 'no repair call is issued')
})

test('a short answer is skipped without spending a model call', async () => {
  const { library, root } = await tempLibrary()
  const llm = fakeLlm([])
  const { host, listeners } = fakeHost({
    llm,
    transcript: [{ role: 'user', text: '在吗' }, { role: 'assistant', text: '在' }],
    answer: '一致，按这个标准记录',
  })

  await apply(host, {}, { library, storageRoot: root })
  await finishTurn(listeners, library, 1)
  assert.equal(llm.calls.length, 0)
  assert.equal(library.data.records.length, 0)
})

test('judge: manual disables automatic scoring entirely', async () => {
  const { library, root } = await tempLibrary()
  const llm = fakeLlm([JUDGE_FAIL_REPLY])
  const { host, listeners } = fakeHost({ llm, transcript: TRANSCRIPT, answer: '一致，按这个标准记录' })

  await apply(host, { judge: 'manual' }, { library, storageRoot: root })
  await finishTurn(listeners, library, 1)
  assert.equal(llm.calls.length, 0)
  assert.equal(library.data.records.length, 0)
})

test('enabled: false mounts nothing at all', async () => {
  const { library, root } = await tempLibrary()
  const { host, tools, listeners, sections } = fakeHost({ llm: fakeLlm([]), transcript: TRANSCRIPT, answer: '一致，按这个标准记录' })

  await apply(host, { enabled: false }, { library, storageRoot: root })
  assert.equal(tools.size, 0)
  assert.equal(listeners.size, 0)
  assert.equal(sections.length, 0)
})

test('persona_report reads the library and never calls the model', async () => {
  const { library, root } = await tempLibrary()
  const llm = fakeLlm([])
  const { host, tools } = fakeHost({ llm, transcript: TRANSCRIPT, answer: '一致，按这个标准记录' })

  await apply(host, {}, { library, storageRoot: root })
  const result = await tools.get('persona_report').execute({}, { agent: { id: SESSION_ID } })
  assert.ok(result.text.includes('结论先行、讨厌客套。'))
  assert.ok(result.text.includes('正确性'))
  assert.equal(llm.calls.length, 0)
})

test('persona_extract refuses when there is not enough material', async () => {
  const { library, root } = await tempLibrary()
  const llm = fakeLlm(['{}'])
  const { host, tools } = fakeHost({
    llm,
    transcript: [{ role: 'user', text: '在吗' }],
    answer: '一致，按这个标准记录',
  })

  await apply(host, {}, { library, storageRoot: root })
  const result = await tools.get('persona_extract').execute({ extraSessions: 0 }, { agent: { id: SESSION_ID } })
  assert.ok(result.text.includes('用户消息不足'), result.text)
  assert.equal(llm.calls.length, 0, 'no model call for a thin corpus')
})

test('persona_extract grounds phrases in counted evidence and normalizes weights', async () => {
  const transcript = []
  for (let i = 0; i < 10; i += 1) {
    transcript.push({ role: 'user', text: `先别动，我觉得这里有问题，第 ${i} 次说` })
    transcript.push({ role: 'assistant', text: `收到，第 ${i} 次。` })
  }
  const llm = fakeLlm([
    JSON.stringify({
      summary: '先别动是他的开场白。',
      traits: ['谨慎'],
      styleRules: ['先确认再动手'],
      // one real phrase and one the evidence never saw
      phrases: [{ phrase: '先别动', count: 1, note: '前置声明' }, { phrase: '绝无此句', count: 9, note: '编的' }],
      antiPatterns: ['自作主张'],
    }),
    JSON.stringify({
      passScore: 85,
      dimensions: [
        { id: 'correctness', label: '正确性', description: '别错', weight: 60 },
        { id: 'intent', label: '诉求对齐', description: '别跑题', weight: 60 },
      ],
    }),
  ])
  const { library, root } = await tempLibrary()
  const { host, tools } = fakeHost({ llm, transcript, answer: '一致，按这个标准记录' })

  await apply(host, {}, { library, storageRoot: root })
  const result = await tools.get('persona_extract').execute({ extraSessions: 0 }, { agent: { id: SESSION_ID } })

  assert.deepEqual(
    library.data.profile.phrases.map(p => p.phrase),
    ['先别动'],
    'an invented phrase must be dropped',
  )
  assert.equal(library.data.profile.phrases[0].count, 10, 'the counted frequency wins')
  assert.equal(library.data.calibration.passScore, 85)
  assert.deepEqual(
    library.data.calibration.dimensions.map(d => d.weight),
    [50, 50],
    'weights are normalized to 100',
  )
  assert.ok(result.text.includes('已校准'), result.text)
})

test('persona_feedback confirms the newest unconfirmed record', async () => {
  const { library, root } = await tempLibrary()
  const llm = fakeLlm([JUDGE_FAIL_REPLY])
  const { host, listeners, tools } = fakeHost({ llm, transcript: TRANSCRIPT, answer: '不一致，我实际的标准不同' })

  await apply(host, { askOnPass: false }, { library, storageRoot: root })
  await finishTurn(listeners, library, 2)
  assert.equal(library.data.records[0].confirmed, undefined)

  const result = await tools.get('persona_feedback').execute({ agrees: false, note: '我这次其实满意' })
  assert.ok(result.text.includes('丢弃'), result.text)
  assert.equal(library.data.records[0].confirmed, false)
})

test('an unusable model route is reported instead of throwing', async () => {
  const { library, root } = await tempLibrary()
  const llm = fakeLlm([JUDGE_FAIL_REPLY])
  llm.listProviders = () => []
  const { host, tools } = fakeHost({ llm, transcript: TRANSCRIPT, answer: '一致，按这个标准记录' })

  await apply(host, {}, { library, storageRoot: root })
  const result = await tools.get('persona_judge').execute({ ask: false }, { agent: { id: SESSION_ID } })
  assert.ok(result.text.includes('无法确定判分模型'), result.text)
  assert.equal(library.data.records.length, 0)
})

test('a provider failure surfaces as a skip, never as a thrown turn', async () => {
  const brokenLlm = {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: () => [{ id: 'deepseek-chat', name: 'chat' }],
    stream() {
      return (async function* generate() {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider down', code: 'E_DOWN' } } }
      })()
    },
  }
  const { library, root } = await tempLibrary()
  // The completed turn must be a real delivery (an artifact, not a one-liner),
  // or the not-worth-scoring gate — not the provider — is what gets tested.
  const { host, tools } = fakeHost({
    llm: brokenLlm,
    transcript: [
      { role: 'user', text: '把判分链路的日志读出来并确证根因' },
      { role: 'assistant', text: '根因已确证：读取器用的是活上下文，因此改读完整日志。证据见 activation.log 第 4380 行。', turn: 4 },
      { role: 'user', text: '继续' },
      { role: 'assistant', text: '正在处理，尚未收尾。', turn: 5 },
    ],
    answer: '一致，按这个标准记录',
  })

  await apply(host, {}, { library, storageRoot: root })
  const result = await tools.get('persona_judge').execute({ ask: false }, { agent: { id: SESSION_ID }, turn: 5 })
  assert.ok(result.text.includes('model-failed'), result.text)
  assert.equal(library.data.records.length, 0)
})

test('the tool refuses to score an unfinished turn instead of inventing a number', async () => {
  // Measured against the live plugin: with only the in-flight turn available the
  // tool reported "38/100 — 不合格" for work that had not been delivered yet, and
  // wrote that number to the library. Refusing is the honest outcome.
  const { library, root } = await tempLibrary()
  const llm = fakeLlm([])
  const { host, tools } = fakeHost({
    llm,
    // Only the live turn exists, and its answer is long enough to pass the
    // length gate — so the refusal, not the length, is what must stop it.
    transcript: [
      { role: 'user', text: '修' },
      { role: 'assistant', text: '正在改：已定位根因，尚未收尾，稍后给出证据。', turn: 7 },
    ],
    answer: '一致，按这个标准记录',
  })

  await apply(host, {}, { library, storageRoot: root })
  // The host supplies the live turn number; without it the tool cannot tell a
  // finished turn from the one in flight.
  const result = await tools.get('persona_judge').execute({ ask: false }, { agent: { id: SESSION_ID }, turn: 7 })
  assert.ok(result.text.includes('没有可判的已完成轮次'), result.text)
  assert.equal(library.data.records.length, 0, 'nothing is written for unfinished work')
  assert.equal(llm.calls.length, 0, 'and no model call is spent on it')
})

test('an unreadable session is reported, not crashed', async () => {
  const { library, root } = await tempLibrary()
  const { host, tools } = fakeHost({ llm: fakeLlm([]), transcript: [], answer: '一致，按这个标准记录' })

  await apply(host, {}, { library, storageRoot: root })
  const result = await tools.get('persona_review').execute({ sessionId: 'missing' }, { agent: { id: SESSION_ID } })
  assert.ok(result.text.includes('读不到会话'), result.text)
})
