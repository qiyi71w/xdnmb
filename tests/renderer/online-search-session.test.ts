import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SearchChannel, SearchNextState, SearchOutcome } from '../../src/shared/online-search'
import { OnlineSearchEntry, OnlineSearchSession, OnlineSearchSessions } from '../../src/renderer/src/features/search/onlineSearchSession'

interface Call {
  kind: 'run' | 'page'
  channel: SearchChannel
  query?: string
  page?: number
  answer: (outcome: SearchOutcome) => Promise<SearchOutcome>
}

/**
 * Each `run` / `page` call waits until the test answers it, like the delayed service of the production
 * scene. `answer` resolves the call and waits for it: the session's handler, registered first, has run by then.
 */
function stubService() {
  const calls: Call[] = []
  const pending = (call: Omit<Call, 'answer'>) => {
    const { promise, resolve } = Promise.withResolvers<SearchOutcome>()
    calls.push({
      ...call,
      answer: (outcome) => {
        resolve(outcome)
        return promise
      }
    })
    return promise
  }
  const run = vi.fn(({ channel, query }: { sessionId: string; channel: SearchChannel; query: string }) => pending({ kind: 'run', channel, query }))
  const page = vi.fn(({ channel, page }: { sessionId: string; channel: SearchChannel; page: number }) => pending({ kind: 'page', channel, page }))
  const cancel = vi.fn(async () => undefined)
  const close = vi.fn(async (_input: { sessionId: string; channel: SearchChannel }) => undefined)
  vi.stubGlobal('window', { xidao: { onlineSearch: { run, page, cancel, close } } })
  return { calls, run, page, cancel, close }
}

const page = (pageNumber: number, fetchedAt: string) => ({ pageNumber, hits: [], fetchedAt })
const ok = (fetchedAt: string, next: SearchNextState = 'end', pageNumber = 1): SearchOutcome =>
  ({ status: 'ok', page: page(pageNumber, fetchedAt), cached: false, next })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('online search session: one run per awaited query', () => {
  it('drops repeats of the query it is still running (Enter, Enter, click) and applies the one answer', async () => {
    const { calls } = stubService()
    const session = new OnlineSearchSession(1, 'xds')
    session.run('汐岛')
    session.run('汐岛')
    session.run('汐岛')
    expect(calls.map((call) => [call.channel, call.query])).toEqual([['xds', '汐岛']])
    expect(session.getState().pending).toEqual({ kind: 'run', query: '汐岛' })

    await calls[0]!.answer(ok('first'))
    const state = session.getState()
    expect(state.pending).toBeNull()
    expect(state.results).toMatchObject({ query: '汐岛', live: true, pages: [{ fetchedAt: 'first' }] })

    // Settled: the same query may run again (retry, 重新搜索).
    session.run('汐岛')
    expect(calls).toHaveLength(2)
  })

  it('still replaces an awaited run with a different query, dropping the older answer', async () => {
    const { calls } = stubService()
    const session = new OnlineSearchSession(2, 'nmb-search')
    session.run('甲')
    session.run('乙')
    expect(calls.map((call) => call.query)).toEqual(['甲', '乙'])
    expect(session.getState().pending).toEqual({ kind: 'run', query: '乙' })

    await calls[0]!.answer(ok('stale'))
    expect(session.getState().pending).toEqual({ kind: 'run', query: '乙' })
    expect(session.getState().results).toBeNull()

    await calls[1]!.answer(ok('fresh'))
    expect(session.getState().results).toMatchObject({ query: '乙', pages: [{ fetchedAt: 'fresh' }] })
  })

  it('runs the same query again after the awaited one was cancelled', () => {
    const { calls } = stubService()
    const session = new OnlineSearchSession(3, 'xds')
    session.run('丙')
    expect(session.cancel()).toBe(true)
    session.run('丙')
    expect(calls).toHaveLength(2)
  })
})

