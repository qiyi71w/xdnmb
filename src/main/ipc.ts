import { isAnnouncementIdentity } from '../shared/announcements'
import type { AnnouncementService } from './announcements/service'
import { BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import {
  CLIPBOARD_EDIT_COMMANDS, IpcChannel, MAX_CLIPBOARD_TEXT_LENGTH, type AppStatus, type ClipboardEditCommand, type DirectoryStrategy,
  type ReadOutcome, type LocateHint
} from '../shared/api'
import type { FeedRef, ReadingMode } from '../shared/forum'
import type { ImageFormat, ImageKind } from '../shared/images'
import { IDENTITY_ROLES, validateCookieId, type CredentialId, type IdentityRole } from '../shared/identity'
import { isCookieColorName } from '../shared/cookieColors'
import {
  MAX_DRAFT_CONTENT_LENGTH, MAX_DRAFT_FIELD_LENGTH, type DraftSaveInput, type PostFields, type PostTarget
} from '../shared/drafts'
import type { ReadingAnchor } from '../shared/reading'
import type { ContentService } from './content/service'
import { OFFLINE_CHANGED_CHANNEL } from '../shared/content'
import { MAX_WORKSPACE_LENGTH } from '../shared/lifecycle'
import type { DraftService } from './drafts/service'
import type { IdentityService } from './identity/service'
import type { ImageService } from './images/service'
import type { ZoomAction } from '../shared/settings'
import { themeFileName, type SettingsService } from './appearance'
import type { ReadingService } from './reading/service'
import type { AppStore } from './storage/contract'
import { emptyReadingState } from './storage/reading-state'
import type { SubscriptionItemChoice, SubscriptionSource } from '../shared/subscriptions'
import type { SubscriptionService } from './subscriptions/service'
import type { PublicationService } from './publication/service'
import type { Lifecycle } from './lifecycle/controller'
import type { UpdateService } from './updates/service'
import { REMINDERS_CHANGED_CHANNEL } from '../shared/reminders'
import type { ReminderService } from './reminders/service'
import { applyZoom, currentZoom } from './zoom'
import type { SearchService } from './search/service'
import type { SearchFilters, SearchScope } from '../shared/search'
import { serverCalendarDate } from '../shared/search-filters'
import { MAX_SEARCH_QUERY_LENGTH, SEARCH_CHANNELS, SEARCH_SITE_URLS, type SearchChannel } from '../shared/online-search'
import type { OnlineSearchService } from './online-search/service'
import type { AccountService } from './account/service'

function searchChannel(value: unknown): SearchChannel {
  if (typeof value !== 'string' || !(SEARCH_CHANNELS as readonly string[]).includes(value)) throw new InvalidRequestError()
  return value as SearchChannel
}

const OPERATION_ID = /^[A-Za-z0-9_-]{1,64}$/
const FORUM_ID = /^\d{1,20}$/
const STRATEGIES: readonly DirectoryStrategy[] = ['cache-first', 'background-refresh', 'refresh']
const MAX_PAGE = 100_000
/** Far beyond what anyone pages through by hand; a search page number is never a forum page. */
const MAX_SEARCH_PAGE = 1000
const MAX_URL_LENGTH = 2048
const MAX_VIEWPORT_OFFSET = 100_000
const CREDENTIAL_ID = /^[1-9]\d{0,14}$/
/** Draft and attachment IDs: never-reused local row IDs. */
const LOCAL_ID = /^[1-9]\d{0,14}$/
/** Pasted input and names beyond this are refused outright; the parsers report smaller limits. */
const MAX_TEXT_LENGTH = 65_536
/** Far beyond any real cookie list; bounds a reorder request. */
const MAX_CREDENTIALS = 1000

class InvalidRequestError extends Error {
  override readonly name = 'InvalidRequestError'
  constructor() {
    super('invalid request')
  }
}

interface IpcDeps {
  announcements: AnnouncementService
  content: ContentService
  search: SearchService
  onlineSearch: OnlineSearchService
  reading: ReadingService
  images: ImageService
  store: AppStore
  identities: IdentityService
  account: AccountService
  drafts: DraftService
  subscriptions: SubscriptionService
  publication: PublicationService
  reminders: ReminderService
  lifecycle: Pick<Lifecycle, 'reside' | 'requestQuit' | 'presentQuit' | 'cancelQuit' | 'completeQuit'>
  updates: UpdateService
  settings: SettingsService
  getStatus: () => AppStatus
  /** Operating system light/dark preference, for exporting a built-in scheme under `system`. */
  systemPrefersDark: () => boolean
  /** True only for the app's own renderer document in its main frame. */
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  /** System save dialog for the sender's window; null when dismissed. */
  chooseSavePath: (sender: WebContents, suggestedName: string, format: ImageFormat) => Promise<string | null>
  /** System open dialog for one image file; null when dismissed. */
  chooseImageFile: (sender: WebContents) => Promise<string | null>
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new InvalidRequestError()
  return input as Record<string, unknown>
}

function searchRecord(raw: unknown, keys: string[]): Record<string, unknown> {
  const input = record(raw)
  if (Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key))) throw new InvalidRequestError()
  return input
}

