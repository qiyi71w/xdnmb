import { targetText, type SavedDraft } from '../../../../shared/drafts'
import { BottomNotice } from '../../components/BottomNotice'
import { SAVE_FAILURE_TEXT } from '../editor/editorText'
import { useEditorWorkspace } from '../editor/workspace'

/**
 * One bottom notice per draft deleted on request (from its editor or the library): 撤销 saves the
 * deleted content (with its image) as a draft again and, when the deletion emptied or closed an
 * editor, continues it there; 知道了 closes the notice, after which it can no longer be undone and
 * its image copy is reclaimed.
 */
export function DraftDeletedNotices({
  reopen,
  fallbackFocus
}: {
  /** Continues a restored draft whose deletion emptied or closed its editor. */
  reopen: (draft: SavedDraft) => void
  fallbackFocus: () => HTMLElement | null
}) {
  const { store, forumName } = useEditorWorkspace()
  return store.deleted.map((entry) => (
    <BottomNotice
      key={entry.key}
      open
      context={targetText(entry.content.target, forumName)}
      detail={entry.failure === null ? null : `没能撤销：${SAVE_FAILURE_TEXT[entry.failure]}`}
      actions={[
        {
          label: '撤销',
          busy: entry.restoring,
          onAction: () => {
            void store.undoDelete(entry.key).then((restored) => {
              if (restored?.reopen === true) reopen(restored.draft)
            })
          }
        },
        { label: '知道了', busy: entry.restoring, onAction: () => store.forgetDeleted(entry.key) }
      ]}
      fallbackFocus={fallbackFocus}
    >
      草稿已删除
    </BottomNotice>
  ))
}
