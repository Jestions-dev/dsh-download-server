import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Minimal boot trace. Overwritten every boot, so it always describes the latest
 * start. A support report is "send me %TEMP%/dls-boot.log".
 */
export const BOOT_LOG = path.join(os.tmpdir(), 'dls-boot.log')

let started = false

/** @param {string} step @param {string} [detail] */
export function mark(step, detail) {
  try {
    if (!started) {
      fs.writeFileSync(BOOT_LOG, `dsh-dl-server boot trace\n`)
      started = true
    }
    const line = `${new Date().toISOString()}  ${step}${detail ? `  ${detail}` : ''}`
    fs.appendFileSync(BOOT_LOG, `${line}\n`)
  } catch {
    /* tracing must never break the plugin */
  }
}

/** @param {string} step @param {unknown} error */
export function markFailure(step, error) {
  const stack = error instanceof Error ? (error.stack ?? error.message) : String(error)
  mark(`FAILED at ${step}`, stack.split('\n').slice(0, 6).join(' | '))
}
