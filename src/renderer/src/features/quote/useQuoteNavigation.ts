import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import type { AppPlatform, QuoteLocation } from '../../../../shared/api'
import type { ThreadId } from '../../../../shared/forum'
import type { AppSettings } from '../../../../shared/settings'
import { isEditableTarget } from '../../app/shortcuts'
import { openLayer } from '../../lib/layers'
import type { ContentRegistry } from '../tabs/contentRegistry'
import { clearThreadReminders } from '../reminders/useReminders'
import { currentEntry, entryThread, newTabEntry, type Tab, type TabEntry, type TabsAction, type TabsState, type ThreadOpen, type ThreadSnapshot } from '../tabs/tabsState'
import { readResumePage } from '../thread/readingStart'
import { findQuoteElement, quoteHostId, quoteKey, type QuoteController, type QuoteRefInfo } from './QuoteContext'
import {
  initialQuoteState,
  isCurrentLocate,
  isCurrentPreview,
  locateCommit,
  quoteReducer,
  type LocateIntent,
  type QuoteAction,
  type QuoteCard,
  type QuoteSource,
  type QuoteState,
  type QuoteTrigger
} from './quoteState'

/** Hover time before a preview opens, and grace time to move the pointer from quote to card. */
const HOVER_DELAY_MS = 280
const LEAVE_DELAY_MS = 220

const TABBABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

const previewOperation = (cardId: number) => `quote-preview-${cardId}`
const locateOperation = (cardId: number) => `quote-locate-${cardId}`

function cancelOperation(operationId: string): void {
  window.xidao.reading.cancel({ operationId }).catch(() => undefined)
}

function triggerOf(source: QuoteSource): HTMLElement | null {
  return findQuoteElement(source.entryKey, quoteHostId(source.focus), source.focus.quoteIndex)
}

function tabbables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter((element) => element.getClientRects().length > 0)
}

/** The IPC call itself rejected (not a forum read failure): shown as an internal request failure. */
export interface QuoteInternalFailure {
  /** Preview `seq` whose call rejected. */
  previewSeq: number | null
  /** Intent of the last locate / 打开原串 call that rejected (it was dropped), else null. */
  locate: LocateIntent | null
}

export interface QuoteCardProps {
  card: QuoteCard
  internal: QuoteInternalFailure
  cardRef: RefObject<HTMLDivElement | null>
  anchor: () => HTMLElement | null
  onPointerEnter: () => void
  onPointerLeave: () => void
  onBlur: () => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  onRetry: () => void
  onOpenThread: () => void
  onClose: () => void
}

interface Options {
  tabs: TabsState | null
  getTabs: () => TabsState | null
  getSettings: () => AppSettings
  dispatch: (action: TabsAction) => void
  registry: ContentRegistry
  platform: AppPlatform | null
}

const NO_INTERNAL: QuoteInternalFailure = { previewSeq: null, locate: null }

/**
 * App-level quote cards: one top-level card at a time, previews and locates with
 * stale-result guards, and the navigation a located quote commits (same tab, in place, a new active
 * tab or 打开原串). Every async result is checked against the latest card state before anything
 * happens; previews never touch reading state.
 */
