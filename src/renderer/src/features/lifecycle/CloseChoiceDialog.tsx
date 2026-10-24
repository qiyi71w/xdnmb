import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { AppPlatform } from '../../../../shared/api'
import { Modal, ModalHeader } from '../../components/Modal'
import './lifecycle.css'

export type CloseChoice = 'background' | 'quit'

/** Where a resident window is opened again on this platform. */
function reopenPlace(platform: AppPlatform | null): string {
  if (platform === 'darwin') return 'Dock 图标'
  if (platform === null) return '系统托盘图标（macOS 为 Dock 图标）'
  return '系统托盘图标'
}

/**
 * The window's close button while 关闭窗口时 is 每次询问: 后台驻留 or 退出汐岛, with 记住我的选择 at
 * the bottom left. Esc and the close button do nothing but close this question.
 */
export function CloseChoiceDialog({
  platform,
  busy,
  onChoose,
  onDismiss
}: {
  platform: AppPlatform | null
  /** The remembered choice is being saved; the action follows. */
  busy: boolean
  onChoose: (choice: CloseChoice, remember: boolean) => void
  onDismiss: () => void
}) {
  const titleId = useId()
  const [remember, setRemember] = useState(false)
  const residentRef = useRef<HTMLButtonElement>(null)

  // Start on 后台驻留, the choice that changes nothing (Modal focused its first control).
  useLayoutEffect(() => {
    residentRef.current?.focus()
  }, [])

  const choose = (choice: CloseChoice) => {
    if (!busy) onChoose(choice, remember)
  }

  const dismiss = () => {
    if (!busy) onDismiss()
  }

  return (
    <Modal className="lifecycle-dialog" labelledBy={titleId} onClose={dismiss}>
      <ModalHeader title="关闭汐岛窗口" titleId={titleId} closeLabel="取消关闭" onClose={dismiss} closeDisabled={busy} />
      <div className="modal-body">
        <dl className="close-choices">
          <div className="close-choice">
            <dt>后台驻留</dt>
            <dd>只隐藏窗口，标签、阅读位置和未保存的编辑原样保留。之后从{reopenPlace(platform)}重新打开。</dd>
          </div>
          <div className="close-choice">
            <dt>退出汐岛</dt>
            <dd>先处理未保存的编辑并保存工作区，再真正退出。已经开始的发送只等它结束，不会重发。</dd>
          </div>
        </dl>
      </div>
      <div className="modal-actions close-choice-actions">
        <label className="close-choice-remember">
          <input type="checkbox" checked={remember} disabled={busy} onChange={(event) => setRemember(event.target.checked)} />
          <span>
            记住我的选择
            <span className="close-choice-remember-help">之后关闭窗口不再询问，可在设置中修改</span>
          </span>
        </label>
        <div className="close-choice-buttons">
          <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => choose('quit')}>
            退出汐岛
          </button>
          <button
            ref={residentRef}
            type="button"
            className="btn btn-primary"
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
            onClick={() => choose('background')}
          >
            后台驻留
          </button>
        </div>
      </div>
    </Modal>
  )
}
