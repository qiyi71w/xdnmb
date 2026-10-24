import type { Worker, WorkerOptions } from 'node:worker_threads'
import type { StorageStatus } from '../../shared/api'
import type { ReadingMode, ThreadId } from '../../shared/forum'
import { DEFAULT_SETTINGS } from '../../shared/reading'
import { StorageWriteRefusedError } from './contract'
import type { AppStore } from './contract'
import { computeCoverage } from './coverage'
import { emptyReadingState } from './reading-state'
import type { ReadingDatabase } from './database'
import type { StorageMethod, StorageResponse } from './worker'

export async function openReadingStore(options: {
  databasePath: string
  createWorker: (options: WorkerOptions) => Worker
}): Promise<AppStore> {
  let status: StorageStatus = { state: 'unavailable', reason: 'open-failed' }
  let worker: Worker | null = null
  let stopped = false
  let closing = false
  let closePromise: Promise<void> | null = null
  let nextId = 1
  const pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }>()
  const { promise: ready, resolve: resolveReady } = Promise.withResolvers<void>()

  function stop(): void {
    if (stopped) return
    stopped = true
    status = { state: 'unavailable', reason: 'open-failed' }
    for (const request of pending.values()) request.reject(new Error('database worker stopped'))
    pending.clear()
    resolveReady()
  }

  function receive(message: StorageResponse): void {
    if (stopped) return
    if ('type' in message) {
      if (message.type === 'ready') {
        status = message.status
        resolveReady()
      }
      return
    }
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.ok) {
      request.resolve(message.value)
    } else if (message.error.name === 'StorageWriteRefusedError' && message.error.status) {
      request.reject(new StorageWriteRefusedError(message.error.status))
    } else {
      request.reject(new Error(message.error.message))
    }
  }

  /** Legacy reading fallbacks stay usable offline; publication reads and all writes must fail. */
  function unavailable<Method extends StorageMethod>(
    method: Method,
    args: Parameters<ReadingDatabase[Method]>
  ): ReturnType<ReadingDatabase[Method]> {
    let value: unknown
    switch (method) {
      case 'getThreadCoverage': value = computeCoverage(args[0] as ThreadId, args[1] as ReadingMode, [], null); break
      case 'getReadingState': value = emptyReadingState(args[0] as ThreadId); break
      case 'loadSettings': value = { ...DEFAULT_SETTINGS }; break
      case 'loadRoleSelections':
        value = { browse: { state: 'none' }, 'default-post': { state: 'none' }, 'web-sync': { state: 'none' } }
        break
      case 'loadDirectory':
      case 'loadFeedPage':
      case 'loadThreadPage':
      case 'getPostImage':
      case 'findImageResource':
      case 'getDraftAttachment':
      case 'loadCredentialCiphertext': value = null; break
      case 'getThreadPostIdentity': value = { state: 'none' }; break
      case 'listImageFileNames':
      case 'listDraftAttachmentFileNames':
      case 'listDrafts':
      case 'listCredentials':
      case 'loadCredentialCiphertexts': value = []; break
      case 'close': value = undefined; break
      default: throw new StorageWriteRefusedError(status)
    }
    return value as ReturnType<ReadingDatabase[Method]>
  }

  async function request<Method extends StorageMethod>(
    method: Method,
    ...args: Parameters<ReadingDatabase[Method]>
  ): Promise<ReturnType<ReadingDatabase[Method]>> {
    if (stopped || worker === null || (closing && method !== 'close')) {
      return unavailable(method, args)
    }
    if (status.state === 'unavailable' && method !== 'close') return unavailable(method, args)
    const activeWorker = worker
    const id = nextId++
    const { promise, resolve, reject } = Promise.withResolvers<ReturnType<ReadingDatabase[Method]>>()
    pending.set(id, {
      resolve: (value) => resolve(value as ReturnType<ReadingDatabase[Method]>),
      reject
    })
    try {
      activeWorker.postMessage({ id, method, args })
    } catch {
      stop()
    }
    return promise
  }

  try {
    worker = options.createWorker({ workerData: { databasePath: options.databasePath } })
    worker.on('message', receive)
    worker.on('error', stop)
    worker.on('exit', stop)
  } catch {
    stop()
  }
  await ready

  return {
    get status() { return status },
    saveDirectory: (directory, fetchedAt) => request('saveDirectory', directory, fetchedAt),
    loadDirectory: () => request('loadDirectory'),
    saveFeedPage: (page, fetchedAt) => request('saveFeedPage', page, fetchedAt),
    loadFeedPage: (feed, page) => request('loadFeedPage', feed, page),
    saveThreadPage: (page, fetchedAt) => request('saveThreadPage', page, fetchedAt),
    loadThreadPage: (threadId, mode, page) => request('loadThreadPage', threadId, mode, page),
    getThreadCoverage: (threadId, mode) => request('getThreadCoverage', threadId, mode),
    getReadingState: (threadId) => request('getReadingState', threadId),
    setReadingMode: (threadId, mode, at) => request('setReadingMode', threadId, mode, at),
    saveReadingPosition: (threadId, mode, anchor, at) => request('saveReadingPosition', threadId, mode, anchor, at),
    markPostsRead: (threadId, postIds, at) => request('markPostsRead', threadId, postIds, at),
    recordVisit: (threadId, at) => request('recordVisit', threadId, at),
    establishAttention: (threadId, source, at) => request('establishAttention', threadId, source, at),
    loadSettings: () => request('loadSettings'),
    saveSettings: (settings) => request('saveSettings', settings),
    getPostImage: (postId) => request('getPostImage', postId),
    findImageResource: (kind, sourceUrl, holder) => request('findImageResource', kind, sourceUrl, holder),
    commitImageResource: (resource, holders) => request('commitImageResource', resource, holders),
    releaseImageHolders: (kind, idPrefix) => request('releaseImageHolders', kind, idPrefix),
    deleteUnheldImages: (resourceIds) => request('deleteUnheldImages', resourceIds),
    listImageFileNames: () => request('listImageFileNames'),
    listCredentials: () => request('listCredentials'),
    loadCredentialCiphertexts: () => request('loadCredentialCiphertexts'),
    loadCredentialCiphertext: (id) => request('loadCredentialCiphertext', id),
    insertCredential: (input) => request('insertCredential', input),
    renameCredential: (id, name) => request('renameCredential', id, name),
    deleteCredential: (id) => request('deleteCredential', id),
    loadRoleSelections: () => request('loadRoleSelections'),
    setRoleSelection: (role, id) => request('setRoleSelection', role, id),
    listDrafts: () => request('listDrafts'),
    saveDraft: (input, at) => request('saveDraft', input, at),
    deleteDraft: (id) => request('deleteDraft', id),
    insertDraftAttachment: (input) => request('insertDraftAttachment', input),
    getDraftAttachment: (id) => request('getDraftAttachment', id),
    deleteUnreferencedAttachments: (keep) => request('deleteUnreferencedAttachments', keep),
    listDraftAttachmentFileNames: () => request('listDraftAttachmentFileNames'),
    getThreadPostIdentity: (threadId) => request('getThreadPostIdentity', threadId),
    setThreadPostIdentity: (threadId, id, at) => request('setThreadPostIdentity', threadId, id, at),
    createPublication: (input) => request('createPublication', input),
    listPublications: () => request('listPublications'),
    getPublication: (id) => request('getPublication', id),
    finishPublication: (input) => request('finishPublication', input),
    recoverPublications: (at) => request('recoverPublications', at),
    listLaunchNotices: () => request('listLaunchNotices'),
    dismissLaunchNotices: (ids) => request('dismissLaunchNotices', ids),
    loadWorkspace: () => request('loadWorkspace'),
    saveWorkspace: (state, at) => request('saveWorkspace', state, at),
    listOwnPosts: () => request('listOwnPosts'),
    addManualOwnPost: (input) => request('addManualOwnPost', input),
    getPoWarningEnabled: () => request('getPoWarningEnabled'),
    setPoWarningEnabled: (enabled) => request('setPoWarningEnabled', enabled),
    lastPublicationAt: (credentialId, forumId) => request('lastPublicationAt', credentialId, forumId),
    close() {
      if (!closePromise) {
        closing = true
        status = { state: 'unavailable', reason: 'open-failed' }
        closePromise = request('close').finally(() => {
          stop()
          worker?.off('message', receive)
        })
      }
      return closePromise
    }
  }
}
