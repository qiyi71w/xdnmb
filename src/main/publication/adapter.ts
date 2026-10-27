import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { pipeline, Transform, Writable } from 'node:stream'
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib'
import { Parser } from 'htmlparser2'
import type { DraftSaveInput } from '../../shared/drafts'
import type { ContentNode } from '../../shared/forum'
import type { PublicationProblem } from '../../shared/publication'
import { parseContent, submittedText } from '../forum/content'
import { createForumClient } from '../forum/client'
import { createForumTransport } from '../forum/transport'
import { userhashCookieValue } from '../forum/userhash'
import { PUBLISH_DEADLINE_MS, type PublicationAdapter, type PublishReport } from './contract'

const COOKIE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/
const ID = /^[1-9]\d{0,19}$/
const MEDIA: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

interface Response { status: number; text: string }
/** The request never reached the forum: nothing was sent, so the send failed for certain. */
class NotSent extends Error {
  constructor(readonly problem: PublicationProblem) { super(problem) }
}

/** Bounded, streamed response decoding; never follows a redirect or includes response text in errors. */
function receive(response: IncomingMessage, done: (result: Response) => void, fail: () => void): void {
  const encoding = response.headers['content-encoding']?.toLowerCase().trim() ?? 'identity'
  const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate()
    : encoding === 'br' ? createBrotliDecompress() : null
  if (encoding !== 'identity' && decoder === null) { response.destroy(); fail(); return }
  let raw = 0
  let decoded = 0
  const chunks: Buffer[] = []
  const count = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    raw += chunk.length
    callback(raw > 4 * 1024 * 1024 ? new Error('response limit') : null, chunk)
  } })
  const collect = new Writable({ write(chunk: Buffer, _encoding, callback) {
    decoded += chunk.length
    if (decoded > 16 * 1024 * 1024) callback(new Error('response limit'))
    else { chunks.push(chunk); callback() }
  } })
  const complete = (error: NodeJS.ErrnoException | null) => {
    if (error) { fail(); return }
    try {
      const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(response.headers['content-type'] ?? '')?.[1] ?? 'utf-8'
      done({ status: response.statusCode ?? 0, text: new TextDecoder(charset, { fatal: true }).decode(Buffer.concat(chunks, decoded)) })
    } catch { fail() }
  }
  if (decoder) pipeline(response, count, decoder, collect, complete)
  else pipeline(response, count, collect, complete)
}

const FORUM_MESSAGE_MAX = 120

/** Whitespace collapsed and trimmed; longer than the limit (in characters) is cut to end in “…”. */
function forumMessage(text: string): string | undefined {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return undefined
  const characters = [...collapsed]
  return characters.length <= FORUM_MESSAGE_MAX ? collapsed : `${characters.slice(0, FORUM_MESSAGE_MAX - 1).join('')}…`
}

/** The POST's classified result and, for a rejection page, the forum's own error text. */
interface PostOutcome { result: 'success' | PublicationProblem; message?: string }

function outcome(response: Response): PostOutcome {
  let success = false
  let error = false
  // Text of the first `<p class="error">` only, never the rest of the page.
  let inError = false
  let errorText: string | null = null
  const parser = new Parser({
    onopentag(name, attributes) {
      if (inError && name === 'br') errorText += ' '
      if (name !== 'p') return
      const classes = (attributes.class ?? '').split(/\s+/)
      success ||= classes.includes('success')
      if (classes.includes('error')) {
        if (!error) { inError = true; errorText = '' }
        error = true
      }
    },
    ontext(text) { if (inError) errorText += text },
    onclosetag(name) { if (name === 'p') inError = false }
  })
  parser.end(response.text)
  // Conflicting markers are never treated as a safe-to-retry rejection.
  if (response.status === 200 && success && !error) return { result: 'success' }
  if (success) return { result: 'response' }
  const message = errorText === null ? undefined : forumMessage(errorText)
  const withMessage = (result: PublicationProblem) => message === undefined ? { result } : { result, message }
  if (response.status === 429) return withMessage('rate-limited')
  if (error) {
    const plain = parseContent(response.text).plainText
    return withMessage(/验证码|captcha/i.test(plain) ? 'captcha' : /频繁|太快|间隔|限制/.test(plain) ? 'rate-limited' : 'rejected')
  }
  return { result: 'response' }
}

