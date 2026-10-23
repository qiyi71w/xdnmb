import { describe, expect, it } from 'vitest'
import type { Post, ThreadCoverage, ThreadPage } from '../../src/shared/forum'
import { initialThreadState, threadReducer } from '../../src/renderer/src/features/thread/threadState'

const head: Post = {
  id: '100', forumId: '4', createdAt: null, userHash: null, name: null, title: null,
  isAdmin: null, isSage: null, content: [], plainText: '', image: null
}
const source = { status: 'fresh', fetchedAt: '2026-10-23T00:00:00.000Z', saved: true } as const

function page(number: number, replies: number): ThreadPage {
  return {
    threadId: '100', mode: 'all', page: number, head, replyCount: null, skippedItems: 0, endCandidate: replies === 0,
    replies: Array.from({ length: replies }, (_, i) => ({ ...head, id: String(200 + i) }))
  }
}

const coverage: ThreadCoverage = {
  threadId: '100', mode: 'all', pages: [], gaps: [], endCandidatePage: null,
  reportedReplyCount: null, obtainedReplyCount: 0, countMismatch: null
}

describe('thread reading state: located end', () => {
  it('shows only observed pages when an empty page 1 is the end candidate', () => {
    const state = threadReducer(initialThreadState(null), {
      type: 'end-located', page: page(1, 0), endCandidatePage: 1, coverage, probedPages: [1], source
    })
    expect(state.pages.map((p) => [p.page, p.endCandidate])).toEqual([[1, true]])
  })

  it('shows the observed empty page that follows the last page with replies', () => {
    const state = threadReducer(initialThreadState(null), {
      type: 'end-located', page: page(9, 7), endCandidatePage: 10, coverage, probedPages: [9, 10], source
    })
    expect(state.pages.map((p) => [p.page, p.endCandidate])).toEqual([[9, false], [10, true]])
  })

  it('keeps shown pages and updates coverage when probing is interrupted', () => {
    const loaded = threadReducer(initialThreadState(null), { type: 'page-loaded', task: { type: 'initial' }, page: page(1, 19), coverage, source })
    const updated = { ...coverage, pages: [{ page: 1, fetchedAt: source.fetchedAt, replyIds: [], endCandidate: false, skippedItems: 0 }] }
    const state = threadReducer(loaded, {
      type: 'end-interrupted', coverage: updated, probedPages: [1], failedPage: 4, error: { kind: 'network', detail: 'timeout' }
    })
    expect(state.pages.map((p) => p.page)).toEqual([1])
    expect(state.coverage).toBe(updated)
  })
})
