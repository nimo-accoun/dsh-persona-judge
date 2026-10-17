/**
 * The tools the main agent can call.
 *
 * The plugin also judges on its own (see index.js), but these are the manual
 * doors: extract now, grade now, inspect the library, answer a pending
 * confirmation, or re-calibrate the judge deliberately.
 */
import { callModel } from './llm.js'
import { calibrateJudge, extractProfile } from './extract.js'
import { describeRecord } from './confirm.js'
import { judgeTurn } from './judge.js'
import { readSessionLog, readTranscript, renderTranscript } from './transcript.js'
import { clip } from './llm.js'

/** Session id behind a tool execution, when the caller is an agent. */
function sessionOf(exec) {
  const id = exec?.agent?.id
  return id === undefined || id === null ? undefined : String(id)
}

/**
 * The live turn number, or undefined when the host does not provide one.
 *
 * Turns are 1-based. Coercing a missing turn to 0 made the completed-turn search
 * look for a turn below zero — it found none and the tool refused every call, so
 * the distinction between "unknown" and "turn zero" has to survive here.
 */
function currentTurn(exec) {
  const turn = exec?.turn
  if (typeof turn !== 'number' || !Number.isFinite(turn) || turn <= 0) return undefined
  return turn
}

/** Wrap a JSON value into the one content block every tool here returns. */
function textBlock(text) {
  return [{ type: 'text', text }]
}

/** Shared output definition: a markdown report plus its structured twin. */
const MARKDOWN_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'markdown 报告' } },
    required: ['text'],
    additionalProperties: false,
  },
  render: (_args, value) => textBlock(String(value?.text ?? '')),
}

/** Human summary of the persona profile. */
function profileReport(library) {
  const profile = library.data.profile
  if (!profile.extractedAt) return '尚未提取人格画像。先调用 persona_extract。'
  const lines = [
    `提取时间：${new Date(profile.extractedAt).toLocaleString()}`,
    `累计统计消息数：${profile.messageCount}`,
    profile.confidenceNote ? `⚠️ ${profile.confidenceNote}` : '',
    profile.summary ? `摘要：${profile.summary}` : '',
    profile.traits?.length ? `性格/工作方式：\n${profile.traits.map(t => `- ${t}`).join('\n')}` : '',
    profile.styleRules?.length ? `输出风格要求：\n${profile.styleRules.map(t => `- ${t}`).join('\n')}` : '',
    profile.antiPatterns?.length ? `明确反感：\n${profile.antiPatterns.map(t => `- ${t}`).join('\n')}` : '',
    profile.phrases?.length
      ? `反复用到的词（括号内 = 提到它的消息条数）：\n` +
        profile.phrases.map(p => `- ${p.phrase}（${p.count} 条）${p.note ? ` — ${p.note}` : ''}`).join('\n')
      : '反复用到的词：无（语料太少，或没有跨消息重复的短语）',
    // The model is right to refuse declaring topic nouns as catchphrases, but
    // "nothing to report" is not the whole truth: the counted candidates still
    // exist. Show them as unverified rather than either hiding them or
    // promoting them to a claim the evidence does not support.
    candidateBlock(profile),
  ].filter(Boolean)
  return lines.join('\n\n')
}

/** The counted phrase candidates, disclosed as unverified. */
function candidateBlock(profile) {
  const candidates = profile.candidates
  if (!Array.isArray(candidates) || candidates.length === 0) return ''
  return '候选片段（统计出现但模型未确认为口头禅，仅供参考）：\n' +
    candidates.slice(0, 12).map(c => `- ${c.phrase}（${c.count} 条）`).join('\n')
}

/** Human summary of calibration + history. */
function calibrationReport(library) {
  const stats = library.stats()
  const dimensions = library.data.calibration.dimensions
  const lines = [
    `及格线：${stats.passScore}`,
    `评分维度：\n${dimensions.map(d => `- ${d.label}（${d.id}，权重 ${d.weight}）：${d.description}`).join('\n')}`,
    `已评分 ${stats.records} 轮，其中不合格 ${stats.failed} 轮。`,
    `已确认 ${stats.confirmed} 轮，你认同我的判断 ${stats.agreed} 轮` +
      `${stats.agreementRate === null ? '' : `（一致率 ${Math.round(stats.agreementRate * 100)}%）`}。`,
  ]
  const recent = library.data.records.slice(-5).reverse()
  if (recent.length > 0) {
    lines.push('最近几轮：')
    for (const record of recent) {
      const mark = record.confirmed === undefined ? '未确认' : record.confirmed ? '已确认一致' : '已确认不一致'
      lines.push(`- ${new Date(record.at).toLocaleString()} ${record.overall} 分 ${record.pass ? '合格' : '不合格'}（${mark}）`)
    }
  }
  return lines.join('\n')
}

