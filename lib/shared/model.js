/**
 * dsh-persona-judge — shared data shapes and defaults.
 *
 * No I/O and no host imports here: the same module is safe to load from the
 * client half later. Every other file in the plugin builds on these names.
 */

/** Version of the on-disk library format. Bump only with a migration. */
export const LIBRARY_VERSION = 1

/** Directory (under the DSH home) that holds the whole library. */
export const LIBRARY_DIRNAME = 'persona-judge'

/** The five default delivery-quality dimensions (0-100 each). */
export const DEFAULT_DIMENSIONS = [
  {
    id: 'correctness',
    label: '正确性',
    description: '结论、事实、代码是否真实正确，而不是看起来合理。',
    weight: 30,
  },
  {
    id: 'intent',
    label: '诉求对齐',
    description: '是否回答了我实际问的那个问题，而不是相邻的、更好回答的问题。',
    weight: 25,
  },
  {
    id: 'completeness',
    label: '完整度',
    description: '我要求的东西是否全部交付，边界情况与失败路径是否交代。',
    weight: 20,
  },
  {
    id: 'concision',
    label: '简洁度',
    description: '是否省略了不影响结论的过程叙述、重复和自我表扬。',
    weight: 15,
  },
  {
    id: 'style',
    label: '风格贴合',
    description: '语气、措辞、格式是否贴近我平时的表达习惯与偏好。',
    weight: 10,
    // Graded, never injected: style is about how the text reads, and an injected
    // weight would push the agent to write for the rubric instead of the task.
    judgeOnly: true,
  },
]

/** Pass mark when the profile carries no calibrated threshold yet. */
export const DEFAULT_PASS_SCORE = 80

/** Domain name used with ctx.storageDomain when that service is available. */
export const STORAGE_DOMAIN = 'persona-judge'

/** Configuration defaults, mirrored by the Config schema in index.js. */
export const DEFAULT_CONFIG = {
  enabled: true,
  judge: 'turn',
  passScore: DEFAULT_PASS_SCORE,
  askOnPass: true,
  /**
   * When to raise the confirmation card.
   * - 'unsure' (default): only when the judge itself marked the difficulty
   *   "unsure". Asking on every score trains a reflex answer, and a reflex
   *   answer feeds noise into the calibration.
   * - 'always': the previous behaviour.
   */
  askWhen: 'unsure',
  /**
   * Let the judge decide difficulty instead of the cheap deterministic gate.
   * Off by default because it costs a model call — the very call the gate exists
   * to avoid — so it pays off only when near misses are worth adjudicating.
   */
  modelDifficulty: false,
  /**
   * Below this length a turn needs a concrete artifact (path, command, code,
   * number) or several clauses to be worth a verdict. It must stay at or below
   * trivialMaxChars, otherwise the length floor rejects exactly the replies the
   * clause rule was meant to keep — the two settings disagree about "short".
   */
  minTurnLength: 16,
  /**
   * A turn at or above this length is always judged; below it the turn needs a
   * concrete artifact (path, command, code, number) or several clauses to be
   * worth a verdict. Keeps "好的" from costing a model call, a record and a
   * confirmation card.
   */
  trivialMaxChars: 120,
  /**
   * Clauses are an alternative to an artifact, so this must not demand more
   * clauses than a short reply can hold while staying under minTurnLength — a
   * three-clause reply of ~18 characters used to be rejected by the length
   * floor after passing this gate.
   */
  trivialMaxClauses: 2,
  maxTranscriptChars: 6000,
  maxContextMessages: 12,
  historyLimit: 200,
  extractMinMessages: 8,
  excludeShortReplies: true,
  provider: '',
  model: '',
  reasoningEffort: '',
  injectPersona: true,
  injectOrder: -50,
  // Repeat requests inside one turn get a compact pointer instead of the whole
  // block; this adds the portrait's opening words to that pointer.
  compactSummary: true,
  /**
   * Dimensions that are graded but never injected into the agent's self-check.
   *
   * The distinction is deliberate: an injected weight steers how the work is
   * written, while some of the user's standards are about the verdict rather
   * than about the deliverable. Politeness is the case that started this — the
   * user wants it judged, not pursued.
   */
  judgeOnlyDimensions: 'no_fluff',
}

/** Clamp helper shared by every numeric setting. */
export function clamp(value, min, max) {
  if (typeof value !== 'number' || Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** Normalize a partial config into a complete one. */
export function resolveConfig(raw) {
  const merged = { ...DEFAULT_CONFIG, ...(raw ?? {}) }
  merged.passScore = clamp(merged.passScore, 0, 100)
  merged.minTurnLength = clamp(merged.minTurnLength, 0, 100000)
  merged.maxTranscriptChars = clamp(merged.maxTranscriptChars, 500, 200000)
  merged.maxContextMessages = clamp(merged.maxContextMessages, 1, 100)
  merged.historyLimit = clamp(merged.historyLimit, 1, 5000)
  merged.extractMinMessages = clamp(merged.extractMinMessages, 1, 1000)
  if (merged.judge !== 'manual' && merged.judge !== 'turn') merged.judge = 'turn'
  if (merged.askWhen !== 'always' && merged.askWhen !== 'unsure') merged.askWhen = 'unsure'
  // A comma-separated string keeps the setting editable in profile YAML without
  // extending the config schema with array support.
  merged.judgeOnlyDimensions = String(merged.judgeOnlyDimensions ?? '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
  return merged
}

/** An empty library document. */
export function emptyLibrary(now = Date.now()) {
  return {
    version: LIBRARY_VERSION,
    createdAt: now,
    updatedAt: now,
    profile: {
      summary: '',
      traits: [],
      styleRules: [],
      phrases: [],
      candidates: [],
      antiPatterns: [],
      confidence: 'normal',
      confidenceNote: '',
      extractedAt: null,
      sessionsSeen: [],
      messageCount: 0,
    },
    calibration: {
      dimensions: DEFAULT_DIMENSIONS.map(d => ({ ...d })),
      passScore: DEFAULT_PASS_SCORE,
      rounds: 0,
      agreements: 0,
    },
    records: [],
  }
}

/** Stable id for one scored turn. */
export function recordId(sessionId, turn, at) {
  return `${sessionId}#${turn}@${at}`
}
