import { ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { IpcChannel, MAX_MARK_READ_IDS, type AppStatus, type DirectoryStrategy, type LocateHint } from '../shared/api'
import type { FeedRef, PostId, ReadingMode } from '../shared/forum'
import { DEFAULT_SETTINGS, type AppSettings, type ReadingAnchor } from '../shared/reading'
import { MAX_SEARCH_QUERY_LENGTH, SEARCH_SITE_URL } from '../shared/search'
import type { ReadingService } from './reading/service'
import type { SearchService } from './search/service'
import type { ReadingStore } from './storage/contract'
import { emptyReadingState } from './storage/reading-state'

const OPERATION_ID = /^[A-Za-z0-9_-]{1,64}$/
const FORUM_ID = /^\d{1,20}$/
const STRATEGIES: readonly DirectoryStrategy[] = ['cache-first', 'background-refresh', 'refresh']
const MAX_PAGE = 100_000
/** Far beyond what anyone pages through by hand; a search page number is never a forum page. */
const MAX_SEARCH_PAGE = 1000
const MAX_URL_LENGTH = 2048
const MAX_VIEWPORT_OFFSET = 100_000

class InvalidRequestError extends Error {
  override readonly name = 'InvalidRequestError'
  constructor() {
    super('invalid request')
  }
}

interface IpcDeps {
  reading: ReadingService
  search: SearchService
  store: ReadingStore
  getStatus: () => AppStatus
  /** True only for the app's own renderer document in its main frame. */
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new InvalidRequestError()
  return input as Record<string, unknown>
}

function operationId(input: Record<string, unknown>): string {
  const value = input.operationId
  if (typeof value !== 'string' || !OPERATION_ID.test(value)) throw new InvalidRequestError()
  return value
}

function forumId(value: unknown): string {
  if (typeof value !== 'string' || !FORUM_ID.test(value)) throw new InvalidRequestError()
  return value
}

function page(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_PAGE) throw new InvalidRequestError()
  return value
}

function feedRef(value: unknown): FeedRef {
  const feed = record(value)
  if (feed.kind !== 'forum' && feed.kind !== 'timeline') throw new InvalidRequestError()
  return { kind: feed.kind, id: forumId(feed.id) }
}

function readingMode(value: unknown): ReadingMode {
  if (value !== 'all' && value !== 'po') throw new InvalidRequestError()
  return value
}

function anchor(value: unknown): ReadingAnchor {
  const input = record(value)
  const { offsetRatio, viewportOffset } = input
  if (typeof offsetRatio !== 'number' || !Number.isFinite(offsetRatio) || offsetRatio < 0 || offsetRatio > 1) {
    throw new InvalidRequestError()
  }
  if (typeof viewportOffset !== 'number' || !Number.isFinite(viewportOffset) || Math.abs(viewportOffset) > MAX_VIEWPORT_OFFSET) {
    throw new InvalidRequestError()
  }
  return { postId: forumId(input.postId), page: page(input.page), offsetRatio, viewportOffset }
}

function postIds(value: unknown): PostId[] {
  if (!Array.isArray(value) || value.length > MAX_MARK_READ_IDS) throw new InvalidRequestError()
  return value.map(forumId)
}

/** Optional search-link clue: absent/undefined means none. */
function locateHint(value: unknown): LocateHint | null {
  if (value === undefined) return null
  const input = record(value)
  return { threadId: forumId(input.threadId), page: input.page === null ? null : page(input.page) }
}

function sessionId(input: Record<string, unknown>): string {
  const value = input.sessionId
  if (typeof value !== 'string' || !OPERATION_ID.test(value)) throw new InvalidRequestError()
  return value
}

function searchQuery(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidRequestError()
  const query = value.trim()
  if (query.length === 0 || query.length > MAX_SEARCH_QUERY_LENGTH) throw new InvalidRequestError()
  return query
}

function settingsPatch(value: unknown): Partial<AppSettings> {
  const input = record(value)
  const patch: Partial<AppSettings> = {}
  for (const [key, item] of Object.entries(input)) {
    if (key !== 'newTabSplitDefault' || typeof item !== 'boolean') throw new InvalidRequestError()
    patch.newTabSplitDefault = item
  }
  return patch
}

/** Local writes report refusal/failure as `saved: false`; they never fail the renderer's call. */
async function attempt(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write()
    return true
  } catch {
    return false
  }
}

/**
 * Tracks cancellable operations per renderer. A repeated ID supersedes (cancels) the earlier one.
 * Keys are scoped by WebContents so one page can never cancel another's work.
 */
class OperationRegistry {
  private readonly active = new Map<string, AbortController>()

  async run<T>(sender: WebContents, id: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const key = `${sender.id}:${id}`
    this.active.get(key)?.abort()
    const controller = new AbortController()
    this.active.set(key, controller)
    try {
      return await work(controller.signal)
    } finally {
      if (this.active.get(key) === controller) this.active.delete(key)
    }
  }

  cancel(sender: WebContents, id: string): void {
    this.active.get(`${sender.id}:${id}`)?.abort()
  }

  cancelAllFor(sender: WebContents): void {
    const prefix = `${sender.id}:`
    for (const [key, controller] of this.active) if (key.startsWith(prefix)) controller.abort()
  }
}

