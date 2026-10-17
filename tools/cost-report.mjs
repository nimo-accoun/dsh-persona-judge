/**
 * Measure what the persona judge actually costs per turn.
 *
 * The judge prompt is assembled locally from the library plus the exchange, so
 * its exact size can be rebuilt offline and measured instead of estimated. The
 * injected persona block is measured the same way. Token counts are derived
 * from the account-level ratio observed in .dshw-usage.json
 * (cost ≈ tokens × 2.5e-8 CNY for deepseek-flash).
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { buildJudgePrompt } from '../lib/host/judge.js'
import { createPersonaSection } from '../lib/index.js'
import { resolveConfig } from '../lib/shared/model.js'

const root = process.env.DSH_PERSONA_JUDGE_HOME || path.join(os.homedir(), '.dsh', 'persona-judge')
const library = JSON.parse(fs.readFileSync(path.join(root, 'library.json'), 'utf8'))

/** CJK-heavy text is ~1 token per 1.5 chars; latin ~1 token per 4 chars. */
function estimateTokens(text) {
  const value = String(text ?? '')
  const cjk = (value.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length
  const rest = value.length - cjk
  return Math.round(cjk / 1.5 + rest / 4)
}

const config = resolveConfig({})

// A representative exchange: this session's typical sizes.
const exchange = [
  { role: 'user', text: '清理，有误的数据会污染库' },
  {
    role: 'assistant',
    text: 'x'.repeat(0) + [
      '清理完成。',
      '| 项 | 结果 |',
      '|---|---|',
      '| records | 2 → 0 |',
      '| judgements.jsonl | 2 行 → 0 行 |',
      '| 画像数据 | 完好 |',
      '删除用显式 id 匹配，脚本默认 dry-run，只在显式传 --apply 时写。',
    ].join('\n'),
  },
]

const prompt = buildJudgePrompt({
  profile: library.profile,
  calibration: library.calibration,
  config,
  transcript: exchange,
})

const JUDGE_SYSTEM = 'judge system prompt (the rubric: dimensions, issues, JSON contract)'
// Measured from the source file so the number is not invented.
const judgeSource = fs.readFileSync(new URL('../lib/host/judge.js', import.meta.url), 'utf8')
const systemBlock = judgeSource.match(/const JUDGE_SYSTEM = `([\s\S]*?)`/)?.[1] ?? ''

// The injected section is rendered by the REAL code path, so this report can
// never drift from what the plugin actually injects.
const renderSection = createPersonaSection(
  { data: library, stats: () => ({ records: 0, failed: 0, confirmed: 0, agreed: 0 }) },
  config,
  { compactSummary: config.compactSummary },
)
const section = renderSection({ turn: 1 })
const sectionRepeat = renderSection({ turn: 1 })

const rows = [
  ['判分 system prompt', systemBlock],
  ['判分 user prompt（画像+维度+本轮问答）', prompt],
  ['注入：本轮首条请求', section],
  ['注入：同轮重复请求', sectionRepeat],
]
console.log('=== 实测字符数与估算 token ===')
for (const [label, text] of rows) {
  console.log(`${label.padEnd(34)} ${String(text.length).padStart(6)} chars  ~${String(estimateTokens(text)).padStart(5)} tokens`)
}

const judgeIn = estimateTokens(systemBlock) + estimateTokens(prompt)
console.log(`\n判分调用输入合计  ~${judgeIn} tokens（每轮一次）`)
console.log(`注入首条请求        ~${estimateTokens(section)} tokens`)
console.log(`注入同轮重复        ~${estimateTokens(sectionRepeat)} tokens（每次重复请求）`)

console.log('\n=== 一轮 N 次模型请求的总注入开销 ===')
for (const n of [1, 3, 6, 10]) {
  const now = estimateTokens(section) + estimateTokens(sectionRepeat) * (n - 1)
  const before = 560 * n
  console.log(`  N=${String(n).padStart(2)}  旧 ~${String(before).padStart(5)} → 新 ~${String(now).padStart(4)} tokens` +
    `  (降 ${Math.round((1 - now / before) * 100)}%)`)
}

console.log('\n=== 相对本轮回答的比例（用你这次的量级）===')
const answerChars = 1219 // measured: the answer the judge actually received last run
const answerTokens = Math.round(answerChars / 1.5)
console.log(`被评判的回答         ${answerChars} chars  ~${answerTokens} tokens`)
console.log(`判分输入 / 回答      ${(judgeIn / answerTokens).toFixed(2)}x`)
console.log(`判分输入 + 注入 / 回答 ${((judgeIn + estimateTokens(section)) / answerTokens).toFixed(2)}x`)

console.log('\n=== 账户级基准（.dshw-usage.json）===')
const usage = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', '.dshw-usage.json'), 'utf8'))
const events = usage.events ?? []
console.log(`今日已用 ${usage.todayUsage} CNY，累计事件 ${events.length} 条`)
const perEvent = events.slice(-12).map(e => e.cost / e.tokens)
const avg = perEvent.reduce((a, b) => a + b, 0) / Math.max(1, perEvent.length)
console.log(`最近 12 次事件平均单价 ${avg.toExponential(3)} CNY/token（= ${(avg * 1e6).toFixed(2)} CNY/百万 token）`)
console.log(`判分单轮输入成本 ≈ ${(judgeIn * avg).toFixed(6)} CNY`)
console.log(`判分单轮输出成本 ≈ ${(600 * avg).toFixed(6)} CNY（按 600 输出 token 估）`)
console.log(`每轮注入成本     ≈ ${(estimateTokens(section) * avg).toFixed(6)} CNY × 该轮请求次数`)

// --- measured usage, once the plugin has run and logged some calls --------
console.log('\n=== 实测用量（来自插件自己的 usage 日志）===')
const activationLog = path.join(root, 'activation.log')
let measured = []
if (fs.existsSync(activationLog)) {
  measured = fs
    .readFileSync(activationLog, 'utf8')
    .split('\n')
    .map(l => l.match(/usage\[(\w+)\]: in=(\d+|\?) out=(\d+|\?) cache=(\d+) \| system (\d+)c user (\d+)c reply (\d+)c/))
    .filter(Boolean)
    .map(m => ({
      purpose: m[1],
      input: m[2] === '?' ? null : Number(m[2]),
      output: m[3] === '?' ? null : Number(m[3]),
      cache: Number(m[4]),
      systemChars: Number(m[5]),
      userChars: Number(m[6]),
      replyChars: Number(m[7]),
    }))
}
if (measured.length === 0) {
  console.log('尚无实测记录：跑一次 persona_judge 后再看这里。')
} else {
  const byPurpose = new Map()
  for (const row of measured) {
    const list = byPurpose.get(row.purpose) ?? []
    list.push(row)
    byPurpose.set(row.purpose, list)
  }
  for (const [purpose, rows] of byPurpose) {
    const avgOf = (pick) => {
      const values = rows.map(pick).filter(v => typeof v === 'number')
      return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null
    }
    const input = avgOf(r => r.input)
    const output = avgOf(r => r.output)
    const cache = avgOf(r => r.cache)
    const cost = input === null ? null : ((input + (output ?? 0)) * avg)
    console.log(
      `${purpose.padEnd(9)} n=${String(rows.length).padStart(3)}  ` +
      `in≈${input ?? '?'} out≈${output ?? '?'} cache≈${cache ?? 0}  ` +
      (cost === null ? '' : `成本≈${cost.toFixed(6)} CNY`),
    )
  }
  const totalCost = measured.reduce((sum, r) => sum + ((r.input ?? 0) + (r.output ?? 0)) * avg, 0)
  console.log(`该插件累计（本进程）≈ ${totalCost.toFixed(6)} CNY，共 ${measured.length} 次调用`)
}
