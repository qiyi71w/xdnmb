import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QuoteLocation } from '../../src/shared/api'
import type { Post } from '../../src/shared/forum'
import type { ThreadOfOutcome } from '../../src/shared/online-search'
import { wholeSelectedNumber } from '../../src/renderer/src/features/quote/selectionNumber'
import { lookUpThread } from '../../src/renderer/src/features/quote/threadLookup'
import { initialQuoteState, quoteReducer, type QuoteAction, type QuoteSource, type QuoteState } from '../../src/renderer/src/features/quote/quoteState'
import {
  initialNumberOpenState,
  isCurrentStep,
  numberOpenReducer,
  type NumberOpenAction,
  type NumberOpenState
} from '../../src/renderer/src/features/search/numberOpenState'

const head: Post = {
  id: '100', forumId: '4', createdAt: null, userHash: null, name: null, title: null,
  isAdmin: null, isSage: null, content: [], plainText: '', image: null
}
const located = (postId: string, threadId = '100'): QuoteLocation => ({
  status: 'located', threadId, head, target: { postId, page: 2, mode: 'all' }, source: 'fresh', networkError: null
})
const run = (state: NumberOpenState, ...actions: NumberOpenAction[]) => actions.reduce(numberOpenReducer, state)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('selected numbers', () => {
  it('accepts a whole number standing on its own, of any length from 1 to 20 digits, as a string', () => {
    expect(wholeSelectedNumber('见 ', '1234567', ' 楼')).toBe('1234567')
    expect(wholeSelectedNumber('（', '12345678', '）')).toBe('12345678')
    expect(wholeSelectedNumber('', '123456789', '。')).toBe('123456789')
    expect(wholeSelectedNumber('', ' 12345678901234567890 ', '')).toBe('12345678901234567890')
    // A double-click selection may include the blank after it.
    expect(wholeSelectedNumber('看', '68810621 ', '吧')).toBe('68810621')
    // `No.` right before it is the same number.
    expect(wholeSelectedNumber('No.', '68810621', '')).toBe('68810621')
    // End of a sentence: a joiner not followed by a digit.
    expect(wholeSelectedNumber('在 ', '68810621', '. 然后')).toBe('68810621')
  })

  it('refuses invalid numbers and pieces of dates, times, amounts, words and longer numbers', () => {
    expect(wholeSelectedNumber('', '123456789012345678901', '')).toBeNull()
    expect(wholeSelectedNumber('', '0123', '')).toBeNull()
    expect(wholeSelectedNumber('', '12a', '')).toBeNull()
    expect(wholeSelectedNumber('', '', '')).toBeNull()
    expect(wholeSelectedNumber('2026-', '10', '-30')).toBeNull()
    expect(wholeSelectedNumber('', '2026', '-10-30')).toBeNull()
    expect(wholeSelectedNumber('12:', '30', '')).toBeNull()
    expect(wholeSelectedNumber('1,', '234', '.56')).toBeNull()
    expect(wholeSelectedNumber('', '3', '.14')).toBeNull()
    expect(wholeSelectedNumber('12', '345', '')).toBeNull()
    expect(wholeSelectedNumber('', '123', '45')).toBeNull()
    expect(wholeSelectedNumber('v', '2', '')).toBeNull()
    expect(wholeSelectedNumber('１', '23', '')).toBeNull()
    expect(wholeSelectedNumber('2026－', '10', '')).toBeNull()
  })
})

