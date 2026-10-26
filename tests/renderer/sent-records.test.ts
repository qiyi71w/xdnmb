import { describe, expect, it } from 'vitest'
import type { PostTarget } from '../../src/shared/drafts'
import type { IdentityOverview } from '../../src/shared/identity'
import { parsePostIdInput, recordCookie, recordPlace } from '../../src/renderer/src/features/publication/sentRecords'

const record = (target: PostTarget, postId: string | null, threadId: string | null) => ({
  payload: { draftId: null, target, credentialId: '1', fields: { content: 'x', title: '', name: '', email: '', watermark: false }, attachmentId: null },
  postId,
  threadId
})

describe('where a sent record opens', () => {
  it('locates a reply with its own number in its thread', () => {
    expect(recordPlace(record({ kind: 'reply', threadId: '100' }, '105', '100'))).toEqual({ kind: 'post', threadId: '100', postId: '105' })
  })

  it('opens the thread of a reply confirmed without a number, without locating', () => {
    expect(recordPlace(record({ kind: 'reply', threadId: '100' }, null, '100'))).toEqual({ kind: 'thread', threadId: '100' })
  })

  it('opens a new thread with its number as that thread', () => {
    expect(recordPlace(record({ kind: 'thread', forumId: '4' }, '200', '200'))).toEqual({ kind: 'thread', threadId: '200' })
  })

  it('opens the forum list of a new thread without a number, guessing no thread', () => {
    expect(recordPlace(record({ kind: 'thread', forumId: '4' }, null, null))).toEqual({ kind: 'forum', forumId: '4' })
  })
})

describe('the number typed for 已发出', () => {
  it('accepts digits or nothing and rejects anything else', () => {
    expect(parsePostIdInput(' 50000001 ')).toEqual({ ok: true, postId: '50000001' })
    expect(parsePostIdInput('  ')).toEqual({ ok: true, postId: null })
    expect(parsePostIdInput('No.123')).toEqual({ ok: false })
    expect(parsePostIdInput('12a')).toEqual({ ok: false })
    expect(parsePostIdInput('1'.repeat(21))).toEqual({ ok: false })
  })
})

describe('the 饼干 ID of a sent record', () => {
  const overview = (cookieId: string | null): IdentityOverview => ({
    protection: 'available',
    writable: true,
    credentials: [{ id: '1', name: '主饼干', cookieId, source: 'export', importedAt: '2026-10-26T00:00:00Z' }],
    roles: { 'default-post': { state: 'none' }, 'web-sync': { state: 'none' } }
  })

  const sent = (credentialId: string | null, cookieId: string | null) => {
    const base = record({ kind: 'reply', threadId: '100' }, '105', '100')
    return { ...base, payload: { ...base.payload, credentialId }, cookieId }
  }

  it('is the ID saved with the send, even after the cookie’s ID changed or the cookie was removed', () => {
    expect(recordCookie(sent('1', 'Saved1'), overview('Changed'))).toEqual({ kind: 'id', text: 'Saved1' })
    expect(recordCookie(sent('2', 'Saved1'), overview('Changed'))).toEqual({ kind: 'id', text: 'Saved1' })
  })

  it('falls back to the local cookie’s current ID only when none was known at sending, else to a local reason', () => {
    expect(recordCookie(sent('1', null), overview('AbCd123'))).toEqual({ kind: 'id', text: 'AbCd123' })
    expect(recordCookie(sent('1', null), overview(null))?.kind).toBe('fallback')
    expect(recordCookie(sent('2', null), overview('AbCd123'))?.kind).toBe('fallback')
    expect(recordCookie(sent(null, null), overview('AbCd123'))?.kind).toBe('fallback')
    expect(recordCookie(sent('1', null), null)).toBeNull()
  })
})
