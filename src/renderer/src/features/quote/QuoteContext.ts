import { createContext } from 'react'
import type { PostId } from '../../../../shared/forum'

/** One quote reference in a reader body: enough to find it again and to return focus to it. */
export interface QuoteRefInfo {
  /** History entry whose reader shows the quote. */
  entryKey: number
  /** Post whose body contains the quote. */
  hostPostId: PostId
  /** Document order of the quote inside that body, from 0. */
  quoteIndex: number
  /** The quoted post. */
  postId: PostId
}

/** What a quote reference can ask of the app-level quote controller. */
export interface QuoteController {
  pointerEnter(info: QuoteRefInfo): void
  pointerLeave(): void
  /** Focus left the quote reference. */
  blur(): void
  /** Space: opens the preview card at once (not pinned). */
  preview(info: QuoteRefInfo): void
  /** Click / Enter (`background` false) or Ctrl·Cmd + click / Enter (`background` true). */
  activate(info: QuoteRefInfo, background: boolean): void
  /** Whether a click or Enter with these modifiers means “open in a background tab”. */
  isBackground(event: { ctrlKey: boolean; metaKey: boolean }): boolean
  /** Tab from the quote reference whose card is open: moves focus into the card. */
  focusCard(): boolean
}

export const QuoteControllerContext = createContext<QuoteController | null>(null)

/** Key of the quote whose card is open (see `quoteKey`), or null. */
export const QuoteActiveContext = createContext<string | null>(null)

/** History entry of the reader around the quote references; null outside a reader. */
export const QuoteEntryContext = createContext<number | null>(null)

export function quoteKey(entryKey: number, hostPostId: PostId, quoteIndex: number): string {
  return `${entryKey}:${hostPostId}:${quoteIndex}`
}

/** The rendered quote reference, if it is still in the document. */
export function findQuoteElement(entryKey: number, hostPostId: PostId, quoteIndex: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-quote-entry="${entryKey}"][data-quote-host="${CSS.escape(hostPostId)}"][data-quote-index="${quoteIndex}"]`
  )
}
