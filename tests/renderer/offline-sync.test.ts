import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import type { OfflineCopy } from '../../src/shared/content'
import type * as Sync from '../../src/renderer/src/features/content/offlineSync'

const copy = (threadId: string): OfflineCopy => ({
  threadId,
  createdAt: '2026-10-26T00:00:00Z',
  updatedAt: '2026-10-26T00:00:00Z',
  includeImages: true,
  state: 'saving',
  pages: [1],
  endCandidatePage: null,
  postCount: 1,
  imageCount: 0,
  savedImages: 0,
  imageFailures: [],
  failedPage: null,
  error: null
})

let sync: typeof Sync
let mainListener: ((threadId: string) => void) | null
let stopMain: Mock

function stub(
  deleteOffline: (input: { threadId: string }) => Promise<unknown>,
  offlineStatus: (input: { threadId: string }) => Promise<unknown> = async () => ({ ok: true, value: null })
) {
  vi.stubGlobal('window', {
    xidao: {
      content: {
        deleteOffline: vi.fn(deleteOffline),
        offlineStatus: vi.fn(offlineStatus),
        onOfflineChanged: vi.fn((listener: (threadId: string) => void) => {
          mainListener = listener
          return stopMain
        })
      }
    }
  })
}

/** Lets already-answered reads run their continuations (microtasks only, no clock). */
async function settle() {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
}

