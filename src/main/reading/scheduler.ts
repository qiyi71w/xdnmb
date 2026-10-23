import { ReadCancelledError } from '../forum/contract'

/**
 * Named forum request lanes. Foreground serves interactive reading; background serves work the user
 * is not waiting on (directory refresh now, catch-up/sync later). Background never occupies more
 * than `maxBackground` slots, so a foreground read always has a slot or is next in line.
 */
export type Lane = 'foreground' | 'background'

export interface RequestScheduler {
  /**
   * Runs one forum request when a slot is free. Rejects with ReadCancelledError if `signal` aborts
   * while queued; once started, `work` receives the same signal and owns abort handling.
   */
  run<T>(lane: Lane, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T>
}

interface QueuedJob {
  lane: Lane
  start: () => void
  cancel: () => void
}

export function createRequestScheduler(options: { maxConcurrent?: number; maxBackground?: number } = {}): RequestScheduler {
  const maxConcurrent = options.maxConcurrent ?? 2
  const maxBackground = Math.min(options.maxBackground ?? 1, maxConcurrent - 1)
  const queues: Record<Lane, QueuedJob[]> = { foreground: [], background: [] }
  let running = 0
  let runningBackground = 0

  function next(): QueuedJob | undefined {
    if (running >= maxConcurrent) return undefined
    const fg = queues.foreground.shift()
    if (fg) return fg
    if (runningBackground >= maxBackground) return undefined
    return queues.background.shift()
  }

  function pump(): void {
    for (let job = next(); job; job = next()) job.start()
  }

  return {
    run<T>(lane: Lane, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (signal.aborted) return Promise.reject(new ReadCancelledError())
      const { promise, resolve, reject } = Promise.withResolvers<T>()
      const job: QueuedJob = {
        lane,
        start: () => {
          signal.removeEventListener('abort', onAbort)
          running++
          if (lane === 'background') runningBackground++
          work(signal)
            .then(resolve, reject)
            .finally(() => {
              running--
              if (lane === 'background') runningBackground--
              pump()
            })
        },
        cancel: () => {
          const queue = queues[lane]
          const index = queue.indexOf(job)
          if (index >= 0) queue.splice(index, 1)
          reject(new ReadCancelledError())
        }
      }
      const onAbort = (): void => job.cancel()
      signal.addEventListener('abort', onAbort, { once: true })
      queues[lane].push(job)
      pump()
      return promise
    }
  }
}
