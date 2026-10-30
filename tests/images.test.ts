import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Post, ThreadPage } from '../src/shared/forum'
import type { ImageLoadOutcome } from '../src/shared/images'
import { openManagedImageFiles, type ManagedImageFiles } from '../src/main/images/files'
import { createImageService, type ImageService } from '../src/main/images/service'
import { createImageDownloader } from '../src/main/images/transport'
import type { ReadingStore } from '../src/main/storage/contract'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { asStore } from './helpers/store'

const THREAD = '60000001'

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A real, decodable RGB PNG of the given size (`declared` overrides the header size only). */
function png(width: number, height: number, declared?: { width: number; height: number }): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(declared?.width ?? width, 0)
  header.writeUInt32BE(declared?.height ?? height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x7f)
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** JPEG segment structure as the forum serves it: SOI, two large APPn (EXIF/ICC) segments, SOF0, SOS, EOI. */
function jpeg(width: number, height: number): Buffer {
  const app = (marker: number) => {
    const segment = Buffer.alloc(60_000)
    segment.set([0xff, marker])
    segment.writeUInt16BE(segment.length - 2, 2)
    return segment
  }
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01])
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00, 0x12, 0x34, 0xff, 0xd9])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app(0xe1), app(0xe2), sof, sos])
}

function post(id: string, image: Post['image']): Post {
  return {
    id,
    forumId: '4',
    createdAt: null,
    userHash: null,
    name: null,
    title: null,
    isAdmin: null,
    isSage: null,
    content: [],
    plainText: '',
    image
  }
}

type Route = (request: IncomingMessage, response: ServerResponse) => void

let dir: string
let db: ReadingDatabase
let store: ReadingStore
let files: ManagedImageFiles
let server: Server
let origin: string
let routes: Map<string, Route>
let requests: IncomingMessage[]

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'xidao-images-'))
  db = openReadingDatabase(join(dir, 'reading.sqlite'))
  store = asStore(db)
  files = await openManagedImageFiles(join(dir, 'images'))
  routes = new Map()
  requests = []
  server = createServer((request, response) => {
    requests.push(request)
    const route = routes.get(request.url ?? '')
    if (route) route(request, response)
    else response.writeHead(404, { 'Content-Type': 'text/html' }).end('<html><body>404 Not Found</body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no server address')
  origin = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
  chmodSync(dir, 0o755)
  rmSync(dir, { recursive: true, force: true })
})

function service(overrides: { store?: ReadingStore; maxConcurrent?: number } = {}): ImageService {
  return createImageService({
    store: overrides.store ?? store,
    files,
    download: createImageDownloader({ allowedOrigins: [origin], timeoutMs: 5000, idleTimeoutMs: 2000 }),
    origin,
    maxConcurrent: overrides.maxConcurrent
  })
}

function seed(posts: Post[]): void {
  const page: ThreadPage = {
    threadId: THREAD,
    mode: 'all',
    page: 1,
    head: post(THREAD, null),
    replies: posts,
    replyCount: posts.length,
    skippedItems: 0,
    endCandidate: false
  }
  db.saveThreadPage(page, '2026-10-23T08:00:00.000Z')
}

function serveBytes(path: string, body: Buffer, contentType = 'image/jpeg'): void {
  routes.set(path, (_request, response) => {
    response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length }).end(body)
  })
}

function managedFiles(): string[] {
  return readdirSync(files.directory).sort()
}

function fileOf(outcome: ImageLoadOutcome): string {
  if (outcome.status !== 'ready') throw new Error(`expected ready, got ${JSON.stringify(outcome)}`)
  return outcome.image.url.slice('xidao-image://file/'.length)
}

const signal = () => new AbortController().signal
const load = (images: ImageService, postId: string, kind: 'thumb' | 'original', viewId = 'view-a', refresh = false) =>
  images.load('1', { viewId, postId, kind, refresh }, signal())

