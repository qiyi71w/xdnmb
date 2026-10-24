import { parentPort, workerData } from 'node:worker_threads'
import type { StorageStatus } from '../../shared/api'
import { StorageWriteRefusedError } from './contract'
import { openReadingDatabase } from './database'
import type { ReadingDatabase } from './database'

export type StorageMethod = Exclude<keyof ReadingDatabase, 'status'>
export type StorageRequest = {
  [Method in StorageMethod]: {
    id: number
    method: Method
    args: Parameters<ReadingDatabase[Method]>
  }
}[StorageMethod]

export type StorageResponse =
  | { type: 'ready'; status: StorageStatus }
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { name: string; message: string; status?: StorageStatus } }

const port = parentPort
if (!port) throw new Error('reading database requires a worker parent')
const data = workerData as { databasePath: string }
const db = openReadingDatabase(data.databasePath)
port.postMessage({ type: 'ready', status: db.status } satisfies StorageResponse)

port.on('message', (request: StorageRequest) => {
  const id = request?.id
  if (!Number.isSafeInteger(id)) return
  try {
    if (!Array.isArray(request.args)) throw new Error('invalid storage request')
    let value: unknown
    switch (request.method) {
      case 'saveDirectory': value = db.saveDirectory(...request.args); break
      case 'loadDirectory': value = db.loadDirectory(...request.args); break
      case 'saveFeedPage': value = db.saveFeedPage(...request.args); break
      case 'loadFeedPage': value = db.loadFeedPage(...request.args); break
      case 'saveThreadPage': value = db.saveThreadPage(...request.args); break
      case 'loadThreadPage': value = db.loadThreadPage(...request.args); break
      case 'getThreadCoverage': value = db.getThreadCoverage(...request.args); break
      case 'listCredentials': value = db.listCredentials(...request.args); break
      case 'loadCredentialCiphertexts': value = db.loadCredentialCiphertexts(...request.args); break
      case 'loadCredentialCiphertext': value = db.loadCredentialCiphertext(...request.args); break
      case 'insertCredential': value = db.insertCredential(...request.args); break
      case 'renameCredential': value = db.renameCredential(...request.args); break
      case 'deleteCredential': value = db.deleteCredential(...request.args); break
      case 'loadRoleSelections': value = db.loadRoleSelections(...request.args); break
      case 'setRoleSelection': value = db.setRoleSelection(...request.args); break
      case 'close': value = db.close(...request.args); break
      default: throw new Error('unknown storage method')
    }
    port.postMessage({ id, ok: true, value } satisfies StorageResponse)
    if (request.method === 'close') port.close()
  } catch (error) {
    const refusal = error instanceof StorageWriteRefusedError
    port.postMessage({
      id,
      ok: false,
      error: {
        name: refusal ? error.name : 'Error',
        message: refusal ? error.message : 'database operation failed',
        ...(refusal ? { status: error.status } : {})
      }
    } satisfies StorageResponse)
    if (request.method === 'close') port.close()
  }
})
