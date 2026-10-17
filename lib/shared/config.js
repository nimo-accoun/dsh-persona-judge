/**
 * Config schema without a schema library.
 *
 * The host's own `resolveConfig` (cordis/lib/index.js) does exactly this:
 *
 *   if (!runtime.Config) return config
 *   const result = runtime.Config['~standard'].validate(config)
 *   if ('then' in result) throw new TypeError('Async config validation is not supported')
 *   if (result.issues) throw new ValidationError(result.issues)
 *   return result.value
 *
 * So the only requirement for activation is the Standard Schema interface —
 * and cordis' dependency on `@standard-schema/spec` is types-only, meaning a
 * plugin can satisfy it with plain code and no dependency at all. Exporting a
 * bare object here is what broke the first activation attempt.
 *
 * Activation is not the whole contract. The host also reads every configurable
 * entry as a Schemastery node (@deepseek-ai/dsh-settings): `schema.meta.volatile`
 * decides whether an entry has a live form and `schema.dict[key].meta` is read
 * per field. A schema carrying only `~standard` and `toJSON` crashes that read
 * with "Cannot read properties of undefined (reading 'volatile')", which fails
 * `settings/describe` — and with it the Desktop welcome screen, so the whole
 * app refuses to open. The `type` / `meta` / `dict` surface below is therefore
 * part of the contract: the same field table, described the way the host looks
 * at it.
 */

const VERSION = 1

/** One field: coerce, clamp, and reject with a message instead of throwing. */
function coerce(key, spec, raw) {
  const value = raw === undefined || raw === null ? spec.default : raw
  switch (spec.type) {
    case 'boolean':
      return { value: Boolean(value) }
    case 'number': {
      const numeric = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(numeric)) return { issue: `${key} 必须是数字` }
      if (spec.min !== undefined && numeric < spec.min) return { value: spec.min }
      if (spec.max !== undefined && numeric > spec.max) return { value: spec.max }
      return { value: numeric }
    }
    case 'string': {
      const text = String(value)
      if (spec.enum && !spec.enum.includes(text)) {
        return { issue: `${key} 只能是 ${spec.enum.join(' / ')}` }
      }
      return { value: text }
    }
    default:
      return { value }
  }
}

/**
 * Build a Standard Schema + Standard JSON Schema config definition.
 * @param {{ fields: Record<string, object>, description?: string }} definition
 */
export function defineConfig(definition) {
  const fields = definition.fields

  const jsonSchema = {
    type: 'object',
    additionalProperties: false,
    description: definition.description,
    properties: Object.fromEntries(
      Object.entries(fields).map(([key, spec]) => {
        const node = { type: spec.type, description: spec.description }
        if (spec.default !== undefined) node.default = spec.default
        if (spec.enum) node.enum = [...spec.enum]
        if (spec.min !== undefined) node.minimum = spec.min
        if (spec.max !== undefined) node.maximum = spec.max
        return [key, node]
      }),
    ),
  }

  const standard = {
    version: VERSION,
    vendor: 'dsh-persona-judge',
    jsonSchema,
    validate(input) {
      const source = input && typeof input === 'object' ? input : {}
      const value = {}
      const issues = []
      for (const [key, spec] of Object.entries(fields)) {
        const result = coerce(key, spec, source[key])
        if (result.issue) issues.push({ message: result.issue, path: [key] })
        else value[key] = result.value
      }
      if (issues.length > 0) return { issues }
      return { value }
    },
  }

  return {
    '~standard': standard,
    toJSON: () => jsonSchema,
    type: 'object',
    meta: { volatile: false },
    dict: Object.fromEntries(
      Object.entries(fields).map(([key, spec]) => [key, fieldNode(spec)]),
    ),
  }
}

/** One field as the Schemastery node the host inspects. No field is volatile: they are read from the profile patch, not from a live settings form. */
function fieldNode(spec) {
  const meta = { volatile: false }
  if (spec.default !== undefined) meta.default = spec.default
  if (spec.description) meta.description = spec.description
  if (spec.min !== undefined) meta.min = spec.min
  if (spec.max !== undefined) meta.max = spec.max
  return { type: spec.type, meta }
}

