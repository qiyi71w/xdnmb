import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { PostId, ReadingMode } from '../../../../shared/forum'
import type { ReadingAnchor, ThreadReadingState } from '../../../../shared/reading'
import { Loading } from '../../components/Notices'
import { createReadingResets, useReadingGeneration } from '../content/readingResets'
import { ContentRegistryContext } from '../tabs/contentRegistry'
import type { ThreadOpen } from '../tabs/tabsState'
import { decideStart, markAllInChunks, savedStart, type ReaderStart } from './readingStart'
import { ThreadReader } from './ThreadReader'
import './thread.css'

const NOTHING_READ: ReadonlySet<PostId> = new Set()

function withRead(previous: ReadonlySet<PostId>, postIds: readonly PostId[]): ReadonlySet<PostId> {
  const next = new Set(previous)
  for (const id of postIds) next.add(id)
  return next
}

/**
 * Reading context of one thread shown in one history entry: fetches the thread's reading state,
 * decides the mode and start position once (target → snapshot of the current reading-data
 * generation → saved position → page 1 top),
 * records the visit, and owns mode changes, read records and 全部标为已读. The reader below is
 * remounted for each mode it shows.
 *
 * When the thread's reading data is cleared (history deletion with 阅读进度), readers created
 * before drop their position and read writes, and a fresh reader starts at the top.
 */
export function ThreadPane({
  entryKey,
  open,
  displayed,
  forumName,
  onBackToList,
  footer
}: {
  entryKey: number
  /** Thread, target and snapshot of the entry; read once when the pane mounts. */
  open: ThreadOpen
  displayed: boolean
  forumName: (forumId: string | null) => string | null
  onBackToList: (() => void) | null
  /** Shown below the scroller (the reply editor). */
  footer: ReactNode
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
   * Mode and start of the mounted reader. `temporaryOf` is set only while an explicit target opened
   * in a mode other than the saved preference is shown: it names that preference. Snapshots, other
   * tabs changing the preference, or a later refetch never make a display temporary. `generation`
   * is the reading-data generation the reader was created under.
   */
  const [view, setView] = useState<{ start: ReaderStart; seq: number; temporaryOf: ReadingMode | null; generation: number } | null>(null)
  const [readNow, setReadNow] = useState<ReadonlySet<PostId>>(NOTHING_READ)
  const [notice, setNotice] = useState<string | null>(null)
  const [markAllBusy, setMarkAllBusy] = useState(false)

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
        const start = decideStart(openRef.current, state, at)
        const target = openRef.current.target
        const preference = state?.mode ?? 'all'
        setView({ start, seq: 0, temporaryOf: target !== null && target.mode !== preference ? preference : null, generation: at })
      })
    return () => {
      cancelled = true
      mounted.current = false
    }
  }, [threadId, resets])

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

  // Reading data cleared under this reader: forget what it marked and start a fresh reader at the
  // top of the mode it shows. The old reader's late writes are dropped by `writable`.
  const viewGeneration = view?.generation
  useEffect(() => {
    if (viewGeneration === undefined || viewGeneration === generation) return
    let cancelled = false
    setReadNow(NOTHING_READ)
    void refetch().then(() => {
      if (cancelled) return
      setNotice('这个串的阅读进度与已读记录已清除，已回到开头')
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

  const onRead = useCallback(
    (at: number, postIds: PostId[]) => {
      if (!resets.writable(threadId, at)) return
      setReadNow((previous) => withRead(previous, postIds))
      window.xidao.readingState
        .markRead({ threadId, postIds })
        .then(
          (result) => {
            if (!result.saved && mounted.current) setNotice('已读记录未能保存到本地')
          },
          () => {
            if (mounted.current) setNotice('已读记录未能保存到本地')
          }
        )
        .finally(() => void refetch())
    },
    [threadId, refetch, resets]
  )

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
      if (!result.saved && mounted.current) setNotice('阅读模式偏好未能保存到本地')
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
      if (!result.saved && mounted.current) setNotice('阅读模式偏好未能保存到本地')
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

  /** Marks exactly the confirmed unread posts of the latest reading state, in bounded chunks. */
  const markAllRead = async () => {
    const postIds = readingState?.unread.map((post) => post.postId) ?? []
    if (postIds.length === 0 || markAllBusy || view === null || !resets.writable(threadId, view.generation)) return
    const at = view.generation
    setMarkAllBusy(true)
    setNotice(null)
    const { failed, stopped } = await markAllInChunks(
      postIds,
      () => resets.writable(threadId, at),
      async (chunk) => (await window.xidao.readingState.markRead({ threadId, postIds: chunk })).saved
    )
    if (!mounted.current) return
    if (!failed && !stopped) setReadNow((previous) => withRead(previous, postIds))
    await refetch()
    if (!mounted.current) return
    setMarkAllBusy(false)
    // After a reset the fresh reader explains itself; only a still-current batch reports the gap.
    if ((failed || stopped) && resets.generation(threadId) === at) setNotice('部分已读记录未能保存到本地')
  }

  // The editor appears with the reader: mounting it here too would remount it (and drop its
  // focus) a moment later when the reader replaces this placeholder.
  if (view === null) {
    return (
      <section className="reader" aria-label={`串 No.${threadId}`}>
        <div className="reader-scroll">
          <div className="reader-column">
            <Loading>正在读取阅读记录…</Loading>
          </div>
        </div>
      </section>
    )
  }

  return (
    <ThreadReader
      key={`${view.start.mode}:${view.seq}`}
      entryKey={entryKey}
      threadId={threadId}
      mode={view.start.mode}
      temporaryOf={view.temporaryOf}
      generation={view.generation}
      start={view.start.position}
      initialHead={open.head}
      displayed={displayed}
      readingState={readingState}
      readNow={readNow}
      notice={notice}
      markAllBusy={markAllBusy}
      forumName={forumName}
      onChooseMode={(mode) => void chooseMode(mode)}
      onRead={(postIds) => onRead(view.generation, postIds)}
      onSavePosition={(mode, anchor) => onSavePosition(view.generation, mode, anchor)}
      onObserved={onObserved}
      onMarkAllRead={() => void markAllRead()}
      onBackToList={onBackToList}
      footer={footer}
    />
  )
}
