import type { ReactNode } from 'react'
import type { ContentNode, EmphasisStyle } from '../../../shared/forum'
import './content.css'

type Mode =
  /** Full post body: links are activatable and open in the system browser. */
  | 'body'
  /** Excerpt inside another control (list row): nothing interactive, line breaks become spaces. */
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

function renderNodes(nodes: readonly ContentNode[], mode: Mode, path: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${path}.${index}`
    switch (node.type) {
      case 'text':
        return node.text
      case 'lineBreak':
        return mode === 'excerpt' ? ' ' : <br key={key} />
      case 'quoteRef':
        return (
          <span key={key} className="quote-ref">
            {node.raw}
          </span>
        )
      case 'emphasis': {
        const Tag = EMPHASIS_TAG[node.style]
        return <Tag key={key}>{renderNodes(node.children, mode, key)}</Tag>
      }
      case 'greentext':
        return (
          <span key={key} className="greentext">
            {renderNodes(node.children, mode, key)}
          </span>
        )
      case 'link': {
        const children = node.children.length > 0 ? renderNodes(node.children, mode, key) : node.href
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
  className
}: {
  nodes: readonly ContentNode[]
  mode?: Mode
  className?: string
}) {
  const base = mode === 'body' ? 'content-body' : 'content-excerpt'
  const classes = className === undefined ? base : `${base} ${className}`
  // Excerpts sit inside buttons, which only allow phrasing content.
  if (mode === 'excerpt') return <span className={classes}>{renderNodes(nodes, mode, 'n')}</span>
  return <div className={classes}>{renderNodes(nodes, mode, 'n')}</div>
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
