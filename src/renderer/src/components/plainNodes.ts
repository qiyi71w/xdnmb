import type { ContentNode } from '../../../shared/forum'

/**
 * Plain text as content nodes, never parsed as markup: its lines as text, each line ending (`\n`,
 * `\r\n` or `\r`) as a line break, so blank lines stay. Used for list excerpts that only have text.
 */
export function plainNodes(text: string): ContentNode[] {
  const nodes: ContentNode[] = []
  text.split(/\r\n|\r|\n/).forEach((line, index) => {
    if (index > 0) nodes.push({ type: 'lineBreak' })
    if (line !== '') nodes.push({ type: 'text', text: line })
  })
  return nodes
}
