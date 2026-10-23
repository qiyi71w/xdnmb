import { Parser } from 'htmlparser2'
import type { ContentNode, EmphasisStyle } from '../../shared/forum'

const droppedTags: Readonly<Record<string, true>> = {
  script: true, style: true, iframe: true, frame: true, object: true, embed: true,
  noscript: true, template: true, svg: true, math: true, textarea: true, select: true,
  button: true, head: true, title: true, img: true, input: true
}
const emphasis: Readonly<Record<string, EmphasisStyle>> = {
  b: 'bold', strong: 'bold', i: 'italic', em: 'italic', u: 'underline',
  s: 'strike', strike: 'strike', del: 'strike', small: 'small', sup: 'sup', sub: 'sub'
}

type Container = Extract<ContentNode, { children: ContentNode[] }>
interface Frame {
  target: ContentNode[] | null
  inLink: boolean
  container?: Container
  parent?: ContentNode[]
}

function appendText(nodes: ContentNode[], text: string): void {
  if (!text) return
  const previous = nodes[nodes.length - 1]
  if (previous?.type === 'text') previous.text += text
  else nodes.push({ type: 'text', text })
}

function safeLink(href: string | undefined): string | null {
  if (href === undefined) return null
  try {
    const url = new URL(href.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/** Convert untrusted forum HTML into the closed, attribute-free content vocabulary. */
export function parseContent(html: string): { nodes: ContentNode[]; plainText: string } {
  const nodes: ContentNode[] = []
  const frames: Frame[] = [{ target: nodes, inLink: false }]
  const parser = new Parser({
    onopentag(name, attributes) {
      const parent = frames[frames.length - 1]!
      if (parent.target === null || Object.hasOwn(droppedTags, name)) {
        frames.push({ target: null, inLink: parent.inLink })
        return
      }
      const target = parent.target
      let container: Container | undefined
      const style = Object.hasOwn(emphasis, name) ? emphasis[name] : undefined
      if (style) container = { type: 'emphasis', style, children: [] }
      else if (name === 'font' && attributes.color?.toLowerCase() === '#789922') {
        container = { type: 'greentext', children: [] }
      } else if (name === 'a' && !parent.inLink) {
        const href = safeLink(attributes.href)
        if (href !== null) container = { type: 'link', href, children: [] }
      }
      if (name === 'br') target.push({ type: 'lineBreak' })
      if (container) {
        target.push(container)
        frames.push({
          target: container.children,
          inLink: parent.inLink || container.type === 'link',
          container,
          parent: target
        })
      } else frames.push({ target, inLink: parent.inLink })
    },
    ontext(text) {
      const target = frames[frames.length - 1]!.target
      if (target !== null) appendText(target, text.replace(/[\r\n]/g, ''))
    },
    onclosetag() {
      if (frames.length === 1) return
      const frame = frames.pop()!
      if (frame.container && frame.container.children.length === 0) frame.parent!.pop()
    }
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true })
  parser.end(html)

  // Entity decoding may split a text callback; recognize references only after text is merged.
  const pending = [nodes]
  while (pending.length) {
    const list = pending.pop()!
    const converted: ContentNode[] = []
    for (const node of list) {
      if (node.type !== 'text') {
        converted.push(node)
        if ('children' in node) pending.push(node.children)
        continue
      }
      const references = /(?:[>＞]{2}(?:No\.)?|[>＞]No\.)(\d{1,20})(?!\d)/g
      let offset = 0
      for (const match of node.text.matchAll(references)) {
        appendText(converted, node.text.slice(offset, match.index))
        converted.push({ type: 'quoteRef', postId: match[1]!, raw: match[0] })
        offset = match.index + match[0].length
      }
      appendText(converted, node.text.slice(offset))
    }
    list.length = 0
    for (const node of converted) list.push(node)
  }

  const text: string[] = []
  const traversal: { list: ContentNode[]; index: number }[] = [{ list: nodes, index: 0 }]
  while (traversal.length) {
    const cursor = traversal[traversal.length - 1]!
    const node = cursor.list[cursor.index++]
    if (!node) { traversal.pop(); continue }
    if (node.type === 'text') text.push(node.text)
    else if (node.type === 'quoteRef') text.push(node.raw)
    else if (node.type === 'lineBreak') text.push('\n')
    else traversal.push({ list: node.children, index: 0 })
  }
  return { nodes, plainText: text.join('').replace(/\n+$/, '') }
}
