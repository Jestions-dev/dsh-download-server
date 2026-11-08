import { JobDomain } from './domain.js'
import { Queue } from './queue.js'
import { Transport } from './transport.js'
import { registerTools } from './tools.js'

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
 * Use the host logger when one is available so INFO lines never land on stdout.
 * @param {any} ctx
 */
function makeLog(ctx) {
  try {
    const factory = ctx?.logger
    if (typeof factory === 'function') {
      const logger = factory('dsh-dl-server')
      if (logger && typeof logger.info === 'function') {
        return (level, message) => {
          const fn = logger[level] ?? logger.info
          fn.call(logger, message)
        }
      }
    }
  } catch {
    /* fall through to the console fallback */
  }
  return (level, message) => {
    if (level === 'warn' || level === 'error') console.warn(`[dsh-dl-server] ${message}`)
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Partial<typeof DEFAULTS>} [rawConfig]
 */
export async function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const log = makeLog(ctx)

  const domain = await ctx.storageDomain.open(JobDomain)
  const transport = new Transport(config, log)
  await transport.init()

  const queue = new Queue({ domain, transport, config, log })
  await queue.recover()

  registerTools({ ctx, queue, config })

  ctx.effect(() => async () => {
    await queue.close()
    await transport.dispose()
    await domain.close()
  })

  log('info', `ready (transport: ${transport.mode}, concurrency: ${config.maxConcurrentJobs})`)
}
