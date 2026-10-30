import { useContext, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { Post, PostId } from '../../../../shared/forum'
import { Content } from '../../components/Content'
import { meaningfulName, meaningfulTitle } from '../../lib/format'
import { formatForumTime } from '../../lib/time'
import type { ImageView } from '../image/imageView'
import { PostThumbnail } from '../image/PostThumbnail'
import { QuoteRef } from '../quote/QuoteRef'
import { QuoteActiveContext, QuoteControllerContext, QuoteEntryContext } from '../quote/QuoteContext'
import { selectedPostNumber } from '../quote/selectionNumber'
import { ContextMenu, contextMenuPoint, isContextMenuKey, type ContextMenuItem, type ContextMenuPoint } from '../../components/ContextMenu'
import { CookieId } from '../../components/CookieId'
import { copyNumberItem, copyTextItem, selectionCopyItem, withSelectionCopy } from '../../components/copyMenuItems'
import { cookieColorItems } from '../cookieColors/CookieColorPicker'
import { setBlocked } from './useBlocks'
import { useCover } from '../../lib/appCovered'

export interface PostActions {
  /** The post's cookie ID matches an imported cookie: no 屏蔽 items. */
  own: boolean
  reply: (opener: HTMLElement | null) => void
  report: (opener: HTMLElement | null) => void
}

/**
 * One post: the meta line (cookie ID, PO, SAGE, time, No.), then the title and the name in bold on
 * their own lines, the image and the body. The head's title is the reader's one h1; an untitled
 * thread keeps a hidden one. The context menu (right click, ContextMenu key, Shift+F10) offers
 * 回复／举报／屏蔽串号／屏蔽饼干 (no 屏蔽 on the user's own posts), then 复制内容／复制串号／复制饼干
 * and 饼干颜色… (not for an admin), under 复制选中文字 when text in the post is selected. A selection
 * that is exactly one whole post number in the body adds 预览／打开／在新标签页打开 for that number
 * (through the quote card: nothing opens before it is located); other digits never do.
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
  const quotes = useContext(QuoteControllerContext)
  const entryKey = useContext(QuoteEntryContext)
  const activeQuote = useContext(QuoteActiveContext)
  const [menu, setMenu] = useState<{
    point: ContextMenuPoint
    owner: HTMLElement
    selection: ContextMenuItem | null
    number: { postId: PostId; range: Range } | null
  } | null>(null)
  useCover(menu !== null)
  const block = (kind: 'post' | 'cookie', value: string) => {
    const reader = articleRef.current?.closest('.reader')
    void setBlocked(kind, value, true).then(() => requestAnimationFrame(() => {
      reader?.querySelector<HTMLElement>(`[data-blocked-post-id="${CSS.escape(post.id)}"]`)?.focus({ preventScroll: true })
    }))
  }
  const userHash = post.userHash !== null && post.userHash !== '' ? post.userHash : null
  const number = menu?.number ?? null
  const numberItems: ContextMenuItem[] =
    number === null || quotes === null || entryKey === null
      ? []
      : (['preview', 'navigate', 'new-tab'] as const).map((action) => ({
          type: 'action' as const,
          key: `number-${action}`,
          label: `${action === 'preview' ? '预览' : action === 'navigate' ? '打开' : '在新标签页打开'} No.${number.postId}`,
          onSelect: () => quotes.selection({ entryKey, postId: number.postId, range: number.range, returnFocus: articleRef.current }, action)
        }))
  const items: ContextMenuItem[] = actions === undefined || menu === null ? [] : withSelectionCopy(menu.selection, [
    ...numberItems,
    ...(numberItems.length > 0 ? [{ type: 'separator' as const, key: 'number-separator' }] : []),
    { type: 'action', key: 'reply', label: '回复', onSelect: () => actions.reply(articleRef.current) },
    { type: 'action', key: 'report', label: '举报', onSelect: () => actions.report(articleRef.current) },
    ...(!actions.own ? [
      { type: 'action' as const, key: 'block-post', label: '屏蔽串号', onSelect: () => block('post', post.id) },
      ...(userHash !== null ? [{ type: 'action' as const, key: 'block-cookie', label: '屏蔽饼干', onSelect: () => block('cookie', userHash) }] : [])
    ] : []),
    { type: 'separator', key: 'copy-separator' },
    copyTextItem('copy-content', '复制内容', post.plainText, '这条发言没有正文'),
    copyNumberItem(post.id),
    ...(userHash !== null ? [copyTextItem('copy-cookie', '复制饼干', userHash, '')] : []),
    ...cookieColorItems({ userHash, isAdmin: post.isAdmin }, menu.point, menu.owner)
  ])
  const name = meaningfulName(post.name)
  const title = meaningfulTitle(post.title)
  const isPo = !isHead && poHash !== null && post.userHash === poHash
  const classes = `${isHead ? 'post is-head' : 'post'}${highlighted ? ' is-highlighted' : ''}`
  const openMenu = actions === undefined ? undefined : (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({
      point: contextMenuPoint(event, event.currentTarget),
      owner: event.currentTarget,
      selection: selectionCopyItem(undefined, event.currentTarget),
      number: selectedPostNumber(event.currentTarget)
    })
  }

  return (
    <article ref={articleRef} className={classes} data-post-id={post.id} tabIndex={0} aria-label={`${isHead ? '主帖' : '回复'} No.${post.id}`}
      onContextMenu={openMenu}
      onKeyDown={openMenu === undefined ? undefined : (event) => {
        if (isContextMenuKey(event)) {
          openMenu(event)
          return
        }
        // Tab from the post whose selected number's card is open moves into that card, as from a quote.
        if (event.key === 'Tab' && !event.shiftKey && event.target === event.currentTarget && quotes !== null && entryKey !== null &&
          activeQuote?.startsWith(`${entryKey}:selection:`) === true && quotes.focusCard()) event.preventDefault()
      }}>
      <header className="post-head">
        <div className="post-meta">
          {post.userHash !== null && <CookieId cookieId={post.userHash} admin={post.isAdmin === true} />}
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
        renderQuote={(node, quoteIndex) => <QuoteRef host={{ postId: post.id }} quoteIndex={quoteIndex} postId={node.postId} raw={node.raw} hint={node.hint} />}
      />
      {menu !== null && <ContextMenu point={menu.point} label={`No.${post.id} 操作`} items={items} onClose={(restore) => { setMenu(null); if (restore) articleRef.current?.focus({ preventScroll: true }) }} />}
    </article>
  )
}
