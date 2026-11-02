import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import {
  ANALYTICS_INSTANCE_ID_PATTERN,
  ANALYTICS_MAX_BODY_BYTES,
  ANALYTICS_PATHS,
  ANALYTICS_PLATFORMS,
  ANALYTICS_PROTOCOL_VERSION,
  ANALYTICS_TOKEN_PATTERN,
  ANALYTICS_VERSION_PATTERN
} from '../../src/shared/analytics-protocol.ts'
import type {
  AnalyticsActivityResponse,
  AnalyticsCredentials,
  AnalyticsErrorCode,
  AnalyticsPlatform,
  AnalyticsRegisterResponse
} from '../../src/shared/analytics-protocol.ts'
import type { AdminAuthenticator } from './auth.ts'
import { statDayAt } from './days.ts'
import { isJsonObject } from './json.ts'
import type { AnalyticsStore, AnalyticsSummary } from './store.ts'

export interface BucketLimit {
  capacity: number
  perMinute: number
}

/**
 * Process-wide token buckets. They deliberately do not key on IP addresses or any client
 * fingerprint: the service never tracks who is sending, only how much is being sent.
 */
export interface RateLimits {
  register: BucketLimit
  selfOperations: BucketLimit
  adminFailures: BucketLimit
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  register: { capacity: 20, perMinute: 20 },
  selfOperations: { capacity: 300, perMinute: 300 },
  adminFailures: { capacity: 10, perMinute: 5 }
}

export interface DashboardAsset {
  contentType: string
  body: Buffer
}

/**
 * Operational events only. Fields never carry request bodies, identifiers, credentials,
 * addresses or client headers.
 */
export type AnalyticsLogger = (event: string, fields?: Record<string, string | number>) => void

export interface AnalyticsServiceOptions {
  store: AnalyticsStore
  admin: AdminAuthenticator
  clock: () => number
  log: AnalyticsLogger
  /** Dashboard files keyed by request path, e.g. `/admin/`. */
  dashboard: ReadonlyMap<string, DashboardAsset>
  maxInstances: number
  limits?: RateLimits
}

export interface AnalyticsService {
  server: Server
  /** Records today as a service day and applies retention once per statistics day. */
  maintain(): void
  close(): Promise<void>
}

/** Admin summary payload consumed by the dashboard. */
export interface AdminSummaryResponse extends AnalyticsSummary {
  generatedAt: string
  timeZone: 'Asia/Shanghai'
}

interface TokenBucket {
  /** Seconds until a request may proceed; 0 when it may proceed now. */
  wait(): number
  /** Consumes one token; returns seconds to wait when none is available. */
  take(): number
  /** Returns a token taken for work that turned out not to count against the limit. */
  give(): void
}

type PublicHandler = (body: Record<string, unknown>, response: ServerResponse) => void

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
}
const DASHBOARD_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
  "img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const MAINTENANCE_INTERVAL_MS = 60 * 1000

