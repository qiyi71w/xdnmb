import { useCallback, useEffect, useRef, useState } from 'react'
import type { PostId } from '../../../../shared/forum'
import type { ImageError, ImageKind, ImageViewId, LoadedImage } from '../../../../shared/images'

export type ImageLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  /** `decoded`: the `<img>` showing `image.url` finished decoding. */
  | { status: 'ready'; image: LoadedImage; decoded: boolean }
  /** `error` null: the IPC call itself failed. */
  | { status: 'failed'; error: ImageError | null }
  /** Main accepted the bytes, but the renderer could not decode them. Retry fetches again. */
  | { status: 'undecodable'; image: LoadedImage }

/**
 * One image (thumbnail or original) of one post, loaded for a reading view. Only the latest
 * operation may change the state: a cancelled or superseded result is ignored on arrival.
 * Unmounting cancels the operation in flight. Nothing retries on its own.
 */
export function useImageLoad(viewId: ImageViewId, postId: PostId, kind: ImageKind) {
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
      window.xidao.images.load({ operationId, viewId, postId, kind, ...(refresh ? { refresh: true } : {}) }).then(
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
    [cancelCurrent, viewId, postId, kind]
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