function searchFilters(raw: unknown): SearchFilters {
  const input = searchRecord(raw, ['forumId', 'fromDate', 'toDate', 'image', 'postKind'])
  const date = (value: unknown): string | null => {
    if (value === null) return null
    if (typeof value !== 'string' || value.length !== 10 || serverCalendarDate(value) !== value) throw new InvalidRequestError()
    return value
  }
  if (input.image !== 'any' && input.image !== 'with' && input.image !== 'without') throw new InvalidRequestError()
  if (input.postKind !== 'any' && input.postKind !== 'head' && input.postKind !== 'reply') throw new InvalidRequestError()
  const fromDate = date(input.fromDate)
  const toDate = date(input.toDate)
  if (fromDate !== null && toDate !== null && fromDate > toDate) throw new InvalidRequestError()
  return { forumId: input.forumId === null ? null : forumId(input.forumId), fromDate, toDate, image: input.image, postKind: input.postKind }
}

function searchScope(raw: unknown): SearchScope {
  const input = record(raw)
  if (input.kind === 'local') { searchRecord(input, ['kind']); return { kind: 'local' } }
  if (input.kind !== 'thread') throw new InvalidRequestError()
  searchRecord(input, ['kind', 'threadId', 'mode'])
  return { kind: 'thread', threadId: forumId(input.threadId), mode: readingMode(input.mode) }
}

function operationId(input: Record<string, unknown>): string {
  const value = input.operationId
  if (typeof value !== 'string' || !OPERATION_ID.test(value)) throw new InvalidRequestError()
  return value
}

/** Reader view IDs share the operation ID format. */
function viewId(value: unknown): string {
  if (typeof value !== 'string' || !OPERATION_ID.test(value)) throw new InvalidRequestError()
  return value
}

function imageKind(value: unknown): ImageKind {
  if (value !== 'thumb' && value !== 'original') throw new InvalidRequestError()
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

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) throw new InvalidRequestError()
  return value
}

function credentialId(value: unknown): CredentialId {
  if (typeof value !== 'string' || !CREDENTIAL_ID.test(value)) throw new InvalidRequestError()
  return value
}

function identityRole(value: unknown): IdentityRole {
  if (!IDENTITY_ROLES.includes(value as IdentityRole)) throw new InvalidRequestError()
  return value as IdentityRole
}

function localId(value: unknown): string {
  if (typeof value !== 'string' || !LOCAL_ID.test(value)) throw new InvalidRequestError()
  return value
}

function nullableCredentialId(value: unknown): CredentialId | null {
  return value === null ? null : credentialId(value)
}

function postTarget(value: unknown): PostTarget {
  const input = record(value)
  if (input.kind === 'reply') return { kind: 'reply', threadId: forumId(input.threadId) }
  if (input.kind === 'thread') return { kind: 'thread', forumId: forumId(input.forumId) }
  throw new InvalidRequestError()
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new InvalidRequestError()
  return value
}

function postFields(value: unknown): PostFields {
  const input = record(value)
  if (typeof input.watermark !== 'boolean') throw new InvalidRequestError()
  return {
    content: boundedText(input.content, MAX_DRAFT_CONTENT_LENGTH),
    title: boundedText(input.title, MAX_DRAFT_FIELD_LENGTH),
    name: boundedText(input.name, MAX_DRAFT_FIELD_LENGTH),
    watermark: input.watermark
  }
}