beforeEach(async () => {
  vi.resetModules()
  mainListener = null
  stopMain = vi.fn()
  // The module keeps window-wide state; each test loads a fresh instance of it.
  sync = await import('../../src/renderer/src/features/content/offlineSync')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it('runs one deletion per thread and invalidates reads from before it and from during it', async () => {
  const answer = Promise.withResolvers<unknown>()
  stub(() => answer.promise)
  const changes: unknown[] = []
  const stop = sync.subscribeOffline((change) => changes.push(change))
  const before = sync.offlineGeneration('100')
  const epoch = sync.offlineEpoch()

  const first = sync.deleteOfflineCopy('100')
  const again = sync.deleteOfflineCopy('100')
  expect(again).toBe(first)
  expect(sync.isDeletingOffline('100')).toBe(true)
  const during = sync.offlineGeneration('100')
  expect(during).not.toBe(before)
  expect(sync.offlineGeneration('200')).toBe(0)

  // The main process's notice usually arrives before the answer.
  mainListener?.('100')
  expect(changes).toEqual([{ kind: 'stale', threadId: '100' }])
  const noticed = sync.offlineGeneration('100')
  expect(noticed).not.toBe(during)

  answer.resolve({ ok: true, value: { cacheCleanup: 'failed' } })
  expect(await first).toEqual({ kind: 'deleted', cacheCleanup: 'failed' })
  expect(await again).toEqual({ kind: 'deleted', cacheCleanup: 'failed' })
  expect(window.xidao.content.deleteOffline).toHaveBeenCalledTimes(1)
  expect(sync.isDeletingOffline('100')).toBe(false)
  expect(sync.offlineGeneration('100')).not.toBe(noticed)
  expect(sync.offlineEpoch()).toBeGreaterThan(epoch)
  expect(changes).toEqual([
    { kind: 'stale', threadId: '100' },
    { kind: 'stale', threadId: '100' }
  ])
  stop()
  expect(stopMain).toHaveBeenCalledTimes(1)
})

it('reports a refused or failed deletion and still has every view read the thread again', async () => {
  stub(async () => ({ ok: false, reason: 'busy' }))
  const changes: unknown[] = []
  sync.subscribeOffline((change) => changes.push(change))
  expect(await sync.deleteOfflineCopy('100')).toEqual({ kind: 'failed', text: '删除没有完成：本地存储正忙，请稍后重试' })
  expect(changes).toEqual([{ kind: 'stale', threadId: '100' }])

  stub(async () => {
    throw new Error('ipc')
  })
  expect(await sync.deleteOfflineCopy('100')).toEqual({ kind: 'failed', text: '删除没有完成：应用内部请求失败' })
  // A later attempt is a new deletion, not the failed one again.
  stub(async () => ({ ok: true, value: { cacheCleanup: 'complete' } }))
  expect(await sync.deleteOfflineCopy('100')).toEqual({ kind: 'deleted', cacheCleanup: 'complete' })
})

it('keeps the toolbar note until it is dismissed or the thread is saved again', () => {
  stub(async () => ({ ok: true, value: { cacheCleanup: 'complete' } }))
  const changes: unknown[] = []
  sync.subscribeOffline((change) => changes.push(change))
  sync.showDeletionNote({ threadId: '100', cacheCleanup: 'failed' })
  sync.announceOfflineCopy(copy('200'))
  expect(sync.deletionNote()).toEqual({ threadId: '100', cacheCleanup: 'failed' })
  sync.announceOfflineCopy(copy('100'))
  expect(sync.deletionNote()).toBeNull()
  expect(changes).toEqual([
    { kind: 'copy', copy: copy('200') },
    { kind: 'copy', copy: copy('100') }
  ])
  sync.showDeletionNote({ threadId: '100', cacheCleanup: 'complete' })
  sync.showDeletionNote(null)
  expect(sync.deletionNote()).toBeNull()
})

it('does not call a copy deleted when its deletion failed', async () => {
  stub(async () => ({ ok: false, reason: 'storage' }), async ({ threadId }) => ({ ok: true, value: copy(threadId) }))
  const watcher = sync.watchOfflinePresence(() => {})
  watcher.track(['100'])
  await settle()
  expect(watcher.get('100')).toBe('present')
  expect(await sync.deleteOfflineCopy('100')).toMatchObject({ kind: 'failed' })
  await settle()
  expect(watcher.get('100')).toBe('present')
  watcher.dispose()
})

it('says deleted only from storage, and present again after a new save', async () => {
  let stored: OfflineCopy | null = copy('100')
  stub(
    async () => {
      stored = null
      return { ok: true, value: { cacheCleanup: 'complete' } }
    },
    async () => ({ ok: true, value: stored })
  )
  const changes = vi.fn()
  const watcher = sync.watchOfflinePresence(changes)
  // Several hits of one thread, and the same results shown again: one read.
  watcher.track(['100', '100'])
  watcher.track(['100'])
  await settle()
  expect(window.xidao.content.offlineStatus).toHaveBeenCalledTimes(1)
  expect(watcher.get('100')).toBe('present')

  await sync.deleteOfflineCopy('100')
  await settle()
  expect(watcher.get('100')).toBe('deleted')

  // Saved again: announced here, or read after another window's notice.
  stored = copy('100')
  sync.announceOfflineCopy(copy('100'))
  expect(watcher.get('100')).toBe('present')
  mainListener?.('100')
  await settle()
  expect(watcher.get('100')).toBe('present')
  expect(changes).toHaveBeenCalled()
  watcher.dispose()
})

it('drops a read a deletion overtook and reads again', async () => {
  const late = Promise.withResolvers<unknown>()
  const reads = [late.promise]
  stub(async () => ({ ok: true, value: { cacheCleanup: 'complete' } }), () => reads.shift() ?? Promise.resolve({ ok: true, value: null }))
  const watcher = sync.watchOfflinePresence(() => {})
  watcher.track(['100'])
  await sync.deleteOfflineCopy('100')
  // The read from before the deletion answers late with the old copy.
  late.resolve({ ok: true, value: copy('100') })
  await settle()
  expect(watcher.get('100')).toBe('deleted')
  watcher.dispose()
})

it('leaves a failed read unknown, forgets untracked threads and stops after dispose', async () => {
  let fail = true
  stub(
    async () => ({ ok: true, value: { cacheCleanup: 'complete' } }),
    async ({ threadId }) => (fail ? { ok: false, reason: 'storage' } : { ok: true, value: copy(threadId) })
  )
  const changes = vi.fn()
  const watcher = sync.watchOfflinePresence(changes)
  watcher.track(['100'])
  await settle()
  expect(watcher.get('100')).toBe('unknown')

  watcher.track([])
  expect(watcher.get('100')).toBeUndefined()
  fail = false
  // Shown again (restored results, a further page): checked again, not remembered.
  watcher.track(['100'])
  await settle()
  expect(watcher.get('100')).toBe('present')

  watcher.dispose()
  expect(stopMain).toHaveBeenCalledTimes(1)
  const count = changes.mock.calls.length
  sync.markOfflineStale('100')
  await settle()
  expect(changes).toHaveBeenCalledTimes(count)
})