/**
 * Build every tool definition. `deps` carries the shared runtime: config,
 * library, route book and the pending-confirmation table.
 */
export function buildTools(deps) {
  const { getConfig, library, routeBook, confirmations, resolveRouteFor } = deps

  return [
    {
      name: 'persona_extract',
      description:
        '从本会话（以及可选的最近若干会话）中提取用户的口头禅、性格特征与表达风格，写入人格库，' +
        '并据此重新校准"我用来给他打分"的评分维度。统计部分为确定性词频，模型只做解释，不会编造短语。',
      parameters: {
        type: 'object',
        properties: {
          extraSessions: {
            type: 'integer',
            description: '额外扫描最近多少个会话（0 表示只看当前会话），默认 0。',
            minimum: 0,
            maximum: 20,
          },
          calibrate: {
            type: 'boolean',
            description: '是否同时重新校准评分维度，默认 true。',
          },
        },
        additionalProperties: false,
      },
      output: MARKDOWN_OUTPUT,
      async execute(args, exec) {
        const config = getConfig()
        const sessionId = sessionOf(exec)
        const route = await resolveRouteFor(exec)
        if (route.error) {
          return { text: `无法确定判分模型：${route.error}` }
        }
        const extraSessions = Number.isFinite(Number(args?.extraSessions)) ? Number(args.extraSessions) : 0

        const extraction = await extractProfile(deps.ctx, {
          route,
          config,
          sessionId,
          signal: exec.signal,
          extraSessions,
          sessionQuery: true,
        })
        if (!extraction.ok) {
          const detail = extraction.reason === 'not-enough-user-messages'
            ? `用户消息不足：已有 ${extraction.messageCount} 条，至少需要 ${extraction.needed} 条。`
            : `提取失败：${extraction.reason}${extraction.error ? ` (${extraction.error})` : ''}`
          return { text: detail }
        }

        await library.setProfile(extraction.profile, {
          sessionsSeen: extraction.sessionsSeen,
          messageCount: extraction.messageCount,
          confidence: extraction.confidence,
          confidenceNote: extraction.confidenceNote,
          candidates: extraction.candidates,
        })

        let calibrationNote = '未校准（calibrate=false）。'
        if (args?.calibrate !== false) {
          const calibrated = await calibrateJudge(deps.ctx, {
            route,
            config,
            profile: extraction.profile,
            calibration: library.data.calibration,
            signal: exec.signal,
            sessionId,
          })
          if (calibrated.ok) {
            await library.setCalibration({ ...calibrated, judgeOnly: config.judgeOnlyDimensions })
            const marked = library.data.calibration.dimensions.filter(d => d.judgeOnly).map(d => d.label)
            calibrationNote =
              `已校准 ${calibrated.dimensions.length} 个维度，及格线 ${calibrated.passScore}：\n` +
              calibrated.dimensions.map(d => `- ${d.label}（权重 ${d.weight}）：${d.description}`).join('\n') +
              (marked.length > 0 ? `\n其中 ${marked.join('、')} 为判分专用：会计分，但不注入自检标准。` : '')
          } else {
            calibrationNote = `校准失败：${calibrated.reason}${calibrated.error ? ` (${calibrated.error})` : ''}`
          }
        }

        const evidence = extraction.evidence
        const dropped = evidence?.droppedCount ?? 0
        return {
          text: [
            `已分析 ${extraction.messageCount} 条消息，来自 ${extraction.sessionsSeen.length} 个会话；` +
              `命中 ${extraction.profile.phrases.length} 个重复短语。`,
            dropped > 0
              ? `另外过滤掉 ${dropped} 条机器生成的消息（粘贴的日志、进度报告、工具输出），它们不是你说的话。`
              : '',
            extraction.confidenceNote ? `⚠️ ${extraction.confidenceNote}` : '',
            extraction.profileSource === 'stats'
              ? `画像来源：统计（${extraction.profileNote ?? '模型未给出可用解释'}）`
              : '画像来源：模型解释 + 统计校验',
            '',
            profileReport(library),
            '',
            calibrationNote,
          ].filter(line => line !== '').join('\n'),
        }
      },
    },

    {
      name: 'persona_judge',
      description:
        '按用户自己的评分标准给"当前这一轮"打分：先读取会话表面对话，再以独立模型调用给出各维度分数、' +
        '总分与不及格理由。不会自动重做，只给结论与整改建议。',
      parameters: {
        type: 'object',
        properties: {
          ask: {
            type: 'boolean',
            description: '是否同时弹出"我的判断和你一致吗"的核对问题，默认 true。',
          },
        },
        additionalProperties: false,
      },
      output: MARKDOWN_OUTPUT,
      async execute(args, exec) {
        const config = getConfig()
        const sessionId = sessionOf(exec)
        if (!sessionId) return { text: '无法确定当前会话。' }
        const route = await resolveRouteFor(exec)
        if (route.error) return { text: `无法确定判分模型：${route.error}` }

        // The durable log, not the live surface: the surface no longer holds a
        // finished turn's answer, which is exactly what this tool has to judge.
        // Fall back to the surface when the log cannot be read.
        const fromLog = await readSessionLog(deps.ctx, sessionId, 400)
        const transcript = fromLog.messages.length > 0
          ? fromLog.messages
          : await readTranscript(deps.ctx, sessionId, Math.max(config.maxContextMessages * 8, 64))
        const result = await judgeTurn(deps.ctx, {
          sessionId,
          // A real turn number, or undefined when the host does not supply one.
          // Passing 0 here turned "unknown" into "turn zero" and made the
          // completed-turn search look for a turn below zero, i.e. none.
          turn: currentTurn(exec),
          route,
          config,
          library,
          transcript,
          signal: exec.signal,
          // This tool runs while the current turn is still streaming, so the
          // newest turn's answer is incomplete by construction: judge the last
          // completed delivery — and when there is none, refuse rather than
          // write a score computed on unfinished work.
          dropNewestTurn: true,
          // The host does not always give a tool its turn number, so the newest
          // turn is assumed to be the one in flight.
          skipNewestTurn: true,
          refuseLiveTurn: true,
        })
        if (result.skipped) {
          if (result.skipped === 'no-completed-turn') {
            return {
              text: '没有可判的已完成轮次：当前这一轮尚未收尾，评它只会得到一个基于半成品的错误分数。'
                + '本轮结束后自动判分会跑；或稍后再调用本工具。',
            }
          }
          if (result.skipped === 'not-worth-scoring') {
            return {
              text: `这一轮不值得评分：${result.reason}。`
                + '内容过于简单时评分只会产生噪音，也不会占用你的核对。',
            }
          }
          // The measured length is included because a bare reason string is
          // indistinguishable from a truncated or empty read.
          return {
            text: `未评分：${result.skipped}（取到 ${result.answerLength ?? '?'} 字符，阈值 ${config.minTurnLength}）` +
              `${result.error ? ` (${result.error})` : ''}`,
          }
        }
        const record = result.record
        let askNote = ''
        const askWhen = config.askWhen ?? 'unsure'
        const shouldAsk = args?.ask !== false && config.askOnPass
          && (askWhen === 'always' || record.difficulty === 'unsure')
        if (shouldAsk) {
          const { askAgreement } = await import('./confirm.js')
          const asked = await askAgreement(deps.ctx, { agent: exec.agent, record })
          askNote = asked.asked
            ? `\n\n已弹出核对问题（结果：${asked.choice ?? asked.error}）。`
            : `\n\n核对问题未弹出：${asked.error}`
        } else {
          askNote = '\n\n未弹核对：裁判对这一轮有把握，无需你确认标准。'
        }
        // Only `text` is declared in MARKDOWN_OUTPUT; anything else is rejected
        // by the host's output validation, so the record stays in the library.
        return { text: describeRecord(record) + askNote }
      },
    },

    {
      name: 'persona_feedback',
      description:
        '回答"我（插件）的评分猜测与用户实际感受是否一致"。一致则把这次评分写入校准数据并强化相关维度权重；' +
        '不一致则丢弃这次评分，原始结果照常保留。',
      parameters: {
        type: 'object',
        properties: {
          recordId: { type: 'string', description: '评分记录 id；省略则取最近一条未确认记录。' },
          agrees: { type: 'boolean', description: '用户的评价与本次打分是否一致。' },
          note: { type: 'string', description: '用户的原话或补充说明。' },
        },
        required: ['agrees'],
        additionalProperties: false,
      },
      output: MARKDOWN_OUTPUT,
      async execute(args) {
        await library.load()
        const records = library.data.records
        const target = args?.recordId
          ? records.find(r => r.id === args.recordId)
          : [...records].reverse().find(r => r.confirmed === undefined)
        if (!target) return { text: '没有找到可确认的评分记录。' }

        const outcome = await library.applyFeedback(target.id, args?.agrees === true, args?.note)
        if (!outcome.ok) {
          return { text: `未能记录：${outcome.reason}` }
        }
        return {
          text: args?.agrees === true
            ? `已记录为"一致"：这次评分（${target.overall} 分）成为校准数据，相关维度权重已上调。`
            : `已记录为"不一致"：这次评分被丢弃，原始结果不受影响。当前基准仍为上一轮。`,
          recordId: target.id,
        }
      },
    },

    {
      name: 'persona_report',
      description: '查看当前人格画像、评分维度、及格线与评分历史统计（不调用模型）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: MARKDOWN_OUTPUT,
      async execute() {
        await library.load()
        return { text: [profileReport(library), '', '---', '', calibrationReport(library)].join('\n') }
      },
    },

    {
      name: 'persona_calibrate',
      description:
        '只重新校准评分维度与及格线（不重新提取口头禅）。适合在多次"不一致"反馈后修正判分标准。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: MARKDOWN_OUTPUT,
      async execute(_args, exec) {
        const config = getConfig()
        await library.load()
        const route = await resolveRouteFor(exec)
        if (route.error) return { text: `无法确定判分模型：${route.error}` }
        const calibrated = await calibrateJudge(deps.ctx, {
          route,
          config,
          profile: library.data.profile,
          calibration: library.data.calibration,
          signal: exec.signal,
          sessionId: sessionOf(exec),
        })
        if (!calibrated.ok) {
          return { text: `校准失败：${calibrated.reason}${calibrated.error ? ` (${calibrated.error})` : ''}` }
        }
        await library.setCalibration({ ...calibrated, judgeOnly: config.judgeOnlyDimensions })
        const marked = library.data.calibration.dimensions.filter(d => d.judgeOnly).map(d => d.label)
        return {
          text: `已校准，及格线 ${calibrated.passScore}：\n` +
            calibrated.dimensions.map(d => `- ${d.label}（权重 ${d.weight}）：${d.description}`).join('\n') +
            (marked.length > 0 ? `\n判分专用（不注入自检）：${marked.join('、')}` : ''),
        }
      },
    },

    {
      name: 'persona_review',
      description:
        '事后补审：对指定会话（默认当前）最近的一轮对话重新打分，或对任意会话的表面对话打分。用于复盘。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '目标会话 id，省略则用当前会话。' },
          contextMessages: {
            type: 'integer',
            description: '送入判分的最近消息条数，默认取配置值。',
            minimum: 2,
            maximum: 100,
          },
          showTranscript: { type: 'boolean', description: '是否在结果里附带判分所用的对话节选。' },
        },
        additionalProperties: false,
      },
      output: MARKDOWN_OUTPUT,
      async execute(args, exec) {
        const config = getConfig()
        const sessionId = typeof args?.sessionId === 'string' && args.sessionId.trim() !== ''
          ? args.sessionId.trim()
          : sessionOf(exec)
        if (!sessionId) return { text: '无法确定目标会话。' }
        const route = await resolveRouteFor(exec)
        if (route.error) return { text: `无法确定判分模型：${route.error}` }
        const limit = Number.isFinite(Number(args?.contextMessages))
          ? Number(args.contextMessages)
          : config.maxContextMessages
        const transcript = await readTranscript(deps.ctx, sessionId, limit)
        if (transcript.length === 0) return { text: `读不到会话 ${sessionId} 的表面对话（可能已归档或无权限）。` }
        const result = await judgeTurn(deps.ctx, {
          sessionId,
          // A real turn number, or undefined when the host does not supply one.
          // Passing 0 here turned "unknown" into "turn zero" and made the
          // completed-turn search look for a turn below zero, i.e. none.
          turn: currentTurn(exec),
          route,
          config,
          library,
          transcript,
          signal: exec.signal,
        })
        if (result.skipped) {
          return { text: `未评分：${result.skipped}${result.error ? ` (${result.error})` : ''}` }
        }
        return {
          text: [
            describeRecord(result.record),
            args?.showTranscript ? `\n--- 判分所用对话 ---\n${clip(renderTranscript(transcript), 2000)}` : '',
          ].filter(Boolean).join('\n'),
        }
      },
    },
  ]
}

export { MARKDOWN_OUTPUT }