function json(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) =>
    ['id', 'resto', 'fid'].includes(key) && typeof value === 'number' ? context?.source : value)
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
// The forum content parser omits trailing rendered line breaks and the forum renders dice; compare
// the submitted representation. Shared by every check that a forum post carries a send's text.
function comparableText(text: string): string { return text.replace(/\r\n?/g, '\n').replace(/\n+$/, '') }
export function carriesText(nodes: readonly ContentNode[], text: string): boolean {
  return comparableText(submittedText(nodes)) === comparableText(text)
}
function bodyMatches(value: Record<string, unknown>, input: DraftSaveInput): boolean {
  if (typeof value.content !== 'string') return false
  if (!carriesText(parseContent(value.content).nodes, input.fields.content)) return false
  for (const field of ['title', 'name'] as const) {
    if (input.fields[field] !== '' && value[field] !== input.fields[field]) return false
  }
  return true
}

/** Main-site publication is independent of browsing identity and subscription source. */
export function createPublicationAdapter(options: {
  origin?: string
  apiOrigin?: string
  publishTimeoutMs?: number
  readTimeoutMs?: number
} = {}): PublicationAdapter {
  const origin = new URL(options.origin ?? 'https://www.nmbxd1.com')
  const apiOrigin = new URL(options.apiOrigin ?? 'https://api.nmb.best')
  for (const url of [origin, apiOrigin]) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid publication origin')
  }
  const publicTransport = createForumTransport({ allowedOrigins: [apiOrigin.origin], timeoutMs: options.readTimeoutMs ?? 20_000 })
  const publicClient = createForumClient({ transport: publicTransport, baseUrl: apiOrigin.origin })

  return { async publish({ payload, userhash, attachment, onAccepted }): Promise<PublishReport> {
    if (!COOKIE.test(userhash)) return { state: 'failed', problem: 'identity' }
    const cookies = new Map<string, string>([['userhash', userhashCookieValue(userhash)]])
    async function request(path: string, fields: Record<string, string> | null): Promise<Response> {
      const url = new URL(path, origin)
      if (url.origin !== origin.origin) throw new Error('Invalid publication target')
      const boundary = `xidao-${randomUUID()}`
      const file = fields !== null && attachment !== null ? await open(attachment.path, 'r').catch(() => { throw new NotSent('attachment') }) : null
      try {
        const stat = file === null ? null : await file.stat().catch(() => { throw new NotSent('attachment') })
        if (stat !== null && !stat.isFile()) throw new NotSent('attachment')
        const prefix = fields === null ? '' : Object.entries(fields).map(([name, value]) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join('') +
          (file === null ? '' : `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="image.${attachment!.format}"\r\nContent-Type: ${MEDIA[attachment!.format]}\r\n\r\n`)
        const suffix = fields === null ? '' : `${file === null ? '' : '\r\n'}--${boundary}--\r\n`
        return await new Promise<Response>((resolve, reject) => {
          let settled = false
          let req: ClientRequest
          let response: IncomingMessage | undefined
          let stream: ReturnType<NonNullable<typeof file>['createReadStream']> | undefined
          // No request byte leaves before the connection (and TLS handshake) is established.
          let connected = false
          const fail = () => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            stream?.destroy(); req?.destroy(); response?.destroy()
            reject(connected ? new Error('Publication transport failed') : new NotSent('network'))
          }
          const timer = setTimeout(fail, fields === null ? options.readTimeoutMs ?? 20_000 : options.publishTimeoutMs ?? PUBLISH_DEADLINE_MS)
          const send = url.protocol === 'https:' ? httpsRequest : httpRequest
          req = send(url, { method: fields === null ? 'GET' : 'POST', headers: {
            Accept: fields === null ? 'application/json' : 'text/html',
            'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': 'Xidao/0.1',
            Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
            ...(fields === null ? {} : { 'Content-Type': `multipart/form-data; boundary=${boundary}`,
              'Content-Length': String(Buffer.byteLength(prefix) + (stat?.size ?? 0) + Buffer.byteLength(suffix)) })
          } }, incoming => {
            response = incoming
            if (settled) { incoming.destroy(); return }
            // A per-attempt session only. A server cannot replace the selected userhash.
            for (const cookie of incoming.headers['set-cookie'] ?? []) {
              const match = /^([A-Za-z0-9_-]+)=([^;]*)/.exec(cookie)
              if (match && match[1] !== 'userhash' && COOKIE.test(match[2]!) && cookies.size < 32) cookies.set(match[1]!, match[2]!)
            }
            receive(incoming, result => {
              if (settled) return
              settled = true; clearTimeout(timer); stream?.destroy(); resolve(result)
            }, fail)
          })
          req.on('socket', socket => {
            if (req.reusedSocket) connected = true
            else socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => { connected = true })
          })
          req.on('error', fail)
          if (fields === null) { req.end(); return }
          req.write(prefix)
          if (file === null) req.end(suffix)
          else {
            stream = file.createReadStream({ autoClose: false })
            stream.on('error', fail)
            stream.on('end', () => { if (!settled) req.end(suffix) })
            stream.pipe(req, { end: false })
          }
        })
      } finally { await file?.close() }
    }

    const fields: Record<string, string> = {
      ...(payload.target.kind === 'thread' ? { fid: payload.target.forumId } : { resto: payload.target.threadId }),
      content: payload.fields.content, title: payload.fields.title, name: payload.fields.name,
      ...(payload.fields.watermark ? { water: 'true' } : {})
    }
    let sent: PostOutcome
    try { sent = outcome(await request(payload.target.kind === 'thread' ? '/Home/Forum/doPostThread.html' : '/Home/Forum/doReplyThread.html', fields)) }
    catch (error) { return error instanceof NotSent ? { state: 'failed', problem: error.problem } : { state: 'unknown', problem: 'network' } }
    const result = sent.result
    if (result !== 'success') {
      if (result !== 'rejected' && result !== 'rate-limited' && result !== 'captcha') return { state: 'unknown', problem: result }
      return sent.message === undefined ? { state: 'failed', problem: result } : { state: 'failed', problem: result, forumMessage: sent.message }
    }
    onAccepted?.()
    try {
      const response = await request('/Api/getLastPost', null)
      if (response.status !== 200) return { state: 'unconfirmed', problem: 'response' }
      const candidate = json(response.text)
      if (!object(candidate) || typeof candidate.id !== 'string' || !ID.test(candidate.id) || !bodyMatches(candidate, payload)) return { state: 'unconfirmed', problem: null }
      const postId = candidate.id
      if (payload.target.kind === 'thread') {
        if (candidate.resto !== '0') return { state: 'unconfirmed', problem: null }
        const page = await publicClient.getThreadPage(postId, 'all', 1, new AbortController().signal)
        if (page.head.forumId !== payload.target.forumId || !carriesText(page.head.content, payload.fields.content) ||
            (payload.fields.title !== '' && page.head.title !== payload.fields.title) || (attachment !== null && page.head.image === null)) return { state: 'unconfirmed', problem: null }
        return { state: 'confirmed', postId, threadId: postId }
      }
      if (candidate.resto !== payload.target.threadId || postId === payload.target.threadId) return { state: 'unconfirmed', problem: null }
      const url = new URL('/api/ref', apiOrigin)
      url.searchParams.set('id', postId)
      const ref = json((await publicTransport.get(url, new AbortController().signal)).text)
      if (!object(ref) || ref.id !== postId || !bodyMatches(ref, payload) ||
          (attachment !== null && !(typeof ref.img === 'string' && ref.img.length > 0))) return { state: 'unconfirmed', problem: null }
      return { state: 'confirmed', postId, threadId: payload.target.threadId }
    } catch { return { state: 'unconfirmed', problem: 'network' } }
  } }
}
