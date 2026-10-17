/**
 * Model route resolution and one-shot judge calls.
 *
 * The judge is an ordinary model call through `ctx.llm`, so it costs exactly
 * what any other call costs. Route choice is deliberately defensive: the
 * plugin must never fail a turn because a configured model was renamed.
 */
import { log } from '../shared/log.js'

/** Extract the last model route seen for a session, if any. */
export class RouteBook {
  constructor() {
    this.bySession = new Map()
    this.lastAny = null
  }

  /** Remember the route carried by a `request/header` event. */
  remember(sessionId, config) {
    if (!config || typeof config.provider !== 'string' || typeof config.model !== 'string') return
    const route = {
      provider: config.provider,
      model: config.model,
      reasoningEffort: typeof config.reasoningEffort === 'string' ? config.reasoningEffort : undefined,
    }
    this.bySession.set(String(sessionId), route)
    this.lastAny = route
  }

  /** Drop a route when its session leaves. */
  forget(sessionId) {
    this.bySession.delete(String(sessionId))
  }

  /** Best known route for one session, falling back to the newest seen. */
  for(sessionId) {
    return this.bySession.get(String(sessionId)) ?? this.lastAny ?? null
  }
}

/** Turn one async chunk stream into its concatenated text plus finish reason. */export async function collectStream(stream, signal) {
  let text = ''
  let finish
  let usage
  for await (const chunk of stream) {
    if (signal?.aborted) break
    if (chunk?.type === 'text-delta') text += chunk.text ?? ''
    else if (chunk?.type === 'usage') usage = chunk.usage
    else if (chunk?.type === 'finish') finish = chunk.reason
  }
  return { text, finish, usage }
}

/** Trim a transcript so a judge prompt stays bounded. */
export function clip(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  const head = Math.floor(max * 0.6)
  const tail = max - head
  return `${value.slice(0, head)}\n…[中略 ${value.length - max} 字]…\n${value.slice(value.length - tail)}`
}

/**
 * Index of the last comma that is not inside a JSON string, or -1.
 */
function lastCommaOutsideString(text) {
  let inString = false
  let escaped = false
  let last = -1
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === ',') last = i
  }
  return last
}

/**
 * Cheap repairs that recover the shapes models actually emit: a trailing
 * comma before a closing brace, or a reply cut off mid-object by the token
 * budget (close the open braces after dropping the incomplete tail).
 */
function repairJson(text) {
  const attempts = []
  const noTrailingComma = text.replace(/,\s*([}\]])/g, '$1')
  if (noTrailingComma !== text) attempts.push(noTrailingComma)

  // Truncated object: keep the longest prefix whose braces balance, then add
  // the closers it is missing.
  let depth = 0
  let inString = false
  let escaped = false
  let lastComplete = -1
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) lastComplete = i
    }
  }
  // Truncation can land mid-string, so this runs whenever a container is still
  // open: cut back to the last comma outside a string and close what remains,
  // in the reverse of the order the containers were opened.
  if (depth > 0) {
    const cut = lastCommaOutsideString(text)
    if (cut > 0) {
      const head = text.slice(0, cut)
      const stack = openStack(head)
      if (stack.length > 0) {
        const closers = stack.map(c => (c === '{' ? '}' : ']')).reverse().join('')
        attempts.push(head + closers)
      }
    }
  }
  if (lastComplete > 0) attempts.push(text.slice(0, lastComplete + 1))
  return attempts
}

/** The still-open containers of a truncated JSON prefix, in open order. */
function openStack(text) {
  const stack = []
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') stack.push(c)
    else if (c === '}' || c === ']') stack.pop()
  }
  return stack
}

/**
 * Pull the first JSON object out of a model reply. Models wrap JSON in prose,
 * fences, a trailing comma, or cut it off at maxTokens often enough that a
 * strict parse would fail most of the time.
 */
export function parseJsonReply(text) {
  const value = String(text ?? '').trim()
  if (value === '') return undefined
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/)
  const first = value.indexOf('{')
  const last = value.lastIndexOf('}')
  const sliced = first !== -1 && last > first ? value.slice(first, last + 1) : undefined

  const candidates = []
  if (fenced) candidates.push(fenced[1])
  candidates.push(value)
  if (sliced) candidates.push(sliced)
  // repairs run over the same shapes, most-specific first
  for (const candidate of [...candidates]) {
    if (candidate) candidates.push(...repairJson(candidate.trim()))
  }

  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate.trim())
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // try the next shape
    }
  }
  return undefined
}

