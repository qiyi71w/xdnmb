import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SearchOutcome } from '../../src/shared/online-search'
import { OnlineSearchSession } from '../../src/renderer/src/features/search/onlineSearchSession'

/**
 * Each `run` call waits until the test answers it, like the delayed service of the production scene.
 * `answer` resolves the call and waits for it: the session's handler, registered first, has run by then.
 */
function stubService() {
  const calls: { query: string; answer: (outcome: SearchOutcome) => Promise<SearchOutcome> }[] = []
  const run = vi.fn(({ query }: { sessionId: string; query: string }) => {
    const { promise, resolve } = Promise.withResolvers<SearchOutcome>()
    calls.push({
      query,
      answer: (outcome) => {
        resolve(outcome)
        return promise
      }
    })
    return promise
  })
  vi.stubGlobal('window', { xidao: { onlineSearch: { run, cancel: vi.fn(async () => undefined), close: vi.fn(async () => undefined) } } })
  return calls
}

const ok = (fetchedAt: string): SearchOutcome => ({ status: 'ok', page: { pageNumber: 1, hits: [], fetchedAt }, cached: false, next: 'end' })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('online search session: one run per awaited query', () => {
  it('drops repeats of the query it is still running (Enter, Enter, click) and applies the one answer', async () => {
    const calls = stubService()
    const session = new OnlineSearchSession(1)
    session.run('汐岛')
    session.run('汐岛')
    session.run('汐岛')
    expect(calls.map((call) => call.query)).toEqual(['汐岛'])
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
    const calls = stubService()
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
    const calls = stubService()
    const session = new OnlineSearchSession(3)
    session.run('丙')
    expect(session.cancel()).toBe(true)
    session.run('丙')
    expect(calls).toHaveLength(2)
  })
})