describe('按串号打开', () => {
  it('takes plain numbers, No., >>No. and verified links, and refuses anything else without a request', () => {
    for (const raw of ['68810621', ' No.68810621 ', '>>No.68810621', '>>68810621']) {
      const state = run(initialNumberOpenState, { type: 'submit', raw, newTab: false })
      expect(state.status).toMatchObject({ kind: 'locating', target: { postId: '68810621', hint: null } })
    }
    const link = run(initialNumberOpenState, { type: 'submit', raw: 'https://www.nmbxd1.com/t/68810621?r=68810699&page=3', newTab: true })
    expect(link.status).toMatchObject({ kind: 'locating', target: { postId: '68810699', hint: { threadId: '68810621', page: 3 }, newTab: true } })
    for (const raw of ['', '0123', '123456789012345678901', '12 34', 'https://example.com/t/1', '2026-10-30']) {
      expect(run(initialNumberOpenState, { type: 'submit', raw, newTab: false })).toEqual({ seq: 0, status: { kind: 'invalid' } })
    }
  })

  it('is busy while a step runs: a second submit, lookup or 打开原串 is dropped synchronously', () => {
    const started = run(initialNumberOpenState, { type: 'submit', raw: '68810621', newTab: false })
    expect(run(started, { type: 'submit', raw: '1', newTab: false })).toBe(started)
    expect(run(started, { type: 'lookup-start' })).toBe(started)
    expect(run(started, { type: 'open-thread-start' })).toBe(started)
    expect(run(started, { type: 'retry' })).toBe(started)
  })

  it('drops late and cancelled results; cancelling keeps what was known before', () => {
    let state = run(initialNumberOpenState, { type: 'submit', raw: '68810699', newTab: false })
    const first = state.seq
    state = run(state, { type: 'locate-done', seq: first, result: { status: 'unknown-thread' } })
    expect(state.status).toMatchObject({ kind: 'unknown-thread' })
    state = run(state, { type: 'lookup-start' })
    const lookup = state.seq
    state = run(state, { type: 'cancel' })
    expect(state.status).toMatchObject({ kind: 'unknown-thread' })
    // The cancelled lookup's answer arrives anyway: ignored, nothing follows it.
    expect(isCurrentStep(state, lookup)).toBe(false)
    expect(run(state, { type: 'lookup-done', seq: lookup, result: { status: 'located', location: located('68810699') as never } })).toBe(state)
    // A superseded locate's answer is ignored as well.
    expect(run(state, { type: 'locate-done', seq: first, result: located('68810699') })).toBe(state)
  })

  it('makes every running step stale on cancel, as leaving the page does: no late result is followed', () => {
    const locating = run(initialNumberOpenState, { type: 'submit', raw: '68810699', newTab: true })
    const unknown = run(locating, { type: 'locate-done', seq: locating.seq, result: { status: 'unknown-thread' } })
    const looking = run(unknown, { type: 'lookup-start' })
    const known = run(locating, { type: 'locate-done', seq: locating.seq, result: { status: 'thread-known', threadId: '100', head } })
    const opening = run(known, { type: 'open-thread-start' })
    for (const running of [locating, looking, opening]) {
      const left = run(running, { type: 'cancel' })
      expect(isCurrentStep(left, running.seq)).toBe(false)
      expect(run(left, { type: 'opened', seq: running.seq })).toBe(left)
      expect(run(left, { type: 'internal', seq: running.seq })).toBe(left)
    }
    expect(run(run(locating, { type: 'cancel' }), { type: 'locate-done', seq: locating.seq, result: located('68810699') }).status).toBeNull()
    expect(run(run(opening, { type: 'cancel' }), { type: 'open-thread-failed', seq: opening.seq, error: null }).status).toMatchObject({ kind: 'thread-known' })
  })

  it('offers the XDS lookup only for an unknown owner, and keeps its outcomes apart', () => {
    const unknown = run(initialNumberOpenState, { type: 'submit', raw: '68810699', newTab: false }, { type: 'locate-done', seq: 1, result: { status: 'unknown-thread' } })
    const known = run(initialNumberOpenState, { type: 'submit', raw: '68810699', newTab: false }, { type: 'locate-done', seq: 1, result: { status: 'thread-known', threadId: '100', head } })
    expect(run(known, { type: 'lookup-start' })).toBe(known)

    const looking = run(unknown, { type: 'lookup-start' })
    expect(looking.status).toMatchObject({ kind: 'looking-up', target: { postId: '68810699' } })
    const seq = looking.seq
    expect(run(looking, { type: 'lookup-done', seq, result: { status: 'not-indexed' } }).status).toMatchObject({ kind: 'not-indexed' })
    const limited = run(looking, { type: 'lookup-done', seq, result: { status: 'search-failed', error: { kind: 'rate-limited', retryAt: 1_800_000_000_000 } } })
    expect(limited.status).toMatchObject({ kind: 'search-failed', error: { kind: 'rate-limited' } })
    // A failed lookup can be asked again, explicitly.
    expect(run(limited, { type: 'lookup-start' }).status).toMatchObject({ kind: 'looking-up' })
    // XDS named the thread, the forum shows it but not the post: only 打开原串, never a located target.
    const parent = run(looking, { type: 'lookup-done', seq, result: { status: 'thread-known', threadId: '100', head } })
    expect(parent.status).toMatchObject({ kind: 'thread-known', known: { threadId: '100', via: 'xds' } })
    expect(run(parent, { type: 'lookup-start' })).toBe(parent)
    const unreadable = run(looking, { type: 'lookup-done', seq, result: { status: 'read-failed', threadId: '100', error: { kind: 'network', detail: 'timeout' } as never } })
    expect(unreadable.status).toMatchObject({ kind: 'failed', threadId: '100', via: 'xds' })
  })

  it('clears only once the target or the thread was opened; a failed 打开原串 keeps the way back', () => {
    const known = run(initialNumberOpenState, { type: 'submit', raw: '68810699', newTab: false }, { type: 'locate-done', seq: 1, result: { status: 'thread-known', threadId: '100', head } })
    const opening = run(known, { type: 'open-thread-start' })
    expect(opening.status).toMatchObject({ kind: 'opening', known: { threadId: '100' } })
    const failed = run(opening, { type: 'open-thread-failed', seq: opening.seq, error: null })
    expect(failed.status).toMatchObject({ kind: 'open-failed', error: null })
    const again = run(failed, { type: 'open-thread-start' })
    expect(run(again, { type: 'cancel' }).status).toMatchObject({ kind: 'thread-known' })
    expect(run(again, { type: 'opened', seq: again.seq }).status).toBeNull()
    // A located result shown while the page was out of sight is opened later from its 打开.
    const shown = run(initialNumberOpenState, { type: 'submit', raw: '68810699', newTab: false }, { type: 'locate-done', seq: 1, result: located('68810699') })
    expect(shown.status).toMatchObject({ kind: 'located' })
    expect(run(shown, { type: 'opened', seq: shown.seq }).status).toBeNull()
  })

  it('retries a failed local locate with the same target, never a missing one', () => {
    const failed = run(initialNumberOpenState, { type: 'submit', raw: '68810699', newTab: true }, {
      type: 'locate-done', seq: 1, result: { status: 'failed', threadId: null, error: { kind: 'network', detail: 'timeout' } as never }
    })
    expect(run(failed, { type: 'retry' }).status).toMatchObject({ kind: 'locating', target: { postId: '68810699', newTab: true } })
    const missing = run(initialNumberOpenState, { type: 'submit', raw: '68810699', newTab: false }, {
      type: 'locate-done', seq: 1, result: { status: 'failed', threadId: null, error: { kind: 'not-found' } as never }
    })
    expect(run(missing, { type: 'retry' })).toBe(missing)
  })
})

