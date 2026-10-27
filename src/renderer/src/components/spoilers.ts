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

type Formatting = Extract<ContentNode, { type: 'emphasis' | 'greentext' }>
type Leaf = Exclude<ContentNode, Formatting>
/** A leaf with the formatting it sits in, outermost first. */
interface Item { node: Leaf; path: readonly Formatting[] }
type Token = Item | { marker: string; open: boolean; path: readonly Formatting[] }
/** A run of the output: an item, or a spoiler whose items share `path` as their common formatting. */
type Entry = Item | { spoiler: Item[]; path: readonly Formatting[] }

const MARKER = /\[(\/?)h\]/g

function append(nodes: DisplayNode[], node: Leaf): void {
  const previous = nodes[nodes.length - 1]
  if (node.type === 'text' && previous?.type === 'text') previous.text += node.text
  else nodes.push(node.type === 'text' ? { type: 'text', text: node.text } : node)
}

function flatten(nodes: readonly ContentNode[], path: readonly Formatting[], tokens: Token[]): void {
  for (const node of nodes) {
    if (node.type === 'emphasis' || node.type === 'greentext') flatten(node.children, [...path, node], tokens)
    else if (node.type !== 'text') tokens.push({ node, path })
    else {
      let offset = 0
      for (const match of node.text.matchAll(MARKER)) {
        if (match.index > offset) tokens.push({ node: { type: 'text', text: node.text.slice(offset, match.index) }, path })
        tokens.push({ marker: match[0], open: match[1] === '', path })
        offset = match.index + match[0].length
      }
      if (offset < node.text.length) tokens.push({ node: { type: 'text', text: node.text.slice(offset) }, path })
    }
  }
}

function asItem(token: Token): Item {
  return 'marker' in token ? { node: { type: 'text', text: token.marker }, path: token.path } : token
}

/** Nothing to hide: only blanks and line breaks. */
function isBlank(items: readonly Item[]): boolean {
  return items.every(({ node }) => node.type === 'lineBreak' || (node.type === 'text' && node.text.trim() === ''))
}

function commonPath(items: readonly Item[]): readonly Formatting[] {
  let path = items[0]!.path
  for (const { path: other } of items) {
    let length = 0
    while (length < path.length && path[length] === other[length]) length++
    path = path.slice(0, length)
  }
  return path
}

/** Rebuild the tree; formatting crossed by a mask edge is split into one copy per side. */
function build(entries: readonly Entry[], depth: number): DisplayNode[] {
  const result: DisplayNode[] = []
  for (let index = 0; index < entries.length;) {
    const entry = entries[index]!
    const formatting = entry.path[depth]
    if (formatting === undefined) {
      if ('spoiler' in entry) result.push({ type: 'spoiler', children: build(entry.spoiler, depth) })
      else append(result, entry.node)
      index++
      continue
    }
    let end = index + 1
    while (end < entries.length && entries[end]!.path[depth] === formatting) end++
    result.push({ ...formatting, children: build(entries.slice(index, end), depth + 1) })
    index = end
  }
  return result
}

/**
 * Recognize `[h]…[/h]` across line breaks, references and formatting, including markers on
 * different formatting levels (the forum wraps `>` lines, quotes included, in green text). Each
 * `[h]` pairs with the next `[/h]` in reading order (markers between them stay text, like the
 * forum's own lazy match). Unpaired markers and segments with nothing but blanks stay as their
 * original text.
 */
export function withSpoilers(nodes: readonly ContentNode[]): DisplayNode[] {
  const tokens: Token[] = []
  flatten(nodes, [], tokens)

  // Index of the first closing marker after each token, -1 when none follows.
  const nextClose = new Array<number>(tokens.length)
  for (let index = tokens.length - 1, next = -1; index >= 0; index--) {
    nextClose[index] = next
    const token = tokens[index]!
    if ('marker' in token && !token.open) next = index
  }

  const entries: Entry[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    const close = 'marker' in token && token.open ? nextClose[index]! : -1
    if (close !== -1) {
      const items = tokens.slice(index + 1, close).map(asItem)
      if (!isBlank(items)) {
        entries.push({ spoiler: items, path: commonPath(items) })
        index = close
        continue
      }
    }
    entries.push(asItem(token))
  }
  return build(entries, 0)
}
