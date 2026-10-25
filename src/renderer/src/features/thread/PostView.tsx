import { useRef, useState, type ReactNode } from 'react'
import type { Post } from '../../../../shared/forum'
import { Content } from '../../components/Content'
import { meaningfulName, meaningfulTitle } from '../../lib/format'
import type { ImageView } from '../image/imageView'
import { PostThumbnail } from '../image/PostThumbnail'
import { QuoteRef } from '../quote/QuoteRef'
// PROTOTYPE (throwaway): posts take the list-row order (meta → title → name), the head's title as the page h1.
import { PROTOTYPE_ENABLED } from '../directory/prototype/prototypeStore'
import { ContextMenu, contextMenuPoint, isContextMenuKey, type ContextMenuItem, type ContextMenuPoint } from '../../components/ContextMenu'
import { setBlocked } from './useBlocks'
import { useCover } from '../../lib/appCovered'

export function PostView({
  post,
  isHead,
  poHash,
  unread,
  images,
  highlighted = false,
  actions
}: {
  post: Post
  isHead: boolean
  poHash: string | null
  /** Confirmed unread: a quiet dot with a spoken “未读”, never color alone. */
  unread: boolean
  /** Images of the reader showing this post. */
  images: ImageView
  /** Target of a quote jump, briefly marked. Purely visual: never a read. */
  highlighted?: boolean
  actions?: { own: boolean; reply: (opener: HTMLElement | null) => void; report: (opener: HTMLElement | null) => void }
}) {
  const articleRef = useRef<HTMLElement>(null)
  const [menu, setMenu] = useState<ContextMenuPoint | null>(null)
  useCover(menu !== null, 'app')
  const block = (kind: 'post' | 'cookie', value: string) => {
    const reader = articleRef.current?.closest('.reader')
    void setBlocked(kind, value, true).then(() => requestAnimationFrame(() => {
      reader?.querySelector<HTMLElement>(`[data-blocked-post-id="${CSS.escape(post.id)}"]`)?.focus({ preventScroll: true })
    }))
  }
  const items: ContextMenuItem[] = actions === undefined ? [] : [
    { type: 'action', key: 'reply', label: '回复', onSelect: () => actions.reply(articleRef.current) },
    ...(!actions.own ? [
      { type: 'action' as const, key: 'report', label: '举报', onSelect: () => actions.report(articleRef.current) },
      { type: 'action' as const, key: 'block-post', label: '屏蔽串号', onSelect: () => block('post', post.id) },
      ...(post.userHash ? [{ type: 'action' as const, key: 'block-cookie', label: '屏蔽饼干', onSelect: () => block('cookie', post.userHash!) }] : [])
    ] : [])
  ]
  const name = meaningfulName(post.name)
  const isPo = !isHead && poHash !== null && post.userHash === poHash
  const classes = `${isHead ? 'post is-head' : 'post'}${highlighted ? ' is-highlighted' : ''}`
  const unreadMark = unread && (
    <span className="unread-mark" title="未读">
      <span className="unread-dot" aria-hidden="true" />
      <span className="visually-hidden">未读</span>
    </span>
  )
  const userHash = post.userHash !== null && <span className={post.isAdmin === true ? 'user-hash is-admin' : 'user-hash'}>{post.userHash}</span>
  const poTag = isPo && <span className="tag tag-po">PO</span>
  const sageTag = post.isSage === true && <span className="tag tag-sage">SAGE</span>
  const time = post.createdAt !== null && <span className="post-time">{post.createdAt}</span>
  const postNo = <span className="post-no">No.{post.id}</span>

  let header: ReactNode
  if (PROTOTYPE_ENABLED) {
    // Meta line, then the title and the name in bold on their own lines. The head's title is the
    // reader's one h1; an untitled thread keeps a hidden one.
    const title = meaningfulTitle(post.title)
    header = (
      <header className="post-head">
        <div className="post-meta">
          {unreadMark}
          {userHash}
          {poTag}
          {sageTag}
          {time}
          {postNo}
        </div>
        {isHead ? (
          <h1 className={title === null ? 'visually-hidden' : 'thread-title'}>{title ?? `No.${post.id}`}</h1>
        ) : (
          title !== null && <p className="post-title">{title}</p>
        )}
        {name !== null && <p className="post-name">{name}</p>}
      </header>
    )
  } else {
    const title = isHead ? null : meaningfulTitle(post.title)
    header = (
      <>
        <header className="post-meta">
          {unreadMark}
          {userHash}
          {poTag}
          {name !== null && <span className="post-name">{name}</span>}
          {sageTag}
          {time}
          {postNo}
        </header>
        {title !== null && <p className="post-title">{title}</p>}
      </>
    )
  }

  return (
    <article ref={articleRef} className={classes} data-post-id={post.id} tabIndex={PROTOTYPE_ENABLED ? 0 : undefined} aria-label={`${isHead ? '主帖' : '回复'} No.${post.id}`}
      onContextMenu={PROTOTYPE_ENABLED && actions !== undefined ? (event) => { event.preventDefault(); event.stopPropagation(); setMenu(contextMenuPoint(event, event.currentTarget)) } : undefined}
      onKeyDown={PROTOTYPE_ENABLED && actions !== undefined ? (event) => { if (isContextMenuKey(event)) { event.preventDefault(); event.stopPropagation(); setMenu(contextMenuPoint(event, event.currentTarget)) } } : undefined}>
      {header}
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
