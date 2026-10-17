/**
 * Remove specific bad judgement records from the persona library.
 *
 * The judgement itself is the only durable evidence of a score, so a record
 * written by a known-broken code path (a judge fed tool fragments, or the
 * model's private reasoning) must not stay in the library: every later report
 * and calibration pass reads it as data.
 *
 * Targets are matched explicitly and nothing else is touched. The append-only
 * ledger is filtered with the same rule so the two files agree.
 *
 * Usage: node tools/purge-records.mjs <id> [<id> ...]        (dry run by default)
 *        node tools/purge-records.mjs --apply <id> [<id> ...]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const ids = args.filter(a => a !== '--apply')

const root = process.env.DSH_PERSONA_JUDGE_HOME || path.join(os.homedir(), '.dsh', 'persona-judge')
const libraryFile = path.join(root, 'library.json')
const auditFile = path.join(root, 'judgements.jsonl')

const doc = JSON.parse(fs.readFileSync(libraryFile, 'utf8'))
const records = Array.isArray(doc.records) ? doc.records : []

console.log(`library: ${libraryFile}`)
console.log(`records: ${records.length}`)
console.log('--- current records ---')
for (const r of records) {
  console.log(
    `  ${r.id}\n    overall=${r.overall} pass=${r.pass} line=${r.passScore} ` +
    `confirmed=${r.confirmed === undefined ? 'unconfirmed' : r.confirmed}\n` +
    `    question="${String(r.excerpt ?? '').slice(0, 60)}"`,
  )
}

if (ids.length === 0) {
  console.log('\nNo ids given: dry run only. Pass ids (and --apply) to remove.')
  process.exit(0)
}

const doomed = records.filter(r => ids.includes(r.id))
const unknown = ids.filter(id => !records.some(r => r.id === id))
if (unknown.length > 0) {
  console.log(`\nREFUSING: ids not present in the library: ${unknown.join(', ')}`)
  process.exit(1)
}
if (doomed.length !== ids.length) {
  console.log(`\nREFUSING: matched ${doomed.length} of ${ids.length} requested ids`)
  process.exit(1)
}

console.log(`\n--- to remove (${doomed.length}) ---`)
for (const r of doomed) console.log(`  ${r.id} overall=${r.overall}`)

if (!apply) {
  console.log('\nDry run. Re-run with --apply to write.')
  process.exit(0)
}

// 1. library.json: drop exactly those records, rewrite atomically
const kept = records.filter(r => !ids.includes(r.id))
doc.records = kept
doc.updatedAt = Date.now()
const tmp = `${libraryFile}.purge.tmp`
fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
fs.renameSync(tmp, libraryFile)
console.log(`\nlibrary.json: ${records.length} -> ${kept.length} records`)

// 2. judgements.jsonl: same rule, so the ledger cannot resurrect them
if (fs.existsSync(auditFile)) {
  const lines = fs.readFileSync(auditFile, 'utf8').split('\n').filter(l => l.trim() !== '')
  const before = lines.length
  const survivors = lines.filter((line) => {
    try {
      const entry = JSON.parse(line)
      return !(typeof entry.id === 'string' && ids.includes(entry.id))
    } catch {
      return true // never drop a line we cannot parse
    }
  })
  const auditTmp = `${auditFile}.purge.tmp`
  fs.writeFileSync(auditTmp, survivors.length ? `${survivors.join('\n')}\n` : '', 'utf8')
  fs.renameSync(auditTmp, auditFile)
  console.log(`judgements.jsonl: ${before} -> ${survivors.length} lines`)
} else {
  console.log('judgements.jsonl: absent, nothing to filter')
}

// 3. verify by reloading
const check = JSON.parse(fs.readFileSync(libraryFile, 'utf8'))
console.log(`verify: ${check.records.length} records remain, purged ids present = ` +
  `${check.records.some(r => ids.includes(r.id))}`)
