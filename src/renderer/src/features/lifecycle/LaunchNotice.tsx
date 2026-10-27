import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { targetText } from '../../../../shared/drafts'
import type { PublicationAttempt } from '../../../../shared/publication'
import { Icon } from '../../components/Icon'
import { useEditorWorkspace } from '../editor/workspace'
import { ATTEMPT_STATE_LABEL } from '../publication/publicationText'
import './lifecycle.css'

/** How often the notice is read again while one of its sends is still being checked (local query). */
const READ_MS = 2000

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
 * the last quit) or that were found unfinished at startup. Non-blocking. While one is still being
 * checked the list is read again: a send found by the check leaves it, and the notice goes away once
 * nothing is left. 打开草稿 (when a listed failure saved its content) and 知道了 both dismiss exactly
 * the attempts shown. A failed dismissal only hides it for this run. Focus inside the notice moves to
 * `fallbackFocus` before it goes away.
 */
export function LaunchNotice({
  onOpenDrafts,
  fallbackFocus
}: {
  onOpenDrafts: () => void
  fallbackFocus: () => HTMLElement | null
}) {
  const { forumName } = useEditorWorkspace()
  const titleId = useId()
  const sectionRef = useRef<HTMLElement>(null)
  const [attempts, setAttempts] = useState<PublicationAttempt[]>([])
  /** Dismissed this run: later reads no longer bring it back. */
  const dismissed = useRef(false)
  const fallback = useRef(fallbackFocus)
  useEffect(() => {
    fallback.current = fallbackFocus
  })

  /** Reads the notice; `alive` says whether its result still applies. */
  const read = useCallback((alive: () => boolean) => {
    window.xidao.lifecycle
      .listLaunchNotices()
      .then((result) => {
        if (!alive() || !result.ok || dismissed.current) return
        if (result.attempts.length === 0 && sectionRef.current?.contains(document.activeElement) === true) fallback.current()?.focus()
        setAttempts(result.attempts)
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

  // While a listed send is still being checked, read again: its result changes or removes it.
  const checking = attempts.some((attempt) => attempt.state === 'unknown')
  useEffect(() => {
    if (!checking) return
    let alive = true
    const timer = window.setInterval(() => read(() => alive), READ_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [checking, read])

  if (attempts.length === 0) return null

  const dismiss = () => {
    const attemptIds = attempts.map((attempt) => attempt.id)
    dismissed.current = true
    if (sectionRef.current?.contains(document.activeElement) === true) fallbackFocus()?.focus()
    setAttempts([])
    window.xidao.lifecycle.dismissLaunchNotices({ attemptIds }).catch(() => undefined)
  }
  const drafted = attempts.some((attempt) => attempt.state === 'failed' && attempt.savedDraftId !== null)

  return (
    <section className="launch-notice" ref={sectionRef} aria-labelledby={titleId}>
      <Icon name="alert" />
      <div className="launch-notice-text">
        <h2 className="launch-notice-title" id={titleId}>
          上次退出时有 {attempts.length} 个发送没有完成
        </h2>
        <ul className="launch-notice-list">
          {attempts.map((attempt) => (
            <li key={attempt.id} className="launch-notice-item">
              <span className="launch-notice-target">{targetText(attempt.payload.target, forumName)}</span>
              <span className="launch-notice-state">{stateText(attempt)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="launch-notice-actions">
        {drafted && (
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              dismiss()
              onOpenDrafts()
            }}
          >
            <Icon name="draft" size={14} />
            打开草稿
          </button>
        )}
        <button type="button" className="btn btn-small" onClick={dismiss}>
          知道了
        </button>
      </div>
    </section>
  )
}
