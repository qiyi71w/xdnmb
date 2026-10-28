import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { parseContent } from '../../src/main/forum/content'
import { Content, TextExcerpt, type RenderQuote } from '../../src/renderer/src/components/Content'
import { withSpoilers } from '../../src/renderer/src/components/spoilers'

const display = (html: string) => withSpoilers(parseContent(html).nodes)
const text = (value: string) => ({ type: 'text', text: value })
const spoiler = (...children: unknown[]) => ({ type: 'spoiler', children })

describe('spoiler segments', () => {
  it('masks a single segment and several in one body', () => {
    expect(display('a[h]秘密[/h]b')).toEqual([text('a'), spoiler(text('秘密')), text('b')])
    expect(display('[h]一[/h]和[h]二[/h]')).toEqual([spoiler(text('一')), text('和'), spoiler(text('二'))])
  })

  it('spans line breaks, references and formatting between the markers', () => {
    expect(display('前[h]第一行<br />\r\n&gt;&gt;No.123 <b>粗</b>[/h]后')).toEqual([
      text('前'),
      spoiler(text('第一行'), { type: 'lineBreak' }, { type: 'quoteRef', postId: '123', raw: '>>No.123' }, text(' '),
        { type: 'emphasis', style: 'bold', children: [text('粗')] }),
      text('后')
    ])
    expect(display('<b>[h]x[/h]</b>')).toEqual([{ type: 'emphasis', style: 'bold', children: [spoiler(text('x'))] }])
  })

  it('pairs markers on different formatting levels, splitting the formatting at the mask edges', () => {
    // The forum wraps a quote line in green text; the segment opened there closes on a later line.
    expect(display('<font color="#789922">&gt;&gt;No.1 [h]秘密</font><br />内容[/h]后')).toEqual([
      { type: 'greentext', children: [{ type: 'quoteRef', postId: '1', raw: '>>No.1' }, text(' ')] },
      spoiler({ type: 'greentext', children: [text('秘密')] }, { type: 'lineBreak' }, text('内容')),
      text('后')
    ])
    expect(display('<b>a[h]b</b>c[/h]')).toEqual([
      { type: 'emphasis', style: 'bold', children: [text('a')] },
      spoiler({ type: 'emphasis', style: 'bold', children: [text('b')] }, text('c'))
    ])
  })

  it('pairs each opening marker with the next closing one, keeping inner openers as text', () => {
    expect(display('[h]a[h]b[/h]c[/h]')).toEqual([spoiler(text('a[h]b')), text('c[/h]')])
  })

  it('shows unpaired and empty markers as their original text', () => {
    expect(display('a[h]b')).toEqual([text('a[h]b')])
    expect(display('a[/h]b')).toEqual([text('a[/h]b')])
    expect(display('[/h]x[h]')).toEqual([text('[/h]x[h]')])
    expect(display('<b>[h]x</b>')).toEqual([{ type: 'emphasis', style: 'bold', children: [text('[h]x')] }])
    expect(display('[h][/h] [h] [/h] [h]<br>[/h]')).toEqual([
      text('[h][/h] [h] [/h] [h]'), { type: 'lineBreak' }, text('[/h]')
    ])
    expect(display('[H]x[/H]')).toEqual([text('[H]x[/H]')])
  })

  it('leaves link labels alone, since a mask cannot sit inside the link control', () => {
    expect(display('<a href="https://example.com">[h]x[/h]</a>')).toEqual([
      { type: 'link', href: 'https://example.com/', children: [text('[h]x[/h]')] }
    ])
  })

  it('keeps stored plain text and content untouched', () => {
    const parsed = parseContent('a[h]秘密<br>&gt;&gt;No.1[/h]b')
    const before = structuredClone(parsed.nodes)
    withSpoilers(parsed.nodes)
    expect(parsed.nodes).toEqual(before)
    expect(parsed.plainText).toBe('a[h]秘密\n>>No.1[/h]b')
  })

  it('keeps reference indexes in document order through a mask', () => {
    const nodes = parseContent('[h]&gt;&gt;No.1[/h] &gt;&gt;No.2').nodes
    const seen: [string, number][] = []
    const renderQuote: RenderQuote = (node, index) => {
      seen.push([node.postId, index])
      return createElement('span', null, node.raw)
    }
    renderToStaticMarkup(createElement(Content, { nodes, renderQuote }))
    expect(seen).toEqual([['1', 0], ['2', 1]])
  })

  it('hides the masked text behind a named control and keeps excerpts non-interactive', () => {
    const nodes = parseContent('前[h]秘密[/h]后').nodes
    const body = renderToStaticMarkup(createElement(Content, { nodes }))
    expect(body).toContain('role="button"')
    expect(body).toContain('显示隐藏内容')
    expect(body).not.toContain('[h]')
    const excerpt = renderToStaticMarkup(createElement(Content, { nodes, mode: 'excerpt' }))
    expect(excerpt).not.toMatch(/role="button"|tabindex|<button/i)
    expect(excerpt).not.toContain('[h]')
  })

  it('masks segments in plain-text row excerpts (history, offline, sent records) across lines', () => {
    const excerpt = renderToStaticMarkup(createElement(TextExcerpt, { text: '回复[1,5]\n[h]自己的\n秘密[/h]完', className: 'row-excerpt' }))
    expect(excerpt).toContain('class="spoiler is-masked"')
    expect(excerpt).toContain('隐藏内容')
    expect(excerpt).not.toContain('[h]')
    expect(excerpt).not.toMatch(/role="button"|tabindex/i)
    expect(excerpt).toContain('回复[1,5]<br/>')
  })
})