export function useQuoteNavigation(options: Options) {
  const opts = useRef(options)
  useLayoutEffect(() => {
    opts.current = options
  })

  const [state, setState] = useState<QuoteState>(initialQuoteState)
  const stateRef = useRef<QuoteState>(initialQuoteState)
  const apply = useCallback((action: QuoteAction): QuoteState => {
    const next = quoteReducer(stateRef.current, action)
    if (next !== stateRef.current) {
      stateRef.current = next
      setState(next)
    }
    return next
  }, [])

  const [internal, setInternal] = useState<{ cardId: number; failure: QuoteInternalFailure } | null>(null)
  const markInternal = useCallback((cardId: number, update: Partial<QuoteInternalFailure>) => {
    setInternal((current) => ({ cardId, failure: { ...(current?.cardId === cardId ? current.failure : NO_INTERNAL), ...update } }))
  }, [])

  const cardRef = useRef<HTMLDivElement>(null)
  /** Thread shown by the source entry when each card opened: a locate commits only while it still is. */
  const threadOf = useRef(new Map<number, ThreadId | null>())
  const pointer = useRef({ trigger: false, card: false })
  const restoringFocus = useRef(false)
  const openTimer = useRef<number | undefined>(undefined)
  const leaveTimer = useRef<number | undefined>(undefined)

  const clearTimers = useCallback(() => {
    window.clearTimeout(openTimer.current)
    window.clearTimeout(leaveTimer.current)
  }, [])

  /** Tab and entry showing `entryKey` as its current entry. */
  const shownEntry = useCallback((entryKey: number): { tab: Tab; entry: TabEntry } | null => {
    const tabs = opts.current.getTabs()
    if (tabs === null) return null
    for (const tab of tabs.tabs) {
      const entry = currentEntry(tab)
      if (entry.key === entryKey) return { tab, entry }
    }
    return null
  }, [])

  /** The card's source entry is still current in its tab and still shows the same thread. */
  const sourceCurrent = useCallback(
    (card: QuoteCard): { tab: Tab; entry: TabEntry } | null => {
      const shown = shownEntry(card.source.entryKey)
      if (shown === null || shown.tab.id !== card.source.tabId) return null
      return (entryThread(shown.entry)?.threadId ?? null) === threadOf.current.get(card.id) ? shown : null
    },
    [shownEntry]
  )

  const runPreview = useCallback(
    (card: QuoteCard) => {
      const { id: cardId } = card
      const seq = card.preview.seq
      window.xidao.quotes.preview({ operationId: previewOperation(cardId), postId: card.source.postId }).then(
        (outcome) => apply({ type: 'preview-done', cardId, seq, outcome }),
        () => {
          if (isCurrentPreview(stateRef.current, cardId, seq)) markInternal(cardId, { previewSeq: seq })
        }
      )
    },
    [apply, markInternal]
  )

  const focusTrigger = useCallback((source: QuoteSource) => {
    restoringFocus.current = true
    try {
      triggerOf(source)?.focus({ preventScroll: true })
    } finally {
      restoringFocus.current = false
    }
  }, [])

  /** Commits a quote navigation from the card's source entry (located target or 打开原串). */
  const commit = useCallback(
    (card: QuoteCard, shown: { tab: Tab; entry: TabEntry }, thread: ThreadOpen) => {
      const { registry, dispatch, getTabs } = opts.current
      const { tab, entry } = shown
      const captured = registry.readers.get(entry.key)?.current.capture() ?? null
      const focus = 'postId' in card.source.focus ? card.source.focus : captured?.focus ?? null
      const source: ThreadSnapshot | null = captured === null ? null : { ...captured, focus }
      // The split list beside the target keeps its loaded pages and scroll position.
      if (entry.kind === 'list' && entry.feed !== null && tab.split) {
        const memory = registry.listMemory.get(entry.key)
        const nextKey = getTabs()?.nextKey
        if (memory !== undefined && nextKey !== undefined) registry.listMemory.set(nextKey, memory)
      }
      apply({ type: 'close', cardId: card.id })
      dispatch({ type: 'quote-navigate', tabId: tab.id, entryKey: entry.key, source, thread })
    },
    [apply]
  )

  const onLocated = useCallback(
    (cardId: number, seq: number, result: QuoteLocation) => {
      const current = stateRef.current
      if (!isCurrentLocate(current, cardId, seq) || result.status === 'cancelled') return
      const card = current.card as QuoteCard
      const shown = sourceCurrent(card)
      if (shown === null) {
        apply({ type: 'close', cardId })
        return
      }
      const commitKind = locateCommit(card.locate?.intent ?? 'resolve', result)
      if (commitKind === 'card' || result.status !== 'located') {
        apply({ type: 'locate-done', cardId, seq, result })
        return
      }
      const target = { postId: result.target.postId, page: result.target.page, mode: result.target.mode }
      const thread: ThreadOpen = { threadId: result.threadId, head: result.head, target, snapshot: null, unlocatedPostId: null }
      if (commitKind === 'new-tab') {
        // A new tab with its own history becomes the active one; the source tab keeps its place.
        const { dispatch, getSettings } = opts.current
        const split = getSettings().newTabSplitDefault
        apply({ type: 'close', cardId })
        dispatch({ type: 'open-tab', entry: newTabEntry(shown.entry, split, thread), split })
        return
      }
      // Already on screen in the same thread and mode: no new history step, just point at it. The
      // jump is still an explicit open of that thread, so its reminder counts go to 0.
      const reader = opts.current.registry.readers.get(shown.entry.key)?.current
      if (reader !== undefined && reader.showInPlace(result.threadId, target)) {
        clearThreadReminders(result.threadId)
        apply({ type: 'close', cardId })
        return
      }
      commit(card, shown, thread)
    },
    [apply, sourceCurrent, commit]
  )

  const runLocate = useCallback(
    (card: QuoteCard) => {
      const locate = card.locate
      if (locate === null || locate.result !== null) return
      const { id: cardId } = card
      const seq = locate.seq
      markInternal(cardId, { locate: null })
      window.xidao.quotes.locate({ operationId: locateOperation(cardId), postId: card.source.postId }).then(
        (result) => onLocated(cardId, seq, result),
        () => {
          if (!isCurrentLocate(stateRef.current, cardId, seq)) return
          apply({ type: 'cancel-locate', cardId })
          markInternal(cardId, { locate: locate.intent })
        }
      )
    },
    [apply, markInternal, onLocated]
  )

  /** Opens (or takes over) the card of a quote; returns it when it belongs to that quote. */
  const open = useCallback(
    (info: QuoteRefInfo, trigger: QuoteTrigger): QuoteCard | null => {
      const shown = shownEntry(info.entryKey)
      const shownThread = shown === null ? null : entryThread(shown.entry)
      if (shown === null) return null
      const before = stateRef.current.card
      if ('previewId' in info.host && info.host.previewId !== `${before?.id}:${before?.source.postId}`) return null
      const source: QuoteSource = {
        tabId: shown.tab.id,
        entryKey: info.entryKey,
        postId: info.postId,
        focus: info.origin ?? { ...info.host, quoteIndex: info.quoteIndex },
        reference: info.origin === undefined ? undefined : { ...info.host, quoteIndex: info.quoteIndex }
      }
      if (info.origin !== undefined && trigger !== 'hover' && cardRef.current?.contains(document.activeElement)) focusTrigger(source)
      // Following a reference in the card is a deliberate preview choice, even if its parent was pinned.
      const card = apply({ type: 'open', source, trigger: info.origin !== undefined && trigger === 'hover' ? 'preview' : trigger }).card
      const reference = card === null ? null : card.source.reference ?? card.source.focus
      if (card === null || reference === null || quoteHostId(reference) !== quoteHostId(info.host) || reference.quoteIndex !== info.quoteIndex || card.source.entryKey !== info.entryKey || card.source.postId !== info.postId) {
        return null
      }
      if (card.id !== before?.id) {
        if (info.origin !== undefined) pointer.current.trigger = false
        threadOf.current.set(card.id, shownThread?.threadId ?? null)
        runPreview(card)
      }
      return card
    },
    [apply, shownEntry, runPreview, focusTrigger]
  )

  const startLocate = useCallback(
    (cardId: number, intent: 'navigate' | 'new-tab') => {
      const before = stateRef.current.card
      const card = apply({ type: 'locate-start', cardId, intent }).card
      if (card !== null && card.locate !== null && card.locate.seq !== before?.locate?.seq) runLocate(card)
    },
    [apply, runLocate]
  )

  const checkLeave = useCallback(() => {
    const card = stateRef.current.card
    if (card === null || card.pinned || pointer.current.trigger || pointer.current.card) return
    const focused = document.activeElement
    if (focused !== null && cardRef.current?.contains(focused)) return
    // Keyboard focus on the quote (Space preview) keeps it; a quote merely clicked earlier does not.
    if (focused !== null && focused === triggerOf(card.source) && focused.matches(':focus-visible')) return
    apply({ type: 'leave', cardId: card.id })
  }, [apply])

  const scheduleLeave = useCallback(() => {
    window.clearTimeout(leaveTimer.current)
    leaveTimer.current = window.setTimeout(checkLeave, LEAVE_DELAY_MS)
  }, [checkLeave])

  const closeCard = useCallback(
    (returnFocus: boolean) => {
      const card = stateRef.current.card
      if (card === null) return
      apply({ type: 'close', cardId: card.id })
      if (returnFocus) focusTrigger(card.source)
    },
    [apply, focusTrigger]
  )

  /** Moves focus to the element that follows the card's quote in tab order. */
  const focusAfterTrigger = useCallback((source: QuoteSource) => {
    const trigger = triggerOf(source)
    if (trigger === null) return
    const list = tabbables(document).filter((element) => !cardRef.current?.contains(element))
    const next = list[list.indexOf(trigger) + 1]
    ;(next ?? trigger).focus()
  }, [])

  const controller = useMemo<QuoteController>(
    () => ({
      pointerEnter(info) {
        pointer.current.trigger = true
        window.clearTimeout(leaveTimer.current)
        window.clearTimeout(openTimer.current)
        const card = stateRef.current.card
        const reference = card === null ? null : card.source.reference ?? card.source.focus
        if (card !== null && reference !== null && card.source.entryKey === info.entryKey && quoteHostId(reference) === quoteHostId(info.host) && reference.quoteIndex === info.quoteIndex && card.source.postId === info.postId) {
          return
        }
        openTimer.current = window.setTimeout(() => {
          if (pointer.current.trigger) open(info, 'hover')
        }, HOVER_DELAY_MS)
      },
      pointerLeave() {
        pointer.current.trigger = false
        window.clearTimeout(openTimer.current)
        scheduleLeave()
      },
      blur() {
        scheduleLeave()
      },
      focus(info) {
        // A quote inside a card only takes focus: previewing it would replace the card and send
        // focus back to the outer quote, so its Enter, Ctrl/Cmd+Enter and menu keys could never act
        // on it. Space (or hovering) previews it.
        if (restoringFocus.current || info.origin !== undefined) return
        window.clearTimeout(openTimer.current)
        open(info, 'preview')
      },
      preview(info) {
        window.clearTimeout(openTimer.current)
        open(info, 'preview')
      },
      activate(info, newTab) {
        clearTimers()
        const card = open(info, 'activate')
        if (card !== null) startLocate(card.id, newTab ? 'new-tab' : 'navigate')
      },
      isNewTab(event) {
        const platform = opts.current.platform
        if (platform === null) return event.ctrlKey || event.metaKey
        return platform === 'darwin' ? event.metaKey : event.ctrlKey
      },
      contextMenu(info) {
        window.clearTimeout(openTimer.current)
        // A quote inside a card: that card stays while its menu is open and the pointer is away.
        const card = stateRef.current.card
        if (card !== null && 'previewId' in info.host && info.host.previewId === `${card.id}:${card.source.postId}`) {
          apply({ type: 'open', source: card.source, trigger: 'activate' })
        }
      },
      focusCard() {
        const first = cardRef.current === null ? undefined : tabbables(cardRef.current)[0]
        first?.focus()
        return first !== undefined
      }
    }),
    [open, scheduleLeave, clearTimers, startLocate, apply]
  )

  // A closed or replaced card drops its reads.
  const cardId = state.card?.id ?? null
  const previousCard = useRef<number | null>(null)
  useEffect(() => {
    const previous = previousCard.current
    previousCard.current = cardId
    if (previous === null || previous === cardId) return
    cancelOperation(previewOperation(previous))
    cancelOperation(locateOperation(previous))
    threadOf.current.delete(previous)
    pointer.current.card = cardRef.current?.matches(':hover') ?? false
  }, [cardId])

  // Another tab, another entry or thread in the source tab, or the quote no longer displayed: the
  // card closes and its running locate can never commit.
  const tabs = options.tabs
  useEffect(() => {
    const card = stateRef.current.card
    if (card === null || tabs === null) return
    const trigger = triggerOf(card.source)
    if (tabs.activeId !== card.source.tabId || sourceCurrent(card) === null || trigger === null || trigger.getClientRects().length === 0) {
      apply({ type: 'close', cardId: card.id })
    }
  }, [tabs, sourceCurrent, apply])

  // Esc and outside clicks while a card is open.
  const hasCard = cardId !== null
  useEffect(() => {
    if (!hasCard) return
    // The card is one closable layer: a popover opened after it takes Esc first.
    const layer = openLayer()
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || isEditableTarget(event.target) || !layer.isTop()) return
      const card = stateRef.current.card
      if (card === null) return
      event.preventDefault()
      event.stopPropagation()
      const focused = document.activeElement
      const returnFocus = focused === null || focused === document.body || (cardRef.current?.contains(focused) ?? false)
      if (card.locate !== null && card.locate.result === null) {
        // Cancels the locate (or 打开原串) only: the card stays, the reading position and history are
        // untouched. A disabled card button would strand focus, so it goes back to the quote.
        apply({ type: 'cancel-locate', cardId: card.id })
        cancelOperation(locateOperation(card.id))
        if (returnFocus) focusTrigger(card.source)
        return
      }
      closeCard(returnFocus)
    }
    const onPointerDown = (event: PointerEvent) => {
      // A layer opened over the card (a quote's context menu) owns this press.
      if (!layer.isTop()) return
      const target = event.target
      if (target instanceof Node && cardRef.current?.contains(target)) return
      // Choosing another quote replaces the card through its own activation.
      if (target instanceof Element && target.closest('[data-quote-entry]') !== null) return
      closeCard(false)
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      layer.release()
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [hasCard, apply, closeCard, focusTrigger])

  useEffect(() => clearTimers, [clearTimers])

  /** The open card's quote element; stable so the card does not re-subscribe on every render. */
  const anchor = useCallback(() => {
    const current = stateRef.current.card
    return current === null ? null : triggerOf(current.source)
  }, [])

  const card = state.card
  const reference = card === null ? null : card.source.reference ?? card.source.focus
  const activeKey = card === null || reference === null ? null : quoteKey(card.source.entryKey, quoteHostId(reference), reference.quoteIndex)

  const cardProps: QuoteCardProps | null =
    card === null
      ? null
      : {
          card,
          internal: internal?.cardId === card.id ? internal.failure : NO_INTERNAL,
          cardRef,
          anchor,
          onPointerEnter: () => {
            pointer.current.card = true
            window.clearTimeout(leaveTimer.current)
          },
          onPointerLeave: () => {
            pointer.current.card = false
            scheduleLeave()
          },
          onBlur: scheduleLeave,
          onKeyDown: (event) => {
            if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey || cardRef.current === null) return
            const list = tabbables(cardRef.current)
            const focused = document.activeElement
            if (event.shiftKey && focused === list[0]) {
              event.preventDefault()
              focusTrigger(card.source)
            } else if (!event.shiftKey && focused === list[list.length - 1]) {
              event.preventDefault()
              focusAfterTrigger(card.source)
            }
          },
          onRetry: () => {
            const before = stateRef.current.card
            if (before === null || before.id !== card.id) return
            setInternal(null)
            const next = apply({ type: 'retry', cardId: card.id }).card
            if (next === null) return
            runPreview(next)
            if (next.locate !== null && next.locate.seq !== before.locate?.seq) runLocate(next)
          },
          onOpenThread: () => {
            const before = stateRef.current.card
            if (before === null || before.id !== card.id) return
            const shown = sourceCurrent(before)
            if (shown === null) {
              apply({ type: 'close', cardId: card.id })
              return
            }
            const started = apply({ type: 'open-thread-start', cardId: card.id }).card
            const locate = started?.locate
            if (started === null || locate === undefined || locate === null || locate.intent !== 'open-thread' || locate.known === undefined) return
            const { seq, known } = locate
            const threadId = known.threadId
            const cardId = card.id
            markInternal(cardId, { locate: null })
            // Commit returnable history only once the page the thread resumes at was obtained.
            const run = async () => {
              const outcome = await readResumePage(threadId, locateOperation(cardId), () => isCurrentLocate(stateRef.current, cardId, seq))
              const latest = stateRef.current
              if (outcome === null || !isCurrentLocate(latest, cardId, seq) || outcome.status === 'cancelled') return
              if (outcome.status === 'failed') {
                apply({ type: 'locate-done', cardId, seq, result: { status: 'failed', threadId, error: outcome.error } })
                return
              }
              const current = latest.card as QuoteCard
              const source = sourceCurrent(current)
              if (source === null) {
                apply({ type: 'close', cardId })
                return
              }
              commit(current, source, { threadId, head: known.head, target: null, snapshot: null, unlocatedPostId: current.source.postId })
            }
            run().catch(() => {
              if (!isCurrentLocate(stateRef.current, cardId, seq)) return
              apply({ type: 'cancel-locate', cardId })
              markInternal(cardId, { locate: 'open-thread' })
            })
          },
          onClose: () => closeCard(true)
        }

  return { controller, activeKey, cardProps }
}