describe('image content judgement', () => {
  it('judges the real encoding: a `.png` original holding JPEG bytes is stored and served as JPEG', async () => {
    seed([post('60000002', { path: '2022-06-18/62acedc59ef24', ext: '.png' })])
    serveBytes('/image/2022-06-18/62acedc59ef24.png', jpeg(640, 480), 'image/png')
    const outcome = await load(service(), '60000002', 'original')
    expect(outcome).toMatchObject({ status: 'ready', image: { kind: 'original', format: 'jpeg', width: 640, height: 480, source: 'network' } })
    expect(fileOf(outcome)).toMatch(/^[0-9a-f]{32}\.jpg$/)
    expect(managedFiles()).toEqual([fileOf(outcome)])
  })

  it('accepts a decodable image whatever MIME the server declares', async () => {
    seed([post('60000002', { path: '2022-06-18/a1', ext: '.jpg' })])
    serveBytes('/thumb/2022-06-18/a1.jpg', png(3, 2), 'text/html')
    expect(await load(service(), '60000002', 'thumb')).toMatchObject({ status: 'ready', image: { format: 'png', width: 3, height: 2 } })
  })

  it('rejects an HTML error page served as 200 image/jpeg and keeps nothing', async () => {
    seed([post('60000002', { path: '2022-07-21/x1', ext: '.jpg' })])
    serveBytes('/image/2022-07-21/x1.jpg', Buffer.from('\n  <!DOCTYPE html><html><body>图片不存在</body></html>'), 'image/jpeg')
    expect(await load(service(), '60000002', 'original')).toEqual({ status: 'failed', error: { reason: 'html' } })
    expect(managedFiles()).toEqual([])
    expect(db.listImageFileNames()).toEqual([])
  })

  it('reports a 404 page as an HTTP status, not as a deleted image', async () => {
    seed([post('60000002', { path: '2022-07-21/missing', ext: '.jpg' })])
    expect(await load(service(), '60000002', 'original')).toEqual({ status: 'failed', error: { reason: 'http-status', httpStatus: 404 } })
  })

  it('rejects non-image bytes and image headers above the pixel limit', async () => {
    seed([
      post('60000002', { path: '2022-07-21/svg', ext: '.jpg' }),
      post('60000003', { path: '2022-07-21/bomb', ext: '.png' })
    ])
    serveBytes('/image/2022-07-21/svg.jpg', Buffer.from('GIF8 not really an image'))
    serveBytes('/image/2022-07-21/bomb.png', png(2, 2, { width: 40_000, height: 40_000 }), 'image/png')
    const images = service()
    expect(await load(images, '60000002', 'original')).toEqual({ status: 'failed', error: { reason: 'not-image' } })
    expect(await load(images, '60000003', 'original')).toEqual({ status: 'failed', error: { reason: 'too-large' } })
    expect(managedFiles()).toEqual([])
  })

  it('never follows a redirect and sends no cookie or credential', async () => {
    seed([post('60000002', { path: '2022-07-21/moved', ext: '.jpg' })])
    routes.set('/image/2022-07-21/moved.jpg', (_request, response) => {
      response.writeHead(302, { Location: '/image/2022-07-21/target.jpg' }).end()
    })
    serveBytes('/image/2022-07-21/target.jpg', png(1, 1))
    expect(await load(service(), '60000002', 'original')).toEqual({ status: 'failed', error: { reason: 'redirect', httpStatus: 302 } })
    expect(requests.map((request) => request.url)).toEqual(['/image/2022-07-21/moved.jpg'])
    expect(requests[0]?.headers.cookie).toBeUndefined()
    expect(requests[0]?.headers.authorization).toBeUndefined()
  })

  it('refuses posts without an image and image paths that are not forum image paths', async () => {
    seed([post('60000002', null), post('60000003', { path: '../../etc/passwd', ext: '' })])
    const images = service()
    expect(await load(images, '60000002', 'thumb')).toEqual({ status: 'failed', error: { reason: 'no-image' } })
    expect(await load(images, '60000003', 'thumb')).toEqual({ status: 'failed', error: { reason: 'unsupported-source' } })
    expect(await load(images, '69999999', 'thumb')).toEqual({ status: 'failed', error: { reason: 'no-image' } })
    expect(requests).toEqual([])
  })
})

