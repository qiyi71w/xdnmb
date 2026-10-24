import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { PoPrompt } from '../../../../shared/publication'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import type { PromptChoice } from '../editor/useEditorsStore'
import './publication.css'

/**
 * 发送前身份提示 for one's own thread: the main process holds the frozen payload behind `prompt`.
 * 切回 PO 饼干并发送 / 仍用当前饼干发送 / 取消; Esc is 取消. “本次启动不再提示” only counts with a
 * send choice; cancelling changes neither the identity nor the suppression and sends nothing.
 */
export function PoPromptDialog({
  prompt,
  target,
  resolving,
  onChoose
}: {
  prompt: PoPrompt
  /** Where the post goes, e.g. “回复 No.123”. */
  target: string
  resolving: boolean
  onChoose: (choice: PromptChoice, suppress: boolean) => void
}) {
  const titleId = useId()
  const switchHelpId = useId()
  const [suppress, setSuppress] = useState(false)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const currentRef = useRef<HTMLButtonElement>(null)

  // Start on the switch when it is possible, else on 仍用当前 (Modal focused its first control).
  useLayoutEffect(() => {
    const first = prompt.canSwitch ? primaryRef.current : currentRef.current
    first?.focus()
  }, [prompt.canSwitch])

  const choose = (choice: PromptChoice) => {
    if (resolving) return
    if (choice === 'switch' && !prompt.canSwitch) return
    onChoose(choice, choice === 'cancel' ? false : suppress)
  }

  return (
    <Modal className="po-dialog" labelledBy={titleId} onClose={() => choose('cancel')}>
      <header className="modal-header">
        <h2 className="modal-title" id={titleId}>
          发送到自己的串：饼干与开串时不同
        </h2>
      </header>
      <div className="modal-body po-body">
        <p className="po-intro">{target}。这个串是你用另一块饼干开的，确认这次用哪块饼干发送。</p>
        <dl className="po-names">
          <div className="po-name">
            <dt>当前饼干</dt>
            <dd>{prompt.currentName}</dd>
          </div>
          <div className="po-name is-po">
            <dt>PO 饼干（开串时）</dt>
            <dd>{prompt.poName}</dd>
          </div>
        </dl>
        {!prompt.canSwitch && (
          <p className="notice-inline is-warning" id={switchHelpId}>
            <Icon name="alert" size={14} />
            PO 饼干当前不可用（已移除或无法读取），不能切回。
          </p>
        )}
        <p className="po-note">正文、目标和附图已固定，选择之前不会发送。切回会同时更新这次编辑和该串记住的饼干。</p>
      </div>
      <div className="modal-actions po-actions">
        <label className="po-suppress">
          <input type="checkbox" checked={suppress} disabled={resolving} onChange={(event) => setSuppress(event.target.checked)} />
          <span>
            本次启动不再提示
            <span className="po-suppress-help">选择发送后生效，对所有串有效；可在设置中长期关闭</span>
          </span>
        </label>
        <div className="po-buttons">
          <button type="button" className="btn" aria-disabled={resolving || undefined} onClick={() => choose('cancel')}>
            取消
          </button>
          <button
            ref={currentRef}
            type="button"
            className="btn"
            aria-disabled={resolving || undefined}
            aria-busy={resolving || undefined}
            onClick={() => choose('current')}
          >
            仍用当前饼干发送
          </button>
          <button
            ref={primaryRef}
            type="button"
            className="btn btn-primary"
            disabled={!prompt.canSwitch}
            aria-describedby={prompt.canSwitch ? undefined : switchHelpId}
            aria-disabled={resolving || undefined}
            aria-busy={resolving || undefined}
            onClick={() => choose('switch')}
          >
            切回 PO 饼干并发送
          </button>
        </div>
      </div>
    </Modal>
  )
}
