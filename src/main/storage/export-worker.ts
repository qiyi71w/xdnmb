import { parentPort } from 'node:worker_threads'
import { readExportEstimate, takeExportSnapshot, trimExportSnapshot, type TrimOptions } from './export-snapshot'

/*
 * Worker entry for 导出个人数据: one request per worker, so the main process stays responsive while
 * SQLite copies and trims (see `./export-snapshot`). Ending the worker stops the work.
 */

export type ExportWorkerRequest =
  | { type: 'estimate'; databasePath: string }
  | { type: 'snapshot'; databasePath: string; workPath: string }
  | { type: 'trim'; workPath: string; options: TrimOptions }

export type ExportWorkerResponse = { ok: true; value: unknown } | { ok: false }

const port = parentPort
if (!port) throw new Error('export snapshot requires a worker parent')

port.once('message', (request: ExportWorkerRequest) => {
  let response: ExportWorkerResponse
  try {
    const value = request.type === 'estimate' ? readExportEstimate(request.databasePath)
      : request.type === 'snapshot' ? takeExportSnapshot(request.databasePath, request.workPath)
      : trimExportSnapshot(request.workPath, request.options)
    response = { ok: true, value }
  } catch {
    response = { ok: false }
  }
  port.postMessage(response)
  port.close()
})
