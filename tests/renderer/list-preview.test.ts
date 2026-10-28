import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { parseContent } from '../../src/main/forum/content'
import type { Post } from '../../src/shared/forum'
import { TextExcerpt } from '../../src/renderer/src/components/Content'
import { plainNodes } from '../../src/renderer/src/components/plainNodes'
import { retainedHeading } from '../../src/renderer/src/features/content/contentText'
import { RowExcerpt } from '../../src/renderer/src/features/feed/ThreadRow'

const post = (patch: Partial<Post>): Post => ({
  id: '100',
  forumId: '4',
  createdAt: null,
  userHash: null,
  name: null,
  title: null,
  isAdmin: null,
  isSage: null,
  content: [],
  plainText: '',
  image: null,
  ...patch
})

const count = (markup: string, part: string) => markup.split(part).length - 1

describe('plain text as list excerpt nodes', () => {
  it('keeps every line ending and blank line as a line break', () => {
    expect(plainNodes('一\n\n二\r\n三\r四')).toEqual([
      { type: 'text', text: '一' },
      { type: 'lineBreak' },
      { type: 'lineBreak' },
      { type: 'text', text: '二' },
      { type: 'lineBreak' },
      { type: 'text', text: '三' },
      { type: 'lineBreak' },
      { type: 'text', text: '四' }
    ])
  })

  it('renders line breaks as elements, so no row white-space rule can flatten them', () => {
    const markup = renderToStaticMarkup(createElement(TextExcerpt, { text: '第一行\n\n第三行', className: 'row-excerpt' }))
    expect(count(markup, '<br/>')).toBe(2)
  })

  it('shows sent text literally, never as markup', () => {
    const markup = renderToStaticMarkup(createElement(TextExcerpt, { text: '<b>粗</b><img src=x onerror=alert(1)>\n下一行', className: 'row-excerpt' }))
    expect(markup).not.toContain('<b>')
    expect(markup).not.toContain('<img')
    expect(markup).toContain('&lt;b&gt;粗&lt;/b&gt;')
    expect(count(markup, '<br/>')).toBe(1)
  })
})

describe('a held post as a row excerpt', () => {
  it('keeps the allowed formatting, line breaks and 防剧透 of its content', () => {
    const parsed = parseContent('第一行<br />\n<br /><b>粗</b><font color="#789922">&gt;绿</font><br />[h]秘密[/h]')
    const markup = renderToStaticMarkup(createElement(RowExcerpt, { post: post({ content: parsed.nodes, plainText: parsed.plainText }) }))
    expect(markup).toContain('class="content-excerpt row-excerpt"')
    expect(count(markup, '<br/>')).toBe(3)
    expect(markup).toContain('<strong>粗</strong>')
    expect(markup).toContain('class="greentext"')
    expect(markup).toContain('class="spoiler is-masked"')
    expect(markup).not.toContain('[h]')
    expect(markup).not.toMatch(/<button|tabindex|role="button"/i)
  })

  it('falls back to its plain text, lines kept, when the content tree is empty', () => {
    const markup = renderToStaticMarkup(createElement(RowExcerpt, { post: post({ plainText: '\n甲\n\n乙\n' }) }))
    expect(markup).toContain('甲<br/><br/>乙')
  })

  it('shows nothing for a post with neither content nor text', () => {
    expect(renderToStaticMarkup(createElement(RowExcerpt, { post: post({}) }))).toBe('')
  })
})

describe('history row heading', () => {
  it('uses the kept title, else the held head title, else its first text line, else the number', () => {
    expect(retainedHeading({ threadId: '1', title: '标题', head: null }).text).toBe('标题')
    expect(retainedHeading({ threadId: '1', title: null, head: post({ title: '主帖标题' }) }).text).toBe('主帖标题')
    expect(retainedHeading({ threadId: '1', title: null, head: post({ plainText: '\n  第一行 \n第二行' }) })).toEqual({ text: '第一行', source: 'excerpt' })
    expect(retainedHeading({ threadId: '1', title: null, head: null })).toEqual({ text: 'No.1', source: 'number' })
  })
})
