import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, open, rename, unlink } from 'node:fs/promises'
import type { PostId, PostImage } from '../../shared/forum'
import {
  IMAGE_FORMAT_EXTENSION,
  IMAGE_SCHEME,
  type ImageError,
  type ImageFormat,
  type ImageKind,
  type ImageLoadOutcome,
  type ImageSaveOutcome,
  type LoadedImage
} from '../../shared/images'
import type { ImageHolder, ImageResourceRecord, ReadingStore } from '../storage/contract'
import type { ManagedImageFiles } from './files'
import { inspectImage } from './format'
import { ImageFetchCancelledError, ImageFetchError, type ImageDownloader } from './transport'

/** Forum image paths look like `2022-07-21/62d8ca6cdfabd` with an extension such as `.jpg`. */
const IMAGE_PATH = /^\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_]{1,64}$/
const IMAGE_EXT = /^(\.[A-Za-z0-9]{1,8})?$/

/** Byte limits per download; generous safety bounds, not the forum's (unverified) upload limits. */
export const MAX_IMAGE_BYTES: Record<ImageKind, number> = {
  thumb: 8 * 1024 * 1024,
  original: 64 * 1024 * 1024
}

export interface ImageLoadInput {
  viewId: string
  postId: PostId
  kind: ImageKind
  refresh: boolean
}

export interface ImageService {
  /** `owner` scopes view IDs to one renderer (its WebContents ID). */
  load(owner: string, input: ImageLoadInput, signal: AbortSignal): Promise<ImageLoadOutcome>
  releaseView(owner: string, viewId: string): Promise<void>
  /** The renderer navigated away or closed: none of its views holds images any more. */
  releaseOwner(owner: string): Promise<void>
  /** `choosePath` asks the user where to save (null: dismissed). */
  saveOriginal(postId: PostId, choosePath: (suggestedName: string, format: ImageFormat) => Promise<string | null>): Promise<ImageSaveOutcome>
  /**
   * Cleanup rule shared by every later cleanup (cache quota, manual clearing): removes the records
   * and files of those resources no holder protects. Returns the removed file names.
   */
  prune(resourceIds: number[]): Promise<string[]>
  /** Startup: reading holders of the previous run are gone; leftover and orphan files are removed. */
  recover(): Promise<void>
}

/** Thumbnails and originals share slots; a waiting original always starts before a waiting thumbnail. */
function createSlots(maxConcurrent: number) {
  const waiting: Record<ImageKind, Array<() => void>> = { original: [], thumb: [] }
  let running = 0
  const pump = (): void => {
    while (running < maxConcurrent) {
      const next = waiting.original.shift() ?? waiting.thumb.shift()
      if (!next) return
      running++
      next()
    }
  }
  return {
    acquire(kind: ImageKind, signal: AbortSignal): Promise<() => void> {
      const { promise, resolve, reject } = Promise.withResolvers<() => void>()
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        running--
        pump()
      }
      const start = (): void => {
        signal.removeEventListener('abort', onAbort)
        resolve(release)
      }
      const onAbort = (): void => {
        const queue = waiting[kind]
        const index = queue.indexOf(start)
        if (index >= 0) queue.splice(index, 1)
        reject(new ImageFetchCancelledError())
      }
      if (signal.aborted) return Promise.reject(new ImageFetchCancelledError())
      signal.addEventListener('abort', onAbort, { once: true })
      waiting[kind].push(start)
      pump()
      return promise
    }
  }
}

interface Flight {
  kind: ImageKind
  /** Holder ID → number of waiting loads from that holder. */
  holders: Map<string, number>
  waiters: number
  controller: AbortController
  result: Promise<ImageResourceRecord>
}

