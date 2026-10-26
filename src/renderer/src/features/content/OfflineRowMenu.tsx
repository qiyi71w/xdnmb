import type { Post, ThreadId } from '../../../../shared/forum'
import { ContextMenu, type ContextMenuItem, type ContextMenuPoint } from '../../components/ContextMenu'
import { useOpenThreadInTab } from '../tabs/openThreadInTab'

/**
 * Context menu of one 离线 row: 在新标签页打开, 更新离线副本 (the 离线副本 dialog's update, started
 * at once; unavailable while the copy is saving or the start is on its way) and 离线详情…, which
 * opens that dialog.
 */
export function OfflineRowMenu({
  point,
  threadId,
  head,
  label,
  updateBlocked,
  onUpdate,
  onDetails,
  onClose
}: {
  point: ContextMenuPoint
  threadId: ThreadId
  /** Main post held here, shown in the new tab until page 1 arrives; null when not held. */
  head: Post | null
  /** Thread title or `No.x`. */
  label: string
  /** Why 更新离线副本 cannot start now; null when it can. */
  updateBlocked: string | null
  onUpdate: () => void
  onDetails: () => void
  onClose: (returnFocus: boolean) => void
}) {
  const openInTab = useOpenThreadInTab()
  const items: ContextMenuItem[] = [
    ...(openInTab === null
      ? []
      : [
          { type: 'action', key: 'open-tab', label: '在新标签页打开', onSelect: () => openInTab(threadId, head) } satisfies ContextMenuItem,
          { type: 'separator', key: 'open-separator' } satisfies ContextMenuItem
        ]),
    {
      type: 'action',
      key: 'update',
      label: '更新离线副本',
      disabled: updateBlocked !== null,
      title: updateBlocked ?? undefined,
      onSelect: onUpdate
    },
    { type: 'action', key: 'details', label: '离线详情…', onSelect: onDetails }
  ]
  return <ContextMenu point={point} label={`离线副本操作：${label}`} items={items} onClose={onClose} />
}
