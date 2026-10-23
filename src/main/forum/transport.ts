import { request as httpRequest } from 'node:http'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { pipeline, Transform, Writable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { ReadError } from '../../shared/api'
import { ForumReadError, ReadCancelledError } from './contract'
import type { ForumTransport, TransportResponse } from './contract'

export function createForumTransport(options: {
  allowedOrigins: readonly string[]
  timeoutMs?: number
  maxCompressedBytes?: number
  maxDecodedBytes?: number
  userAgent?: string
}): ForumTransport {
  const origins = new Set(options.allowedOrigins)
  const timeoutMs = options.timeoutMs ?? 20_000
  const maxCompressedBytes = options.maxCompressedBytes ?? 4 * 1024 * 1024
  const maxDecodedBytes = options.maxDecodedBytes ?? 16 * 1024 * 1024
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      !Number.isSafeInteger(maxCompressedBytes) || maxCompressedBytes < 0 ||
      !Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 0) {
    throw new Error('Invalid forum transport limits')
  }

  return {
    async get(url, signal) {
      if (!origins.has(url.origin) || !['http:', 'https:'].includes(url.protocol) ||
          url.username || url.password) {
        throw new Error('Forum transport target is not allowed')
      }
      if (signal.aborted) throw new ReadCancelledError()

      const { promise, resolve, reject } = Promise.withResolvers<TransportResponse>()
      let settled = false
      let request: ClientRequest | undefined
      let response: IncomingMessage | undefined
      let decoder: Transform | undefined
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
        decoder?.destroy()
        reject(error)
      }
      const classified = (error: ReadError): void => fail(new ForumReadError(error))
      const abort = (): void => fail(new ReadCancelledError())
      const deadline = setTimeout(() => classified({ kind: 'network', detail: 'timeout' }), timeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) { abort(); return promise }

      try {
        const send = url.protocol === 'https:' ? httpsRequest : httpRequest
        request = send(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip, deflate, br',
            'User-Agent': options.userAgent ?? 'Xidao/0.1'
          }
        }, (incoming) => {
          response = incoming
          if (settled) { incoming.destroy(); return }
          incoming.on('error', () => classified({ kind: 'network', detail: 'connection' }))
          const httpStatus = incoming.statusCode ?? 0
          if (httpStatus !== 200) {
            const detail = httpStatus >= 300 && httpStatus < 400 ? 'redirect' : 'http-status'
            const kind = detail === 'redirect' ? 'unknown-structure'
              : httpStatus === 429 ? 'rate-limited'
                : httpStatus === 401 || httpStatus === 403 ? 'permission'
                  : httpStatus === 404 ? 'not-found' : 'network'
            classified({ kind, detail, httpStatus })
            return
          }

          const encoding = incoming.headers['content-encoding']?.trim().toLowerCase() ?? 'identity'
          if (encoding === 'gzip' || encoding === 'x-gzip') decoder = createGunzip()
          else if (encoding === 'deflate') decoder = createInflate()
          else if (encoding === 'br') decoder = createBrotliDecompress()
          else if (encoding !== 'identity') {
            classified({ kind: 'unknown-structure', detail: 'decode' })
            return
          }
          decoder?.on('error', () => classified({ kind: 'unknown-structure', detail: 'decode' }))
          let compressedBytes = 0
          let decodedBytes = 0
          const chunks: Buffer[] = []
          const countRaw = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              compressedBytes += chunk.length
              if (compressedBytes > maxCompressedBytes) {
                const error = new ForumReadError({ kind: 'unknown-structure', detail: 'too-large' })
                fail(error)
                callback(error)
              } else callback(null, chunk)
            }
          })
          const collect = new Writable({
            write(chunk: Buffer, _encoding, callback) {
              decodedBytes += chunk.length
              if (decodedBytes > maxDecodedBytes) {
                const error = new ForumReadError({ kind: 'unknown-structure', detail: 'too-large' })
                fail(error)
                callback(error)
              } else {
                chunks.push(chunk)
                callback()
              }
            }
          })
          const complete = (error: NodeJS.ErrnoException | null): void => {
            if (settled) return
            if (error) {
              classified({ kind: 'network', detail: 'connection' })
              return
            }
            const contentType = incoming.headers['content-type'] ?? ''
            const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() || null
            const charset = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/i.exec(contentType)
            try {
              const text = new TextDecoder(charset?.[1] ?? charset?.[2] ?? charset?.[3] ?? 'utf-8', {
                fatal: true
              }).decode(Buffer.concat(chunks, decodedBytes))
              settled = true
              cleanup()
              resolve({ mediaType, text })
            } catch {
              classified({ kind: 'unknown-structure', detail: 'decode' })
            }
          }
          if (decoder) pipeline(incoming, countRaw, decoder, collect, complete)
          else pipeline(incoming, countRaw, collect, complete)
        })
        request.on('error', () => classified({ kind: 'network', detail: 'connection' }))
        request.end()
      } catch {
        classified({ kind: 'network', detail: 'connection' })
      }
      return promise
    }
  }
}
