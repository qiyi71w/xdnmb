import type { ReadErrorKind } from '../../shared/api'
import type {
  BoardDirectory, FeedPage, Forum, ForumGroup, Post, ThreadPage, ThreadSummary, Timeline
} from '../../shared/forum'
import { pageCapFor } from '../../shared/threadPages'
import { ForumReadError } from './contract'
import type { ForumClient, ForumTransport } from './contract'
import { parseContent } from './content'

const idKeys: Readonly<Record<string, true>> = { id: true, fid: true, resto: true }
const idPattern = /^\d{1,20}$/
/** The forum list embeds the timeline as a pseudo forum; it is not a forum and not a malformed item. */
const TIMELINE_PSEUDO_FORUM_ID = '-1'
type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function id(value: unknown): string | null {
  return typeof value === 'string' && idPattern.test(value) ? value : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function flag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  return typeof value === 'number' && Number.isFinite(value) ? value !== 0 : null
}

function isTips(value: unknown): boolean {
  return isObject(value) && value.id === '9999999' && value.user_hash === 'Tips'
}

function normalizePost(value: unknown): Post | null {
  if (!isObject(value)) return null
  const postId = id(value.id)
  if (postId === null || typeof value.content !== 'string') return null
  const content = parseContent(value.content)
  return {
    id: postId,
    forumId: id(value.fid),
    createdAt: text(value.now),
    userHash: text(value.user_hash),
    name: text(value.name),
    title: text(value.title),
    isAdmin: flag(value.admin),
    isSage: flag(value.sage),
    content: content.nodes,
    plainText: content.plainText,
    image: typeof value.img === 'string' && value.img.length > 0 && typeof value.ext === 'string' && value.ext.length > 0
      ? { path: value.img, ext: value.ext } : null,
    imageKnown: typeof value.img === 'string' && typeof value.ext === 'string' &&
      ((value.img === '' && value.ext === '') || (value.img !== '' && value.ext !== ''))
  }
}

function shapeError(): ForumReadError {
  return new ForumReadError({ kind: 'unknown-structure', detail: 'shape' })
}

function businessError(message: string): ForumReadError {
  let kind: ReadErrorKind = 'unknown-structure'
  if (/不存在/.test(message)) kind = 'not-found'
  else if (/饼干|权限|登入|登录|无权/.test(message)) kind = 'permission'
  else if (/验证码|频繁|太快|限制/.test(message)) kind = 'rate-limited'
  return new ForumReadError({ kind, detail: 'business', serverMessage: message.slice(0, 200) })
}

function nonNegativeNumber(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

/**
 * Forum/timeline display names may carry markup (e.g. `任天堂<font color="DeepSkyBlue">N</font>`).
 * Names are shown as plain text: markup is parsed safely and only its text is kept.
 */
function displayName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const plain = parseContent(value).plainText.replace(/\s+/g, ' ').trim()
  return plain.length > 0 ? plain : fallback
}

