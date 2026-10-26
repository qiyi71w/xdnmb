import { ReadCancelledError } from '../forum/contract'

/**
 * Named forum request lanes. Foreground serves interactive reading; background serves work the user
 * is not waiting on (directory refresh and reminder checks). Background is serialized and its
 * starts are spaced; foreground always has priority and never waits for the background timer.
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

export function createRequestScheduler(options: {
  maxConcurrent?: number
  maxBackground?: number
  backgroundSpacingMs?: number
  monotonicNow?: () => number
  timers?: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>
} = {}): RequestScheduler {
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 2)
  const maxBackground = Math.min(options.maxBackground ?? 1, 1)
  const spacing = Math.max(0, options.backgroundSpacingMs ?? 1000)
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const timers = options.timers ?? globalThis
  const queues: Record<Lane, QueuedJob[]> = { foreground: [], background: [] }
  let running = 0
  let runningBackground = 0
  let lastBackgroundStart = -Infinity
  let wakeup: ReturnType<typeof setTimeout> | undefined

  function next(): QueuedJob | undefined {
    if (running >= maxConcurrent) return undefined
    const fg = queues.foreground.shift()
    if (fg) return fg
    if (runningBackground >= maxBackground) return undefined
    if (queues.background.length > 0) {
      const delay = lastBackgroundStart + spacing - monotonicNow()
      if (delay > 0) {
        wakeup = timers.setTimeout(() => { wakeup = undefined; pump() }, delay)
        return undefined
      }
    }
    return queues.background.shift()
  }

  function pump(): void {
    if (wakeup !== undefined) {
      timers.clearTimeout(wakeup)
      wakeup = undefined
    }
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
          if (lane === 'background') {
            runningBackground++
            lastBackgroundStart = monotonicNow()
          }
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
          signal.removeEventListener('abort', onAbort)
          pump()
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
