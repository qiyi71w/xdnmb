import { useEffect, useRef, useState } from 'react'
import { targetText } from '../../../../shared/drafts'
import { sendFailureTitle, type SendFailureNotice } from '../../../../shared/publication'
import { BottomNotice } from '../../components/BottomNotice'

interface Shown {
  notice: SendFailureNotice
  opening: boolean
  /** Why 打开草稿 did not open it; null when it has not failed. */
  failure: string | null
}

/**
 * In-app notices of explicit send failures, one per attempt, each closed on its own: 打开草稿 opens
 * (or focuses) the automatically saved draft, 知道了 just closes it. The main process sends them
 * while the window is in front, or when it is shown after a system notification could not show.
 * A notice sent at the failure itself (`missed` false) is dropped for good when the editor that
 * sent it is on screen: that editor already shows the failure and holds the draft. A notice owed
 * for a system notification that did not show always appears. A clicked system notification opens
 * the draft directly and closes its in-app notice if there is one, or, when the draft cannot be
 * opened, shows the notice with the reason.
 */
export function SendFailureNotices({
  forumName,
  shownInEditor,
  openDraft,
  fallbackFocus
}: {
  forumName: (forumId: string | null) => string | null
  /** The editor that sent it is expanded and on screen now. */
  shownInEditor: (notice: SendFailureNotice) => boolean
  /** Opens or focuses the failure's draft; resolves to why it could not, or null when it did. */
  openDraft: (notice: SendFailureNotice) => Promise<string | null>
  fallbackFocus: () => HTMLElement | null
}) {
  const [shown, setShown] = useState<readonly Shown[]>([])

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const close = (attemptId: string) => setShown((list) => list.filter((item) => item.notice.attemptId !== attemptId))
  const update = (attemptId: string, patch: Partial<Shown>) =>
    setShown((list) => list.map((item) => (item.notice.attemptId === attemptId ? { ...item, ...patch } : item)))

  const openRef = useRef(openDraft)
  const shownInEditorRef = useRef(shownInEditor)
  useEffect(() => {
    openRef.current = openDraft
    shownInEditorRef.current = shownInEditor
  })

  /** Adds the notice, or updates the one already shown for its attempt. */
  const show = (notice: SendFailureNotice, failure: string | null) =>
    setShown((list) =>
      list.some((item) => item.notice.attemptId === notice.attemptId)
        ? list.map((item) => (item.notice.attemptId === notice.attemptId ? { ...item, opening: false, failure } : item))
        : [...list, { notice, opening: false, failure }]
    )

  useEffect(
    () =>
      window.xidao.publication.onFailureNotice((notice, missed) => {
        if (missed || !shownInEditorRef.current(notice)) show(notice, null)
      }),
    []
  )

  // A clicked system notification: open the draft; when that fails, say why in the app.
  useEffect(
    () =>
      window.xidao.publication.onOpenDraft((notice) => {
        close(notice.attemptId)
        void openRef.current(notice).then((failure) => {
          if (failure !== null && alive.current) show(notice, failure)
        })
      }),
    []
  )

  const open = async (notice: SendFailureNotice) => {
    update(notice.attemptId, { opening: true, failure: null })
    const failure = await openRef.current(notice)
    if (!alive.current) return
    if (failure === null) close(notice.attemptId)
    else update(notice.attemptId, { opening: false, failure })
  }

  return shown.map(({ notice, opening, failure }) => (
    <BottomNotice
      key={notice.attemptId}
      open
      note={notice.forumMessage === undefined ? null : `论坛提示：${notice.forumMessage}`}
      context={targetText(notice.target, forumName)}
      detail={failure}
      actions={[
        { label: '打开草稿', busy: opening, leaves: true, onAction: () => void open(notice) },
        { label: '知道了', onAction: () => close(notice.attemptId) }
      ]}
      fallbackFocus={fallbackFocus}
    >
      {sendFailureTitle(notice.problem)}，内容已存为草稿
    </BottomNotice>
  ))
}
