import { describe, expect, it } from 'vitest'
import type { Post } from '../../src/shared/forum'
import { filterList, headMeta, judgeListItem, NO_LIST_FILTERS, postHasImage, type ListItemMeta } from '../../src/renderer/src/features/search/listFilters'
import { NO_CONTENT_FILTERS } from '../../src/renderer/src/features/search/searchState'

function post(fields: Partial<Post>): Post {
  return {
    id: '1',
    forumId: '4',
    createdAt: '2026-10-05(日)09:00:00',
    userHash: null,
    name: null,
    title: null,
    isAdmin: null,
    isSage: null,
    content: [],
    plainText: '',
    image: null,
    ...fields
  }
}

const meta = (fields: Partial<ListItemMeta>): ListItemMeta => ({
  forumId: '4',
  createdAt: '2026-10-05(日)09:00:00',
  hasImage: true,
  unreadCount: 2,
  coverageUnknown: false,
  ...fields
})

describe('list filters', () => {
  it('tells unknown image evidence apart from a known absent image', () => {
    expect(postHasImage(post({ image: { path: '2026-10-05/a', ext: '.jpg' } }))).toBe(true)
    expect(postHasImage(post({ image: null, imageKnown: true }))).toBe(false)
    // Historical observations without evidence stay unknown.
    expect(postHasImage(post({ image: null }))).toBeNull()
  })

  it('never hides an item for an unknown field; hides only definite mismatches', () => {
    const withImage = { ...NO_LIST_FILTERS, content: { ...NO_CONTENT_FILTERS, image: 'with' as const } }
    expect(judgeListItem(headMeta(post({ image: null })), withImage)).toEqual({ shown: true, uncertain: true })
    expect(judgeListItem(headMeta(post({ image: null, imageKnown: true })), withImage)).toEqual({ shown: false, uncertain: false })

    const october = { ...NO_LIST_FILTERS, content: { ...NO_CONTENT_FILTERS, fromDate: '2026-10-01', toDate: '2026-10-31' } }
    expect(judgeListItem(meta({ createdAt: 'unparsed' }), october)).toEqual({ shown: true, uncertain: true })
    expect(judgeListItem(meta({ createdAt: '2026-09-30(二)23:59:59' }), october)).toEqual({ shown: false, uncertain: false })
    // Nothing known yet about the thread: shown, marked uncertain.
    expect(judgeListItem(null, october)).toEqual({ shown: true, uncertain: true })
    // No filters: nothing is judged at all.
    expect(judgeListItem(null, NO_LIST_FILTERS)).toEqual({ shown: true, uncertain: false })
  })

  it('仅未读 hides only threads whose obtained coverage proves no unread replies', () => {
    const unread = { ...NO_LIST_FILTERS, unreadOnly: true }
    const items = [
      meta({ unreadCount: 3 }),
      meta({ unreadCount: 0 }),
      meta({ unreadCount: 0, coverageUnknown: true }),
      meta({ unreadCount: null })
    ]
    const result = filterList(items, (item) => item, unread)
    expect(result.hidden).toBe(1)
    expect(result.shown.map(({ item, uncertain }) => [item.unreadCount, item.coverageUnknown, uncertain])).toEqual([
      [3, false, false],
      [0, true, true],
      [null, false, true]
    ])
    expect(result.uncertain).toBe(2)
  })
})
