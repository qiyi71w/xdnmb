import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { IpcChannel, MAX_MARK_READ_IDS, type AppStatus, type DirectoryStrategy, type ReadOutcome } from '../shared/api'
import type { FeedRef, PostId, ReadingMode } from '../shared/forum'
import type { ReadingAnchor } from '../shared/reading'
import type { ZoomAction } from '../shared/settings'
import { themeFileName, type SettingsService } from './appearance'
import type { ReadingService } from './reading/service'
import type { ReadingStore } from './storage/contract'
import { emptyReadingState } from './storage/reading-state'
import { applyZoom, currentZoom } from './zoom'

const OPERATION_ID = /^[A-Za-z0-9_-]{1,64}$/
const FORUM_ID = /^\d{1,20}$/
const STRATEGIES: readonly DirectoryStrategy[] = ['cache-first', 'background-refresh', 'refresh']
const MAX_PAGE = 100_000
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
  store: ReadingStore
  settings: SettingsService
  getStatus: () => AppStatus
  /** Operating system light/dark preference, for exporting a built-in scheme under `system`. */
  systemPrefersDark: () => boolean
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

  async run<T>(sender: WebContents, id: string, work: (signal: AbortSignal) => Promise<ReadOutcome<T>>): Promise<ReadOutcome<T>> {
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

export function registerIpc({ reading, store, settings, getStatus, systemPrefersDark, isTrustedSender }: IpcDeps): { cancelAllFor: (sender: WebContents) => void } {
  const operations = new OperationRegistry()

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

  handle(IpcChannel.getStatus, async () => getStatus())

  return { cancelAllFor: (sender) => operations.cancelAllFor(sender) }
}
