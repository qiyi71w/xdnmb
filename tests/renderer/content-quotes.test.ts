import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { parseContent } from '../../src/main/forum/content'
import { Content, type RenderQuote } from '../../src/renderer/src/components/Content'
import { QuoteControllerContext, QuoteEntryContext, quoteHostId, type QuoteController } from '../../src/renderer/src/features/quote/QuoteContext'
import { QuoteRef } from '../../src/renderer/src/features/quote/QuoteRef'

const controller: QuoteController = {
  pointerEnter: vi.fn(), pointerLeave: vi.fn(), blur: vi.fn(), focus: vi.fn(), preview: vi.fn(),
  activate: vi.fn(), isBackground: () => false, focusCard: () => false
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
})