export function createAnalyticsService(options: AnalyticsServiceOptions): AnalyticsService {
  const { store, clock, log } = options
  const limits = options.limits ?? DEFAULT_RATE_LIMITS
  const buckets = {
    register: createBucket(limits.register, clock),
    selfOperations: createBucket(limits.selfOperations, clock),
    adminFailures: createBucket(limits.adminFailures, clock)
  }
  let maintainedDay: string | undefined

  function maintain(): void {
    const today = statDayAt(clock())
    if (today === maintainedDay) return
    store.markServiceDay(today)
    const removed = store.cleanup(today)
    maintainedDay = today
    log('retention_applied', { day: today, ...removed })
  }

  function maintainSafely(): void {
    try {
      maintain()
    } catch (error) {
      logFailure(log, 'maintenance', error)
    }
  }

  const publicRoutes = new Map<string, { bucket: TokenBucket; handle: PublicHandler }>([
    [ANALYTICS_PATHS.register, {
      bucket: buckets.register,
      handle(body, response) {
        const problem = checkFields(body, ['protocol'])
        if (problem) return sendError(response, 400, problem)
        const result = store.register(statDayAt(clock()), options.maxInstances)
        if (result.kind === 'capacity_exhausted') return sendError(response, 503, 'capacity_exhausted')
        sendJson(response, 201, result.credentials satisfies AnalyticsRegisterResponse)
      }
    }],
    [ANALYTICS_PATHS.activity, {
      bucket: buckets.selfOperations,
      handle(body, response) {
        const problem = checkFields(body, ['protocol', 'instanceId', 'token', 'version', 'platform'])
        const credentials = readCredentials(body)
        const { version, platform } = body
        if (problem || !credentials || typeof version !== 'string' || !ANALYTICS_VERSION_PATTERN.test(version) ||
            !ANALYTICS_PLATFORMS.includes(platform as AnalyticsPlatform)) {
          return sendError(response, 400, problem ?? 'invalid_request')
        }
        // The statistics day always comes from the server clock; clients cannot backfill.
        const statDay = statDayAt(clock())
        const result = store.recordActivity(statDay, credentials, version, platform as AnalyticsPlatform)
        if (result.kind === 'invalid_credentials') return sendError(response, 403, 'invalid_credentials')
        sendJson(response, 200, { statDay, duplicate: result.duplicate } satisfies AnalyticsActivityResponse)
      }
    }]
  ])

  async function handlePublic(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    const route = publicRoutes.get(path)
    if (!route) return sendError(response, 404, 'not_found')
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST')
      return sendError(response, 405, 'method_not_allowed')
    }
    const wait = route.bucket.take()
    if (wait > 0) {
      response.setHeader('Retry-After', String(wait))
      return sendError(response, 429, 'rate_limited')
    }
    const mediaType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
    if (mediaType !== 'application/json') return sendError(response, 415, 'unsupported_media_type')
    const body = await readBody(request)
    if (body === 'aborted') return
    if (body === 'too_large') {
      response.setHeader('Connection', 'close')
      return sendError(response, 413, 'payload_too_large')
    }
    let value: unknown
    try {
      value = JSON.parse(body.toString('utf8'))
    } catch {
      return sendError(response, 400, 'invalid_request')
    }
    if (!isJsonObject(value)) return sendError(response, 400, 'invalid_request')
    route.handle(value, response)
  }

  async function handleAdmin(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    // Every /admin path is checked before routing, so unknown paths reveal nothing either.
    const check = await options.admin.check(request.headers.authorization, {
      reserve: () => buckets.adminFailures.take() === 0,
      refund: () => buckets.adminFailures.give()
    })
    if (check === 'throttled') {
      response.setHeader('Retry-After', String(buckets.adminFailures.wait()))
      return sendText(response, 429, '登录尝试过多，请稍后再试。')
    }
    if (check !== 'ok') {
      // The failed check already used its reserved token.
      response.setHeader('WWW-Authenticate', 'Basic realm="Xidao analytics", charset="UTF-8"')
      return sendText(response, 401, '需要作者登录后查看统计。')
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET')
      return sendText(response, 405, '不支持的请求方法。')
    }
    if (path === '/admin') {
      response.setHeader('Location', '/admin/')
      return sendText(response, 308, '/admin/')
    }
    if (path === '/admin/api/summary') {
      const now = clock()
      const summary: AdminSummaryResponse = {
        ...store.summary(statDayAt(now)),
        generatedAt: new Date(now).toISOString(),
        timeZone: 'Asia/Shanghai'
      }
      return sendJson(response, 200, summary)
    }
    const asset = options.dashboard.get(path)
    if (!asset) return sendText(response, 404, '没有这个页面。')
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': asset.contentType,
      'Content-Security-Policy': DASHBOARD_POLICY,
      'X-Frame-Options': 'DENY'
    })
    response.end(asset.body)
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://analytics.invalid').pathname
    maintainSafely()
    if (path === '/admin' || path.startsWith('/admin/')) return handleAdmin(request, response, path)
    return handlePublic(request, response, path)
  }

  const server = createServer({
    requestTimeout: 15_000,
    headersTimeout: 10_000,
    keepAliveTimeout: 5_000,
    maxHeaderSize: 8 * 1024
  }, (request, response) => {
    handle(request, response).catch((error: unknown) => {
      logFailure(log, 'request', error)
      if (!response.headersSent) sendError(response, 500, 'server_error')
      else response.destroy()
    })
  })
  server.maxConnections = 256
  server.maxRequestsPerSocket = 100

  const timer = setInterval(maintainSafely, MAINTENANCE_INTERVAL_MS)
  timer.unref()

  return {
    server,
    maintain,
    close() {
      clearInterval(timer)
      const { promise, resolve } = Promise.withResolvers<void>()
      server.close(() => resolve())
      server.closeAllConnections()
      return promise
    }
  }
}

