import type { ReactNode } from 'react'
import type { Post, ThreadId, ThreadSummary } from '../../../../shared/forum'
import { Content, TextExcerpt } from '../../components/Content'
import { CookieId } from '../../components/CookieId'
import { Icon } from '../../components/Icon'
import { meaningfulName, meaningfulTitle } from '../../lib/format'
import { formatForumTime } from '../../lib/time'
import type { ImageView } from '../image/imageView'
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
 * The row is a container of two controls: the row button (the list's item, opening the thread,
 * clickable over the whole row) and, on image threads, the thumbnail's 查看原图 button, which opens
 * the list's image viewer. Menus, middle-click and Ctrl/Cmd+click act for the whole row.
 * With `tabMenu`, the row offers 在新标签页打开 (context menu, middle-click, Ctrl/Cmd+click), 复制串号
 * and 饼干颜色… for the head post's 饼干 ID.
 * A `pinned` row (置顶串, forum and timeline lists only) is compact: a shorter, faded excerpt and a
 * smaller thumbnail; everything else, including its behaviour, is the same as other rows.
 */
export function ThreadRow({
  thread,
  forumName,
  selected,
  uncertain = false,
  pinned = false,
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
  /** The list's 置顶串: shown compact. */
  pinned?: boolean
  /** Where the list's thumbnails load, and its image viewer. */
  images: ImageView
  onOpen: () => void
  itemProps: { 'data-roving-item': string; tabIndex: number; onFocus: () => void }
  /** Off where the list's own row menu holds the item instead (订阅). */
  tabMenu?: boolean
  /** What the list adds at the end of the meta line (non-interactive: it is inside the row button). */
  metaEnd?: ReactNode
}) {
  const head = thread.head
  const id = thread.head === null ? thread.id : thread.head.id
  const title = meaningfulTitle(thread.head === null ? thread.title : thread.head.title)
  const name = head === null ? null : meaningfulName(head.name)
  const hasImage = head !== null && head.image !== null
  const classes = ['thread-row', hasImage && 'has-thumb', pinned && 'is-pinned', selected && 'is-selected'].filter(Boolean).join(' ')
  const inTab = useThreadTabMenu({ cookieColor: true })
  const tabThread = tabMenu ? id : null
  return (
    <>
      <div
        className={classes}
        // Ctrl/Cmd+click anywhere on the row, the thumbnail included, opens the thread in a new tab.
        onClickCapture={(event) => {
          if (inTab.openFromClick(event, tabThread, head)) event.stopPropagation()
        }}
        {...inTab.rowProps(tabThread, head)}
      >
        <button type="button" className="row-open" aria-current={selected ? 'true' : undefined} onClick={onOpen} {...itemProps}>
          <span className="row-text">
            {head !== null && (
              <span className="row-byline">
                <span className="row-author">
                  {head.userHash !== null && <CookieId cookieId={head.userHash} admin={head.isAdmin === true} />}
                  {head.isSage === true && <span className="tag tag-sage">SAGE</span>}
                </span>
                {head.createdAt !== null && <span className="row-time">{formatForumTime(head.createdAt)}</span>}
              </span>
            )}
            {title !== null && <span className="row-title">{title}</span>}
            {name !== null && <span className="row-name">{name}</span>}
            {head !== null && <RowExcerpt post={head} />}
            <span className="row-meta">
              {forumName !== null && <span className="row-forum">{forumName}</span>}
              <span className="row-no">No.{id}</span>
              {thread.replyCount !== null && (
                <span className="row-replies">
                  <Icon name="reply" size={13} />
                  {thread.replyCount} 回复
                </span>
              )}
              {/* Arrow keys move between row buttons only: this tells them the thread has an image. */}
              {hasImage && <span className="visually-hidden">附图</span>}
              {uncertain && <UncertainTag />}
              {metaEnd}
            </span>
          </span>
        </button>
        {hasImage && <RowThumbnail postId={id} images={images} tabIndex={itemProps.tabIndex} />}
      </div>
      {/* Outside the row: clicks in the menu's portal still bubble through React to its owner. */}
      {inTab.menu}
    </>
  )
}

/**
 * A list row's excerpt of a held post: its content tree with the allowed formatting; a post held
 * with text but no tree (an older local record) shows that text, its line breaks kept. Nothing
 * when the post has neither.
 */
export function RowExcerpt({ post }: { post: Pick<Post, 'content' | 'plainText'> }) {
  if (post.content.length > 0) return <Content nodes={post.content} mode="excerpt" className="row-excerpt" />
  const text = post.plainText.trim()
  return text === '' ? null : <TextExcerpt text={text} className="row-excerpt" />
}
