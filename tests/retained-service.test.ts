import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createContentService, type ContentService } from '../src/main/content/service'
import { ForumReadError, ReadCancelledError, type ForumClient } from '../src/main/forum/contract'
import { openManagedImageFiles } from '../src/main/images/files'
import { createImageService } from '../src/main/images/service'
import { ImageFetchError } from '../src/main/images/transport'
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
    listRetained: async (...a) => db.listRetained(...a),
    isFavorite: async (...a) => db.isFavorite(...a),
    setFavorite: async (...a) => db.setFavorite(...a),
    clearHistory: async (...a) => db.clearHistory(...a),
    getContentUsage: async () => db.getContentUsage(),
    setCacheLimit: async (...a) => db.setCacheLimit(...a),
    evictContentBatch: async (...a) => db.evictContentBatch(...a),
    holdContentReader: async (...a) => db.holdContentReader(...a),
    releaseContentReaders: async (...a) => db.releaseContentReaders(...a),
    getOfflineCopy: async (...a) => db.getOfflineCopy(...a),
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
async function setup(read: ForumClient['getThreadPage'], overrides: Partial<ContentStore> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'xidao-retained-service-'))
  const databasePath = join(dir, 'xidao.sqlite')
  const db = openReadingDatabase(databasePath)
  const store = { ...asStore(db), ...contentStore(db), ...overrides }
  const files = await openManagedImageFiles(join(dir, 'images'))
  const downloads: string[] = []
  const images = createImageService({ store, files, origin: 'https://image.example', download: async (url, destination) => {
    downloads.push(url.pathname)
    if (url.pathname.includes('broken')) throw new ImageFetchError({ reason: 'html' })
    writeFileSync(destination, png)
    return { bytes: png.length }
  } })
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
    expect(db.getReadingState('100').readPostIds).toEqual([])
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
    expect(await service.list({ kind: 'offline' })).toMatchObject({ ok: true, value: [{ offline: { state: 'interrupted', error: 'storage' } }] })
    expect(db.loadThreadPage('100', 'all', 1)?.value.head.id).toBe('100')
  })
})
