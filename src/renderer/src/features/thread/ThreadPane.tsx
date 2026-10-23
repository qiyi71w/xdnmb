import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { PostId, ReadingMode } from '../../../../shared/forum'
import type { ReadingAnchor, ThreadReadingState } from '../../../../shared/reading'
import { Loading } from '../../components/Notices'
import { ContentRegistryContext } from '../tabs/contentRegistry'
import type { ThreadOpen } from '../tabs/tabsState'
import { decideStart, markReadChunks, savedStart, type ReaderStart } from './readingStart'
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
 * decides the mode and start position once (target → snapshot → saved position → page 1 top),
 * records the visit, and owns mode changes, read records and 全部标为已读. The reader below is
 * remounted for each mode it shows.
 */
export function ThreadPane({
  entryKey,
  open,
  displayed,
  forumName,
  onBackToList
}: {
  entryKey: number
  /** Thread, target and snapshot of the entry; read once when the pane mounts. */
  open: ThreadOpen
  displayed: boolean
  forumName: (forumId: string | null) => string | null
  onBackToList: (() => void) | null
}) {
  const threadId = open.threadId
  const openRef = useRef(open)
  const mounted = useRef(true)
  const fetchSeq = useRef(0)
  const visited = useRef(false)
  const [readingState, setReadingState] = useState<ThreadReadingState | null>(null)
  /**
   * Mode and start of the mounted reader. `temporaryOf` is set only while an explicit target opened
   * in a mode other than the saved preference is shown: it names that preference. Snapshots, other
   * tabs changing the preference, or a later refetch never make a display temporary.
   */
  const [view, setView] = useState<{ start: ReaderStart; seq: number; temporaryOf: ReadingMode | null } | null>(null)
  const [readNow, setReadNow] = useState<ReadonlySet<PostId>>(NOTHING_READ)
  const [notice, setNotice] = useState<string | null>(null)
  const [markAllBusy, setMarkAllBusy] = useState(false)

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    window.xidao.readingState
      .get({ threadId })
      .catch(() => null)
      .then((state) => {
        if (cancelled) return
        setReadingState(state)
        const start = decideStart(openRef.current, state)
        const target = openRef.current.target
        const preference = state?.mode ?? 'all'
        setView({ start, seq: 0, temporaryOf: target !== null && target.mode !== preference ? preference : null })
      })
    return () => {
      cancelled = true
      mounted.current = false
    }
  }, [threadId])

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

  const onRead = useCallback(
    (postIds: PostId[]) => {
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
    [threadId, refetch]
  )

  const onSavePosition = useCallback(
    (mode: ReadingMode, anchor: ReadingAnchor) => {
      window.xidao.readingState.savePosition({ threadId, mode, anchor }).catch(() => undefined)
    },
    [threadId]
  )

  const registry = useContext(ContentRegistryContext)

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
      if (snapshot !== null && snapshot.mode === leaving) {
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
    setView((current) => ({ start: savedStart(fresh ?? readingState, next), seq: (current?.seq ?? 0) + 1, temporaryOf: null }))
  }

  /** Marks exactly the confirmed unread posts of the latest reading state, in bounded chunks. */
  const markAllRead = async () => {
    const postIds = readingState?.unread.map((post) => post.postId) ?? []
    if (postIds.length === 0 || markAllBusy) return
    setMarkAllBusy(true)
    setNotice(null)
    let failed = false
    for (const chunk of markReadChunks(postIds)) {
      try {
        const result = await window.xidao.readingState.markRead({ threadId, postIds: chunk })
        if (!result.saved) failed = true
      } catch {
        failed = true
      }
    }
    if (!mounted.current) return
    if (!failed) setReadNow((previous) => withRead(previous, postIds))
    await refetch()
    if (!mounted.current) return
    setMarkAllBusy(false)
    if (failed) setNotice('部分已读记录未能保存到本地')
  }

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
      start={view.start.position}
      initialHead={open.head}
      displayed={displayed}
      readingState={readingState}
      readNow={readNow}
      notice={notice}
      markAllBusy={markAllBusy}
      forumName={forumName}
      onChooseMode={(mode) => void chooseMode(mode)}
      onRead={onRead}
      onSavePosition={onSavePosition}
      onObserved={onObserved}
      onMarkAllRead={() => void markAllRead()}
      onBackToList={onBackToList}
    />
  )
}
