// The images of a forum's 版规, above its text. They load when 版规 is opened (never for a closed
// one), each from its own host through main, and show at a modest height; a failure offers 重试.

import { useEffect } from 'react'
import type { ForumId, RulesImage } from '../../../../shared/forum'
import type { ImageViewId } from '../../../../shared/images'
import { useRulesImageLoad } from '../image/useImageLoad'

export function RulesImages({ viewId, forumId, images }: { viewId: ImageViewId; forumId: ForumId; images: readonly RulesImage[] }) {
  return (
    <div className="rules-images">
      {images.map((image, index) => (
        <RulesImageItem key={image.url} viewId={viewId} forumId={forumId} index={index} alt={image.alt} />
      ))}
    </div>
  )
}

function RulesImageItem({ viewId, forumId, index, alt }: { viewId: ImageViewId; forumId: ForumId; index: number; alt: string }) {
  const image = useRulesImageLoad(viewId, forumId, index)
  const { state, load } = image
  useEffect(() => {
    load()
  }, [load])

  if (state.status === 'ready') {
    return (
      <img
        className="rules-image"
        src={state.image.url}
        alt={alt}
        width={state.image.width}
        height={state.image.height}
        onLoad={() => image.markDecoded(state.image.url)}
        onError={() => image.markUndecodable(state.image.url)}
      />
    )
  }
  if (state.status === 'failed' || state.status === 'undecodable') {
    return (
      <p className="rules-image-failed">
        图片加载失败
        <button type="button" className="btn btn-small btn-quiet" onClick={image.retry}>
          重试
        </button>
      </p>
    )
  }
  return <span className="rules-image-placeholder skeleton-line" aria-hidden="true" />
}
