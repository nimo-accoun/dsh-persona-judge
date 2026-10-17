/**
 * dsh-persona-judge — host entry.
 *
 * Contract with DSH (verified against the installed plugin bundle):
 *   export const name    — loader entry identity
 *   export const inject  — services that must exist before apply runs
 *   export const Config  — plain-object config schema
 *   export function apply — mounts listeners, tools and the prompt section
 *
 * Turn-level scoring is the default: every finished turn is graded against
 * the user's own derived standard, a failing grade is surfaced (never
 * auto-applied), and a confirmation question turns an agreed guess into
 * calibration data.
 */
import { DEFAULT_DIMENSIONS, resolveConfig } from './shared/model.js'
import { ConfigDefinition } from './shared/config.js'
import { log, logFatal } from './shared/log.js'
import { PersonaLibrary, libraryRoot } from './host/store.js'
import { RouteBook, describe, resolveRoute } from './host/llm.js'
import { buildTools } from './host/tools.js'
import { judgeTurn } from './host/judge.js'
import { askAgreement } from './host/confirm.js'
import { readSessionLog, readTranscript } from './host/transcript.js'
import { extractProfile, calibrateJudge } from './host/extract.js'

export const name = 'persona-judge'

export const inject = ['llm']

/**
 * Config as a Standard Schema (see shared/config.js). The host calls
 * `Config['~standard'].validate(raw)` before `apply`, so this must be a
 * schema object — a plain field map fails activation with
 * "Cannot read properties of undefined (reading 'validate')".
 */
export const Config = ConfigDefinition

/**
 * Fire-and-forget with a log, so a listener can never reject into the loop.
 * Every detached operation is also recorded on the library so a test (or a
 * future shutdown path) can await in-flight judging instead of racing it.
 */
function detach(label, promise, library) {
  const tracked = Promise.resolve(promise).catch((error) => {
    log(`detached "${label}" failed: ${error?.stack ?? error}`)
  })
  if (library) {
    if (!Array.isArray(library.pending)) {
      Object.defineProperty(library, 'pending', { value: [], enumerable: false, configurable: true })
    }
    library.pending.push(tracked)
  }
  return tracked
}

/** Await every detached operation started for this library so far. */
export async function settled(library) {
  const pending = library?.pending
  if (!Array.isArray(pending)) return
  while (pending.length > 0) {
    const batch = pending.splice(0, pending.length)
    await Promise.all(batch)
  }
}

/** Config as a live read: `config` is mutated by the loader on reload. */
function configReader(getRaw) {
  let cache
  let cacheKey = ''
  return () => {
    const raw = getRaw()
    const key = JSON.stringify(raw ?? {})
    if (key !== cacheKey) {
      cacheKey = key
      cache = resolveConfig(raw)
      if (!Array.isArray(cache.dimensions)) cache.dimensions = DEFAULT_DIMENSIONS
    }
    return cache
  }
}

/**
 * The dimensions that belong in the agent's self-check.
 *
 * Membership is decided from the configured judge-only list at render time, so
 * the answer cannot be lost by a persistence round-trip.
 */
export function injectedDimensions(dimensions, config) {
  const judgeOnly = new Set(
    (Array.isArray(config?.judgeOnlyDimensions) ? config.judgeOnlyDimensions : [])
      .map(v => String(v).trim())
      .filter(Boolean),
  )
  return (dimensions ?? []).filter(d => !judgeOnly.has(String(d.id)))
}

/**
 * Render the persona block injected into the system prompt.
 *
 * This plugin is an assistant, not the task: the block is a standing cost on
 * every request, so it carries only what the agent can act on while writing —
 * a one-line portrait, the style rules, and the dimension labels with their
 * weights. The per-dimension descriptions ("what counts as good/bad") stay in
 * the library for the judge, which needs them and reads them exactly once per
 * turn. Measured: the full block was ~560 tokens per request; this is ~40%.
 */
