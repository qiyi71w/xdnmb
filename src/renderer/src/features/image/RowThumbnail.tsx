import { useRef } from 'react'
import type { PostId } from '../../../../shared/forum'
import { Icon } from '../../components/Icon'
import type { ImageView } from './imageView'
import { useImageLoad, useLoadWhenNear } from './useImageLoad'

/**
 * Thumbnail of a thread's head post in a list row: a fixed-size box, so loading, showing and failing
 * never move the row's text. Loaded only while the row is near the list viewport, like reader
 * thumbnails. The box is the row's 查看原图 button, beside (never inside) the row's own button: it
 * opens the list's image viewer whatever the thumbnail's state, and a failure keeps the placeholder
 * (the viewer shows the reason). `tabIndex` follows the row's, so a list keeps one tab stop per row.
 */
export function RowThumbnail({ postId, images, tabIndex }: { postId: PostId; images: ImageView; tabIndex: number }) {
  const thumb = useImageLoad(images.viewId, postId, 'thumb')
  const { state } = thumb
  const buttonRef = useRef<HTMLButtonElement>(null)
  useLoadWhenNear(thumb, images.near, buttonRef)

  const shown = state.status === 'ready' && state.decoded ? state.image : null
  return (
    <button
      ref={buttonRef}
      type="button"
      className="row-thumb"
      data-state={state.status}
      aria-label="查看原图"
      title="查看原图"
      tabIndex={tabIndex}
      onClick={(event) => images.openViewer({ postId, thumb: shown, trigger: event.currentTarget })}
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
    </button>
  )
}
