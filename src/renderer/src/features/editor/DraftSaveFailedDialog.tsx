import { useId, useLayoutEffect, useRef } from 'react'
import { targetText, type EditorId } from '../../../../shared/drafts'
import { Modal } from '../../components/Modal'
import { excerpt, SAVE_FAILURE_TEXT } from './editorText'
import type { SaveFailure } from './useEditorsStore'
import { useEditorWorkspace } from './workspace'
import './editor.css'

/**
 * Asked only when something is about to go away (a tab, or every tab on 退出汐岛) and saving its
 * editors' drafts right then failed: 仍{verb} goes on and loses what could not be saved, the other
 * button changes nothing (the editors stay, and saving is tried again on their next change). Focus
 * starts on that safe button.
 */
export function DraftSaveFailedDialog({
  label,
  verb,
  cancelLabel,
  failures,
  onConfirm,
  onCancel
}: {
  /** What was asked for, e.g. “关闭标签”; says what loses the content. */
  label: string
  /** The confirming button's verb after 仍, e.g. “关闭”. */
  verb: string
  cancelLabel: string
  /** The editors whose draft could not be saved, with why. */
  failures: ReadonlyMap<EditorId, SaveFailure>
  onConfirm: () => void
  onCancel: () => void
}) {
  const { store, forumName } = useEditorWorkspace()
  const titleId = useId()
  const introId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const listed = store.state.editors.filter((editor) => failures.has(editor.id))

  // The safe choice first (Modal focused the first button, 仍{verb}).
  useLayoutEffect(() => {
    cancelRef.current?.focus()
  }, [])

  return (
    <Modal className="save-failed-dialog" labelledBy={titleId} onClose={onCancel}>
      <header className="modal-header">
        <h2 className="modal-title" id={titleId}>
          草稿没能保存
        </h2>
      </header>
      <div className="modal-body">
        <p className="save-failed-intro" id={introId}>
          {label}后，下面的内容会丢失。
        </p>
        <ul className="save-failed-list" aria-labelledby={introId}>
          {listed.map((editor) => (
            <li key={editor.id} className="save-failed-item">
              <p className="save-failed-target">{targetText(editor.target, forumName)}</p>
              <p className="save-failed-excerpt">{excerpt(editor.fields, editor.attachment)}</p>
              <p className="save-failed-reason">{SAVE_FAILURE_TEXT[failures.get(editor.id)!]}</p>
            </li>
          ))}
        </ul>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-danger" onClick={onConfirm}>
          仍{verb}
        </button>
        <button ref={cancelRef} type="button" className="btn btn-primary" onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    </Modal>
  )
}
