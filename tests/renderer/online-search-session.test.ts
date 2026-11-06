import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SearchNextState, SearchOutcome } from '../../src/shared/online-search'
import { OnlineSearchSession, OnlineSearchSessions } from '../../src/renderer/src/features/search/onlineSearchSession'

interface Call {
  kind: 'run' | 'page'
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
  const run = vi.fn(({ query }: { sessionId: string; query: string }) => pending({ kind: 'run', query }))
  const page = vi.fn(({ page }: { sessionId: string; page: number }) => pending({ kind: 'page', page }))
  const cancel = vi.fn(async () => undefined)
  const close = vi.fn(async (_input: { sessionId: string }) => undefined)
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
    const { calls, run } = stubService()
    const session = new OnlineSearchSession(1)
    session.run('汐岛')
    session.run('汐岛')
    session.run('汐岛')
    expect(run.mock.calls).toEqual([[{ sessionId: 'search-1', query: '汐岛' }]])
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
    const session = new OnlineSearchSession(2)
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
    const session = new OnlineSearchSession(3)
    session.run('丙')
    expect(session.cancel()).toBe(true)
    session.run('丙')
    expect(calls).toHaveLength(2)
  })
})

describe('online search sessions of search pages', () => {
  it('keeps one session per entry and releases it once the entry leaves every history', () => {
    const { run, page, cancel, close } = stubService()
    const sessions = new OnlineSearchSessions()
    const session = sessions.session(9)
    expect(sessions.session(9)).toBe(session)
    expect(sessions.session(10)).not.toBe(session)
    for (const call of [run, page, cancel, close]) expect(call).not.toHaveBeenCalled()
    sessions.retain(new Set([10]))
    expect(close.mock.calls.map(([input]) => input)).toEqual([{ sessionId: 'search-9' }])
    expect(sessions.session(9)).not.toBe(session)
  })
})

describe('online search paging', () => {
  async function onSecondPageRequest() {
    const service = stubService()
    const session = new OnlineSearchSession(10)
    session.run('丁')
    await service.calls[0]!.answer(ok('p1', 'available'))
    session.goToPage(2)
    expect(service.calls[1]).toMatchObject({ kind: 'page', page: 2 })
    return { ...service, session }
  }

  it('a cancelled next page spends its one-time token, never offered again', async () => {
    const { session, cancel } = await onSecondPageRequest()
    expect(session.cancel()).toBe(true)
    expect(cancel).toHaveBeenCalledWith({ sessionId: 'search-10' })
    expect(session.getState().results?.next).toBe('lost')
    expect(session.canShow(2)).toBe(false)
  })

  it('a failed page keeps the obtained ones and offers no retry; busy blocks a second request', async () => {
    const { session, calls } = await onSecondPageRequest()
    // While the page is awaited, no other page request starts.
    expect(session.canShow(2)).toBe(false)
    session.goToPage(2)
    expect(calls).toHaveLength(2)
    await calls[1]!.answer({ status: 'failed', error: { kind: 'network', detail: 'timeout' }, next: 'lost' })
    expect(session.getState().results).toMatchObject({ current: 1, pages: [{ fetchedAt: 'p1' }], next: 'lost' })
    expect(session.canShow(2)).toBe(false)
  })

  it('an internal failure of a next page loses the token', async () => {
    const service = stubService()
    service.page.mockImplementationOnce(async () => {
      throw new Error('ipc')
    })
    const session = new OnlineSearchSession(11)
    session.run('戊')
    await service.calls[0]!.answer(ok('p1', 'available'))
    session.goToPage(2)
    await Promise.resolve()
    await Promise.resolve()
    expect(session.getState().notice).toMatchObject({ kind: 'internal' })
    expect(session.getState().results?.next).toBe('lost')
  })
})
