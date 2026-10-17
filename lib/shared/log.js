/**
 * File-backed diagnostics.
 *
 * A failed activation is reported by the host only as `fiberPhase: failed`;
 * the message itself dies with the fiber and is not visible from outside the
 * process. Writing our own lines to a file is the only way to see what the
 * plugin actually did before it failed. Kept deliberately tiny: one append
 * per event, never on a hot path.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const LOG_FILE = path.join(os.homedir(), '.dsh', 'persona-judge', 'activation.log')

/** Append one line, swallowing every failure (logging must never throw). */
export function log(message) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    // a missing or unwritable log directory is not worth failing over
  }
}

/** Log and rethrow: keeps the original stack while leaving evidence behind. */
export function logFatal(stage, error) {
  log(`FATAL ${stage}: ${error?.stack ?? error}`)
  throw error
}
