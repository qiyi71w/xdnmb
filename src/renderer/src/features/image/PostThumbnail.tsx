import { useId, useRef } from 'react'
import type { PostId } from '../../../../shared/forum'
import { Icon } from '../../components/Icon'
import { ImageMaskCover, useImageMask } from './imageMask'
import { describeImageError, UNDECODABLE_TEXT, type ImageView } from './imageView'
import { useImageLoad, useLoadWhenNear } from './useImageLoad'
import './image.css'

/**
 * Thumbnail of a post image in a fixed-size slot: loading, showing and failing never change the
 * post's height. Loaded only while the slot is near the reader viewport; a load still running when
 * the slot leaves that range is cancelled. The slot is the button that opens the image viewer,
 * whatever the thumbnail's state; failures show their reason and a manual 重试 beside it. Under the
 * 图片遮罩 the slot is frosted from its first frame: the first activation only reveals it (显示图片),
 * the next opens the viewer.
 */
export function PostThumbnail({ postId, images: view }: { postId: PostId; images: ImageView }) {
  const thumb = useImageLoad(view.viewId, postId, 'thumb')
  const mask = useImageMask()
  const cover = mask.cover(postId)
  const masked = cover !== null
  const { state } = thumb
  const buttonRef = useRef<HTMLButtonElement>(null)
  const statusId = useId()

  useLoadWhenNear(thumb, view.near, buttonRef)

  const shown = state.status === 'ready' && state.decoded ? state.image : null
  const failure =
    state.status === 'failed' ? describeImageError(state.error) : state.status === 'undecodable' ? UNDECODABLE_TEXT : null

  return (
    <div className="post-image" data-state={state.status}>
      <button
        ref={buttonRef}
        type="button"
        className={masked ? 'post-image-open is-masked' : 'post-image-open'}
        aria-label={masked ? `显示图片 No.${postId}` : `查看原图 No.${postId}`}
        aria-describedby={failure === null ? undefined : statusId}
        title={masked ? '显示图片' : '查看原图'}
        onClick={(event) => {
          if (masked) mask.reveal(postId)
          else view.openViewer({ postId, thumb: shown, trigger: event.currentTarget })
        }}
      >
        {state.status === 'ready' && (
          <img
            key={state.image.url}
            src={state.image.url}
            alt=""
            draggable={false}
            className={state.decoded ? 'is-shown' : undefined}
            onLoad={() => thumb.markDecoded(state.image.url)}
            onError={() => thumb.markUndecodable(state.image.url)}
          />
        )}
        {shown === null && (
          <span className="post-image-placeholder" aria-hidden="true">
            <Icon name={failure === null ? 'image' : 'alert'} size={22} />
          </span>
        )}
        {cover !== null && <ImageMaskCover strength={cover} />}
      </button>
      {failure !== null && (
        <div className="post-image-status">
          <p id={statusId}>缩略图未取得：{failure}</p>
          <button
            type="button"
            className="btn btn-small btn-page"
            onClick={() => {
              // This button unmounts as the retry starts: focus stays on the post's thumbnail.
              buttonRef.current?.focus({ preventScroll: true })
              thumb.retry()
            }}
          >
            <Icon name="refresh" size={14} />
            重试
          </button>
        </div>
      )}
    </div>
  )
}
