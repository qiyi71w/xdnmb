import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContentService, type ContentService } from '../src/main/content/service'
import { ForumReadError, ReadCancelledError, type ForumClient } from '../src/main/forum/contract'
import { openManagedImageFiles } from '../src/main/images/files'
import { createImageService } from '../src/main/images/service'
import { ImageFetchError, type ImageDownloader } from '../src/main/images/transport'
import { createRequestScheduler } from '../src/main/reading/scheduler'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import type { ContentStore } from '../src/main/storage/content-contract'
import type { OfflineCopy } from '../src/shared/content'
import type { FeedPage, Post, ThreadPage } from '../src/shared/forum'
import { asStore } from './helpers/store'

const resources: Array<{ dir: string; db: ReadingDatabase; service: ContentService }> = []
afterEach(async () => {
  for (const { dir, db, service } of resources.splice(0)) {
    await service.stop()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
function contentStore(db: ReadingDatabase): ContentStore {
  return {
    listHistory: async () => db.listHistory(),
    listOffline: async () => db.listOffline(),
    clearHistory: async (...a) => db.clearHistory(...a),
    getContentUsage: async () => db.getContentUsage(),
    setCacheLimit: async (...a) => db.setCacheLimit(...a),
    evictContentBatch: async (...a) => db.evictContentBatch(...a),
    holdContentReader: async (...a) => db.holdContentReader(...a),
    releaseContentReaders: async (...a) => db.releaseContentReaders(...a),
    getOfflineCopy: async (...a) => db.getOfflineCopy(...a),
    deleteOfflineCopy: async (...a) => db.deleteOfflineCopy(...a),
    beginOfflineCopy: async (...a) => db.beginOfflineCopy(...a),
    saveOfflinePage: async (...a) => db.saveOfflinePage(...a),
    updateOfflineCopy: async (...a) => db.updateOfflineCopy(...a),
    holdOfflineImage: async (...a) => db.holdOfflineImage(...a),
    listOfflineImagePosts: async (...a) => db.listOfflineImagePosts(...a),
    recoverContent: async () => db.recoverContent()
  }
}
const image = { path: '2026-10-24/shared', ext: '.png' }
function post(id: string, withImage = false): Post {
  return { id, title: `串 ${id}`, plainText: `内容 ${id}`, content: [{ type: 'text', text: `内容 ${id}` }],
    image: withImage ? image : null, forumId: '4', createdAt: null, userHash: null, name: null, isAdmin: false, isSage: false }
}
function page(threadId: string, number: number, replies: Post[]): ThreadPage {
  return { threadId, mode: 'all', page: number, head: post(threadId), replies, replyCount: null, skippedItems: 0, endCandidate: replies.length === 0 }
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
async function setup(read: ForumClient['getThreadPage'], overrides: Partial<ContentStore> = {}, download?: ImageDownloader) {
  const dir = mkdtempSync(join(tmpdir(), 'xidao-retained-service-'))
  const databasePath = join(dir, 'xidao.sqlite')
  const db = openReadingDatabase(databasePath)
  const store = { ...asStore(db), ...contentStore(db), ...overrides }
  const files = await openManagedImageFiles(join(dir, 'images'))
  const downloads: string[] = []
  const images = createImageService({ store, files, origin: 'https://image.example', download: download ?? (async (url, destination) => {
    downloads.push(url.pathname)
    if (url.pathname.includes('broken')) throw new ImageFetchError({ reason: 'html' })
    writeFileSync(destination, png)
    return { bytes: png.length }
  }) })
  const client: ForumClient = {
    getThreadPage: read,
    getDirectory: async () => { throw new Error('not used') },
    getFeedPage: async () => { throw new Error('not used') },
    getRef: async () => { throw new Error('not used') }
  }
  const service = createContentService({ store, files, images, client, scheduler: createRequestScheduler(), databasePath })
  resources.push({ dir, db, service })
  return { dir, db, store, files, images, service, downloads }
}
async function finished(service: ContentService, threadId: string): Promise<OfflineCopy> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const status = await service.offlineStatus({ threadId })
    if (status.ok && status.value !== null && status.value.state !== 'saving') return status.value
    await yieldToLoop()
  }
  throw new Error('offline task did not settle')
}

describe('retained content operations', () => {
  it('drains late pages and terminal writes before deleting, excluding competing operations', async () => {
    const reached = Promise.withResolvers<void>()
    const latePage = Promise.withResolvers<ThreadPage>()
    const terminal = Promise.withResolvers<void>()
    const releaseTerminal = Promise.withResolvers<void>()
    let actual: ContentStore
    const { service, db } = await setup(async (id, _mode, n) => {
      if (n === 1) return page(id, n, [post('101')])
      reached.resolve()
      return latePage.promise
    }, {
      updateOfflineCopy: async (...args) => {
        if (args[1].state === 'cancelled') {
          terminal.resolve()
          await releaseTerminal.promise
        }
        return actual.updateOfflineCopy(...args)
      }
    })
    actual = contentStore(db)
    await service.saveOffline({ threadId: '100', includeImages: false })
    await reached.promise
    const deletion = service.deleteOffline({ threadId: '100' })
    expect(await service.saveOffline({ threadId: '100', includeImages: false })).toEqual({ ok: false, reason: 'busy' })
    expect(await service.deleteOffline({ threadId: '100' })).toEqual({ ok: false, reason: 'busy' })
    latePage.resolve(page('100', 2, [post('102')]))
    await terminal.promise
    expect(db.getOfflineCopy('100')?.pages).toEqual([1])
    expect(await service.saveOffline({ threadId: '100', includeImages: false })).toEqual({ ok: false, reason: 'busy' })
    releaseTerminal.resolve()
    expect(await deletion).toEqual({ ok: true, value: { cacheCleanup: 'complete' } })
    expect(await service.offlineStatus({ threadId: '100' })).toEqual({ ok: true, value: null })
    expect(db.loadThreadPage('100', 'all', 1)?.value.replies.map((item) => item.id)).toEqual(['101'])
    expect(db.loadThreadPage('100', 'all', 2)).toBeNull()
    expect(db.loadPost('102')).toBeNull()
  })

  it('waits for an original and prevents its late result from restoring offline protection', async () => {
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const { service, db, images, files } = await setup(async (id, _mode, n) => page(id, n, n === 1 ? [post('101', true)] : []))
    const load = images.load.bind(images)
    vi.spyOn(images, 'load').mockImplementation(async (...args) => {
      const result = await load(...args)
      reached.resolve()
      await release.promise
      return result
    })
    await service.saveOffline({ threadId: '100', includeImages: true })
    await reached.promise
    const url = 'https://image.example/image/2026-10-24/shared.png'
    const resource = db.findImageResource('original', url, null)!
    const file = files.pathOf(resource.fileName)!
    expect(existsSync(file)).toBe(true)
    db.setCacheLimit(0)
    const deletion = service.deleteOffline({ threadId: '100' })
    expect(await service.saveOffline({ threadId: '100', includeImages: true })).toEqual({ ok: false, reason: 'busy' })
    release.resolve()
    expect(await deletion).toEqual({ ok: true, value: { cacheCleanup: 'complete' } })
    expect(db.getOfflineCopy('100')).toBeNull()
    expect(db.findImageResource('original', url, null)).toBeNull()
    expect(existsSync(file)).toBe(false)
  })

  it.each(['download', 'commit'] as const)('drains the real image %s before deleting and reopening save admission', async (phase) => {
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const { service, db, files } = await setup(
      async (id, _mode, n) => page(id, n, n === 1 ? [post('101', true)] : []),
      {},
      async (_url, destination) => {
        writeFileSync(destination, png)
        if (phase === 'download') {
          reached.resolve()
          await release.promise
        }
        return { bytes: png.length }
      }
    )
    if (phase === 'commit') {
      const commit = files.commit.bind(files)
      vi.spyOn(files, 'commit').mockImplementation(async (...args) => {
        reached.resolve()
        await release.promise
        return commit(...args)
      })
    }
    await service.saveOffline({ threadId: '100', includeImages: true })
    await reached.promise
    db.setCacheLimit(0)
    let deleted = false
    const deletion = service.deleteOffline({ threadId: '100' }).then((result) => { deleted = true; return result })
    try {
      for (let i = 0; i < 10; i++) await yieldToLoop()
      expect(deleted).toBe(false)
      expect(await service.saveOffline({ threadId: '100', includeImages: true })).toEqual({ ok: false, reason: 'busy' })
    } finally {
      release.resolve()
      await deletion
    }
    expect(await deletion).toEqual({ ok: true, value: { cacheCleanup: 'complete' } })
    expect(db.getOfflineCopy('100')).toBeNull()
    expect(db.findImageResource('original', 'https://image.example/image/2026-10-24/shared.png', null)).toBeNull()
  })

  it('keeps a shared reader download and its holder while draining the offline waiter', async () => {
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const { service, db, images } = await setup(
      async (id, _mode, n) => page(id, n, n === 1 ? [post('101', true)] : []),
      {},
      async (_url, destination, _limit, signal) => {
        reached.resolve()
        await release.promise
        expect(signal.aborted).toBe(false)
        writeFileSync(destination, png)
        return { bytes: png.length }
      }
    )
    await service.saveOffline({ threadId: '100', includeImages: true })
    await reached.promise
    const reader = images.load('reader', { viewId: 'view', postId: '101', kind: 'original', refresh: false }, new AbortController().signal)
    for (let i = 0; i < 10; i++) await yieldToLoop()
    db.setCacheLimit(0)
    const deletion = service.deleteOffline({ threadId: '100' })
    release.resolve()
    expect(await reader).toMatchObject({ status: 'ready' })
    expect(await deletion).toEqual({ ok: true, value: { cacheCleanup: 'complete' } })
    const url = 'https://image.example/image/2026-10-24/shared.png'
    expect(db.getOfflineCopy('100')).toBeNull()
    expect(db.findImageResource('original', url, null)).not.toBeNull()
    await images.releaseOwner('reader')
    await service.enforceQuota()
    expect(db.findImageResource('original', url, null)).toBeNull()
  })

  it('surfaces actual image-holder storage failure before deleting and retries the release', async () => {
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const { service, db, store } = await setup(async (id, _mode, n) => page(id, n, n === 1 ? [post('101', true)] : []))
    const releaseHolders = store.releaseImageHolders.bind(store)
    let fail = true
    vi.spyOn(store, 'releaseImageHolders').mockImplementation(async (kind, prefix) => {
      if (!fail || !prefix.startsWith('offline-100:')) return releaseHolders(kind, prefix)
      if (prefix === 'offline-100:') {
        reached.resolve()
        await release.promise
      }
      throw new Error('reading holder release failed')
    })
    await service.saveOffline({ threadId: '100', includeImages: true })
    await reached.promise
    const deletion = service.deleteOffline({ threadId: '100' })
    release.resolve()
    expect(await deletion).toEqual({ ok: false, reason: 'storage' })
    expect(db.getOfflineCopy('100')?.savedImages).toBe(1)
    fail = false
    db.setCacheLimit(0)
    expect(await service.deleteOffline({ threadId: '100' })).toEqual({ ok: true, value: { cacheCleanup: 'complete' } })
    expect(db.getOfflineCopy('100')).toBeNull()
    expect(db.findImageResource('original', 'https://image.example/image/2026-10-24/shared.png', null)).toBeNull()
  })

  it('reports failed task cleanup without hanging or deleting, and allows an explicit retry', async () => {
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const { service, db, images } = await setup(async (id, _mode, n) => page(id, n, []))
    vi.spyOn(images, 'releaseOwner').mockImplementationOnce(async () => {
      reached.resolve()
      await release.promise
      throw new Error('holder release failed')
    })
    await service.saveOffline({ threadId: '100', includeImages: false })
    await reached.promise
    const deletion = service.deleteOffline({ threadId: '100' })
    release.resolve()
    expect(await deletion).toEqual({ ok: false, reason: 'storage' })
    expect(db.getOfflineCopy('100')?.pages).toEqual([1])
    expect(await service.deleteOffline({ threadId: '100' })).toEqual({ ok: true, value: { cacheCleanup: 'complete' } })
    expect(db.getOfflineCopy('100')).toBeNull()
  })

  it('distinguishes refused deletion from committed deletion with failed quota cleanup', async () => {
    let deleteFails = true
    let actual: ContentStore
    const { service, db } = await setup(async (id, _mode, n) => page(id, n, []), {
      deleteOfflineCopy: async (id) => {
        if (deleteFails) throw new Error('delete unavailable')
        await actual.deleteOfflineCopy(id)
      },
      evictContentBatch: async () => { throw new Error('quota unavailable') }
    })
    actual = contentStore(db)
    await service.saveOffline({ threadId: '100', includeImages: false })
    await finished(service, '100')
    expect(await service.deleteOffline({ threadId: '100' })).toEqual({ ok: false, reason: 'storage' })
    expect(db.getOfflineCopy('100')?.pages).toEqual([1])
    deleteFails = false
    expect(await service.deleteOffline({ threadId: '100' })).toEqual({ ok: true, value: { cacheCleanup: 'failed' } })
    expect(await service.offlineStatus({ threadId: '100' })).toEqual({ ok: true, value: null })
    expect(db.loadThreadPage('100', 'all', 1)?.value.head.id).toBe('100')
  })

  it('drains admitted deletion at quit and accepts a fresh save after reopening', async () => {
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let actual: ContentStore
    const { service, db } = await setup(async (id, _mode, n) => page(id, n, []), {
      deleteOfflineCopy: async (id) => {
        reached.resolve()
        await release.promise
        await actual.deleteOfflineCopy(id)
      }
    })
    actual = contentStore(db)
    db.beginOfflineCopy('100', false, '2000-01-01T00:00:00Z')
    const deletion = service.deleteOffline({ threadId: '100' })
    await reached.promise
    let stopped = false
    const stopping = service.stop().then(() => { stopped = true })
    await yieldToLoop()
    expect(stopped).toBe(false)
    release.resolve()
    expect(await deletion).toEqual({ ok: true, value: { cacheCleanup: 'failed' } })
    await stopping
    expect(db.getOfflineCopy('100')).toBeNull()
    service.resume()
    expect((await service.saveOffline({ threadId: '100', includeImages: false })).ok).toBe(true)
    const saved = await finished(service, '100')
    expect(saved.pages).toEqual([1])
    expect(saved.createdAt).not.toBe('2000-01-01T00:00:00Z')
  })

  it('drains background saves at quit and accepts new work when the window is reopened', async () => {
    const reached = Promise.withResolvers<void>()
    const requests: string[] = []
    const { service, db } = await setup(async (id, _mode, n, signal) => {
      requests.push(`${id}:${n}`)
      if (id === '200') return page(id, n, [])
      if (n === 1) return page(id, n, [post('101')])
      const { promise, reject } = Promise.withResolvers<ThreadPage>()
      signal.addEventListener('abort', () => reject(new ReadCancelledError()), { once: true })
      reached.resolve()
      return promise
    })
    await service.saveOffline({ threadId: '100', includeImages: false })
    await reached.promise
    await service.stop()
    expect(requests).toEqual(['100:1', '100:2'])
    expect(await service.saveOffline({ threadId: '200', includeImages: false })).toEqual({ ok: false, reason: 'busy' })
    expect(db.getOfflineCopy('100')).toMatchObject({ pages: [1], state: 'interrupted' })
    service.resume()
    expect((await service.saveOffline({ threadId: '200', includeImages: false })).ok).toBe(true)
    expect(await finished(service, '200')).toMatchObject({ pages: [1], state: 'stopped' })
    expect(requests).toEqual(['100:1', '100:2', '200:1'])
  })

  it('cancels queued pages, preserves completed text, and allows foreground persistence before exit', async () => {
    const reached = Promise.withResolvers<void>()
    const { service, db } = await setup(async (id, _mode, n, signal) => {
      if (n === 1) return page(id, n, [post('101')])
      reached.resolve()
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new ReadCancelledError()), { once: true }))
    })
    expect((await service.saveOffline({ threadId: '100', includeImages: false })).ok).toBe(true)
    await reached.promise
    db.saveReadingPosition('100', 'all', { postId: '101', page: 1, offsetRatio: 0.5, viewportOffset: 40 }, '2026-10-24T01:00:00Z')
    const cancelled = await service.cancelOffline({ threadId: '100' })
    expect(cancelled).toMatchObject({ ok: true, value: { state: 'cancelled', pages: [1], failedPage: 2 } })
    expect(db.loadThreadPage('100', 'all', 1)?.value.replies.map((p) => p.id)).toEqual(['101'])
    expect(db.getReadingState('100').positions.all?.anchor.postId).toBe('101')
    await service.saveOffline({ threadId: '100', includeImages: false })
    await service.stop()
    expect(db.getOfflineCopy('100')?.state).toBe('interrupted')
    expect(db.loadThreadPage('100', 'all', 1)?.value.replies[0]?.plainText).toBe('内容 101')
  })

  it('keeps old missing replies on update and stores page failures without claiming an end', async () => {
    let phase = 0
    const { service, db } = await setup(async (id, _mode, n) => {
      if (phase === 2 && n === 2) throw new ForumReadError({ kind: 'rate-limited', detail: 'http-status', httpStatus: 429 })
      return page(id, n, n === 1 ? [post(phase === 0 ? '101' : '102')] : [])
    })
    await service.saveOffline({ threadId: '100', includeImages: false })
    expect(await finished(service, '100')).toMatchObject({ state: 'stopped', endCandidatePage: 2 })
    phase = 1
    await service.saveOffline({ threadId: '100', includeImages: false })
    await finished(service, '100')
    await service.clearCache()
    expect(db.loadThreadPage('100', 'all', 1)?.value.replies.map((p) => p.id)).toEqual(['101', '102'])
    phase = 2
    await service.saveOffline({ threadId: '100', includeImages: false })
    expect(await finished(service, '100')).toMatchObject({ state: 'interrupted', endCandidatePage: null, failedPage: 2, error: { kind: 'rate-limited' } })
    expect(db.loadThreadPage('100', 'all', 1)?.value.replies.map((p) => p.id)).toEqual(['101', '102'])
  })

  it('shares originals across offline copies, never counts a failed original, and keeps drafts and source files', async () => {
    const broken = { ...post('103', true), image: { path: '2026-10-24/broken', ext: '.png' } }
    const { service, db, images, files, dir, downloads } = await setup(async (id, _mode, n) => page(id, n,
      n === 1 ? id === '100' ? [post('101', true), broken] : [post('201', true)] : []))
    await service.saveOffline({ threadId: '100', includeImages: true })
    expect(await finished(service, '100')).toMatchObject({ state: 'stopped', savedImages: 1, imageFailures: [{ postId: '103', error: { reason: 'html' } }] })
    await service.saveOffline({ threadId: '200', includeImages: true })
    expect(await finished(service, '200')).toMatchObject({ savedImages: 1 })
    expect(downloads.filter((p) => p.endsWith('/shared.png'))).toEqual(['/image/2026-10-24/shared.png'])
    const resource = db.findImageResource('original', 'https://image.example/image/2026-10-24/shared.png', null)
    if (!resource) throw new Error('original not stored')
    const path = files.pathOf(resource.fileName)!
    const source = join(dir, 'user-original.png')
    writeFileSync(source, png)
    const draftAttachment = db.insertDraftAttachment({ fileName: 'a'.repeat(32) + '.png', format: 'png', bytes: png.length, width: 1, height: 1, originalName: 'source.png', createdAt: '2026-10-24T00:00:00Z' })
    mkdirSync(join(dir, 'draft-images'))
    const draftPath = join(dir, 'draft-images', draftAttachment.fileName)
    copyFileSync(source, draftPath)
    db.saveDraft({ draftId: null, target: { kind: 'reply', threadId: '100' }, credentialId: null,
      fields: { content: '草稿保留', title: '', name: '', email: '', watermark: false }, attachmentId: draftAttachment.id }, '2026-10-24T00:00:00Z')
    await service.setCacheLimit({ bytes: 0 })
    await service.clearCache()
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(source)).toEqual(png)
    expect(readFileSync(draftPath)).toEqual(png)
    expect(db.listDrafts()[0]?.fields.content).toBe('草稿保留')
    expect(db.getDraftAttachment(draftAttachment.id)?.bytes).toBe(png.length)
    const preview = await images.load('reader', { viewId: 'a', postId: '101', kind: 'thumb', refresh: false }, new AbortController().signal)
    expect(preview).toMatchObject({ status: 'ready', image: { kind: 'original', source: 'stored' } })
    expect(downloads.some((p) => p.startsWith('/thumb/'))).toBe(false)
  })

  it('keeps offline original metadata when a newer ordinary observation omits the image', async () => {
    const { service, db, images } = await setup(async (id, _mode, n) => page(id, n, n === 1 ? [post('101', true)] : []))
    await service.saveOffline({ threadId: '100', includeImages: true })
    expect(await finished(service, '100')).toMatchObject({ savedImages: 1, imageCount: 1 })
    db.saveThreadPage(page('100', 1, [post('101')]), '2099-01-01T00:00:00Z')
    await service.clearCache()
    expect(db.loadThreadPage('100', 'all', 1)?.value.replies[0]?.image).toEqual(image)
    expect(db.getOfflineCopy('100')).toMatchObject({ savedImages: 1, imageCount: 1 })
    expect(await images.load('reader', { viewId: 'retained', postId: '101', kind: 'original', refresh: false }, new AbortController().signal))
      .toMatchObject({ status: 'ready', image: { kind: 'original', source: 'stored' } })

    // Feed entrypoint variant: feed observation with missing image keeps retained offline image
    db.saveFeedPage({
      feed: { kind: 'forum', id: '4' },
      page: 1,
      skippedItems: 0,
      threads: [{ head: post('100'), replyCount: 1, recentReplies: [post('101')], remainReplies: null }]
    }, '2099-01-02T00:00:00Z')
    expect(db.loadThreadPage('100', 'all', 1)?.value.replies[0]?.image).toEqual(image)

    // Offline update entrypoint variant: offline update with missing image keeps retained metadata
    db.saveOfflinePage(page('100', 1, [post('101')]), '2099-01-03T00:00:00Z')
    expect(db.loadThreadPage('100', 'all', 1)?.value.replies[0]?.image).toEqual(image)
    expect(db.getOfflineCopy('100')).toMatchObject({ savedImages: 1, imageCount: 1 })

    // Thread head entrypoint variant: retained head image preserved when newer observation omits it
    const headImage = { path: '2026-10-24/head', ext: '.png' }
    db.beginOfflineCopy('300', true, '2026-10-24T00:00:00Z')
    db.saveOfflinePage({ ...page('300', 1, []), head: { ...post('300', true), image: headImage } }, '2026-10-24T00:00:00Z')
    expect(db.loadThreadPage('300', 'all', 1)?.value.head.image).toEqual(headImage)
    db.saveThreadPage(page('300', 1, []), '2099-01-01T00:00:00Z')
    expect(db.loadThreadPage('300', 'all', 1)?.value.head.image).toEqual(headImage)

    // Non-offline thread variant: missing image on non-offline post still clears
    db.saveThreadPage(page('200', 1, [post('201', true)]), '2026-10-24T00:00:00Z')
    expect(db.loadThreadPage('200', 'all', 1)?.value.replies[0]?.image).toEqual(image)
    db.saveThreadPage(page('200', 1, [post('201')]), '2099-01-01T00:00:00Z')
    expect(db.loadThreadPage('200', 'all', 1)?.value.replies[0]?.image).toBeNull()

    // Newer non-null image variant: updates post image
    const updatedImage = { path: '2026-10-24/updated', ext: '.webp' }
    db.saveThreadPage(page('100', 1, [{ ...post('101', true), image: updatedImage }]), '2100-01-01T00:00:00Z')
    expect(db.loadThreadPage('100', 'all', 1)?.value.replies[0]?.image).toEqual(updatedImage)

    // Timestamp ordering variant: older observation does not overwrite newer image
    db.saveThreadPage(page('100', 1, [post('101')]), '2000-01-01T00:00:00Z')
    expect(db.loadThreadPage('100', 'all', 1)?.value.replies[0]?.image).toEqual(updatedImage)
  })

  it('reports a storage failure and keeps the previous page when an update cannot be written', async () => {
    let fail = false
    let actual: ContentStore | undefined
    const { service, db } = await setup(async (id, _mode, n) => page(id, n, n === 1 ? [post(fail ? '102' : '101')] : []), {
      saveOfflinePage: async (...args) => {
        if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        return actual!.saveOfflinePage(...args)
      }
    })
    actual = contentStore(db)
    await service.saveOffline({ threadId: '100', includeImages: false })
    await finished(service, '100')
    fail = true
    await service.saveOffline({ threadId: '100', includeImages: false })
    expect(await finished(service, '100')).toMatchObject({ state: 'interrupted', error: 'storage', failedPage: 1 })
    expect(db.loadThreadPage('100', 'all', 1)?.value.replies.map((p) => p.id)).toEqual(['101'])
  })

  it('stops on a partial normalized page while retaining its valid posts', async () => {
    const { service, db } = await setup(async (id, _mode, n) => ({ ...page(id, n, [post('101')]), skippedItems: 1 }))
    await service.saveOffline({ threadId: '100', includeImages: false })
    expect(await finished(service, '100')).toMatchObject({ state: 'interrupted', failedPage: 1, endCandidatePage: null, error: { kind: 'unknown-structure' } })
    expect(db.loadThreadPage('100', 'all', 1)?.value.replies[0]?.id).toBe('101')
  })

  it('shows a storage interruption even when the terminal status cannot be persisted', async () => {
    const { service, db } = await setup(async (id, _mode, n) => page(id, n, []), {
      updateOfflineCopy: async () => { throw new Error('disk full') }
    })
    await service.saveOffline({ threadId: '100', includeImages: false })
    expect(await finished(service, '100')).toMatchObject({ state: 'interrupted', error: 'storage' })
    expect(await service.listOffline()).toMatchObject({ ok: true, value: [{ copy: { state: 'interrupted', error: 'storage' } }] })
    expect(db.loadThreadPage('100', 'all', 1)?.value.head.id).toBe('100')
  })
})