function draftSaveInput(value: unknown): DraftSaveInput {
  const input = record(value)
  return {
    draftId: input.draftId === null ? null : localId(input.draftId),
    target: postTarget(input.target),
    credentialId: nullableCredentialId(input.credentialId),
    fields: postFields(input.fields),
    attachmentId: input.attachmentId === null ? null : localId(input.attachmentId)
  }
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

function subscriptionSource(value: unknown): SubscriptionSource {
  if (value !== 'app' && value !== 'web') throw new InvalidRequestError()
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

  async run<R>(sender: WebContents, id: string, work: (signal: AbortSignal) => Promise<R>): Promise<R> {
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

  cancelAll(): void {
    for (const controller of this.active.values()) controller.abort()
  }
}

export interface IpcRegistration {
  /** The page went away: cancel its reads, prompts and holds. */
  cancelAllFor: (sender: WebContents) => void
  /** Cancels every running read and download, whoever started it. */
  cancelAll: () => void
}

export function registerIpc({
  reading, images, identities, account, drafts, content, subscriptions, publication, reminders, lifecycle, store, settings, search, onlineSearch,
  announcements, updates, getStatus, systemPrefersDark, isTrustedSender, chooseSavePath, chooseImageFile
}: IpcDeps): IpcRegistration {
  const owner = (sender: WebContents): string => String(sender.id)
  const operations = new OperationRegistry()
  const subscriptionReads = new OperationRegistry()
  const reminderRecipients = new Set<WebContents>()
  let reminderChangePending = false
  const remindersChanged = () => {
    if (reminderChangePending) return
    reminderChangePending = true
    queueMicrotask(() => {
      reminderChangePending = false
      for (const sender of reminderRecipients) {
        if (sender.isDestroyed()) reminderRecipients.delete(sender)
        else sender.send(REMINDERS_CHANGED_CHANNEL)
      }
    })
  }
  reminders.onChanged(remindersChanged)

  function handle(channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>): void {
    ipcMain.handle(channel, (event, input: unknown) => {
      if (!isTrustedSender(event)) throw new InvalidRequestError()
      reminderRecipients.add(event.sender)
      return handler(event, input)
    })
  }

  handle(IpcChannel.announcementGetState, async () => announcements.getState())
  handle(IpcChannel.announcementRefresh, async () => announcements.refresh())
  handle(IpcChannel.announcementTakeAutomatic, async () => announcements.takeAutomatic())
  handle(IpcChannel.announcementSuppress, async (_event, raw) => {
    const input = searchRecord(raw, ['date', 'content'])
    if (!isAnnouncementIdentity(input)) throw new InvalidRequestError()
    return announcements.suppress(input)
  })

  handle(IpcChannel.listBlocks, async () => store.listBlocks())
  handle(IpcChannel.setBlock, async (_event, raw) => {
    const input = record(raw)
    if (input.kind !== 'post' && input.kind !== 'cookie') throw new InvalidRequestError()
    if (typeof input.blocked !== 'boolean' || typeof input.value !== 'string' || input.value.length === 0 || input.value.length > 128 || input.value.includes('\0')) throw new InvalidRequestError()
    const value = input.kind === 'post' ? forumId(input.value) : input.value
    const { kind, blocked } = input
    return { saved: await attempt(() => store.setBlock(kind, value, blocked, new Date().toISOString())) }
  })
  handle(IpcChannel.listCookieColors, async () => store.listCookieColors())
  /** Matched verbatim, so the ID must already be in the form stored: trimmed and within the 饼干 ID rules. */
  const listedCookieId = (value: unknown): string => {
    if (typeof value !== 'string') throw new InvalidRequestError()
    const checked = validateCookieId(value)
    if (!checked.ok || checked.cookieId !== value) throw new InvalidRequestError()
    return value
  }
  handle(IpcChannel.addCookieColor, async (_event, raw) => {
    const cookieId = listedCookieId(searchRecord(raw, ['cookieId']).cookieId)
    try {
      return { saved: true, added: await store.addCookieColor(cookieId, new Date().toISOString()) }
    } catch {
      return { saved: false }
    }
  })
  handle(IpcChannel.setCookieColor, async (_event, raw) => {
    const input = searchRecord(raw, ['cookieId', 'color'])
    const cookieId = listedCookieId(input.cookieId)
    const { color } = input
    if (color !== null && !isCookieColorName(color)) throw new InvalidRequestError()
    return { saved: await attempt(() => store.setCookieColor(cookieId, color, new Date().toISOString())) }
  })
  handle(IpcChannel.removeCookieColor, async (_event, raw) => {
    const cookieId = listedCookieId(searchRecord(raw, ['cookieId']).cookieId)
    return { saved: await attempt(() => store.removeCookieColor(cookieId)) }
  })

  handle(IpcChannel.searchStart, async (event, raw) => {
    const input = searchRecord(raw, ['operationId', 'query', 'scope', 'filters'])
    if (typeof input.query !== 'string' || input.query.length === 0 || input.query.length > 512 || input.query.includes('\0')) throw new InvalidRequestError()
    return search.forOwner(String(event.sender.id)).start({ operationId: operationId(input), query: input.query,
      scope: searchScope(input.scope), filters: searchFilters(input.filters) })
  })
  handle(IpcChannel.searchNext, async (event, raw) => search.forOwner(String(event.sender.id)).next({ operationId: operationId(searchRecord(raw, ['operationId'])) }))
  handle(IpcChannel.searchCancel, async (event, raw) => search.forOwner(String(event.sender.id)).cancel({ operationId: operationId(searchRecord(raw, ['operationId'])) }))
  handle(IpcChannel.searchFetchThread, async (event, raw) => {
    const input = searchRecord(raw, ['operationId', 'threadId'])
    return search.forOwner(String(event.sender.id)).fetchThread({ operationId: operationId(input), threadId: forumId(input.threadId) })
  })
  handle(IpcChannel.searchFetchStatus, async (event, raw) => search.forOwner(String(event.sender.id)).fetchStatus({ operationId: operationId(searchRecord(raw, ['operationId'])) }))
  handle(IpcChannel.searchRebuild, async (event, raw) => search.forOwner(String(event.sender.id)).rebuild({ operationId: operationId(searchRecord(raw, ['operationId'])) }))
  handle(IpcChannel.searchThreadMetadata, async (event, raw) => {
    const input = searchRecord(raw, ['threadIds'])
    if (!Array.isArray(input.threadIds) || input.threadIds.length > 200) throw new InvalidRequestError()
    return search.forOwner(String(event.sender.id)).threadMetadata({ threadIds: input.threadIds.map(forumId) })
  })

  const enforceQuota = () => { void content.enforceQuota().catch(() => console.error('[content] cleanup failed')) }
  const boolean = (value: unknown): boolean => {
    if (typeof value !== 'boolean') throw new InvalidRequestError()
    return value
  }
  const threadIds = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 500) throw new InvalidRequestError()
    return [...new Set(value.map(forumId))]
  }
  handle(IpcChannel.reminderGetRules, async (_event, raw) => reminders.getRules({ threadIds: threadIds(record(raw).threadIds) }))
  handle(IpcChannel.reminderSetRule, async (_event, raw) => {
    const input = record(raw)
    const kind = input.kind
    if (kind !== 'all' && kind !== 'po' && kind !== 'quote') throw new InvalidRequestError()
    return reminders.setRule({ threadId: forumId(input.threadId), kind, enabled: boolean(input.enabled) })
  })
  handle(IpcChannel.reminderOverview, async () => reminders.overview())
  handle(IpcChannel.reminderCheck, async () => reminders.check())
  handle(IpcChannel.reminderCancel, async () => reminders.cancel())
  handle(IpcChannel.reminderCloseForThreads, async (_event, raw) => {
    const input = record(raw)
    const reason = input.reason
    if (reason !== 'unsubscribe' && reason !== 'sync-delete') throw new InvalidRequestError()
    return reminders.closeForThreads({ threadIds: threadIds(input.threadIds), reason })
  })
  handle(IpcChannel.reminderClear, async (_event, raw) => reminders.clear({ threadId: forumId(record(raw).threadId) }))
  handle(IpcChannel.reminderDismissRateLimit, async (_event, raw) => {
    const id = record(raw).id
    if (typeof id !== 'string' || id.length > 128 || id.length === 0) throw new InvalidRequestError()
    return reminders.dismissRateLimit({ id })
  })
  handle(IpcChannel.listHistory, async () => content.listHistory())
  handle(IpcChannel.listOffline, async () => content.listOffline())
  handle(IpcChannel.clearHistory, async (_event, raw) => {
    const input = record(raw)
    return content.clearHistory({ threadId: input.threadId === null ? null : forumId(input.threadId), clearReading: boolean(input.clearReading) })
  })
  handle(IpcChannel.contentUsage, async () => content.usage())
  handle(IpcChannel.setCacheLimit, async (_event, raw) => {
    const bytes = record(raw).bytes
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) throw new InvalidRequestError()
    return content.setCacheLimit({ bytes })
  })
  handle(IpcChannel.clearCache, async () => content.clearCache())
  handle(IpcChannel.saveOffline, async (_event, raw) => {
    const input = record(raw)
    return content.saveOffline({ threadId: forumId(input.threadId), includeImages: boolean(input.includeImages) })
  })
  handle(IpcChannel.offlineStatus, async (_event, raw) => content.offlineStatus({ threadId: forumId(record(raw).threadId) }))
  handle(IpcChannel.cancelOffline, async (_event, raw) => content.cancelOffline({ threadId: forumId(record(raw).threadId) }))
  handle(IpcChannel.deleteOffline, async (_event, raw) => {
    const threadId = forumId(record(raw).threadId)
    const result = await content.deleteOffline({ threadId })
    if (result.ok) {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.webContents.isDestroyed()) window.webContents.send(OFFLINE_CHANGED_CHANNEL, threadId)
      }
    }
    return result
  })
  handle(IpcChannel.holdContentReader, async (event, raw) => {
    const input = record(raw)
    await content.holdReader(String(event.sender.id), { viewId: viewId(input.viewId), threadId: forumId(input.threadId) })
  })
  handle(IpcChannel.releaseContentReader, async (event, raw) => {
    await content.releaseReader(String(event.sender.id), { viewId: viewId(record(raw).viewId) })
  })

  handle(IpcChannel.loadDirectory, async (event, raw) => {
    const input = record(raw)
    const strategy = input.strategy
    if (!STRATEGIES.includes(strategy as DirectoryStrategy)) throw new InvalidRequestError()
    return operations.run(event.sender, operationId(input), (signal) => reading.loadDirectory(strategy as DirectoryStrategy, signal)).finally(enforceQuota)
  })

  handle(IpcChannel.readFeedPage, async (event, raw) => {
    const input = record(raw)
    const feed = feedRef(input.feed)
    const pageNumber = page(input.page)
    return operations.run(event.sender, operationId(input), (signal) => reading.readFeedPage(feed, pageNumber, signal)).finally(enforceQuota)
  })

  handle(IpcChannel.readThreadPage, async (event, raw) => {
    const input = record(raw)
    const threadId = forumId(input.threadId)
    const mode = readingMode(input.mode)
    const pageNumber = page(input.page)
    const id = operationId(input)
    return operations.run(event.sender, id, async (signal) => {
      const held = { viewId: `request-${id}`, threadId }
      await content.holdReader(String(event.sender.id), held).catch(() => undefined)
      try { return await reading.readThreadPage(threadId, mode, pageNumber, signal) }
      finally { await content.releaseReader(String(event.sender.id), held).catch(() => undefined) }
    })
  })

  handle(IpcChannel.locateThreadEnd, async (event, raw) => {
    const input = record(raw)
    const threadId = forumId(input.threadId)
    const mode = readingMode(input.mode)
    const id = operationId(input)
    return operations.run(event.sender, id, async (signal) => {
      const held = { viewId: `request-${id}`, threadId }
      await content.holdReader(String(event.sender.id), held).catch(() => undefined)
      try { return await reading.locateThreadEnd(threadId, mode, signal) }
      finally { await content.releaseReader(String(event.sender.id), held).catch(() => undefined) }
    })
  })

  handle(IpcChannel.previewQuote, async (event, raw) => {
    const input = record(raw)
    const postId = forumId(input.postId)
    return operations.run(event.sender, operationId(input), (signal) => reading.previewQuote(postId, signal)).finally(enforceQuota)
  })

  handle(IpcChannel.locateQuote, async (event, raw) => {
    const input = record(raw)
    const postId = forumId(input.postId)
    const id = operationId(input)
    const hint = locateHint(input.hint)
    return operations.run(event.sender, id, async (signal) => {
      const relation = await store.findPostThread(postId).catch(() => null)
      const held = { viewId: `request-${id}`, threadId: relation?.threadId ?? hint?.threadId ?? postId }
      await content.holdReader(owner(event.sender), held).catch(() => undefined)
      try { return await reading.locateQuote(postId, signal, hint) }
      finally { await content.releaseReader(owner(event.sender), held).catch(() => undefined) }
    })
  })

  handle(IpcChannel.runOnlineSearch, async (event, raw) => {
    const input = searchRecord(raw, ['sessionId', 'channel', 'query'])
    return onlineSearch.run(owner(event.sender), sessionId(input), searchChannel(input.channel), searchQuery(input.query))
  })
  handle(IpcChannel.onlineSearchPage, async (event, raw) => {
    const input = searchRecord(raw, ['sessionId', 'channel', 'page'])
    const pageNumber = input.page
    if (typeof pageNumber !== 'number' || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > MAX_SEARCH_PAGE) throw new InvalidRequestError()
    return onlineSearch.page(owner(event.sender), sessionId(input), searchChannel(input.channel), pageNumber)
  })
  handle(IpcChannel.cancelOnlineSearch, async (event, raw) => {
    const input = searchRecord(raw, ['sessionId', 'channel'])
    onlineSearch.cancel(owner(event.sender), sessionId(input), searchChannel(input.channel))
  })
  handle(IpcChannel.closeOnlineSearch, async (event, raw) => {
    const input = searchRecord(raw, ['sessionId', 'channel'])
    onlineSearch.close(owner(event.sender), sessionId(input), searchChannel(input.channel))
  })
  handle(IpcChannel.openOnlineSearchSite, async (_event, raw) => {
    const input = searchRecord(raw, ['channel'])
    await shell.openExternal(SEARCH_SITE_URLS[searchChannel(input.channel)])
    return { opened: true }
  })
  handle(IpcChannel.searchThreadOf, async (event, raw) => {
    const input = searchRecord(raw, ['operationId', 'postId'])
    if (typeof input.postId !== 'string' || !/^[1-9]\d{0,19}$/.test(input.postId)) throw new InvalidRequestError()
    const postId = input.postId
    return operations.run(event.sender, operationId(input), (signal) => onlineSearch.threadOf(postId, signal))
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

  handle(IpcChannel.recordVisit, async (_event, raw) => {
    const threadId = forumId(record(raw).threadId)
    return { saved: await attempt(() => store.recordVisit(threadId, new Date().toISOString())) }
  })

  handle(IpcChannel.getSettings, async () => settings.get())

  handle(IpcChannel.updateSettings, async (_event, raw) => settings.update(record(raw)))

  const themeFilters = [{ name: '汐岛主题', extensions: ['json'] }]

  handle(IpcChannel.importTheme, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = { title: '导入主题', properties: ['openFile' as const], filters: themeFilters }
    const choice = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return settings.importTheme(choice.canceled ? null : (choice.filePaths[0] ?? null))
  })

  handle(IpcChannel.exportTheme, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = { title: '导出主题', defaultPath: themeFileName(await settings.get()), filters: themeFilters }
    const choice = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
    return settings.exportTheme(choice.canceled || !choice.filePath ? null : choice.filePath, systemPrefersDark())
  })

  handle(IpcChannel.getZoom, async (event) => currentZoom(event.sender))

  handle(IpcChannel.updateTitleBar, async (event, raw) => {
    const input = record(raw)
    if (typeof input.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(input.color) || typeof input.symbolColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(input.symbolColor) || (input.scheme !== 'system' && input.scheme !== 'light' && input.scheme !== 'dark')) throw new InvalidRequestError()
    nativeTheme.themeSource = input.scheme
    const window = BrowserWindow.fromWebContents(event.sender)
    if (process.platform !== 'darwin') window?.setTitleBarOverlay({ color: input.color, symbolColor: input.symbolColor, height: 44 })
  })

  // Only on the sender's own window (the trusted main window); the clipboard is never read here.
  handle(IpcChannel.clipboard, async (event, raw) => {
    const input = record(raw)
    if (input.command === 'writeText') {
      if (typeof input.text !== 'string' || input.text.length === 0 || input.text.length > MAX_CLIPBOARD_TEXT_LENGTH) throw new InvalidRequestError()
      clipboard.writeText(input.text)
      return
    }
    if (!CLIPBOARD_EDIT_COMMANDS.includes(input.command as ClipboardEditCommand)) throw new InvalidRequestError()
    const command = input.command as ClipboardEditCommand
    if (command === 'cut') event.sender.cut()
    else if (command === 'copy') event.sender.copy()
    else if (command === 'paste') event.sender.paste()
    else event.sender.selectAll()
  })

  handle(IpcChannel.zoom, async (event, raw) => {
    const action = record(raw).action
    if (action !== 'in' && action !== 'out' && action !== 'reset') throw new InvalidRequestError()
    return applyZoom(event.sender, action satisfies ZoomAction)
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

  handle(IpcChannel.loadImage, async (event, raw) => {
    const input = record(raw)
    if (input.refresh !== undefined && typeof input.refresh !== 'boolean') throw new InvalidRequestError()
    if (input.localOnly !== undefined && typeof input.localOnly !== 'boolean') throw new InvalidRequestError()
    const load = {
      viewId: viewId(input.viewId),
      postId: forumId(input.postId),
      kind: imageKind(input.kind),
      refresh: input.refresh === true,
      localOnly: input.localOnly === true
    }
    return operations.run(event.sender, operationId(input), (signal) => images.load(String(event.sender.id), load, signal)).finally(enforceQuota)
  })

  handle(IpcChannel.cancelImage, async (event, raw) => {
    operations.cancel(event.sender, operationId(record(raw)))
  })

  handle(IpcChannel.releaseImageView, async (event, raw) => {
    await images.releaseView(String(event.sender.id), viewId(record(raw).viewId))
    enforceQuota()
  })

  handle(IpcChannel.saveOriginalImage, async (event, raw) => {
    const postId = forumId(record(raw).postId)
    return images.saveOriginal(postId, (suggestedName, format) => chooseSavePath(event.sender, suggestedName, format))
  })

  handle(IpcChannel.copyOriginalImage, async (_event, raw) => {
    const input = searchRecord(raw, ['postId', 'url'])
    const postId = forumId(input.postId)
    if (typeof input.url !== 'string' || !/^xidao-image:\/\/file\/[0-9a-f]{32}\.(jpg|png|gif|webp)$/.test(input.url)) throw new InvalidRequestError()
    return images.copyOriginal(postId, input.url)
  })

  handle(IpcChannel.accountOverview, async () => account.getOverview())
  handle(IpcChannel.accountLogin, async () => account.login())
  handle(IpcChannel.accountList, async () => account.list())
  handle(IpcChannel.accountForget, async () => account.forget())
  handle(IpcChannel.accountImport, async (_event, raw) => {
    const ids = record(raw).ids
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_CREDENTIALS ||
        ids.some((id) => typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id))) throw new InvalidRequestError()
    return account.importSelected({ ids })
  })

  // Identity operations: secrets travel only renderer → main during import and are never returned.
  handle(IpcChannel.identityOverview, async () => identities.getOverview())

  handle(IpcChannel.identityImportExport, async (_event, raw) => {
    const input = record(raw)
    const name = input.name === undefined || input.name === null ? null : text(input.name)
    return identities.importExport(text(input.payload), name)
  })

  handle(IpcChannel.identityImportRaw, async (_event, raw) => {
    const input = record(raw)
    const name = input.name === undefined || input.name === null ? null : text(input.name)
    return identities.importRaw(text(input.userhash), text(input.cookieId), name)
  })

  handle(IpcChannel.identityRename, async (_event, raw) => {
    const input = record(raw)
    return identities.rename(credentialId(input.credentialId), text(input.name))
  })

  handle(IpcChannel.identitySetCookieId, async (_event, raw) => {
    const input = record(raw)
    return identities.setCookieId(credentialId(input.credentialId), text(input.cookieId))
  })

  handle(IpcChannel.identityRemove, async (_event, raw) => identities.remove(credentialId(record(raw).credentialId)))

  handle(IpcChannel.identitySelect, async (_event, raw) => {
    const input = record(raw)
    const id = input.credentialId === null ? null : credentialId(input.credentialId)
    return identities.select(identityRole(input.role), id)
  })

  handle(IpcChannel.identityReorder, async (_event, raw) => {
    const ids = record(raw).credentialIds
    if (!Array.isArray(ids) || ids.length > MAX_CREDENTIALS) throw new InvalidRequestError()
    return identities.reorder(ids.map(credentialId))
  })

  // Drafts and posting identity choice: local only, nothing reaches the forum.
  handle(IpcChannel.listDrafts, async () => drafts.list())
  handle(IpcChannel.saveDraft, async (_event, raw) => drafts.save(draftSaveInput(raw)))
  handle(IpcChannel.deleteDraft, async (_event, raw) => drafts.delete(localId(record(raw).draftId)))

  handle(IpcChannel.attachDraftImage, async (event, raw) => {
    const editorId = viewId(record(raw).editorId)
    return drafts.attachImage(String(event.sender.id), editorId, await chooseImageFile(event.sender))
  })

  handle(IpcChannel.holdDraftAttachment, async (event, raw) => {
    const input = record(raw)
    const attachmentId = input.attachmentId === null ? null : localId(input.attachmentId)
    await drafts.holdAttachment(String(event.sender.id), viewId(input.editorId), attachmentId)
  })

  handle(IpcChannel.releaseEditor, async (event, raw) => {
    await drafts.releaseEditor(String(event.sender.id), viewId(record(raw).editorId))
  })

  handle(IpcChannel.postingIdentityFor, async (_event, raw) => drafts.identityFor(postTarget(record(raw).target)))

  handle(IpcChannel.selectThreadIdentity, async (_event, raw) => {
    const input = record(raw)
    return drafts.selectThreadIdentity(forumId(input.threadId), credentialId(input.credentialId))
  })

  handle(IpcChannel.subscriptionOverview, async () => subscriptions.getOverview())

  handle(IpcChannel.subscriptionConfigureApp, async (_event, raw) => {
    const uuid = record(raw).uuid
    if (uuid !== null && (typeof uuid !== 'string' || uuid.length > 64)) throw new InvalidRequestError()
    return subscriptions.configureApp({ uuid })
  })

  // The one path a subscription secret takes back to the renderer: the settings view's UUID field.
  handle(IpcChannel.subscriptionRevealApp, async () => subscriptions.revealAppUuid())

  handle(IpcChannel.subscriptionSelectSource, async (_event, raw) =>
    subscriptions.selectSource({ source: subscriptionSource(record(raw).source) }))

  handle(IpcChannel.subscriptionObservation, async (_event, raw) =>
    subscriptions.getObservation({ source: subscriptionSource(record(raw).source) }))

  handle(IpcChannel.subscriptionSnapshot, async (_event, raw) =>
    subscriptions.getSnapshot({ source: subscriptionSource(record(raw).source) }))

  handle(IpcChannel.subscriptionRead, async (event, raw) => {
    const input = record(raw)
    const request = {
      source: subscriptionSource(input.source),
      observationId: input.observationId === null ? null : viewId(input.observationId),
      operationId: operationId(input)
    }
    const result = await subscriptionReads.run(event.sender, request.operationId, (signal) => subscriptions.read(request, signal))
    enforceQuota()
    return result
  })

  handle(IpcChannel.subscriptionChange, async (event, raw) => {
    const input = record(raw)
    const { action, expectedGeneration } = input
    if (action !== 'add' && action !== 'remove') throw new InvalidRequestError()
    if (typeof expectedGeneration !== 'number' || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
      throw new InvalidRequestError()
    }
    const request: Parameters<SubscriptionService['change']>[0] = {
      source: subscriptionSource(input.source), threadId: forumId(input.threadId),
      action, expectedGeneration, operationId: operationId(input)
    }
    // The service does not pass this cancellation signal to its explicit write request.
    const result = await subscriptionReads.run(event.sender, request.operationId, (signal) => subscriptions.change(request, signal))
    enforceQuota()
    return result
  })

  handle(IpcChannel.subscriptionOperations, async () => subscriptions.getOperations())

  handle(IpcChannel.subscriptionReconcile, async (event, raw) => {
    const input = record(raw)
    const request = { id: viewId(input.id), operationId: operationId(input) }
    const result = await subscriptionReads.run(event.sender, request.operationId, (signal) => subscriptions.reconcile(request, signal))
    enforceQuota()
    return result
  })

  handle(IpcChannel.subscriptionDismiss, async (_event, raw) =>
    subscriptions.dismiss({ id: viewId(record(raw).id) }))

  handle(IpcChannel.subscriptionMergeSources, async () => subscriptions.getMergeSources())
  handle(IpcChannel.subscriptionPlans, async () => subscriptions.getPlans())

  handle(IpcChannel.subscriptionPreviewSync, async (event, raw) => {
    const request = { operationId: operationId(record(raw)) }
    return subscriptionReads.run(event.sender, request.operationId, (signal) => subscriptions.previewSync(request, signal))
  })

  handle(IpcChannel.subscriptionPreviewMerge, async (event, raw) => {
    const input = record(raw)
    const request = { sourceAppCredentialId: viewId(input.sourceAppCredentialId), operationId: operationId(input) }
    return subscriptionReads.run(event.sender, request.operationId, (signal) => subscriptions.previewMerge(request, signal))
  })

  handle(IpcChannel.subscriptionExecutePlan, async (event, raw) => {
    const input = record(raw)
    if (!Array.isArray(input.choices) || input.choices.length > 100_000) throw new InvalidRequestError()
    const request = {
      previewId: viewId(input.previewId),
      choices: input.choices.map((value): SubscriptionItemChoice => {
        const { itemId, choice } = record(value)
        if (choice !== 'both' && choice !== 'none' && choice !== 'skip') throw new InvalidRequestError()
        return { itemId: viewId(itemId), choice }
      }),
      operationId: operationId(input)
    }
    return subscriptionReads.run(event.sender, request.operationId, (signal) => subscriptions.executePlan(request, signal))
  })

  handle(IpcChannel.subscriptionCancel, async (event, raw) => {
    subscriptionReads.cancel(event.sender, operationId(record(raw)))
  })
  handle(IpcChannel.submitPublication, async (_event, raw) => {
    const input = record(raw)
    return publication.submit({ requestId: viewId(input.requestId), editorId: viewId(input.editorId), payload: draftSaveInput(input.payload) })
  })
  handle(IpcChannel.resolvePoPrompt, async (_event, raw) => {
    const input = record(raw)
    const answer = record(input.answer)
    const token = viewId(input.token)
    if (answer.kind === 'cancel') return publication.resolvePrompt({ token, answer: { kind: 'cancel' } })
    if (answer.kind !== 'send' || typeof answer.suppress !== 'boolean') throw new InvalidRequestError()
    return publication.resolvePrompt({ token, answer: { kind: 'send', credentialId: localId(answer.credentialId), suppress: answer.suppress } })
  })
  handle(IpcChannel.listPublications, async () => publication.listAttempts())
  handle(IpcChannel.getPublication, async (_event, raw) => publication.getAttempt({ attemptId: localId(record(raw).attemptId) }))
  handle(IpcChannel.getPoWarning, async () => publication.getPoWarning())
  handle(IpcChannel.setPoWarning, async (_event, raw) => {
    const input = record(raw)
    if (typeof input.enabled !== 'boolean') throw new InvalidRequestError()
    return publication.setPoWarning({ enabled: input.enabled })
  })

  // Window lifecycle. The serialized workspace is opaque here; the renderer validates it on load.
  handle(IpcChannel.lifecycleReside, async () => lifecycle.reside())
  // A renderer quit is always an ordinary quit; only `updates.installAndRestart` quits for installing.
  handle(IpcChannel.lifecycleRequestQuit, async () => lifecycle.requestQuit('quit'))
  handle(IpcChannel.lifecyclePresentQuit, async () => lifecycle.presentQuit())
  handle(IpcChannel.lifecycleCancelQuit, async () => lifecycle.cancelQuit())
  handle(IpcChannel.lifecycleCompleteQuit, async (_event, raw) => {
    const draftsSaved = record(raw).draftsSaved
    if (typeof draftsSaved !== 'boolean') throw new InvalidRequestError()
    lifecycle.completeQuit(draftsSaved)
  })
  handle(IpcChannel.loadWorkspace, async () => {
    try {
      return { ok: true, workspace: await store.loadWorkspace() }
    } catch {
      return { ok: false }
    }
  })
  handle(IpcChannel.saveWorkspace, async (_event, raw) => {
    const workspace = record(raw).workspace
    if (typeof workspace !== 'string' || workspace.length > MAX_WORKSPACE_LENGTH) throw new InvalidRequestError()
    return { ok: await attempt(() => store.saveWorkspace(workspace, new Date().toISOString())) }
  })
  handle(IpcChannel.listLaunchNotices, async () => {
    try {
      return { ok: true, attempts: await store.listLaunchNotices() }
    } catch {
      return { ok: false }
    }
  })
  handle(IpcChannel.dismissLaunchNotices, async (_event, raw) => {
    const ids = record(raw).attemptIds
    if (!Array.isArray(ids) || ids.length > 1000) throw new InvalidRequestError()
    const attemptIds = ids.map(localId)
    return { ok: await attempt(() => store.dismissLaunchNotices(attemptIds)) }
  })
  handle(IpcChannel.listUnstoredResults, async () => ({ attempts: publication.unstoredResults() }))
  handle(IpcChannel.retryUnstoredResults, async () => ({ ok: await publication.retryUnstored().catch(() => false) }))

  // Software updates: no input names a URL, path or version to fetch; the source is fixed.
  handle(IpcChannel.updateGetState, async () => updates.state())
  handle(IpcChannel.updateCheck, async () => { await updates.check() })
  handle(IpcChannel.updateDownload, async () => { await updates.download() })
  handle(IpcChannel.updateCancelDownload, async () => updates.cancelDownload())
  handle(IpcChannel.updateInstallAndRestart, async () => updates.installAndRestart())
  handle(IpcChannel.updateOpenInstaller, async () => updates.openInstaller())
  handle(IpcChannel.updateAcknowledgeNotice, async (_event, raw) => {
    const { version, kind } = record(raw)
    if (typeof version !== 'string' || version.length > 32 || (kind !== 'available' && kind !== 'ready')) throw new InvalidRequestError()
    await updates.acknowledgeNotice(version, kind)
  })

  handle(IpcChannel.getStatus, async () => getStatus())

  return {
    cancelAllFor: (sender) => {
      reminderRecipients.delete(sender)
      account.cancel()
      operations.cancelAllFor(sender)
      subscriptionReads.cancelAllFor(sender)
      publication.releasePrompts()
      search.releaseOwner(String(sender.id))
      onlineSearch.closeAll(owner(sender))
      void images.releaseOwner(String(sender.id)).catch(() => undefined)
      void drafts.releaseOwner(String(sender.id))
      void content.releaseOwner(String(sender.id)).catch(() => undefined)
    },
    cancelAll: () => {
      account.cancel()
      operations.cancelAll()
      subscriptionReads.cancelAll()
    }
  }
}
