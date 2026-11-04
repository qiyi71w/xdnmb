import { describe, expect, it } from 'vitest'
import { EMPTY_FIELDS, type PostTarget } from '../../src/shared/drafts'
import type { Post } from '../../src/shared/forum'
import type { PublicationAttempt } from '../../src/shared/publication'
import type { ContentFilters } from '../../src/shared/search'
import {
  filterList,
  headMeta,
  judgeListItem,
  listFilterCount,
  parseKeyword,
  postHasImage,
  threadKeywordFields,
  type ListItemMeta
} from '../../src/renderer/src/features/search/listFilters'
import { sentKeywordFields } from '../../src/renderer/src/features/publication/sentRecords'
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
    const withImage = { ...NO_CONTENT_FILTERS, image: 'with' as const }
    expect(judgeListItem(headMeta(post({ image: null })), withImage)).toEqual({ shown: true, uncertain: true })
    expect(judgeListItem(headMeta(post({ image: null, imageKnown: true })), withImage)).toEqual({ shown: false, uncertain: false })

    const october = { ...NO_CONTENT_FILTERS, fromDate: '2026-10-01', toDate: '2026-10-31' }
    expect(judgeListItem(meta({ createdAt: 'unparsed' }), october)).toEqual({ shown: true, uncertain: true })
    expect(judgeListItem(meta({ createdAt: '2026-09-30(二)23:59:59' }), october)).toEqual({ shown: false, uncertain: false })
    // Nothing known yet about the thread: shown, marked uncertain.
    expect(judgeListItem(null, october)).toEqual({ shown: true, uncertain: true })
    // No filters: nothing is judged at all.
    expect(judgeListItem(null, NO_CONTENT_FILTERS)).toEqual({ shown: true, uncertain: false })
  })
})

/** A 浏览 row: its main post when held here, else only its number and kept title. */
interface Row {
  threadId: string
  title: string | null
  head: Post | null
  meta: ListItemMeta | null
}

const row = (threadId: string, head: Partial<Post> | null, title: string | null = null, rowMeta: ListItemMeta | null = null): Row => ({
  threadId,
  title,
  head: head === null ? null : post({ id: threadId, ...head }),
  meta: rowMeta
})

/** Numbers of the rows 浏览 shows for `keyword` (with `filters`), and how many were judged without their main post. */
function browse(rows: Row[], keyword: string, filters: ContentFilters = NO_CONTENT_FILTERS) {
  const result = filterList(rows, (item) => item.meta, filters, {
    keyword: parseKeyword(keyword),
    fieldsOf: (item) => threadKeywordFields(item.threadId, item.head, item.title)
  })
  return { shown: result.shown.map(({ item, uncertain }) => (uncertain ? `${item.threadId}?` : item.threadId)), partial: result.partial }
}

/** The fields of a sent record this page reads. */
type SentRecord = Pick<PublicationAttempt, 'id' | 'payload' | 'postId' | 'threadId'>

const sent = (target: PostTarget, fields: { title?: string; name?: string; content?: string }, postId: string | null, threadId: string | null): SentRecord => ({
  id: `${target.kind}-${postId ?? 'unconfirmed'}-${fields.content ?? ''}`,
  payload: {
    draftId: null,
    target,
    credentialId: '1',
    fields: { ...EMPTY_FIELDS, ...fields },
    attachmentId: null
  },
  postId,
  threadId
})

/** Ids of the sent records a 新串／回复 page shows for `keyword`. */
function sentShown(records: SentRecord[], keyword: string): string[] {
  return filterList(records, () => null, NO_CONTENT_FILTERS, { keyword: parseKeyword(keyword), fieldsOf: sentKeywordFields }).shown.map(({ item }) => item.id)
}

