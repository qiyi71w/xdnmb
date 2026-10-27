import { useId } from 'react'
import { targetText, type EditorId } from '../../../../shared/drafts'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { excerpt, SAVE_FAILURE_TEXT } from './editorText'
import type { SaveFailure } from './useEditorsStore'
import { useEditorWorkspace } from './workspace'
import './editor.css'

/**
 * Asked only when something is about to go away (a tab, or every tab on 退出汐岛) and saving its
 * editors' drafts right then failed: 仍{verb} goes on and loses what could not be saved, the other
 * button changes nothing (the editors stay, and saving is tried again on their next change).
 */
export function DraftSaveFailedDialog({
  label,
  verb,
  cancelLabel,
  failures,
  onConfirm,
  onCancel
}: {
  /** Accessible name and title of the dialog, e.g. “关闭标签”. */
  label: string
  /** What happens afterwards, e.g. “关闭”. */
  verb: string
  cancelLabel: string
  /** The editors whose draft could not be saved, with why. */
  failures: ReadonlyMap<EditorId, SaveFailure>
  onConfirm: () => void
  onCancel: () => void
}) {
  const { store, forumName } = useEditorWorkspace()
  const titleId = useId()
  const listed = store.state.editors.filter((editor) => failures.has(editor.id))

  return (
    <Modal className="unsaved-dialog" labelledBy={titleId} onClose={onCancel}>
      <header className="modal-header">
        <h2 className="modal-title" id={titleId}>
          {label}
        </h2>
      </header>
      <div className="modal-body">
        <p className="notice-inline is-warning" role="alert">
          <Icon name="alert" size={14} />
          草稿没能保存，{verb}后这些内容会丢失
        </p>
        <ul className="unsaved-list" aria-labelledby={titleId}>
          {listed.map((editor) => (
            <li key={editor.id} className="unsaved-item">
              <p className="unsaved-target">{targetText(editor.target, forumName)}</p>
              <p className="unsaved-excerpt">{excerpt(editor.fields, editor.attachment)}</p>
              <p className="unsaved-kind">{SAVE_FAILURE_TEXT[failures.get(editor.id)!]}</p>
            </li>
          ))}
        </ul>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="button" className="btn btn-danger" onClick={onConfirm}>
          仍{verb}
        </button>
      </div>
    </Modal>
  )
}
