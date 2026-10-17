/**
 * On-disk persona library.
 *
 * One JSON document per DSH home, written atomically: the whole library is
 * small (a few hundred records at most), so a single file avoids a schema
 * migration surface while `records` stays bounded by `historyLimit`.
 *
 * Everything here is plain fs — the plugin must work on a host that has no
 * storage service at all.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { LIBRARY_VERSION, LIBRARY_DIRNAME, emptyLibrary } from '../shared/model.js'

/** Root directory of the library for one process. */
export function libraryRoot() {
  const override = process.env.DSH_PERSONA_JUDGE_HOME
  if (typeof override === 'string' && override.trim() !== '') return override
  return path.join(os.homedir(), '.dsh', LIBRARY_DIRNAME)
}

/** Normalize a possibly partial document into a complete one. */
function normalize(raw) {
  const base = emptyLibrary()
  if (!raw || typeof raw !== 'object') return base
  const doc = { ...base, ...raw }
  doc.version = LIBRARY_VERSION
  doc.profile = { ...base.profile, ...(raw.profile ?? {}) }
  doc.calibration = { ...base.calibration, ...(raw.calibration ?? {}) }
  if (!Array.isArray(doc.calibration.dimensions) || doc.calibration.dimensions.length === 0) {
    doc.calibration.dimensions = base.calibration.dimensions
  }
  if (!Array.isArray(doc.records)) doc.records = []
  return doc
}

/**
 * A single-instance library handle. Reads once, then serves memory; every
 * mutation writes through so a crash never loses an accepted judgement.
 */
export class PersonaLibrary {
  constructor(root = libraryRoot()) {
    this.root = root
    this.file = path.join(root, 'library.json')
    this.auditFile = path.join(root, 'judgements.jsonl')
    this.doc = null
    this.writeQueue = Promise.resolve()
  }

  /** Load from disk (idempotent). */
  async load() {
    if (this.doc) return this.doc
    await fs.promises.mkdir(this.root, { recursive: true })
    let parsed
    try {
      parsed = JSON.parse(await fs.promises.readFile(this.file, 'utf8'))
    } catch {
      parsed = undefined
    }
    this.doc = normalize(parsed)
    if (parsed === undefined) await this.persist()
    return this.doc
  }

  /** Current document (loads synchronously-shaped lazily by callers). */
  get data() {
    return this.doc ?? emptyLibrary()
  }