export function createForumClient(options: {
  transport: ForumTransport
  baseUrl?: string
  /**
   * Userhash of the selected browse identity, or null to read without one. Throws
   * ForumReadError(identity/…) when the chosen identity cannot be used; the read is then not sent.
   */
  browseIdentity?: () => Promise<string | null>
}): ForumClient {
  const baseUrl = new URL(options.baseUrl ?? 'https://api.nmb.best')
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new Error('Invalid forum API base URL')
  }

  /** `page` is omitted only by reads that address a single post (`ref`). */
  async function read(path: string, signal: AbortSignal, params?: { id: string; page?: number }): Promise<unknown> {
    const url = new URL(path, baseUrl)
    if (params) {
      if (typeof params.id !== 'string' || !idPattern.test(params.id) ||
          (params.page !== undefined && (!Number.isSafeInteger(params.page) || params.page < 1))) {
        throw new Error('Invalid forum read identifier or page')
      }
      url.searchParams.set('id', params.id)
      if (params.page !== undefined) url.searchParams.set('page', String(params.page))
    }
    const userhash = options.browseIdentity ? await options.browseIdentity() : null
    const response = await options.transport.get(url, signal, userhash === null ? undefined : { userhash })
    if (response.text.trimStart().startsWith('<') || response.mediaType === 'text/html') {
      throw new ForumReadError({
        kind: /验证码|captcha|challenge/i.test(response.text) ? 'rate-limited' : 'unknown-structure',
        detail: 'html'
      })
    }
    if (response.mediaType !== 'application/json' && response.mediaType !== 'text/json') throw shapeError()
    let value: unknown
    try {
      value = JSON.parse(response.text, (key: string, item: unknown, context?: { source?: string }): unknown => {
        if (Object.hasOwn(idKeys, key) && typeof item === 'number') return context?.source
        return item
      }) as unknown
    } catch {
      throw new ForumReadError({ kind: 'unknown-structure', detail: 'json' })
    }
    if (typeof value === 'string') throw businessError(value)
    if (isObject(value) && value.success === false && typeof value.error === 'string') {
      throw businessError(value.error)
    }
    return value
  }

  return {
    async getDirectory(signal): Promise<BoardDirectory> {
      const forumList = await read('/api/getForumList', signal)
      if (!Array.isArray(forumList)) throw shapeError()
      const timelineList = await read('/api/getTimelineList', signal)
      if (!Array.isArray(timelineList)) throw shapeError()
      const groups: ForumGroup[] = []
      let skippedItems = 0
      let forumCount = 0
      for (const rawGroup of forumList as unknown[]) {
        if (!isObject(rawGroup) || id(rawGroup.id) === null || typeof rawGroup.name !== 'string' ||
            !Array.isArray(rawGroup.forums)) {
          skippedItems++
          continue
        }
        const groupId = id(rawGroup.id)!
        const forums: Forum[] = []
        for (const rawForum of rawGroup.forums as unknown[]) {
          if (isObject(rawForum) && rawForum.id === TIMELINE_PSEUDO_FORUM_ID) continue
          const forumId = isObject(rawForum) ? id(rawForum.id) : null
          if (!isObject(rawForum) || forumId === null || typeof rawForum.name !== 'string') {
            skippedItems++
            continue
          }
          forums.push({
            id: forumId,
            groupId,
            groupName: rawGroup.name,
            name: rawForum.name,
            displayName: displayName(rawForum.showName, rawForum.name),
            rules: parseContent(text(rawForum.msg) ?? '').nodes,
            postIntervalSeconds: nonNegativeNumber(rawForum.interval)
          })
        }
        forumCount += forums.length
        groups.push({ id: groupId, name: rawGroup.name, forums })
      }
      const timelines: Timeline[] = []
      for (const raw of timelineList as unknown[]) {
        const timelineId = isObject(raw) ? id(raw.id) : null
        if (!isObject(raw) || timelineId === null || typeof raw.name !== 'string') {
          skippedItems++
          continue
        }
        timelines.push({
          id: timelineId,
          name: raw.name,
          displayName: displayName(raw.display_name, raw.name),
          notice: parseContent(text(raw.notice) ?? '').nodes,
          maxPage: nonNegativeNumber(raw.max_page)
        })
      }
      // Content that is present but entirely unusable is an unknown structure, not an empty directory.
      if (skippedItems > 0 && forumCount === 0 && timelines.length === 0) throw shapeError()
      return { groups, timelines, skippedItems }
    },
    async getFeedPage(feed, page, signal): Promise<FeedPage> {
      if (feed.kind !== 'forum' && feed.kind !== 'timeline') throw new Error('Invalid feed kind')
      const value = await read(feed.kind === 'forum' ? '/api/showf' : '/api/timeline', signal, { id: feed.id, page })
      if (!Array.isArray(value)) throw shapeError()
      const threads: ThreadSummary[] = []
      let skippedItems = 0
      for (const raw of value as unknown[]) {
        const head = normalizePost(raw)
        if (head === null || !isObject(raw)) { skippedItems++; continue }
        const recentReplies: Post[] = []
        if (Array.isArray(raw.Replies)) {
          for (const rawReply of raw.Replies as unknown[]) {
            if (isTips(rawReply)) continue
            const reply = normalizePost(rawReply)
            if (reply !== null) recentReplies.push(reply)
          }
        }
        threads.push({
          head,
          replyCount: finiteNumber(raw.ReplyCount),
          recentReplies,
          remainReplies: finiteNumber(raw.RemainReplies)
        })
      }
      return { feed, page, threads, skippedItems }
    },
    async getThreadPage(threadId, mode, page, signal): Promise<ThreadPage> {
      if (mode !== 'all' && mode !== 'po') throw new Error('Invalid reading mode')
      const fetchPage = async (number: number): Promise<ThreadPage> => {
        const value = await read(mode === 'po' ? '/api/po' : '/api/thread', signal, { id: threadId, page: number })
        if (!isObject(value) || value.id !== threadId || !Array.isArray(value.Replies)) throw shapeError()
        const head = normalizePost(value)
        if (head === null) throw shapeError()
        const replies: Post[] = []
        const seen = new Set<string>()
        let skippedItems = 0
        for (const raw of value.Replies as unknown[]) {
          if (isTips(raw)) continue
          const reply = normalizePost(raw)
          if (reply === null) { skippedItems++; continue }
          if (seen.has(reply.id)) continue
          seen.add(reply.id)
          replies.push(reply)
        }
        return {
          threadId, mode, page: number, head, replies,
          replyCount: nonNegativeNumber(value.ReplyCount),
          skippedItems,
          endCandidate: replies.length === 0 && skippedItems === 0
        }
      }
      const result = await fetchPage(page)
      // Public reads above 100 have been observed to return page 100. Verify content rather than
      // hard-coding a cap: a selected cookie may allow later pages. This also covers direct jumps
      // without an earlier local page-100 observation. Empty (Tips-only) pages remain end candidates.
      if (page > 100 && result.replies.length > 0) {
        const lower = await fetchPage(100)
        const highestReadablePage = pageCapFor(result, [{ page: 100, replyIds: lower.replies.map((reply) => reply.id) }])
        if (highestReadablePage !== null) throw new ForumReadError({ kind: 'page-cap', detail: 'shape', highestReadablePage }, lower)
      }
      return result
    },
    async getRef(postId, signal): Promise<Post> {
      const value = await read('/api/ref', signal, { id: postId })
      const post = normalizePost(value)
      if (post === null || post.id !== postId) throw shapeError()
      return post
    }
  }
}
