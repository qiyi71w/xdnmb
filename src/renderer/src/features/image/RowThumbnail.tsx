import { useRef } from 'react'
import type { PostId } from '../../../../shared/forum'
import { Icon } from '../../components/Icon'
import { ImageMaskCover, useImageMask } from './imageMask'
import type { ImageView } from './imageView'
import { useImageLoad, useLoadWhenNear } from './useImageLoad'
import './image.css'

/**
 * Thumbnail of a thread's head post in a list row: a fixed-size box, so loading, showing and failing
 * never move the row's text. Loaded only while the row is near the list viewport, like reader
 * thumbnails. The box is the row's 查看原图 button, beside (never inside) the row's own button: it
 * opens the list's image viewer whatever the thumbnail's state, and a failure keeps the placeholder
 * (the viewer shows the reason). `tabIndex` follows the row's, so a list keeps one tab stop per row.
 * In a local-only list (历史, 离线) the thumbnail never downloads; a missing one keeps the placeholder.
 * Under the 图片遮罩 the first activation only reveals the thumbnail (显示图片): it never opens the
 * row's thread or the viewer; the next opens the viewer.
 */
export function RowThumbnail({ postId, images, tabIndex }: { postId: PostId; images: ImageView; tabIndex: number }) {
  const thumb = useImageLoad(images.viewId, postId, 'thumb', images.localOnly)
  const mask = useImageMask()
  const cover = mask.cover(postId)
  const masked = cover !== null
  const { state } = thumb
  const buttonRef = useRef<HTMLButtonElement>(null)
  useLoadWhenNear(thumb, images.near, buttonRef)

  const shown = state.status === 'ready' && state.decoded ? state.image : null
  return (
    <button
      ref={buttonRef}
      type="button"
      className={masked ? 'row-thumb is-masked' : 'row-thumb'}
      data-state={state.status}
      aria-label={masked ? '显示图片' : '查看原图'}
      title={masked ? '显示图片' : '查看原图'}
      tabIndex={tabIndex}
      onClick={(event) => {
        if (masked) mask.reveal(postId)
        else images.openViewer({ postId, thumb: shown, trigger: event.currentTarget })
      }}
    >
      {state.status === 'ready' && (
        <img
          key={state.image.url}
          src={state.image.url}
          alt=""
          draggable={false}
          className={shown !== null ? 'is-shown' : undefined}
          onLoad={() => thumb.markDecoded(state.image.url)}
          onError={() => thumb.markUndecodable(state.image.url)}
        />
      )}
      {shown === null && (
        <span className="row-thumb-placeholder" aria-hidden="true">
          <Icon name="image" size={18} />
        </span>
      )}
      {cover !== null && <ImageMaskCover opacity={cover} />}
    </button>
  )
}
