import { ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { IpcChannel, type AppStatus, type DirectoryStrategy, type ReadOutcome } from '../shared/api'
import type { FeedRef } from '../shared/forum'
import { IDENTITY_ROLES, type CredentialId, type IdentityRole } from '../shared/identity'
import type { IdentityService } from './identity/service'
import type { ReadingService } from './reading/service'

const OPERATION_ID = /^[A-Za-z0-9_-]{1,64}$/
const FORUM_ID = /^\d{1,20}$/
const STRATEGIES: readonly DirectoryStrategy[] = ['cache-first', 'background-refresh', 'refresh']
const MAX_PAGE = 100_000
const MAX_URL_LENGTH = 2048
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
  identities: IdentityService
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

export function registerIpc({ reading, identities, getStatus, isTrustedSender }: IpcDeps): { cancelAllFor: (sender: WebContents) => void } {
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
    const pageNumber = page(input.page)
    return operations.run(event.sender, operationId(input), (signal) => reading.readThreadPage(threadId, pageNumber, signal))
  })

  handle(IpcChannel.locateThreadEnd, async (event, raw) => {
    const input = record(raw)
    const threadId = forumId(input.threadId)
    return operations.run(event.sender, operationId(input), (signal) => reading.locateThreadEnd(threadId, signal))
  })

  handle(IpcChannel.cancel, async (event, raw) => {
    operations.cancel(event.sender, operationId(record(raw)))
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

  handle(IpcChannel.getStatus, async () => getStatus())

  return { cancelAllFor: (sender) => operations.cancelAllFor(sender) }
}