  /** Serialize writes so concurrent turns cannot interleave a rename. */
  persist() {
    const snapshot = JSON.stringify(this.doc, null, 2)
    this.writeQueue = this.writeQueue.then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`
      await fs.promises.writeFile(tmp, snapshot, 'utf8')
      await fs.promises.rename(tmp, this.file)
    }).catch((error) => {
      console.error('[persona-judge] library write failed:', error)
    })
    return this.writeQueue
  }

  /** Append-only judgement ledger: survives library trimming. */
  appendAudit(entry) {
    const line = `${JSON.stringify(entry)}\n`
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.promises.appendFile(this.auditFile, line, 'utf8')
    }).catch((error) => {
      console.error('[persona-judge] audit append failed:', error)
    })
    return this.writeQueue
  }

  /** Replace the persona profile produced by one extraction round. */
  async setProfile(profile, meta = {}) {
    await this.load()
    this.doc.profile = {
      ...this.doc.profile,
      summary: String(profile.summary ?? ''),
      traits: asStringList(profile.traits),
      styleRules: asStringList(profile.styleRules),
      phrases: normalizePhrases(profile.phrases),
      antiPatterns: asStringList(profile.antiPatterns),
      // Counted phrase candidates, kept even when the model confirmed none, so
      // the report can disclose them as unverified instead of reporting nothing.
      candidates: normalizePhrases(meta.candidates ?? this.doc.profile.candidates ?? []),
      // How much clean material backed this profile; the injected block and
      // the report both disclose it instead of implying certainty.
      confidence: typeof meta.confidence === 'string' ? meta.confidence : (this.doc.profile.confidence ?? 'normal'),
      confidenceNote: typeof meta.confidenceNote === 'string' ? meta.confidenceNote : (this.doc.profile.confidenceNote ?? ''),
      extractedAt: Date.now(),
      sessionsSeen: uniqueStrings([
        ...(this.doc.profile.sessionsSeen ?? []),
        ...(meta.sessionsSeen ?? []),
      ]).slice(-50),
      messageCount: (this.doc.profile.messageCount ?? 0) + (meta.messageCount ?? 0),
    }
    this.doc.updatedAt = Date.now()
    await this.persist()
    return this.doc.profile
  }

  /** Adopt a calibrated dimension set and pass line. */
  async setCalibration({ dimensions, passScore, judgeOnly = [] }) {
    await this.load()
    if (Array.isArray(dimensions) && dimensions.length > 0) {
      // A re-calibration returns dimensions the model just wrote, with no memory
      // of which ones are judge-only. That flag is the user's standing decision
      // about their own rubric, so it is restored from the configured list (and
      // from the previous set) rather than lost on every re-calibration.
      // Accepts an array or the comma-separated form the config field uses, so a
      // caller passing the raw default cannot silently end up with no list.
      const configured = new Set(
        (Array.isArray(judgeOnly) ? judgeOnly : String(judgeOnly ?? '').split(','))
          .map(v => String(v).trim())
          .filter(Boolean),
      )
      const previous = new Map(this.doc.calibration.dimensions.map(d => [d.id, d]))
      this.doc.calibration.dimensions = dimensions.map(d => {
        const id = String(d.id)
        const before = previous.get(id)
        // Priority matters: the configured list is the user's standing decision
        // about their own rubric, so it wins. An explicit `judgeOnly: false` on
        // an incoming dimension (which is what re-adopting the stored set looks
        // like) must not be able to short-circuit it — that bug silently turned
        // the flag back off.
        const flagged = configured.has(id)
          ? true
          : (d.judgeOnly === true || before?.judgeOnly === true)
        return {
          id,
          label: String(d.label ?? d.id),
          description: String(d.description ?? ''),
          weight: Number(d.weight) || 0,
          judgeOnly: flagged,
        }
      })
    }
    if (Number.isFinite(Number(passScore))) {
      this.doc.calibration.passScore = Math.round(Math.max(0, Math.min(100, Number(passScore))))
    }
    this.doc.updatedAt = Date.now()
    await this.persist()
    return this.doc.calibration
  }

  /** Remember the most recent pass line without rewriting dimensions. */
  async setPassScore(value) {
    await this.load()
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return this.doc.calibration.passScore
    this.doc.calibration.passScore = Math.round(Math.max(0, Math.min(100, numeric)))
    await this.persist()
    return this.doc.calibration.passScore
  }

  /** Push one scored turn, trimming to `historyLimit`. */
  async addRecord(record, historyLimit = 200) {
    await this.load()
    this.doc.records.push(record)
    if (this.doc.records.length > historyLimit) {
      this.doc.records.splice(0, this.doc.records.length - historyLimit)
    }
    this.doc.updatedAt = Date.now()
    await this.persist()
    await this.appendAudit({ kind: 'score', ...record })
    return record
  }

  /** Record the user's answer to "was my guess right?" and update weights. */
  async applyFeedback(recordId, agrees, note) {
    await this.load()
    const record = this.doc.records.find(r => r.id === recordId)
    if (!record) return { ok: false, reason: 'record-not-found' }
    if (record.confirmed !== undefined) {
      return { ok: false, reason: 'already-confirmed', record }
    }
    record.confirmed = agrees === true
    if (typeof note === 'string' && note.trim() !== '') record.feedbackNote = note.trim()
    record.confirmedAt = Date.now()

    if (agrees === true) {
      // The judge guessed the user's own standard: reinforce what actually
      // decided the verdict. The old rule bumped every dimension by a fixed
      // step, so all five drifted together and nothing was learned — the point
      // is which dimension was furthest from the pass line, not that a round
      // happened.
      const cal = this.doc.calibration
      cal.rounds += 1
      cal.agreements += 1
      const scored = (record.dimensions ?? []).filter(d => typeof d.score === 'number')
      if (scored.length > 0) {
        const passLine = Number(cal.passScore) || 80
        // The dimension that cost the most: the one whose score sat furthest
        // BELOW the pass line. An earlier draft reduced over the absolute
        // distance, which selected the dimension that had scored best — the
        // opposite of finding what to care about.
        const decisive = scored.reduce((worst, d) =>
          (passLine - d.score) > (passLine - worst.score) ? d : worst)
        const target = cal.dimensions.find(d => d.id === decisive.id)
        if (target && decisive.score < passLine) {
          const shortfall = passLine - decisive.score
          // A near-miss is the informative case: it says this dimension sits
          // right where the standard bites.
          const delta = shortfall <= 10 ? 1 : 0.25
          const before = Number(target.weight) || 0
          target.weight = round1(Math.min(50, before + delta))
          const gained = round1(target.weight - before)
          // The gain is taken from the others, not conjured: bumping one weight
          // and renormalizing otherwise SHRINKS it (measured 25 -> 24.9), because
          // the untouched dimensions keep their share of a smaller total.
          if (gained > 0) {
            const others = cal.dimensions.filter(d => d !== target)
            const otherTotal = others.reduce((sum, d) => sum + (Number(d.weight) || 0), 0)
            if (otherTotal > gained) {
              for (const d of others) {
                d.weight = round1((Number(d.weight) || 0) - gained * ((Number(d.weight) || 0) / otherTotal))
              }
            }
          }
        }
      }
      this.normalizeWeights()
    } else if (agrees === false) {
      // An explicit disagreement is data too, but it must not move a weight in
      // an unknown direction: count the round and leave the profile alone.
      this.doc.calibration.rounds += 1
    }

    this.doc.updatedAt = Date.now()
    await this.persist()
    await this.appendAudit({
      kind: 'feedback',
      id: recordId,
      agrees: agrees === true,
      note: record.feedbackNote,
      at: record.confirmedAt,
    })
    return { ok: true, record }
  }

  /** Renormalize dimension weights to sum to 100. */
  normalizeWeights() {
    const dimensions = this.doc.calibration.dimensions
    const total = dimensions.reduce((sum, d) => sum + (Number(d.weight) || 0), 0)
    if (total <= 0) return
    for (const d of dimensions) d.weight = round1(((Number(d.weight) || 0) / total) * 100)
  }

  /** Compact stats for tools and the injected prompt. */
  stats() {
    const records = this.doc?.records ?? []
    const confirmed = records.filter(r => r.confirmed !== undefined)
    const agreed = confirmed.filter(r => r.confirmed === true)
    const failed = records.filter(r => r.pass === false)
    return {
      records: records.length,
      confirmed: confirmed.length,
      agreed: agreed.length,
      agreementRate: confirmed.length === 0 ? null : round2(agreed.length / confirmed.length),
      failed: failed.length,
      lastAt: records.length === 0 ? null : records[records.length - 1].at,
      extractedAt: this.doc?.profile?.extractedAt ?? null,
      dimensions: (this.doc?.calibration?.dimensions ?? []).map(d => ({
        id: d.id,
        label: d.label,
        weight: d.weight,
      })),
      passScore: this.doc?.calibration?.passScore ?? 80,
    }
  }
}

function asStringList(value) {
  if (!Array.isArray(value)) return []
  return uniqueStrings(value.map(v => String(v ?? '').trim()).filter(Boolean))
}

function normalizePhrases(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      const phrase = entry.trim()
      if (phrase) out.push({ phrase, count: 0, note: '' })
      continue
    }
    if (entry && typeof entry === 'object' && typeof entry.phrase === 'string') {
      const phrase = entry.phrase.trim()
      if (!phrase) continue
      out.push({
        phrase,
        count: Number(entry.count) || 0,
        note: typeof entry.note === 'string' ? entry.note : '',
      })
    }
  }
  return out.slice(0, 60)
}

function uniqueStrings(values) {
  return [...new Set(values)]
}

function round1(n) {
  return Math.round(n * 10) / 10
}

function round2(n) {
  return Math.round(n * 100) / 100
}