/**
 * Resolve the provider/model route to use.
 *
 * Order: explicit config, the route this session is already using, the host's
 * default-model service, then any registered provider's first model. The
 * result is validated against the live adapter list so a stale name degrades
 * to the next candidate instead of throwing at call time.
 */
export async function resolveRoute(ctx, config, routeBook, sessionId) {
  const llm = ctx.get('llm')
  if (!llm) return { error: 'llm-service-unavailable' }

  let providers = []
  try {
    providers = llm.listProviders() ?? []
  } catch (error) {
    return { error: `listProviders failed: ${describe(error)}` }
  }
  if (providers.length === 0) return { error: 'no-llm-provider-registered' }
  const known = new Set(providers.map(p => p.id))

  const candidates = []
  if (config.provider && config.model) {
    candidates.push({
      provider: config.provider,
      model: config.model,
      reasoningEffort: config.reasoningEffort || undefined,
      source: 'config',
    })
  }
  const sessionRoute = routeBook.for(sessionId)
  if (sessionRoute) candidates.push({ ...sessionRoute, source: 'session' })

  const defaultModel = ctx.get('agentDefaultModel')
  if (defaultModel) {
    try {
      const selection = defaultModel.currentSelection()
      if (selection?.provider && selection?.model) {
        candidates.push({
          provider: selection.provider,
          model: selection.model,
          reasoningEffort: selection.reasoningEffort ?? undefined,
          source: 'default-model',
        })
      }
    } catch {
      // a host without a usable default selection falls through
    }
  }

  for (const candidate of candidates) {
    if (known.has(candidate.provider)) return candidate
  }

  // Nothing usable is known: ask the first provider what it serves.
  for (const provider of providers) {
    try {
      const models = await llm.listModels(provider.id)
      if (Array.isArray(models) && models.length > 0) {
        return {
          provider: provider.id,
          model: models[0].id,
          reasoningEffort: config.reasoningEffort || undefined,
          source: 'provider-first-model',
        }
      }
    } catch {
      // try the next provider
    }
  }
  return { error: 'no-usable-model-route' }
}

/**
 * One judge call: system + user text in, raw text out.
 * Never throws for provider failure; the caller decides what a miss means.
 */
export async function callModel(ctx, route, { system, user, maxTokens, signal, sessionId, purpose = 'judge' }) {
  const llm = ctx.get('llm')
  if (!llm) return { ok: false, error: 'llm-service-unavailable' }
  try {
    const startedAt = Date.now()
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      system,
      maxTokens,
      ...(sessionId ? { sessionId } : {}),
      ...(signal ? { signal } : {}),
    })
    const { text, finish, usage } = await collectStream(stream, signal)
    // Measured usage, so the cost report cites real numbers instead of a
    // character-count estimate. One line per call; the report folds them.
    usageLog().push({
      at: startedAt,
      ms: Date.now() - startedAt,
      purpose,
      provider: route.provider,
      model: route.model,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      cacheReadTokens: usage?.cacheReadTokens,
      systemChars: String(system ?? '').length,
      userChars: String(user ?? '').length,
      replyChars: text.length,
      finishKind: finish?.kind,
      maxTokens,
    })
    // `out` equal to `maxTokens` with an empty reply means the reasoning phase
    // ate the whole output budget — the diagnosis that a bare "unusable reply
    // (0 chars)" line could not give.
    const exhausted = text.length === 0 && usage?.outputTokens >= (maxTokens ?? Infinity) - 1
    log(
      `usage[${purpose}]: in=${usage?.inputTokens ?? '?'} out=${usage?.outputTokens ?? '?'} ` +
      `cache=${usage?.cacheReadTokens ?? 0} | system ${String(system ?? '').length}c user ${String(user ?? '').length}c ` +
      `reply ${text.length}c finish=${finish?.kind ?? '?'} ${Date.now() - startedAt}ms` +
      (exhausted ? ' | 输出预算被推理吃满，无文本产出' : ''),
    )
    if (finish?.kind === 'error') {
      return { ok: false, error: finish.failure?.message ?? 'model error', failure: finish.failure }
    }
    if (finish?.kind === 'aborted') {
      return { ok: false, error: 'aborted', aborted: true }
    }
    return { ok: true, text, usage }
  } catch (error) {
    return { ok: false, error: describe(error) }
  }
}

/**
 * Per-process usage ledger for this plugin's own model calls.
 * Kept in memory: it exists to answer "what does this plugin cost", and a
 * restart is a reasonable boundary for that question.
 */
const usageLedger = []
export function usageLog() {
  return usageLedger
}

/** Human-readable one-liner for an unknown thrown value. */
export function describe(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