describe('history keyword filter', () => {
  it('matches after NFC and lower-casing, without folding full-width forms', () => {
    const rows = [
      row('1', { title: 'Café 日记' }),
      row('2', { plainText: 'ＸＩＤＡＯ 岛' }),
      row('3', { plainText: 'xidao' })
    ]
    // Composed and decomposed é are the same text; case does not matter.
    expect(browse(rows, 'CAFE\u0301').shown).toEqual(['1'])
    // Full-width letters lower-case to full-width letters, never to ASCII.
    expect(browse(rows, 'ｘｉｄａｏ').shown).toEqual(['2'])
    expect(browse(rows, 'XIDAO').shown).toEqual(['3'])
  })

  it('takes inner spaces literally and treats a blank keyword as not in use', () => {
    const rows = [row('1', { plainText: '今天 下雨了' }), row('2', { plainText: '今天下雨了' }), row('3', { plainText: '下雨 今天' })]
    expect(browse(rows, '  今天 下雨  ').shown).toEqual(['1'])
    expect(parseKeyword(' \u3000 ')).toBeNull()
    expect(browse(rows, '   ').shown).toEqual(['1', '2', '3'])
    expect(listFilterCount(NO_CONTENT_FILTERS, '   ')).toBe(0)
  })

  it('matches a number exactly or as text, either way', () => {
    const rows = [row('12345', { plainText: '正文' }), row('123456', { plainText: '正文' }), row('777', { plainText: '见 No.12345 楼' })]
    // Exact thread number, or the keyword inside a row's text; never a prefix of another number.
    expect(browse(rows, '12345').shown).toEqual(['12345', '777'])
    expect(browse(rows, 'No.12345').shown).toEqual(['12345', '777'])
    // `No.` with a space still names the number; its text (with the space) is not in row 777.
    expect(browse(rows, 'no. 12345').shown).toEqual(['12345'])
    expect(browse(rows, 'No.123456').shown).toEqual(['123456'])
    // Not any row's number: only the text of row 777 holds it.
    expect(browse(rows, '1234').shown).toEqual(['777'])
  })

  it('judges rows without their main post by number and kept title alone, and counts them', () => {
    const rows = [row('10', null, '旧串标题'), row('11', null, null), row('12', { title: null, plainText: '旧串正文' })]
    expect(browse(rows, '旧串')).toEqual({ shown: ['10', '12'], partial: 2 })
    expect(browse(rows, '11')).toEqual({ shown: ['11'], partial: 2 })
    // Hidden ones still count as judged that way; no keyword, nothing is judged.
    expect(browse(rows, '正文')).toEqual({ shown: ['12'], partial: 2 })
    expect(browse(rows, '')).toEqual({ shown: ['10', '11', '12'], partial: 0 })
  })

  it('combines with 版面／时间／图片: both must hold, and unknown fields still only mark a row', () => {
    const withImage = { ...NO_CONTENT_FILTERS, image: 'with' as const }
    const rows = [
      row('1', { plainText: '猫' }, null, meta({ hasImage: true })),
      row('2', { plainText: '猫' }, null, meta({ hasImage: false })),
      row('3', { plainText: '猫' }, null, meta({ hasImage: null })),
      row('4', { plainText: '狗' }, null, meta({ hasImage: null })),
      row('5', null, '猫', null)
    ]
    expect(browse(rows, '猫', withImage).shown).toEqual(['1', '3?', '5?'])
    expect(listFilterCount(withImage, '猫')).toBe(2)
    expect(listFilterCount(null, '猫')).toBe(1)
  })

  it('matches only what a record sent, and only confirmed numbers', () => {
    const reply = { kind: 'reply', threadId: '500' } as const
    const records = [
      sent(reply, { content: '我的回复' }, '501', '500'),
      sent(reply, { name: '路人', title: '标题甲' }, null, null),
      sent({ kind: 'thread', forumId: '4' }, { content: '新串正文' }, '600', '600'),
      sent({ kind: 'thread', forumId: '4' }, { content: '未确认的新串' }, null, null)
    ]
    expect(sentShown(records, '路人')).toEqual([records[1]!.id])
    expect(sentShown(records, '标题甲')).toEqual([records[1]!.id])
    // A reply by its own number or its thread's; a new thread by the number it got.
    expect(sentShown(records, '501')).toEqual([records[0]!.id])
    expect(sentShown(records, 'No.500')).toEqual([records[0]!.id, records[1]!.id])
    expect(sentShown(records, '600')).toEqual([records[2]!.id])
    // The sent post as held here, or its thread's main post, is not part of the record.
    const withPreview = { ...records[0]!, preview: post({ id: '501', plainText: '本机持有的版本' }), head: post({ id: '500', title: '所在串主帖' }) }
    expect(sentShown([withPreview], '本机持有')).toEqual([])
    expect(sentShown([withPreview], '所在串')).toEqual([])
  })
})
