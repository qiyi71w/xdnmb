import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { PostId } from '../../../../shared/forum'
import type { ImageError, ImageKind, ImageViewId, LoadedImage } from '../../../../shared/images'
import { NearViewport, type ImageScope } from './imageView'

export type ImageLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  /** `decoded`: the `<img>` showing `image.url` finished decoding. */
  | { status: 'ready'; image: LoadedImage; decoded: boolean }
  /** `error` null: the IPC call itself failed. */
  | { status: 'failed'; error: ImageError | null }
  /** Main accepted the bytes, but the renderer could not decode them. Retry fetches again. */
  | { status: 'undecodable'; image: LoadedImage }

/** One post image's load state and the operations on it. */
export interface ImageLoad {
  state: ImageLoadState
  /** Starts a load (`refresh`: fetch again even when stored), cancelling any in flight. */
  load: (refresh?: boolean) => void
  /** Stops a load in flight and forgets it; a later `load` starts afresh. */
  abort: () => void
  /** Manual retry: decode failures fetch again, other failures load normally. */
  retry: () => void
  markDecoded: (url: string) => void
  markUndecodable: (url: string) => void
}

/**
 * One image (thumbnail or original) of one post, loaded for a reading view. Only the latest
 * operation may change the state: a cancelled or superseded result is ignored on arrival.
 * Unmounting cancels the operation in flight. Nothing retries on its own. `localOnly` loads use
 * only files already on this machine (a stored original also serves a thumbnail) and never
 * download, retry included; a missing image fails with `not-stored`.
 */
export function useImageLoad(viewId: ImageViewId, postId: PostId, kind: ImageKind, localOnly = false): ImageLoad {
  const [state, setState] = useState<ImageLoadState>({ status: 'idle' })
  const current = useRef<string | null>(null)

  const cancelCurrent = useCallback(() => {
    const operationId = current.current
    if (operationId === null) return
    current.current = null
    window.xidao.images.cancel({ operationId }).catch(() => undefined)
  }, [])

  const load = useCallback(
    (refresh = false) => {
      cancelCurrent()
      const operationId = crypto.randomUUID()
      current.current = operationId
      setState({ status: 'loading' })
      const request = { operationId, viewId, postId, kind, ...(refresh ? { refresh: true } : {}), ...(localOnly ? { localOnly: true } : {}) }
      window.xidao.images.load(request).then(
        (outcome) => {
          if (current.current !== operationId) return
          current.current = null
          switch (outcome.status) {
            case 'ready':
              setState({ status: 'ready', image: outcome.image, decoded: false })
              break
            case 'failed':
              setState({ status: 'failed', error: outcome.error })
              break
            case 'cancelled':
              setState({ status: 'idle' })
              break
          }
        },
        () => {
          if (current.current !== operationId) return
          current.current = null
          setState({ status: 'failed', error: null })
        }
      )
    },
    [cancelCurrent, viewId, postId, kind, localOnly]
  )

  /** Stops a load in flight and forgets it; a later `load` starts afresh. */
  const abort = useCallback(() => {
    if (current.current === null) return
    cancelCurrent()
    setState({ status: 'idle' })
  }, [cancelCurrent])

  /** Manual retry: decode failures fetch again (`refresh`), other failures load normally. */
  const retry = useCallback(() => {
    load(state.status === 'undecodable')
  }, [load, state.status])

  const markDecoded = useCallback((url: string) => {
    setState((previous) =>
      previous.status === 'ready' && previous.image.url === url && !previous.decoded ? { ...previous, decoded: true } : previous
    )
  }, [])

  const markUndecodable = useCallback((url: string) => {
    setState((previous) =>
      previous.status === 'ready' && previous.image.url === url ? { status: 'undecodable', image: previous.image } : previous
    )
  }, [])

  // Unmount cancels the load in flight (a StrictMode remount then starts from idle again).
  useEffect(() => abort, [abort])

  return { state, load, abort, retry, markDecoded, markUndecodable }
}

/**
 * Loads `image` while `target` is near its scroller's viewport; a load still running when the
 * element leaves that range is cancelled. A failure stays until a manual retry.
 */
export function useLoadWhenNear(image: ImageLoad, near: NearViewport, target: RefObject<Element | null>): void {
  const latest = useRef({ status: image.state.status, load: image.load, abort: image.abort })
  useLayoutEffect(() => {
    latest.current = { status: image.state.status, load: image.load, abort: image.abort }
  })

  useEffect(() => {
    const element = target.current
    if (element === null) return
    return near.observe(element, (isNear) => {
      const { status, load, abort } = latest.current
      if (isNear && status === 'idle') load()
      else if (!isNear && status === 'loading') abort()
    })
  }, [near, target])
}

/**
 * Image scope of a thread list (its viewer: `useListImageViewer`): its own view ID and lazy-load
 * observer rooted at `root`. Unmounting releases the view's images from reading protection.
 * `localOnly`: the list's thumbnails never download (see `ImageScope.localOnly`).
 */
export function useImageScope(root: RefObject<Element | null>, { localOnly = false }: { localOnly?: boolean } = {}): ImageScope {
  const [viewId] = useState(() => crypto.randomUUID())
  const [near] = useState(() => new NearViewport(() => root.current))
  useEffect(
    () => () => {
      near.disconnect()
      window.xidao.images.releaseView({ viewId }).catch(() => undefined)
    },
    [near, viewId]
  )
  return useMemo(() => ({ viewId, near, localOnly }), [viewId, near, localOnly])
}
