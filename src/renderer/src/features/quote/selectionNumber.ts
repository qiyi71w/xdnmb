import type { PostId } from '../../../../shared/forum'

const POST_NUMBER = /^[1-9]\d{0,19}$/
/** Characters that continue a number or word: a selection next to one is only part of it. */
const WORD = /[0-9０-９A-Za-z_]/
const DIGIT = /[0-9０-９]/
/** Joiners of dates, times, amounts and versions (2026-10-30, 12:30, 1,234.5); only between digits. */
const JOINER = /[.,:/\-－．，：]/

/** Whether the character next to the selection (`neighbor`, then `beyond` it) makes the selection part of a longer token. */
function joined(neighbor: string | undefined, beyond: string | undefined): boolean {
  if (neighbor === undefined) return false
  if (WORD.test(neighbor)) return true
  return JOINER.test(neighbor) && beyond !== undefined && DIGIT.test(beyond)
}

/**
 * The post number when `selected` (surrounding blanks aside) is a whole 1–20 digit positive
 * decimal standing on its own in its text: not a piece of a longer number, word, date, time or
 * amount (`2026-10-30`, `12:30`, `1,234.56`, `v2`). The number stays a string (no precision loss);
 * a valid number says nothing about the post existing.
 */
export function wholeSelectedNumber(before: string, selected: string, after: string): PostId | null {
  const trimmed = selected.trim()
  if (!POST_NUMBER.test(trimmed)) return null
  const start = selected.indexOf(trimmed)
  const head = before + selected.slice(0, start)
  const tail = selected.slice(start + trimmed.length) + after
  if (joined(head.at(-1), head.at(-2)) || joined(tail.at(0), tail.at(1))) return null
  return trimmed
}

/**
 * The selected whole post number inside one content body of `owner` (a post), with its range;
 * null for no selection, a selection reaching outside a single body, or anything but a whole number.
 * Read when the owner's context menu opens; nothing is requested.
 */
export function selectedPostNumber(owner: Element): { postId: PostId; range: Range } | null {
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount !== 1 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  const container = range.commonAncestorContainer
  const element = container instanceof Element ? container : container.parentElement
  const body = element?.closest('.content-body') ?? null
  if (body === null || !owner.contains(body)) return null
  const head = document.createRange()
  head.selectNodeContents(body)
  head.setEnd(range.startContainer, range.startOffset)
  const tail = document.createRange()
  tail.selectNodeContents(body)
  tail.setStart(range.endContainer, range.endOffset)
  const postId = wholeSelectedNumber(head.toString(), range.toString(), tail.toString())
  return postId === null ? null : { postId, range: range.cloneRange() }
}
