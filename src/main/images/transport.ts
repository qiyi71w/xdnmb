import { createWriteStream } from 'node:fs'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { pipeline, Transform } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { ImageError } from '../../shared/images'

export class ImageFetchError extends Error {
  override readonly name = 'ImageFetchError'
  constructor(readonly error: ImageError) {
    super(`image fetch failed: ${error.reason}`)
  }
}

export class ImageFetchCancelledError extends Error {
  override readonly name = 'ImageFetchCancelledError'
}

export interface ImageDownload {
  bytes: number
}

/**
 * Downloads one image into `destination` (created exclusively). Fails with ImageFetchError or
 * ImageFetchCancelledError; on any failure the caller removes the partial file.
 */
export type ImageDownloader = (url: URL, destination: string, maxBytes: number, signal: AbortSignal) => Promise<ImageDownload>

/**
 * Image requests: GET only to the allowed image origins, with no cookies, credentials or forum
 * identity of any kind; redirects are reported, never followed. The body streams straight to disk
 * under a byte limit; a body shorter than its Content-Length is a network failure.
 */
export function createImageDownloader(options: {
  allowedOrigins: readonly string[]
  timeoutMs?: number
  idleTimeoutMs?: number
  userAgent?: string
}): ImageDownloader {
  const origins = new Set(options.allowedOrigins)
  const timeoutMs = options.timeoutMs ?? 180_000
  const idleTimeoutMs = options.idleTimeoutMs ?? 20_000

  return (url, destination, maxBytes, signal) => {
    if (!origins.has(url.origin) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return Promise.reject(new ImageFetchError({ reason: 'unsupported-source' }))
    }
    if (signal.aborted) return Promise.reject(new ImageFetchCancelledError())

    const { promise, resolve, reject } = Promise.withResolvers<ImageDownload>()
    let settled = false
    let request: ClientRequest | undefined
    let response: IncomingMessage | undefined
    const cleanup = (): void => {
      clearTimeout(deadline)
      signal.removeEventListener('abort', abort)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      request?.destroy()
      response?.destroy()
      reject(error)
    }
    const failWith = (error: ImageError): void => fail(new ImageFetchError(error))
    const abort = (): void => fail(new ImageFetchCancelledError())
    const deadline = setTimeout(() => failWith({ reason: 'timeout' }), timeoutMs)
    signal.addEventListener('abort', abort, { once: true })

    try {
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest
      request = send(url, {
        method: 'GET',
        headers: {
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5',
          'Accept-Encoding': 'identity',
          'User-Agent': options.userAgent ?? 'Xidao/0.1'
        }
      }, (incoming) => {
        response = incoming
        if (settled) { incoming.destroy(); return }
        incoming.on('error', () => failWith({ reason: 'network' }))
        const httpStatus = incoming.statusCode ?? 0
        if (httpStatus !== 200) {
          failWith(httpStatus >= 300 && httpStatus < 400 ? { reason: 'redirect', httpStatus } : { reason: 'http-status', httpStatus })
          return
        }
        const declared = Number(incoming.headers['content-length'])
        if (Number.isFinite(declared) && declared > maxBytes) {
          failWith({ reason: 'too-large' })
          return
        }
        const encoding = incoming.headers['content-encoding']?.trim().toLowerCase() ?? 'identity'
        const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip()
          : encoding === 'deflate' ? createInflate()
            : encoding === 'br' ? createBrotliDecompress()
              : encoding === 'identity' ? null : undefined
        if (decoder === undefined) {
          failWith({ reason: 'not-image' })
          return
        }
        let received = 0
        let written = 0
        const countRaw = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length
            callback(null, chunk)
          }
        })
        const limit = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            written += chunk.length
            if (written > maxBytes) {
              const error = new ImageFetchError({ reason: 'too-large' })
              fail(error)
              callback(error)
            } else callback(null, chunk)
          }
        })
        const file = createWriteStream(destination, { flags: 'wx', flush: true })
        let fileError = false
        file.on('error', () => { fileError = true })
        const complete = (error: NodeJS.ErrnoException | null): void => {
          if (settled) return
          if (fileError) { failWith({ reason: 'storage' }); return }
          if (error) { failWith({ reason: decoder !== null && error.code?.startsWith('Z_') ? 'not-image' : 'network' }); return }
          if (!incoming.complete || (Number.isFinite(declared) && received !== declared)) {
            failWith({ reason: 'network' })
            return
          }
          if (written === 0) { failWith({ reason: 'not-image' }); return }
          settled = true
          cleanup()
          resolve({ bytes: written })
        }
        if (decoder) pipeline(incoming, countRaw, decoder, limit, file, complete)
        else pipeline(incoming, countRaw, limit, file, complete)
      })
      request.setTimeout(idleTimeoutMs, () => failWith({ reason: 'timeout' }))
      request.on('error', () => failWith({ reason: 'network' }))
      request.end()
    } catch {
      failWith({ reason: 'network' })
    }
    return promise
  }
}
