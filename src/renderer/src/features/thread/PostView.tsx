import type { ReactNode } from 'react'
import type { Post } from '../../../../shared/forum'
import { Content } from '../../components/Content'
import { meaningfulName, meaningfulTitle } from '../../lib/format'
import type { ImageView } from '../image/imageView'
import { PostThumbnail } from '../image/PostThumbnail'
import { QuoteRef } from '../quote/QuoteRef'
// PROTOTYPE (throwaway): posts take the list-row order (meta → title → name), the head's title as the page h1.
import { PROTOTYPE_ENABLED } from '../directory/prototype/prototypeStore'

export function PostView({
  post,
  isHead,
  poHash,
  unread,
  images,
  highlighted = false
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
}) {
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
    <article className={classes} data-post-id={post.id} aria-label={`${isHead ? '主帖' : '回复'} No.${post.id}`}>
      {header}
      {post.image !== null && <PostThumbnail postId={post.id} images={images} />}
      <Content
        nodes={post.content}
        className="post-body"
        renderQuote={(node, quoteIndex) => <QuoteRef hostPostId={post.id} quoteIndex={quoteIndex} postId={node.postId} raw={node.raw} />}
      />
    </article>
  )
}