/** The plugin's own settings surface. */
export const ConfigDefinition = defineConfig({
  description: '按用户本人的标准给每一轮交付打分，并把确认过的判断沉淀为校准数据。',
  fields: {
    enabled: {
      type: 'boolean',
      default: true,
      description: '总开关。关闭后插件完全不挂载（无工具、无监听、无提示词注入）。',
    },
    judge: {
      type: 'string',
      enum: ['turn', 'manual'],
      default: 'turn',
      description: 'turn：每轮结束自动打分；manual：只用工具手动打分。',
    },
    askOnPass: {
      type: 'boolean',
      default: true,
      description: '是否允许弹出「我的判断和你一致吗」的核对问题。',
    },
    askWhen: {
      type: 'string',
      enum: ['unsure', 'always'],
      default: 'unsure',
      description: '何时弹核对：unsure 只在裁判拿不准时弹；always 每次都弹。',
    },
    modelDifficulty: {
      type: 'boolean',
      default: false,
      description: '是否让裁判自己判断难度（多一次模型调用）；关闭时用免费的确定性关卡。',
    },
    passScore: {
      type: 'number',
      min: 0,
      max: 100,
      default: 80,
      description: '未校准时使用的及格线。',
    },
    minTurnLength: {
      type: 'number',
      min: 0,
      max: 100000,
      default: 16,
      description: '低于此长度且不含具体产物（路径/命令/代码/数字）时不评分；含具体产物的短交付照常评分。须不高于 trivialMaxChars。',
    },
    trivialMaxChars: {
      type: 'number',
      min: 0,
      max: 100000,
      default: 120,
      description: '低于此长度的交付必须含具体产物（路径/命令/代码/数字）才评分；高于此长度一律评分。',
    },
    trivialMaxClauses: {
      type: 'number',
      min: 1,
      max: 50,
      default: 2,
      description: '低于 trivialMaxChars 时，至少这么多分句才算值得评分；须与 minTurnLength 相容。',
    },
    maxTranscriptChars: {
      type: 'number',
      min: 500,
      max: 200000,
      default: 6000,
      description: '单次判分提示词的字符上限，超出取头尾。',
    },
    maxContextMessages: {
      type: 'number',
      min: 1,
      max: 100,
      default: 12,
      description: '送入判分的最近消息条数。',
    },
    historyLimit: {
      type: 'number',
      min: 1,
      max: 5000,
      default: 200,
      description: 'library.json 中保留的评分记录条数。',
    },
    extractMinMessages: {
      type: 'number',
      min: 1,
      max: 1000,
      default: 8,
      description: '少于这么多条用户消息就拒绝提取人格。',
    },
    provider: {
      type: 'string',
      default: '',
      description: '判分模型 provider，留空自动回退到本会话正在使用的模型。',
    },
    model: {
      type: 'string',
      default: '',
      description: '判分模型 id，留空自动回退。',
    },
    reasoningEffort: {
      type: 'string',
      default: '',
      description: '判分调用的推理档位，留空用模型默认。',
    },
    injectPersona: {
      type: 'boolean',
      default: true,
      description: '是否把画像与自检标准注入系统提示词。',
    },
    injectOrder: {
      type: 'number',
      min: -1000,
      max: 1000,
      default: -50,
      description: '注入段落的排序，越小越靠前。',
    },
    compactSummary: {
      type: 'boolean',
      default: true,
      description: '同一轮内的后续请求改用精简画像以省 token；此开关决定精简版是否带上画像开头几个字。',
    },
    judgeOnlyDimensions: {
      type: 'string',
      default: 'no_fluff',
      description: '判分专用维度 id，逗号分隔：会计分但不注入自检标准（例如"无客套"——你要的是判它，不是追它）。',
    },
    autoExtractOnFirstTurn: {
      type: 'boolean',
      default: false,
      description: '启动时自动做一次冷启动提取与校准。',
    },
  },
})