describe('local-only list thumbnails', () => {
  it('does not fetch a missing image, even when refresh is requested; explicit original loads still fetch', async () => {
    seed([post('60000002', { path: '2022-07-21/local', ext: '.png' })])
    serveBytes('/thumb/2022-07-21/local.png', png(3, 2))
    serveBytes('/image/2022-07-21/local.png', png(6, 4))
    const images = service()
    const input = { viewId: 'history', postId: '60000002', kind: 'thumb' as const, refresh: true, localOnly: true }
    const outcome = await images.load('1', input, signal())
    expect(requests.map((request) => request.url)).toEqual([])
    expect(outcome).toEqual({ status: 'failed', error: { reason: 'not-stored' } })
    expect(await load(images, '60000002', 'original')).toMatchObject({ status: 'ready', image: { source: 'network', kind: 'original' } })
    expect(requests.map((request) => request.url)).toEqual(['/image/2022-07-21/local.png'])
  })

  it.each(['thumb', 'original'] as const)('reuses a stored %s and never repairs a missing file over the network', async (kind) => {
    seed([post('60000002', { path: '2022-07-21/cached', ext: '.png' })])
    serveBytes(`/${kind === 'thumb' ? 'thumb' : 'image'}/2022-07-21/cached.png`, png(6, 4))
    const images = service()
    const stored = await load(images, '60000002', kind)
    requests.length = 0
    const input = { viewId: 'offline', postId: '60000002', kind: 'thumb' as const, refresh: true, localOnly: true }
    expect(await images.load('1', input, signal())).toMatchObject({
      status: 'ready', image: { kind, source: 'stored', url: `xidao-image://file/${fileOf(stored)}` }
    })
    await files.remove(fileOf(stored))
    expect(await images.load('1', input, signal())).toEqual({ status: 'failed', error: { reason: 'not-stored' } })
    expect(requests.map((request) => request.url)).toEqual([])
  })
})

