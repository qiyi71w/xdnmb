import type { ThreadSummary } from '../../../../shared/forum'
import { Content } from '../../components/Content'
import { Icon } from '../../components/Icon'
import { meaningfulName, meaningfulTitle } from '../../lib/format'
import type { ImageScope } from '../image/imageView'
import { RowThumbnail } from '../image/RowThumbnail'
import { UncertainTag } from '../search/FilterFields'

/**
 * One thread of a list, in the shared row order: the head post's cookie ID (with tags) and time,
 * then its title and its name in bold (each only when it has a real one), its excerpt and the
 * thread's meta line. An image thread shows the head post's thumbnail on the right in a fixed box.
 */
export function ThreadRow({
  thread,
  forumName,
  selected,
  uncertain = false,
  images,
  onOpen,
  itemProps
}: {
  thread: ThreadSummary
  /** Shown for timeline rows, which mix forums. */
  forumName: string | null
  selected: boolean
  /** Kept by the list filters only because a field they judge by is unknown. */
  uncertain?: boolean
  /** Where the list's thumbnails load. */
  images: ImageScope
  onOpen: () => void
  itemProps: { 'data-roving-item': string; tabIndex: number; onFocus: () => void }
}) {
  const { head } = thread
  const title = meaningfulTitle(head.title)
  const name = meaningfulName(head.name)
  const hasImage = head.image !== null
  const classes = ['thread-row', hasImage && 'has-thumb', selected && 'is-selected'].filter(Boolean).join(' ')
  return (
    <button type="button" className={classes} aria-current={selected ? 'true' : undefined} onClick={onOpen} {...itemProps}>
      <span className="row-text">
        <span className="row-byline">
          <span className="row-author">
            {head.userHash !== null && <span className={head.isAdmin === true ? 'user-hash is-admin' : 'user-hash'}>{head.userHash}</span>}
            {head.isSage === true && <span className="tag tag-sage">SAGE</span>}
          </span>
          {head.createdAt !== null && <span className="row-time">{head.createdAt}</span>}
        </span>
        {title !== null && <span className="row-title">{title}</span>}
        {name !== null && <span className="row-name">{name}</span>}
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
          {/* The thumbnail is decorative; this names the image for assistive technology. */}
          {hasImage && <span className="visually-hidden">附图</span>}
          {uncertain && <UncertainTag />}
        </span>
      </span>
      {hasImage && <RowThumbnail postId={head.id} scope={images} />}
    </button>
  )
}
