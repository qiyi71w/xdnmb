import type { ReactNode } from 'react'
import type { ThreadId, ThreadSummary } from '../../../../shared/forum'
import { Content } from '../../components/Content'
import { Icon } from '../../components/Icon'
import { meaningfulName, meaningfulTitle } from '../../lib/format'
import { formatForumTime } from '../../lib/time'
import type { ImageScope } from '../image/imageView'
import { RowThumbnail } from '../image/RowThumbnail'
import { UncertainTag } from '../search/FilterFields'
import { useThreadTabMenu } from '../tabs/ThreadTabMenu'

/**
 * A listed thread whose main post is not held on this machine: only its number and what the list
 * itself keeps. Nothing else is shown or fetched; unknown stays unknown.
 */
export interface HeadlessThread {
  head: null
  id: ThreadId
  /** Last title kept for the thread, if any. */
  title: string | null
  replyCount: number | null
}

/**
 * One thread of a list, in the shared row order: the head post's cookie ID (with tags) and time,
 * then its title and its name in bold (each only when it has a real one), its excerpt and the
 * thread's meta line. An image thread shows the head post's thumbnail on the right in a fixed box.
 * A headless thread shows its title (when kept) and its meta line only.
 * With `tabMenu`, the row offers 在新标签页打开 (context menu, middle-click, Ctrl/Cmd+click).
 */
export function ThreadRow({
  thread,
  forumName,
  selected,
  uncertain = false,
  images,
  onOpen,
  itemProps,
  tabMenu = false,
  metaEnd
}: {
  thread: Pick<ThreadSummary, 'head' | 'replyCount'> | HeadlessThread
  /** Shown for timeline rows, which mix forums. */
  forumName: string | null
  selected: boolean
  /** Kept by the list filters only because a field they judge by is unknown. */
  uncertain?: boolean
  /** Where the list's thumbnails load. */
  images: ImageScope
  onOpen: () => void
  itemProps: { 'data-roving-item': string; tabIndex: number; onFocus: () => void }
  /** Off where the list's own row menu holds the item instead (订阅). */
  tabMenu?: boolean
  /** What the list adds at the end of the meta line (non-interactive: the row is a button). */
  metaEnd?: ReactNode
}) {
  const head = thread.head
  const id = thread.head === null ? thread.id : thread.head.id
  const title = meaningfulTitle(thread.head === null ? thread.title : thread.head.title)
  const name = head === null ? null : meaningfulName(head.name)
  const hasImage = head !== null && head.image !== null
  const classes = ['thread-row', hasImage && 'has-thumb', selected && 'is-selected'].filter(Boolean).join(' ')
  const inTab = useThreadTabMenu()
  const tabThread = tabMenu ? id : null
  return (
    <>
      <button
        type="button"
        className={classes}
        aria-current={selected ? 'true' : undefined}
        onClick={(event) => {
          if (!inTab.openFromClick(event, tabThread, head)) onOpen()
        }}
        {...inTab.rowProps(tabThread, head)}
        {...itemProps}
      >
        <span className="row-text">
          {head !== null && (
            <span className="row-byline">
              <span className="row-author">
                {head.userHash !== null && <span className={head.isAdmin === true ? 'user-hash is-admin' : 'user-hash'}>{head.userHash}</span>}
                {head.isSage === true && <span className="tag tag-sage">SAGE</span>}
              </span>
              {head.createdAt !== null && <span className="row-time">{formatForumTime(head.createdAt)}</span>}
            </span>
          )}
          {title !== null && <span className="row-title">{title}</span>}
          {name !== null && <span className="row-name">{name}</span>}
          {head !== null && <Content nodes={head.content} mode="excerpt" className="row-excerpt" />}
          <span className="row-meta">
            {forumName !== null && <span className="row-forum">{forumName}</span>}
            <span className="row-no">No.{id}</span>
            {thread.replyCount !== null && (
              <span className="row-replies">
                <Icon name="reply" size={13} />
                {thread.replyCount} 回复
              </span>
            )}
            {/* The thumbnail is decorative; this names the image for assistive technology. */}
            {hasImage && <span className="visually-hidden">附图</span>}
            {uncertain && <UncertainTag />}
            {metaEnd}
          </span>
        </span>
        {hasImage && <RowThumbnail postId={id} scope={images} />}
      </button>
      {/* Outside the row: clicks in the menu's portal still bubble through React to its owner. */}
      {inTab.menu}
    </>
  )
}