function personaSectionText(library, config) {
  const data = library.data
  const profile = data.profile
  const calibration = data.calibration
  const stats = library.stats()

  if (!profile.extractedAt && !calibration.dimensions?.length) return ''

  const lines = ['## 用户画像（自检标准，交付前对一遍）']
  if (profile.summary) lines.push(`- 画像：${profile.summary}`)
  if (profile.confidenceNote) {
    // Disclose weak evidence here too: the agent should not treat a thin
    // corpus as a settled description of the person.
    lines.push(`- ⚠️ ${profile.confidenceNote}`)
  }
  if (profile.styleRules?.length) lines.push(`- 风格要求：${profile.styleRules.join('；')}`)
  if (profile.antiPatterns?.length) lines.push(`- 避免：${profile.antiPatterns.join('；')}`)
  if (profile.traits?.length) lines.push(`- 工作方式：${profile.traits.slice(0, 4).join('；')}`)
  if (profile.phrases?.length) {
    lines.push(`- 常用词：${profile.phrases.slice(0, 8).map(p => p.phrase).join('、')}`)
  } else if (profile.candidates?.length) {
    lines.push(`- 候选词（未确认，仅供参考）：${profile.candidates.slice(0, 8).map(p => p.phrase).join('、')}`)
  }
  if (calibration.dimensions?.length) {
    // A judge-only dimension is graded but NOT injected: it shapes the verdict
    // without shaping the writing. The set is read from the CONFIG at render
    // time rather than from a stored flag on each dimension — a flag that rides
    // through persistence was silently lost once already, and the config is the
    // user's standing decision anyway.
    const injected = injectedDimensions(calibration.dimensions, config)
    if (injected.length > 0) {
      lines.push(
        `- 自检维度（权重）：${injected.map(d => `${d.label} ${d.weight}`).join('、')}` +
        `；及格线 ${calibration.passScore ?? config.passScore}`,
      )
    } else {
      lines.push('- 自检维度：全部为判分专用（不影响你的写作），按交付质量与用户风格要求执行。')
    }
  }
  if (stats.records > 0) {
    lines.push(`- 历史：已评 ${stats.records} 轮，不合格 ${stats.failed} 轮，你已确认 ${stats.confirmed} 轮。`)
  }
  return lines.join('\n')
}

/**
 * Wrap the section so a turn pays for the portrait once.
 *
 * A turn with tool calls issues many model requests, and a prompt section
 * renderer has no other way to know it is repeating itself. The first request
 * of a turn gets the full block; later ones get a compact pointer, unless the
 * full block was truncated — then repeating it is the only way to keep the
 * dimensions visible at all.
 */
export function createPersonaSection(library, config, plan) {
  const full = () => personaSectionText(library, config)
  const compact = () => {
    const parts = []
    if (plan.compactSummary && library.data.profile.summary) {
      parts.push(`画像与自检标准见本轮首条请求（${library.data.profile.summary.slice(0, 24)}…）`)
    } else {
      parts.push('画像与自检标准见本轮首条请求。')
    }
    const dimensions = injectedDimensions(library.data.calibration.dimensions, config)
    if (dimensions.length > 0) {
      parts.push(`自检维度：${dimensions.map(d => `${d.label} ${d.weight}`).join('、')}。`)
    }
    return parts.join('')
  }

  let lastTurn
  let lastSent = ''
  return (context) => {
    const turn = typeof context?.turn === 'number' ? context.turn : undefined
    const current = full()
    if (current === '') return ''

    // A new turn (or an unknown one) resets the memory and pays for the text.
    if (turn === undefined || turn !== lastTurn) {
      lastTurn = turn
      lastSent = current
      return current
    }
    // A repeat within the same turn costs nothing — unless the full block was
    // clipped last time, in which case the dimensions must be restated.
    if (lastSent !== current) {
      lastSent = current
      return current
    }
    return compact()
  }
}

/**
 * Mount the plugin.
 *
 * `overrides` is a test seam only: DSH itself calls `apply(ctx, config)`, and
 * `overrides.storageRoot` / `overrides.library` let a test exercise the real
 * code paths against a temp directory instead of the user's library.
 */
export async function apply(ctx, rawConfig, overrides = {}) {
  try {
    return await applyInner(ctx, rawConfig, overrides)
  } catch (error) {
    return logFatal('apply', error)
  }
}

