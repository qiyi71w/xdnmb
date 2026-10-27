import { useState } from 'react'
import { targetText, type PostTarget, type SavedDraft } from '../../../../shared/drafts'
import { BottomNotice } from '../../components/BottomNotice'
import { SAVE_FAILURE_TEXT } from '../editor/editorText'
import { useEditorWorkspace } from '../editor/workspace'

/** A deletion was undone but its draft could not be continued: it stays in 草稿. */
interface NotReopened {
  key: string
  target: PostTarget
  reason: string
}

/**
 * One bottom notice per draft deleted on request (from its editor or the library): 撤销 saves the
 * deleted content (with its image) as a draft again and, when the deletion emptied or closed an
 * editor, continues it there; 知道了 closes the notice, after which it can no longer be undone and
 * its image copy is reclaimed. A restored draft that could not be continued (its target's editor is
 * sending) is reported by one more notice that leads to 草稿.
 */
export function DraftDeletedNotices({
  reopen,
  onOpenDrafts,
  fallbackFocus
}: {
  /** Continues a restored draft whose deletion emptied or closed its editor; resolves to why it could not, or null. */
  reopen: (draft: SavedDraft) => Promise<string | null>
  onOpenDrafts: () => void
  fallbackFocus: () => HTMLElement | null
}) {
  const { store, forumName } = useEditorWorkspace()
  const [notReopened, setNotReopened] = useState<readonly NotReopened[]>([])
  return (
    <>
      {store.deleted.map((entry) => (
        <BottomNotice
          key={entry.key}
          open
          icon="trash"
          tone="neutral"
          context={targetText(entry.content.target, forumName)}
          detail={entry.failure === null ? null : `没能撤销：${SAVE_FAILURE_TEXT[entry.failure]}`}
          actions={[
            {
              label: '撤销',
              busy: entry.restoring,
              onAction: () => {
                void store.undoDelete(entry.key).then(async (restored) => {
                  if (restored?.reopen !== true) return
                  const reason = await reopen(restored.draft)
                  if (reason !== null) {
                    setNotReopened((previous) => [...previous, { key: entry.key, target: restored.draft.target, reason }])
                  }
                })
              }
            },
            { label: '知道了', busy: entry.restoring, onAction: () => store.forgetDeleted(entry.key) }
          ]}
          fallbackFocus={fallbackFocus}
        >
          草稿已删除
        </BottomNotice>
      ))}
      {notReopened.map((item) => (
        <BottomNotice
          key={`reopen-${item.key}`}
          open
          icon="alert"
          tone="warning"
          context={targetText(item.target, forumName)}
          detail={item.reason}
          actions={[
            {
              label: '查看草稿',
              onAction: () => {
                setNotReopened((previous) => previous.filter((other) => other.key !== item.key))
                onOpenDrafts()
              }
            },
            { label: '知道了', onAction: () => setNotReopened((previous) => previous.filter((other) => other.key !== item.key)) }
          ]}
          fallbackFocus={fallbackFocus}
        >
          草稿已恢复
        </BottomNotice>
      ))}
    </>
  )
}
