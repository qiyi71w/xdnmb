import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { ANALYTICS_MAX_BODY_BYTES, ANALYTICS_PATHS } from '../../shared/analytics-protocol'

export type AnalyticsPath = (typeof ANALYTICS_PATHS)[keyof typeof ANALYTICS_PATHS]

export interface AnalyticsResponse {
  status: number
  /** Parsed JSON body; `null` when absent or not JSON. */
  body: unknown
  /** `Retry-After` in seconds, when the service sent a usable one. */
  retryAfterSeconds: number | null
}

/** No usable response: connection failure, timeout or an oversized answer. */
export class AnalyticsNetworkError extends Error {
  override readonly name = 'AnalyticsNetworkError'
}

/** The caller's signal stopped the request. */
export class AnalyticsCancelledError extends Error {
  override readonly name = 'AnalyticsCancelledError'
}

export interface AnalyticsTransport {
  post(path: AnalyticsPath, body: object, signal: AbortSignal): Promise<AnalyticsResponse>
}

/** Answers are tiny JSON objects; anything larger is not the statistics service. */
const MAX_RESPONSE_BYTES = 4096
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * The receiving service's origin from build configuration, or `null` when absent or not acceptable:
 * HTTPS, or plain HTTP only to this machine (isolated development and acceptance services). A bare
 * origin only: no path, query, fragment or credentials.
 */
export function analyticsOrigin(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null
  let url: URL
  try { url = new URL(raw.trim()) } catch { return null }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null
  if (url.protocol === 'https:') return url.origin
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url.origin
  return null
}

/**
 * POSTs JSON to one fixed origin. No cookies, no redirects followed (a redirect is just a status),
 * identifiers and credentials only in the body; the renderer never supplies a URL.
 */
export function createAnalyticsTransport(options: { origin: string; timeoutMs: number; userAgent: string }): AnalyticsTransport {
  const origin = analyticsOrigin(options.origin)
  if (origin === null) throw new Error('Invalid analytics origin')
  const paths = new Set<string>(Object.values(ANALYTICS_PATHS))

  return {
    post(path, body, signal) {
      if (!paths.has(path)) return Promise.reject(new Error('Analytics path is not allowed'))
      const payload = Buffer.from(JSON.stringify(body), 'utf8')
      if (payload.length > ANALYTICS_MAX_BODY_BYTES) return Promise.reject(new Error('Analytics request too large'))
      if (signal.aborted) return Promise.reject(new AnalyticsCancelledError())
      const url = new URL(path, origin)

      const { promise, resolve, reject } = Promise.withResolvers<AnalyticsResponse>()
      let settled = false
      let request: ClientRequest | undefined
      let response: IncomingMessage | undefined
      const finish = (error: Error | null, value?: AnalyticsResponse): void => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        signal.removeEventListener('abort', abort)
        if (error !== null) {
          request?.destroy()
          response?.destroy()
          reject(error)
        } else if (value !== undefined) resolve(value)
      }
      const abort = (): void => finish(new AnalyticsCancelledError())
      const deadline = setTimeout(() => finish(new AnalyticsNetworkError('timeout')), options.timeoutMs)
      signal.addEventListener('abort', abort, { once: true })

      try {
        const send = url.protocol === 'https:' ? httpsRequest : httpRequest
        request = send(url, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'Content-Length': String(payload.length),
            'User-Agent': options.userAgent
          }
        }, (incoming) => {
          response = incoming
          if (settled) { incoming.destroy(); return }
          const encoding = incoming.headers['content-encoding']?.trim().toLowerCase() ?? 'identity'
          if (encoding !== 'identity') { finish(new AnalyticsNetworkError('encoding')); return }
          const chunks: Buffer[] = []
          let size = 0
          incoming.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_RESPONSE_BYTES) finish(new AnalyticsNetworkError('too-large'))
            else chunks.push(chunk)
          })
          incoming.on('error', () => finish(new AnalyticsNetworkError('connection')))
          incoming.on('end', () => {
            let parsed: unknown = null
            try { parsed = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) } catch { /* Not JSON: status only. */ }
            const retryAfter = Number(incoming.headers['retry-after'])
            finish(null, {
              status: incoming.statusCode ?? 0,
              body: parsed,
              retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null
            })
          })
        })
        request.on('error', () => finish(new AnalyticsNetworkError('connection')))
        request.end(payload)
      } catch {
        finish(new AnalyticsNetworkError('connection'))
      }
      return promise
    }
  }
}
