import { useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { Post } from '../../../../shared/forum'
import { Content } from '../../components/Content'
import { meaningfulName, meaningfulTitle } from '../../lib/format'
import { formatForumTime } from '../../lib/time'
import type { ImageView } from '../image/imageView'
import { PostThumbnail } from '../image/PostThumbnail'
import { QuoteRef } from '../quote/QuoteRef'
import { ContextMenu, contextMenuPoint, isContextMenuKey, type ContextMenuItem, type ContextMenuPoint } from '../../components/ContextMenu'
import { setBlocked } from './useBlocks'
import { useCover } from '../../lib/appCovered'

export interface PostActions {
  /** The post's cookie ID matches an imported cookie: only 回复 is offered. */
  own: boolean
  reply: (opener: HTMLElement | null) => void
  report: (opener: HTMLElement | null) => void
}

/**
 * One post: the meta line (cookie ID, PO, SAGE, time, No.), then the title and the name in bold on
 * their own lines, the image and the body. The head's title is the reader's one h1; an untitled
 * thread keeps a hidden one. The context menu (right click, ContextMenu key, Shift+F10) offers
 * 回复／举报／屏蔽串号／屏蔽饼干, only 回复 on the user's own posts.
 */
export function PostView({
  post,
  isHead,
  poHash,
  images,
  highlighted = false,
  actions
}: {
  post: Post
  isHead: boolean
  poHash: string | null
  /** Images of the reader showing this post. */
  images: ImageView
  /** Target of a quote jump, briefly marked. Purely visual. */
  highlighted?: boolean
  actions?: PostActions
}) {
  const articleRef = useRef<HTMLElement>(null)
  const [menu, setMenu] = useState<ContextMenuPoint | null>(null)
  useCover(menu !== null)
  const block = (kind: 'post' | 'cookie', value: string) => {
    const reader = articleRef.current?.closest('.reader')
    void setBlocked(kind, value, true).then(() => requestAnimationFrame(() => {
      reader?.querySelector<HTMLElement>(`[data-blocked-post-id="${CSS.escape(post.id)}"]`)?.focus({ preventScroll: true })
    }))
  }
  const userHash = post.userHash
  const items: ContextMenuItem[] = actions === undefined ? [] : [
    { type: 'action', key: 'reply', label: '回复', onSelect: () => actions.reply(articleRef.current) },
    ...(!actions.own ? [
      { type: 'action' as const, key: 'report', label: '举报', onSelect: () => actions.report(articleRef.current) },
      { type: 'action' as const, key: 'block-post', label: '屏蔽串号', onSelect: () => block('post', post.id) },
      ...(userHash !== null && userHash !== '' ? [{ type: 'action' as const, key: 'block-cookie', label: '屏蔽饼干', onSelect: () => block('cookie', userHash) }] : [])
    ] : [])
  ]
  const name = meaningfulName(post.name)
  const title = meaningfulTitle(post.title)
  const isPo = !isHead && poHash !== null && post.userHash === poHash
  const classes = `${isHead ? 'post is-head' : 'post'}${highlighted ? ' is-highlighted' : ''}`
  const openMenu = actions === undefined ? undefined : (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu(contextMenuPoint(event, event.currentTarget))
  }

  return (
    <article ref={articleRef} className={classes} data-post-id={post.id} tabIndex={0} aria-label={`${isHead ? '主帖' : '回复'} No.${post.id}`}
      onContextMenu={openMenu}
      onKeyDown={openMenu === undefined ? undefined : (event) => { if (isContextMenuKey(event)) openMenu(event) }}>
      <header className="post-head">
        <div className="post-meta">
          {post.userHash !== null && <span className={post.isAdmin === true ? 'user-hash is-admin' : 'user-hash'}>{post.userHash}</span>}
          {isPo && <span className="tag tag-po">PO</span>}
          {post.isSage === true && <span className="tag tag-sage">SAGE</span>}
          {post.createdAt !== null && <span className="post-time">{formatForumTime(post.createdAt)}</span>}
          <span className="post-no">No.{post.id}</span>
        </div>
        {isHead ? (
          <h1 className={title === null ? 'visually-hidden' : 'thread-title'}>{title ?? `No.${post.id}`}</h1>
        ) : (
          title !== null && <p className="post-title">{title}</p>
        )}
        {name !== null && <p className="post-name">{name}</p>}
      </header>
      {post.image !== null && <PostThumbnail postId={post.id} images={images} />}
      <Content
        nodes={post.content}
        className="post-body"
        renderQuote={(node, quoteIndex) => <QuoteRef host={{ postId: post.id }} quoteIndex={quoteIndex} postId={node.postId} raw={node.raw} />}
      />
      {menu !== null && <ContextMenu point={menu} label={`No.${post.id} 操作`} items={items} onClose={(restore) => { setMenu(null); if (restore) articleRef.current?.focus({ preventScroll: true }) }} />}
    </article>
  )
}
