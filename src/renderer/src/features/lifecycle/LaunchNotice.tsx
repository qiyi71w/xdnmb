import { useEffect, useId, useRef, useState } from 'react'
import { targetText } from '../../../../shared/drafts'
import type { PublicationAttempt } from '../../../../shared/publication'
import { Icon } from '../../components/Icon'
import { useEditorWorkspace } from '../editor/workspace'
import { ATTEMPT_STATE_LABEL } from '../publication/publicationText'
import './lifecycle.css'

function stateText(attempt: PublicationAttempt): string {
  if (attempt.state === 'failed') return attempt.savedDraftId === null ? '发送失败' : '发送失败，内容已存为草稿'
  if (attempt.state === 'unknown') return '结果待确认'
  return ATTEMPT_STATE_LABEL[attempt.state]
}

/**
 * Once per launch: sends that failed or stayed unknown while no window was open (finishing after
 * the last quit) or that were found unfinished at startup. Non-blocking; 查看发送记录 and 知道了 both
 * dismiss exactly the attempts shown. A failed dismissal only hides it for this run. Focus inside
 * the notice moves to `fallbackFocus` before it goes away.
 */
export function LaunchNotice({
  onOpenAttempts,
  fallbackFocus
}: {
  onOpenAttempts: () => void
  fallbackFocus: () => HTMLElement | null
}) {
  const { forumName } = useEditorWorkspace()
  const titleId = useId()
  const sectionRef = useRef<HTMLElement>(null)
  const [attempts, setAttempts] = useState<PublicationAttempt[]>([])

  useEffect(() => {
    let alive = true
    window.xidao.lifecycle
      .listLaunchNotices()
      .then((result) => {
        if (alive && result.ok) setAttempts(result.attempts)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  if (attempts.length === 0) return null

  const dismiss = () => {
    const attemptIds = attempts.map((attempt) => attempt.id)
    if (sectionRef.current?.contains(document.activeElement) === true) fallbackFocus()?.focus()
    setAttempts([])
    window.xidao.lifecycle.dismissLaunchNotices({ attemptIds }).catch(() => undefined)
  }

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
        <button
          type="button"
          className="btn btn-small"
          onClick={() => {
            dismiss()
            onOpenAttempts()
          }}
        >
          <Icon name="history" size={14} />
          查看发送记录
        </button>
        <button type="button" className="btn btn-small" onClick={dismiss}>
          知道了
        </button>
      </div>
    </section>
  )
}
