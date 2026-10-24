import { describe, expect, it } from 'vitest'
import { parseAppList, parseWebList, parseWriteReport } from '../src/main/subscriptions/protocol'

const app = (value: unknown) => ({ mediaType: 'application/json', text: JSON.stringify(value) })
const web = (text: string) => ({ mediaType: 'text/html', text })
const normal = (items = '') => web(`<html><head><title>网页订阅 - X岛</title></head><body><div class="h-threads-list">${items}</div></body></html>`)
const item = (id: string, body = '正文') => `<div class="h-threads-item-main" data-threads-id="${id}"><a class="h-threads-info-id" href="/t/${id}">No.${id}</a><div class="h-threads-content">${body}</div></div>`

describe('App subscription JSON adapter', () => {
  it('preserves explicit image absence without inventing it for missing or malformed source fields', () => {
    const heads = parseAppList(app([
      { id: '1', content: 'text' }, { id: '2', content: 'text', img: '', ext: '' },
      { id: '3', content: 'text', img: 'path', ext: '' }, { id: '4', content: 'text', img: 'path', ext: '.png' }
    ])).map((thread) => thread.head)
    expect(heads.map((head) => head.imageKnown)).toEqual([false, true, false, true])
    expect(heads.map((head) => head.image)).toEqual([null, null, null, { path: 'path', ext: '.png' }])
    expect(parseWebList(normal(item('100')))[0]?.head.imageKnown).toBeUndefined()
  })

  it('preserves decimal IDs and unknown statistics, sanitizing bodies', () => {
    const result = parseAppList({ mediaType: 'application/json', text: '[{"id":90071992547409931234,"content":"<script>steal()</script><b>正文</b>","fid":"4"}]' })
    expect(result[0]?.head.id).toBe('90071992547409931234')
    expect(result[0]?.head.plainText).toBe('正文')
    expect(result[0]?.replyCount).toBeNull()
    expect(result[0]?.remainReplies).toBeNull()
    expect(parseAppList(app([]))).toEqual([])
  })

  it.each([
    app('请确认饼干是否应用正确？'), app({ success: false, error: '权限不足' }),
    app([{ id: '12', content: '有效' }, { id: 'bad', content: '无效' }]),
    { mediaType: 'text/html', text: '<h1>captcha</h1>' },
    { mediaType: 'application/json', text: '[' }
  ])('never maps business, malformed or partial pages to a normal empty list (%#)', (response) => {
    expect(() => parseAppList(response)).toThrow()
  })
})

describe('web subscription HTML adapter', () => {
  it('requires normal markers and valid item structure; preserves unknown fields', () => {
    expect(parseWebList(normal())).toEqual([])
    const result = parseWebList(normal(item('1001')))
    expect(result[0]).toMatchObject({ head: { id: '1001', plainText: '正文', forumId: null }, replyCount: null })
  })

  it('does not mistake quoted authentication words for site-level errors', () => {
    expect(parseWebList(normal(item('1001', '验证码、饼干、请登录、请确认饼干是否应用正确？')))[0]?.head.id).toBe('1001')
  })

  it.each([
    web('<title>订阅</title><p class="error">请确认饼干是否应用正确？</p><div class="h-threads-list"></div>'),
    web('<title>验证</title><p>验证码</p>'),
    web('<title>订阅</title><main>未知页面</main>'),
    normal('<a class="h-threads-info-id" href="/t/1">No.1</a>'),
    normal('<div class="h-threads-item-main"><a class="h-threads-info-id" href="/t/1">No.2</a><div class="h-threads-content">内容</div></div>'),
    normal('<div class="h-threads-item-main"><div class="h-threads-content">缺少编号</div></div>')
  ])('rejects errors and changed structures rather than claiming empty membership (%#)', (response) => {
    expect(() => parseWebList(response)).toThrow()
  })

  it('separates exact server reports from HTTP success and membership facts', () => {
    expect(parseWriteReport('app', 'add', app('订阅大成功→_→'))).toBe('success')
    expect(parseWriteReport('app', 'remove', app('取消订阅成功!'))).toBe('success')
    expect(parseWriteReport('web', 'add', web('<p class="success">订阅大成功→_→</p>'))).toBe('success')
    expect(parseWriteReport('web', 'remove', web('<p class="success">取消订阅成功!</p>'))).toBe('success')
    expect(() => parseWriteReport('app', 'add', app([]))).toThrow()
    expect(() => parseWriteReport('app', 'add', app('unknown report'))).toThrow()
    expect(() => parseWriteReport('web', 'remove', web('<p>HTTP 200</p>'))).toThrow()
  })
})
