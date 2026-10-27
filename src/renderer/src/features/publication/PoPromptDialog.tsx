import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { CredentialId } from '../../../../shared/identity'
import type { PoAnswer, PoPrompt } from '../../../../shared/publication'
import { CookieId } from '../../components/CookieId'
import { Modal } from '../../components/Modal'
import './publication.css'

/**
 * 发送前身份提示 for one's own thread: the main process holds the frozen payload behind `prompt`.
 * The cookies to choose from are a radio group (the current cookie, then every imported cookie with
 * the main post's 饼干 ID); 发送 sends with the selected one, 取消 or Esc sends nothing. Focus starts
 * on the selected cookie, arrow keys move it, Enter sends. “本次启动不再提示” only counts with a
 * send; cancelling changes neither the identity nor the suppression.
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
  const name = useId()
  const [suppress, setSuppress] = useState(false)
  const [selected, setSelected] = useState<CredentialId>(prompt.initial)
  const groupRef = useRef<HTMLDivElement>(null)

  // Start on the selected cookie (Modal focused its first control).
  useLayoutEffect(() => {
    groupRef.current?.querySelector<HTMLInputElement>('input:checked')?.focus()
  }, [])

  const send = () => {
    if (resolving) return
    const chosen = prompt.candidates.find((candidate) => candidate.credentialId === selected)
    if (chosen === undefined || chosen.unavailable !== null) return
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
          发送到自己的串：当前饼干不是 PO 饼干
        </h2>
      </header>
      <div className="modal-body po-body">
        <p className="po-intro">{target}，用哪块饼干发送？</p>
        <div className="po-choices" role="radiogroup" aria-labelledby={titleId} ref={groupRef} onKeyDown={onGroupKeyDown}>
          {prompt.candidates.map((candidate) => {
            const unavailable = candidate.unavailable !== null
            return (
              <label key={candidate.credentialId} className={`po-choice${unavailable ? ' is-unavailable' : ''}`}>
                <input
                  type="radio"
                  name={name}
                  value={candidate.credentialId}
                  checked={selected === candidate.credentialId}
                  disabled={unavailable}
                  onChange={() => {
                    if (!resolving) setSelected(candidate.credentialId)
                  }}
                />
                <span className="po-choice-text">
                  <span className="po-choice-name">{candidate.name}</span>
                  {candidate.cookieId !== null && <CookieId cookieId={candidate.cookieId} />}
                  <span className="po-choice-role">{candidate.role === 'current' ? '当前饼干' : 'PO 饼干'}</span>
                  {unavailable && <span className="po-choice-reason">无法读取这块饼干，不能使用</span>}
                </span>
              </label>
            )
          })}
        </div>
      </div>
      <div className="modal-actions po-actions">
        <label className="po-suppress">
          <input type="checkbox" checked={suppress} disabled={resolving} onChange={(event) => setSuppress(event.target.checked)} />
          <span>本次启动不再提示</span>
        </label>
        <div className="po-buttons">
          <button type="button" className="btn" aria-disabled={resolving || undefined} onClick={cancel}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            aria-disabled={resolving || undefined}
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
