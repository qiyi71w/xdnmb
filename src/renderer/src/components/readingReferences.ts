import type { ContentNode } from '../../../shared/forum'
import { readingReferenceNodes } from '../../../shared/reading-references'

/**
 * Reading references in body text that predates their recognition (stored content parsed before
 * `No.` candidates existed): plain text nodes outside links are split by the same shared tokenizer
 * the parser uses. Display only: the stored tree, its plain text and the reminder engine never see
 * these nodes, and HTML is never reinterpreted. Freshly parsed content has nothing left to split,
 * so it comes back equal; bare digits stay text.
 */
export function withReadingReferences(nodes: readonly ContentNode[]): ContentNode[] {
  const result: ContentNode[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        result.push(...readingReferenceNodes(node.text))
        break
      case 'emphasis':
      case 'greentext':
      case 'redtext':
        result.push({ ...node, children: withReadingReferences(node.children) })
        break
      default:
        // Links keep their children (a control cannot hold another); quotes and breaks stay as they are.
        result.push(node)
    }
  }
  return result
}
