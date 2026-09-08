import * as db from '../db'

/**
 * Background body compaction. Rows written before the zstd codec existed (or
 * with any codec that is no longer the default) are re-encoded a small batch
 * at a time on a timer, with the event loop yielded between batches so the
 * main process stays responsive. Nothing is remembered between runs: each
 * batch asks the store for whatever rows still need work, so the job is
 * resumable across restarts and idempotent by construction. It stops itself
 * once a batch finds nothing left.
 *
 * The scheduling lives here; the row rewrite is `db.compactBodiesBatch`. To
 * replace the strategy (idle-time scheduling, a worker thread, ...) swap this
 * module and keep the BackgroundJob shape.
 */

export interface BackgroundJob {
  start(): void
  stop(): void
  status(): JobStatus
}

export interface JobStatus {
  /** Timer armed or a batch in flight */
  running: boolean
  /** Rows still to do (as of the last batch, or the start check) */
  remaining: number
  /** Rows done since start() */
  processed: number
  bytesBefore: number
  bytesAfter: number
  textDerived: number
  /** Set when a batch threw; the job stops on error */
  error: string | null
}

export interface CompactorOptions {
  /** Rows per batch */
  batchSize?: number
  /** Pause between batches */
  intervalMs?: number
  /** Pause before the first batch, so startup work goes first */
  initialDelayMs?: number
  /** Progress line at most this often */
  logEveryMs?: number
  /** Batch runner; defaults to the store's */
  runBatch?: (limit: number) => db.CompactBatch
  countRemaining?: () => number
  log?: (line: string) => void
}

export interface Compactor extends BackgroundJob {
  /** Run one batch now (tests, or a manual nudge); returns what it did */
  runOnce(): db.CompactBatch
  /** Run batches back to back until nothing is left (tests) */
  runToCompletion(): number
}

function mb(bytes: number): string {
  return (bytes / 1_048_576).toFixed(1)
}

export function createCompactor(opts: CompactorOptions = {}): Compactor {
  const batchSize = opts.batchSize ?? 200
  const intervalMs = opts.intervalMs ?? 250
  const initialDelayMs = opts.initialDelayMs ?? 5_000
  const logEveryMs = opts.logEveryMs ?? 5_000
  const runBatch = opts.runBatch ?? db.compactBodiesBatch
  const countRemaining = opts.countRemaining ?? db.countUncompacted
  const log = opts.log ?? ((line: string) => console.log(line))

  let timer: NodeJS.Timeout | null = null
  let lastLog = 0
  const status: JobStatus = {
    running: false,
    remaining: 0,
    processed: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    textDerived: 0,
    error: null
  }

  function record(batch: db.CompactBatch): void {
    status.processed += batch.processed
    status.bytesBefore += batch.bytesBefore
    status.bytesAfter += batch.bytesAfter
    status.textDerived += batch.textDerived
    status.remaining = batch.remaining
  }

  function progress(final: boolean): void {
    const now = Date.now()
    if (!final && now - lastLog < logEveryMs) return
    lastLog = now
    const ratio = status.bytesBefore > 0 ? (status.bytesAfter / status.bytesBefore) * 100 : 0
    log(
      `[compactor] ${final ? 'done: ' : ''}${status.processed} rows, ${status.remaining} left; ` +
        `${mb(status.bytesBefore)} MB → ${mb(status.bytesAfter)} MB (${ratio.toFixed(0)}%)` +
        (status.textDerived > 0 ? `; text derived from HTML for ${status.textDerived}` : '')
    )
  }

  function tick(): void {
    timer = null
    let batch: db.CompactBatch
    try {
      batch = runBatch(batchSize)
    } catch (err) {
      status.error = err instanceof Error ? err.message : String(err)
      status.running = false
      log(`[compactor] stopped on error: ${status.error}`)
      return
    }
    record(batch)
    if (batch.remaining === 0) {
      status.running = false
      progress(true)
      return
    }
    progress(false)
    timer = setTimeout(tick, intervalMs)
  }

  return {
    start(): void {
      if (status.running) return
      status.error = null
      status.remaining = countRemaining()
      if (status.remaining === 0) {
        log('[compactor] nothing to compact')
        return
      }
      status.running = true
      log(`[compactor] ${status.remaining} rows to compact, ${batchSize} per batch`)
      timer = setTimeout(tick, initialDelayMs)
    },
    stop(): void {
      if (timer) clearTimeout(timer)
      timer = null
      status.running = false
    },
    status(): JobStatus {
      return { ...status }
    },
    runOnce(): db.CompactBatch {
      const batch = runBatch(batchSize)
      record(batch)
      return batch
    },
    runToCompletion(): number {
      let total = 0
      for (;;) {
        const batch = runBatch(batchSize)
        record(batch)
        total += batch.processed
        if (batch.remaining === 0 || batch.processed === 0) return total
      }
    }
  }
}

/** The app's compactor over the live store */
export const compactor = createCompactor()
