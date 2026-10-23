import type { ThreadSummary } from '../../../../shared/forum'
import { Content } from '../../components/Content'
import { Icon } from '../../components/Icon'
import { meaningfulName, meaningfulTitle } from '../../lib/format'

export function ThreadRow({
  thread,
  forumName,
  selected,
  onOpen,
  itemProps
}: {
  thread: ThreadSummary
  /** Shown for timeline rows, which mix forums. */
  forumName: string | null
  selected: boolean
  onOpen: () => void
  itemProps: { 'data-roving-item': string; tabIndex: number; onFocus: () => void }
}) {
  const { head } = thread
  const title = meaningfulTitle(head.title)
  const name = meaningfulName(head.name)
  return (
    <button
      type="button"
      className={selected ? 'thread-row is-selected' : 'thread-row'}
      aria-current={selected ? 'true' : undefined}
      onClick={onOpen}
      {...itemProps}
    >
      <span className="row-top">
        <span className="row-author">
          {head.userHash !== null && <span className="user-hash">{head.userHash}</span>}
          {name !== null && <span className="row-name">{name}</span>}
          {head.isAdmin === true && <span className="tag tag-admin">管理员</span>}
        </span>
        {head.createdAt !== null && <span className="row-time">{head.createdAt}</span>}
      </span>
      {title !== null && <span className="row-title">{title}</span>}
      <Content nodes={head.content} mode="excerpt" className="row-excerpt" />
      <span className="row-meta">
        {forumName !== null && <span className="row-forum">{forumName}</span>}
        <span className="row-no">No.{head.id}</span>
        {thread.replyCount !== null && (
          <span className="row-replies">
            <Icon name="reply" size={13} />
            {thread.replyCount} 回复
          </span>
        )}
        {head.image !== null && (
          <span className="tag tag-image">
            <Icon name="image" size={12} />
            附图
          </span>
        )}
      </span>
    </button>
  )
}
