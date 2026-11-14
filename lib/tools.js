import { CLEANUP_SCOPES, DEFAULT_SCOPE, QueueError } from './queue.js'
import { mark, markFailure } from './bootlog.js'

/**
 * Turn a domain-level failure into a canonical value instead of an exception.
 * Only unexpected failures propagate as errors.
 * @param {unknown} error
 */
function fail(error) {
  if (error instanceof QueueError) {
    return { ok: false, code: error.code, message: error.message }
  }
  throw error
}

/**
 * Every DLS tool returns one canonical JSON object.
 * `ToolDefinition.output` is mandatory and its `render` is mandatory too, so the
 * shape lives here instead of being repeated seven times.
 */
const CANONICAL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

/**
 * Best-effort caller identity. DSH's tool execution context is the only source;
 * when a field is missing we fall back to a stable placeholder so the queue
 * still behaves sanely in a single-session profile.
 * @param {any} exec
 */
export function resolveCaller(exec) {
  const agent = exec?.agent
  const session =
    agent?.sessionId ?? agent?.session?.id ?? exec?.session?.id ?? exec?.sessionId ?? 'local'
  const workspace =
    agent?.workspaceId ?? agent?.workspace?.id ?? exec?.workspaceId ?? 'local'
  return { workspace: String(workspace), session: String(session) }
}

/**
 * Register the seven DLS tools.
 *
 * @param {object} deps
 * @param {any} deps.ctx
 * @param {import('./queue.js').Queue} deps.queue
 * @param {object} deps.config
 */
export function registerTools({ ctx, queue, config }) {
  mark('registerTools enter')

  ctx.inject(['tools'], (scope) => {
    try {
      mark('tools inject fired', `hasTools=${typeof scope?.tools?.register === 'function'}`)
      const tools = scope.tools
      const withCaller = (exec) => resolveCaller(exec)

      tools.register({
        name: 'download_enqueue',
        output: CANONICAL_OUTPUT,
        description:
          'Queue a file for download without blocking. Returns a job id such as J#1042 immediately; ' +
          'use download_wait or download_status to follow it. The job survives the turn, the session and ' +
          'a DSH restart. Every session can see every job, but only the owning session can pause, resume ' +
          'or cancel an in-flight one.',
        parameters: {
          type: 'object',
          properties: {
            urls: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: 'Candidate HTTP(S) URLs, tried in order. The first that answers wins.',
            },
            dest: {
              type: 'string',
              description: 'Absolute destination path including the file name.',
            },
            sha256: {
              type: 'string',
              description: 'Optional expected SHA-256. The job fails if the finished file does not match.',
            },
            headers: {
              type: 'object',
              description:
                'Optional HTTP request headers sent with every attempt, including mirror probes and ' +
                'resumes. Use this for CDNs that refuse a bare request — Bilibili media needs ' +
                '{"Referer": "https://www.bilibili.com"}, some hosts want a Cookie or User-Agent. ' +
                'Range, Host, Content-Length and similar transport headers cannot be set. ' +
                'Values are stored locally but never echoed back: job output lists header names only.',
              additionalProperties: { type: 'string' },
            },
          },
          required: ['urls', 'dest'],
          additionalProperties: false,
        },
        async execute(args, exec) {
          try {
            const job = await queue.enqueue(
              {
                urls: args.urls,
                destPath: args.dest,
                expectSha256: args.sha256,
                headers: args.headers,
              },
              withCaller(exec),
            )
            return {
              ok: true,
              jobId: job.id,
              state: job.state,
              dest: job.dest,
              ...(job.deduplicated ? { deduplicated: true } : {}),
            }
          } catch (error) {
            return fail(error)
          }
        },
      })

      tools.register({
        name: 'download_status',
        output: CANONICAL_OUTPUT,
        description:
          'List DLS jobs. Every session sees every job; the owner field shows which session owns each one. ' +
          'Omit id to list all jobs, pass an id such as J#1042 for a single job.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Optional job id. Omit to list every job.' },
          },
          additionalProperties: false,
        },
        async execute(args) {
          const health = queue.health()
          if (args?.id) {
            const job = queue.get(args.id)
            return job
              ? { ok: true, count: 1, jobs: [job], ...health }
              : { ok: false, code: 'not-found', message: `${args.id} does not exist` }
          }
          const jobs = queue.list()
          return { ok: true, count: jobs.length, jobs, ...health }
        },
      })

      tools.register({
        name: 'download_wait',
        output: CANONICAL_OUTPUT,
        description:
          'Block until a job reaches a terminal state (completed / failed / canceled) or the timeout expires. ' +
          'Returns the current job view either way; check state to tell which happened.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Job id such as J#1042.' },
            timeoutSeconds: {
              type: 'number',
              description: 'How long to wait. Default 60, maximum 600.',
            },
          },
          required: ['id'],
          additionalProperties: false,
        },
        async execute(args) {
          const seconds = Math.min(Math.max(Number(args.timeoutSeconds ?? 60), 1), 600)
          try {
            const job = await queue.wait(args.id, seconds * 1000)
            return { ok: true, job }
          } catch (error) {
            return fail(error)
          }
        },
      })

      for (const [toolName, method, verb] of [
        ['download_pause', 'pause', 'Pause'],
        ['download_resume', 'resume', 'Resume'],
        ['download_cancel', 'cancel', 'Cancel'],
      ]) {
        tools.register({
          name: toolName,
          output: CANONICAL_OUTPUT,
          description:
            `${verb} a DLS job. Only the session that enqueued the job may do this while it is in flight; ` +
            'finished jobs are open to everyone. A paused job keeps its partial file and can resume later.',
          parameters: {
            type: 'object',
            properties: { id: { type: 'string', description: 'Job id such as J#1042.' } },
            required: ['id'],
            additionalProperties: false,
          },
          async execute(args, exec) {
            try {
              const job = await queue[method](args.id, withCaller(exec))
              return { ok: true, job }
            } catch (error) {
              return fail(error)
            }
          },
        })
      }

      tools.register({
        name: 'download_cleanup',
        output: CANONICAL_OUTPUT,
        description:
          'Clean up the calling session\'s DLS records and leftovers. Default scope "allWithoutFiles" removes ' +
          'finished records and partial files but never touches the downloaded files themselves. Passing "all" ' +
          'also deletes those files and cannot be undone.',
        parameters: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              enum: CLEANUP_SCOPES,
              description: `Default ${DEFAULT_SCOPE}. "all" is the only value that deletes downloaded files.`,
            },
          },
          additionalProperties: false,
        },
        async execute(args, exec) {
          try {
            const result = await queue.cleanup(args?.scope ?? DEFAULT_SCOPE, withCaller(exec))
            return { ok: true, ...result }
          } catch (error) {
            return fail(error)
          }
        },
      })

      mark('tools registered', '7/7')
    } catch (error) {
      markFailure('registerTools', error)
      throw error
    }
  })
}