export function registerIpc({ reading, search, store, getStatus, isTrustedSender }: IpcDeps): { cancelAllFor: (sender: WebContents) => void } {
  const operations = new OperationRegistry()
  const owner = (sender: WebContents): string => String(sender.id)

  function handle(channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>): void {
    ipcMain.handle(channel, (event, input: unknown) => {
      if (!isTrustedSender(event)) throw new InvalidRequestError()
      return handler(event, input)
    })
  }

  handle(IpcChannel.loadDirectory, async (event, raw) => {
    const input = record(raw)
    const strategy = input.strategy
    if (!STRATEGIES.includes(strategy as DirectoryStrategy)) throw new InvalidRequestError()
    return operations.run(event.sender, operationId(input), (signal) => reading.loadDirectory(strategy as DirectoryStrategy, signal))
  })

  handle(IpcChannel.readFeedPage, async (event, raw) => {
    const input = record(raw)
    const feed = feedRef(input.feed)
    const pageNumber = page(input.page)
    return operations.run(event.sender, operationId(input), (signal) => reading.readFeedPage(feed, pageNumber, signal))
  })

  handle(IpcChannel.readThreadPage, async (event, raw) => {
    const input = record(raw)
    const threadId = forumId(input.threadId)
    const mode = readingMode(input.mode)
    const pageNumber = page(input.page)
    return operations.run(event.sender, operationId(input), (signal) => reading.readThreadPage(threadId, mode, pageNumber, signal))
  })

  handle(IpcChannel.locateThreadEnd, async (event, raw) => {
    const input = record(raw)
    const threadId = forumId(input.threadId)
    const mode = readingMode(input.mode)
    return operations.run(event.sender, operationId(input), (signal) => reading.locateThreadEnd(threadId, mode, signal))
  })

  handle(IpcChannel.previewQuote, async (event, raw) => {
    const input = record(raw)
    const postId = forumId(input.postId)
    return operations.run(event.sender, operationId(input), (signal) => reading.previewQuote(postId, signal))
  })

  handle(IpcChannel.locateQuote, async (event, raw) => {
    const input = record(raw)
    const postId = forumId(input.postId)
    const hint = locateHint(input.hint)
    return operations.run(event.sender, operationId(input), (signal) => reading.locateQuote(postId, signal, hint))
  })

  handle(IpcChannel.runSearch, async (event, raw) => {
    const input = record(raw)
    const id = sessionId(input)
    return search.run(owner(event.sender), id, searchQuery(input.query))
  })

  handle(IpcChannel.searchPage, async (event, raw) => {
    const input = record(raw)
    const id = sessionId(input)
    const pageNumber = input.page
    if (typeof pageNumber !== 'number' || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > MAX_SEARCH_PAGE) {
      throw new InvalidRequestError()
    }
    return search.page(owner(event.sender), id, pageNumber)
  })

  handle(IpcChannel.cancelSearch, async (event, raw) => {
    search.cancel(owner(event.sender), sessionId(record(raw)))
  })

  handle(IpcChannel.closeSearch, async (event, raw) => {
    search.close(owner(event.sender), sessionId(record(raw)))
  })

  handle(IpcChannel.openSearchSite, async () => {
    await shell.openExternal(SEARCH_SITE_URL)
    return { opened: true }
  })

  handle(IpcChannel.cancel, async (event, raw) => {
    operations.cancel(event.sender, operationId(record(raw)))
  })

  handle(IpcChannel.getReadingState, async (_event, raw) => {
    const threadId = forumId(record(raw).threadId)
    try {
      return await store.getReadingState(threadId)
    } catch {
      console.error('[reading-state] load failed')
      return emptyReadingState(threadId)
    }
  })

  handle(IpcChannel.setReadingMode, async (_event, raw) => {
    const input = record(raw)
    const threadId = forumId(input.threadId)
    const mode = readingMode(input.mode)
    return { saved: await attempt(() => store.setReadingMode(threadId, mode, new Date().toISOString())) }
  })

  handle(IpcChannel.saveReadingPosition, async (_event, raw) => {
    const input = record(raw)
    const threadId = forumId(input.threadId)
    const mode = readingMode(input.mode)
    const position = anchor(input.anchor)
    return { saved: await attempt(() => store.saveReadingPosition(threadId, mode, position, new Date().toISOString())) }
  })

  handle(IpcChannel.markRead, async (_event, raw) => {
    const input = record(raw)
    const threadId = forumId(input.threadId)
    const ids = postIds(input.postIds)
    try {
      return { saved: true, marked: await store.markPostsRead(threadId, ids, new Date().toISOString()) }
    } catch {
      return { saved: false, marked: [] }
    }
  })

  handle(IpcChannel.recordVisit, async (_event, raw) => {
    const threadId = forumId(record(raw).threadId)
    return { saved: await attempt(() => store.recordVisit(threadId, new Date().toISOString())) }
  })

  /** A settings row that cannot be read leaves the defaults in effect rather than failing the UI. */
  const loadSettings = () => store.loadSettings().catch((): AppSettings => ({ ...DEFAULT_SETTINGS }))

  handle(IpcChannel.getSettings, async () => loadSettings())

  handle(IpcChannel.updateSettings, async (_event, raw) => {
    const patch = settingsPatch(raw)
    const current = await loadSettings()
    const next: AppSettings = { ...current, ...patch }
    const saved = await attempt(() => store.saveSettings(next))
    return { saved, settings: saved ? next : current }
  })

  handle(IpcChannel.openExternal, async (_event, raw) => {
    const url = record(raw).url
    if (typeof url !== 'string' || url.length > MAX_URL_LENGTH || !URL.canParse(url)) return { opened: false }
    const parsed = new URL(url)
    // Only explicit web links; never credentials-in-URL, files, custom schemes or app protocols.
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) return { opened: false }
    await shell.openExternal(parsed.href)
    return { opened: true }
  })

  handle(IpcChannel.getStatus, async () => getStatus())

  return {
    cancelAllFor: (sender) => {
      operations.cancelAllFor(sender)
      search.closeAll(owner(sender))
    }
  }
}
