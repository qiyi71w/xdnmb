import { createContext } from 'react'
import type { PostId } from '../../../../shared/forum'

/** A real content host, not necessarily a post. Preview hosts stay distinct from the reader. */
export type QuoteHost = { postId: PostId } | { descriptionId: string } | { previewId: string }
export type QuoteAnchor = QuoteHost & { quoteIndex: number }

export function quoteHostId(host: QuoteHost): string {
  if ('postId' in host) return host.postId
  if ('descriptionId' in host) return `description:${host.descriptionId}`
  return `preview:${host.previewId}`
}

/** One quote reference in a content body: enough to find it again and return focus to it. */
export interface QuoteRefInfo {
  /** History entry whose reader shows the quote. */
  entryKey: number
  /** Content whose body contains the quote. */
  host: QuoteHost
  /** Original trigger when following a quote inside its preview card. */
  origin?: QuoteAnchor
  /** Document order of the quote inside that body, from 0. */
  quoteIndex: number
  /** The quoted post. */
  postId: PostId
}

/** What a quote reference can ask of the app-level quote controller. */
export interface QuoteController {
  pointerEnter(info: QuoteRefInfo): void
  pointerLeave(): void
  /** Keyboard focus previews unless the controller is restoring a previous trigger. */
  focus(info: QuoteRefInfo): void
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

/** History entry around the quote references; null outside a navigable entry. */
export const QuoteEntryContext = createContext<number | null>(null)

export function quoteKey(entryKey: number, hostId: string, quoteIndex: number): string {
  return `${entryKey}:${hostId}:${quoteIndex}`
}

/** The rendered quote reference, if it is still in the document. */
export function findQuoteElement(entryKey: number, hostId: string, quoteIndex: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-quote-entry="${entryKey}"][data-quote-host="${CSS.escape(hostId)}"][data-quote-index="${quoteIndex}"]`
  )
}
