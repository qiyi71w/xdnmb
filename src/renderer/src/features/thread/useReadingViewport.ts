import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { PostId } from '../../../../shared/forum'
import type { ReadingAnchor } from '../../../../shared/reading'
import { captureAnchor, nearbyAnchor, scrollTopForAnchor, type PostBox } from '../reading/anchor'
import type { ReaderPosition } from './readingStart'

/** The reading line sits this far below the sticky toolbar. */
const LINE_GAP = 8
/** Position save after scrolling stops. */
const SAVE_DELAY_MS = 800

export interface ReadingViewportOptions {
  scrollRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  toolbarRef: RefObject<HTMLDivElement | null>
  /** The reader's tab is active and its pane is actually displayed. */
  displayed: boolean
  /** Positions may be saved for this mode (false while a target is shown in a temporary mode). */
  canSave: boolean
  onSave: (anchor: ReadingAnchor) => void
  /**
   * A requested position was not in the loaded range; the reader was placed nearby. `anchor`: a
   * remembered anchor (snapshot, saved position) whose post is gone; `post`: an explicit post.
   */
  onNearby: (kind: 'anchor' | 'post') => void
  /**
   * The reader scrolled the content itself (not a position or anchor applied by this hook), by
   * `delta` px (positive downwards) from the last position, whoever set that one.
   */
  onUserScroll: (delta: number) => void
}

function sameAnchor(a: ReadingAnchor, b: ReadingAnchor | null): boolean {
  return (
    b !== null &&
    a.postId === b.postId &&
    a.page === b.page &&
    a.viewportOffset === b.viewportOffset &&
    Math.abs(a.offsetRatio - b.offsetRatio) < 0.001
  )
}

/**
 * Reading line and anchors of one reader scroller.
 * - The last captured anchor (user scroll, rAF) is re-applied whenever anything resizes — late
 *   images, reflow after a width change, the toolbar growing — so the reading line stays on the
 *   same spot of the same post. Content appended below never moves the view. A page inserted above
 *   is kept still exactly with `exactAnchor` (read before the insertion) and `keepAnchor`.
 * - Nothing is captured or saved until the first position has been applied.
 */