describe('managed files', () => {
  it('keeps the previous file and record when a refresh is interrupted mid-body', async () => {
    seed([post('60000002', { path: '2022-07-21/ok', ext: '.jpg' })])
    const original = jpeg(800, 600)
    serveBytes('/image/2022-07-21/ok.jpg', original)
    const images = service()
    const first = fileOf(await load(images, '60000002', 'original'))

    routes.set('/image/2022-07-21/ok.jpg', (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': original.length })
      response.write(original.subarray(0, 1000))
      setTimeout(() => response.socket?.destroy(), 20)
    })
    expect(await load(images, '60000002', 'original', 'view-a', true)).toEqual({ status: 'failed', error: { reason: 'network' } })
    expect(managedFiles()).toEqual([first])
    expect(readFileSync(join(files.directory, first))).toEqual(original)
    expect(await load(images, '60000002', 'original')).toMatchObject({ status: 'ready', image: { source: 'stored', url: `xidao-image://file/${first}` } })
  })

  it('replaces the stored file only after the new one is committed', async () => {
    seed([post('60000002', { path: '2022-07-21/ok', ext: '.jpg' })])
    serveBytes('/thumb/2022-07-21/ok.jpg', png(4, 4), 'image/png')
    const images = service()
    const first = fileOf(await load(images, '60000002', 'thumb'))
    serveBytes('/thumb/2022-07-21/ok.jpg', png(5, 5), 'image/png')
    const second = await load(images, '60000002', 'thumb', 'view-a', true)
    expect(second).toMatchObject({ status: 'ready', image: { width: 5, source: 'network' } })
    expect(fileOf(second)).not.toBe(first)
    expect(managedFiles()).toEqual([fileOf(second)])
  })

  it('keeps the previous file and leaves no new file when the record cannot be written', async () => {
    seed([post('60000002', { path: '2022-07-21/ok', ext: '.jpg' })])
    serveBytes('/thumb/2022-07-21/ok.jpg', png(4, 4), 'image/png')
    const first = fileOf(await load(service(), '60000002', 'thumb'))
    serveBytes('/thumb/2022-07-21/ok.jpg', png(5, 5), 'image/png')
    const failing: ReadingStore = { ...store, commitImageResource: async () => { throw new Error('disk full') } }
    expect(await load(service({ store: failing }), '60000002', 'thumb', 'view-a', true)).toEqual({ status: 'failed', error: { reason: 'storage' } })
    expect(managedFiles()).toEqual([first])
    expect(db.findImageResource('thumb', `${origin}/thumb/2022-07-21/ok.jpg`, null)).toMatchObject({ fileName: first, width: 4 })
  })

  it('records thumbnail and original as separate resources with their source and fetch time', async () => {
    seed([post('60000002', { path: '2022-07-21/both', ext: '.jpg' })])
    serveBytes('/thumb/2022-07-21/both.jpg', png(2, 2), 'image/png')
    serveBytes('/image/2022-07-21/both.jpg', jpeg(1200, 900))
    const images = service()
    await load(images, '60000002', 'thumb')
    await load(images, '60000002', 'original')
    const thumb = db.findImageResource('thumb', `${origin}/thumb/2022-07-21/both.jpg`, null)
    const full = db.findImageResource('original', `${origin}/image/2022-07-21/both.jpg`, null)
    expect(thumb).toMatchObject({ kind: 'thumb', format: 'png', width: 2 })
    expect(full).toMatchObject({ kind: 'original', format: 'jpeg', width: 1200 })
    expect(thumb?.fileName).not.toBe(full?.fileName)
    expect(Number.isNaN(Date.parse(full?.fetchedAt ?? ''))).toBe(false)
  })

  it('shares one download and one file between posts and views; cleanup removes it only when nobody holds it', async () => {
    seed([
      post('60000002', { path: '2022-07-21/same', ext: '.jpg' }),
      post('60000003', { path: '2022-07-21/same', ext: '.jpg' })
    ])
    serveBytes('/thumb/2022-07-21/same.jpg', png(2, 2), 'image/png')
    const images = service()
    const [a, b] = await Promise.all([load(images, '60000002', 'thumb', 'view-a'), load(images, '60000003', 'thumb', 'view-b')])
    expect(fileOf(a)).toBe(fileOf(b))
    expect(requests).toHaveLength(1)
    const resource = db.findImageResource('thumb', `${origin}/thumb/2022-07-21/same.jpg`, null)
    if (resource === null) throw new Error('resource missing')

    await images.releaseView('1', 'view-a')
    expect(await images.prune([resource.id])).toEqual([])
    expect(managedFiles()).toEqual([fileOf(a)])

    await images.releaseView('1', 'view-b')
    expect(await images.prune([resource.id])).toEqual([fileOf(a)])
    expect(managedFiles()).toEqual([])
    expect(db.listImageFileNames()).toEqual([])
  })

  it('a view released while its download runs does not hold the image afterwards', async () => {
    seed([post('60000002', { path: '2022-07-21/late', ext: '.jpg' })])
    const pending: { send?: () => void } = {}
    routes.set('/thumb/2022-07-21/late.jpg', (_request, response) => {
      pending.send = () => {
        const body = png(2, 2)
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length }).end(body)
      }
    })
    const images = service()
    const loading = load(images, '60000002', 'thumb', 'view-a')
    await expect.poll(() => pending.send !== undefined).toBe(true)
    await images.releaseView('1', 'view-a')
    pending.send?.()
    await loading
    const resource = db.findImageResource('thumb', `${origin}/thumb/2022-07-21/late.jpg`, null)
    expect(await images.prune([resource?.id ?? -1])).toHaveLength(1)
  })

  it('cancelling one waiter keeps the shared download; cancelling all aborts it and leaves no file', async () => {
    seed([post('60000002', { path: '2022-07-21/slow', ext: '.jpg' })])
    const body = jpeg(100, 100)
    const pending: { respond?: () => void } = {}
    routes.set('/image/2022-07-21/slow.jpg', (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': body.length })
      response.write(body.subarray(0, 10))
      pending.respond = () => response.end(body.subarray(10))
    })
    const images = service()
    const first = new AbortController()
    const second = new AbortController()
    const a = images.load('1', { viewId: 'view-a', postId: '60000002', kind: 'original', refresh: false }, first.signal)
    const b = images.load('1', { viewId: 'view-b', postId: '60000002', kind: 'original', refresh: false }, second.signal)
    await expect.poll(() => pending.respond !== undefined).toBe(true)
    first.abort()
    expect(await a).toEqual({ status: 'cancelled' })
    pending.respond?.()
    expect(await b).toMatchObject({ status: 'ready' })
    expect(requests).toHaveLength(1)

    pending.respond = undefined
    const third = new AbortController()
    const c = images.load('1', { viewId: 'view-a', postId: '60000002', kind: 'original', refresh: true }, third.signal)
    await expect.poll(() => pending.respond !== undefined).toBe(true)
    third.abort()
    expect(await c).toEqual({ status: 'cancelled' })
    await expect.poll(() => managedFiles().filter((name) => name.endsWith('.part'))).toEqual([])
    expect(managedFiles()).toHaveLength(1)
  })

  it('a new load right after the last waiter cancelled gets its own download, not the cancellation', async () => {
    seed([post('60000002', { path: '2022-07-21/reopen', ext: '.jpg' })])
    const body = jpeg(100, 100)
    const pending: { respond?: () => void } = {}
    routes.set('/image/2022-07-21/reopen.jpg', (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': body.length })
      response.write(body.subarray(0, 10))
      pending.respond = () => response.end(body.subarray(10))
    })
    const images = service()
    const closed = new AbortController()
    const first = images.load('1', { viewId: 'view-a', postId: '60000002', kind: 'original', refresh: false }, closed.signal)
    await expect.poll(() => requests.length).toBe(1)
    // The viewer closes and is reopened at once, while the abandoned download is still cleaning up.
    closed.abort()
    const reopened = images.load('1', { viewId: 'view-a', postId: '60000002', kind: 'original', refresh: false }, signal())
    expect(await first).toEqual({ status: 'cancelled' })
    await expect.poll(() => requests.length).toBe(2)
    pending.respond?.()
    expect(await reopened).toMatchObject({ status: 'ready', image: { kind: 'original', width: 100 } })
  })

  it('startup recovery removes leftovers and unrecorded files, clears reading holders, and never follows links', async () => {
    seed([post('60000002', { path: '2022-07-21/kept', ext: '.jpg' })])
    serveBytes('/thumb/2022-07-21/kept.jpg', png(2, 2), 'image/png')
    const kept = fileOf(await load(service(), '60000002', 'thumb'))
    const userFile = join(dir, 'user-picture.jpg')
    writeFileSync(userFile, 'user bytes')
    const leftover = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.part'
    const orphan = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jpg'
    const link = 'cccccccccccccccccccccccccccccccc.jpg'
    writeFileSync(join(files.directory, leftover), 'partial')
    writeFileSync(join(files.directory, orphan), 'orphan')
    writeFileSync(join(files.directory, 'notes.txt'), 'not ours')
    symlinkSync(userFile, join(files.directory, link))

    const restarted = service()
    await restarted.recover()
    expect(managedFiles()).toEqual([kept, link, 'notes.txt'].sort())
    expect(readFileSync(userFile, 'utf8')).toBe('user bytes')
    const resource = db.findImageResource('thumb', `${origin}/thumb/2022-07-21/kept.jpg`, null)
    // The previous run's reading holder is gone, so only now is the stored image unprotected.
    expect(await restarted.prune([resource?.id ?? -1])).toEqual([kept])
    expect(existsSync(userFile)).toBe(true)
  })
})

