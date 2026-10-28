import { useState } from 'react'
import { targetText, type PostTarget } from '../../../../shared/drafts'
import { BottomNotice } from '../../components/BottomNotice'
import { SAVE_FAILURE_TEXT } from '../editor/editorText'
import type { UndoneDeletion } from '../editor/useEditorsStore'
import { useEditorWorkspace } from '../editor/workspace'

/** Why the editor a deletion emptied did not take the restored draft back. */
const REFUSED_TEXT: Record<NonNullable<UndoneDeletion['refused']>, string> = {
  locked: '编辑框正在发送，草稿留在草稿列表',
  occupied: '编辑框里已有新内容，草稿留在草稿列表'
}

/** An undone deletion whose editor could not take the draft back: it is in 草稿 only. */
interface NotTakenBack {
  key: string
  target: PostTarget
  reason: string
}

/**
 * One bottom notice per draft deleted on request (from its editor or the library): 撤销 saves the
 * deleted content (with its image) as a draft again, back in 草稿 (an open 草稿 dialog lists it at
 * once); deleted from an editor that is still open, it goes back into that editor too. Nothing
 * opens and nothing moves. 知道了 closes the notice, after which it can no longer be undone and its
 * image copy is reclaimed. When that editor could not take it back (sending, or holding something
 * new), one more notice says so and leads to 草稿.
 */
export function DraftDeletedNotices({
  onOpenDrafts,
  fallbackFocus
}: {
  onOpenDrafts: () => void
  fallbackFocus: () => HTMLElement | null
}) {
  const { store, forumName } = useEditorWorkspace()
  const [notTakenBack, setNotTakenBack] = useState<readonly NotTakenBack[]>([])
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
                void store.undoDelete(entry.key).then((restored) => {
                  const refused = restored?.refused ?? null
                  if (restored === null || refused === null) return
                  setNotTakenBack((previous) => [...previous, { key: entry.key, target: restored.draft.target, reason: REFUSED_TEXT[refused] }])
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
      {notTakenBack.map((item) => {
        const dismiss = () => setNotTakenBack((previous) => previous.filter((other) => other.key !== item.key))
        return (
          <BottomNotice
            key={`not-taken-back-${item.key}`}
            open
            icon="alert"
            tone="warning"
            context={targetText(item.target, forumName)}
            detail={item.reason}
            actions={[
              {
                label: '查看草稿',
                leaves: true,
                onAction: () => {
                  dismiss()
                  onOpenDrafts()
                }
              },
              { label: '知道了', onAction: dismiss }
            ]}
            fallbackFocus={fallbackFocus}
          >
            草稿已恢复
          </BottomNotice>
        )
      })}
    </>
  )
}
