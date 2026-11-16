import type { Worker, WorkerOptions } from 'node:worker_threads'
import type { ExportWorkerRequest, ExportWorkerResponse } from '../storage/export-worker'
import type { ExportDatabase } from './service'

/**
 * `ExportDatabase` on worker threads (`../storage/export-worker`): one worker per request, so a
 * long copy never blocks the main process, and `abort` ends every running one.
 */
export function createWorkerExportDatabase(createWorker: (options: WorkerOptions) => Worker): ExportDatabase {
  const active = new Set<Worker>()

  function request<T>(message: ExportWorkerRequest): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    const worker = createWorker({})
    active.add(worker)
    let answered = false
    worker.once('message', (response: ExportWorkerResponse) => {
      answered = true
      if (response.ok) resolve(response.value as T)
      else reject(new Error('export snapshot failed'))
    })
    worker.once('error', () => reject(new Error('export snapshot failed')))
    worker.once('exit', () => {
      active.delete(worker)
      if (!answered) reject(new Error('export snapshot stopped'))
    })
    worker.postMessage(message)
    return promise
  }

  return {
    estimate: (databasePath) => request({ type: 'estimate', databasePath }),
    snapshot: (databasePath, workPath) => request({ type: 'snapshot', databasePath, workPath }),
    trim: (workPath, options) => request({ type: 'trim', workPath, options }),
    abort() {
      for (const worker of active) void worker.terminate()
    }
  }
}
