import { Fragment, type ReactNode } from 'react'
import type { ContentNode, EmphasisStyle } from '../../../shared/forum'
import './content.css'

type Mode =
  /** Full post body: links are activatable and open in the system browser. */
  | 'body'
  /** Excerpt inside another control (list row): nothing interactive; line breaks kept. */
  | 'excerpt'

const EMPHASIS_TAG: Record<EmphasisStyle, 'strong' | 'em' | 'u' | 's' | 'small' | 'sup' | 'sub'> = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  strike: 's',
  small: 'small',
  sup: 'sup',
  sub: 'sub'
}

/**
 * Renders an interactive quote reference; `quoteIndex` is its document order in this body, from 0.
 * Without it (excerpts, previews, other bodies) quote references are static text.
 */
export type RenderQuote = (node: Extract<ContentNode, { type: 'quoteRef' }>, quoteIndex: number) => ReactNode

interface RenderContext {
  mode: Mode
  /** Unset inside links: a control cannot sit inside another control. Indexes still count. */
  renderQuote: RenderQuote | undefined
  quoteCount: number
}

function renderNodes(nodes: readonly ContentNode[], ctx: RenderContext, path: string): ReactNode[] {
  const mode = ctx.mode
  return nodes.map((node, index) => {
    const key = `${path}.${index}`
    switch (node.type) {
      case 'text':
        return node.text
      case 'lineBreak':
        return <br key={key} />
      case 'quoteRef': {
        const quoteIndex = ctx.quoteCount++
        if (ctx.renderQuote !== undefined) return <Fragment key={key}>{ctx.renderQuote(node, quoteIndex)}</Fragment>
        return (
          <span key={key} className="quote-ref">
            {node.raw}
          </span>
        )
      }
      case 'emphasis': {
        const Tag = EMPHASIS_TAG[node.style]
        return <Tag key={key}>{renderNodes(node.children, ctx, key)}</Tag>
      }
      case 'greentext':
        return (
          <span key={key} className="greentext">
            {renderNodes(node.children, ctx, key)}
          </span>
        )
      case 'link': {
        const renderQuote = ctx.renderQuote
        ctx.renderQuote = undefined
        const children = node.children.length > 0 ? renderNodes(node.children, ctx, key) : node.href
        ctx.renderQuote = renderQuote
        if (mode === 'excerpt') {
          return (
            <span key={key} className="content-link is-static">
              {children}
            </span>
          )
        }
        return (
          <button
            key={key}
            type="button"
            className="content-link"
            title={`在系统浏览器中打开：${node.href}`}
            onClick={(event) => {
              event.preventDefault()
              window.xidao.links.openExternal({ url: node.href }).catch(() => undefined)
            }}
          >
            {children}
          </button>
        )
      }
    }
  })
}

export function Content({
  nodes,
  mode = 'body',
  className,
  renderQuote
}: {
  nodes: readonly ContentNode[]
  mode?: Mode
  className?: string
  /** Body mode only: makes quote references interactive (reader posts). */
  renderQuote?: RenderQuote
}) {
  const base = mode === 'body' ? 'content-body' : 'content-excerpt'
  const classes = className === undefined ? base : `${base} ${className}`
  const ctx: RenderContext = { mode, renderQuote: mode === 'body' ? renderQuote : undefined, quoteCount: 0 }
  // Excerpts sit inside buttons, which only allow phrasing content (`<br>` included).
  if (mode === 'excerpt') return <span className={classes}>{renderNodes(nodes, ctx, 'n')}</span>
  return <div className={classes}>{renderNodes(nodes, ctx, 'n')}</div>
}

/** Plain text of a content tree, for short summaries. */
export function contentText(nodes: readonly ContentNode[]): string {
  let text = ''
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        text += node.text
        break
      case 'lineBreak':
        text += ' '
        break
      case 'quoteRef':
        text += node.raw
        break
      default:
        text += contentText(node.children)
    }
  }
  return text
}