describe('saving the original', () => {
  it('saves only a stored original, never the thumbnail, and copies its exact bytes', async () => {
    seed([post('60000002', { path: '2022-06-18/62acedc59ef24', ext: '.png' })])
    const original = jpeg(640, 480)
    serveBytes('/thumb/2022-06-18/62acedc59ef24.png', png(2, 2), 'image/png')
    serveBytes('/image/2022-06-18/62acedc59ef24.png', original, 'image/png')
    const images = service()
    await load(images, '60000002', 'thumb')
    const target = join(dir, 'saved.jpg')
    const asked: string[] = []
    const choose = async (name: string) => {
      asked.push(name)
      return target
    }
    expect(await images.saveOriginal('60000002', choose)).toEqual({ status: 'not-loaded' })
    expect(asked).toEqual([])

    await load(images, '60000002', 'original')
    expect(await images.saveOriginal('60000002', async () => null)).toEqual({ status: 'cancelled' })
    expect(await images.saveOriginal('60000002', choose)).toEqual({ status: 'saved' })
    expect(asked).toEqual(['62acedc59ef24.jpg'])
    expect(readFileSync(target)).toEqual(original)
  })

  it('leaves an existing file unchanged when the copy cannot be written', async () => {
    seed([post('60000002', { path: '2022-07-21/s', ext: '.jpg' })])
    serveBytes('/image/2022-07-21/s.jpg', jpeg(10, 10))
    const images = service()
    await load(images, '60000002', 'original')
    const folder = join(dir, 'locked')
    mkdirSync(folder)
    const target = join(folder, 'existing.jpg')
    writeFileSync(target, 'existing')
    chmodSync(folder, 0o555)
    try {
      expect(await images.saveOriginal('60000002', async () => target)).toEqual({ status: 'failed' })
      expect(readFileSync(target, 'utf8')).toBe('existing')
      expect(readdirSync(folder)).toEqual(['existing.jpg'])
    } finally {
      chmodSync(folder, 0o755)
    }
  })
})
