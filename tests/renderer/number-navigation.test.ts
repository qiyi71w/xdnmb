import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QuoteLocation } from '../../src/shared/api'
import type { Post } from '../../src/shared/forum'
import { parseNumberTarget } from '../../src/shared/online-search'
import { wholeSelectedNumber } from '../../src/renderer/src/features/quote/selectionNumber'
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

describe('explicit number inputs', () => {
  it.each(['1', '1234567', '12345678', '123456789', '99999999999999999999'])('keeps %s exact', (value) => {
    for (const prefix of ['', 'No.', '>>No.']) expect(parseNumberTarget(` ${prefix}${value} `)).toEqual({ postId: value, hint: null })
  })
  it.each(['0', '012', '-1', '1.1', '1e3', '123456789012345678901', '2026-10-30', '$12345', 'text 12345', 'No.1 extra', 'https://evil.example/t/12'])('rejects whole invalid input %s', (value) => {
    expect(parseNumberTarget(value)).toBeNull()
  })
  it('keeps verified reply and page hints', () => {
    expect(parseNumberTarget('https://www.nmbxd1.com/t/1234567?page=9&r=99999999999999999999')).toEqual({ postId: '99999999999999999999', hint: { threadId: '1234567', page: 9 } })
  })
  it.each(['?r=abc', '?r=0', '?page=-1', '?page=0', '?page=1&r=2&r=3', '?page=1&callback=evil', '#other'])('rejects malformed or ambiguous explicit link %s instead of opening its parent', (suffix) => {
    expect(parseNumberTarget(`https://www.nmbxd1.com/t/1234567${suffix}`)).toBeNull()
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

  it('is busy while a step runs: a second submit or 打开原串 is dropped synchronously', () => {
    const started = run(initialNumberOpenState, { type: 'submit', raw: '68810621', newTab: false })
    expect(run(started, { type: 'submit', raw: '1', newTab: false })).toBe(started)
    expect(run(started, { type: 'open-thread-start' })).toBe(started)
    expect(run(started, { type: 'retry' })).toBe(started)
  })

  it('drops late and cancelled results; cancelling keeps what was known before', () => {
    let state = run(initialNumberOpenState, { type: 'submit', raw: '68810699', newTab: false })
    const first = state.seq
    state = run(state, { type: 'locate-done', seq: first, result: { status: 'thread-known', threadId: '100', head } })
    state = run(state, { type: 'open-thread-start' })
    const opening = state.seq
    state = run(state, { type: 'cancel' })
    expect(state.status).toMatchObject({ kind: 'thread-known' })
    // The cancelled step's answer arrives anyway: ignored, nothing follows it.
    expect(isCurrentStep(state, opening)).toBe(false)
    expect(run(state, { type: 'open-thread-failed', seq: opening, error: null })).toBe(state)
    // A superseded locate's answer is ignored as well.
    expect(run(state, { type: 'locate-done', seq: first, result: located('68810699') })).toBe(state)
  })

  it('makes every running step stale on cancel, as leaving the page does: no late result is followed', () => {
    const locating = run(initialNumberOpenState, { type: 'submit', raw: '68810699', newTab: true })
    const known = run(locating, { type: 'locate-done', seq: locating.seq, result: { status: 'thread-known', threadId: '100', head } })
    const opening = run(known, { type: 'open-thread-start' })
    for (const running of [locating, opening]) {
      const left = run(running, { type: 'cancel' })
      expect(isCurrentStep(left, running.seq)).toBe(false)
      expect(run(left, { type: 'opened', seq: running.seq })).toBe(left)
      expect(run(left, { type: 'internal', seq: running.seq })).toBe(left)
    }
    expect(run(run(locating, { type: 'cancel' }), { type: 'locate-done', seq: locating.seq, result: located('68810699') }).status).toBeNull()
    expect(run(run(opening, { type: 'cancel' }), { type: 'open-thread-failed', seq: opening.seq, error: null }).status).toMatchObject({ kind: 'thread-known' })
  })

  it('offers nothing more for an unknown owner; an internal locate failure can be retried', () => {
    const unknown = run(initialNumberOpenState, { type: 'submit', raw: '68810699', newTab: false }, { type: 'locate-done', seq: 1, result: { status: 'unknown-thread' } })
    expect(unknown.status).toMatchObject({ kind: 'unknown-thread', target: { postId: '68810699' } })
    expect(run(unknown, { type: 'retry' })).toBe(unknown)
    expect(run(unknown, { type: 'open-thread-start' })).toBe(unknown)
    const internal = run(initialNumberOpenState, { type: 'submit', raw: '68810699', newTab: true }, { type: 'internal', seq: 1 })
    expect(internal.status).toMatchObject({ kind: 'internal' })
    expect(run(internal, { type: 'retry' }).status).toMatchObject({ kind: 'locating', target: { postId: '68810699', newTab: true } })
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