/** Returns the error code for a body whose keys differ from `fields`, or for an unknown protocol. */
function checkFields(body: Record<string, unknown>, fields: readonly string[]): AnalyticsErrorCode | undefined {
  if (Object.hasOwn(body, 'protocol') && body.protocol !== ANALYTICS_PROTOCOL_VERSION) return 'unsupported_protocol'
  const keys = Object.keys(body)
  if (keys.length !== fields.length || !fields.every((field) => Object.hasOwn(body, field))) return 'invalid_request'
  return undefined
}

function readCredentials(body: Record<string, unknown>): AnalyticsCredentials | undefined {
  const { instanceId, token } = body
  if (typeof instanceId !== 'string' || !ANALYTICS_INSTANCE_ID_PATTERN.test(instanceId)) return undefined
  if (typeof token !== 'string' || !ANALYTICS_TOKEN_PATTERN.test(token)) return undefined
  return { instanceId, token }
}

/** Reads at most the protocol limit; an oversized remainder is drained, not buffered. */
function readBody(request: IncomingMessage): Promise<Buffer | 'too_large' | 'aborted'> {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > ANALYTICS_MAX_BODY_BYTES) {
    request.resume()
    return Promise.resolve('too_large')
  }
  const { promise, resolve } = Promise.withResolvers<Buffer | 'too_large' | 'aborted'>()
  const chunks: Buffer[] = []
  let size = 0
  const onData = (chunk: Buffer): void => {
    size += chunk.length
    if (size <= ANALYTICS_MAX_BODY_BYTES) return void chunks.push(chunk)
    request.off('data', onData)
    request.resume()
    resolve('too_large')
  }
  request.on('data', onData)
  request.once('end', () => resolve(Buffer.concat(chunks)))
  // A client that disconnects mid-body gets no response; settling first wins.
  request.once('close', () => resolve('aborted'))
  request.once('error', () => resolve('aborted'))
  return promise
}

function createBucket(limit: BucketLimit, clock: () => number): TokenBucket {
  let tokens = limit.capacity
  let updatedAt = clock()
  const refill = (): void => {
    const now = clock()
    // A clock stepping backwards never grants extra tokens.
    tokens = Math.min(limit.capacity, tokens + Math.max(0, now - updatedAt) * limit.perMinute / 60_000)
    updatedAt = now
  }
  const secondsUntilToken = (): number => tokens >= 1 ? 0 : Math.max(1, Math.ceil((1 - tokens) * 60 / limit.perMinute))
  return {
    wait() {
      refill()
      return secondsUntilToken()
    },
    take() {
      refill()
      const wait = secondsUntilToken()
      if (wait === 0) tokens -= 1
      return wait
    },
    give() {
      refill()
      tokens = Math.min(limit.capacity, tokens + 1)
    }
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function sendError(response: ServerResponse, status: number, error: AnalyticsErrorCode): void {
  sendJson(response, status, { error })
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
  response.end(text)
}

/** Logs only the error class and code: messages may echo request content. */
function logFailure(log: AnalyticsLogger, area: string, error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error
  const code = isJsonObject(error) && typeof error.code === 'string' ? error.code : 'none'
  log('failure', { area, error: name, code })
}
