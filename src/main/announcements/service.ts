import {
  ANNOUNCEMENT_URL, MAX_ANNOUNCEMENT_LENGTH, isAnnouncementIdentity, sameAnnouncement,
  type Announcement, type AnnouncementIdentity, type AnnouncementRecord, type AnnouncementState, type AnnouncementsApi
} from '../../shared/announcements'
import { parseContent } from '../forum/content'
import type { ForumTransport } from '../forum/contract'
import type { AppStore } from '../storage/contract'

export interface AnnouncementService extends AnnouncementsApi {
  start(): Promise<void>
  stop(): Promise<void>
}

type Store = Pick<AppStore, 'loadAnnouncements' | 'saveAnnouncements'>

function presented(record: NonNullable<AnnouncementRecord['latest']>): Announcement {
  const parsed = parseContent(record.content)
  if (!parsed.plainText.trim()) throw new Error('Empty announcement')
  const pending = parsed.nodes.map((node) => ({ node, depth: 0 }))
  while (pending.length) {
    const { node, depth } = pending.pop()!
    if (depth > 32) throw new Error('Announcement nesting limit')
    if ('children' in node) for (const child of node.children) pending.push({ node: child, depth: depth + 1 })
  }
  return { ...record, nodes: parsed.nodes }
}

/** Separate from forum reads: one cold-start attempt, and explicit single-flight retries only. */
export function createAnnouncementService(options: {
  store: Store
  transport: ForumTransport
  isForeground: () => boolean
  now?: () => string
}): AnnouncementService {
  let record: AnnouncementRecord = { latest: null, suppressed: null }
  let state: AnnouncementState = {
    latest: null, source: 'none', outcome: 'not-fetched', saved: true, storageAvailable: true
  }
  let initial: Promise<void> | null = null
  let inFlight: Promise<AnnouncementState> | null = null
  let controller: AbortController | null = null
  let stopped = false
  let automatic: Announcement | null = null
  let consumed = false
  let writes: Promise<unknown> = Promise.resolve()
  const now = options.now ?? (() => new Date().toISOString())

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = writes.then(work, work)
    writes = run.catch(() => undefined)
    return run
  }

  async function load(): Promise<void> {
    try {
      record = await options.store.loadAnnouncements()
      if (record.latest !== null) state = { ...state, latest: presented(record.latest), source: 'cached' }
    } catch {
      state = { ...state, storageAvailable: false }
    }
  }

  function fetch(coldStart: boolean): Promise<AnnouncementState> {
    if (inFlight !== null) return inFlight
    if (stopped) return Promise.resolve(state)
    controller = new AbortController()
    const signal = controller.signal
    const run = async (): Promise<AnnouncementState> => {
      let text: string
      try {
        // No identity argument: this dedicated transport has no credential origins.
        text = (await options.transport.get(new URL(ANNOUNCEMENT_URL), signal)).text
      } catch {
        state = { ...state, source: state.latest ? 'cached' : 'none', outcome: 'network-error' }
        return state
      }
      let latest: Announcement | null = null
      let enabled = false
      try {
        if (text.length > MAX_ANNOUNCEMENT_LENGTH) throw new Error('Announcement size limit')
        const raw: unknown = JSON.parse(text)
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Invalid announcement')
        const input = raw as Record<string, unknown>
        if (typeof input.enable !== 'boolean') throw new Error('Invalid announcement')
        enabled = input.enable
        // Disabled messages may carry an empty body, but still require a valid opaque version.
        const validDate = (typeof input.date === 'string' && input.date.length > 0 && input.date.length <= MAX_ANNOUNCEMENT_LENGTH) ||
          (typeof input.date === 'number' && Number.isSafeInteger(input.date))
        if (!validDate || typeof input.content !== 'string' || input.content.length > MAX_ANNOUNCEMENT_LENGTH) {
          throw new Error('Invalid announcement')
        }
        if (isAnnouncementIdentity(input)) latest = presented({ date: input.date, content: input.content, enable: enabled, fetchedAt: now() })
        else if (enabled) throw new Error('Empty announcement')
      } catch {
        state = { ...state, source: state.latest ? 'cached' : 'none', outcome: 'invalid' }
        return state
      }
      if (stopped) return state
      const received = latest
      await serial(async () => {
        const next = { ...record, latest: received === null ? record.latest : {
          date: received.date, content: received.content, enable: received.enable, fetchedAt: received.fetchedAt
        } }
        let saved = false
        // A failed initial read must not overwrite an unknown suppression choice.
        if (state.storageAvailable) {
          try { await options.store.saveAnnouncements(next); saved = true } catch { /* Keep current content for this run. */ }
        }
        record = next
        state = {
          latest: received ?? state.latest,
          source: received ? 'current' : state.latest ? 'cached' : 'none',
          outcome: enabled ? 'ready' : 'disabled', saved, storageAvailable: state.storageAvailable
        }
        if (coldStart && enabled && state.storageAvailable) automatic = received
      })
      return state
    }
    inFlight = run().finally(() => { inFlight = null; controller = null })
    return inFlight
  }

  const start = (): Promise<void> => {
    if (initial === null) initial = load().then(() => fetch(true)).then(() => undefined)
    return initial
  }

  return {
    start,
    async getState() { await start(); return state },
    async refresh() {
      // A click during the cold read joins that read rather than issuing a second request.
      if (inFlight !== null) return inFlight
      if (initial === null) { await start(); return state }
      await initial
      return fetch(false)
    },
    async takeAutomatic() {
      await start()
      if (stopped || consumed || !options.isForeground() || automatic === null || sameAnnouncement(automatic, record.suppressed)) return null
      consumed = true
      return automatic
    },
    async suppress(identity: AnnouncementIdentity) {
      await start()
      return serial(async () => {
        if (!state.storageAvailable || !isAnnouncementIdentity(identity)) return { saved: false }
        const next = { ...record, suppressed: { date: identity.date, content: identity.content } }
        try {
          await options.store.saveAnnouncements(next)
          record = next
          return { saved: true }
        } catch { return { saved: false } }
      })
    },
    async stop() {
      stopped = true
      controller?.abort()
      await initial
      await inFlight
      await writes
    }
  }
}
