import { createContext } from 'react'
import type { LocateHint } from '../../../../shared/api'
import type { PostId } from '../../../../shared/forum'

/**
 * A real content host, not necessarily a post. Preview hosts stay distinct from the reader.
 * `selectionId` is a selected whole post number inside some content: it has no element of its own.
 */
export type QuoteHost = { postId: PostId } | { descriptionId: string } | { previewId: string } | { selectionId: string }
export type QuoteAnchor = QuoteHost & { quoteIndex: number }

export function quoteHostId(host: QuoteHost): string {
  if ('postId' in host) return host.postId
  if ('descriptionId' in host) return `description:${host.descriptionId}`
  if ('selectionId' in host) return `selection:${host.selectionId}`
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
  /** Verified forum link clue (thread and page), used only when local records do not locate the post. */
  hint?: LocateHint
}

/**
 * A whole post number the user selected in body content (see `selectedPostNumber`). It is no
 * reference: nothing was linked or requested before the user chose an action on it.
 */
export interface SelectedNumber {
  /** History entry whose content holds the selection. */
  entryKey: number
  postId: PostId
  /** The selected text, for placing the card under it while the content stays. */
  range: Range
  /** Where focus goes back when the card closes (the post or row whose menu offered the action). */
  returnFocus: HTMLElement | null
}

/** What a quote reference can ask of the app-level quote controller. */
export interface QuoteController {
  pointerEnter(info: QuoteRefInfo): void
  pointerLeave(): void
  /** Keyboard focus previews unless the controller is restoring a previous trigger or the quote is inside a card. */
  focus(info: QuoteRefInfo): void
  /** Focus left the quote reference. */
  blur(): void
  /** Space: opens the preview card at once (not pinned). */
  preview(info: QuoteRefInfo): void
  /**
   * Click / Enter (`newTab` false), or 在新标签页打开 and Ctrl·Cmd + click / Enter (`newTab` true):
   * once located, the target shows in this tab or in a new tab that becomes the active one.
   */
  activate(info: QuoteRefInfo, newTab: boolean): void
  /** Whether a click or Enter with these modifiers means “open in a new tab”. */
  isNewTab(event: { ctrlKey: boolean; metaKey: boolean }): boolean
  /**
   * The quote's context menu opens: no hover preview opens behind it, and a card holding the
   * quote stays (pinned) so the menu's actions still find it.
   */
  contextMenu(info: QuoteRefInfo): void
  /** Tab from the quote reference whose card is open: moves focus into the card. */
  focusCard(): boolean
  /**
   * An action on a selected number, from its content's context menu (right click, ContextMenu key or
   * Shift+F10): `preview` opens the pinned card; `navigate` / `new-tab` locate it like a click / Ctrl·Cmd
   * click on a quote, with the same card for anything but a located post.
   */
  selection(selected: SelectedNumber, action: 'preview' | 'navigate' | 'new-tab'): void
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
