import { ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { IpcChannel, MAX_MARK_READ_IDS, type AppStatus, type DirectoryStrategy, type ReadOutcome } from '../shared/api'
import type { FeedRef, PostId, ReadingMode } from '../shared/forum'
import type { ImageFormat, ImageKind } from '../shared/images'
import { IDENTITY_ROLES, type CredentialId, type IdentityRole } from '../shared/identity'
import { DEFAULT_SETTINGS, type AppSettings, type ReadingAnchor } from '../shared/reading'
import type { IdentityService } from './identity/service'
import type { ImageService } from './images/service'
import type { ReadingService } from './reading/service'
import type { ReadingStore } from './storage/contract'
import { emptyReadingState } from './storage/reading-state'
import type { SubscriptionSource } from '../shared/subscriptions'
import type { SubscriptionService } from './subscriptions/service'

const OPERATION_ID = /^[A-Za-z0-9_-]{1,64}$/
const FORUM_ID = /^\d{1,20}$/
const STRATEGIES: readonly DirectoryStrategy[] = ['cache-first', 'background-refresh', 'refresh']
const MAX_PAGE = 100_000
const MAX_URL_LENGTH = 2048
const MAX_VIEWPORT_OFFSET = 100_000
const CREDENTIAL_ID = /^[1-9]\d{0,14}$/
/** Pasted input and names beyond this are refused outright; the parsers report smaller limits. */
const MAX_TEXT_LENGTH = 65_536

class InvalidRequestError extends Error {
  override readonly name = 'InvalidRequestError'
  constructor() {
    super('invalid request')
  }
}

interface IpcDeps {
  reading: ReadingService
  images: ImageService
  store: ReadingStore
  identities: IdentityService
  subscriptions: SubscriptionService
  getStatus: () => AppStatus
  /** True only for the app's own renderer document in its main frame. */
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  /** System save dialog for the sender's window; null when dismissed. */
  chooseSavePath: (sender: WebContents, suggestedName: string, format: ImageFormat) => Promise<string | null>
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

function postIds(value: unknown): PostId[] {
  if (!Array.isArray(value) || value.length > MAX_MARK_READ_IDS) throw new InvalidRequestError()
  return value.map(forumId)
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
}

export function registerIpc({ reading, images, identities, subscriptions, store, getStatus, isTrustedSender, chooseSavePath }: IpcDeps): {
  cancelAllFor: (sender: WebContents) => void
} {
  const operations = new OperationRegistry()
  const subscriptionReads = new OperationRegistry()

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

  handle(IpcChannel.loadImage, async (event, raw) => {
    const input = record(raw)
    if (input.refresh !== undefined && typeof input.refresh !== 'boolean') throw new InvalidRequestError()
    const load = {
      viewId: viewId(input.viewId),
      postId: forumId(input.postId),
      kind: imageKind(input.kind),
      refresh: input.refresh === true
    }
    return operations.run(event.sender, operationId(input), (signal) => images.load(String(event.sender.id), load, signal))
  })

  handle(IpcChannel.cancelImage, async (event, raw) => {
    operations.cancel(event.sender, operationId(record(raw)))
  })

  handle(IpcChannel.releaseImageView, async (event, raw) => {
    await images.releaseView(String(event.sender.id), viewId(record(raw).viewId))
  })

  handle(IpcChannel.saveOriginalImage, async (event, raw) => {
    const postId = forumId(record(raw).postId)
    return images.saveOriginal(postId, (suggestedName, format) => chooseSavePath(event.sender, suggestedName, format))
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
    return identities.importRaw(text(input.userhash), text(input.name))
  })

  handle(IpcChannel.identityRename, async (_event, raw) => {
    const input = record(raw)
    return identities.rename(credentialId(input.credentialId), text(input.name))
  })

  handle(IpcChannel.identityRemove, async (_event, raw) => identities.remove(credentialId(record(raw).credentialId)))

  handle(IpcChannel.identitySelect, async (_event, raw) => {
    const input = record(raw)
    const id = input.credentialId === null ? null : credentialId(input.credentialId)
    return identities.select(identityRole(input.role), id)
  })

  handle(IpcChannel.subscriptionOverview, async () => subscriptions.getOverview())

  handle(IpcChannel.subscriptionConfigureApp, async (_event, raw) => {
    const uuid = record(raw).uuid
    if (uuid !== null && (typeof uuid !== 'string' || uuid.length > 64)) throw new InvalidRequestError()
    return subscriptions.configureApp({ uuid })
  })

  handle(IpcChannel.subscriptionSelectSource, async (_event, raw) =>
    subscriptions.selectSource({ source: subscriptionSource(record(raw).source) }))

  handle(IpcChannel.subscriptionObservation, async (_event, raw) =>
    subscriptions.getObservation({ source: subscriptionSource(record(raw).source) }))

  handle(IpcChannel.subscriptionRead, async (event, raw) => {
    const input = record(raw)
    const request = {
      source: subscriptionSource(input.source),
      observationId: input.observationId === null ? null : viewId(input.observationId),
      operationId: operationId(input)
    }
    return subscriptionReads.run(event.sender, request.operationId, (signal) => subscriptions.read(request, signal))
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
    return subscriptionReads.run(event.sender, request.operationId, (signal) => subscriptions.change(request, signal))
  })

  handle(IpcChannel.subscriptionOperations, async () => subscriptions.getOperations())

  handle(IpcChannel.subscriptionReconcile, async (event, raw) => {
    const input = record(raw)
    const request = { id: viewId(input.id), operationId: operationId(input) }
    return subscriptionReads.run(event.sender, request.operationId, (signal) => subscriptions.reconcile(request, signal))
  })

  handle(IpcChannel.subscriptionCancel, async (event, raw) => {
    subscriptionReads.cancel(event.sender, operationId(record(raw)))
  })

  handle(IpcChannel.getStatus, async () => getStatus())

  return {
    cancelAllFor: (sender) => {
      operations.cancelAllFor(sender)
      subscriptionReads.cancelAllFor(sender)
      void images.releaseOwner(String(sender.id))
    }
  }
}
