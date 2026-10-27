import { useCallback, useEffect, useState } from 'react'
import { targetText } from '../../../../shared/drafts'
import { sendFailureNotice, type PublicationAttempt, type SendFailureNotice } from '../../../../shared/publication'
import { BottomNotice } from '../../components/BottomNotice'
import { useEditorWorkspace } from '../editor/workspace'
import { ATTEMPT_STATE_LABEL } from '../publication/publicationText'

/** How often the notices are read again while one of their sends is still being checked (local query). */
const READ_MS = 2000

/** At most this many launch notices at once; the rest are summed up in one more. */
const SHOWN = 3

function stateText(attempt: PublicationAttempt): string {
  if (attempt.state === 'failed') {
    if (attempt.problem === 'unverified') return '可能已经发出，内容已存为草稿'
    return attempt.savedDraftId === null ? '发送失败' : '发送失败，内容已存为草稿'
  }
  if (attempt.state === 'unknown') return '正在确认是否已发出…'
  return ATTEMPT_STATE_LABEL[attempt.state]
}

/**
 * Once per launch: sends that failed or stayed unknown while no window was open (finishing after
 * the last quit) or that were found unfinished at startup, one bottom notice each, closed on its
 * own. While one is still being checked they are read again, so its notice changes in place (or
 * goes away when the send turns out sent). 打开草稿 (a failure whose content was saved) opens or
 * focuses that draft like a send failure's notice; it and 知道了 dismiss that send's notice for
 * good. Beyond the first three, one more notice says how many are left and opens 草稿.
 */
export function LaunchNotices({
  openDraft,
  onOpenDrafts,
  fallbackFocus
}: {
  /** Opens or focuses the failure's draft; resolves to why it could not, or null when it did. */
  openDraft: (notice: SendFailureNotice) => Promise<string | null>
  onOpenDrafts: () => void
  fallbackFocus: () => HTMLElement | null
}) {
  const { forumName } = useEditorWorkspace()
  const [attempts, setAttempts] = useState<readonly PublicationAttempt[]>([])
  /** Dismissed this run: later reads no longer bring them back, even if dismissing was not stored. */
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  const [opening, setOpening] = useState<ReadonlySet<string>>(() => new Set())
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(() => new Map())

  const read = useCallback((alive: () => boolean) => {
    window.xidao.lifecycle
      .listLaunchNotices()
      .then((result) => {
        if (alive() && result.ok) setAttempts(result.attempts)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    let alive = true
    read(() => alive)
    return () => {
      alive = false
    }
  }, [read])

  const visible = attempts.filter((attempt) => !dismissed.has(attempt.id))

  // While a listed send is still being checked, read again: its result changes or removes it.
  const checking = visible.some((attempt) => attempt.state === 'unknown')
  useEffect(() => {
    if (!checking) return
    let alive = true
    const timer = window.setInterval(() => read(() => alive), READ_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [checking, read])

  const dismiss = (attemptIds: string[]) => {
    setDismissed((previous) => new Set([...previous, ...attemptIds]))
    window.xidao.lifecycle.dismissLaunchNotices({ attemptIds }).catch(() => undefined)
  }

  const open = async (notice: SendFailureNotice) => {
    setOpening((previous) => new Set(previous).add(notice.attemptId))
    const failure = await openDraft(notice)
    setOpening((previous) => {
      const next = new Set(previous)
      next.delete(notice.attemptId)
      return next
    })
    if (failure === null) dismiss([notice.attemptId])
    else setFailures((previous) => new Map(previous).set(notice.attemptId, failure))
  }

  const shown = visible.slice(0, SHOWN)
  const rest = visible.slice(SHOWN)
  return (
    <>
      {shown.map((attempt) => {
        const failure = sendFailureNotice(attempt)
        const busy = opening.has(attempt.id)
        return (
          <BottomNotice
            key={attempt.id}
            open
            context={`上次退出时 · ${targetText(attempt.payload.target, forumName)}`}
            detail={failures.get(attempt.id) ?? null}
            actions={[
              ...(failure === null ? [] : [{ label: '打开草稿', busy, onAction: () => void open(failure) }]),
              { label: '知道了', busy, onAction: () => dismiss([attempt.id]) }
            ]}
            fallbackFocus={fallbackFocus}
          >
            {stateText(attempt)}
          </BottomNotice>
        )
      })}
      {rest.length > 0 && (
        <BottomNotice
          open
          actions={[
            {
              label: '打开草稿',
              onAction: () => {
                dismiss(rest.map((attempt) => attempt.id))
                onOpenDrafts()
              }
            },
            { label: '知道了', onAction: () => dismiss(rest.map((attempt) => attempt.id)) }
          ]}
          fallbackFocus={fallbackFocus}
        >
          上次退出时还有 {rest.length} 个发送没有完成
        </BottomNotice>
      )}
    </>
  )
}
