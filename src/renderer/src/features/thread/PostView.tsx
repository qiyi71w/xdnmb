import type { Post } from '../../../../shared/forum'
import { Content } from '../../components/Content'
import { meaningfulName, meaningfulTitle } from '../../lib/format'
import type { ImageView } from '../image/imageView'
import { PostThumbnail } from '../image/PostThumbnail'
import { QuoteRef } from '../quote/QuoteRef'

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
  const title = isHead ? null : meaningfulTitle(post.title)
  const isPo = !isHead && poHash !== null && post.userHash === poHash
  const classes = `${isHead ? 'post is-head' : 'post'}${highlighted ? ' is-highlighted' : ''}`
  return (
    <article className={classes} data-post-id={post.id} aria-label={`${isHead ? '主帖' : '回复'} No.${post.id}`}>
      <header className="post-meta">
        {unread && (
          <span className="unread-mark" title="未读">
            <span className="unread-dot" aria-hidden="true" />
            <span className="visually-hidden">未读</span>
          </span>
        )}
        {post.userHash !== null && <span className={post.isAdmin === true ? 'user-hash is-admin' : 'user-hash'}>{post.userHash}</span>}
        {isPo && <span className="tag tag-po">PO</span>}
        {name !== null && <span className="post-name">{name}</span>}
        {post.isSage === true && <span className="tag tag-sage">SAGE</span>}
        {post.createdAt !== null && <span className="post-time">{post.createdAt}</span>}
        <span className="post-no">No.{post.id}</span>
      </header>
      {title !== null && <p className="post-title">{title}</p>}
      {post.image !== null && <PostThumbnail postId={post.id} images={images} />}
      <Content
        nodes={post.content}
        className="post-body"
        renderQuote={(node, quoteIndex) => <QuoteRef hostPostId={post.id} quoteIndex={quoteIndex} postId={node.postId} raw={node.raw} />}
      />
    </article>
  )
}
