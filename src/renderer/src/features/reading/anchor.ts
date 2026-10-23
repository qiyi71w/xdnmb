import { comparePostIds } from '../../../../shared/forum'
import type { ReadingAnchor } from '../../../../shared/reading'

/** Layout box of one rendered post in scroll-content coordinates (offset from the content top). */
export interface PostBox {
  postId: string
  /** Page of the post in the mode being read (the main post uses the first loaded page). */
  page: number
  top: number
  height: number
}

/**
 * Anchor at the reading line, `lineOffset` pixels below the top of the viewport. The post under the
 * line is the anchor; when the line falls between posts, the next post below is used at its top
 * edge (or the last post above at its bottom edge when nothing follows). `boxes` are in document order.
 */
export function captureAnchor(boxes: readonly PostBox[], scrollTop: number, lineOffset: number): ReadingAnchor | null {
  if (boxes.length === 0) return null
  const line = scrollTop + lineOffset
  let chosen: PostBox | undefined
  for (const box of boxes) {
    if (box.top + box.height > line) {
      chosen = box
      break
    }
  }
  const box = chosen ?? boxes[boxes.length - 1]!
  const ratio = box.height > 0 ? (line - box.top) / box.height : 0
  return {
    postId: box.postId,
    page: box.page,
    offsetRatio: Math.min(1, Math.max(0, ratio)),
    viewportOffset: lineOffset
  }
}

/**
 * Scroll offset that puts the anchor's position inside its post back under its viewport offset.
 * Re-applying it after a post above grows (late image, prepended page) keeps the reader in place.
 */
export function scrollTopForAnchor(anchor: ReadingAnchor, box: { top: number; height: number }): number {
  return Math.max(0, box.top + anchor.offsetRatio * box.height - anchor.viewportOffset)
}

/**
 * Replacement for an anchor whose post is no longer in the loaded range: the nearest loaded post
 * before it on the anchor's page (by post ID; the reading line at that post's end, where the
 * missing post began), else the nearest one after it (at its start). Null when the page shows no
 * post at all; the caller then falls back to the page top.
 */
export function nearbyAnchor(boxes: readonly PostBox[], anchor: ReadingAnchor): ReadingAnchor | null {
  let before: PostBox | undefined
  let after: PostBox | undefined
  for (const box of boxes) {
    if (box.page !== anchor.page) continue
    const order = comparePostIds(box.postId, anchor.postId)
    if (order < 0 && (before === undefined || comparePostIds(box.postId, before.postId) > 0)) before = box
    if (order > 0 && (after === undefined || comparePostIds(box.postId, after.postId) < 0)) after = box
  }
  if (before !== undefined) return { postId: before.postId, page: anchor.page, offsetRatio: 1, viewportOffset: anchor.viewportOffset }
  if (after !== undefined) return { postId: after.postId, page: anchor.page, offsetRatio: 0, viewportOffset: anchor.viewportOffset }
  return null
}