describe('explicit XDS lookup', () => {
  function stub(clue: ThreadOfOutcome, location: QuoteLocation) {
    const threadOf = vi.fn(async () => clue)
    const locate = vi.fn(async () => location)
    vi.stubGlobal('window', { xidao: { onlineSearch: { threadOf }, quotes: { locate } } })
    return { threadOf, locate }
  }

  it('uses the XDS thread only as a clue the reader verifies (first page, no page guess)', async () => {
    const { threadOf, locate } = stub({ status: 'found', postId: '68810699', threadId: '68810621', kind: 'reply' }, located('68810699', '68810621'))
    const result = await lookUpThread('op-1', '68810699', () => true)
    expect(threadOf).toHaveBeenCalledWith({ operationId: 'op-1', postId: '68810699' })
    expect(locate).toHaveBeenCalledWith({ operationId: 'op-1', postId: '68810699', hint: { threadId: '68810621', page: null } })
    expect(result).toMatchObject({ status: 'located', location: { threadId: '68810621' } })
  })

  it('reads nothing when XDS has nothing, failed, or the lookup is no longer wanted', async () => {
    for (const clue of [{ status: 'not-indexed' }, { status: 'failed', error: { kind: 'verification', httpStatus: 403 } }, { status: 'cancelled' }] as ThreadOfOutcome[]) {
      const { locate } = stub(clue, located('1'))
      const result = await lookUpThread('op', '1', () => true)
      expect(locate).not.toHaveBeenCalled()
      expect(result.status).toBe(clue.status === 'failed' ? 'search-failed' : clue.status)
    }
    const { locate } = stub({ status: 'found', postId: '1', threadId: '2', kind: 'reply' }, located('1', '2'))
    expect(await lookUpThread('op', '1', () => false)).toEqual({ status: 'cancelled' })
    expect(locate).not.toHaveBeenCalled()
  })

  it('reports a readable thread without the post as thread-known, not as located', async () => {
    stub({ status: 'found', postId: '68810699', threadId: '68810621', kind: 'reply' }, { status: 'thread-known', threadId: '68810621', head })
    expect(await lookUpThread('op', '68810699', () => true)).toEqual({ status: 'thread-known', threadId: '68810621', head })
  })
})

