import { parentPort } from 'node:worker_threads'
import { readSecretRows } from './export-snapshot'
import { checkStagedImport, readLocalAppendedBytes, readLocalCounts, stageImport, type ImportFileFacts } from './import-staging'

/*
 * Worker entry for 导入个人数据: one request per worker, so the main process stays responsive while
 * SQLite checks, migrates and merges (see `./import-staging`). Ending the worker stops the work.
 */

export type ImportWorkerRequest =
  | { type: 'check'; stagingDirectory: string; schemaVersion: number }
  | { type: 'counts'; databasePath: string }
  | { type: 'appended-bytes'; databasePath: string }
  | { type: 'secrets'; databasePath: string }
  | { type: 'stage'; stagingDirectory: string; databasePath: string; file: ImportFileFacts }

export type ImportWorkerResponse = { ok: true; value: unknown } | { ok: false }

const port = parentPort
if (!port) throw new Error('import staging requires a worker parent')

port.once('message', (request: ImportWorkerRequest) => {
  let response: ImportWorkerResponse
  try {
    const value = request.type === 'check' ? checkStagedImport(request.stagingDirectory, request.schemaVersion)
      : request.type === 'counts' ? readLocalCounts(request.databasePath)
      : request.type === 'appended-bytes' ? readLocalAppendedBytes(request.databasePath)
      : request.type === 'secrets' ? readSecretRows(request.databasePath)
      : stageImport(request.stagingDirectory, request.databasePath, request.file)
    response = { ok: true, value }
  } catch {
    response = { ok: false }
  }
  port.postMessage(response)
  port.close()
})
