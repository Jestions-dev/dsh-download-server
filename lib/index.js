import { JobDomain } from './domain.js'
import { isTerminal } from './types.js'

export const name = 'dsh-dl-server'
export const inject = ['tools', 'storageDomain']

const DEFAULTS = Object.freeze({
  maxConcurrentJobs: 3,
  connectionsPerJob: 16,
  aria2Path: '',
  aria2Port: 16801,
  speedLimitKbps: 0,
  proxy: '',
  defaultDownloadDir: '',
  checkpointSeconds: 30,
  autoResumeOnSessionReopen: true,
  autoResumeOnHostRestart: true,
  keepCompletedRecords: 200,
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Partial<typeof DEFAULTS>} [rawConfig]
 */
export async function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }

  const domain = await ctx.storageDomain.open(JobDomain)
  ctx.effect(() => () => void domain.close())

  const jobs = domain.table('jobs')

  ctx.inject(['tools'], (scope) => {
    scope.tools.register({
      name: 'download_status',
      description:
        'List DLS download jobs. Every session can see every job; the owner field shows which session owns each one. ' +
        'Omit id to list all jobs, pass an id such as J#1042 for a single job.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Optional job id such as J#1042. Omit to list every job.',
          },
        },
        additionalProperties: false,
      },
      async execute(args) {
        const all = [...jobs.entries()].map(([, record]) => record)
        const selected = args?.id ? all.filter((row) => row.id === args.id) : all

        return {
          count: selected.length,
          jobs: selected.map((row) => ({
            id: row.id,
            state: row.state,
            pauseReason: row.pauseReason,
            owner: { workspace: row.ownerWorkspace, session: row.ownerSession },
            origin: row.origin,
            dest: row.destPath,
            bytesTotal: row.bytesTotal,
            bytesDone: isTerminal(row.state)
              ? (row.finalBytes ?? row.bytesCheckpoint)
              : row.bytesCheckpoint,
            attempts: row.attempts,
            lastError: row.lastError,
            updatedAt: row.updatedAt,
          })),
        }
      },
    })
  })

  // v0.1 ships the query tool only; the queue engine registers the other six.
  void config
}
