import { useRef } from 'react'
import type { PostId } from '../../../../shared/forum'
import { Icon } from '../../components/Icon'
import type { ImageScope } from './imageView'
import { useImageLoad, useLoadWhenNear } from './useImageLoad'

/**
 * Thumbnail of a thread's head post in a list row: a fixed-size box, so loading, showing and failing
 * never move the row's text. Loaded only while the row is near the list viewport, like reader
 * thumbnails. Decorative inside the row button (the row says 附图); a failure keeps the placeholder.
 */
export function RowThumbnail({ postId, scope }: { postId: PostId; scope: ImageScope }) {
  const thumb = useImageLoad(scope.viewId, postId, 'thumb')
  const { state } = thumb
  const boxRef = useRef<HTMLSpanElement>(null)
  useLoadWhenNear(thumb, scope.near, boxRef)

  const shown = state.status === 'ready' && state.decoded
  return (
    <span ref={boxRef} className="row-thumb" data-state={state.status} aria-hidden="true">
      {state.status === 'ready' && (
        <img
          key={state.image.url}
          src={state.image.url}
          alt=""
          draggable={false}
          className={shown ? 'is-shown' : undefined}
          onLoad={() => thumb.markDecoded(state.image.url)}
          onError={() => thumb.markUndecodable(state.image.url)}
        />
      )}
      {!shown && (
        <span className="row-thumb-placeholder">
          <Icon name="image" size={18} />
        </span>
      )}
    </span>
  )
}
