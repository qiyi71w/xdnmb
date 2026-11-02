import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { parseContent } from '../../src/main/forum/content'
import { Content, type RenderQuote } from '../../src/renderer/src/components/Content'
import { withReadingReferences } from '../../src/renderer/src/components/readingReferences'
import { QuoteControllerContext, QuoteEntryContext, quoteHostId, type QuoteController } from '../../src/renderer/src/features/quote/QuoteContext'
import { QuoteRef } from '../../src/renderer/src/features/quote/QuoteRef'
import type { ContentNode } from '../../src/shared/forum'

const controller: QuoteController = {
  pointerEnter: vi.fn(), pointerLeave: vi.fn(), blur: vi.fn(), focus: vi.fn(), preview: vi.fn(),
  activate: vi.fn(), isNewTab: () => false, contextMenu: vi.fn(), focusCard: () => false, selection: vi.fn()
}

describe('content quote references', () => {
  it('numbers ordinary quotes and thread URLs in document order through nested formatting', () => {
    const nodes = parseContent('>>No.1 <b>https://www.nmbxd.com/t/68810621</b> ' +
      '<a href="https://www.nmbxd1.com/t/68810621?page=2">原串链接</a> ' +
      '<a href="https://example.com">&gt;&gt;No.2</a> >>No.3').nodes
    const seen: [string, string, number][] = []
    const renderQuote: RenderQuote = (node, index) => {
      seen.push([node.postId, node.raw, index])
      return createElement('span', null, node.raw)
    }
    renderToStaticMarkup(createElement(Content, { nodes, renderQuote }))
    // The reference inside an external link is static, but still reserves its document-order index.
    expect(seen).toEqual([
      ['1', '>>No.1', 0], ['68810621', 'https://www.nmbxd.com/t/68810621', 1],
      ['68810621', '原串链接', 2], ['3', '>>No.3', 4]
    ])
    const repeat: number[] = []
    renderToStaticMarkup(createElement(Content, { nodes, renderQuote: (_node, index) => { repeat.push(index); return null } }))
    expect(repeat).toEqual([0, 1, 2, 4])
  })

  it('keeps excerpts static even when given an interactive quote renderer', () => {
    const renderQuote = vi.fn<RenderQuote>()
    const nodes = parseContent('>>No.1 https://www.nmbxd.com/t/68810621').nodes
    const markup = renderToStaticMarkup(createElement(Content, { nodes, mode: 'excerpt', renderQuote }))
    expect(renderQuote).not.toHaveBeenCalled()
    expect(markup).not.toContain('<button')
    expect(markup).toContain('https://www.nmbxd.com/t/68810621')
  })

  it('renders a description quote with its own entry and content identity, without inventing a host post', () => {
    const markup = renderToStaticMarkup(createElement(QuoteControllerContext.Provider, { value: controller },
      createElement(QuoteEntryContext.Provider, { value: 8 },
        createElement(QuoteRef, { host: { descriptionId: 'forum:4' }, quoteIndex: 0, postId: '50000002', raw: '>>No.50000002' })
      )
    ))
    expect(markup).toContain('<button')
    expect(markup).toContain('data-quote-entry="8"')
    expect(markup).toContain('data-quote-host="description:forum:4"')
    expect(markup).toContain('data-quote-index="0"')
    expect(quoteHostId({ postId: '50000002' })).not.toBe(quoteHostId({ previewId: '50000002' }))
  })

  it('makes No. in stored text from before its recognition previewable, leaving bare digits, dates and amounts as text', () => {
    // A body stored by an older parser: one text node, nothing recognized yet.
    const stored: ContentNode[] = [
      { type: 'text', text: '见No.1234567、（No.12345678）和 No.123456789。日期 2026-10-30，金额 12345 元，ABCNo.42' },
      { type: 'link', href: 'https://example.com/', children: [{ type: 'text', text: 'No.777' }] }
    ]
    const seen: [string, string, boolean, number][] = []
    const markup = renderToStaticMarkup(createElement(Content, {
      nodes: stored,
      renderQuote: (node, index) => {
        seen.push([node.postId, node.raw, node.readingOnly === true, index])
        return createElement('b', null, node.raw)
      }
    }))
    // Seven, eight and nine digits alike; punctuation around them stays as it was.
    expect(seen).toEqual([
      ['1234567', 'No.1234567', true, 0],
      ['12345678', 'No.12345678', true, 1],
      ['123456789', 'No.123456789', true, 2]
    ])
    expect(markup).toContain('见<b>No.1234567</b>、（<b>No.12345678</b>）和 <b>No.123456789</b>。日期 2026-10-30，金额 12345 元，ABCNo.42')
    // Inside a link nothing becomes a control; the stored tree itself is untouched.
    expect(markup).toContain('No.777')
    expect(stored[0]).toEqual({ type: 'text', text: '见No.1234567、（No.12345678）和 No.123456789。日期 2026-10-30，金额 12345 元，ABCNo.42' })
  })

  it('leaves freshly parsed content as the parser made it, and excerpts as text', () => {
    const parsed = parseContent('>>No.1 No.68810621 https://www.nmbxd.com/t/68810621?r=68810699 2026 年').nodes
    expect(withReadingReferences(parsed)).toEqual(parsed)
    const renderQuote = vi.fn<RenderQuote>()
    const stored: ContentNode[] = [{ type: 'text', text: '旧文 No.68810621' }]
    const markup = renderToStaticMarkup(createElement(Content, { nodes: stored, mode: 'excerpt', renderQuote }))
    expect(renderQuote).not.toHaveBeenCalled()
    expect(markup).toContain('旧文 No.68810621')
  })

  it('keeps the No. limits: 20 digits at most, no leading zero, no precision loss', () => {
    const refs = (text: string) => withReadingReferences([{ type: 'text', text }]).filter((node) => node.type === 'quoteRef')
    expect(refs('No.12345678901234567890')).toEqual([{ type: 'quoteRef', postId: '12345678901234567890', raw: 'No.12345678901234567890', readingOnly: true }])
    expect(refs('No.123456789012345678901')).toEqual([])
    expect(refs('No.0123')).toEqual([])
  })
})
