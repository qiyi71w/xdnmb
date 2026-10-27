import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ImageViewer } from './ImageViewer'
import type { ImageScope, ImageView, ViewerRequest } from './imageView'

/**
 * The image viewer of a thread list, opened from its row thumbnails (查看原图): the reader's viewer,
 * loading in the list's own image scope. The pane renders `viewer` after its scroller and makes the
 * scroller `inert` while `open`; the viewer covers the pane. Closing returns focus to the thumbnail
 * that opened it, or to the list (`list`, its scroller) when that row has left it.
 */
export function useListImageViewer(
  scope: ImageScope,
  list: RefObject<HTMLElement | null>
): { images: ImageView; open: boolean; viewer: ReactNode } {
  const [request, setRequest] = useState<ViewerRequest | null>(null)
  // Whether the pane is on screen (its tab active, the list pane shown): a viewer that had focus
  // takes it back when the pane is shown again, as in the reader. A thumbnail opens it on screen.
  const [displayed, setDisplayed] = useState(true)
  const images = useMemo<ImageView>(
    () => ({
      ...scope,
      openViewer: (next) => {
        setDisplayed(true)
        setRequest(next)
      }
    }),
    [scope]
  )
  const close = useCallback(() => setRequest(null), [])
  const open = request !== null

  useEffect(() => {
    const element = list.current
    if (!open || element === null) return
    const observer = new ResizeObserver(() => setDisplayed(element.clientHeight > 0))
    observer.observe(element)
    return () => observer.disconnect()
  }, [open, list])

  // After the commit that drops `inert` from the list, so the trigger can take focus again.
  const trigger = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (request !== null) {
      trigger.current = request.trigger
      return
    }
    const from = trigger.current
    if (from === null) return
    trigger.current = null
    if (from.isConnected) from.focus({ preventScroll: true })
    else list.current?.focus({ preventScroll: true })
  }, [request, list])

  const viewer =
    request === null ? null : (
      <ImageViewer
        key={request.postId}
        viewId={scope.viewId}
        postId={request.postId}
        initialThumb={request.thumb}
        displayed={displayed}
        onClose={close}
      />
    )
  return { images, open, viewer }
}