export function useReadingViewport(options: ReadingViewportOptions) {
  const { scrollRef, contentRef, toolbarRef, displayed } = options
  const opts = useRef(options)
  useLayoutEffect(() => {
    opts.current = options
  })

  const anchorRef = useRef<ReadingAnchor | null>(null)
  const savedRef = useRef<ReadingAnchor | null>(null)
  const restoredRef = useRef(false)
  const pendingRef = useRef<ReaderPosition | null>(null)
  const expectedTopRef = useRef<number | null>(null)
  /** scrollTop after the last scroll event or position set here: the base of a user scroll's delta. */
  const baseTopRef = useRef(0)
  const frame = useRef<{ id: number | null }>({ id: null })
  const saveTimer = useRef<number | undefined>(undefined)

  const measurable = useCallback(() => {
    const scroller = scrollRef.current
    return opts.current.displayed && scroller !== null && scroller.clientHeight > 0 && contentRef.current !== null
  }, [scrollRef, contentRef])

  const toolbarHeight = useCallback(() => toolbarRef.current?.offsetHeight ?? 0, [toolbarRef])
  const lineOffset = useCallback(() => toolbarHeight() + LINE_GAP, [toolbarHeight])

  /** Content-coordinate origin: viewport top of the scroll content. */
  const origin = useCallback(() => {
    const scroller = scrollRef.current as HTMLDivElement
    return scroller.getBoundingClientRect().top - scroller.scrollTop
  }, [scrollRef])

  const boxes = useCallback((): PostBox[] => {
    const content = contentRef.current
    if (content === null || scrollRef.current === null) return []
    const top = origin()
    // The main post belongs to the first loaded page.
    const firstPage = Number(content.querySelector<HTMLElement>('[data-page]')?.dataset.page ?? '1')
    return Array.from(content.querySelectorAll<HTMLElement>('[data-post-id]'), (element) => {
      const rect = element.getBoundingClientRect()
      const section = element.closest<HTMLElement>('[data-page]')
      return {
        postId: element.dataset.postId ?? '',
        page: section === null ? firstPage : Number(section.dataset.page),
        top: rect.top - top,
        height: rect.height
      }
    })
  }, [contentRef, scrollRef, origin])

  const setScrollTop = useCallback(
    (top: number) => {
      const scroller = scrollRef.current
      if (scroller === null) return
      scroller.scrollTop = top
      expectedTopRef.current = scroller.scrollTop
      baseTopRef.current = scroller.scrollTop
    },
    [scrollRef]
  )

  const applyAnchor = useCallback(
    (anchor: ReadingAnchor): boolean => {
      const element = contentRef.current?.querySelector<HTMLElement>(`[data-post-id="${CSS.escape(anchor.postId)}"]`)
      if (element === null || element === undefined) return false
      const rect = element.getBoundingClientRect()
      setScrollTop(scrollTopForAnchor(anchor, { top: rect.top - origin(), height: rect.height }))
      return true
    },
    [contentRef, origin, setScrollTop]
  )

  /**
   * Re-applies a kept anchor with its viewport offset raised to the current reading line, so a
   * taller (wrapped) toolbar never covers it. The stored anchor keeps its original offset and is
   * used again as-is once the toolbar shrinks back.
   */
  const reapplyAnchor = useCallback(
    (anchor: ReadingAnchor): boolean => applyAnchor({ ...anchor, viewportOffset: Math.max(anchor.viewportOffset, lineOffset()) }),
    [applyAnchor, lineOffset]
  )

  const capture = useCallback(
    () => captureAnchor(boxes(), scrollRef.current?.scrollTop ?? 0, lineOffset()),
    [boxes, scrollRef, lineOffset]
  )

  const saveNow = useCallback(() => {
    window.clearTimeout(saveTimer.current)
    const anchor = anchorRef.current
    if (anchor === null || !restoredRef.current || !opts.current.canSave || sameAnchor(anchor, savedRef.current)) return
    savedRef.current = anchor
    opts.current.onSave(anchor)
  }, [])

  const scheduleSave = useCallback(() => {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(saveNow, SAVE_DELAY_MS)
  }, [saveNow])

  /** rAF-throttled capture after a user scroll. */
  const scheduleCapture = useCallback(() => {
    const current = frame.current
    if (current.id !== null) return
    current.id = requestAnimationFrame(() => {
      current.id = null
      if (!measurable() || !restoredRef.current) return
      anchorRef.current = capture() ?? anchorRef.current
      scheduleSave()
    })
  }, [measurable, capture, scheduleSave])

  const scrollToPage = useCallback(
    (page: number): boolean => {
      const section = contentRef.current?.querySelector<HTMLElement>(`[data-page="${page}"]`)
      if (section === null || section === undefined) return false
      setScrollTop(section.getBoundingClientRect().top - origin() - toolbarHeight())
      return true
    },
    [contentRef, origin, setScrollTop, toolbarHeight]
  )

  /**
   * Puts the reading line where `position` asks, or defers it until the reader is displayed.
   * Marks the reader as restored: capture and saving start from here.
   */
  const position = useCallback(
    (target: ReaderPosition) => {
      if (!measurable()) {
        pendingRef.current = target
        return
      }
      pendingRef.current = null
      let nearby: 'anchor' | 'post' | null = null
      /**
       * The anchor that was asked for. When the content below is still too short, the browser clamps
       * the scroll position; keeping the requested anchor (not a capture of the clamped position)
       * lets the ResizeObserver put the reading line back once content arrives, and saves it intact.
       */
      let requested: ReadingAnchor | null = null
      const line = lineOffset()
      switch (target.kind) {
        case 'top':
          setScrollTop(0)
          break
        case 'anchor':
          if (applyAnchor({ ...target.anchor, viewportOffset: Math.max(target.anchor.viewportOffset, line) })) {
            requested = target.anchor
          } else {
            // The anchor post vanished: nearest known post of that page, then the page top.
            nearby = 'anchor'
            const near = nearbyAnchor(boxes(), target.anchor)
            if (near !== null && applyAnchor({ ...near, viewportOffset: Math.max(near.viewportOffset, line) })) requested = near
            else if (!scrollToPage(target.anchor.page)) setScrollTop(0)
          }
          break
        case 'post': {
          const anchor: ReadingAnchor = { postId: target.postId, page: target.page, offsetRatio: 0, viewportOffset: line }
          if (applyAnchor(anchor)) {
            requested = anchor
          } else {
            nearby = 'post'
            if (!scrollToPage(target.page)) setScrollTop(0)
          }
          break
        }
        case 'page':
          if (!scrollToPage(target.page)) setScrollTop(0)
          break
        case 'last': {
          const posts = contentRef.current?.querySelectorAll<HTMLElement>('[data-post-id]')
          const last = posts === undefined ? undefined : posts[posts.length - 1]
          const postId = last?.dataset.postId
          // The main post belongs to the first loaded page.
          const section = last?.closest<HTMLElement>('[data-page]') ?? contentRef.current?.querySelector<HTMLElement>('[data-page]')
          const anchor: ReadingAnchor | null =
            postId === undefined ? null : { postId, page: Number(section?.dataset.page ?? '1'), offsetRatio: 0, viewportOffset: line }
          if (anchor !== null && applyAnchor(anchor)) requested = anchor
          else setScrollTop(0)
          break
        }
      }
      restoredRef.current = true
      anchorRef.current = requested ?? capture()
      // An explicit position is a reading position like a scrolled one: save it after the same delay
      // (skipped while a temporary target mode is shown, and when it equals the saved anchor).
      scheduleSave()
      if (nearby !== null) opts.current.onNearby(nearby)
    },
    [measurable, lineOffset, setScrollTop, applyAnchor, boxes, scrollToPage, contentRef, capture, scheduleSave]
  )

  const onScroll = useCallback(() => {
    const scroller = scrollRef.current
    if (scroller === null) return
    const top = scroller.scrollTop
    const base = baseTopRef.current
    baseTopRef.current = top
    if (!restoredRef.current || !measurable()) return
    // The last position we set stays recorded until the reader scrolls: separate scroll events for
    // our assignment and a later layout clamp are both recognised.
    const expected = expectedTopRef.current
    if (expected !== null) {
      // Our own scroll (restore, anchor keeping): nothing moved under the reading line.
      if (Math.abs(top - expected) < 1) return
      // Our position was clamped by a layout change (content became shorter, e.g. an intermediate
      // layout before single pane): not the reader's choice. Keep the anchor; the ResizeObserver
      // re-applies it once the layout settles.
      if (top < expected && top >= scroller.scrollHeight - scroller.clientHeight - 1) return
    }
    expectedTopRef.current = null
    opts.current.onUserScroll(top - base)
    scheduleCapture()
  }, [scrollRef, measurable, scheduleCapture])

  /**
   * Anchor of exactly what is on screen now, taken before content is inserted above it: the post
   * under the reading line, or, when the line falls above or between posts, the next post at its
   * own distance from the viewport top (a plain capture would move that post up to the line).
   */
  const exactAnchor = useCallback((): ReadingAnchor | null => {
    const scroller = scrollRef.current
    if (!measurable() || !restoredRef.current || scroller === null) return null
    const all = boxes()
    const anchor = captureAnchor(all, scroller.scrollTop, lineOffset())
    if (anchor === null || anchor.offsetRatio > 0) return anchor
    const box = all.find((item) => item.postId === anchor.postId)
    return box === undefined ? anchor : { ...anchor, viewportOffset: Math.max(anchor.viewportOffset, box.top - scroller.scrollTop) }
  }, [scrollRef, measurable, boxes, lineOffset])

  /** Puts `anchor` (from `exactAnchor`) back on screen right after layout and keeps it until the reader scrolls. */
  const keepAnchor = useCallback(
    (anchor: ReadingAnchor) => {
      if (!measurable() || !restoredRef.current) return
      anchorRef.current = anchor
      reapplyAnchor(anchor)
    },
    [measurable, reapplyAnchor]
  )

  // Re-shown (tab activated, single pane switched back): the browser may have dropped scrollTop
  // while the pane was hidden, so re-apply the pending position or the last anchor.
  useLayoutEffect(() => {
    if (!displayed) return
    const pending = pendingRef.current
    if (pending !== null) position(pending)
    else if (restoredRef.current && anchorRef.current !== null) reapplyAnchor(anchorRef.current)
  }, [displayed, position, reapplyAnchor])

  // Keep the anchor under the reading line whenever content, toolbar or viewport size changes.
  useEffect(() => {
    const scroller = scrollRef.current
    const content = contentRef.current
    if (scroller === null || content === null) return
    const observer = new ResizeObserver(() => {
      if (!measurable() || !restoredRef.current) return
      const anchor = anchorRef.current
      if (anchor !== null && !reapplyAnchor(anchor)) anchorRef.current = capture()
    })
    observer.observe(scroller)
    observer.observe(content)
    if (toolbarRef.current !== null) observer.observe(toolbarRef.current)
    return () => observer.disconnect()
  }, [scrollRef, contentRef, toolbarRef, measurable, reapplyAnchor, capture])

  // Leaving the screen (tab hidden, single pane shows the list) saves the position now.
  useEffect(() => {
    if (!displayed) saveNow()
  }, [displayed, saveNow])

  useEffect(
    () => () => {
      const current = frame.current
      if (current.id !== null) cancelAnimationFrame(current.id)
      current.id = null
      saveNow()
    },
    [saveNow]
  )

  /** Last anchor once the first position has been applied; null before. */
  const currentAnchor = useCallback(() => (restoredRef.current ? anchorRef.current : null), [])

  /** Whether `postId` is rendered in the current range. */
  const hasPost = useCallback(
    (postId: PostId) => contentRef.current?.querySelector(`[data-post-id="${CSS.escape(postId)}"]`) != null,
    [contentRef]
  )

  /** Whether `postId` is displayed and at least partly inside the reading viewport below the toolbar. */
  const isVisible = useCallback(
    (postId: PostId) => {
      const scroller = scrollRef.current
      const element = contentRef.current?.querySelector<HTMLElement>(`[data-post-id="${CSS.escape(postId)}"]`)
      if (!measurable() || !restoredRef.current || scroller === null || element == null) return false
      const rect = scroller.getBoundingClientRect()
      const box = element.getBoundingClientRect()
      return Math.min(box.bottom, rect.top + scroller.clientHeight) - Math.max(box.top, rect.top + toolbarHeight()) > 0
    },
    [scrollRef, contentRef, measurable, toolbarHeight]
  )

  return { onScroll, position, currentAnchor, saveNow, hasPost, isVisible, exactAnchor, keepAnchor }
}
