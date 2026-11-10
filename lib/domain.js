import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const JobRecordSchema = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),

  ownerWorkspace: z.string(),
  ownerSession: z.string(),
  origin: z.string().optional(),

  urls: z.array(z.string()).min(1),
  /** Mirrors derived from the original URL at enqueue time, for diagnostics. */
  mirrors: z
    .array(z.object({ from: z.string(), to: z.string(), rule: z.string() }))
    .optional(),
  destPath: z.string(),

  state: z.enum(['queued', 'running', 'paused', 'completed', 'failed', 'canceled']),
  pauseReason: z.enum(['user', 'session_closed', 'host_restart']).optional(),

  createdAt: z.number(),
  updatedAt: z.number(),

  bytesTotal: z.number(),
  bytesCheckpoint: z.number(),

  attempts: z.number().int().nonnegative(),
  lastError: z.string().optional(),

  expectSha256: z.string().optional(),
  finalBytes: z.number().optional(),
})

/**
 * The persistent queue domain.
 *
 * per-record: one corrupt job must not make the whole queue unreadable.
 * backup-and-skip: move the bad document aside and keep booting.
 * global.nextSeq: the global counter behind J# ids.
 */
export const JobDomain = defineDomain({
  // Domain names must match /^[a-z][a-z0-9_]*$/ — hyphens are rejected at load.
  name: 'dsh_dl_jobs',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    jobs: domainTable(JobRecordSchema),
  },
  global: {
    initial: { nextSeq: 1 },
    schema: z.object({ nextSeq: z.number().int().positive() }),
  },
})
