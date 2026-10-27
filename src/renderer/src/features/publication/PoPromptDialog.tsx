import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { CredentialId } from '../../../../shared/identity'
import type { PoAnswer, PoCandidate, PoPrompt } from '../../../../shared/publication'
import { CookieId } from '../../components/CookieId'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import './publication.css'

/** Why a candidate cannot be chosen, shown inside its item. */
const UNAVAILABLE_TEXT: Record<NonNullable<PoCandidate['unavailable']>, string> = {
  unreadable: '无法读取这块饼干，不能使用'
}

/**
 * 发送前身份提示 for one's own thread: the main process holds the frozen payload behind `prompt`.
 * The cookies to choose from are a radio group (the current cookie, then every imported cookie with
 * the main post's 饼干 ID); 发送 sends with the selected one, 取消 or Esc sends nothing. Focus starts
 * on the selected cookie, arrow keys move it, Enter sends. “本次启动不再提示” only counts with a
 * send; cancelling changes neither the identity nor the suppression. While the answer is being
 * handled every control keeps its focus and presses are ignored.
 */
export function PoPromptDialog({
  prompt,
  target,
  resolving,
  onAnswer
}: {
  prompt: PoPrompt
  /** Where the post goes, e.g. “回复 No.123”. */
  target: string
  resolving: boolean
  onAnswer: (answer: PoAnswer) => void
}) {
  const titleId = useId()
  const introId = useId()
  const name = useId()
  const [suppress, setSuppress] = useState(false)
  const [selected, setSelected] = useState<CredentialId>(prompt.initial)
  const groupRef = useRef<HTMLDivElement>(null)

  // Start on the selected cookie (Modal focused its first control).
  useLayoutEffect(() => {
    groupRef.current?.querySelector<HTMLInputElement>('input:checked')?.focus()
  }, [])

  const chosen = prompt.candidates.find((candidate) => candidate.credentialId === selected)
  const usable = chosen !== undefined && chosen.unavailable === null
  const send = () => {
    if (resolving || chosen === undefined || chosen.unavailable !== null) return
    onAnswer({ kind: 'send', credentialId: chosen.credentialId, suppress })
  }
  const cancel = () => {
    if (!resolving) onAnswer({ kind: 'cancel' })
  }

  const onGroupKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement) || event.target.type !== 'radio') return
    event.preventDefault()
    send()
  }

  return (
    <Modal className="po-dialog" labelledBy={titleId} onClose={cancel}>
      <header className="modal-header">
        <h2 className="modal-title" id={titleId}>
          用哪块饼干发送？
        </h2>
      </header>
      <div className="modal-body po-body">
        <p className="po-intro" id={introId}>
          {target}：这是你的串，当前饼干不是 PO 饼干。
        </p>
        <div
          className="po-choices"
          role="radiogroup"
          aria-labelledby={titleId}
          aria-describedby={introId}
          ref={groupRef}
          onKeyDown={onGroupKeyDown}
        >
          {prompt.candidates.map((candidate, index) => {
            const checked = selected === candidate.credentialId
            const reasonId = `${name}-reason-${index}`
            return (
              <label
                key={candidate.credentialId}
                className={`po-choice${checked ? ' is-selected' : ''}${candidate.unavailable !== null ? ' is-unavailable' : ''}`}
              >
                <input
                  type="radio"
                  name={name}
                  value={candidate.credentialId}
                  checked={checked}
                  disabled={candidate.unavailable !== null}
                  aria-describedby={candidate.unavailable !== null ? reasonId : undefined}
                  onChange={() => {
                    if (!resolving) setSelected(candidate.credentialId)
                  }}
                />
                <span className="po-choice-who">
                  <span className="po-choice-name">{candidate.name}</span>
                  {candidate.cookieId !== null && <CookieId cookieId={candidate.cookieId} />}
                </span>
                {candidate.role === 'current' ? (
                  <span className="po-choice-role">当前饼干</span>
                ) : (
                  <span className="po-choice-role tag tag-po">PO</span>
                )}
                {candidate.unavailable !== null && (
                  <span className="po-choice-reason" id={reasonId}>
                    <Icon name="alert" size={13} />
                    {UNAVAILABLE_TEXT[candidate.unavailable]}
                  </span>
                )}
              </label>
            )
          })}
        </div>
      </div>
      <div className="modal-actions po-actions">
        <label className="po-suppress">
          <input
            type="checkbox"
            checked={suppress}
            aria-disabled={resolving || undefined}
            onChange={(event) => {
              if (!resolving) setSuppress(event.target.checked)
            }}
          />
          <span>本次启动不再提示</span>
        </label>
        <div className="po-buttons">
          <button type="button" className="btn" aria-disabled={resolving || undefined} onClick={cancel}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            aria-disabled={resolving || !usable || undefined}
            aria-busy={resolving || undefined}
            onClick={send}
          >
            发送
          </button>
        </div>
      </div>
    </Modal>
  )
}