async function applyInner(ctx, rawConfig, overrides = {}) {
  log(`apply() entered; ctx.keys=${typeof ctx?.get}; has-on=${typeof ctx?.on}; has-effect=${typeof ctx?.effect}; has-inject=${typeof ctx?.inject}`)
  const getConfig = configReader(() => rawConfig)
  const config = getConfig()
  log(`config resolved: enabled=${config.enabled} judge=${config.judge}`)
  if (config.enabled === false) {
    log('disabled by config; mounting nothing')
    return
  }

  const root = overrides.storageRoot ?? libraryRoot()
  log(`library root = ${root}`)
  const library = overrides.library ?? new PersonaLibrary(root)
  await library.load()
  log('library loaded')
  const routeBook = new RouteBook()
  /** Pending confirmations: recordId -> { sessionId, askedAt }. */
  const confirmations = new Map()
  /**
   * A confirmation question outlives the turn that triggered it, so it also
   * outlives this plugin if the profile reloads while the card is on screen.
   * Aborting on dispose releases the answerer instead of leaving a listener
   * registered for a plugin that no longer exists.
   */
  const lifetime = new AbortController()
  try {
    ctx.on('dispose', () => {
      if (!lifetime.signal.aborted) lifetime.abort()
    })
  } catch (error) {
    log(`dispose listener rejected: ${error?.message ?? error}`)
  }

  log(`config: injectPersona=${getConfig().injectPersona}`)
  ctx.inject(['llm'], (hostCtx) => {
    log('injected: llm present')
    const deps = {
      ctx: hostCtx,
      getConfig,
      library,
      routeBook,
      confirmations,
      /** Resolve the judge route for one execution's session. */
      resolveRouteFor: (exec) => {
        const sessionId = exec?.agent?.id
        return resolveRoute(hostCtx, getConfig(), routeBook, sessionId)
      },
    }

    // ---- tools -----------------------------------------------------------
    try {
      const tools = hostCtx.get('tools')
      log(`tools service present: ${tools !== undefined}`)
      if (tools) {
        for (const definition of buildTools(deps)) {
          hostCtx.effect(() => tools.register(definition))
        }
        log('tools registered')
      }
    } catch (error) {
      log(`tool registration failed: ${error?.stack ?? error}`)
    }

    // ---- route bookkeeping ----------------------------------------------
    // Every subscription is attempted defensively: a host whose event shape
    // changed should lose one feature, not fail to mount the plugin.
    try {
      hostCtx.on('agent/request', (payload, next) => {
        const run = async () => {
          const resolved = await next()
          try {
            routeBook.remember(payload?.agent?.id, resolved)
          } catch {
            // route memory is best-effort
          }
          return resolved
        }
        return run()
      })
      log('agent/request listener mounted')
    } catch (error) {
      log(`agent/request listener rejected: ${error?.stack ?? error}`)
    }

    // ---- the turn loop ---------------------------------------------------
    try {
      hostCtx.on('agent/turn-stopping', (payload) => {
        // Every guard is logged: a handler that returns silently is
        // indistinguishable from a listener that never fired, and that
        // ambiguity already cost a full debugging round.
        const current = getConfig()
        const agent = payload?.agent
        log(
          `turn-stopping fired: enabled=${current.enabled} judge=${current.judge} ` +
          `agentId=${agent?.id ?? '(none)'} turn=${payload?.turn ?? '(none)'}`,
        )
        if (!current.enabled || current.judge !== 'turn') {
          log('turn-stopping: skipped (judge is not in turn mode)')
          return
        }
        if (!agent?.id) {
          log('turn-stopping: skipped (no agent id in payload)')
          return
        }
        detach('turn judge', scoreFinishedTurn(hostCtx, {
          agent,
          turn: payload.turn,
          signal: payload.signal,
          lifetime: lifetime.signal,
          config: current,
          library,
          routeBook,
          confirmations,
        }), library)
      })
      log('agent/turn-stopping listener mounted')
    } catch (error) {
      log(`turn listener rejected: ${error?.stack ?? error}`)
    }

    // ---- persona in the system prompt ------------------------------------
    if (getConfig().injectPersona !== false) {
      const renderSection = createPersonaSection(library, getConfig(), {
        compactSummary: getConfig().compactSummary,
      })
      const register = (order) => {
        const systemPrompt = hostCtx.get('systemPrompt')
        if (!systemPrompt) return false
        hostCtx.effect(() => systemPrompt.section({
          name: 'persona-judge',
          order,
          text: (context) => renderSection(context),
        }))
        return true
      }
      const order = Number(getConfig().injectOrder)
      try {
        if (!register(Number.isFinite(order) ? order : -50)) {
          log('systemPrompt service unavailable; persona not injected')
        } else {
          log(`persona section registered at order ${order}`)
        }
      } catch (error) {
        log(`section order ${order} rejected: ${error?.stack ?? error}; retrying at 0`)
        try {
          register(0)
          log('persona section registered at order 0')
        } catch (retryError) {
          log(`persona injection disabled: ${retryError?.stack ?? retryError}`)
        }
      }
    }

    // ---- optional cold start --------------------------------------------
    if (getConfig().autoExtractOnFirstTurn) {
      detach('cold start', coldStart(hostCtx, deps), library)
    }
    log('apply() completed successfully')
  })
}

