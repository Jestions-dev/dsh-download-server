/**
 * DLS data model. Zero dependencies, plain JS.
 *
 * @typedef {'queued'|'running'|'paused'|'completed'|'failed'|'canceled'} JobState
 * @typedef {'user'|'session_closed'|'host_restart'} PauseReason
 *
 * @typedef {object} JobRecord
 * @property {string} id             `J#1042`
 * @property {number} seq            monotonic sequence, matches the number in id
 * @property {string} ownerWorkspace WorkspaceId (uuid)
 * @property {string} ownerSession   SessionId (uuid) of the parent session
 * @property {string} [origin]       subagent name, display and audit only
 * @property {string[]} urls
 * @property {string} destPath
 * @property {JobState} state
 * @property {PauseReason} [pauseReason]
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} bytesTotal     -1 when unknown
 * @property {number} bytesCheckpoint  checkpoint bytes, not live progress
 * @property {number} attempts
 * @property {string} [lastError]
 * @property {string} [expectSha256]
 * @property {number} [finalBytes]
 */

export const JOB_STATES = Object.freeze([
  'queued',
  'running',
  'paused',
  'completed',
  'failed',
  'canceled',
])

const TERMINAL = new Set(['completed', 'failed', 'canceled'])

/** @param {JobState} state */
export function isTerminal(state) {
  return TERMINAL.has(state)
}

/** @param {number} seq */
export function formatJobId(seq) {
  return `J#${seq}`
}

const JOB_ID_RE = /^J#(\d+)$/

/** @param {string} id @returns {number | undefined} */
export function parseJobId(id) {
  const m = JOB_ID_RE.exec(id)
  return m ? Number(m[1]) : undefined
}