describe('quote card XDS lookup', () => {
  const source: QuoteSource = { tabId: 1, entryKey: 2, postId: '68810699', focus: { postId: '101', quoteIndex: 0 } }
  const apply = (state: QuoteState, ...actions: QuoteAction[]) => actions.reduce(quoteReducer, state)

  function unknownCard(): QuoteState {
    let state = apply(initialQuoteState, { type: 'open', source, trigger: 'activate' })
    const id = state.card!.id
    state = apply(state, { type: 'locate-start', cardId: id, intent: 'new-tab' })
    return apply(state, { type: 'locate-done', cardId: id, seq: state.card!.locate!.seq, result: { status: 'unknown-thread' } })
  }

  it('starts only after an unknown owner and keeps the jump the user asked for', () => {
    const state = unknownCard()
    const id = state.card!.id
    const looking = apply(state, { type: 'lookup-start', cardId: id })
    expect(looking.card!.locate).toMatchObject({ intent: 'new-tab', result: null, viaLookup: true, fallback: { status: 'unknown-thread' } })
    // Nothing else to look up while it runs, nor after a known owner.
    expect(apply(looking, { type: 'lookup-start', cardId: id })).toBe(looking)
    const known = apply(looking, { type: 'locate-done', cardId: id, seq: looking.card!.locate!.seq, result: { status: 'thread-known', threadId: '100', head } })
    expect(apply(known, { type: 'lookup-start', cardId: id })).toBe(known)
  })

  it('goes back to the unknown owner on cancel, and keeps what XDS said when it found nothing', () => {
    const state = unknownCard()
    const id = state.card!.id
    const looking = apply(state, { type: 'lookup-start', cardId: id })
    const seq = looking.card!.locate!.seq
    expect(apply(looking, { type: 'cancel-locate', cardId: id }).card!.locate).toMatchObject({ result: { status: 'unknown-thread' } })
    const noted = apply(looking, { type: 'lookup-done', cardId: id, seq, note: { status: 'not-indexed' } })
    expect(noted.card!.locate!.result).toEqual({ status: 'unknown-thread' })
    expect(noted.card!.lookup).toEqual({ status: 'not-indexed' })
    // A late answer of a cancelled lookup changes nothing.
    const cancelled = apply(looking, { type: 'cancel-locate', cardId: id })
    expect(apply(cancelled, { type: 'lookup-done', cardId: id, seq, note: { status: 'not-indexed' } })).toBe(cancelled)
  })
})
