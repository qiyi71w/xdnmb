import { Parser } from 'htmlparser2'
import type { Post, PostImage, ThreadSummary } from '../../shared/forum'
import type { SubscriptionAction } from '../../shared/subscriptions'
import { ForumReadError } from '../forum/contract'
import type { TransportResponse } from '../forum/contract'
import { parseContent } from '../forum/content'

const ID = /^\d{1,20}$/
const shape = () => new ForumReadError({ kind: 'unknown-structure', detail: 'shape' })

function business(message: string): ForumReadError {
  // Classification only: never return a server message that might echo a secret or a whole page.
  return new ForumReadError({ kind: /饼干|权限|登录|登入|无权/.test(message) ? 'permission'
    : /验证码|频繁|太快|限制|captcha|challenge/i.test(message) ? 'rate-limited'
      : /不存在/.test(message) ? 'not-found' : 'unknown-structure', detail: 'business' })
}

function json(response: TransportResponse): unknown {
  if (response.mediaType !== 'application/json' && response.mediaType !== 'text/json') {
    if (/验证码|captcha|challenge/i.test(response.text)) throw business('验证码')
    throw new ForumReadError({ kind: 'unknown-structure', detail: 'html' })
  }
  try {
    return JSON.parse(response.text, (key: string, value: unknown, context?: { source?: string }) =>
      (key === 'id' || key === 'fid') && typeof value === 'number' ? context?.source : value) as unknown
  } catch { throw new ForumReadError({ kind: 'unknown-structure', detail: 'json' }) }
}

const string = (value: unknown) => typeof value === 'string' ? value : null
const count = (value: unknown): number | null => {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') return null
  const result = Number(value)
  return Number.isSafeInteger(result) && result >= 0 ? result : null
}
function appPost(value: unknown): Post {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw shape()
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || !ID.test(raw.id) || typeof raw.content !== 'string') throw shape()
  const content = parseContent(raw.content)
  return { id: raw.id, forumId: typeof raw.fid === 'string' && ID.test(raw.fid) ? raw.fid : null,
    createdAt: string(raw.now), userHash: string(raw.user_hash), name: string(raw.name), title: string(raw.title),
    isAdmin: typeof raw.admin === 'boolean' ? raw.admin : typeof raw.admin === 'number' ? raw.admin !== 0 : null,
    isSage: typeof raw.sage === 'boolean' ? raw.sage : typeof raw.sage === 'number' ? raw.sage !== 0 : null,
    content: content.nodes, plainText: content.plainText,
    image: typeof raw.img === 'string' && raw.img !== '' && typeof raw.ext === 'string' && raw.ext !== '' ? { path: raw.img, ext: raw.ext } : null,
    imageKnown: typeof raw.img === 'string' && typeof raw.ext === 'string' && ((raw.img === '' && raw.ext === '') || (raw.img !== '' && raw.ext !== '')) }
}

export function parseAppList(response: TransportResponse): ThreadSummary[] {
  const value = json(response)
  if (typeof value === 'string') throw business(value)
  if (!Array.isArray(value)) {
    if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string') throw business(value.error)
    throw shape()
  }
  return value.map((raw: unknown) => {
    const head = appPost(raw)
    const item = raw as Record<string, unknown>
    const recent = Array.isArray(item.recent_replies) ? item.recent_replies : []
    return { head, replyCount: count(item.reply_count), remainReplies: null,
      recentReplies: recent.filter((post: unknown) => !(post && typeof post === 'object' && 'user_hash' in post && post.user_hash === 'Tips')).map(appPost) }
  })
}

interface Element { tag: string; attrs: Record<string, string>; children: Array<Element | string>; start: number; end: number }
function document(response: TransportResponse): Element {
  if (response.mediaType !== 'text/html') throw shape()
  const root: Element = { tag: '', attrs: {}, children: [], start: 0, end: response.text.length }
  const stack = [root]
  const parser = new Parser({
    onopentag(tag, attrs) {
      const node: Element = { tag, attrs, children: [], start: parser.endIndex + 1, end: response.text.length }
      stack.at(-1)!.children.push(node)
      stack.push(node)
    },
    ontext(text) { stack.at(-1)!.children.push(text) },
    onclosetag() { if (stack.length > 1) stack.pop()!.end = parser.startIndex }
  }, { decodeEntities: true })
  parser.end(response.text)
  return root
}
function nodes(root: Element, predicate: (node: Element) => boolean): Element[] {
  const result: Element[] = []
  const pending = [root]
  while (pending.length) {
    const node = pending.pop()!
    if (predicate(node)) result.push(node)
    for (let index = node.children.length - 1; index >= 0; index--) {
      const child = node.children[index]!
      if (typeof child !== 'string') pending.push(child)
    }
  }
  return result
}
function text(node: Element): string {
  const parts: string[] = []
  const pending: Array<Element | string> = [node]
  while (pending.length) {
    const child = pending.pop()!
    if (typeof child === 'string') parts.push(child)
    else if (!['script', 'style', 'noscript'].includes(child.tag)) {
      if (child.tag === 'br') parts.push('\n')
      for (let index = child.children.length - 1; index >= 0; index--) pending.push(child.children[index]!)
    }
  }
  return parts.join('').trim()
}
const hasClass = (node: Element, name: string) => (node.attrs.class ?? '').split(/\s+/).includes(name)
function errors(root: Element): void {
  // Only site-level error text is authoritative. A normal post can quote any error phrase.
  const pending = [root]
  const siteText: string[] = []
  while (pending.length) {
    const node = pending.pop()!
    if (hasClass(node, 'h-threads-item-main')) continue
    if (hasClass(node, 'error')) throw business(text(node))
    if (['script', 'style', 'noscript'].includes(node.tag)) continue
    for (const child of node.children) {
      if (typeof child === 'string') siteText.push(child)
      else pending.push(child)
    }
  }
  const message = siteText.join(' ')
  if (/请确认饼干是否应用正确|请(?:先)?(?:登录|登入)|权限不足|无权访问|验证码|captcha|challenge/i.test(message)) throw business(message)
}

