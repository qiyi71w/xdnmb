import type { ContentNode } from './forum'
import { parseNumberTarget } from './online-search'

/** Verified link clues shared by fresh HTML normalization and cached safe-content rendering. */
export function readingLinkTarget(href: string): { postId: string; hint?: { threadId: string; page: number | null } } | null {
  if (!/^https?:\/\//.test(href)) return null
  const target = parseNumberTarget(href)
  if (target === null || target.hint === null) return null
  const url = new URL(href)
  return url.searchParams.has('page') || url.searchParams.has('r')
    ? { postId: target.postId, hint: target.hint }
    : { postId: target.postId }
}

/**
 * Recognizes reading actions in plain text, never HTML. No. candidates are distinct from explicit
 * quotes so rendering old cached text does not alter the reminder engine's matching vocabulary.
 */
export function readingReferenceNodes(text: string): ContentNode[] {
  const references = /(?:[>＞]{2}(?:No\.)?|[>＞]No\.)(?<quoted>[1-9]\d{0,19})(?!\d)|(?<![A-Za-z0-9_>＞])No\.(?<number>[1-9]\d{0,19})(?!\d)|(?<url>https?:\/\/[^\s<>"'，。！？；、（）【】]+)/gu
  const nodes: ContentNode[] = []
  let offset = 0
  for (const match of text.matchAll(references)) {
    const raw = match.groups?.url !== undefined ? match[0].replace(/[.,!;:)\]}]+$/, '') : match[0]
    const postId = match.groups?.quoted ?? match.groups?.number
    const target = postId === undefined ? readingLinkTarget(raw) : { postId }
    if (target === null) continue
    if (match.index > offset) nodes.push({ type: 'text', text: text.slice(offset, match.index) })
    nodes.push({ type: 'quoteRef', ...target, raw, ...(match.groups?.number !== undefined ? { readingOnly: true as const } : {}) })
    offset = match.index + raw.length
  }
  if (offset < text.length) nodes.push({ type: 'text', text: text.slice(offset) })
  return nodes
}