export function createImageService(options: {
  store: ReadingStore
  files: ManagedImageFiles
  download: ImageDownloader
  /** Image server origin, e.g. `https://image.nmb.best`. */
  origin: string
  maxConcurrent?: number
  now?: () => Date
}): ImageService {
  const { store, files, download, origin } = options
  const now = options.now ?? (() => new Date())
  const slots = createSlots(options.maxConcurrent ?? 4)
  const flights = new Map<string, Flight>()
  /** Reading holders of mounted views; a download finishing after its view closed does not hold for it. */
  const activeHolders = new Set<string>()

  const holderId = (owner: string, viewId: string) => `${owner}:${viewId}:`
  const reading = (id: string): ImageHolder => ({ kind: 'reading', id })

  function sourceUrl(image: PostImage, kind: ImageKind): string | null {
    if (!IMAGE_PATH.test(image.path) || !IMAGE_EXT.test(image.ext)) return null
    return `${origin}/${kind === 'thumb' ? 'thumb' : 'image'}/${image.path}${image.ext}`
  }

  async function storedPath(resource: ImageResourceRecord): Promise<string | null> {
    const path = files.pathOf(resource.fileName)
    if (path === null) return null
    try {
      const stat = await lstat(path)
      return stat.isFile() && stat.size === resource.bytes ? path : null
    } catch {
      return null
    }
  }

  function loaded(resource: ImageResourceRecord, source: LoadedImage['source']): ImageLoadOutcome {
    return {
      status: 'ready',
      image: {
        kind: resource.kind,
        url: `${IMAGE_SCHEME}://file/${resource.fileName}`,
        format: resource.format,
        width: resource.width,
        height: resource.height,
        bytes: resource.bytes,
        fetchedAt: resource.fetchedAt,
        source
      }
    }
  }

  async function fetchResource(flight: Flight, url: string): Promise<ImageResourceRecord> {
    const { signal } = flight.controller
    const release = await slots.acquire(flight.kind, signal)
    const partial = files.partialPath()
    let committedName: string | null = null
    try {
      const { bytes } = await download(new URL(url), partial, MAX_IMAGE_BYTES[flight.kind], signal)
      let handle
      try {
        handle = await open(partial, 'r')
      } catch {
        throw new ImageFetchError({ reason: 'storage' })
      }
      const inspection = await inspectImage(handle, bytes).finally(() => handle.close())
      if (!inspection.ok) throw new ImageFetchError({ reason: inspection.reason })
      if (signal.aborted) throw new ImageFetchCancelledError()
      try {
        committedName = await files.commit(partial, inspection.format)
      } catch {
        throw new ImageFetchError({ reason: 'storage' })
      }
      // The file is in place; its record makes it visible. Until then the previous file and record
      // of this resource stay untouched.
      const holders = [...flight.holders.keys()].filter((id) => activeHolders.has(id)).map(reading)
      let committed
      try {
        committed = await store.commitImageResource({
          kind: flight.kind,
          sourceUrl: url,
          fileName: committedName,
          format: inspection.format,
          bytes,
          width: inspection.width,
          height: inspection.height,
          fetchedAt: now().toISOString()
        }, holders)
      } catch {
        await files.remove(committedName).catch(() => undefined)
        throw new ImageFetchError({ reason: 'storage' })
      }
      if (committed.replacedFileName !== null) await files.remove(committed.replacedFileName).catch(() => undefined)
      return committed.resource
    } finally {
      release()
      if (committedName === null) await files.remove(partial).catch(() => undefined)
    }
  }

  /**
   * Joins (or starts) the single download of `kind` + `url`; cancelling the last waiter aborts it.
   * An aborted download may still be cleaning up: a new load starts its own download instead.
   */
  function joinFlight(key: string, kind: ImageKind, url: string, holder: string, signal: AbortSignal): Promise<ImageLoadOutcome> {
    let flight = flights.get(key)
    if (!flight || flight.controller.signal.aborted) {
      const created: Flight = { kind, holders: new Map(), waiters: 0, controller: new AbortController(), result: null as never }
      created.result = fetchResource(created, url).finally(() => {
        if (flights.get(key) === created) flights.delete(key)
      })
      // Waiters handle the outcome; this keeps an abandoned flight from reporting an unhandled rejection.
      created.result.catch(() => undefined)
      flights.set(key, created)
      flight = created
    }
    const current = flight
    current.waiters++
    current.holders.set(holder, (current.holders.get(holder) ?? 0) + 1)
    const leave = (): void => {
      current.waiters--
      const count = (current.holders.get(holder) ?? 1) - 1
      if (count === 0) current.holders.delete(holder)
      else current.holders.set(holder, count)
      if (current.waiters === 0) current.controller.abort()
    }
    const { promise, resolve } = Promise.withResolvers<ImageLoadOutcome>()
    const onAbort = (): void => {
      leave()
      resolve({ status: 'cancelled' })
    }
    if (signal.aborted) {
      onAbort()
      return promise
    }
    signal.addEventListener('abort', onAbort, { once: true })
    current.result.then(
      (resource) => {
        if (signal.aborted) return
        signal.removeEventListener('abort', onAbort)
        resolve(loaded(resource, 'network'))
      },
      (error: unknown) => {
        if (signal.aborted) return
        signal.removeEventListener('abort', onAbort)
        const failure: ImageError = error instanceof ImageFetchError ? error.error : { reason: 'network' }
        resolve(error instanceof ImageFetchCancelledError ? { status: 'cancelled' } : { status: 'failed', error: failure })
      }
    )
    return promise
  }

  return {
    async load(owner, input, signal) {
      if (signal.aborted) return { status: 'cancelled' }
      const holder = holderId(owner, input.viewId)
      activeHolders.add(holder)
      let image: PostImage | null
      try {
        image = await store.getPostImage(input.postId)
      } catch {
        return { status: 'failed', error: { reason: 'storage' } }
      }
      if (image === null) return { status: 'failed', error: { reason: 'no-image' } }
      const url = sourceUrl(image, input.kind)
      if (url === null) return { status: 'failed', error: { reason: 'unsupported-source' } }
      if (!input.refresh) {
        let stored: ImageResourceRecord | null
        try {
          // Checked when the request is queued: a release queued later runs after it in the worker.
          stored = await store.findImageResource(input.kind, url, activeHolders.has(holder) ? reading(holder) : null)
        } catch {
          return { status: 'failed', error: { reason: 'storage' } }
        }
        if (stored !== null && (await storedPath(stored)) !== null) {
          return signal.aborted ? { status: 'cancelled' } : loaded(stored, 'stored')
        }
      }
      return joinFlight(`${input.kind}|${url}`, input.kind, url, holder, signal)
    },

    async releaseView(owner, viewId) {
      const holder = holderId(owner, viewId)
      activeHolders.delete(holder)
      await store.releaseImageHolders('reading', holder).catch(() => undefined)
    },

    async releaseOwner(owner) {
      const prefix = `${owner}:`
      for (const holder of activeHolders) if (holder.startsWith(prefix)) activeHolders.delete(holder)
      await store.releaseImageHolders('reading', prefix).catch(() => undefined)
    },

    async saveOriginal(postId, choosePath) {
      let path: string | null = null
      let suggested = ''
      let format: ImageFormat = 'jpeg'
      try {
        const image = await store.getPostImage(postId)
        const url = image === null ? null : sourceUrl(image, 'original')
        const resource = url === null ? null : await store.findImageResource('original', url, null)
        if (image !== null && resource !== null) {
          path = await storedPath(resource)
          format = resource.format
          suggested = `${image.path.slice(image.path.lastIndexOf('/') + 1)}.${IMAGE_FORMAT_EXTENSION[format]}`
        }
      } catch {
        path = null
      }
      if (path === null) return { status: 'not-loaded' }
      const destination = await choosePath(suggested, format)
      if (destination === null) return { status: 'cancelled' }
      // Copy beside the destination first: an existing file there is only replaced by a complete copy.
      const partial = `${destination}.${randomBytes(6).toString('hex')}.xidao-part`
      try {
        await copyFile(path, partial, constants.COPYFILE_EXCL)
        await rename(partial, destination)
        return { status: 'saved' }
      } catch {
        await unlink(partial).catch(() => undefined)
        return { status: 'failed' }
      }
    },

    async prune(resourceIds) {
      const names = await store.deleteUnheldImages(resourceIds)
      // A file that cannot be removed now has no record any more; the startup sweep removes it.
      for (const name of names) await files.remove(name).catch(() => undefined)
      return names
    },

    async recover() {
      if (store.status.state !== 'ready') return
      await store.releaseImageHolders('reading', '')
      await files.sweep(new Set(await store.listImageFileNames()))
    }
  }
}