/** Accept only the forum image service's managed paths, never arbitrary page image URLs. */
function webImage(item: Element): PostImage | null {
  for (const image of nodes(item, (node) => node.tag === 'img' && hasClass(node, 'h-threads-img'))) {
    try {
      const url = new URL(image.attrs.src ?? '', 'https://www.nmbxd1.com')
      if (url.protocol !== 'https:' || url.hostname !== 'image.nmb.best' || url.port || url.username || url.password || url.search || url.hash) continue
      const match = /^\/(?:thumb|image)\/(\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_]{1,64})(\.[A-Za-z0-9]{1,8})$/.exec(url.pathname)
      if (match) return { path: match[1]!, ext: match[2]! }
    } catch { /* An invalid or foreign URL does not establish image metadata. */ }
  }
  return null
}

export function parseWebList(response: TransportResponse): ThreadSummary[] {
  const root = document(response)
  errors(root)
  const lists = nodes(root, (node) => hasClass(node, 'h-threads-list'))
  const titles = nodes(root, (node) => node.tag === 'title')
  if (lists.length !== 1 || !titles.some((node) => /订阅/.test(text(node)))) throw shape()
  const items = nodes(lists[0]!, (node) => hasClass(node, 'h-threads-item-main'))
  // A changed item wrapper must not turn an unrecognized nonempty list into an empty set.
  const links = nodes(lists[0]!, (node) => hasClass(node, 'h-threads-info-id'))
  if (links.length !== items.length) throw shape()
  return items.map((item) => {
    const ids = nodes(item, (node) => node.tag === 'a' && hasClass(node, 'h-threads-info-id'))
    if (ids.length !== 1) throw shape()
    const linkId = /(?:^|\/)t\/(\d{1,20})(?:\.html)?(?:[/?#]|$)/.exec(ids[0]!.attrs.href ?? '')?.[1]
    const labelId = /^(?:No\.)?(\d{1,20})$/.exec(text(ids[0]!))?.[1]
    const id = linkId ?? labelId
    if (!id || (linkId && labelId && linkId !== labelId) || (item.attrs['data-threads-id'] && item.attrs['data-threads-id'] !== id)) throw shape()
    const bodies = nodes(item, (node) => hasClass(node, 'h-threads-content'))
    if (bodies.length !== 1) throw shape()
    const body = parseContent(response.text.slice(bodies[0]!.start, bodies[0]!.end))
    const field = (name: string) => { const value = nodes(item, (node) => hasClass(node, name))[0]; return value ? text(value) : null }
    return { head: { id, forumId: null, createdAt: field('h-threads-info-createdat'), userHash: field('h-threads-info-uid')?.replace(/^ID:\s*/i, '') || null,
      name: field('h-threads-info-name'), title: field('h-threads-info-title'), isAdmin: null, isSage: null,
      content: body.nodes, plainText: body.plainText, image: webImage(item) },
      replyCount: null, recentReplies: [], remainReplies: null }
  })
}

export function parseWriteReport(source: 'app' | 'web', action: SubscriptionAction, response: TransportResponse): 'success' | 'rejected' {
  let message: string
  if (source === 'app') {
    const value = json(response)
    if (typeof value !== 'string') throw shape()
    message = value.trim()
  } else {
    const root = document(response)
    errors(root)
    const successes = nodes(root, (node) => node.tag === 'p' && hasClass(node, 'success'))
    if (successes.length !== 1) throw shape()
    message = text(successes[0]!)
  }
  if (message === (action === 'add' ? '订阅大成功→_→' : '取消订阅成功!')) return 'success'
  throw business(message)
}
