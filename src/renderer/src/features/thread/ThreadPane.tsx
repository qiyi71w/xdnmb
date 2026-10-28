import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReadingMode } from '../../../../shared/forum'
import type { ReadingAnchor, ThreadReadingState } from '../../../../shared/reading'
import { createReadingResets, useReadingGeneration } from '../content/readingResets'
import { ContentRegistryContext } from '../tabs/contentRegistry'
import type { ThreadOpen } from '../tabs/tabsState'
import type { ComposeEntry } from '../editor/ComposePanel'
import { decideView, savedStart, type ReaderStart } from './readingStart'
import { ThreadReader } from './ThreadReader'
import './thread.css'

/**
 * Reading context of one thread shown in one history entry: fetches the thread's reading state,
 * decides the mode and start position once (target → snapshot of the current reading-data
 * generation → saved position → page 1 top),
 * records the visit, and owns mode changes and reading-state writes. The reader below is remounted
 * for each mode it shows. Loads stay quiet: a text-free skeleton until the reading state arrives.
 *
 * When the thread's reading data is cleared (history deletion with 阅读进度), readers created
 * before drop their position and reading-state writes, and a fresh reader starts at the top.
 */
export function ThreadPane({
  entryKey,
  open,
  displayed,
  forumName,
  onBackToList,
  compose
}: {
  entryKey: number
  /** Thread opening; a confirmed send can advance the history entry without replacing this pane. */
  open: ThreadOpen
  displayed: boolean
  forumName: (forumId: string | null) => string | null
  onBackToList: (() => void) | null
  /** The 回复 entry for the toolbar and its sent note. */
  compose: ComposeEntry | null
}) {
  const threadId = open.threadId
  const openRef = useRef(open)
  const mounted = useRef(true)
  const fetchSeq = useRef(0)
  const visited = useRef(false)
  const registry = useContext(ContentRegistryContext)
  // Outside the shell (no registry) nothing else clears reading data: a private store never resets.
  const [ownResets] = useState(createReadingResets)
  const resets = registry?.readingResets ?? ownResets
  const generation = useReadingGeneration(resets, threadId)
  const [readingState, setReadingState] = useState<ThreadReadingState | null>(null)
  /**
   * Mode and start of the mounted reader. `temporaryOf` names the saved preference while a temporary
   * target display is shown (an explicit target in another mode, or coming back to an entry left
   * during one); see `decideView`. Other tabs changing the preference or a later refetch never make
   * a display temporary. `generation` is the reading-data generation the reader was created under.
   */
  const [view, setView] = useState<{ start: ReaderStart; seq: number; temporaryOf: ReadingMode | null; generation: number } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    const at = resets.generation(threadId)
    window.xidao.readingState
      .get({ threadId })
      .catch(() => null)
      .then((state) => {
        if (cancelled) return
        setReadingState(state)
        setView({ ...decideView(openRef.current, state, at), seq: 0, generation: at })
      })
    return () => {
      cancelled = true
      mounted.current = false
    }
  }, [threadId, resets])

  const shownEntry = useRef(entryKey)
  useEffect(() => {
    if (shownEntry.current === entryKey) return
    shownEntry.current = entryKey
    openRef.current = open
    setView((current) => current === null ? current : {
      ...current,
      ...decideView(open, readingState, current.generation)
    })
  }, [entryKey, open, readingState])

  // Browsing history: once per thread opened in a visible reader. Not a navigation step.
  useEffect(() => {
    if (!displayed || visited.current) return
    visited.current = true
    window.xidao.readingState.recordVisit({ threadId }).catch(() => undefined)
  }, [displayed, threadId])

  const refetch = useCallback(async (): Promise<ThreadReadingState | null> => {
    const seq = ++fetchSeq.current
    try {
      const next = await window.xidao.readingState.get({ threadId })
      if (seq === fetchSeq.current && mounted.current) setReadingState(next)
      return next
    } catch {
      return null
    }
  }, [threadId])

  const onObserved = useCallback(() => void refetch(), [refetch])

  // Reading data cleared under this reader: start a fresh reader at the top of the mode it shows. The old reader's late writes are dropped by `writable`.
  const viewGeneration = view?.generation
  useEffect(() => {
    if (viewGeneration === undefined || viewGeneration === generation) return
    let cancelled = false
    void refetch().then(() => {
      if (cancelled) return
      setNotice('阅读进度已清除，已回到开头')
      setView((current) =>
        current === null
          ? current
          : { start: { mode: current.start.mode, position: { kind: 'top' } }, seq: current.seq + 1, temporaryOf: null, generation }
      )
    })
    return () => {
      cancelled = true
    }
  }, [viewGeneration, generation, refetch])

  const onSavePosition = useCallback(
    (at: number, mode: ReadingMode, anchor: ReadingAnchor) => {
      if (!resets.writable(threadId, at)) return
      window.xidao.readingState.savePosition({ threadId, mode, anchor }).catch(() => undefined)
    },
    [threadId, resets]
  )

  /**
   * Toggle 全部 / 只看 PO. The position of the mode being left is saved first, under that mode,
   * unless it was a temporary target display. Choosing a mode saves it as the preference, except
   * returning from a temporary target display to the preference it named. Choosing the mode already
   * shown during a temporary display adopts it as the preference and ends the temporary state.
   * A newly shown mode opens at its own saved position.
   */
  const chooseMode = async (next: ReadingMode) => {
    if (view === null) return
    const leaving = view.start.mode
    const temporaryOf = view.temporaryOf
    if (next === leaving) {
      if (temporaryOf === null) return
      setNotice(null)
      setView((current) => (current === null ? current : { ...current, temporaryOf: null }))
      const result = await window.xidao.readingState.setMode({ threadId, mode: next }).catch(() => ({ saved: false }))
      if (!result.saved && mounted.current) setNotice('阅读模式未保存')
      return
    }
    setNotice(null)
    if (temporaryOf === null) {
      const snapshot = registry?.readers.get(entryKey)?.current.capture() ?? null
      if (snapshot !== null && snapshot.mode === leaving && resets.writable(threadId, view.generation)) {
        await window.xidao.readingState.savePosition({ threadId, mode: leaving, anchor: snapshot.anchor }).catch(() => undefined)
        if (!mounted.current) return
      }
    }
    if (next !== temporaryOf) {
      const result = await window.xidao.readingState.setMode({ threadId, mode: next }).catch(() => ({ saved: false }))
      if (!result.saved && mounted.current) setNotice('阅读模式未保存')
    }
    const fresh = await refetch()
    if (!mounted.current) return
    setView((current) => ({
      start: savedStart(fresh ?? readingState, next),
      seq: (current?.seq ?? 0) + 1,
      temporaryOf: null,
      generation: current?.generation ?? view.generation
    }))
  }

  // Until the reading state arrives: a text-free skeleton.
  if (view === null) {
    return (
      <section className="reader" aria-label={`串 No.${threadId}`}>
        <div className="reader-scroll">
          <div className="reader-column">
            <div className="reader-placeholder" aria-busy="true">
              <div aria-hidden="true">
                {Array.from({ length: 3 }, (_, index) => (
                  <div key={index} className="post-skeleton">
                    <span className="skeleton-line is-short" />
                    <span className="skeleton-line" />
                    <span className="skeleton-line is-mid" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    )
  }

  return (
    <ThreadReader
      key={view.seq}
      entryKey={entryKey}
      threadId={threadId}
      mode={view.start.mode}
      temporaryOf={view.temporaryOf}
      generation={view.generation}
      start={view.start.position}
      initialHead={open.head}
      displayed={displayed}
      notice={notice}
      forumName={forumName}
      onChooseMode={(mode) => void chooseMode(mode)}
      onSavePosition={(mode, anchor) => onSavePosition(view.generation, mode, anchor)}
      onObserved={onObserved}
      onBackToList={onBackToList}
      compose={compose}
      unlocatedPostId={openRef.current.unlocatedPostId}
      // Only the first reader of the entry arrives from the opening: a later mode switch or a reset
      // does not, and a snapshot voided by a history clear gives back no focus either.
      restoreFocus={
        view.seq === 0 && openRef.current.target === null && openRef.current.snapshot?.generation === view.generation
          ? openRef.current.snapshot.focus
          : null
      }
      highlightPostId={view.seq === 0 ? (openRef.current.target?.postId ?? null) : null}
    />
  )
}