describe('online search channels of one search page', () => {
  it('starts on the given channel and switches without any request', () => {
    const { run, page, cancel, close } = stubService()
    const entry = new OnlineSearchSessions().entry(7, 'xds')
    expect(entry.getChannel()).toBe('xds')
    const listener = vi.fn()
    entry.subscribe(listener)
    expect(entry.setChannel('nmb-search')).toBe(true)
    expect(entry.setChannel('nmb-search')).toBe(false)
    entry.session('nmb-search')
    expect(entry.setChannel('xds')).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
    for (const call of [run, page, cancel, close]) expect(call).not.toHaveBeenCalled()
  })

  it('keeps query, results and pending requests per channel; a late answer lands only on its own channel', async () => {
    const { calls } = stubService()
    const entry = new OnlineSearchEntry(8, 'xds')
    const xds = entry.session('xds')
    xds.setDraft('甲')
    xds.run('甲')
    entry.setChannel('nmb-search')
    const nmb = entry.session('nmb-search')
    expect(nmb.getState()).toMatchObject({ draft: '', results: null, pending: null })
    nmb.setDraft('乙')
    nmb.run('乙')
    expect(calls.map((call) => [call.channel, call.query])).toEqual([['xds', '甲'], ['nmb-search', '乙']])

    // The XDS answer arrives while nmb-search is shown: it lands on XDS and leaves nmb-search waiting.
    await calls[0]!.answer(ok('xds-1', 'available'))
    expect(xds.getState().results).toMatchObject({ query: '甲', pages: [{ fetchedAt: 'xds-1' }] })
    expect(nmb.getState()).toMatchObject({ draft: '乙', pending: { kind: 'run', query: '乙' }, results: null })

    await calls[1]!.answer({ status: 'failed', error: { kind: 'rate-limited', retryAt: null }, next: 'end' })
    expect(nmb.getState().notice).toMatchObject({ kind: 'failed', error: { kind: 'rate-limited' } })
    // Back on XDS: its results, untouched by the other channel's failure.
    expect(xds.getState()).toMatchObject({ draft: '甲', notice: null, results: { query: '甲' } })
  })

  it('releases both channels once the entry leaves every history', () => {
    const { close } = stubService()
    const sessions = new OnlineSearchSessions()
    const entry = sessions.entry(9, 'xds')
    entry.session('xds')
    entry.session('nmb-search')
    sessions.retain(new Set())
    expect(close.mock.calls.map(([input]) => input)).toEqual([
      { sessionId: 'search-9', channel: 'xds' },
      { sessionId: 'search-9', channel: 'nmb-search' }
    ])
  })
})

describe('online search paging per channel', () => {
  async function onSecondPageRequest(channel: SearchChannel) {
    const service = stubService()
    const session = new OnlineSearchSession(10, channel)
    session.run('丁')
    await service.calls[0]!.answer(ok('p1', 'available'))
    session.goToPage(2)
    expect(service.calls[1]).toMatchObject({ kind: 'page', channel, page: 2 })
    return { ...service, session }
  }

  it('nmb-search: a cancelled next page spends its one-time token, never offered again', async () => {
    const { session, cancel } = await onSecondPageRequest('nmb-search')
    expect(session.cancel()).toBe(true)
    expect(cancel).toHaveBeenCalledWith({ sessionId: 'search-10', channel: 'nmb-search' })
    expect(session.getState().results?.next).toBe('lost')
    expect(session.canShow(2)).toBe(false)
  })

  it('XDS: a cancelled next page can be asked for again (numbered pages, nothing replayed)', async () => {
    const { session, cancel, calls } = await onSecondPageRequest('xds')
    expect(session.cancel()).toBe(true)
    expect(cancel).toHaveBeenCalledWith({ sessionId: 'search-10', channel: 'xds' })
    expect(session.getState().results?.next).toBe('available')
    expect(session.canShow(2)).toBe(true)
    session.goToPage(2)
    expect(calls).toHaveLength(3)
  })

  it('XDS: a failed page keeps the obtained ones and can be retried; busy blocks a second request', async () => {
    const { session, calls } = await onSecondPageRequest('xds')
    // While the page is awaited, no other page request starts.
    expect(session.canShow(2)).toBe(false)
    session.goToPage(2)
    expect(calls).toHaveLength(2)
    await calls[1]!.answer({ status: 'failed', error: { kind: 'network', detail: 'timeout' }, next: 'available' })
    expect(session.getState().results).toMatchObject({ current: 1, pages: [{ fetchedAt: 'p1' }], next: 'available' })
    session.goToPage(2)
    await calls[2]!.answer(ok('p2', 'end', 2))
    expect(session.getState().results).toMatchObject({ current: 2, next: 'end' })
    // An obtained page is asked of the main-process session, which serves it without a network request.
    session.goToPage(1)
    expect(calls[3]).toMatchObject({ kind: 'page', page: 1 })
  })

  it('nmb-search: an internal failure of a next page loses the token; XDS keeps it', async () => {
    for (const channel of ['nmb-search', 'xds'] as const) {
      vi.unstubAllGlobals()
      const service = stubService()
      service.page.mockImplementationOnce(async () => {
        throw new Error('ipc')
      })
      const session = new OnlineSearchSession(11, channel)
      session.run('戊')
      await service.calls[0]!.answer(ok('p1', 'available'))
      session.goToPage(2)
      await Promise.resolve()
      await Promise.resolve()
      expect(session.getState().notice).toMatchObject({ kind: 'internal' })
      expect(session.getState().results?.next).toBe(channel === 'nmb-search' ? 'lost' : 'available')
    }
  })
})
