/**
 * The confirmation question.
 *
 * This is the part that turns a guess into data. The question is asked
 * through `ctx.userQuestions.ask`, so it renders as the ordinary structured
 * question card in the Web GUI and its answer comes back as a structured
 * choice — never as text this plugin would have to interpret.
 */
import { describe } from './llm.js'

const AGREE_CHOICES = [
  '一致，按这个标准记录',
  '不一致，我实际的标准不同',
  '不一致，这次我本来就满意',
]

const CHOICE = {
  confirm: 'confirm',
  reject: 'reject',
  notUnhappy: 'not-unhappy',
  unrecognized: 'unrecognized',
}

/** Map the answer card's raw selection onto a plugin decision. */
export function classifyAnswer(answer) {
  const selected = answer?.answers?.[0]?.selected
  const raw = Array.isArray(selected) ? selected[0] : selected
  const choice = typeof raw === 'string' ? raw : ''
  if (choice === AGREE_CHOICES[0]) return { choice: CHOICE.confirm, raw: choice }
  if (choice === AGREE_CHOICES[1]) return { choice: CHOICE.reject, raw: choice }
  if (choice === AGREE_CHOICES[2]) return { choice: CHOICE.notUnhappy, raw: choice }
  return { choice: CHOICE.unrecognized, raw: choice }
}

/**
 * Ask "我的评分和你的感觉一致吗?" for one judgement.
 * @param {{ agent: object, record: object, signal?: AbortSignal }} input
 * @returns {{ asked: boolean, choice?: string, error?: string }}
 */
export async function askAgreement(ctx, { agent, record, signal }) {
  const userQuestions = ctx.get('userQuestions')
  if (!userQuestions) return { asked: false, error: 'user-questions-unavailable' }

  const weakest = [...(record.dimensions ?? [])]
    .sort((a, b) => a.score - b.score)
    .slice(0, 2)
    .map(d => `${d.label} ${d.score}`)
    .join('、')

  try {
    const answer = await userQuestions.ask({
      questions: [{
        id: 'persona-judge-agreement',
        header: '打分核对',
        question:
          `我按「${record.summary || '你的标准'}」给这一轮打了 ${record.overall} 分（及格线 ${record.passScore}）` +
          `${weakest ? `，主要扣分在 ${weakest}` : ''}。我的判断和你自己的感觉一致吗？`,
        options: AGREE_CHOICES.map(label => ({ label })),
      }],
      agent,
      ...(signal ? { signal } : {}),
    })
    return { asked: true, ...classifyAnswer(answer) }
  } catch (error) {
    return { asked: false, error: describe(error) }
  }
}

/** Short line for the agent-facing tool result. */
export function describeRecord(record) {
  const dims = (record.dimensions ?? [])
    .map(d => `${d.label} ${d.score}`)
    .join('  ')
  const issues = (record.issues ?? [])
    .map((issue, index) => `  ${index + 1}. ${issue.what}${issue.fix ? ` → ${issue.fix}` : ''}`)
    .join('\n')
  return [
    `评分 ${record.overall}/100（及格线 ${record.passScore}）— ${record.pass ? '合格' : '不合格'}`,
    dims ? `维度：${dims}` : '',
    record.summary ? `判断：${record.summary}` : '',
    issues ? `扣分点：\n${issues}` : '',
  ].filter(Boolean).join('\n')
}

export { CHOICE, AGREE_CHOICES }
