import type { ContentNode, EmphasisStyle } from '../../../shared/forum'

/**
 * Content as displayed: the stored vocabulary plus 防剧透 segments. Spoilers exist only on screen;
 * the stored content, its plain text, search and copying keep the original `[h]…[/h]` text.
 */
export type DisplayNode =
  | Exclude<ContentNode, { children: ContentNode[] }>
  | { type: 'emphasis'; style: EmphasisStyle; children: DisplayNode[] }
  | { type: 'greentext'; children: DisplayNode[] }
  /** Link labels are never searched for markers: a mask cannot sit inside the link's control. */
  | { type: 'link'; href: string; children: ContentNode[] }
  | { type: 'spoiler'; children: DisplayNode[] }

type Token = DisplayNode | { type: 'marker'; open: boolean; raw: string }

const MARKER = /\[(\/?)h\]/g

function append(nodes: DisplayNode[], node: DisplayNode): void {
  const previous = nodes[nodes.length - 1]
  if (node.type === 'text' && previous?.type === 'text') previous.text += node.text
  else nodes.push(node.type === 'text' ? { type: 'text', text: node.text } : node)
}

/** Nothing to hide: only blanks and line breaks. */
function isBlank(nodes: readonly DisplayNode[]): boolean {
  return nodes.every((node) => node.type === 'lineBreak' || (node.type === 'text' && node.text.trim() === ''))
}

/**
 * Recognize `[h]…[/h]` among siblings, across line breaks, references and formatting between the
 * two markers. Each `[h]` pairs with the next `[/h]` at the same level (markers between them stay
 * text, like the forum's own lazy match). Unpaired markers, markers split across formatting levels
 * and segments with nothing but blanks stay as their original text.
 */
export function withSpoilers(nodes: readonly ContentNode[]): DisplayNode[] {
  const tokens: Token[] = []
  for (const node of nodes) {
    if (node.type === 'text') {
      let offset = 0
      for (const match of node.text.matchAll(MARKER)) {
        if (match.index > offset) tokens.push({ type: 'text', text: node.text.slice(offset, match.index) })
        tokens.push({ type: 'marker', open: match[1] === '', raw: match[0] })
        offset = match.index + match[0].length
      }
      if (offset < node.text.length) tokens.push({ type: 'text', text: node.text.slice(offset) })
    } else if (node.type === 'emphasis' || node.type === 'greentext') {
      tokens.push({ ...node, children: withSpoilers(node.children) })
    } else tokens.push(node)
  }

  // Index of the first closing marker after each token, -1 when none follows.
  const nextClose = new Array<number>(tokens.length)
  for (let index = tokens.length - 1, next = -1; index >= 0; index--) {
    nextClose[index] = next
    const token = tokens[index]!
    if (token.type === 'marker' && !token.open) next = index
  }

  const result: DisplayNode[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.type !== 'marker') {
      append(result, token)
      continue
    }
    const close = token.open ? nextClose[index]! : -1
    if (close !== -1) {
      const children: DisplayNode[] = []
      for (const inner of tokens.slice(index + 1, close)) {
        append(children, inner.type === 'marker' ? { type: 'text', text: inner.raw } : inner)
      }
      if (!isBlank(children)) {
        result.push({ type: 'spoiler', children })
        index = close
        continue
      }
    }
    append(result, { type: 'text', text: token.raw })
  }
  return result
}
