import { describe, expect, it } from 'vitest'
import { createForumClient } from '../src/main/forum/client'
import { ForumReadError } from '../src/main/forum/contract'
import type { ForumTransport, TransportResponse } from '../src/main/forum/contract'

const signal = new AbortController().signal

function fixture(body: unknown, mediaType = 'application/json') {
  const transport: ForumTransport = {
    async get() { return { mediaType, text: JSON.stringify(body) } }
  }
  return createForumClient({ transport })
}

function thread(replies: unknown[], extra: Record<string, unknown> = {}) {
  return { id: '100', content: '<b>head</b>', Replies: replies, ...extra }
}

const tips = { id: '9999999', user_hash: 'Tips', content: 'not a reply' }

describe('forum JSON normalization', () => {
  it('does not turn a short page into an end candidate', async () => {
    const client = fixture(thread(Array.from({ length: 5 }, (_, index) => ({
      id: String(200 + index), content: 'reply'
    }))))
    const result = await client.getThreadPage('100', 1, signal)
    expect(result.replies).toHaveLength(5)
    expect(result.endCandidate).toBe(false)
    expect(result.replyCount).toBeNull()
    expect(result.mode).toBe('all')
  })

  it('excludes Tips from replies, skips and end-candidate counts', async () => {
    const result = await fixture(thread([tips])).getThreadPage('100', 2, signal)
    expect(result.replies).toEqual([])
    expect(result.skippedItems).toBe(0)
    expect(result.endCandidate).toBe(true)
  })

  it('deduplicates reply IDs in server order and keeps ordinary admin replies', async () => {
    const result = await fixture(thread([
      { id: '201', content: 'first', admin: true },
      { id: '201', content: 'duplicate' },
      { id: '9999999', user_hash: 'not Tips', content: 'ordinary' },
      { id: '202', content: 'last' }
    ])).getThreadPage('100', 1, signal)
    expect(result.replies.map((post) => [post.id, post.plainText])).toEqual([
      ['201', 'first'], ['9999999', 'ordinary'], ['202', 'last']
    ])
    expect(result.replies[0]?.isAdmin).toBe(true)
    expect(result.skippedItems).toBe(0)
  })

  it.each(['该串不存在', { success: false, error: '该串不存在' }])(
    'classifies HTTP-200 business failures instead of returning an empty page: %j', async (body) => {
      await expect(fixture(body).getThreadPage('100', 1, signal)).rejects.toMatchObject({
        error: { kind: 'not-found', detail: 'business', serverMessage: '该串不存在' }
      })
    }
  )

  it.each([
    ['请登录并确认饼干', 'permission'], ['请求太快，请稍后', 'rate-limited'], ['其他错误', 'unknown-structure']
  ])('classifies business message %s', async (message, kind) => {
    await expect(fixture(message).getThreadPage('100', 1, signal)).rejects.toMatchObject({
      error: { kind, detail: 'business' }
    })
  })

  it.each([
    ['<html>not JSON</html>', 'application/json', 'unknown-structure'],
    ['<html>CAPTCHA challenge</html>', 'text/html', 'rate-limited']
  ])('rejects an HTML error body before JSON parsing', async (body, mediaType, kind) => {
    const transport: ForumTransport = { async get() { return { mediaType, text: body } } }
    const client = createForumClient({ transport })
    await expect(client.getThreadPage('100', 1, signal)).rejects.toMatchObject({ error: { kind, detail: 'html' } })
  })

  it('counts malformed replies and blocks end-candidate classification', async () => {
    const result = await fixture(thread([tips, { id: '201' }, { content: 'missing id' }, null]))
      .getThreadPage('100', 1, signal)
    expect(result.replies).toEqual([])
    expect(result.skippedItems).toBe(3)
    expect(result.endCandidate).toBe(false)
  })

  it.each([
    thread([], { id: '101' }), { id: '100', content: 'head' },
    thread([], { content: null }), thread([], { Replies: {} }), []
  ])('rejects an invalid target or thread shape', async (body) => {
    await expect(fixture(body).getThreadPage('100', 1, signal)).rejects.toMatchObject({
      error: { kind: 'unknown-structure', detail: 'shape' }
    })
  })

  it('preserves the exact source digits of numeric identifiers larger than Number precision', async () => {
    const transport: ForumTransport = {
      async get() {
        return { mediaType: 'application/json', text:
          '{"id":12345678901234567890,"fid":12345678901234567891,"content":"head",' +
          '"Replies":[{"id":12345678901234567892,"content":"reply"}]}' }
      }
    }
    const result = await createForumClient({ transport }).getThreadPage('12345678901234567890', 1, signal)
    expect(result.head.id).toBe('12345678901234567890')
    expect(result.head.forumId).toBe('12345678901234567891')
    expect(result.replies[0]?.id).toBe('12345678901234567892')
  })

  it('preserves unknown optional fields and image metadata without inventing URLs', async () => {
    const result = await fixture(thread([], {
      fid: {}, now: 123, user_hash: null, admin: '1', sage: 0,
      img: '2026-10-23/image', ext: '.png'
    })).getThreadPage('100', 1, signal)
    expect(result.head).toMatchObject({
      forumId: null, createdAt: null, userHash: null, name: null, title: null,
      isAdmin: null, isSage: false, image: { path: '2026-10-23/image', ext: '.png' },
      content: [{ type: 'emphasis', style: 'bold', children: [{ type: 'text', text: 'head' }] }]
    })
    expect((await fixture(thread([])).getThreadPage('100', 1, signal)).head.image).toBeNull()
  })

  it('accepts an empty feed page without inventing entries', async () => {
    expect(await fixture([]).getFeedPage({ kind: 'forum', id: '4' }, 3, signal)).toEqual({
      feed: { kind: 'forum', id: '4' }, page: 3, threads: [], skippedItems: 0
    })
  })

  it('counts malformed feed heads but silently omits malformed preview replies and Tips', async () => {
    const result = await fixture([
      thread([tips, { id: '201', content: 'preview' }, { id: '202' }], { ReplyCount: 9, RemainReplies: 8 }),
      { id: '101' }, null
    ]).getFeedPage({ kind: 'timeline', id: '1' }, 2, signal)
    expect(result.skippedItems).toBe(2)
    expect(result.threads).toHaveLength(1)
    expect(result.threads[0]?.recentReplies.map((post) => post.id)).toEqual(['201'])
    expect(result.threads[0]?.replyCount).toBe(9)
    expect(result.threads[0]?.remainReplies).toBe(8)
  })

  it('excludes pseudo forum -1 without counting it, counts malformed entries and parses directory notices', async () => {
    const responses: TransportResponse[] = [
      { mediaType: 'application/json', text: JSON.stringify([{ id: '1', name: 'group', forums: [
        { id: '-1', name: 'timeline' },
        { id: '4', name: 'forum', showName: 'display', msg: 'rules<br>next', interval: '30' },
        { id: '5', name: 'fallback', showName: '', interval: 'bad' },
        { id: '6' }
      ] }]) },
      { mediaType: 'application/json', text: JSON.stringify([
        { id: 1, name: 'timeline', display_name: 'display timeline', notice: '<b>notice</b>', max_page: 100 },
        { id: 2 }
      ]) }
    ]
    let index = 0
    const transport: ForumTransport = { async get() { return responses[index++]! } }
    const result = await createForumClient({ transport }).getDirectory(signal)
    expect(result.groups[0]?.forums.map((forum) => forum.id)).toEqual(['4', '5'])
    expect(result.skippedItems).toBe(2)
    expect(result.groups[0]?.forums[0]).toMatchObject({
      displayName: 'display', postIntervalSeconds: 30,
      rules: [{ type: 'text', text: 'rules' }, { type: 'lineBreak' }, { type: 'text', text: 'next' }]
    })
    expect(result.groups[0]?.forums[1]).toMatchObject({ displayName: 'fallback', postIntervalSeconds: null })
    expect(result.timelines).toEqual([{
      id: '1', name: 'timeline', displayName: 'display timeline', maxPage: 100,
      notice: [{ type: 'emphasis', style: 'bold', children: [{ type: 'text', text: 'notice' }] }]
    }])
  })

  it('rejects a directory whose entries are present but all unusable, while empty lists stay a valid empty directory', async () => {
    const directory = (forums: unknown, timelines: unknown) => {
      const bodies = [forums, timelines]
      let index = 0
      const transport: ForumTransport = { async get() { return { mediaType: 'application/json', text: JSON.stringify(bodies[index++]) } } }
      return createForumClient({ transport }).getDirectory(signal)
    }
    await expect(directory([{}], [{}])).rejects.toMatchObject({ error: { kind: 'unknown-structure', detail: 'shape' } })
    await expect(directory([{ id: '1', name: 'g', forums: [{ id: 'x' }] }], [])).rejects.toMatchObject({
      error: { kind: 'unknown-structure', detail: 'shape' }
    })
    await expect(directory([], [])).resolves.toEqual({ groups: [], timelines: [], skippedItems: 0 })
  })

  it.each([['invalid', 1], ['100', 0], ['100', 1.5], ['100', Number.NaN]])(
    'rejects invalid input without accepting a successful-looking response', async (threadId, page) => {
      await expect(fixture(thread([])).getThreadPage(String(threadId), Number(page), signal)).rejects.toBeInstanceOf(Error)
    }
  )

  it('reports invalid JSON as a parse error', async () => {
    const transport: ForumTransport = { async get() { return { mediaType: 'application/json', text: '{bad' } } }
    await expect(createForumClient({ transport }).getThreadPage('100', 1, signal)).rejects.toMatchObject({
      error: { kind: 'unknown-structure', detail: 'json' }
    })
  })

  it('keeps classified transport failures intact', async () => {
    const failure = new ForumReadError({ kind: 'network', detail: 'timeout' })
    const transport: ForumTransport = { async get() { throw failure } }
    await expect(createForumClient({ transport }).getThreadPage('100', 1, signal)).rejects.toBe(failure)
  })
})
