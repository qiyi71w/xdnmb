import type { Worker, WorkerOptions } from 'node:worker_threads'
import type { ExportWorkerRequest, ExportWorkerResponse } from '../storage/export-worker'
import type { ImportWorkerRequest, ImportWorkerResponse } from '../storage/import-worker'
import type { ImportDatabase } from './import'
import type { ExportDatabase } from './service'

/**
 * One request per worker, so long SQLite work never blocks the main process; `abort` ends every
 * running one (its promise rejects).
 */
function workerRequests<Request>(createWorker: (options: WorkerOptions) => Worker) {
  const active = new Set<Worker>()
  return {
    request<T>(message: Request): Promise<T> {
      const { promise, resolve, reject } = Promise.withResolvers<T>()
      const worker = createWorker({})
      active.add(worker)
      let answered = false
      worker.once('message', (response: ExportWorkerResponse | ImportWorkerResponse) => {
        answered = true
        if (response.ok) resolve(response.value as T)
        else reject(new Error('worker request failed'))
      })
      worker.once('error', () => reject(new Error('worker request failed')))
      worker.once('exit', () => {
        active.delete(worker)
        if (!answered) reject(new Error('worker request stopped'))
      })
      worker.postMessage(message)
      return promise
    },
    abort() {
      for (const worker of active) void worker.terminate()
    }
  }
}

/** `ExportDatabase` on worker threads (`../storage/export-worker`). */
export function createWorkerExportDatabase(createWorker: (options: WorkerOptions) => Worker): ExportDatabase {
  const { request, abort } = workerRequests<ExportWorkerRequest>(createWorker)
  return {
    estimate: (databasePath) => request({ type: 'estimate', databasePath }),
    snapshot: (databasePath, workPath) => request({ type: 'snapshot', databasePath, workPath }),
    secrets: (databasePath) => request({ type: 'secrets', databasePath }),
    trim: (workPath, options) => request({ type: 'trim', workPath, options }),
    abort
  }
}

/** `ImportDatabase` on worker threads (`../storage/import-worker`). */
export function createWorkerImportDatabase(createWorker: (options: WorkerOptions) => Worker): ImportDatabase {
  const { request, abort } = workerRequests<ImportWorkerRequest>(createWorker)
  return {
    check: (stagingDirectory, schemaVersion) => request({ type: 'check', stagingDirectory, schemaVersion }),
    counts: (databasePath) => request({ type: 'counts', databasePath }),
    secrets: (databasePath) => request({ type: 'secrets', databasePath }),
    stage: (stagingDirectory, databasePath, file) => request({ type: 'stage', stagingDirectory, databasePath, file }),
    abort
  }
}
