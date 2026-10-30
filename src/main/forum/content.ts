import { Parser } from 'htmlparser2'
import type { ContentNode, EmphasisStyle } from '../../shared/forum'
import { readingLinkTarget, readingReferenceNodes } from '../../shared/reading-references'

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
interface Opened {
  container: Container
  parent: ContentNode[]
}
interface Frame {
  target: ContentNode[] | null
  inLink: boolean
  /** Containers this tag opened, outermost first; each is dropped on close if it stayed empty. */
  opened: Opened[]
}

const RED: Readonly<Record<string, true>> = { red: true, '#f00': true, '#ff0000': true }
const GREEN: Readonly<Record<string, true>> = { green: true, '#789922': true }

/**
 * The only inline styles kept, from `span`/`font`: red or green text and bold. The color becomes a
 * closed node type, never the forum's value; every other declaration is dropped.
 */
function inlineFormatting(name: string, attributes: Record<string, string>): Container[] {
  if (name !== 'span' && name !== 'font') return []
  let color = name === 'font' ? attributes.color?.replace(/\s+/g, '').toLowerCase() : undefined
  let bold = false
  for (const declaration of (attributes.style ?? '').split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    const property = declaration.slice(0, colon).trim().toLowerCase()
    const value = declaration.slice(colon + 1).replace(/\s+/g, '').toLowerCase()
    if (property === 'color') color = value
    else if (property === 'font-weight') bold = value === 'bold' || (/^\d+$/.test(value) && Number(value) >= 600)
  }
  const containers: Container[] = []
  if (color !== undefined && Object.hasOwn(RED, color)) containers.push({ type: 'redtext', children: [] })
  else if (color !== undefined && Object.hasOwn(GREEN, color)) containers.push({ type: 'greentext', children: [] })
  if (bold) containers.push({ type: 'emphasis', style: 'bold', children: [] })
  return containers
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


function visibleText(nodes: readonly ContentNode[]): string {
  return nodes.map((node) => {
    if (node.type === 'text') return node.text
    if (node.type === 'quoteRef') return node.raw
    if (node.type === 'lineBreak') return '\n'
    return visibleText(node.children)
  }).join('')
}

function emphasized(node: ContentNode | undefined, style: EmphasisStyle, pattern: RegExp): node is Container {
  return node?.type === 'emphasis' && node.style === style && pattern.test(visibleText(node.children))
}

/**
 * Colour only decorates text: for publication verification a colour container's children read as
 * if they sat directly in the surrounding sequence. Bold wrappers need nothing: a bold result is
 * matched by its visible text, however its emphasis is nested.
 */
function withoutColour(nodes: readonly ContentNode[]): ContentNode[] {
  return nodes.flatMap((node): ContentNode[] => node.type === 'redtext' || node.type === 'greentext' ? withoutColour(node.children) : [node])
}

/**
 * Visible text as it was submitted: the forum stores a dice expression `[n]` / `[n,m]` rendered as
 * `<b>result</b><small>[expr]</small>`, so that pair reads back as the expression alone, whatever
 * official colour wraps it. For publication verification only; reading keeps the rendered result.
 */
export function submittedText(input: readonly ContentNode[]): string {
  const nodes = withoutColour(input)
  let text = ''
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!
    const next = nodes[index + 1]
    if (emphasized(node, 'bold', /^\d+$/) && emphasized(next, 'small', /^\[\d+(?:,\d+)?\]$/)) {
      text += visibleText(next.children)
      index++
    } else if (node.type === 'text') text += node.text
    else if (node.type === 'quoteRef') text += node.raw
    else if (node.type === 'lineBreak') text += '\n'
    else text += submittedText(node.children)
  }
  return text
}

/** Convert untrusted forum HTML into the closed, attribute-free content vocabulary. */
export function parseContent(html: string): { nodes: ContentNode[]; plainText: string } {
  const nodes: ContentNode[] = []
  const frames: Frame[] = [{ target: nodes, inLink: false, opened: [] }]
  const parser = new Parser({
    onopentag(name, attributes) {
      const parent = frames[frames.length - 1]!
      if (parent.target === null || Object.hasOwn(droppedTags, name)) {
        frames.push({ target: null, inLink: parent.inLink, opened: [] })
        return
      }
      let target = parent.target
      let inLink = parent.inLink
      const containers: Container[] = []
      const style = Object.hasOwn(emphasis, name) ? emphasis[name] : undefined
      if (style) containers.push({ type: 'emphasis', style, children: [] })
      else if (name === 'a' && !parent.inLink) {
        const href = safeLink(attributes.href)
        if (href !== null) containers.push({ type: 'link', href, children: [] })
      } else containers.push(...inlineFormatting(name, attributes))
      if (name === 'br') target.push({ type: 'lineBreak' })
      const opened: Opened[] = []
      for (const container of containers) {
        target.push(container)
        opened.push({ container, parent: target })
        target = container.children
        inLink ||= container.type === 'link'
      }
      frames.push({ target, inLink, opened })
    },
    ontext(text) {
      const target = frames[frames.length - 1]!.target
      if (target !== null) appendText(target, text.replace(/[\r\n]/g, ''))
    },
    onclosetag() {
      if (frames.length === 1) return
      const frame = frames.pop()!
      for (let index = frame.opened.length - 1; index >= 0; index--) {
        const { container, parent } = frame.opened[index]!
        if (container.children.length === 0) parent.pop()
      }
    }
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true })
  parser.end(html)

  // Entity decoding may split a text callback; recognize references only after text is merged.
  const pending = [nodes]
  while (pending.length) {
    const list = pending.pop()!
    const converted: ContentNode[] = []
    for (const node of list) {
      if (node.type === 'link') {
        const target = readingLinkTarget(node.href)
        if (target !== null) {
          converted.push({ type: 'quoteRef', ...target, raw: visibleText(node.children) || node.href })
          continue
        }
      }
      if (node.type !== 'text') {
        converted.push(node)
        if ('children' in node) pending.push(node.children)
        continue
      }
      for (const reference of readingReferenceNodes(node.text)) {
        if (reference.type === 'text') appendText(converted, reference.text)
        else converted.push(reference)
      }
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
