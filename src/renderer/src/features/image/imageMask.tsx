import { createContext, useContext, useLayoutEffect, useMemo, useRef, type CSSProperties, type Dispatch, type ReactNode } from 'react'
import type { PostId } from '../../../../shared/forum'
import { useSettings } from '../../lib/settingsContext'
import { revealsOn, type ImageRevealsAction, type PageReveals, type RevealView } from './imageMaskState'
import './image.css'

/** 图片遮罩 of the reading thumbnails of one tab's page (its reader, lists and quote card). */
export interface ImageMask {
  /** Whether masking is on (enabled at a blur strength above 0%). */
  active: boolean
  /** Blur strength in percent of the frost over the thumbnail of `postId`; null when it is not masked now. */
  cover: (postId: PostId) => number | null
  reveal: (postId: PostId) => void
  /** Ends the visit of the page: it switched to another of its own local pages (`useImageMaskSubpage`). */
  leave: () => void
  /** The page visit (see `PageReveals.visit`); a viewer of the original closes when it changes. */
  visit: number
}

const ImageMaskContext = createContext<ImageMask | null>(null)

export function useImageMask(): ImageMask {
  const mask = useContext(ImageMaskContext)
  if (mask === null) throw new Error('useImageMask outside ImageMaskScope')
  return mask
}

/**
 * A page with local pages of its own (历史 浏览／新串／回复, 订阅 list／同步与合并): switching from
 * `subpage` to another one leaves the page's visit, before paint, like a page change of the tab.
 * Its images are masked again and a viewer of the original opened there closes.
 */
export function useImageMaskSubpage(subpage: string): void {
  const { leave } = useImageMask()
  const shown = useRef(subpage)
  useLayoutEffect(() => {
    if (shown.current === subpage) return
    shown.current = subpage
    leave()
  }, [subpage, leave])
}

/**
 * The image mask of tab `tabId` showing `view` (`revealView`), for content mounted inside the tab or
 * outside it on its behalf (the quote card of a quote in the tab).
 */
export function ImageMaskScope({
  tabId,
  view,
  reveals,
  dispatch,
  children
}: {
  tabId: number
  view: RevealView | null
  reveals: PageReveals | undefined
  dispatch: Dispatch<ImageRevealsAction>
  children: ReactNode
}) {
  const { imageMaskEnabled, imageMaskStrength } = useSettings().settings
  const strength = imageMaskEnabled && imageMaskStrength > 0 ? imageMaskStrength : null
  const revealed = revealsOn(reveals, view)
  const visit = reveals?.visit ?? 0
  const page = view?.page ?? null
  const mask = useMemo<ImageMask>(
    () => ({
      active: strength !== null,
      cover: (postId) => (strength !== null && !revealed.has(postId) ? strength : null),
      reveal: (postId) => dispatch({ type: 'reveal', tabId, page, postId }),
      leave: () => dispatch({ type: 'leave', tabId, page }),
      visit
    }),
    [strength, revealed, visit, dispatch, tabId, page]
  )
  return <ImageMaskContext value={mask}>{children}</ImageMaskContext>
}

/**
 * The frost over a masked thumbnail (and the 设置 preview): blurs what lies under it in its box,
 * keeping the picture's colours, with a light theme tint. `strength` (1–100) scales the blur, the
 * saturation boost and the tint together (image.css); at 100 the detail is gone but the colours stay.
 */
export function ImageMaskCover({ strength }: { strength: number }) {
  return (
    <span className="image-mask" style={{ '--image-mask-strength': strength / 100 } as CSSProperties} aria-hidden="true" />
  )
}
