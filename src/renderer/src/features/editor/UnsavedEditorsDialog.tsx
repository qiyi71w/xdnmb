import { useId, useState } from 'react'
import type { EditorId } from '../../../../shared/drafts'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { excerpt, SAVE_FAILURE_TEXT, targetText } from './editorText'
import { isUnsaved } from './editorsState'
import type { SaveFailure } from './useEditorsStore'
import { useEditorWorkspace } from './workspace'
import './editor.css'

/**
 * Handles one group of unsaved editors before something goes away (a tab now; the whole app
 * later): 保存并{verb} saves them one by one and finishes only when every save succeeded,
 * listing what failed otherwise; 放弃并{verb} drops their unsaved content (a continued draft
 * keeps its saved version); 取消 changes nothing. Saved drafts without changes need nothing.
 */
export function UnsavedEditorsDialog({
  label,
  intro,
  verb,
  editorIds,
  onFinish,
  onCancel
}: {
  /** Accessible name and title of the dialog. */
  label: string
  intro: string
  /** What happens afterwards, e.g. “关闭”. */
  verb: string
  /** The editors to handle, fixed when the dialog opened. */
  editorIds: readonly EditorId[]
  /** Every listed editor was saved or discarded. */
  onFinish: () => void
  onCancel: () => void
}) {
  const { store, forumName } = useEditorWorkspace()
  const titleId = useId()
  const [busy, setBusy] = useState(false)
  const [failures, setFailures] = useState<ReadonlyMap<EditorId, SaveFailure>>(() => new Map())

  const pending = store.state.editors.filter((editor) => editorIds.includes(editor.id) && isUnsaved(editor))

  const saveAll = async () => {
    if (busy) return
    setBusy(true)
    const failed = new Map<EditorId, SaveFailure>()
    for (const editor of pending) {
      const outcome = await store.save(editor.id)
      if (!outcome.ok) failed.set(editor.id, outcome.reason)
    }
    setBusy(false)
    setFailures(failed)
    if (failed.size === 0) onFinish()
  }

  const discardAll = () => {
    if (busy) return
    for (const editor of pending) store.dispatch({ type: 'discard', editorId: editor.id })
    onFinish()
  }

  const cancel = () => {
    if (!busy) onCancel()
  }

  return (
    <Modal className="unsaved-dialog" label={label} onClose={cancel}>
      <header className="modal-header">
        <h2 className="modal-title" id={titleId}>
          {label}
        </h2>
      </header>
      <div className="modal-body">
        <p className="unsaved-intro">{intro}</p>
        {failures.size > 0 && (
          <p className="notice-inline is-warning" role="alert">
            <Icon name="alert" size={14} />
            {failures.size} 份未能保存，未{verb}；已保存的不再列出
          </p>
        )}
        <ul className="unsaved-list" aria-labelledby={titleId}>
          {pending.map((editor) => {
            const failure = failures.get(editor.id)
            return (
              <li key={editor.id} className="unsaved-item">
                <p className="unsaved-target">{targetText(editor.target, forumName)}</p>
                <p className="unsaved-excerpt">{excerpt(editor.fields, editor.attachment)}</p>
                <p className="unsaved-kind">
                  {editor.draft === null ? '新编辑' : '草稿的未保存修改'}
                  {editor.attachment !== null && ' · 有图'}
                </p>
                {failure !== undefined && (
                  <p className="notice-inline is-warning">
                    <Icon name="alert" size={14} />
                    {SAVE_FAILURE_TEXT[failure]}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
        {busy && (
          <p className="unsaved-progress" role="status">
            正在逐个保存…
          </p>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={cancel} disabled={busy}>
          取消
        </button>
        <button type="button" className="btn btn-danger" onClick={discardAll} disabled={busy}>
          放弃并{verb}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void saveAll()}
          aria-busy={busy || undefined}
          aria-disabled={busy || undefined}
        >
          保存并{verb}
        </button>
      </div>
    </Modal>
  )
}