/**
 * Score one finished turn end to end: read the surface, judge, persist, then
 * ask the confirmation question. Never throws to its caller.
 */
async function scoreFinishedTurn(ctx, { agent, turn, signal, lifetime, config, library, routeBook, confirmations }) {
  await library.load()
  const route = await resolveRoute(ctx, config, routeBook, agent.id)
  if (route.error) {
    log(`no judge route (${route.error}); turn ${turn} not scored`)
    return
  }
  log(`judging turn ${turn} via ${route.provider}/${route.model} (source ${route.source})`)

  // Judge the durable log, not the live surface. The surface is "what is in
  // context", which after a tool-heavy turn bundled several turns of assistant
  // text into the answer — a measured run judged `question 2 chars, answer 2989
  // chars` and scored it 44. The log carries the turn's own messages.
  const fromLog = await readSessionLog(ctx, agent.id, 0)
  const transcript = fromLog.messages.length > 0
    ? fromLog.messages
    : await readTranscript(ctx, agent.id, config.maxContextMessages)
  const result = await judgeTurn(ctx, {
    sessionId: agent.id,
    turn: turn ?? 0,
    route,
    config,
    library,
    transcript,
    // The turn's own abort signal is deliberately NOT forwarded: the judge
    // runs after the turn has closed and must survive it. Cancellation is the
    // plugin's own business, not the finished turn's.
  })
  if (result.skipped) {
    log(`turn ${turn} not scored: ${result.skipped} (answer ${result.answerLength ?? '?'} chars)`)
    return
  }

  const record = result.record
  confirmations.set(record.id, { sessionId: String(agent.id), askedAt: Date.now() })

  if (!config.askOnPass) return
  // Ask only when the judge was genuinely torn, or when configured to always
  // ask. Confirming every score made the card a chore the user answers by reflex,
  // which is worse than no confirmation at all: it feeds noise into calibration.
  const askWhen = config.askWhen ?? 'unsure'
  if (askWhen === 'unsure' && record.difficulty !== 'unsure') {
    log(`turn ${turn}: judged ${record.overall}; not asking (the judge was not unsure)`)
    return
  }
  const answer = await askAgreement(ctx, { agent, record, signal: lifetime })
  if (!answer.asked) {
    console.warn(`[persona-judge] confirmation not asked: ${answer.error}`)
    return
  }
  confirmations.delete(record.id)
  if (answer.choice === 'confirm') {
    await library.applyFeedback(record.id, true)
  } else if (answer.choice === 'reject' || answer.choice === 'not-unhappy') {
    await library.applyFeedback(record.id, false)
  }
  // 'unrecognized' leaves the record unconfirmed: better a gap than a wrong
  // calibration point.
}

/** Optional one-time profile bootstrap before the first judged turn. */
async function coldStart(ctx, deps) {
  const config = deps.getConfig()
  if (!config.autoExtractOnFirstTurn) return
  await deps.library.load()
  if (deps.library.data.profile.extractedAt) return

  const sessions = ctx.get('sessionQuery')
  if (!sessions) return
  const roots = await sessions.listSessions().catch(() => [])
  const newest = roots
    .filter(record => !record.header?.parentSession)
    .sort((a, b) => (b.header?.createdAt ?? 0) - (a.header?.createdAt ?? 0))[0]
  if (!newest) return

  const route = await resolveRoute(ctx, config, deps.routeBook, newest.header.id)
  if (route.error) return
  const extraction = await extractProfile(ctx, {
    route,
    config,
    sessionId: newest.header.id,
    extraSessions: 3,
  })
  if (!extraction.ok) {
    console.warn(`[persona-judge] cold start extraction skipped: ${extraction.reason}`)
    return
  }
  await deps.library.setProfile(extraction.profile, {
    sessionsSeen: extraction.sessionsSeen,
    messageCount: extraction.messageCount,
  })
  const calibrated = await calibrateJudge(ctx, {
    route,
    config,
    profile: extraction.profile,
    calibration: deps.library.data.calibration,
    sessionId: newest.header.id,
  })
  if (calibrated.ok) {
    await deps.library.setCalibration({ ...calibrated, judgeOnly: deps.getConfig().judgeOnlyDimensions })
  }
  console.log(
    `[persona-judge] cold start complete: ${extraction.profile.phrases.length} phrases, ` +
    `calibration ${calibrated.ok ? 'ok' : `failed (${calibrated.reason})`}`,
  )
}

export { LIBRARY_DIRNAME } from './shared/model.js'
export { libraryRoot } from './host/store.js'
